/**
 * test/test-tombstone.js —— 删除传播（tombstone 机制，M7）自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 hub/backups/state/logs，伪造各 App 目录，
 * LLM 全程 mock。绝不触碰真实的 ~/.memory-hub / ~/Desktop/Memory Hub / 各 App 记忆文件。
 *
 * 覆盖：
 * 1. hub-store：tombstone 清单 CRUD（add 不覆盖首删时间 / remove / update / 损坏回退空）；
 * 2. hub-store：源路径反查快照 hubId + 同源重摄取自动解除（ingest lift）；
 * 3. watcher：unlink 去抖后登记 tombstone；删除哨兵抑制（写回自删回环）；
 *    去抖期内重建（编辑器原子保存）不登记；
 * 4. distill：stripHubIdBlocks 条目块剔除；applyTombstones 部分剔除 / 页级 deleted
 *    标记 / 重放防护（processed skipped:tombstone）/ 新摄取解除；
 * 5. writeback：deleted 页与 tombstoned hubId 过滤 + 各 App removeEntries 移除；
 * 6. 端到端：摄取→蒸馏成页→写回→删源→下轮蒸馏+写回后各 App 不复活、wiki 已标记；
 *    同 hubId 重新摄取解除 tombstone。
 *
 * 运行：npm test 或 node test/test-tombstone.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import {
  ensureHubStore,
  storePaths,
  harvest,
  tombstonesPath,
  loadTombstones,
  addTombstones,
  removeTombstones,
  updateTombstones,
  listSnapshotMeta,
  findSnapshotHubIdsBySource,
  liftTombstonesForSource,
} from '../src/hub-store.js';
import { Watcher } from '../src/watcher.js';
import {
  distill,
  applyTombstones,
  stripHubIdBlocks,
  loadDistillState,
  saveDistillState,
} from '../src/distill.js';
import { runWriteback, wikiToEntries, loadPendingWriteback } from '../src/writeback.js';
import { CodexAdapter, HUB_MARK_START, HUB_MARK_END } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { QoderAdapter } from '../src/adapters/qoder.js';
import { removeFilesSafely, DELETED_INFLIGHT_SHA } from '../src/adapters/write-utils.js';
import { loadInflightEntries, loadDirWindows } from '../src/inflight.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去（含目录初始化）。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-tomb-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

/** 新建一个伪造的家目录。 */
function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-tomb-home-'));
  tmpRoots.push(dir);
  return dir;
}

