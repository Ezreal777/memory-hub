/**
 * test/test-promote.js —— 用户维度长期核心层（wiki/core/）与晋升管道自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 hub/state，绝不触碰真实数据。
 *
 * 覆盖：
 * 1. scorePage 四信号打分（跨源复现/存活验证/探针命中/拍板语义）——纯函数注入伪造数据；
 * 2. core 页契约：writeCorePage 的 frontmatter（tier/category/hub-id）、更新保留 hub-id 与 promoted-at；
 * 3. promoteAdd：新建/并入既有页/并入 user-profile；容量上限拒绝新建；
 * 4. compact 隔离：listCompactablePages 不收 core 页；
 * 5. 分级写回：增量轮次 core 条目无条件重申（不在 pending 也写）、--core-only 只写核心层、
 *    core category 透传 qoder 适配器；App 侧文件被删后重申复活；
 * 6. demote：tier 移除、hubId 登记 pending removals；
 * 7. promoteScan 启发式提名（零 LLM 调用）与 reject 负样本抑制。
 *
 * 运行：npm test 或 node test/test-promote.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { storePaths } from '../src/hub-store.js';
import { corePaths, writeCorePage, readCorePage, listCorePages, countCorePages } from '../src/core-store.js';
import {
  scorePage,
  promoteAdd,
  promoteDemote,
  promoteScan,
  promoteReject,
  promoteApply,
  loadNominations,
  loadRetentionSignals,
} from '../src/promote.js';
import { listCompactablePages } from '../src/compact.js';
import { runWriteback, wikiToEntries, loadPendingWriteback } from '../src/writeback.js';
import { QoderAdapter } from '../src/adapters/qoder.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-promote-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

after(() => {
  delete process.env.MEMORY_HUB_ROOT;
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结果
    }
  }
});

/** 写一个 wiki 主题页（frontmatter 契约同 distill 产出） */
function writeWikiPage(slug, { hubIds, title, body, sources = [], tags = [] }) {
  fs.mkdirSync(storePaths.wiki, { recursive: true });
  const file = path.join(storePaths.wiki, `${slug}.md`);
  fs.writeFileSync(
    file,
    matter.stringify({ content: `# ${title}\n\n${body}\n` }, { 'hub-id': hubIds, sources, tags }),
  );
  return file;
}

/** 基础 core 配置（测试可覆写） */
function coreConfig(extra = {}) {
  return { enabled: true, maxEntries: 50, survivalDays: 15, reassertEveryRound: true, minScore: 3, ...extra };
}

// ---------------------------------------------------------------------------
// 1. 打分纯函数
// ---------------------------------------------------------------------------

test('scorePage：四信号独立计分，注入伪造留存/探针数据', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const old = '2026-08-01T00:00:00Z'; // 31 天前，满足 survivalDays=15
  const meta = {
    file: '/x/wiki/foo.md',
    title: '宽表口径（已拍板）',
    hubIds: ['hub-1'],
    sources: ['/h/Memory Hub/sources/claude/a.md', '/h/Memory Hub/sources/qoder/b.md'],
    body: '转化率口径，用户已确认。',
  };
  const signals = {
    retention: { firstSeen: new Map([['hub-1', old]]), removedCount: new Map() },
    probePages: new Set(['foo.md']),
  };
  const full = scorePage(meta, signals, { survivalDays: 15, now });
  assert.equal(full.score, 4);
  assert.deepEqual(full.signals, { crossSource: true, survival: true, probe: true, decision: true });

  // 单源 → crossSource 失分
  const singleSrc = scorePage({ ...meta, sources: [meta.sources[0]] }, signals, { survivalDays: 15, now });
  assert.equal(singleSrc.signals.crossSource, false);

  // 曾被清理 → survival 失分
  const removed = scorePage(
    meta,
    { ...signals, retention: { firstSeen: signals.retention.firstSeen, removedCount: new Map([['hub-1', 2]]) } },
    { survivalDays: 15, now },
  );
  assert.equal(removed.signals.survival, false);

  // 留存数据未覆盖（无首见记录）→ survival 不给分（未验证 ≠ 通过）
  const noData = scorePage(meta, { ...signals, retention: { firstSeen: new Map(), removedCount: new Map() } }, { now });
  assert.equal(noData.signals.survival, false);

  // 无拍板措辞 + 探针未命中
  const plain = scorePage(
    { ...meta, title: '普通主题', body: '一段普通内容。', file: '/x/wiki/bar.md' },
    signals,
    { survivalDays: 15, now },
  );
  assert.equal(plain.signals.decision, false);
  assert.equal(plain.signals.probe, false);
});

