/**
 * test/test-distill-hardening.js —— 蒸馏与索引层加固修复自测（Task #2）。
 *
 * 覆盖（全部在 MEMORY_HUB_ROOT 隔离目录演练，LLM 一律 mock 注入）：
 * - H3：批内内容 hash 去重、`-N` 冲突后缀同名合并、相似 slug 优先更新既有页；
 * - H4：测试标记（HUB-TEST/冒烟）快照过滤（标 processed + 一次日志）；
 * - H5：frontmatter Markdown 净化重试 + 不可解析快照物理隔离（_quarantine）；
 * - M2：毒批次失败计数与隔离（≥3 次不再重放）；
 * - M3：llmClient 指数退避重试（429/5xx 重试、4xx 不重试）+ distill 单批失败 continue；
 * - M5：TooLarge 对半拆分重试 + chunkSnapshots 请求体字节预算；
 * - M4：distill-state 加锁原子写（陈旧锁可自愈）；
 * - H7：rebuildMasterIndex 全量重建（实际计数 + hub-id 回填）；
 * - 增量写回契约：pending-writeback.json 合并写入；
 * - 页面质量守卫：孤立标题裁剪、薄页并入；M1：超长页 LLM 整页重写；
 * - category 字段产出与非法值回退。
 *
 * 运行：npm test 或 node test/test-distill-hardening.js
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
  distillStatePath,
  dedupeSnapshots,
  normalizeSnapshotName,
  hasTestMarker,
  TEST_MARKERS,
  sanitizeFrontmatterMarkdown,
  quarantineDir,
  chunkSnapshots,
  batchSignature,
  slugsSimilar,
  findSimilarPageSlug,
  trimTrailingOrphanHeadings,
  consolidateThinPages,
  normalizePages,
  appendPendingWriteback,
  pendingWritebackPath,
  CATEGORY_ENUM,
  DEFAULT_CATEGORY,
  MIN_PAGE_BYTES,
  MAX_PAGE_REWRITE_BYTES,
  MAX_BATCH_FAILURES,
} from '../src/distill.js';
import { rebuildMasterIndex, listWikiPages } from '../src/index-builder.js';
import { ensureHubStore, storePaths } from '../src/hub-store.js';
import { paths } from '../src/util/paths.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-hard-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

/** 伪造一个 sources/<app>/ 快照文件（可指定文件名，frontmatter 值一律 JSON 转义保证可解析） */
function writeSnapshot(app, hubId, title, body, extra = {}) {
  const dir = path.join(storePaths.sources, app);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `hubId: ${JSON.stringify(hubId)}`,
    `app: ${JSON.stringify(app)}`,
    `title: ${JSON.stringify(title)}`,
    `ingestedAt: ${JSON.stringify(extra.ingestedAt || '2026-08-05T10:00:00.000Z')}`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ];
  const name = extra.name || `20260805-000000-${hubId}.md`;
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

/** 从 buildMessages 产物中还原 user 段的快照 payload */
function payloadOf(messages) {
  const m = messages.find((x) => x.role === 'user');
  return JSON.parse(m.content.slice(m.content.indexOf('\n') + 1));
}