/** 递归写文件（自动建目录），返回绝对路径。 */
function writeAt(base, rel, content = '') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 伪造一个 sources/<app>/ 快照文件（frontmatter 值一律 JSON 转义，含 source 字段）。 */
function writeSnapshot(app, hubId, title, body, extra = {}) {
  const dir = path.join(storePaths.sources, app);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `hubId: ${JSON.stringify(hubId)}`,
    `app: ${JSON.stringify(app)}`,
    `source: ${JSON.stringify(extra.source || '')}`,
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

/** 在 wiki/ 写入一个带 hub-id frontmatter 的整理页，返回绝对路径。 */
function writeWikiPage(hubIds, slug, title, body, extraFm = {}) {
  fs.mkdirSync(storePaths.wiki, { recursive: true });
  const fm = {
    'hub-id': hubIds,
    sources: [`fake-source-${slug}`],
    'last-updated': '2026-08-05T10:00:00.000Z',
    tags: ['记忆'],
    category: 'project_introduction',
    ...extraFm,
  };
  const p = path.join(storePaths.wiki, `${slug}.md`);
  fs.writeFileSync(p, matter.stringify(`# ${title}\n\n${body}\n`, fm));
  return p;
}

/** 构造 mock LLM 客户端（本套件内 distill 不应真正调用 LLM）。 */
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

// MUST-2：本文件既有用例验证的是传播机制本身，故显式开启 autoPropagate
// （缺省 false 的安全阀行为由 test-task10-fixes.js 专项覆盖）
const BASE_CONFIG = {
  llm: { baseUrl: 'http://mock.local/v1', model: 'mock-model', keyRef: '' },
  tombstone: { autoPropagate: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. hub-store：tombstone 清单 CRUD
// ---------------------------------------------------------------------------

test('T1：tombstone 清单 add/remove/update；重复登记不覆盖首删时间；损坏文件回退空清单', () => {
  freshHubRoot();
  assert.deepEqual(loadTombstones().tombstones, {}, '初始为空清单');

  const added = addTombstones([
    { hubId: 'hub-t1-aaa', app: 'claude', source: '/fake/a.md' },
    { hubId: 'hub-t1-bbb', app: 'codex', source: '/fake/b.md' },
  ]);
  assert.deepEqual(added, ['hub-t1-aaa', 'hub-t1-bbb']);
  const t1 = loadTombstones().tombstones['hub-t1-aaa'];
  assert.equal(t1.app, 'claude');
  assert.equal(t1.source, '/fake/a.md');
  assert.ok(t1.deletedAt, '登记时打 deletedAt');

  // 重复登记：不覆盖（首删时间为准），返回空
  const again = addTombstones([{ hubId: 'hub-t1-aaa', app: 'qoder', source: '/other.md' }]);
  assert.deepEqual(again, []);
  assert.equal(loadTombstones().tombstones['hub-t1-aaa'].app, 'claude', '首次登记不被覆盖');

  updateTombstones(['hub-t1-aaa'], { wikiApplied: '2026-08-07T00:00:00.000Z' });
  assert.equal(loadTombstones().tombstones['hub-t1-aaa'].wikiApplied, '2026-08-07T00:00:00.000Z');
  assert.equal(loadTombstones().tombstones['hub-t1-aaa'].source, '/fake/a.md', 'update 合并不丢既有字段');

  const removed = removeTombstones(['hub-t1-aaa', 'hub-t1-nonexist']);
  assert.deepEqual(removed, ['hub-t1-aaa'], '只返回实际移除的 id');
  assert.equal(loadTombstones().tombstones['hub-t1-aaa'], undefined);
  assert.ok(loadTombstones().tombstones['hub-t1-bbb'], '其余不受影响');

  // 损坏文件：回退空清单不抛错
  fs.writeFileSync(tombstonesPath(), '{broken json');
  assert.deepEqual(loadTombstones().tombstones, {});
});

// ---------------------------------------------------------------------------
// 2. hub-store：源路径反查 + 同源重摄取解除
// ---------------------------------------------------------------------------

test('T2：findSnapshotHubIdsBySource 反查快照；同源路径重新摄取（harvest）自动解除 tombstone', () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const src = writeAt(memDir, 'note-a.md', '---\nname: 部署要点\n---\n生产环境要点第一版。');

  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  harvest(adapter);
  const ids = findSnapshotHubIdsBySource(src);
  assert.equal(ids.length, 1, '摄取后可按源路径反查到快照 hubId');
  const meta = listSnapshotMeta().find((m) => m.hubId === ids[0]);
  assert.equal(path.resolve(meta.source), path.resolve(src));

  // 登记 tombstone 后，同源路径重新出现内容并被摄取 → 自动解除
  addTombstones([{ hubId: ids[0], app: 'claude', source: src }]);
  assert.ok(loadTombstones().tombstones[ids[0]]);
  fs.writeFileSync(src, '---\nname: 部署要点\n---\n用户重建后的第二版内容。');
  harvest(adapter);
  assert.equal(loadTombstones().tombstones[ids[0]], undefined, '重摄取即解除 tombstone');

  // liftTombstonesForSource 直调路径
  addTombstones([{ hubId: 'hub-t2-x', app: 'claude', source: src }]);
  assert.deepEqual(liftTombstonesForSource(src), ['hub-t2-x']);
});

// ---------------------------------------------------------------------------
// 3. watcher：unlink → tombstone 登记与三类抑制
// ---------------------------------------------------------------------------

function watcherFor(memDir, debounceMs = 60) {
  return new Watcher({
    apps: [{ id: 'claude', enabled: true, memory_paths: [memDir] }],
    debounceMs,
    pollIntervalMs: 999999,
  });
}

test('T3：handleUnlink 去抖到期后按源路径登记 tombstone（含 app/source/时间）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const src = writeAt(memDir, 'gone.md', '---\nname: gone\n---\n将被删除的内容。');
  writeSnapshot('claude', 'hub-t3-aaa', '将被删除', '将被删除的内容。', { source: src });

  const watcher = watcherFor(memDir);
  fs.rmSync(src);
  watcher.handleUnlink(src);
  assert.deepEqual(loadTombstones().tombstones, {}, '去抖期内不立即登记');
  await sleep(200);
  const t = loadTombstones().tombstones['hub-t3-aaa'];
  assert.ok(t, '去抖到期后登记 tombstone');
  assert.equal(t.app, 'claude');
  assert.equal(path.resolve(t.source), path.resolve(src));
  assert.ok(t.deletedAt);
});

test('T4：写回自删（removeFilesSafely 删除哨兵）触发的 unlink 被抑制且哨兵被消费', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const src = writeAt(memDir, 'self-del.md', '含 hub-t4-aaa 标记的写回条目。');
  writeSnapshot('claude', 'hub-t4-aaa', '自删条目', '内容。', { source: src });

  // 写回引擎侧删除：登记删除哨兵 + 备份 + 删除
  const { backupDir } = removeFilesSafely([{ path: src, app: 'claude', hubId: 'hub-t4-aaa' }]);
  assert.ok(fs.existsSync(backupDir), '删除前已备份');
  assert.ok(!fs.existsSync(src));
  assert.equal(loadInflightEntries()[path.resolve(src)]?.sha256, DELETED_INFLIGHT_SHA, '删除哨兵已登记');

  const watcher = watcherFor(memDir);
  watcher.handleUnlink(src);
  await sleep(200);
  assert.deepEqual(loadTombstones().tombstones, {}, '自删回环不登记 tombstone');
  assert.equal(loadInflightEntries()[path.resolve(src)], undefined, '哨兵已被消费');
});

