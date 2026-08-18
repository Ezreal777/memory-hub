/**
 * llmClient.js —— OpenAI 兼容 API 客户端封装（供 distill 使用）。
 *
 * 设计要点：
 * - baseUrl / model 由 config.llm 提供，apiKey 由 keys.resolveApiKey() 从 Keychain 解析；
 * - fetch 可注入（opts.fetchImpl），便于单测 mock，不打真实网络；
 * - 请求带 AbortController 超时保护；
 * - M3：瞬时故障（429/5xx/网络错误/超时）按指数退避自动重试 2 次（共 3 次尝试），
 *   重试间隔可注入（opts.retryDelaysMs），4xx 业务错误不重试；
 * - M5：网关请求体超限（HTTP 413 或响应体含 TooLarge）抛出带 tooLarge 标记的错误，
 *   供上层（distill）对批次做对半拆分重试，绝不原地重放；
 * - 任何错误信息与日志绝不包含明文密钥（Authorization 头不落日志、不回显）。
 */

import { llmBudgetState, recordLlmCall } from './llm-usage.js';

/** LLM 配置/调用类错误（区别于解析错误），供上层统一降级处理 */
export class LlmError extends Error {
  /**
   * @param {string} message 错误信息（绝不含密钥）
   * @param {{ status?: number|null, retryable?: boolean, tooLarge?: boolean, rateLimited?: boolean }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LlmError';
    /** HTTP 状态码（网络层失败为 null） */
    this.status = meta.status ?? null;
    /** 是否值得原样重试（429/5xx/网络错误/超时） */
    this.retryable = Boolean(meta.retryable);
    /** 请求体超网关上限（上层应拆分批次而非重试） */
    this.tooLarge = Boolean(meta.tooLarge);
    /** 配额/频次限流（上层应整轮刹车进入冷却，继续发请求只会白烧额度） */
    this.rateLimited = Boolean(meta.rateLimited);
  }
}

/** 配置缺失时的统一指引文案（提示 hub keys / config 配置方法） */
export const LLM_CONFIG_HINT =
  '请编辑 config.json 的 llm 段填写 baseUrl/model（hub config 查看配置文件路径），' +
  '并运行 hub keys --sync 与 hub keys use <name> 将密钥存入 Keychain 后选择引用名';

/** 缺省重试退避序列（指数放大）：第 1 次失败等 500ms，第 2 次等 2s，之后放弃 */
export const LLM_RETRY_DELAYS_MS = [500, 2000];

/** 异步休眠 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 创建一个 OpenAI 兼容的 chat completion 客户端。
 * @param {{
 *   baseUrl: string,            // 形如 https://api.example.com/v1（未配置则抛清晰错误）
 *   model: string,              // 模型名
 *   apiKey: string,             // 明文密钥（仅存于进程内存，绝不落日志）
 *   fetchImpl?: Function,       // 可注入的 fetch（测试 mock 用），缺省全局 fetch
 *   timeoutMs?: number,         // 单次请求超时，缺省 120s
 *   retryDelaysMs?: number[],   // 重试退避序列（测试可注入 [1,1] 加速），缺省 LLM_RETRY_DELAYS_MS
 *   budgetEnabled?: boolean,    // 预算台账开关；缺省仅真实 fetch 时启用（mock 注入不记账，防测试污染真实台账）
 * }} opts
 * @returns {{ chat: (messages: Object[], extra?: Object) => Promise<string>, baseUrl: string, model: string }}
 */
