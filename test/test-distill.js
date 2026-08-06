/**
 * test/test-distill.js —— LLM 整理引擎（distill）+ llmClient 自测（node:test）。
 *
 * 全部在 MEMORY_HUB_ROOT 隔离的临时目录演练；LLM 客户端一律 mock 注入，
 * 不打真实网络、不触发 Keychain。
 *
 * 覆盖：
 * 1. llmClient：baseUrl/model 未配置时抛清晰错误（含 hub keys/config 指引）；
 * 2. distill 编排：sources 选取（已处理的跳过）、LLM 调用、wiki 落盘、
 *    master-index 更新、distill-state 记录、脱敏过滤、编造 hubId 过滤；
 * 3. --dry-run 不落盘不改状态；
 * 4. LLM 失败优雅降级（保留 sources、状态不变、下次重试）；
 * 5. --max-pages 限额（超出页面的快照保持未处理）。
 *
 * 运行：npm test 或 node test/test-distill.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { createLlmClient, LlmError } from '../src/llmClient.js';
import {
  distill,
  loadDistillState,
  saveDistillState,
  listUnprocessedSnapshots,
  maskSecrets,
  extractJson,
  distillStatePath,
} from '../src/distill.js';
import { ensureHubStore, storePaths } from '../src/hub-store.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-dist-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

/** 伪造一个 sources/<app>/ 快照文件（与 hub-store.ingest 产物同构）。 */
function writeSnapshot(app, hubId, title, body, extra = {}) {
  const dir = path.join(storePaths.sources, app);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `hubId: ${hubId}`,
    `app: ${app}`,
    `title: ${title}`,
    `source: ${extra.source || `/fake/${app}/${title}.md`}`,
    `ingestedAt: ${extra.ingestedAt || '2026-08-05T10:00:00.000Z'}`,
    'sha256: deadbeef',
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ];
  const p = path.join(dir, `20260805-000000-${hubId}.md`);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

/** 构造记录调用参数的 mock LLM 客户端。 */
function mockClient(reply) {
  const calls = [];
  return {
    calls,
    chat: async (messages) => {
      calls.push(messages);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(messages) : reply;
    },
  };
}

const BASE_CONFIG = { llm: { baseUrl: 'http://mock.local/v1', model: 'mock-model', keyRef: '' } };

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. llmClient 配置校验
// ---------------------------------------------------------------------------

test('llmClient：baseUrl/model/key 缺失时抛清晰错误（含 hub keys/config 指引），fetch 可注入', async () => {
  assert.throws(() => createLlmClient({}), (err) => {
    assert.ok(err instanceof LlmError);
    assert.match(err.message, /baseUrl 未配置/);
    assert.match(err.message, /hub keys --sync/);
    return true;
  });
  assert.throws(() => createLlmClient({ baseUrl: 'http://x/v1' }), /model 未配置/);
  assert.throws(() => createLlmClient({ baseUrl: 'http://x/v1', model: 'm' }), /API Key/);

  // 注入 fetch mock：验证请求体与响应解析，且 Authorization 头不外泄到错误信息
  const seen = {};
  const fakeFetch = async (url, init) => {
    seen.url = url;
    seen.init = init;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '回复内容' } }] }),
    };
  };
  const client = createLlmClient({
    baseUrl: 'http://mock.local/v1/',
    model: 'm',
    apiKey: 'sk-secret-123456',
    fetchImpl: fakeFetch,
  });
  const out = await client.chat([{ role: 'user', content: '你好' }]);
  assert.equal(out, '回复内容');
  assert.equal(seen.url, 'http://mock.local/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-secret-123456');

  // 非 2xx 错误信息不含密钥
  const errClient = createLlmClient({
    baseUrl: 'http://mock.local/v1',
    model: 'm',
    apiKey: 'sk-secret-123456',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'internal error' }),
  });
  await assert.rejects(() => errClient.chat([]), (err) => {
    assert.match(err.message, /HTTP 500/);
    assert.ok(!err.message.includes('sk-secret-123456'), '错误信息不含明文密钥');
    return true;
  });
});