test('T5：去抖期内文件重建（编辑器删+重建原子保存）→ 不登记 tombstone', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const src = writeAt(memDir, 'atomic.md', '---\nname: atomic\n---\n原子保存内容。');
  writeSnapshot('claude', 'hub-t5-aaa', '原子保存', '原子保存内容。', { source: src });

  const watcher = watcherFor(memDir, 100);
  fs.rmSync(src);
  watcher.handleUnlink(src);
  // 去抖期内重建（编辑器先 unlink 再写回同名文件）
  fs.writeFileSync(src, '---\nname: atomic\n---\n原子保存内容 v2。');
  await sleep(300);
  assert.deepEqual(loadTombstones().tombstones, {}, '文件已重建，不判定为用户删除');
});

// ---------------------------------------------------------------------------
// 4. distill：stripHubIdBlocks / applyTombstones
// ---------------------------------------------------------------------------

test('T6：stripHubIdBlocks 剔除标记块与独立标记行，保留无关内容与后继同级标题', () => {
  const body = [
    '# 页面标题',
    '',
    '开场说明段落。',
    '',
    '## 条目甲 [hub-s-aaa]',
    '',
    '甲的正文第一行。',
    '甲的正文第二行。',
    '',
    '### 甲的子节',
    '',
    '子节内容也应随块剔除。',
    '',
    '## 条目乙 [hub-s-bbb]',
    '',
    '乙的正文。',
    '',
    '[hub-s-ccc]',
    '乙区域的独立标记行之后的内容保留。',
  ].join('\n');

  const out = stripHubIdBlocks(body, ['hub-s-aaa', 'hub-s-ccc']);
  assert.ok(!out.includes('hub-s-aaa'), '甲块标题被剔除');
  assert.ok(!out.includes('甲的正文第一行'), '甲块正文被剔除');
  assert.ok(!out.includes('甲的子节'), '甲块子节随块剔除');
  assert.ok(out.includes('## 条目乙 [hub-s-bbb]'), '后继同级标题保留（skipLevel 归零）');
  assert.ok(out.includes('乙的正文'), '无关块正文保留');
  assert.ok(!out.includes('[hub-s-ccc]'), '独立标记行被剔除');
  assert.ok(out.includes('独立标记行之后的内容保留'));
  assert.ok(!/\n{3,}/.test(out), '连续空行被压缩');
});