/** 构造记录调用参数的 mock LLM 客户端 */
function mockClient(reply) {
  const calls = [];
  return {
    calls,
    chat: async (messages) => {
      calls.push(messages);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(messages, calls.length) : reply;
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
// H3：批内去重与归并
// ---------------------------------------------------------------------------

test('H3a：内容 hash 物理去重——逐字相同的快照只送一份进 LLM，重复者随代表一并标 processed', async () => {
  freshHubRoot();
  const sameBody = 'ODPS 连接配置：endpoint=http://odps.internal，项目名 dxm_prod。';
  writeSnapshot('claude', 'hub-dupa1', 'ODPS 连接', sameBody);
  writeSnapshot('codex', 'hub-dupb2', 'ODPS 连接信息', sameBody, {
    ingestedAt: '2026-08-05T12:00:00.000Z',
  });

  const client = mockClient((messages) => {
    const payload = payloadOf(messages);
    return JSON.stringify({
      pages: [
        {
          slug: 'odps-connection',
          title: 'ODPS 连接配置',
          tags: [],
          category: 'project_environment_configuration',
          hubIds: payload.map((s) => s.hubId),
          content: `${sameBody}\n\n补充说明与账号申请流程等更多细节，凑足页面正文体量避免薄页并入逻辑干扰断言。`,
        },
      ],
    });
  });
  const result = await distill({ client, config: BASE_CONFIG });
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 1);
  assert.equal(payloadOf(client.calls[0]).length, 1, '内容相同的快照只保留一份进 LLM');

  const st = loadDistillState();
  assert.equal(st.processed['hub-dupb2'].page, 'odps-connection', '代表快照标 processed');
  assert.equal(st.processed['hub-dupa1'].page, 'odps-connection', '重复快照随代表一并标 processed');
  assert.equal(st.processed['hub-dupa1'].dedupOf, 'hub-dupb2', '重复者记录归并到的代表 hubId');
  assert.equal(listUnprocessedSnapshots().length, 0, '两份快照均不再待处理');

  // H7 顺带验证：e2e 主索引行回填了 hub-id
  const index = fs.readFileSync(storePaths.masterIndex, 'utf8');
  assert.match(index, /共 1 个页面/);
  assert.ok(index.includes('hub-id: '), '索引行含 hub-id 字段');
  assert.ok(index.includes('hub-dupb2'), 'hub-id 从页面 frontmatter 回填');

  // 增量写回契约：pending-writeback.json 已登记本轮页面
  const pending = JSON.parse(fs.readFileSync(pendingWritebackPath(), 'utf8'));
  assert.ok(pending.updatedAt);
  assert.equal(pending.pages.length, 1);
  assert.equal(pending.pages[0].path, 'odps-connection.md');
  assert.ok(pending.pages[0].hubIds.includes('hub-dupb2'));
});

test('H3b：源快照名归一化（剥离 -N 冲突后缀）后同名合并为一个逻辑快照，正文不丢', async () => {
  freshHubRoot();
  writeSnapshot('wukong', 'hub-nm1', '结论影响', '第一版结论正文。', {
    name: '20260806-120000-impact.md',
  });
  writeSnapshot('wukong', 'hub-nm2', '结论影响', '第二版结论正文（同名 -1 后缀）。', {
    name: '20260806-120000-impact-1.md',
    ingestedAt: '2026-08-05T11:00:00.000Z',
  });
  assert.equal(normalizeSnapshotName('/x/20260806-120000-impact-1.md'), '20260806-120000-impact');

  const snaps = listUnprocessedSnapshots();
  const { kept, members } = dedupeSnapshots(snaps);
  assert.equal(kept.length, 1, '同名快照合并为一个逻辑快照');
  assert.ok(kept[0].body.includes('第一版结论正文'), '双方正文都保留');
  assert.ok(kept[0].body.includes('第二版结论正文'), '双方正文都保留');
  assert.equal(members.get(kept[0].hubId).length, 1, '被合并者挂在代表名下');

  const client = mockClient((messages) => {
    const payload = payloadOf(messages);
    assert.equal(payload.length, 1);
    return JSON.stringify({
      pages: [
        {
          slug: 'impact-topic',
          title: '结论影响',
          tags: [],
          hubIds: [payload[0].hubId],
          content: '归并后的结论影响完整正文，包含两版内容的提炼结果，篇幅足够不触发薄页并入。'.repeat(3),
        },
      ],
    });
  });
  const result = await distill({ client, config: BASE_CONFIG });
  assert.equal(result.ok, true);
  const st = loadDistillState();
  assert.equal(st.processed['hub-nm1'].page, 'impact-topic');
  assert.equal(st.processed['hub-nm2'].page, 'impact-topic');
});

test('H3c：创建新页前按归一化 slug 相似度查找既有页，优先 update 既有页而非新建 slug', async () => {
  freshHubRoot();
  // 既有页面（review 证据中的重复对之一）
  const existingSlug = 'impact-of-analysis-scope-on-conclusions';
  const existingPath = path.join(storePaths.wiki, `${existingSlug}.md`);
  fs.writeFileSync(
    existingPath,
    matter.stringify('# 分析范围对结论的影响\n\n既有正文。\n', {
      'hub-id': ['hub-old0'],
      sources: [],
      'last-updated': '2026-08-01T00:00:00.000Z',
      tags: ['分析'],
      category: 'task_summary_experience',
    }),
  );
  assert.equal(slugsSimilar('impact-on-conclusions', existingSlug), true);
  assert.equal(slugsSimilar('odps-config', 'odps-connection-info'), false, '词集不含关系不误归并');
  assert.equal(findSimilarPageSlug('impact-on-conclusions', ''), existingSlug);

  writeSnapshot('codex', 'hub-sc1', '影响结论', '新的一批关于分析范围影响结论的内容。');
  const client = mockClient(
    JSON.stringify({
      pages: [
        {
          slug: 'impact-on-conclusions',
          title: '分析范围对结论的影响',
          tags: [],
          hubIds: ['hub-sc1'],
          content: '新增：范围收窄会使转化率结论偏乐观。',
        },
      ],
    }),
  );
  const result = await distill({ client, config: BASE_CONFIG });
  assert.equal(result.ok, true);
  assert.ok(
    !fs.existsSync(path.join(storePaths.wiki, 'impact-on-conclusions.md')),
    '不新建相似 slug 页面',
  );
  const page = fs.readFileSync(existingPath, 'utf8');
  const fm = matter(page).data;
  assert.deepEqual(fm['hub-id'].sort(), ['hub-old0', 'hub-sc1'], 'hub-id 并集');
  assert.ok(page.includes('既有正文'), '旧正文保留');
  assert.ok(page.includes('偏乐观'), '新内容并入');
  assert.equal(loadDistillState().processed['hub-sc1'].page, existingSlug);
});

// ---------------------------------------------------------------------------
// H4：测试标记过滤
// ---------------------------------------------------------------------------

test('H4：含 HUB-TEST/冒烟标记的快照直接标 processed 跳过，不进入蒸馏、不产出 wiki', async () => {
  freshHubRoot();
  assert.ok(TEST_MARKERS.includes('HUB-TEST'), '标记清单为可配置常量');
  assert.equal(hasTestMarker({ title: 'x', body: '本条为 HUB-TEST 冒烟产物' }), true);
  assert.equal(hasTestMarker({ title: 'N4 冒烟验证', body: '正文' }), true);
  assert.equal(hasTestMarker({ title: '正常', body: '正常正文' }), false);

  writeSnapshot('claude', 'hub-tm1', 'HUB-TEST 冒烟条目', '这是 N4 冒烟测试产物。');
  writeSnapshot('claude', 'hub-tm2', '正常条目', '正常业务内容，值得整理进 wiki 的真实记忆。');
  const client = mockClient((messages) => {
    const payload = payloadOf(messages);
    assert.equal(payload.length, 1, '测试标记快照不进入 LLM 输入');
    assert.equal(payload[0].hubId, 'hub-tm2');
    return JSON.stringify({
      pages: [{ slug: 'normal-topic', title: '正常主题', tags: [], hubIds: ['hub-tm2'], content: '整理后的正常内容。' }],
    });
  });
  const result = await distill({ client, config: BASE_CONFIG });
  assert.equal(result.ok, true);
  const st = loadDistillState();
  assert.equal(st.processed['hub-tm1'].skipped, 'test-marker', '测试快照标 processed 且注明原因');
  assert.equal(st.processed['hub-tm1'].page, '');
  const log = fs.readFileSync(path.join(paths.logs, 'distill.log'), 'utf8');
  assert.match(log, /测试标记快照跳过蒸馏/);
  // wiki 中不含测试产物
  for (const p of listWikiPages()) {
    assert.ok(!fs.readFileSync(p, 'utf8').includes('HUB-TEST'), '测试标记绝不泄漏进 wiki');
  }

  // 全部为测试标记时：LLM 零调用、直接返回无待整理
  const before = client.calls.length;
  writeSnapshot('claude', 'hub-tm3', '又一条', '冒烟测试标记内容 HUB-TEST。');
  const again = await distill({ client, config: BASE_CONFIG });
  assert.equal(again.pending, 0);
  assert.equal(client.calls.length, before, '全为测试标记时不调用 LLM');
});

// ---------------------------------------------------------------------------
// H5：frontmatter 容错 + 隔离
// ---------------------------------------------------------------------------

test('H5a：`title: **xxx**` 类 Markdown 语法净化重试后可解析，快照不丢', async () => {
  freshHubRoot();
  const dir = path.join(storePaths.sources, 'wukong');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '20260701-000000-legacy.md');
  fs.writeFileSync(file, '---\nhubId: hub-h5a1\napp: wukong\ntitle: **重要配置**\ningestedAt: "2026-07-01T00:00:00.000Z"\n---\n\n正文内容。\n');

  assert.equal(sanitizeFrontmatterMarkdown('无 frontmatter'), null);
  const snaps = listUnprocessedSnapshots();
  assert.equal(snaps.length, 1, '净化重试后快照可读');
  assert.equal(snaps[0].hubId, 'hub-h5a1');
  assert.equal(snaps[0].title, '重要配置', 'Markdown 加粗语法被剥离');
  assert.ok(fs.existsSync(file), '可净化的快照不隔离');
});

test('H5b：净化仍不可解析的快照移入 _quarantine/<app>/ 并记入 distill-state，后续扫描跳过', async () => {
  freshHubRoot();
  const dir = path.join(storePaths.sources, 'wukong');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '20260701-000000-broken.md');
  fs.writeFileSync(file, '---\nhubId: hub-h5b1\nbroken: [unclosed\n---\n\n正文。\n');

  const state = loadDistillState();
  const snaps = listUnprocessedSnapshots(state, { quarantine: true });
  assert.equal(snaps.length, 0);
  assert.ok(!fs.existsSync(file), '原位文件已移走');
  const dest = path.join(quarantineDir(), 'wukong', '20260701-000000-broken.md');
  assert.ok(fs.existsSync(dest), '隔离区保留 <app>/ 相对路径');
  assert.ok(state.quarantined['wukong/20260701-000000-broken.md'], '隔离记录写入 state');
  const persisted = loadDistillState();
  assert.ok(persisted.quarantined['wukong/20260701-000000-broken.md'], '隔离清单已落盘');
  const log1 = fs.readFileSync(path.join(paths.logs, 'distill.log'), 'utf8');
  assert.equal(log1.split('已隔离至 _quarantine').length - 1, 1, '日志只记一次');

  // 再扫一轮：隔离区不参与扫描、不再报警
  const snaps2 = listUnprocessedSnapshots(loadDistillState(), { quarantine: true });
  assert.equal(snaps2.length, 0);
  const log2 = fs.readFileSync(path.join(paths.logs, 'distill.log'), 'utf8');
  assert.equal(log2.split('已隔离至 _quarantine').length - 1, 1, '重扫不重复报警');
});