// ---------------------------------------------------------------------------
// 2. distill 编排：sources 选取 / 去重归并 / wiki 落盘 / master-index / 脱敏
// ---------------------------------------------------------------------------

test('distill：mock LLM 编排全流程（选取、调用、落盘、索引、状态、脱敏、幂等）', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-h1aaa', '用户身份', '用户叫狂且。');
  writeSnapshot('codex', 'hub-h2bbb', 'ODPS 配置', '凭证 sk-abcdef123456789xyz 存于本地。', {
    ingestedAt: '2026-08-05T12:00:00.000Z',
  });
  writeSnapshot('wukong', 'hub-h3ccc', '已处理条目', '这条已经整理过。');

  // h3 已处理过 → 本次不应再进入 LLM 输入
  const st = loadDistillState();
  st.processed['hub-h3ccc'] = { page: 'old-topic', at: '2026-08-04T00:00:00.000Z' };
  saveDistillState(st);
  assert.equal(listUnprocessedSnapshots().length, 2, '已处理快照被排除');

  const reply = JSON.stringify({
    pages: [
      {
        slug: 'user-profile',
        title: '用户画像与配置',
        tags: ['用户', '配置'],
        // hub-h9zzz 为 LLM 编造（不在输入中），必须被过滤
        hubIds: ['hub-h1aaa', 'hub-h2bbb', 'hub-h9zzz'],
        content: '用户叫狂且。凭证 sk-abcdef123456789xyz 需要脱敏。\n\n⚠️ 冲突：两边说法一致，无冲突。',
      },
    ],
  });
  const client = mockClient(reply);
  const result = await distill({ client, config: BASE_CONFIG });

  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 1, '仅调用一次 LLM（去重归并）');
  const promptText = client.calls[0].map((m) => m.content).join('\n');
  assert.ok(promptText.includes('hub-h1aaa') && promptText.includes('hub-h2bbb'), '输入含未处理快照');
  assert.ok(!promptText.includes('hub-h3ccc'), '已处理快照未进入输入');

  // wiki 落盘：frontmatter hub-id/sources/last-updated/tags 齐全；编造 hubId 被过滤；密钥已脱敏
  const pagePath = path.join(storePaths.wiki, 'user-profile.md');
  assert.ok(fs.existsSync(pagePath), 'wiki 页面已落盘');
  const pageRaw = fs.readFileSync(pagePath, 'utf8');
  const fm = matter(pageRaw).data;
  assert.deepEqual(fm['hub-id'], ['hub-h1aaa', 'hub-h2bbb'], '编造 hubId 被过滤');
  assert.ok(Array.isArray(fm.sources) && fm.sources.length === 2);
  assert.ok(fm['last-updated']);
  assert.deepEqual(fm.tags, ['用户', '配置']);
  assert.ok(!pageRaw.includes('sk-abcdef123456789xyz'), '明文密钥未落盘');
  assert.ok(pageRaw.includes('sk-***已脱敏***'), '密钥已替换为脱敏标记');

  // master-index 更新
  const index = fs.readFileSync(storePaths.masterIndex, 'utf8');
  assert.match(index, /\[用户画像与配置\]\(user-profile\.md\)/);

  // distill-state 记录已处理
  const after1 = loadDistillState();
  assert.equal(after1.processed['hub-h1aaa'].page, 'user-profile');
  assert.equal(after1.processed['hub-h2bbb'].page, 'user-profile');
  assert.equal(after1.processed['hub-h3ccc'].page, 'old-topic', '既有记录不被覆盖');

  // 幂等：再跑一次无待处理快照
  const again = await distill({ client, config: BASE_CONFIG });
  assert.equal(again.pending, 0);
  assert.match(again.message, /没有待整理/);
});