test('T7：applyTombstones 部分剔除——页 [A,B] 删 B：hub-id 收窄、deleted-hub-ids 记录、重放防护、wikiApplied 打点、登记 pending-writeback', () => {
  freshHubRoot();
  const A = 'hub-t7-aaa';
  const B = 'hub-t7-bbb';
  writeWikiPage([A, B], 'mixed-page', '混合主题', [
    `## 条目A [${A}]`,
    '',
    'A 的正文。',
    '',
    `## 条目B [${B}]`,
    '',
    'B 的正文（将被删除）。',
  ].join('\n'));
  writeSnapshot('claude', B, '条目B', 'B 的正文（将被删除）。', { source: '/fake/b.md' });
  addTombstones([{ hubId: B, app: 'claude', source: '/fake/b.md' }]);

  const state = loadDistillState();
  const summary = applyTombstones(state, { force: true });
  assert.deepEqual(summary.applied, [B]);
  assert.deepEqual(summary.updatedPages, ['mixed-page.md']);
  assert.deepEqual(summary.deletedPages, []);

  const parsed = matter(fs.readFileSync(path.join(storePaths.wiki, 'mixed-page.md'), 'utf8'));
  assert.deepEqual(parsed.data['hub-id'], [A], 'hub-id 收窄为存活条目');
  assert.deepEqual(parsed.data['deleted-hub-ids'], [B], '被删 hubId 留痕');
  assert.notEqual(parsed.data.deleted, true, '仍有存活条目，页不标 deleted');
  assert.ok(!parsed.content.includes(B), 'B 块已从正文剔除');
  assert.ok(parsed.content.includes('A 的正文'), 'A 块保留');

  // 重放防护 + 打点
  assert.equal(loadDistillState().processed[B]?.skipped, 'tombstone', 'B 记入 processed 防复活');
  assert.ok(loadTombstones().tombstones[B].wikiApplied, 'wikiApplied 已打点');

  // 剩余条目登记增量写回（App 侧旧渲染需要刷新）
  const pending = loadPendingWriteback();
  const pg = pending.pages.find((p) => p.path === 'mixed-page.md');
  assert.ok(pg && pg.hubIds.includes(A));

  // 幂等：再次调用不重复处理
  const summary2 = applyTombstones(loadDistillState(), { force: true });
  assert.deepEqual(summary2.applied, [], 'wikiApplied 已打点的 tombstone 不再重复处理');
});

test('T8：applyTombstones 页级标记——整页 hubId 均 tombstone → deleted:true 原地保留，wikiToEntries 过滤该页', () => {
  freshHubRoot();
  const A = 'hub-t8-aaa';
  writeWikiPage([A], 'all-gone', '整页删除', `## 唯一条目 [${A}]\n\n唯一条目正文。`);
  writeSnapshot('codex', A, '唯一条目', '唯一条目正文。', { source: '/fake/agents.md' });
  addTombstones([{ hubId: A, app: 'codex', source: '/fake/agents.md' }]);

  const summary = applyTombstones(loadDistillState(), { force: true });
  assert.deepEqual(summary.deletedPages, ['all-gone.md']);

  const parsed = matter(fs.readFileSync(path.join(storePaths.wiki, 'all-gone.md'), 'utf8'));
  assert.equal(parsed.data.deleted, true, '页级 deleted 标记');
  assert.ok(parsed.data['deleted-at'], 'deleted-at 打点');
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'all-gone.md')), '原地保留不移动');

  const entries = wikiToEntries();
  assert.ok(!entries.some((e) => e.hubIds.includes(A)), 'deleted 页不进入写回条目');
});