// ---------------------------------------------------------------------------
// M2：毒批次隔离
// ---------------------------------------------------------------------------

test('M2：解析失败达 3 次的批次记入隔离清单并告警一次，之后不再重放', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-poison1', '毒批条目', '会让 LLM 输出垃圾的内容。');
  const client = mockClient('这不是 JSON，解析必然失败');

  for (let i = 1; i <= MAX_BATCH_FAILURES; i += 1) {
    const r = await distill({ client, config: BASE_CONFIG });
    assert.equal(r.ok, false, `第 ${i} 轮解析失败`);
  }
  assert.equal(client.calls.length, MAX_BATCH_FAILURES);
  const st = loadDistillState();
  const sigs = Object.keys(st.poisonedBatches);
  assert.equal(sigs.length, 1, '毒批次进入隔离清单');
  assert.deepEqual(st.poisonedBatches[sigs[0]].hubIds, ['hub-poison1']);
  assert.equal(st.poisonedBatches[sigs[0]].failCount, MAX_BATCH_FAILURES);
  assert.deepEqual(st.batchFailures, {}, '隔离后失败计数清除');
  const log = fs.readFileSync(path.join(paths.logs, 'distill.log'), 'utf8');
  assert.equal(log.split('毒批次隔离告警').length - 1, 1, '告警只记一次');

  // 第 4 轮：不再调用 LLM
  const r4 = await distill({ client, config: BASE_CONFIG });
  assert.equal(client.calls.length, MAX_BATCH_FAILURES, '隔离批次不再重放');
  assert.equal(r4.ok, true);
  assert.equal(r4.skippedPoisoned, 1);
});

