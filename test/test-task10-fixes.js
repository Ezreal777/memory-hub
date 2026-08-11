/**
 * test/test-task10-fixes.js —— Task#10 三路评审收口修复自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 hub/backups/state/logs，适配器 mock。
 * 绝不触碰真实的 ~/.memory-hub / ~/Desktop/Memory Hub / 各 App 记忆文件。
 *
 * 覆盖：
 * 1. MUST-1 pending-writeback 多写者竞态：appendPendingWriteback / clearPendingWriteback
 *    共锁 + updatedAt 比对防误清；写回窗口内 distill 登记新页面时清空被跳过；
 * 2. MUST-2 风暴熔断：addTombstonesGuarded 超阈值熔断、suspectedStorm 标记、
 *    窗口内后续 suppressed、窗口过期复位；
 * 3. MUST-2 安全阀：autoPropagate 默认关闭 → distill 不动 wiki / writeback 不
 *    removeEntries（lift 解除不受影响）；开启后跳过 suspectedStorm；force 全量执行；
 * 4. MUST-3 新旧锁互操作：旧锁（无 v 字段）沿用旧语义（ts 超 60s 可破 / 新鲜不可破），
 *    新锁写入 v:2；
 * 5. MUST-2③ tombstone CLI：classifyTombstones / formatTombstoneList /
 *    previewTombstoneApply（纯只读）/ runTombstoneApply（force 语义）；
 *    子进程 hub tombstone apply --dry-run 零写入、list / drop；
 * 6. SHOULD-4 子目录同名页不被 basename 误匹配；SHOULD-5 testMarkers 可配置；
 *    SHOULD-6 lockTimeoutHint；SHOULD-7 formatWritebackSummary mode 行；
 * 7. doctor checkTombstones：风暴 / 超 7 天未闭环 → warn。
 *
 * 运行：npm test 或 node test/test-task10-fixes.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';

import {
  ensureHubStore,
  storePaths,
  tombstonesPath,
  loadTombstones,
  addTombstones,
  addTombstonesGuarded,
  updateTombstones,
} from '../src/hub-store.js';
import {
  appendPendingWriteback,
  applyTombstones,
  loadDistillState,
  hasTestMarker,
} from '../src/distill.js';
import {
  runWriteback,
  loadPendingWriteback,
  clearPendingWriteback,
  pendingWritebackPath,
  formatWritebackSummary,
} from '../src/writeback.js';
import { withLock, lockPathFor, LOCK_PROTOCOL_VERSION } from '../src/util/lock.js';
import { defaultConfig, DEFAULT_TEST_MARKERS } from '../src/config.js';
import { checkTombstones } from '../src/doctor.js';
import {
  CLI_LOCK_TIMEOUT_MS,
  lockTimeoutHint,
  classifyTombstones,
  formatTombstoneList,
  previewTombstoneApply,
  formatTombstonePreview,
  runTombstoneApply,
} from '../src/cli.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去（含目录初始化）。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-t10-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

/** 新建一个普通临时目录（锁互操作测试用，不切 MEMORY_HUB_ROOT）。 */
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** 在 wiki/ 写入一个带 hub-id frontmatter 的整理页（slug 可含子目录），返回绝对路径。 */
function writeWikiPage(hubIds, slug, title, body, extraFm = {}) {
  const p = path.join(storePaths.wiki, `${slug}.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fm = {
    'hub-id': hubIds,
    sources: [`fake-source-${slug}`],
    'last-updated': '2026-08-05T10:00:00.000Z',
    tags: ['记忆'],
    ...extraFm,
  };
  fs.writeFileSync(p, matter.stringify(`# ${title}\n\n${body}\n`, fm));
  return p;
}

/** 伪造一个 sources/<app>/ 快照文件（lift 解除测试用）。 */
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
  const p = path.join(dir, extra.name || `20260805-000000-${hubId}.md`);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

/** 可注入 runWriteback 的伪适配器（记录 write/removeEntries 调用）。 */
function fakeAdapter(id = 'fake', hooks = {}) {
  const calls = { written: [], removed: [] };
  return {
    id,
    calls,
    render: (e) => `${e.title}\n${e.body}`,
    async write(entries) {
      calls.written.push(entries.map((e) => e.hubId));
      if (hooks.onWrite) await hooks.onWrite(entries);
      return entries.map((e) => ({ hubId: e.hubId, status: 'written' }));
    },
    async removeEntries(ids) {
      calls.removed.push([...ids]);
      return ids.map((hubId) => ({ hubId, status: 'removed' }));
    },
  };
}

/** 子进程跑 CLI（MEMORY_HUB_ROOT 指向隔离 root）。 */
function runCli(args, root) {
  const env = { ...process.env, MEMORY_HUB_ROOT: root };
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', env });
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// MUST-1：pending-writeback 多写者竞态
// ---------------------------------------------------------------------------

test('MUST-1：clearPendingWriteback 与 appendPendingWriteback 共锁，updatedAt 比对防误清', () => {
  freshHubRoot();
  // 文件不存在：无操作视为已清空
  assert.equal(clearPendingWriteback(), true);

  const v1 = appendPendingWriteback([{ path: 'a.md', hubIds: ['hub-1'] }], '2026-08-07T00:00:01.000Z');
  assert.equal(v1.updatedAt, '2026-08-07T00:00:01.000Z');
  // 模拟 distill 在写回窗口内又登记了新页面（updatedAt 前进）
  appendPendingWriteback([{ path: 'b.md', hubIds: ['hub-2'] }], '2026-08-07T00:00:02.000Z');

  // 消费方拿着旧版本清空 → 必须被拒绝，页面原样保留（含合并后的 a+b）
  assert.equal(clearPendingWriteback('2026-08-07T00:00:01.000Z'), false, 'updatedAt 不一致时不得清空');
  const kept = loadPendingWriteback();
  assert.deepEqual(kept.pages.map((p) => p.path).sort(), ['a.md', 'b.md']);

  // 拿着当前版本清空 → 成功
  assert.equal(clearPendingWriteback('2026-08-07T00:00:02.000Z'), true);
  assert.equal(loadPendingWriteback().pages.length, 0);

  // 无参调用：无条件清空（兼容旧调用）
  appendPendingWriteback([{ path: 'c.md', hubIds: ['hub-3'] }]);
  assert.equal(clearPendingWriteback(), true);
  assert.equal(loadPendingWriteback().pages.length, 0);
});

test('MUST-1：写回窗口内 distill 登记新页面 → 清空被跳过、新增页面保留（端到端交错）', async () => {
  freshHubRoot();
  writeWikiPage(['hub-p1'], 'p1', '页面一', '正文一。');
  appendPendingWriteback([{ path: 'p1.md', hubIds: ['hub-p1'] }], '2026-08-07T01:00:00.000Z');

  // 适配器 write 期间模拟 distill 并发登记新页面（消费-清空窗口内的交错）
  const adapter = fakeAdapter('fake', {
    onWrite: () => {
      appendPendingWriteback([{ path: 'p2.md', hubIds: ['hub-p2'] }], '2026-08-07T01:00:30.000Z');
    },
  });
  const result = await runWriteback({ config: { apps: [] }, adapters: [adapter] });
  assert.equal(result.mode, 'incremental');
  assert.equal(result.entryCount, 1);
  assert.deepEqual(adapter.calls.written, [['hub-p1']], '本轮只消费清单中的 p1');

  // 清空被 updatedAt 比对拦截：distill 新登记的 p2 必须保留供下轮消费
  const pending = loadPendingWriteback();
  assert.ok(pending && pending.pages.some((p) => p.path === 'p2.md'), '窗口内新增的 p2.md 不得被误清');
});

test('MUST-1：无交错时增量消费后正常清空', async () => {
  freshHubRoot();
  writeWikiPage(['hub-p1'], 'p1', '页面一', '正文一。');
  appendPendingWriteback([{ path: 'p1.md', hubIds: ['hub-p1'] }]);

  const adapter = fakeAdapter();
  const result = await runWriteback({ config: { apps: [] }, adapters: [adapter] });
  assert.equal(result.mode, 'incremental');
  assert.equal(loadPendingWriteback().pages.length, 0, '全部成功后清单已清空');
  assert.ok(fs.existsSync(pendingWritebackPath()));
});

// ---------------------------------------------------------------------------
// MUST-2：风暴熔断（addTombstonesGuarded）
// ---------------------------------------------------------------------------

test('MUST-2 风暴熔断：超阈值熔断、suspectedStorm 标记、窗口内后续 suppressed', () => {
  freshHubRoot();
  const t0 = Date.parse('2026-08-07T02:00:00.000Z');
  const opts = { stormThreshold: 3, stormWindowMs: 60 * 1000, now: t0 };
  const items = (ids) => ids.map((hubId) => ({ hubId, app: 'codex', source: `/x/${hubId}.md` }));

  // 前 3 条：正常登记，无风暴
  let r = addTombstonesGuarded(items(['hub-a1', 'hub-a2', 'hub-a3']), opts);
  assert.deepEqual(r, { added: ['hub-a1', 'hub-a2', 'hub-a3'], suppressed: [], tripped: [] });
  assert.ok(Object.values(loadTombstones().tombstones).every((t) => t.suspectedStorm !== true));

  // 第 4 条超阈值：熔断 + 窗口内全部打 suspectedStorm
  r = addTombstonesGuarded(items(['hub-a4']), { ...opts, now: t0 + 1000 });
  assert.deepEqual(r.added, ['hub-a4']);
  assert.deepEqual(r.tripped, ['codex']);
  const { tombstones } = loadTombstones();
  for (const id of ['hub-a1', 'hub-a2', 'hub-a3', 'hub-a4']) {
    assert.equal(tombstones[id].suspectedStorm, true, `${id} 应带 suspectedStorm 标记`);
  }

  // 已熔断：本窗口后续 unlink 只记日志不登记
  r = addTombstonesGuarded(items(['hub-a5']), { ...opts, now: t0 + 2000 });
  assert.deepEqual(r, { added: [], suppressed: ['hub-a5'], tripped: [] });
  assert.equal(loadTombstones().tombstones['hub-a5'], undefined, '熔断期内不得登记');
});

test('MUST-2 风暴熔断：窗口过期自动复位；已存在 hubId 不计入风暴', () => {
  freshHubRoot();
  const t0 = Date.parse('2026-08-07T03:00:00.000Z');
  const opts = { stormThreshold: 2, stormWindowMs: 60 * 1000, now: t0 };
  const mk = (id) => [{ hubId: id, app: 'codex' }];

  addTombstonesGuarded(mk('hub-b1'), opts);
  addTombstonesGuarded(mk('hub-b2'), { ...opts, now: t0 + 1000 });
  let r = addTombstonesGuarded(mk('hub-b3'), { ...opts, now: t0 + 2000 });
  assert.deepEqual(r.tripped, ['codex'], '第 3 条超阈值 2 触发熔断');

  // 窗口过期：复位重新计数，新登记不带风暴标记
  r = addTombstonesGuarded(mk('hub-b4'), { ...opts, now: t0 + 61 * 1000 });
  assert.deepEqual(r, { added: ['hub-b4'], suppressed: [], tripped: [] });
  const { tombstones, storms } = loadTombstones();
  assert.equal(tombstones['hub-b4'].suspectedStorm, undefined, '新窗口登记不带风暴标记');
  assert.equal(storms.codex.tripped, false, '窗口过期后熔断状态复位');

  // 已存在 hubId：不覆盖也不计入风暴计数
  r = addTombstonesGuarded(mk('hub-b4'), { ...opts, now: t0 + 62 * 1000 });
  assert.deepEqual(r, { added: [], suppressed: [], tripped: [] });
  assert.equal(loadTombstones().storms.codex.count, 1, '重复登记不计数');
});

// ---------------------------------------------------------------------------
// MUST-2：autoPropagate 安全阀（distill 侧 + writeback 侧）
// ---------------------------------------------------------------------------

test('MUST-2 安全阀：autoPropagate 默认关闭 → applyTombstones 不动 wiki、lift 仍执行', () => {
  freshHubRoot();
  const page = writeWikiPage(['hub-keep', 'hub-del'], 'guard', '安全阀页', '## 条目 [hub-del]\n\n待删正文。');
  const before = fs.readFileSync(page, 'utf8');
  addTombstones([{ hubId: 'hub-del', app: 'codex' }, { hubId: 'hub-lift', app: 'codex' }]);
  // hub-lift 删除后又有新摄取（用户重建记忆）→ 解除不受安全阀影响
  writeSnapshot('codex', 'hub-lift', '重建', '重建正文。', { ingestedAt: '2099-01-01T00:00:00.000Z' });

  // 缺省配置（autoPropagate=false）且非 force：只解除 + 计数，不动 wiki
  const summary = applyTombstones(loadDistillState(), { config: defaultConfig() });
  assert.deepEqual(summary.lifted, ['hub-lift'], '源已重建的 tombstone 仍被解除');
  assert.equal(summary.pendingConfirm, 1, '待确认删除计数');
  assert.deepEqual(summary.deletedPages, []);
  assert.deepEqual(summary.updatedPages, []);
  assert.equal(fs.readFileSync(page, 'utf8'), before, 'wiki 页原样未动');
  const { tombstones } = loadTombstones();
  assert.equal(tombstones['hub-lift'], undefined, '解除后已移除');
  assert.ok(tombstones['hub-del'] && !tombstones['hub-del'].wikiApplied, '证据链保留但未传播');
});

test('MUST-2 安全阀：autoPropagate 开启跳过 suspectedStorm；force 全量执行', () => {
  freshHubRoot();
  const page = writeWikiPage(['hub-s'], 'storm', '风暴页', '正文。');
  const before = fs.readFileSync(page, 'utf8');
  addTombstones([{ hubId: 'hub-s', app: 'codex' }]);
  updateTombstones(['hub-s'], { suspectedStorm: true });

  // 开启自动传播但非 force：疑似风暴条目被跳过
  let summary = applyTombstones(loadDistillState(), { config: { tombstone: { autoPropagate: true } } });
  assert.equal(summary.stormSkipped, 1);
  assert.deepEqual(summary.deletedPages, []);
  assert.equal(fs.readFileSync(page, 'utf8'), before, '风暴条目命中的页不得被动');

  // force（hub tombstone apply）：含 suspectedStorm 一并执行
  summary = applyTombstones(loadDistillState(), { force: true });
  assert.deepEqual(summary.deletedPages, ['storm.md']);
  const fm = matter(fs.readFileSync(page, 'utf8')).data;
  assert.equal(fm.deleted, true, '整页 tombstone → 页级 deleted 标记');
  assert.ok(loadTombstones().tombstones['hub-s'].wikiApplied, 'wikiApplied 打点');
});

test('MUST-2 安全阀：writeback 侧 removeEntries 门禁（关→不调用；开→跳过风暴；force→全部）', async () => {
  freshHubRoot();
  addTombstones([{ hubId: 'hub-r', app: 'codex' }, { hubId: 'hub-storm', app: 'codex' }]);
  updateTombstones(['hub-storm'], { suspectedStorm: true });

  // ① 缺省关闭：不做 removeEntries、不打 appsCleaned
  let adapter = fakeAdapter();
  await runWriteback({ config: defaultConfig(), adapters: [adapter], full: true });
  assert.deepEqual(adapter.calls.removed, [], 'autoPropagate=false 时不得调用 removeEntries');
  let { tombstones } = loadTombstones();
  assert.ok(!tombstones['hub-r'].appsCleaned && !tombstones['hub-storm'].appsCleaned);

  // ② 开启：执行普通条目、跳过 suspectedStorm
  adapter = fakeAdapter();
  await runWriteback({
    config: { apps: [], tombstone: { autoPropagate: true } },
    adapters: [adapter],
    full: true,
  });
  assert.deepEqual(adapter.calls.removed, [['hub-r']], '仅传播非风暴条目');
  tombstones = loadTombstones().tombstones;
  assert.ok(tombstones['hub-r'].appsCleaned, '成功后打 appsCleaned 点');
  assert.ok(!tombstones['hub-storm'].appsCleaned, '风暴条目保留待人工确认');

  // ③ forceTombstones（hub tombstone apply）：绕过开关与风暴过滤
  adapter = fakeAdapter();
  await runWriteback({ config: defaultConfig(), adapters: [adapter], full: true, forceTombstones: true });
  assert.deepEqual(adapter.calls.removed, [['hub-storm']]);
  assert.ok(loadTombstones().tombstones['hub-storm'].appsCleaned);
});

// ---------------------------------------------------------------------------
// MUST-3：锁文件协议版本兼容（新旧锁互操作）
// ---------------------------------------------------------------------------

test('MUST-3：旧版锁（无 v 字段）沿用旧语义——pid 存活但 ts 超 60s 判陈旧可破', () => {
  const dir = freshDir('mh-t10-lock-old-stale-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  // 旧进程写的锁：无 v 字段、不心跳续期；ts 已过 2 分钟 → 旧语义判陈旧
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() - 2 * 60 * 1000 }));
  const r = withLock(file, () => 'reclaimed', { timeoutMs: 2000 });
  assert.equal(r, 'reclaimed', '旧锁 ts 超 60s 应可破除重抢');
  assert.equal(fs.existsSync(lockFile), false);
});