test('T9：applyTombstones 解除——同 hubId 有更新摄取（ingestedAt > deletedAt）→ tombstone 解除且 processed 记录清除', () => {
  freshHubRoot();
  const A = 'hub-t9-aaa';
  addTombstones([{ hubId: A, app: 'claude', source: '/fake/a.md' }]);
  // 先让 wiki 标记流程跑一遍（无页命中，仅重放防护）
  applyTombstones(loadDistillState(), { force: true });
  assert.equal(loadDistillState().processed[A]?.skipped, 'tombstone');

  // 用户重建记忆：同 hubId 出现更新的摄取快照
  writeSnapshot('claude', A, '重建条目', '用户重建后的内容。', {
    source: '/fake/a.md',
    ingestedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const summary = applyTombstones(loadDistillState(), { force: true });
  assert.deepEqual(summary.lifted, [A], 'tombstone 被解除');
  assert.equal(loadTombstones().tombstones[A], undefined);
  assert.equal(loadDistillState().processed[A], undefined, 'processed 防复活记录同步清除，快照可重新蒸馏');
});

// ---------------------------------------------------------------------------
// 5. writeback：tombstone 过滤与各 App removeEntries
// ---------------------------------------------------------------------------

test('T10：writeback 过滤未标记的 tombstone 并从 codex 标记区移除对应块（A 保留 B 移除）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const A = 'hub-t10-aaa';
  const B = 'hub-t10-bbb';
  const agentsPath = writeAt(
    home,
    'ws/AGENTS.md',
    `# 项目说明\n\n用户自己的内容。\n\n${HUB_MARK_START}\n### 条目A [${A}]\n\nA 旧渲染。\n\n### 条目B [${B}]\n\nB 旧渲染。\n${HUB_MARK_END}\n`,
  );
  writeWikiPage([A, B], 'two-items', '双条目页', `## 条目A [${A}]\n\nA 的正文。\n\n## 条目B [${B}]\n\nB 的正文。`);
  // wiki 尚未打删除标记（distill 未跑），但 tombstone 已登记 → writeback 也必须不复活
  addTombstones([{ hubId: B, app: 'codex', source: agentsPath }]);

  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agentsPath] });
  const config = {
    apps: [{ id: 'codex', enabled: true, memory_paths: [agentsPath] }],
    tombstone: { autoPropagate: true },
  };
  const result = await runWriteback({ config, adapters: [adapter], full: true });

  const content = fs.readFileSync(agentsPath, 'utf8');
  assert.ok(!content.includes(B), 'B 块已从标记区移除且未被重写复活');
  assert.ok(content.includes(A), 'A 块保留');
  assert.ok(content.includes('用户自己的内容'), '区外用户内容不动');
  const appResult = result.appResults.find((r) => r.app === 'codex');
  assert.ok((appResult.removed || []).some((r) => r.hubId === B && r.status === 'removed'), '移除结果入账');
  assert.ok(loadTombstones().tombstones[B].appsCleaned, '全量写回成功后打 appsCleaned 点');

  // 已 appsCleaned：下一轮不再重复移除
  const result2 = await runWriteback({ config, adapters: [adapter], full: true });
  const appResult2 = result2.appResults.find((r) => r.app === 'codex');
  assert.equal((appResult2.removed || []).length, 0, 'appsCleaned 后不再重复移除');
});

test('T11：qoder removeEntries 跨 category 定位删除文件并登记目录宽限窗口', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const root = path.join(home, '.qoder/memories/acct');
  const A = 'hub-t11-aaa';
  const target = writeAt(
    root,
    'projects/memory-hub/user_info/entry.md',
    `---\ntitle: 用户信息\nusage_scenario:\n  - 记忆同步\nkeywords:\n  - 用户\nsource: memory-hub\n---\n[${A}]\n正文。\n`,
  );
  const adapter = new QoderAdapter({ id: 'qoder', enabled: true, memory_paths: [root], project_slug: 'memory-hub' });
  const results = await adapter.removeEntries([A, 'hub-t11-miss']);
  assert.equal(results.length, 1, '未命中的 hubId 静默跳过');
  assert.equal(results[0].status, 'removed');
  assert.ok(!fs.existsSync(target), '目标文件已删除');
  assert.ok(fs.existsSync(results[0].backupDir), '删除前已备份');
  const windows = Object.keys(loadDirWindows());
  assert.ok(windows.some((d) => path.resolve(d) === path.resolve(path.dirname(target))), '目录宽限窗口已登记');
});

// ---------------------------------------------------------------------------
// 6. 端到端：删除不复活 + 重新摄取解除
// ---------------------------------------------------------------------------