// ---------------------------------------------------------------------------
// M3：llmClient 重试 + distill 单批失败 continue
// ---------------------------------------------------------------------------

test('M3a：llmClient 对 5xx/网络错误指数退避重试，429 判限流不重试，4xx 不重试，TooLarge 带标记', async () => {
  const base = { baseUrl: 'http://mock.local/v1', model: 'm', apiKey: 'k', retryDelaysMs: [1, 1] };

  // 5xx 两次后成功 → 共 3 次
  let n500 = 0;
  const c500 = createLlmClient({
    ...base,
    fetchImpl: async () => {
      n500 += 1;
      if (n500 < 3) return { ok: false, status: 500, text: async () => 'internal' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '成功' } }] }) };
    },
  });
  assert.equal(await c500.chat([]), '成功');
  assert.equal(n500, 3);

  // 429 限流：绝不重试（失败调用照样计额度，上层整轮刹车进入冷却）
  let n429 = 0;
  const c429 = createLlmClient({
    ...base,
    fetchImpl: async () => {
      n429 += 1;
      return { ok: false, status: 429, text: async () => 'rate limited' };
    },
  });
  await assert.rejects(() => c429.chat([]), (err) => /HTTP 429/.test(err.message) && err.rateLimited === true);
  assert.equal(n429, 1);

  // 网络错误可重试
  let nNet = 0;
  const cNet = createLlmClient({
    ...base,
    fetchImpl: async () => {
      nNet += 1;
      if (nNet < 2) throw new Error('socket hang up');
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    },
  });
  assert.equal(await cNet.chat([]), 'ok');
  assert.equal(nNet, 2);

  // 400 业务错误不重试
  let n400 = 0;
  const c400 = createLlmClient({
    ...base,
    fetchImpl: async () => {
      n400 += 1;
      return { ok: false, status: 400, text: async () => 'bad request' };
    },
  });
  await assert.rejects(() => c400.chat([]), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(n400, 1, '4xx 不重试');

  // TooLarge：不重试且带 tooLarge 标记
  let nTL = 0;
  const cTL = createLlmClient({
    ...base,
    fetchImpl: async () => {
      nTL += 1;
      return { ok: false, status: 400, text: async () => 'BadRequest.TooLarge: 6291456' };
    },
  });
  await assert.rejects(() => cTL.chat([]), (err) => {
    assert.ok(err instanceof LlmError);
    assert.equal(err.tooLarge, true);
    return true;
  });
  assert.equal(nTL, 1, 'TooLarge 不原地重试（上层拆分）');
});

