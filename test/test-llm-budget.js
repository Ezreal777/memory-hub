/**
 * test/test-llm-budget.js —— LLM 限流冷却（budget brake）自测（node:test）。
 *
 * 背景：idealab 免费 AK 的失败调用照样计入日额度（200 次/天），此前系统把
 * 限流（400+IRC-001）当"单批失败下轮再试"，daemon 补跑链持续撞墙，
 * 实测一上午烧光全天额度。防御：
 * - llmClient 识别限流（429 / 400+IRC-001 文案）→ LlmError.rateLimited，不重试；
 * - distill/compact 撞限流整轮刹车 + 写 state/llm-cooldown.json；
 * - 冷却期内 distill/compact/eval 零调用直接跳过；
 * - 日额度耗尽（"今天/请明天再来"）冷却到本地次日凌晨，小时限流冷却 60 分钟。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { createLlmClient } from '../src/llmClient.js';
import {
  distill,
  llmCooldownRemaining,
  startLlmCooldown,
  llmCooldownPath,
  LLM_COOLDOWN_MS,
} from '../src/distill.js';
import { compact } from '../src/compact.js';
import { ensureHubStore, storePaths } from '../src/hub-store.js';
import { defaultConfig } from '../src/config.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-budget-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

function writeSnapshot(app, hubId, title, body) {
  const dir = path.join(storePaths.sources, app);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `20260814-100000-${hubId}.md`);
  fs.writeFileSync(file, ['---', `hubId: "${hubId}"`, `app: "${app}"`, `title: "${title}"`, 'source: "/fake/x.md"', 'ingestedAt: "2026-08-14T10:00:00.000Z"', 'sha256: "beef"', '---', '', body, ''].join('\n'));
  return file;
}

function writeWikiPage(slug, hubIds, body) {
  const fm = { 'hub-id': hubIds, sources: [], 'last-updated': '2026-08-14T10:00:00.000Z', tags: [], category: 'task_summary_experience' };
  fs.writeFileSync(path.join(storePaths.wiki, `${slug}.md`), matter.stringify({ content: `# ${slug}\n\n${body}\n` }, fm));
}

/** mock fetch：返回指定 HTTP 状态与响应体 */
function mockFetch(status, body) {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    return {
      ok: status < 400,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

/** 抛限流错误的 mock 客户端 */
function rateLimitedClient(message) {
  const calls = [];
  return {
    calls,
    chat: async () => {
      calls.push(1);
      const err = new Error(message);
      err.rateLimited = true;
      throw err;
    },
  };
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('llmClient：400+IRC-001 与 429 判定 rateLimited 且不重试', async () => {
  const fetchHourly = mockFetch(400, { success: false, message: '抱歉，您当前调用的API超过了10次/60.0分钟，请下一个周期再试。', code: 'IRC-001' });
  const client = createLlmClient({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetchImpl: fetchHourly, retryDelaysMs: [1, 1] });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (err) => err.rateLimited === true && err.retryable === false,
  );
  assert.equal(fetchHourly.calls.length, 1, '限流绝不重试（重试也计额度）');

  const fetch429 = mockFetch(429, 'Too Many Requests');
  const client429 = createLlmClient({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetchImpl: fetch429, retryDelaysMs: [1, 1] });
  await assert.rejects(() => client429.chat([{ role: 'user', content: 'x' }]), (err) => err.rateLimited === true);
  assert.equal(fetch429.calls.length, 1, '429 同样不重试');

  // 5xx 仍保持原重试语义
  const fetch500 = mockFetch(500, 'oops');
  const client500 = createLlmClient({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetchImpl: fetch500, retryDelaysMs: [1, 1] });
  await assert.rejects(() => client500.chat([{ role: 'user', content: 'x' }]), (err) => err.retryable !== undefined);
  assert.equal(fetch500.calls.length, 3, '5xx 按退避重试 2 次');
});

test('llmClient：响应体永久挂起 → 总超时预算内报 retryable 超时（M9 防 pipeline 冻结）', async () => {
  // 复现场景：拿到响应头后连接中途死掉（TCP CLOSED），resp.json() 永不 resolve；
  // 修复前超时定时器在响应头到达即被清除，daemon 整条 pipeline 曾永久冻结
  const hangFetch = async () => ({
    ok: true,
    json: () => new Promise(() => {}), // 永久挂起的响应体
  });
  const client = createLlmClient({
    baseUrl: 'https://x/v1',
    model: 'm',
    apiKey: 'k',
    fetchImpl: hangFetch,
    timeoutMs: 120, // 小预算加速测试
    retryDelaysMs: [1],
  });
  const t0 = Date.now();
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (err) => err.retryable === true && /响应体读取超时/.test(err.message),
  );
  assert.ok(Date.now() - t0 < 5000, '在总超时预算量级内返回，绝不永久挂起');

  // 错误响应的 body 挂起同样受保护（降级为“响应体不可读”，按 status 判定重试语义）
  const hangErrFetch = async () => ({
    ok: false,
    status: 500,
    text: () => new Promise(() => {}),
  });
  const client2 = createLlmClient({
    baseUrl: 'https://x/v1',
    model: 'm',
    apiKey: 'k',
    fetchImpl: hangErrFetch,
    timeoutMs: 120,
    retryDelaysMs: [],
  });
  await assert.rejects(
    () => client2.chat([{ role: 'user', content: 'x' }]),
    (err) => /HTTP 500/.test(err.message) && /不可读/.test(err.message),
  );
});

test('startLlmCooldown：小时限流冷却 60 分钟，日额度耗尽冷却到次日凌晨，不回退更晚冷却', () => {
  freshHubRoot();
  // 固定到本地正午：若用 Date.now()，23 点后运行时“小时冷却（now+60min）”会晚于
  // “次日凌晨”，断言必挂（时间依赖型 flaky，实测踩中）
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  const now = base.getTime();
  startLlmCooldown('抱歉，您当前调用的API超过了10次/60.0分钟，请下一个周期再试。', now);
  const c1 = llmCooldownRemaining(now);
  assert.ok(c1.remainMs > 0 && c1.remainMs <= LLM_COOLDOWN_MS, '小时限流冷却 ≤60 分钟');

  // 日额度耗尽 → 冷却到次日凌晨（比 60 分钟更晚，覆盖生效）
  startLlmCooldown('抱歉，您今天调用ideaLAB服务的模型超过了200次，请明天再来吧！', now);
  const c2 = llmCooldownRemaining(now);
  assert.ok(c2.remainMs > c1.remainMs, '日额度冷却更晚');
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  assert.equal(Date.parse(c2.until), midnight.getTime(), '冷却到本地次日凌晨');

  // 再来一次小时限流：不回退已有的更晚冷却
  startLlmCooldown('超过了10次/60.0分钟', now);
  assert.equal(llmCooldownRemaining(now).until, c2.until, '更晚冷却不被回退');

  // 冷却过期后自动失效
  assert.equal(llmCooldownRemaining(Date.parse(c2.until) + 1000).remainMs, 0);
});

test('distill：撞限流整轮刹车（剩余批次不再调用），冷却期内下轮零调用跳过', async () => {
  freshHubRoot();
  // 两批快照（每批 40 条上限，这里 2 条小快照会进同一批 → 用大正文强制分批）
  writeSnapshot('claude', 'hub-20260814100000-r1', '快照一', 'A'.repeat(40000));
  writeSnapshot('claude', 'hub-20260814100001-r2', '快照二', 'B'.repeat(40000));

  const client = rateLimitedClient('抱歉，您当前调用的API超过了10次/60.0分钟，请下一个周期再试。');
  const r1 = await distill({ client });
  assert.equal(client.calls.length, 1, '第一批撞限流后整轮刹车，第二批不再调用');
  assert.match(String(r1.error || ''), /刹车|限流/);
  assert.ok(llmCooldownRemaining().remainMs > 0, '冷却已写入');

  const r2 = await distill({ client });
  assert.equal(r2.ok, false);
  assert.equal(r2.cooldown, true, '冷却期内直接跳过');
  assert.equal(client.calls.length, 1, '冷却期内零调用');
});

test('compact：撞限流整轮刹车并写冷却，冷却期内零调用跳过', async () => {
  freshHubRoot();
  writeWikiPage('rx-topic-one', ['hub-a1'], '内容一');
  writeWikiPage('rx-topic-two', ['hub-a2'], '内容二');
  writeWikiPage('rx-topic-three', ['hub-a3'], '内容三');

  const config = defaultConfig();
  config.compact = { ...config.compact, minClusterSize: 2 };
  const client = rateLimitedClient('抱歉，您今天调用ideaLAB服务的模型超过了200次，请明天再来吧！');
  const r1 = await compact({ config, client });
  assert.equal(client.calls.length, 1, '撞限流后不再尝试后续块/簇');
  assert.ok(llmCooldownRemaining().remainMs > 0);

  const r2 = await compact({ config, client });
  assert.equal(r2.cooldown, true, '冷却期内直接跳过');
  assert.equal(client.calls.length, 1, '冷却期内零调用');
  assert.ok(fs.existsSync(llmCooldownPath()));
});