test('loadRetentionSignals：解析快照 JSONL 的首见时间与被清次数', () => {
  const root = freshHubRoot();
  const file = path.join(root, 'retention.jsonl');
  const lines = [
    { time: 't1', slugs: { a: { hubIds: ['hub-x', 'hub-y'] } }, diff: { removed: [], added: [] } },
    { time: 't2', slugs: { a: { hubIds: ['hub-x'] } }, diff: { removed: ['hub-y'], added: [] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  const r = loadRetentionSignals(file);
  assert.equal(r.snapshots, 2);
  assert.equal(r.firstSeen.get('hub-x'), 't1');
  assert.equal(r.removedCount.get('hub-y'), 1);
  assert.equal(r.removedCount.get('hub-x') || 0, 0);
});

// ---------------------------------------------------------------------------
// 2. core 页契约
// ---------------------------------------------------------------------------

test('writeCorePage：frontmatter 契约（tier/category/hub-id），更新保留 hub-id 与 promoted-at', () => {
  freshHubRoot();
  const r1 = writeCorePage({
    title: '转人工率口径',
    body: '以 touch 为单元，is_request_manual / touch_count。',
    category: 'development_code_specification',
    promotedFrom: ['handoff-rate.md'],
    now: '2026-08-17T00:00:00.000Z',
  });
  assert.ok(r1.created);
  assert.equal(r1.hubIds.length, 1);
  assert.match(r1.hubIds[0], /^hub-\d{14}-[a-z0-9]+$/);
  const parsed = matter(fs.readFileSync(r1.file, 'utf8'));
  assert.equal(parsed.data.tier, 'core');
  assert.equal(parsed.data.category, 'development_code_specification');
  assert.deepEqual(parsed.data['hub-id'], r1.hubIds);
  assert.equal(parsed.data['promoted-at'], '2026-08-17T00:00:00.000Z');
  assert.match(parsed.content, /^# 转人工率口径/m);

  // 原位更新：hub-id 与 promoted-at 不变，last-updated 刷新，promoted-from 并集
  const r2 = writeCorePage({
    file: r1.file,
    title: '转人工率口径',
    body: '更新后的口径正文。',
    category: 'development_code_specification',
    promotedFrom: ['another-source.md'],
    now: '2026-08-18T00:00:00.000Z',
  });
  assert.ok(!r2.created);
  assert.deepEqual(r2.hubIds, r1.hubIds);
  const again = matter(fs.readFileSync(r1.file, 'utf8'));
  assert.equal(again.data['promoted-at'], '2026-08-17T00:00:00.000Z');
  assert.equal(again.data['last-updated'], '2026-08-18T00:00:00.000Z');
  assert.deepEqual(again.data['promoted-from'], ['handoff-rate.md', 'another-source.md']);

  // 非法 category 回落缺省；空 body 拒写
  const r3 = writeCorePage({ title: '另一条', body: 'x', category: '中文非法', now: '2026-08-17T00:00:00.000Z' });
  assert.equal(readCorePage(r3.file).category, 'project_introduction');
  assert.throws(() => writeCorePage({ title: '空', body: '  ' }), /body 不能为空/);
});

// ---------------------------------------------------------------------------
// 3. promoteAdd 手动晋升 + 容量上限
// ---------------------------------------------------------------------------

test('promoteAdd：新建/并入/画像三种动作；maxEntries 上限拒绝新建', () => {
  freshHubRoot();
  writeWikiPage('metrics', { hubIds: ['hub-m1'], title: '宽表口径', body: '三大指标最终口径，已拍板。' });
  writeWikiPage('profile-src', { hubIds: ['hub-p1'], title: '用户偏好', body: '偏好数据先行、结论直给。' });
  writeWikiPage('extra', { hubIds: ['hub-e1'], title: '另一个事实', body: '正文。' });

  const config = { core: coreConfig({ maxEntries: 1 }) };
  // 新建成功（占满容量 1）
  const r1 = promoteAdd({ source: 'metrics.md', category: 'development_code_specification', config });
  assert.ok(r1.ok, r1.error);
  const page1 = readCorePage(r1.file);
  assert.equal(page1.category, 'development_code_specification');
  assert.deepEqual(page1.promotedFrom, ['metrics.md']);
  // 新发号，不与来源页共用 hubId（共用会导致同一 hubId 双渲染拉锯）
  assert.ok(!page1.hubIds.includes('hub-m1'));

  // 容量满：再新建被拒
  const r2 = promoteAdd({ source: 'extra.md', config });
  assert.ok(!r2.ok);
  assert.match(r2.error, /容量上限/);

  // 并入 user-profile 不受新建上限约束（固定单页）
  const r3 = promoteAdd({ source: 'profile-src.md', to: 'user-profile', config });
  assert.ok(r3.ok, r3.error);
  assert.equal(r3.file, corePaths.userProfile);
  assert.equal(readCorePage(corePaths.userProfile).category, 'user_info');

  // 并入既有 core 页（merge）：正文追加更新小节，hub-id 不变
  const before = readCorePage(r1.file);
  const r4 = promoteAdd({ source: 'extra.md', to: path.relative(corePaths.root, r1.file), config });
  assert.ok(r4.ok, r4.error);
  const merged = readCorePage(r1.file);
  assert.deepEqual(merged.hubIds, before.hubIds);
  assert.match(merged.body, /## 更新（\d{4}-\d{2}-\d{2}，晋升自 extra\.md）/);

  // core 页不能再次晋升
  const r5 = promoteAdd({ source: r1.file, config });
  assert.ok(!r5.ok);
});

// ---------------------------------------------------------------------------
// 4. compact / 索引隔离
// ---------------------------------------------------------------------------

test('compact 隔离：listCompactablePages 只收 wiki 顶层，core 页绝不参与归并', () => {
  freshHubRoot();
  writeWikiPage('topic-a', { hubIds: ['hub-a'], title: '主题A', body: '正文A。' });
  writeCorePage({ title: '核心事实', body: '正文。', now: '2026-08-17T00:00:00.000Z' });
  const pages = listCompactablePages();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].slug, 'topic-a');
});

// ---------------------------------------------------------------------------
// 5. 分级写回：重申 / core-only / category 透传 / 复活
// ---------------------------------------------------------------------------

/** 捕获型 mock 适配器（skipped 结果避开 verify 流程） */
function captureAdapter(id, seen) {
  return {
    id,
    render: (e) => `${e.title}\n${e.body}`,
    write: async (entries) => {
      seen.push(...entries);
      return entries.map((e) => ({ hubId: e.hubId, status: 'skipped', reason: 'capture' }));
    },
  };
}

test('分级写回：增量轮次 core 条目无条件重申；--core-only 只写核心层', async () => {
  const root = freshHubRoot();
  writeWikiPage('topic-a', { hubIds: ['hub-a'], title: '主题A', body: '正文A。' });
  writeWikiPage('topic-b', { hubIds: ['hub-b'], title: '主题B', body: '正文B。' });
  const core = writeCorePage({ title: '核心事实', body: '长期口径。', now: '2026-08-17T00:00:00.000Z' });

  // wikiToEntries 标记 tier
  const all = wikiToEntries();
  assert.equal(all.find((e) => e.hubId === core.hubIds[0])?.tier, 'core');
  assert.equal(all.find((e) => e.hubId === 'hub-a')?.tier, undefined);

  // pending 只列 topic-a：core 条目仍被附带重申，topic-b 不写
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'state', 'pending-writeback.json'),
    JSON.stringify({ updatedAt: 't0', pages: [{ path: 'topic-a.md', hubIds: ['hub-a'] }], removals: [] }),
  );
  const seen = [];
  const config = { apps: [{ id: 'mock', enabled: true, memory_paths: ['/tmp'] }], writeback: {}, core: coreConfig() };
  const r = await runWriteback({ config, adapters: [captureAdapter('mock', seen)] });
  assert.equal(r.mode, 'incremental');
  const ids = seen.map((e) => e.hubId).sort();
  assert.deepEqual(ids, ['hub-a', core.hubIds[0]].sort());

  // reassertEveryRound=false：core 不附带
  seen.length = 0;
  fs.writeFileSync(
    path.join(root, 'state', 'pending-writeback.json'),
    JSON.stringify({ updatedAt: 't1', pages: [{ path: 'topic-a.md', hubIds: ['hub-a'] }], removals: [] }),
  );
  const config2 = { ...config, core: coreConfig({ reassertEveryRound: false }) };
  await runWriteback({ config: config2, adapters: [captureAdapter('mock', seen)] });
  assert.deepEqual(seen.map((e) => e.hubId), ['hub-a']);

  // --core-only：只写核心层
  seen.length = 0;
  const r3 = await runWriteback({ config, adapters: [captureAdapter('mock', seen)], coreOnly: true });
  assert.equal(r3.mode, 'core-only');
  assert.deepEqual(seen.map((e) => e.hubId), [core.hubIds[0]]);
});

test('分级写回：core category 透传 qoder 适配器，App 侧文件被删后重申复活', async () => {
  freshHubRoot();
  const core = writeCorePage({
    title: '核心口径',
    body: '长期有效。',
    category: 'user_info',
    now: '2026-08-17T00:00:00.000Z',
  });
  const fakeQoderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-promote-qoder-'));
  tmpRoots.push(fakeQoderRoot);
  const appCfg = { id: 'qoder', enabled: true, memory_paths: [fakeQoderRoot], project_slug: 'proj' };
  const adapter = new QoderAdapter(appCfg);
  const config = { apps: [appCfg], writeback: {}, core: coreConfig() };

  // 第一轮（pending 为空 → 降级全量，含 core）：category 按页 frontmatter 落 user_info 目录
  const r1 = await runWriteback({ config, adapters: [adapter] });
  const target = path.join(fakeQoderRoot, 'projects', 'proj', 'user_info');
  const files1 = fs.readdirSync(target).filter((f) => f.endsWith('.md'));
  assert.equal(files1.length, 1);
  assert.ok(fs.readFileSync(path.join(target, files1[0]), 'utf8').includes(core.hubIds[0]));
  assert.equal(r1.appResults[0].status, 'written');

  // 模拟 Qoder 整理机制清掉该文件 → 下一轮增量（pending 空页清单）重申复活
  fs.rmSync(path.join(target, files1[0]));
  const r2 = await runWriteback({ config, adapters: [new QoderAdapter(appCfg)] });
  const files2 = fs.readdirSync(target).filter((f) => f.endsWith('.md'));
  assert.equal(files2.length, 1, 'core 条目被清后应复活');
  assert.equal(r2.appResults[0].status, 'written');

  // 第三轮：内容无变化，N2 幂等 skipped（零成本重申）
  const r3 = await runWriteback({ config, adapters: [new QoderAdapter(appCfg)] });
  assert.equal(r3.appResults[0].status, 'skipped');
});

// ---------------------------------------------------------------------------
// 6. demote 降级
// ---------------------------------------------------------------------------

test('promoteDemote：core 页移回 wiki 顶层（tier 移除），hubId 登记 pending removals', () => {
  freshHubRoot();
  const core = writeCorePage({ title: '将降级的事实', body: '正文。', now: '2026-08-17T00:00:00.000Z' });
  const slug = path.basename(core.file, '.md');
  const r = promoteDemote({ page: slug });
  assert.ok(r.ok, r.error);
  assert.ok(!fs.existsSync(core.file), '原 core 页已删除');
  assert.equal(path.dirname(r.file), storePaths.wiki, '落到 wiki 顶层');
  const fm = matter(fs.readFileSync(r.file, 'utf8')).data;
  assert.equal(fm.tier, undefined);
  assert.deepEqual(fm['hub-id'], core.hubIds, 'hub-id 保留（下轮按主题页重建 App 侧）');
  const pending = loadPendingWriteback();
  assert.ok(core.hubIds.every((id) => pending.removals.includes(id)), 'removals 登记旧渲染清理');
  assert.equal(countCorePages(), 0);
});

// ---------------------------------------------------------------------------
// 7. promoteScan 启发式提名 + reject 抑制
// ---------------------------------------------------------------------------

test('promoteScan：启发式提名（零 LLM）、minScore 过滤、reject 负样本抑制、apply 执行', async () => {
  freshHubRoot();
  const now = Date.parse('2026-09-01T00:00:00Z');
  writeWikiPage('decided', {
    hubIds: ['hub-d1'],
    title: '口径规范',
    body: '该口径已拍板，用户确认。',
    sources: ['/h/Memory Hub/sources/claude/a.md', '/h/Memory Hub/sources/qoder/b.md'],
  });
  writeWikiPage('plain', { hubIds: ['hub-x1'], title: '普通页', body: '普通内容。' });

  const retention = {
    firstSeen: new Map([['hub-d1', '2026-08-01T00:00:00Z']]),
    removedCount: new Map(),
    snapshots: 2,
  };
  const config = { core: coreConfig({ minScore: 3 }), llm: {} };
  const r = await promoteScan({ config, retention, probePages: new Set(['decided.md']), now });
  assert.ok(r.ok);
  assert.equal(r.nominated, 1, 'plain 低于 minScore 被过滤');
  const noms = loadNominations();
  assert.equal(noms.nominations[0].sourcePage, 'decided.md');
  assert.equal(noms.nominations[0].score, 4);

  // reject 后再扫描：30 天抑制窗口内不再提名
  promoteReject({ ids: [noms.nominations[0].id], now: new Date(now).toISOString() });
  const r2 = await promoteScan({ config, retention, probePages: new Set(['decided.md']), now });
  assert.equal(r2.nominated, 0);

  // 撤销负样本（模拟 31 天后）：重新提名并 apply 落 core 页
  const r3 = await promoteScan({
    config,
    retention,
    probePages: new Set(['decided.md']),
    now: now + 31 * 24 * 60 * 60 * 1000,
  });
  assert.equal(r3.nominated, 1);
  const applied = promoteApply({ all: true, config });
  assert.equal(applied.results.length, 1);
  assert.ok(applied.results[0].ok, applied.results[0].error);
  assert.equal(listCorePages().length, 1);
  // 已晋升的来源页不再重复提名
  const r4 = await promoteScan({
    config,
    retention,
    probePages: new Set(['decided.md']),
    now: now + 32 * 24 * 60 * 60 * 1000,
  });
  assert.equal(r4.nominated, 0);
});