test('M3b：distill 单批 LLM 调用失败 continue 而非 break，后续批次照常产出', async () => {
  freshHubRoot();
  // 16 条 ~4KB 快照 → 默认 64KB 预算切成 2 批
  for (let i = 0; i < 16; i += 1) {
    writeSnapshot('codex', `hub-mb${i}`, `条目${i}`, `${i}-${'x'.repeat(4000)}`);
  }
  const client = mockClient((messages, callNo) => {
    if (callNo === 1) throw new LlmError('连接被重置', { retryable: true });
    const payload = payloadOf(messages);
    return JSON.stringify({
      pages: [
        {
          slug: `batch-page-${callNo}`,
          title: `批次页${callNo}`,
          tags: [],
          hubIds: payload.map((s) => s.hubId),
          content: '第二批正常产出的内容。'.repeat(40),
        },
      ],
    });
  });
  const result = await distill({ client, config: BASE_CONFIG });
  assert.equal(client.calls.length, 2, '首批失败后仍继续处理后续批次');
  assert.equal(result.ok, true, '有产出即整体成功');
  assert.match(result.error, /LLM 调用失败/, '失败批次记录在 error 中');
  assert.equal(result.written.length, 1);
  assert.ok(listUnprocessedSnapshots().length > 0, '失败批次的快照保留下轮重试');
});

// ---------------------------------------------------------------------------
// M5：TooLarge 对半拆分 + 字节预算预切分
// ---------------------------------------------------------------------------

test('M5a：收到 TooLarge 时批次对半拆分重试，全部快照最终处理完', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-tl-aa', '大条目一', '第一条大内容正文。');
  writeSnapshot('claude', 'hub-tl-bb', '大条目二', '第二条大内容正文。');
  const client = mockClient((messages) => {
    const payload = payloadOf(messages);
    if (payload.length > 1) {
      throw new LlmError('LLM 返回 HTTP 400: BadRequest.TooLarge: 6291456', {
        status: 400,
        tooLarge: true,
      });
    }
    return JSON.stringify({
      pages: [
        {
          slug: `page-${payload[0].hubId}`,
          title: `页面 ${payload[0].hubId}`,
          tags: [],
          hubIds: [payload[0].hubId],
          content: '拆分后单条批次的整理产出内容。'.repeat(30),
        },
      ],
    });
  });
  const result = await distill({ client, config: BASE_CONFIG });
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 3, '1 次 TooLarge + 2 次拆分后成功');
  assert.equal(result.written.length, 2);
  assert.equal(listUnprocessedSnapshots().length, 0, '拆分后全部快照处理完');
  const log = fs.readFileSync(path.join(paths.logs, 'distill.log'), 'utf8');
  assert.match(log, /对半拆分重试/);
});

test('M5b：chunkSnapshots 请求体字节预算硬约束预切分', () => {
  const mk = (id, len) => ({ hubId: id, app: 'x', title: 't', ingestedAt: '', body: 'x'.repeat(len), file: `/x/${id}.md` });
  // 缺省预算下小快照一批装下
  assert.equal(chunkSnapshots([mk('a', 100), mk('b', 100)]).length, 1);
  // 收紧 maxRequestBytes 后被强制切分
  const tight = chunkSnapshots([mk('a', 1000), mk('b', 1000), mk('c', 1000)], { maxRequestBytes: 1500 });
  assert.equal(tight.length, 3, '请求体预算硬约束生效');
  // 签名与顺序无关
  assert.equal(batchSignature([mk('a', 1), mk('b', 1)]), batchSignature([mk('b', 1), mk('a', 1)]));
});