test('MUST-3：旧版锁 ts 新鲜（pid 存活）→ 不可破，只能抢锁超时', () => {
  const dir = freshDir('mh-t10-lock-old-fresh-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  // 混版本运行：新代码若按心跳 mtime 判会把旧活锁误破导致双写——必须按旧语义等待
  assert.throws(() => withLock(file, () => 'never', { timeoutMs: 300 }), /抢锁超时/);
  assert.equal(fs.existsSync(lockFile), true, '新鲜的旧锁不得被误删');
  fs.rmSync(lockFile, { force: true });
});

test('MUST-3：新锁写入 v:2 协议字段（等待方据此走心跳判定）', () => {
  const dir = freshDir('mh-t10-lock-v2-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  assert.equal(LOCK_PROTOCOL_VERSION, 2);
  withLock(file, () => {
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(info.v, 2);
    assert.equal(info.pid, process.pid);
    assert.ok(Number.isFinite(info.ts));
  });
});

// ---------------------------------------------------------------------------
// MUST-2③：tombstone CLI（list / apply --dry-run / drop）
// ---------------------------------------------------------------------------

test('CLI：classifyTombstones / formatTombstoneList 三态分类与风暴计数', () => {
  const state = {
    tombstones: {
      'hub-w': { app: 'codex', deletedAt: '2026-08-06T00:00:00.000Z' },
      'hub-a': { app: 'claude', deletedAt: '2026-08-06T00:00:00.000Z', wikiApplied: '2026-08-06T01:00:00.000Z' },
      'hub-c': {
        app: 'qoder',
        deletedAt: '2026-08-06T00:00:00.000Z',
        wikiApplied: '2026-08-06T01:00:00.000Z',
        appsCleaned: '2026-08-06T02:00:00.000Z',
        suspectedStorm: true,
      },
    },
    storms: {},
  };
  const groups = classifyTombstones(state);
  assert.deepEqual(groups.pendingWiki.map((t) => t.hubId), ['hub-w']);
  assert.deepEqual(groups.pendingApps.map((t) => t.hubId), ['hub-a']);
  assert.deepEqual(groups.closed.map((t) => t.hubId), ['hub-c']);

  const text = formatTombstoneList(state, { tombstone: { autoPropagate: false } });
  assert.match(text, /共 3 条/);
  assert.match(text, /自动传播: 关闭/);
  assert.match(text, /疑似风暴 1 条/);
  assert.match(text, /【待 wiki 标记】1 条/);
  assert.match(text, /hub-c.*疑似风暴/);
  assert.match(text, /hub tombstone apply/, '关闭态且有待办时提示显式执行');
});

test('CLI：previewTombstoneApply 纯只读预览影响面（整页删除/部分剔除/目标 App）', () => {
  freshHubRoot();
  const p1 = writeWikiPage(['hub-1'], 'p1', '整删页', '正文。');
  const p2 = writeWikiPage(['hub-2', 'hub-keep'], 'p2', '部分页', '正文。');
  const before1 = fs.readFileSync(p1, 'utf8');
  const before2 = fs.readFileSync(p2, 'utf8');
  const state = {
    tombstones: {
      'hub-1': { app: 'codex', deletedAt: '2026-08-06T00:00:00.000Z', suspectedStorm: true },
      'hub-2': { app: 'codex', deletedAt: '2026-08-06T00:00:00.000Z' },
      'hub-done': { app: 'codex', deletedAt: '2026-08-01T00:00:00.000Z', wikiApplied: 'x', appsCleaned: 'y' },
    },
    storms: {},
  };
  const config = {
    apps: [
      { id: 'codex', enabled: true, memory_paths: ['/tmp/x'] },
      { id: 'claude', enabled: false, memory_paths: ['/tmp/y'] },
      { id: 'qoder', enabled: true, memory_paths: ['/tmp/z'], readOnly: true },
    ],
  };
  const preview = previewTombstoneApply({ state, config });
  assert.deepEqual(preview.pendingWikiIds.sort(), ['hub-1', 'hub-2']);
  assert.deepEqual(preview.removalIds.sort(), ['hub-1', 'hub-2'], '已闭环条目不再列入');
  assert.deepEqual(preview.stormIds, ['hub-1']);
  assert.deepEqual(preview.deletedPages, ['p1.md']);
  assert.deepEqual(preview.updatedPages, ['p2.md']);
  assert.deepEqual(preview.apps, ['codex'], '禁用与只读 App 不在影响面内');
  // 纯只读：预览不得改动任何文件
  assert.equal(fs.readFileSync(p1, 'utf8'), before1);
  assert.equal(fs.readFileSync(p2, 'utf8'), before2);

  const text = formatTombstonePreview(preview);
  assert.match(text, /整页删除 1 页: p1\.md/);
  assert.match(text, /部分剔除 1 页: p2\.md/);
  assert.match(text, /目标 App: codex/);
  assert.match(text, /1 条带 suspectedStorm/);
});

test('CLI 子进程：hub tombstone apply --dry-run 只预览零写入', () => {
  const root = freshHubRoot();
  const page = writeWikiPage(['hub-x'], 'x', '待删页', '正文。');
  addTombstones([{ hubId: 'hub-x', app: 'codex' }]);
  const pageBefore = fs.readFileSync(page, 'utf8');
  const tombBefore = fs.readFileSync(tombstonesPath(), 'utf8');

  const r = runCli(['tombstone', 'apply', '--dry-run'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /整页删除 1 页: x\.md/);
  assert.match(r.stdout, /\[dry-run\] 仅预览，未做任何写入/);
  assert.equal(fs.readFileSync(page, 'utf8'), pageBefore, 'dry-run 不得动 wiki 页');
  assert.equal(fs.readFileSync(tombstonesPath(), 'utf8'), tombBefore, 'dry-run 不得动 tombstone 清单');
});

test('CLI 子进程：hub tombstone list / drop（含未找到退出码 1 与空清单提示）', () => {
  const root = freshHubRoot();
  writeWikiPage(['hub-x'], 'x', '待删页', '正文。');
  addTombstones([{ hubId: 'hub-x', app: 'codex', source: '/fake/x.md' }]);

  let r = runCli(['tombstone', 'list'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /共 1 条/);
  assert.match(r.stdout, /【待 wiki 标记】1 条/);
  assert.match(r.stdout, /hub-x/);

  // drop 未找到 → 退出码 1
  r = runCli(['tombstone', 'drop', 'hub-miss'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未找到 tombstone/);

  // drop 命中 → 撤销登记
  r = runCli(['tombstone', 'drop', 'hub-x'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已撤销 tombstone hub-x/);
  assert.equal(Object.keys(loadTombstones().tombstones).length, 0);

  // 清单已空：apply 直接提示无待传播
  r = runCli(['tombstone', 'apply', '--dry-run'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /没有待传播的 tombstone/);
});

test('CLI：runTombstoneApply force 语义——含 suspectedStorm 条目全链路传播并闭环', async () => {
  freshHubRoot();
  const page = writeWikiPage(['hub-st'], 'st', '风暴待删页', '正文。');
  addTombstones([{ hubId: 'hub-st', app: 'codex' }]);
  updateTombstones(['hub-st'], { suspectedStorm: true });

  const adapter = fakeAdapter();
  // 配置保持缺省（autoPropagate=false）：显式 apply 必须绕过开关与风暴过滤
  const { tombstone, writeback } = await runTombstoneApply({ config: defaultConfig(), adapters: [adapter] });
  assert.deepEqual(tombstone.deletedPages, ['st.md']);
  assert.deepEqual(adapter.calls.removed, [['hub-st']], 'removalsOnly 传播含风暴条目');
  assert.deepEqual(adapter.calls.written, [], 'removalsOnly 不写回任何条目');
  assert.equal(writeback.ok, true);
  const t = loadTombstones().tombstones['hub-st'];
  assert.ok(t.wikiApplied && t.appsCleaned, '显式传播后闭环打点');
  assert.equal(matter(fs.readFileSync(page, 'utf8')).data.deleted, true);
});

// ---------------------------------------------------------------------------
// SHOULD-4/5/6/7 + doctor
// ---------------------------------------------------------------------------

test('SHOULD-4：子目录同名页不被 basename 误匹配，只认相对 wiki 根精确路径', async () => {
  freshHubRoot();
  writeWikiPage(['hub-top'], 'a', '顶层页', '顶层正文。');
  writeWikiPage(['hub-sub'], 'sub/a', '子目录页', '子目录正文。');

  // 清单只列顶层 a.md：子目录同名 sub/a.md 不得被 basename 命中
  appendPendingWriteback([{ path: 'a.md', hubIds: ['hub-top'] }]);
  let adapter = fakeAdapter();
  let result = await runWriteback({ config: { apps: [] }, adapters: [adapter] });
  assert.equal(result.mode, 'incremental');
  assert.deepEqual(adapter.calls.written, [['hub-top']], '子目录同名页不得混入');

  // 清单列子目录页：只认 path.relative 精确匹配
  appendPendingWriteback([{ path: 'sub/a.md', hubIds: ['hub-sub'] }]);
  adapter = fakeAdapter();
  result = await runWriteback({ config: { apps: [] }, adapters: [adapter] });
  assert.equal(result.mode, 'incremental');
  assert.deepEqual(adapter.calls.written, [['hub-sub']], '相对路径精确命中子目录页');
});

test('SHOULD-5：testMarkers 迁入配置——缺省即现有 4 个值，hasTestMarker 接受自定义清单', () => {
  assert.deepEqual(DEFAULT_TEST_MARKERS, ['HUB-TEST', '冒烟测试', 'N4 冒烟', 'N4冒烟']);
  assert.deepEqual(defaultConfig().distill.testMarkers, DEFAULT_TEST_MARKERS, '缺省配置与内置标记一致');

  const snap = { title: '标题', body: '正文 HUB-TEST 残留' };
  assert.equal(hasTestMarker(snap), true, '缺省标记命中');
  assert.equal(hasTestMarker(snap, ['CUSTOM-MARK']), false, '自定义清单下不命中缺省标记');
  assert.equal(hasTestMarker({ title: 'x', body: '含 CUSTOM-MARK 的正文' }, ['CUSTOM-MARK']), true);
});

test('SHOULD-6/7：lockTimeoutHint 锁超时提示与 formatWritebackSummary mode 行', () => {
  assert.equal(CLI_LOCK_TIMEOUT_MS, 30 * 1000, 'CLI 交互命令抢锁超时 30s');
  const hint = lockTimeoutHint(new Error('withLock 抢锁超时（30000ms）：/x/write.lock 被其他进程长期持有'));
  assert.match(hint, /锁被 daemon 持有，请稍后再试/);
  assert.equal(lockTimeoutHint(new Error('其他错误')), null, '非锁超时错误不误报');
  assert.equal(lockTimeoutHint(undefined), null);

  const text = formatWritebackSummary({ ok: true, mode: 'full', entryCount: 2, appResults: [] });
  assert.match(text, /mode: full，条目数: 2/);
  const inc = formatWritebackSummary({ ok: true, mode: 'incremental', entryCount: 0, appResults: [] });
  assert.match(inc, /mode: incremental，条目数: 0/);
});

test('doctor：checkTombstones 空环境 ok；风暴/超 7 天未闭环 → warn 且详情提示', () => {
  freshHubRoot();
  let c = checkTombstones();
  assert.equal(c.level, 'ok');
  assert.match(c.summary, /无 tombstone 登记/);

  // 直接落盘伪造清单：1 条超 7 天未闭环 + 1 条风暴标记（缺省 autoPropagate=false）
  fs.writeFileSync(
    tombstonesPath(),
    JSON.stringify({
      version: 1,
      tombstones: {
        'hub-old': { app: 'codex', source: '', deletedAt: '2026-07-01T00:00:00.000Z' },
        'hub-storm': { app: 'codex', source: '', deletedAt: new Date().toISOString(), suspectedStorm: true },
      },
      storms: {},
    }),
  );
  c = checkTombstones();
  assert.equal(c.level, 'warn');
  assert.match(c.summary, /风暴标记 1/);
  assert.match(c.summary, /超 7 天未闭环 1/);
  const details = (c.details || []).join('\n');
  assert.match(details, /待确认的删除/, 'autoPropagate 关闭时提示待确认数');
  assert.match(details, /suspectedStorm/);
  assert.match(details, /超过 7 天仍未闭环/);
});