export function createLlmClient(opts = {}) {
  const { baseUrl, model, apiKey, fetchImpl, timeoutMs = 120000 } = opts;
  const retryDelaysMs = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : LLM_RETRY_DELAYS_MS;
  // 预算台账：缺省仅真实 fetch 时启用（mock 注入不消耗额度，记账反而污染真实台账）
  const budgetEnabled = opts.budgetEnabled ?? !fetchImpl;
  if (!baseUrl) {
    throw new LlmError(`llm.baseUrl 未配置，无法调用 LLM。${LLM_CONFIG_HINT}`);
  }
  if (!model) {
    throw new LlmError(`llm.model 未配置，无法调用 LLM。${LLM_CONFIG_HINT}`);
  }
  if (!apiKey) {
    throw new LlmError(`API Key 解析为空，无法调用 LLM。${LLM_CONFIG_HINT}`);
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new LlmError('当前环境缺少 fetch，且未注入 fetchImpl');
  }
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  /**
   * 发起单次 chat completion 调用（不含重试），返回助手回复文本。
   * @param {{ role: string, content: string }[]} messages 对话消息
   * @param {{ temperature?: number, maxTokens?: number }} extra 透传参数
   * @returns {Promise<string>} choices[0].message.content
   * @throws {LlmError} 网络/HTTP/响应结构异常时抛出（错误文本不含密钥）
   */
  async function chatOnce(messages, extra = {}) {
    // 预算刹车（缺省关闭，config.llm.hourlyCallCap/dailyCallCap 启用）：主动限频
    // 给同一 AK 的交互使用留余量；超额抛 rateLimited，调用方走既有冷却刹车
    //（reason 含「请明天再来」时冷却到次日凌晨，否则 60 分钟）。
    // 仅真实网关调用记账：注入 fetchImpl（测试 mock）不消耗额度，记账会污染真实台账
    if (budgetEnabled) {
      const budget = llmBudgetState();
      if (budget.exceeded) {
        throw new LlmError(`LLM 预算刹车: ${budget.reason}`, { rateLimited: true });
      }
      recordLlmCall(); // 每次真实发请求前登记（含重试的每次尝试——网关同样计数）
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // M9：响应体读取也必须在总超时预算内——实测连接中途死掉（TCP 已 CLOSED）时
    // resp.json() 会永久挂起，daemon 整条 pipeline 冻结；用剩余预算竞速 + abort 兜底，
    // 超时抛 retryable（不依赖 fetch 实现对 signal 的响应，mock 同样受保护）
    const readBody = (promise, what) => {
      const remainMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      let bodyTimer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          bodyTimer = setTimeout(() => {
            controller.abort();
            reject(new LlmError(`LLM ${what}超时（总预算 ${timeoutMs}ms）`, { retryable: true }));
          }, remainMs);
          if (bodyTimer.unref) bodyTimer.unref();
        }),
      ]).finally(() => clearTimeout(bodyTimer));
    };
    let resp;
    try {
      resp = await doFetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: extra.temperature ?? 0.2,
          ...(extra.maxTokens ? { max_tokens: extra.maxTokens } : {}),
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : err.message;
      // 网络错误/超时：瞬时故障概率高，标记可重试
      throw new LlmError(`LLM 请求失败（${endpoint}）: ${reason}`, { retryable: true });
    }
    // 注意：不能在拿到响应头就 clearTimeout——body 仍在传输，后续读取继续受总超时保护
    try {
      if (!resp.ok) {
        // 只截取响应体前 300 字符用于诊断，绝不回显请求头（含密钥）
        let snippet = '';
        try {
          snippet = (await readBody(resp.text(), '错误响应体读取')).slice(0, 300);
        } catch {
          snippet = '(响应体不可读)';
        }
        const status = Number(resp.status);
        // M5：请求体超网关上限（413 或响应体含 TooLarge）→ 上层拆分批次，重试无意义
        const tooLarge = status === 413 || /TooLarge|too\s*large/i.test(snippet);
        // 配额/频次限流：标准 429，或 idealab 网关的 400+IRC-001（小时限流/日额度耗尽）。
        // 关键事实：失败调用照样计入日额度，因此不重试、上层整轮刹车进入冷却
        const rateLimited =
          status === 429 || (status === 400 && /IRC-001|超过了\s*\d+\s*次|请下一个周期|请明天再来/.test(snippet));
        const retryable = !tooLarge && !rateLimited && status >= 500;
        throw new LlmError(`LLM 返回 HTTP ${status}: ${snippet}`, { status, retryable, tooLarge, rateLimited });
      }

      let data;
      try {
        data = await readBody(resp.json(), '响应体读取');
      } catch (err) {
        if (err instanceof LlmError) throw err; // body 超时：保留 retryable 语义
        throw new LlmError(`LLM 响应不是合法 JSON: ${err.message}`);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LlmError('LLM 响应缺少 choices[0].message.content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发起一次 chat completion 调用（含 M3 指数退避重试），返回助手回复文本。
   * 仅对 retryable 错误（429/5xx/网络错误/超时）重试；TooLarge 与其余 4xx 立即抛出。
   * @param {{ role: string, content: string }[]} messages 对话消息
   * @param {{ temperature?: number, maxTokens?: number }} [extra] 透传参数
   * @returns {Promise<string>} choices[0].message.content
   * @throws {LlmError} 重试耗尽或不可重试错误
   */
  async function chat(messages, extra = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        return await chatOnce(messages, extra);
      } catch (err) {
        lastErr = err;
        if (!err?.retryable || attempt === retryDelaysMs.length) throw err;
        await sleep(retryDelaysMs[attempt]);
      }
    }
    throw lastErr;
  }

  return { chat, baseUrl, model };
}