// ---------------------------------------------------------------------------
// M4：distill-state 加锁原子写
// ---------------------------------------------------------------------------

test('M4：saveDistillState 走 withLock + 原子写，陈旧锁可自愈且锁最终释放', () => {
  freshHubRoot();
  fs.mkdirSync(paths.state, { recursive: true });
  // 伪造死进程持有的陈旧锁
  const lockFile = `${distillStatePath()}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 4194000, ts: Date.now() - 120000 }));
  const state = loadDistillState();
  state.processed['hub-lk1'] = { page: 'p', at: '2026-08-07T00:00:00.000Z' };
  saveDistillState(state);
  assert.equal(loadDistillState().processed['hub-lk1'].page, 'p', '陈旧锁被清理后正常写入');
  assert.ok(!fs.existsSync(lockFile), '写完释放锁');
});

// ---------------------------------------------------------------------------
// H7：rebuildMasterIndex 全量重建 + hub-id 回填
// ---------------------------------------------------------------------------

test('H7：rebuildMasterIndex 收录全部页面（含子目录）、计数用实际值、回填 frontmatter hub-id', () => {
  freshHubRoot();
  fs.writeFileSync(
    path.join(storePaths.wiki, 'alpha-topic.md'),
    matter.stringify('# Alpha 主题\n\nAlpha 摘要行。\n', { 'hub-id': ['hub-a1', 'hub-a2'], tags: [] }),
  );
  fs.writeFileSync(path.join(storePaths.wiki, 'beta.md'), '# Beta 主题\n\nBeta 摘要。\n');
  fs.mkdirSync(path.join(storePaths.wiki, 'nested'), { recursive: true });
  fs.writeFileSync(
    path.join(storePaths.wiki, 'nested', 'gamma.md'),
    matter.stringify('# Gamma 主题\n\nGamma 摘要。\n', { 'hub-id': ['hub-g1'] }),
  );

  const p = rebuildMasterIndex();
  const index = fs.readFileSync(p, 'utf8');
  assert.match(index, /共 3 个页面/, '头部计数用实际值');
  assert.match(index, /\[Alpha 主题\]\(alpha-topic\.md\).*hub-id: hub-a1, hub-a2/, 'hub-id 回填');
  assert.match(index, /\[Beta 主题\]\(beta\.md\).*hub-id: 无/, '无 frontmatter 页面 hub-id 记「无」');
  assert.match(index, /\[Gamma 主题\]\(nested\/gamma\.md\).*hub-id: hub-g1/, '子目录页面不漏收');
  assert.ok(!index.includes('README'), 'README 占位不收录');
});

// ---------------------------------------------------------------------------
// 增量写回契约：pending-writeback.json 合并写入
// ---------------------------------------------------------------------------

test('增量写回契约：文件已存在且未被消费时按 path 去重合并 hubIds 后原子写入', () => {
  freshHubRoot();
  fs.mkdirSync(paths.state, { recursive: true });
  // 预置未消费内容
  fs.writeFileSync(
    pendingWritebackPath(),
    JSON.stringify({ updatedAt: '2026-08-06T00:00:00.000Z', pages: [{ path: 'a.md', hubIds: ['hub-1'] }] }),
  );
  const out = appendPendingWriteback(
    [
      { path: 'a.md', hubIds: ['hub-1', 'hub-2'] },
      { path: 'b.md', hubIds: ['hub-3'] },
    ],
    '2026-08-07T00:00:00.000Z',
  );
  assert.equal(out.updatedAt, '2026-08-07T00:00:00.000Z');
  const byPath = Object.fromEntries(out.pages.map((e) => [e.path, e.hubIds]));
  assert.deepEqual(byPath['a.md'].sort(), ['hub-1', 'hub-2'], '同 path 合并且 hubIds 去重');
  assert.deepEqual(byPath['b.md'], ['hub-3']);
  const disk = JSON.parse(fs.readFileSync(pendingWritebackPath(), 'utf8'));
  assert.deepEqual(disk, out, '落盘内容与返回一致（tmp+rename 原子写）');
  // 契约字段逐字校验
  assert.deepEqual(Object.keys(disk).sort(), ['pages', 'updatedAt']);
  assert.deepEqual(Object.keys(disk.pages[0]).sort(), ['hubIds', 'path']);
});

// ---------------------------------------------------------------------------
// 页面质量守卫：孤立标题裁剪 + 薄页并入
// ---------------------------------------------------------------------------

test('质量守卫：合并结果不以孤立标题结尾（写前裁剪）', async () => {
  assert.equal(trimTrailingOrphanHeadings('# 页\n\n正文\n\n## 孤立标题\n\n### 又一个'), '# 页\n\n正文');
  assert.equal(trimTrailingOrphanHeadings('# 页\n\n正文结尾'), '# 页\n\n正文结尾');
  assert.equal(trimTrailingOrphanHeadings('# 只有标题'), '# 只有标题', '单行标题不裁剪');

  freshHubRoot();
  writeSnapshot('claude', 'hub-qg1', '守卫条目', '需要整理的内容。');
  const client = mockClient(
    JSON.stringify({
      pages: [
        {
          slug: 'guard-topic',
          title: '守卫主题',
          tags: [],
          hubIds: ['hub-qg1'],
          content: `${'正文内容充足，避免薄页逻辑干扰。'.repeat(30)}\n\n## 孤立结尾标题`,
        },
      ],
    }),
  );
  const r = await distill({ client, config: BASE_CONFIG });
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(path.join(storePaths.wiki, 'guard-topic.md'), 'utf8');
  assert.ok(!raw.includes('孤立结尾标题'), '孤立结尾标题被裁剪');
  assert.ok(raw.includes('正文内容充足'), '正文保留');
});