// ---------------------------------------------------------------------------
// 3. 脱敏与 JSON 抽取工具
// ---------------------------------------------------------------------------

test('maskSecrets / extractJson：sk- 与 AK 模式脱敏；围栏与前后缀文字均可抽取 JSON', () => {
  const masked = maskSecrets('key=sk-abcdef123456, aliyun LTAIabcdefghij1234, access_key_id: DEADBEEF99');
  assert.ok(!masked.includes('sk-abcdef123456'));
  assert.ok(!masked.includes('LTAIabcdefghij1234'));
  assert.ok(!masked.includes('DEADBEEF99'));
  assert.match(masked, /sk-\*\*\*已脱敏\*\*\*/);

  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：[{"b":2}] 以上。'), [{ b: 2 }]);
  assert.throws(() => extractJson('没有任何结构'), /未找到 JSON/);
});

// ---------------------------------------------------------------------------
// 4. --dry-run 不落盘不改状态
// ---------------------------------------------------------------------------

test('distill --dry-run：只报告将产生的页面，不落盘、不改状态、不刷新索引', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-d1aaa', '演练条目', '演练正文。');
  const client = mockClient(
    JSON.stringify({ pages: [{ slug: 'dry-topic', title: '演练', tags: [], hubIds: ['hub-d1aaa'], content: '演练' }] }),
  );

  const result = await distill({ client, config: BASE_CONFIG, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.pages.length, 1);
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'dry-topic.md')), 'wiki 未落盘');
  assert.ok(!fs.existsSync(distillStatePath()), 'distill-state 未创建');
  assert.equal(listUnprocessedSnapshots().length, 1, '快照仍为未处理');
});

// ---------------------------------------------------------------------------
// 5. LLM 失败优雅降级 + max-pages 限额
// ---------------------------------------------------------------------------

test('distill：LLM 失败优雅降级（sources 保留、状态不变）；max-pages 限额保留剩余', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-f1aaa', '失败条目', '正文。');
  const failClient = mockClient(new Error('连接超时'));
  const bad = await distill({ client: failClient, config: BASE_CONFIG });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /LLM 调用失败.*连接超时/);
  assert.equal(bad.retained, 1);
  assert.equal(listUnprocessedSnapshots().length, 1, '失败后 sources 保留可重试');
  assert.ok(!fs.existsSync(distillStatePath()), '失败不落状态');

  // max-pages：两页只放行第一页，第二页的 hubId 保持未处理
  freshHubRoot();
  writeSnapshot('claude', 'hub-m1aaa', '条目一', '正文一。');
  writeSnapshot('codex', 'hub-m2bbb', '条目二', '正文二。');
  const twoPages = mockClient(
    JSON.stringify({
      pages: [
        { slug: 'p1', title: 'P1', tags: [], hubIds: ['hub-m1aaa'], content: 'c1' },
        { slug: 'p2', title: 'P2', tags: [], hubIds: ['hub-m2bbb'], content: 'c2' },
      ],
    }),
  );
  const limited = await distill({ client: twoPages, config: BASE_CONFIG, maxPages: 1 });
  assert.equal(limited.written.length, 1);
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'p1.md')));
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'p2.md')));
  const left = listUnprocessedSnapshots();
  assert.equal(left.length, 1, '超出限额的快照保持未处理');
  assert.equal(left[0].hubId, 'hub-m2bbb');
});

// ---------------------------------------------------------------------------
// 6. 未配置 llm 且未注入 client：报清晰配置指引并降级
// ---------------------------------------------------------------------------

test('distill：baseUrl 未配置且无注入 client 时返回清晰错误（不崩溃）', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-n1aaa', '无配置条目', '正文。');
  const result = await distill({ config: { llm: { baseUrl: '', model: '', keyRef: '' } } });
  assert.equal(result.ok, false);
  assert.match(result.error, /baseUrl|model/);
  assert.match(result.error, /hub keys/);
  assert.equal(listUnprocessedSnapshots().length, 1, 'sources 保留');
});
