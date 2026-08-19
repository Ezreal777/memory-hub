/**
 * test/test-echo-guard.js —— 回声护栏（echo guard）自测（node:test）。
 *
 * 背景：hub 写回到各 App 的渲染产物，被 App 客户端重组目录（qoder 跨 category
 * 挪文件）或追加文件（qoderwork daily / codex AGENTS.md）后，路径/hash 变化
 * 绕过 inflight 抑制，被当成新记忆重新摄取 → 蒸馏 → 再写回，形成回声循环
 * （实测单日膨胀 1.3 万条快照）。护栏分两层：
 * - 采集层（hub-store.isEchoEntry）：harvest 与 watcher 摄取前按内容指纹拦截；
 * - 蒸馏层（distill.hasEchoMarker）：护栏上线前漏进 sources 的存量回声快照，
 *   蒸馏前标 processed（skipped:'echo'）跳过，不烧 token 不进 wiki。
 *
 * 全部在 MEMORY_HUB_ROOT 隔离的临时目录演练；LLM 客户端 mock 注入。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isEchoEntry, harvest, ensureHubStore, storePaths, ingest } from '../src/hub-store.js';
import { distill, hasEchoMarker, loadDistillState } from '../src/distill.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-echo-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-echo-home-'));
  tmpRoots.push(dir);
  return dir;
}

function writeAt(home, rel, content) {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 伪造一个 sources/<app>/ 快照文件（与 hub-store.ingest 产物同构） */
function writeSnapshot(app, hubId, title, body, extra = {}) {
  const dir = path.join(storePaths.sources, app);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `hubId: "${hubId}"`,
    `app: "${app}"`,
    `title: "${title}"`,
    `source: "/fake/${app}/${title}.md"`,
    `ingestedAt: "2026-08-13T10:00:00.000Z"`,
    'sha256: "deadbeef"',
    ...(extra.frontmatter ? [`frontmatter: ${JSON.stringify(extra.frontmatter)}`] : []),
    '---',
    '',
    body,
    '',
  ];
  const file = path.join(dir, `20260813-100000-${hubId}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function mockClient(reply = '{"pages":[]}') {
  const calls = [];
  return {
    calls,
    chat: async (messages) => {
      calls.push(messages);
      return typeof reply === 'function' ? reply(messages, calls.length) : reply;
    },
  };
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 采集层：isEchoEntry 三类指纹
// ---------------------------------------------------------------------------

test('isEchoEntry：正文 [hub-…] 标记 / chatId hub- 前缀 / source=memory-hub 均判回声，原生内容放行', () => {
  // 指纹一：正文含 hub 写回渲染标记（qoder/claude/codex 写回体）
  assert.equal(isEchoEntry({ body: '[hub-20260812135717-m1uzyn]\n## 功能概述\n……' }), true);
  assert.equal(isEchoEntry({ body: '前文\n[hub-20260812135717-m1uzyn]\n后文' }), true, '行内标记也命中');
  // 指纹二：qoderwork daily 块的 chatId 为 hub- 前缀
  assert.equal(isEchoEntry({ body: '正常正文', frontmatter: { kind: 'memory-chat', chatId: 'hub-20260807091308-kjczjw' } }), true);
  // 指纹三：qoder 写回 frontmatter 固定字段
  assert.equal(isEchoEntry({ body: '正常正文', frontmatter: { source: 'memory-hub' } }), true);

  // 原生内容放行
  assert.equal(isEchoEntry({ body: '用户自己的记忆，讲到 hub 这个词但没有标记' }), false);
  assert.equal(isEchoEntry({ body: '原生 daily', frontmatter: { kind: 'memory-chat', chatId: 'msol2u8hni0qhd1q' } }), false);
  assert.equal(isEchoEntry({ body: '原生', frontmatter: { source: 'auto' } }), false);
  assert.equal(isEchoEntry({ body: '格式不完整 [hub-2026-abc] 不是合法 hubId' }), false, '非 genHubId 格式不误杀');
});

test('harvest：回声条目被拦截不进 sources，echoSkipped 计数返回', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  // 一个原生记忆 + 一个 hub 写回产物（含渲染标记，模拟被 App 重组后绕过 inflight）
  writeAt(home, '.claude/projects/proj/memory/native.md', '---\nname: native\n---\n原生记忆内容');
  writeAt(home, '.claude/projects/proj/memory/echoed.md', '---\nname: echoed\n---\n[hub-20260812135717-m1uzyn]\nhub 写回的渲染内容');

  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const r = harvest(adapter);
  assert.equal(r.ingested, 1, '只摄取原生记忆');
  assert.equal(r.echoSkipped, 1, '回声条目计数');

  const snaps = fs.readdirSync(path.join(storePaths.sources, 'claude'));
  assert.equal(snaps.length, 1, 'sources 只落一个快照');
  const content = fs.readFileSync(path.join(storePaths.sources, 'claude', snaps[0]), 'utf8');
  assert.match(content, /原生记忆内容/);
  assert.ok(!content.includes('hub-20260812135717'), '回声内容未落盘');
});

// ---------------------------------------------------------------------------
// 蒸馏层：存量回声快照兜底
// ---------------------------------------------------------------------------

test('distill：存量回声快照标 processed skipped:echo，不调 LLM 不进 wiki', async () => {
  freshHubRoot();
  // 正文标记型回声（qoder 重组产物）
  writeSnapshot('qoder', 'hub-20260813110000-echo01', '回声一', '[hub-20260812135717-m1uzyn]\nhub 写回的内容');
  // rawFrontmatter chatId 型回声（qoderwork daily 产物）
  writeSnapshot('qoderwork', 'hub-20260813110001-echo02', '回声二', '看似正常的正文', {
    frontmatter: '{"kind":"memory-chat","chatId":"hub-20260807091308-kjczjw"}',
  });
  // rawFrontmatter source 型回声（qoder 写回 frontmatter 字段幸存的情况）
  writeSnapshot('qoder', 'hub-20260813110002-echo03', '回声三', '看似正常的正文', {
    frontmatter: '{"title":"x","source":"memory-hub"}',
  });
  // 一条真实记忆
  writeSnapshot('claude', 'hub-20260813110003-real01', '真实记忆', '用户的真实记忆内容。');

  const client = mockClient(
    JSON.stringify({
      pages: [
        {
          slug: 'real-memory-page',
          title: '真实记忆页',
          tags: [],
          category: 'project_introduction',
          content: '真实内容。',
          hubIds: ['hub-20260813110003-real01'],
        },
      ],
    }),
  );
  const r = await distill({ client });
  assert.equal(r.ok, true);
  assert.equal(r.pending, 1, '只有真实记忆进入蒸馏');
  assert.equal(client.calls.length, 1);

  const state = loadDistillState();
  assert.equal(state.processed['hub-20260813110000-echo01'].skipped, 'echo');
  assert.equal(state.processed['hub-20260813110001-echo02'].skipped, 'echo');
  assert.equal(state.processed['hub-20260813110002-echo03'].skipped, 'echo');
  assert.equal(state.processed['hub-20260813110003-real01'].page, 'real-memory-page');

  // 回声内容绝不进 wiki
  const wikiFiles = fs.readdirSync(storePaths.wiki).filter((f) => f.endsWith('.md') && f !== 'README.md');
  assert.equal(wikiFiles.length, 1);

  // 第二轮：已标 processed，不再重复处理
  const r2 = await distill({ client });
  assert.equal(r2.pending, 0, '回声快照不复活');
});

test('hasEchoMarker：与 isEchoEntry 同口径（作用于快照结构）', () => {
  assert.equal(hasEchoMarker({ body: '[hub-20260812135717-m1uzyn]\n内容' }), true);
  assert.equal(hasEchoMarker({ body: '内容', rawFrontmatter: '{"chatId":"hub-20260807091308-kjczjw"}' }), true);
  assert.equal(hasEchoMarker({ body: '内容', rawFrontmatter: '{"source":"memory-hub"}' }), true);
  assert.equal(hasEchoMarker({ body: '正常内容', rawFrontmatter: '{"source":"auto"}' }), false);
});

// ---------------------------------------------------------------------------
// 第二代防线（echo-storm 2026-08-19）：codex 聚合文件回声雪球
// 写回 AGENTS.md 的 wiki 页正文自带 H2，旧 parse 按全文切节把它们全量重摄取
// （单文件滚到 11MB/1.3 万 H2，单日 3.5 万份重复快照/464MB，daemon 事件循环被
// 同步 IO 拖死 4 小时）。防线：①parse 只看标记区外 ②标记区硬上限 ③指纹去重 ④巨文件拒摄取
// ---------------------------------------------------------------------------

test('codex.parse：标记区内 hub 写回内容不再摄取，区外原生 H2 照常（雪球断根）', () => {
  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: ['/tmp/none/AGENTS.md'] });
  const content = [
    '# 项目配置',
    '## 用户身份',
    '用户叫狂且。',
    '<!-- memory-hub:start -->',
    '### Wiki页A [hub-20260819000000-aaaaaa]',
    '## 核心原则',
    '蒸馏正文自带的 H2（曾是雪球燃料）',
    '### Wiki页B [hub-20260819000001-bbbbbb]',
    '更多正文',
    '<!-- memory-hub:end -->',
    '## 区外补充',
    '区外原生内容。',
  ].join('\n');
  const entries = adapter.parse({ path: '/tmp/none/AGENTS.md', content, mtimeMs: 1, sha256: 'x' });
  const titles = entries.map((e) => e.title);
  assert.ok(titles.includes('用户身份'), '区外 H2 照常摄取');
  assert.ok(titles.includes('区外补充'), '区尾部 H2 照常摄取');
  assert.ok(!titles.includes('核心原则'), '区内 H2 不再摄取');
  assert.ok(!entries.some((e) => /Wiki页/.test(e.title)), '区内 hub 块整体不摄取');
});

test('codex.buildMergedContent：标记区硬上限滚动淘汰，core 条目永不淘汰', () => {
  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [], maxRegionEntries: 3 });
  const mk = (i, tier) => ({
    hubId: `hub-2026081900000${i}-id0${i}a`,
    title: `T${i}`,
    body: `B${i}`,
    tier,
  });
  // 首轮写 5 条（超上限 3）→ 终态硬裁到 3，尾部注释声明淘汰数
  let merged = adapter.buildMergedContent('', [mk(1), mk(2), mk(3), mk(4), mk(5)]);
  assert.equal((merged.match(/^### T\d /gm) || []).length, 3, '终态硬裁到上限');
  assert.match(merged, /淘汰 2 条最旧/);
  assert.match(merged, /T5/, '各档内保最新');
  assert.ok(!/### T1 /.test(merged), '淘汰最旧');

  // 第二轮：写入 1 条新 + 1 条 core → core 永不淘汰，旧块让位
  merged = adapter.buildMergedContent(merged, [mk(6), mk(7, 'core')]);
  assert.match(merged, /### T7 /, 'core 条目在场');
  assert.match(merged, /### T6 /, '本轮新条目在场');
  assert.equal((merged.match(/^### T\d /gm) || []).length, 3, '仍不超上限');
});

test('ingest：同 app 同内容指纹只落一份快照（mtime/sha 变化也去重）', () => {
  freshHubRoot();
  const adapter = { id: 'codex' };
  const entry = { app: 'codex', file: '/x/AGENTS.md', title: '核心原则', body: '内容 A', sha256: 'a', mtime: 1 };
  const r1 = ingest(adapter, entry);
  assert.notEqual(r1.deduped, true);
  // 同内容重摄取（文件级 mtime/sha 已变——曾的全量重摄取场景）→ 指纹去重
  const r2 = ingest(adapter, { ...entry, sha256: 'b', mtime: 2 });
  assert.equal(r2.deduped, true);
  assert.equal(r2.hubId, r1.hubId);
  assert.equal(r2.snapshotPath, null);
  // 内容变化正常落盘
  const r3 = ingest(adapter, { ...entry, body: '内容 B' });
  assert.notEqual(r3.hubId, r1.hubId);
  const snaps = fs.readdirSync(path.join(storePaths.sources, 'codex'));
  assert.equal(snaps.length, 2, '只落两份（首次 + 内容变化）');
});

test('harvest：巨文件（>2MB）拒摄取且不重判，缩回后重新摄取', () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  writeAt(home, '.claude/projects/proj/memory/big.md', `---\nname: big\n---\n${'x'.repeat(3 * 1024 * 1024)}`);
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const r1 = harvest(adapter);
  assert.equal(r1.bigSkipped, 1, '巨文件拒摄取');
  assert.equal(r1.ingested, 0);
  const r2 = harvest(adapter);
  assert.equal(r2.files, 0, '指纹已记不重判');
  // 缩回正常尺寸 → mtime/size 变化 → 重新摄取
  writeAt(home, '.claude/projects/proj/memory/big.md', '---\nname: big\n---\n正常内容');
  const r3 = harvest(adapter);
  assert.equal(r3.ingested, 1, '缩回后正常摄取');
});