test('质量守卫：<400B 独立薄页并入同批主题页（hubIds/tags 一并归并），不单独立页', async () => {
  freshHubRoot();
  writeSnapshot('claude', 'hub-thin1', '大主题条目', '主内容。');
  writeSnapshot('codex', 'hub-thin2', '零碎条目', '一点零碎信息。');
  const bigContent = '主主题的完整整理内容，信息量充足。'.repeat(30); // >400B
  const client = mockClient(
    JSON.stringify({
      pages: [
        { slug: 'main-topic', title: '主主题', tags: ['主'], hubIds: ['hub-thin1'], content: bigContent },
        { slug: 'tiny-topic', title: '零碎主题', tags: ['碎'], hubIds: ['hub-thin2'], content: '很短。' },
      ],
    }),
  );
  const r = await distill({ client, config: BASE_CONFIG });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'tiny-topic.md')), '薄页不单独立页');
  const raw = fs.readFileSync(path.join(storePaths.wiki, 'main-topic.md'), 'utf8');
  const fm = matter(raw).data;
  assert.ok(raw.includes('## 零碎主题'), '薄页内容并入主题页为小节');
  assert.ok(raw.includes('很短。'));
  assert.deepEqual(fm['hub-id'].sort(), ['hub-thin1', 'hub-thin2'], 'hubIds 归并');
  assert.deepEqual(fm.tags.sort(), ['主', '碎'], 'tags 归并');
  assert.equal(loadDistillState().processed['hub-thin2'].page, 'main-topic');

  // 单元：无可承接主题页时薄页保持原样（宁薄不丢）
  const only = [{ slug: 's', title: 't', tags: [], hubIds: ['h'], content: '短', sources: [] }];
  assert.equal(consolidateThinPages(only).length, 1);
  assert.ok(Buffer.byteLength(bigContent, 'utf8') >= MIN_PAGE_BYTES);
});

// ---------------------------------------------------------------------------
// M1：超长页触发 LLM 整页重写归并
// ---------------------------------------------------------------------------