test('T12：端到端——摄取→成页→写回→删源→下轮蒸馏+写回后各 App 不复活、wiki 已标记；第三轮仍不复活', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const claudeDir = path.join(home, '.claude/projects/proj/memory');
  const agentsPath = writeAt(home, 'ws/AGENTS.md', '# 项目说明\n\n用户内容。\n');
  const src = writeAt(claudeDir, 'deploy-note.md', '---\nname: 发布流程\n---\n发布前先跑回归再灰度。');

  const claudeAdapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [claudeDir] });
  const codexAdapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agentsPath] });
  const adapters = [codexAdapter, claudeAdapter];
  const config = {
    apps: [
      { id: 'claude', enabled: true, memory_paths: [claudeDir] },
      { id: 'codex', enabled: true, memory_paths: [agentsPath] },
    ],
    tombstone: { autoPropagate: true },
  };

  // ① 摄取：源文件 → sources 快照（拿到真实 hubId）
  harvest(claudeAdapter);
  const hubId = findSnapshotHubIdsBySource(src)[0];
  assert.ok(hubId, '摄取产生快照 hubId');

  // ② 成页（模拟蒸馏产物）+ 标记 processed，再全量写回到两个 App
  writeWikiPage([hubId], 'release-flow', '发布流程', `## 发布流程 [${hubId}]\n\n发布前先跑回归再灰度。`);
  const st = loadDistillState();
  st.processed[hubId] = { page: 'release-flow', at: new Date().toISOString() };
  saveDistillState(st);
  await runWriteback({ config, adapters, full: true });
  assert.ok(fs.readFileSync(agentsPath, 'utf8').includes(hubId), 'codex 已写回');
  const claudeFiles = () =>
    fs.readdirSync(claudeDir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md' && n !== 'deploy-note.md');
  const syncedFile = claudeFiles().find((n) =>
    fs.readFileSync(path.join(claudeDir, n), 'utf8').includes(hubId));
  assert.ok(syncedFile, 'claude 已写回条目文件');
  assert.ok(fs.readFileSync(path.join(claudeDir, 'MEMORY.md'), 'utf8').includes(syncedFile), '索引行已写');

  // ③ 用户删除源记忆 → watcher unlink → tombstone
  fs.rmSync(src);
  const watcher = watcherFor(claudeDir);
  watcher.handleUnlink(src);
  await sleep(200);
  assert.ok(loadTombstones().tombstones[hubId], 'tombstone 已登记');

  // ④ 下轮蒸馏（LLM mock，不应被调用）：wiki 标记 + 快照不重放
  const client = mockClient();
  const r2 = await distill({ config: BASE_CONFIG, client });
  assert.equal(client.calls.length, 0, 'tombstoned 快照不进入蒸馏，LLM 零调用');
  const page = matter(fs.readFileSync(path.join(storePaths.wiki, 'release-flow.md'), 'utf8'));
  assert.equal(page.data.deleted, true, 'wiki 页已标 deleted');
  assert.ok(!page.content.includes('发布前先跑回归'), '页内条目块已剔除');
  assert.equal(loadDistillState().processed[hubId]?.skipped, 'tombstone', '重放防护已记入 distill-state');
  assert.ok(r2.tombstones, 'distill 结果携带 tombstone 摘要');

  // ⑤ 下轮写回：各 App 侧条目被移除，不复活
  await runWriteback({ config, adapters, full: true });
  assert.ok(!fs.readFileSync(agentsPath, 'utf8').includes(hubId), 'codex 区内块已移除');
  assert.ok(fs.readFileSync(agentsPath, 'utf8').includes('用户内容'), 'codex 区外内容不动');
  assert.equal(claudeFiles().length, 0, 'claude 条目文件已删除');
  assert.ok(!fs.readFileSync(path.join(claudeDir, 'MEMORY.md'), 'utf8').includes(syncedFile), '索引行已清理');
  assert.ok(loadTombstones().tombstones[hubId].appsCleaned, 'appsCleaned 已打点');
  // 防回环：写回删除登记了删除哨兵，watcher 收到 unlink 会被抑制
  const removedPath = path.resolve(path.join(claudeDir, syncedFile));
  assert.equal(loadInflightEntries()[removedPath]?.sha256, DELETED_INFLIGHT_SHA, '删除哨兵已登记');
  watcher.handleUnlink(removedPath);
  await sleep(200);
  assert.equal(loadTombstones().tombstones[removedPath], undefined);
  assert.equal(loadInflightEntries()[removedPath], undefined, '自删回环被消费抑制');

  // ⑥ 第三轮蒸馏+写回：仍不复活
  await distill({ config: BASE_CONFIG, client });
  await runWriteback({ config, adapters, full: true });
  assert.equal(client.calls.length, 0);
  assert.ok(!fs.readFileSync(agentsPath, 'utf8').includes(hubId), '第三轮后 codex 仍无该条目');
  assert.equal(claudeFiles().length, 0, '第三轮后 claude 仍无该条目');

  // ⑦ 用户重建记忆：同源路径重新出现 → 摄取即解除 tombstone，可重新进入蒸馏
  fs.writeFileSync(src, '---\nname: 发布流程\n---\n重建后的发布流程内容。');
  harvest(claudeAdapter);
  assert.equal(loadTombstones().tombstones[hubId], undefined, '重摄取解除 tombstone');
  const newIds = findSnapshotHubIdsBySource(src);
  assert.ok(newIds.length >= 1, '重建内容已生成新快照');
});
