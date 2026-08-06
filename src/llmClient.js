/**
 * llmClient.js —— OpenAI 兼容 API 客户端封装（供 distill 使用）。
 *
 * 设计要点：
 * - baseUrl / model 由 config.llm 提供，apiKey 由 keys.resolveApiKey() 从 Keychain 解析；
 * - fetch 可注入（opts.fetchImpl），便于单测 mock，不打真实网络；
 * - 请求带 AbortController 超时保护；
 * - 任何错误信息与日志绝不包含明文密钥（Authorization 头不落日志、不回显）。
 */

/** LLM 配置/调用类错误（区别于解析错误），供上层统一降级处理 */
export class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 配置缺失时的统一指引文案（提示 hub keys / config 配置方法） */
export const LLM_CONFIG_HINT =
  '请编辑 config.json 的 llm 段填写 baseUrl/model（hub config 查看配置文件路径），' +
  '并运行 hub keys --sync 与 hub keys use <name> 将密钥存入 Keychain 后选择引用名';

/**
 * 创建一个 OpenAI 兼容的 chat completion 客户端。
 * @param {{
 *   baseUrl: string,            // 形如 https://api.example.com/v1（未配置则抛清晰错误）
 *   model: string,              // 模型名
 *   apiKey: string,             // 明文密钥（仅存于进程内存，绝不落日志）
 *   fetchImpl?: Function,       // 可注入的 fetch（测试 mock 用），缺省全局 fetch
 *   timeoutMs?: number,         // 单次请求超时，缺省 120s
 * }} opts
 * @returns {{ chat: (messages: Object[], extra?: Object) => Promise<string>, baseUrl: string, model: string }}
 */
export function createLlmClient(opts = {}) {
  const { baseUrl, model, apiKey, fetchImpl, timeoutMs = 120000 } = opts;
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
   * 发起一次 chat completion 调用，返回助手回复文本。
   * @param {{ role: string, content: string }[]} messages 对话消息
   * @param {{ temperature?: number, maxTokens?: number }} [extra] 透传参数
   * @returns {Promise<string>} choices[0].message.content
   * @throws {LlmError} 网络/HTTP/响应结构异常时抛出（错误文本不含密钥）
   */
  async function chat(messages, extra = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const reason = err?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : err.message;
      throw new LlmError(`LLM 请求失败（${endpoint}）: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      // 只截取响应体前 300 字符用于诊断，绝不回显请求头（含密钥）
      let snippet = '';
      try {
        snippet = (await resp.text()).slice(0, 300);
      } catch {
        snippet = '(响应体不可读)';
      }
      throw new LlmError(`LLM 返回 HTTP ${resp.status}: ${snippet}`);
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      throw new LlmError(`LLM 响应不是合法 JSON: ${err.message}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LlmError('LLM 响应缺少 choices[0].message.content');
    }
    return content;
  }

  return { chat, baseUrl, model };
}