test('M1：单页超过 24KB 时下次更新触发整页重写（非追加「## 更新」），失败回退追加', async () => {
  freshHubRoot();
  // 预置超过阈值的既有页
  const bigBody = `# 大主题\n\n${'既有内容段落，历史累积很长。'.repeat(2000)}`;
  assert.ok(Buffer.byteLength(bigBody, 'utf8') > MAX_PAGE_REWRITE_BYTES);
  const pagePath = path.join(storePaths.wiki, 'big-topic.md');
  fs.writeFileSync(
    pagePath,
    matter.stringify(`${bigBody}\n`, {
      'hub-id': ['hub-big-old'],
      sources: [],
      'last-updated': '2026-08-01T00:00:00.000Z',
      tags: ['旧'],
      category: 'project_tech_stack',
    }),
  );
  writeSnapshot('claude', 'hub-big-new', '大主题', '新增的一段内容。');

  const client = mockClient((messages) => {
    const sys = messages[0].content;
    if (sys.includes('重写引擎')) {
      // 整页重写调用：校验输入含既有正文与新增内容
      const input = JSON.parse(messages[1].content);
      assert.ok(input.existing.includes('既有内容段落'));
      assert.ok(input.incoming.includes('新增的一段内容'));
      return JSON.stringify({ title: '大主题', content: '整页重写归并后的精炼正文，吸收了全部历史更新区。' });
    }
    return JSON.stringify({
      pages: [{ slug: 'big-topic', title: '大主题', tags: ['新'], hubIds: ['hub-big-new'], content: '新增的一段内容。'.repeat(40) }],
    });
  });
  const r = await distill({ client, config: BASE_CONFIG });
  assert.equal(r.ok, true);
  assert.equal(client.calls.length, 2, 'distill 调用 + 整页重写调用');
  const raw = fs.readFileSync(pagePath, 'utf8');
  const fm = matter(raw).data;
  assert.ok(raw.includes('整页重写归并后的精炼正文'), '页面被整体重写');
  assert.ok(!raw.includes('## 更新（'), '不再追加「## 更新」区');
  assert.deepEqual(fm['hub-id'].sort(), ['hub-big-new', 'hub-big-old'], 'hub-id 并集保留');
  assert.equal(fm.category, 'project_tech_stack', 'category 保留旧值');

  // 重写调用失败 → 回退确定性的追加合并，内容绝不丢
  freshHubRoot();
  const pagePath2 = path.join(storePaths.wiki, 'big-topic.md');
  fs.writeFileSync(
    pagePath2,
    matter.stringify(`${bigBody}\n`, { 'hub-id': ['hub-big-old'], sources: [], 'last-updated': '', tags: [] }),
  );
  writeSnapshot('claude', 'hub-big-n2', '大主题', '第二轮新增内容。');
  const client2 = mockClient((messages) => {
    if (messages[0].content.includes('重写引擎')) throw new LlmError('重写超时', { retryable: false });
    return JSON.stringify({
      pages: [{ slug: 'big-topic', title: '大主题', tags: [], hubIds: ['hub-big-n2'], content: '第二轮新增内容。'.repeat(40) }],
    });
  });
  const r2 = await distill({ client: client2, config: BASE_CONFIG });
  assert.equal(r2.ok, true);
  const raw2 = fs.readFileSync(pagePath2, 'utf8');
  assert.ok(raw2.includes('## 更新（'), '重写失败回退追加合并');
  assert.ok(raw2.includes('既有内容段落'), '旧正文保留');
  assert.ok(raw2.includes('第二轮新增内容'), '新内容写入');
});

// ---------------------------------------------------------------------------
// category 字段产出
// ---------------------------------------------------------------------------

test('category：prompt 枚举约束 + normalizePages 校验回退 + frontmatter 落盘', async () => {
  // 单元：合法值保留、非法/缺失回退缺省
  const pages = normalizePages({
    pages: [
      { slug: 'a', title: 'A', hubIds: ['h1'], content: 'x', category: 'common_pitfalls_experience' },
      { slug: 'b', title: 'B', hubIds: ['h2'], content: 'y', category: '不合法分类' },
      { slug: 'c', title: 'C', hubIds: ['h3'], content: 'z' },
    ],
  });
  assert.equal(pages[0].category, 'common_pitfalls_experience');
  assert.equal(pages[1].category, DEFAULT_CATEGORY);
  assert.equal(pages[2].category, DEFAULT_CATEGORY);
  assert.equal(CATEGORY_ENUM.length, 9, '枚举共 9 个取值');

  // e2e：category 写入页面 frontmatter；prompt 含枚举与命名约束
  freshHubRoot();
  writeSnapshot('qoder', 'hub-cat1', '踩坑记录', 'session_id 与 touch_id 不等价。');
  const client = mockClient((messages) => {
    assert.ok(messages[0].content.includes('kebab-case'), 'prompt 约束 slug 英文 kebab-case');
    assert.ok(messages[0].content.includes('title（统一用中文）'), 'prompt 约束标题中文');
    assert.ok(messages[0].content.includes('common_pitfalls_experience'), 'prompt 含 category 枚举');
    return JSON.stringify({
      pages: [
        {
          slug: 'odps-session-touch-pitfall',
          title: 'ODPS session 与 touch 桥接踩坑',
          tags: [],
          category: 'common_pitfalls_experience',
          hubIds: ['hub-cat1'],
          content: 'session_id 与 touch_id 不等价，需经 mock 消息表桥接。'.repeat(10),
        },
      ],
    });
  });
  const r = await distill({ client, config: BASE_CONFIG });
  assert.equal(r.ok, true);
  const fm = matter(fs.readFileSync(path.join(storePaths.wiki, 'odps-session-touch-pitfall.md'), 'utf8')).data;
  assert.equal(fm.category, 'common_pitfalls_experience');
});
