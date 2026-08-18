/**
 * test/test-task4-cli-doctor-search.js —— Task#4 CLI 集成自测（node:test）。
 *
 * 全部在 MEMORY_HUB_ROOT 隔离的临时目录演练，绝不触碰真实数据
 * （~/.memory-hub/、~/Desktop/Memory Hub/、各 App 记忆文件）。
 *
 * 覆盖：
 * 1. hub doctor（src/doctor.js）：八项检查逐项构造异常场景（缺页索引/重复标题/
 *    隔离与毒批/积压阈值/写回失败与 pending 滞留/备份池外遗留/残留锁/测试污染），
 *    含「纯只读、空环境零写入」与健康环境全绿断言；
 * 2. hub search（src/search.js）：多关键词 AND、大小写不敏感、tags/frontmatter 命中、
 *    --limit 截断与总命中数、hub-id/标题/首个命中行摘录输出；
 * 3. CLI 接线（spawn 真实 node src/cli.js）：hub index 改调 rebuildMasterIndex、
 *    hub doctor --json 结构化输出与退出码、hub search 输出、
 *    hub writeback --repair 三态修复落盘、默认增量 vs --full 强制全量；
 * 4. hub status 增强：隔离/毒批计数、权威日志路径提示、doctor 提示。
 *
 * 运行：npm test 或 node --test test/test-task4-cli-doctor-search.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { paths } from '../src/util/paths.js';
import { storePaths } from '../src/hub-store.js';
import { rebuildMasterIndex } from '../src/index-builder.js';
import { findHubRegions, HUB_MARK_START, HUB_MARK_END } from '../src/adapters/codex.js';
import { MAX_FULL_BACKUPS } from '../src/safe-write.js';
import {
  runDoctor,
  formatDoctorReport,
  checkIndex,
  checkDuplicateTitles,
  checkQuarantine,
  checkBacklog,
  checkWriteback,
  checkBackups,
  checkLocks,
  checkTestMarkers,
  BACKLOG_WARN_THRESHOLD,
} from '../src/doctor.js';
import { searchWiki, formatSearchResults, DEFAULT_SEARCH_LIMIT } from '../src/search.js';
import { getStatusReport, runWritebackRepair, formatRepairSummary } from '../src/cli.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-task4-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 写一个 wiki 页面（frontmatter 含 hub-id/tags），返回绝对路径。 */
function writePage(slug, { title = slug, hubIds = [], tags = [], body = '正文内容' } = {}) {
  const fm = ['---'];
  if (hubIds.length > 0) {
    fm.push('hub-id:');
    for (const id of hubIds) fm.push(`  - ${id}`);
  }
  if (tags.length > 0) {
    fm.push('tags:');
    for (const t of tags) fm.push(`  - ${t}`);
  }
  fm.push('category: project_introduction', '---');
  const p = path.join(storePaths.wiki, `${slug}.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${fm.join('\n')}\n# ${title}\n\n${body}\n`);
  return p;
}

/** 写一个 sources 快照（distill 未整理扫描的输入）。 */
function writeSnapshot(app, name, hubId, body = '快照正文') {
  const p = path.join(storePaths.sources, app, `${name}.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `---\nhubId: ${hubId}\napp: ${app}\ntitle: ${name}\ningestedAt: 2026-08-01T00:00:00.000Z\n---\n# ${name}\n\n${body}\n`,
  );
  return p;
}

/** spawn 真实 CLI（隔离 root 注入环境变量），返回 { status, stdout, stderr }。 */
function runCli(args, root) {
  const env = { ...process.env, MEMORY_HUB_ROOT: root };
  delete env.MEMORY_HUB_USER_ROOT;
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', env });
}

/** 拿一个已退出进程的 pid（伪造死锁持有者）。 */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(child.pid > 0, '测试前提：能拿到已退出子进程的 pid');
  return child.pid;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. hub doctor —— 逐项检查
// ---------------------------------------------------------------------------

test('doctor：空环境全绿且零写入（纯只读承诺）', () => {
  const root = freshHubRoot();
  const report = runDoctor();
  assert.equal(report.ok, true);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.checks.length, 10);
  // 纯只读：runDoctor 之后隔离根目录仍然空空如也（不建目录、不写任何文件）
  assert.deepEqual(fs.readdirSync(root), []);
  const text = formatDoctorReport(report);
  assert.match(text, /健康度报告/);
  assert.match(text, /结论: ✅ 10 项正常 \/ ⚠️ 0 项告警 \/ ❌ 0 项异常/);
});

test('doctor 索引完整率：缺页 ❌（列缺失示例）、陈旧行与 hub-id 未回填 ⚠️', () => {
  freshHubRoot();
  writePage('page-a', { title: '页面A', hubIds: ['hub-a-1'] });
  writePage('page-b', { title: '页面B', hubIds: ['hub-b-1'] });
  // 手工索引：只收录 a，另含一条已删除页面的陈旧行 c
  fs.mkdirSync(path.dirname(storePaths.masterIndex), { recursive: true });
  fs.writeFileSync(
    storePaths.masterIndex,
    ['# Master Index —— 中转站目录索引', '', '共 2 个页面：', '', '- [页面A](page-a.md) — 摘要（hub-id: hub-a-1）', '- [幽灵页](page-c.md) — 摘要（hub-id: 无）', ''].join('\n'),
  );
  const c = checkIndex();
  assert.equal(c.level, 'fail');
  assert.equal(c.data.pageCount, 2);
  assert.equal(c.data.missingCount, 1);
  assert.deepEqual(c.data.missingExamples, ['page-b.md']);
  assert.equal(c.data.staleCount, 1);
  assert.equal(c.data.hubIdFilled, 2);
  assert.match(c.details.join('\n'), /page-b\.md/);

  // 索引补全后：仅剩「hub-id 未回填」告警（新增一页无 hub-id）
  writePage('page-noid', { title: '无ID页', hubIds: [] });
  rebuildMasterIndex();
  const c2 = checkIndex();
  assert.equal(c2.level, 'warn');
  assert.equal(c2.data.missingCount, 0);
  assert.equal(c2.data.hubIdFilled, 2);
  assert.match(c2.details.join('\n'), /hub-id 未回填 1 页/);
});

test('doctor 重复标题：按 H1 分组统计重复组数', () => {
  freshHubRoot();
  writePage('dup-1', { title: '同名主题', hubIds: ['hub-1'] });
  writePage('dup-2', { title: '同名主题', hubIds: ['hub-2'] });
  writePage('uniq', { title: '独立主题', hubIds: ['hub-3'] });
  const c = checkDuplicateTitles();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.groupCount, 1);
  assert.equal(c.data.groups[0].title, '同名主题');
  assert.deepEqual(c.data.groups[0].pages.sort(), ['dup-1.md', 'dup-2.md']);
});

test('doctor 隔离与失败：quarantined/毒批/未达阈值批次分别计数', () => {
  freshHubRoot();
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(
    path.join(paths.state, 'distill-state.json'),
    JSON.stringify({
      version: 1,
      processed: {},
      quarantined: { 'wukong/a.md': { at: 'x', error: 'bad yaml' }, 'wukong/b.md': { at: 'x', error: 'bad yaml' } },
      batchFailures: { sigX: 3, sigY: 1 },
      poisonedBatches: { sigX: { at: 'x' } },
    }),
  );
  const c = checkQuarantine();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.quarantined, 2);
  assert.equal(c.data.poisonedBatches, 1);
  // sigY 失败 1 次未达隔离阈值；sigX 已入毒批不重复计
  assert.equal(c.data.pendingBatchFailures, 1);
  assert.match(c.summary, /隔离快照 2 条 \/ 毒批 1 个 \/ 未达隔离阈值的失败批次 1 个/);
});

test('doctor distill 积压：未整理快照计数与告警阈值', () => {
  freshHubRoot();
  writeSnapshot('qoder', 'snap-1', 'hub-back-1');
  writeSnapshot('qoder', 'snap-2', 'hub-back-2');
  let c = checkBacklog();
  assert.equal(c.level, 'ok');
  assert.equal(c.data.pendingSnapshots, 2);
  // 超过告警阈值 → ⚠️
  for (let i = 3; i <= BACKLOG_WARN_THRESHOLD + 1; i += 1) {
    writeSnapshot('qoder', `snap-${i}`, `hub-back-${i}`);
  }
  c = checkBacklog();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.pendingSnapshots, BACKLOG_WARN_THRESHOLD + 1);
  assert.match(c.details.join('\n'), /hub distill/);
});

test('doctor 写回健康：failed 计数 ⚠️、pending 滞留超 24h ❌、诊断日志失败记录', () => {
  freshHubRoot();
  fs.mkdirSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  // writeback-log（JSONL）最近记录含 1 条 failed
  fs.writeFileSync(
    path.join(paths.state, 'writeback-log.json'),
    [
      JSON.stringify({ time: 't1', app: 'codex', hubId: 'h1', result: 'written', backupDir: null }),
      JSON.stringify({ time: 't2', app: 'qoder', hubId: '*', result: 'failed: 写回后校验失败', backupDir: null }),
      '',
    ].join('\n'),
  );
  // 诊断日志含 [error]
  fs.writeFileSync(
    path.join(paths.logs, 'writeback.log'),
    '[2026-08-06T00:00:00.000Z] [error] [qoder] 写回失败: boom\n',
  );
  let c = checkWriteback();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.failedCount, 1);
  assert.equal(c.data.diagErrorCount, 1);
  assert.match(c.details.join('\n'), /boom/);

  // pending-writeback.json 滞留超 24h → ❌
  fs.writeFileSync(
    path.join(paths.state, 'pending-writeback.json'),
    JSON.stringify({
      updatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      pages: [{ path: 'x.md', hubIds: ['hub-x'] }],
    }),
  );
  c = checkWriteback();
  assert.equal(c.level, 'fail');
  assert.equal(c.data.pendingStale, true);
  assert.equal(c.data.pendingPages, 1);

  // 新鲜的 pending 不算滞留（降回 ⚠️，因仍有 failed 记录）
  fs.writeFileSync(
    path.join(paths.state, 'pending-writeback.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), pages: [{ path: 'x.md', hubIds: ['hub-x'] }] }),
  );
  c = checkWriteback();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.pendingStale, false);
});

test('doctor 备份池：full 池超限与池外遗留目录（数量 + 总体积）⚠️', () => {
  freshHubRoot();
  // full 池超限
  for (let i = 0; i <= MAX_FULL_BACKUPS; i += 1) {
    fs.mkdirSync(path.join(paths.backups, 'full', `2026-08-0${(i % 9) + 1}T00-00-00-000Z-${i}`), {
      recursive: true,
    });
  }
  // 池外遗留：backups/ 根下的时间戳目录（池管理之外）
  const stray = path.join(paths.backups, '2026-01-01T00-00-00-000Z');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'old.md'), 'x'.repeat(2048));
  const c = checkBackups();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.fullCount, MAX_FULL_BACKUPS + 1);
  assert.equal(c.data.strayCount, 1);
  assert.equal(c.data.strayBytes, 2048);
  assert.match(c.summary, /池外遗留 1 个（共 2\.0KB）/);
  assert.match(c.details.join('\n'), /2026-01-01T00-00-00-000Z/);
  assert.match(c.details.join('\n'), /绝不代删/);
});

test('doctor 锁状态：持有者已退出 → 残留锁 ⚠️；存活且心跳新鲜 → ✅', () => {
  freshHubRoot();
  fs.mkdirSync(paths.state, { recursive: true });
  const lock = path.join(paths.state, 'write.lock');
  // 死 pid → 陈旧锁告警
  fs.writeFileSync(lock, `${JSON.stringify({ pid: deadPid(), ts: Date.now() })}\n`);
  let c = checkLocks();
  assert.equal(c.level, 'warn');
  assert.equal(c.data.lockCount, 1);
  assert.equal(c.data.staleCount, 1);
  assert.match(c.summary, /陈旧锁/);
  // 本进程持有 + mtime 新鲜 → 正常在持
  fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`);
  c = checkLocks();
  assert.equal(c.level, 'ok');
  assert.equal(c.data.staleCount, 0);
  assert.match(c.summary, /1 把锁在持/);
  // 无锁 → 空闲
  fs.rmSync(lock);
  c = checkLocks();
  assert.equal(c.level, 'ok');
  assert.match(c.summary, /无锁文件/);
});

test('doctor 测试污染：含 TEST_MARKERS 的页面清单 ❌，整体报告非 ok；健康环境全绿', () => {
  freshHubRoot();
  writePage('clean-page', { title: '正常页', hubIds: ['hub-c-1'] });
  writePage('polluted', { title: '污染页', hubIds: ['hub-p-1'], body: '这是 HUB-TEST 冒烟产物' });
  rebuildMasterIndex();
  const c = checkTestMarkers();
  assert.equal(c.level, 'fail');
  assert.equal(c.data.pollutedCount, 1);
  assert.deepEqual(c.data.pollutedPages, ['polluted.md']);
  const report = runDoctor();
  assert.equal(report.ok, false);
  assert.ok(report.counts.fail >= 1);
  assert.match(formatDoctorReport(report), /❌ 【测试污染】/);

  // 移除污染页并重建索引 → 健康环境全绿
  fs.rmSync(path.join(storePaths.wiki, 'polluted.md'));
  rebuildMasterIndex();
  const healthy = runDoctor();
  assert.equal(healthy.ok, true);
  assert.equal(healthy.counts.fail, 0);
  assert.equal(healthy.counts.warn, 0);
});

// ---------------------------------------------------------------------------
// 2. hub search
// ---------------------------------------------------------------------------

test('search：多关键词 AND、大小写不敏感，输出标题/hub-id/首个命中行', () => {
  freshHubRoot();
  writePage('alpha-beta', {
    title: '商品对比CVR分析',
    hubIds: ['hub-s-1', 'hub-s-2'],
    body: '第一段无关。\n\nAlpha 与 beta 在此同现。',
  });
  writePage('only-alpha', { title: '只有Alpha', hubIds: ['hub-s-3'], body: 'alpha 单独出现' });
  const res = searchWiki(['ALPHA', 'Beta']);
  assert.equal(res.total, 1);
  assert.equal(res.results.length, 1);
  const hit = res.results[0];
  assert.equal(hit.rel, path.join('wiki', 'alpha-beta.md')); // rel 改为 hub 根相对（区分 core/ 与 wiki/）
  assert.equal(hit.title, '商品对比CVR分析');
  assert.deepEqual(hit.hubIds, ['hub-s-1', 'hub-s-2']);
  assert.ok(hit.lineNo > 0);
  assert.match(hit.excerpt, /Alpha 与 beta/);
  // 单关键词命中两页
  assert.equal(searchWiki(['alpha']).total, 2);
  // 无关键词/无命中
  assert.equal(searchWiki([]).total, 0);
  assert.equal(searchWiki(['不存在的词']).total, 0);
});

test('search：tags/frontmatter 命中、--limit 截断但总命中数照报、输出格式', () => {
  freshHubRoot();
  writePage('tagged', { title: '标签页', hubIds: ['hub-t-1'], tags: ['转人工率'], body: '正文不含该词' });
  const tagRes = searchWiki(['转人工率']);
  assert.equal(tagRes.total, 1);
  assert.equal(tagRes.results[0].rel, path.join('wiki', 'tagged.md'));

  for (let i = 1; i <= 3; i += 1) {
    writePage(`zeta-${i}`, { title: `Zeta页${i}`, hubIds: [`hub-z-${i}`], body: '关键词 zeta 出现' });
  }
  const res = searchWiki(['zeta'], { limit: 2 });
  assert.equal(res.total, 3);
  assert.equal(res.results.length, 2);
  const text = formatSearchResults(res);
  assert.match(text, /关键词: zeta —— 命中 3 页（仅显示前 2 条/);
  assert.match(text, /1\. wiki\/zeta-1\.md · Zeta页1（hub-id: hub-z-1）/);
  assert.match(text, /L\d+: /);
  // 缺省 limit 为 20
  assert.equal(searchWiki(['zeta']).limit, DEFAULT_SEARCH_LIMIT);
  // 空关键词提示用法
  assert.match(formatSearchResults(searchWiki([])), /请提供至少一个关键词/);
});

// ---------------------------------------------------------------------------
// 3. writeback --repair（直调）
// ---------------------------------------------------------------------------

/** 造一个含两个标记区（同 hub-id 重复块）的 AGENTS.md 内容 */
function multiRegionAgents() {
  return [
    '# 项目说明',
    '',
    '区外内容 A',
    '',
    HUB_MARK_START,
    '### 条目一 [hub-20260101-aaaa]',
    '正文 v1',
    HUB_MARK_END,
    '',
    '区外内容 B',
    '',
    HUB_MARK_START,
    '### 条目一 [hub-20260101-aaaa]',
    '正文 v2',
    '### 条目二 [hub-20260101-bbbb]',
    '正文 B',
    HUB_MARK_END,
    '',
  ].join('\n');
}

test('runWritebackRepair：missing/clean/repaired 三态与去重统计；非 codex 拒绝', () => {
  const root = freshHubRoot();
  const cleanFile = path.join(root, 'clean', 'AGENTS.md');
  fs.mkdirSync(path.dirname(cleanFile), { recursive: true });
  fs.writeFileSync(cleanFile, `# hi\n\n${HUB_MARK_START}\n### 条目 [hub-x]\n正文\n${HUB_MARK_END}\n`);
  const brokenFile = path.join(root, 'broken', 'AGENTS.md');
  fs.mkdirSync(path.dirname(brokenFile), { recursive: true });
  fs.writeFileSync(brokenFile, multiRegionAgents());
  const missingFile = path.join(root, 'nope', 'AGENTS.md');

  const config = {
    apps: [{ id: 'codex', enabled: true, memory_paths: [cleanFile, brokenFile, missingFile] }],
  };
  const repair = runWritebackRepair({ config });
  assert.equal(repair.ok, true);
  const byPath = Object.fromEntries(repair.results.map((r) => [r.path, r]));
  assert.equal(byPath[cleanFile].status, 'clean');
  assert.equal(byPath[missingFile].status, 'missing');
  const fixed = byPath[brokenFile];
  assert.equal(fixed.status, 'repaired');
  assert.equal(fixed.regionCount, 2);
  assert.equal(fixed.totalBlocks, 3);
  assert.equal(fixed.uniqueBlocks, 2);
  assert.equal(fixed.duplicateBlocks, 1);
  assert.ok(fixed.backupDir && fs.existsSync(fixed.backupDir), '修复必须留备份');

  // 落盘结果：单一标记区、保留最后版本、区外内容原样
  const after = fs.readFileSync(brokenFile, 'utf8');
  assert.equal(findHubRegions(after).length, 1);
  assert.match(after, /正文 v2/);
  assert.doesNotMatch(after, /正文 v1/);
  assert.match(after, /区外内容 A/);
  assert.match(after, /区外内容 B/);

  // 摘要输出三态齐全
  const text = formatRepairSummary(repair);
  assert.match(text, /clean：标记区正常/);
  assert.match(text, /repaired：2 个标记区合并为 1 个，块 3 → 2（去重 1）/);
  assert.match(text, /missing：文件不存在/);

  // 非 codex app 拒绝；无 memory_paths 报错
  assert.match(runWritebackRepair({ app: 'claude', config }).error, /仅支持 codex/);
  assert.match(
    runWritebackRepair({ config: { apps: [{ id: 'codex', enabled: true, memory_paths: [] }] } }).error,
    /没有 memory_paths/,
  );
});

// ---------------------------------------------------------------------------
// 4. CLI 接线（spawn 真实 node src/cli.js）
// ---------------------------------------------------------------------------

test('CLI hub index：改调 rebuildMasterIndex（全量收录 + hub-id 回填）', () => {
  const root = freshHubRoot();
  writePage('idx-page', { title: '索引页', hubIds: ['hub-idx-1'] });
  const r = runCli(['index'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已生成主索引/);
  const index = fs.readFileSync(storePaths.masterIndex, 'utf8');
  assert.match(index, /## 主题页（1 页）/);
  assert.match(index, /\[索引页\]\(idx-page\.md\)/);
  assert.match(index, /hub-id: hub-idx-1/); // 旧 generateMasterIndex 此处恒为空
});

test('CLI hub doctor --json：结构化输出；有 ❌ 时退出码非零', () => {
  const root = freshHubRoot();
  // 健康空环境：退出码 0
  let r = runCli(['doctor', '--json'], root);
  assert.equal(r.status, 0, r.stderr);
  let report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 10);
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['index', 'duplicate-titles', 'quarantine', 'backlog', 'writeback', 'backups', 'locks', 'test-markers', 'tombstones', 'daemon-health'],
  );
  // 注入测试污染页（同时造成索引缺页）→ 退出码非零
  writePage('bad', { title: '污染', hubIds: ['hub-bad'], body: 'HUB-TEST 残留' });
  r = runCli(['doctor', '--json'], root);
  assert.equal(r.status, 1);
  report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === 'test-markers').level, 'fail');
  // 人类可读版包含分级图标与结论行
  r = runCli(['doctor'], root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ 【测试污染】/);
  assert.match(r.stdout, /结论: /);
});

test('CLI hub search：关键词 AND 检索与 --limit', () => {
  const root = freshHubRoot();
  writePage('cli-hit', { title: '命中页', hubIds: ['hub-cli-1'], body: '包含 foo 与 bar 的正文' });
  writePage('cli-miss', { title: '未命中页', hubIds: ['hub-cli-2'], body: '只有 foo' });
  const r = runCli(['search', 'FOO', 'bar', '--limit', '5'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /命中 1 页/);
  assert.match(r.stdout, /cli-hit\.md · 命中页（hub-id: hub-cli-1）/);
  assert.match(r.stdout, /L\d+: 包含 foo 与 bar 的正文/);
  assert.doesNotMatch(r.stdout, /cli-miss/);
});

test('CLI hub writeback --repair：按 config 目标修复落盘；--app 非 codex 报错退出', () => {
  const root = freshHubRoot();
  const agents = path.join(root, 'ws', 'AGENTS.md');
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, multiRegionAgents());
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ apps: [{ id: 'codex', enabled: true, memory_paths: [agents] }] }),
  );
  const r = runCli(['writeback', '--repair'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repaired：2 个标记区合并为 1 个，块 3 → 2（去重 1）/);
  assert.match(r.stdout, /备份: /);
  assert.equal(findHubRegions(fs.readFileSync(agents, 'utf8')).length, 1);
  // 幂等：再跑一次是 clean
  const r2 = runCli(['writeback', '--repair'], root);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /clean：标记区正常（区数 1）/);
  // 不支持的 app
  const r3 = runCli(['writeback', '--repair', '--app', 'claude'], root);
  assert.equal(r3.status, 1);
  assert.match(r3.stdout, /仅支持 codex/);
});

test('CLI hub writeback：默认增量消费 pending 清单，--full 强制全量广播', () => {
  const root = freshHubRoot();
  const agents = path.join(root, 'ws', 'AGENTS.md');
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, '# 工作区说明\n');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ apps: [{ id: 'codex', enabled: true, memory_paths: [agents] }] }),
  );
  writePage('real-page', { title: '真实页', hubIds: ['hub-full-1'], body: '写回内容' });
  // 增量清单只列一个已不存在的页面 → 默认（增量）无条目可写
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(
    path.join(paths.state, 'pending-writeback.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), pages: [{ path: 'ghost.md', hubIds: ['hub-ghost'] }] }),
  );
  const inc = runCli(['writeback', '--dry-run'], root);
  assert.equal(inc.status, 0, inc.stderr);
  assert.match(inc.stdout, /增量清单中的页面已不存在/);
  assert.doesNotMatch(inc.stdout, /hub-full-1/);
  // --full 忽略清单，全量渲染 wiki 页面
  const full = runCli(['writeback', '--full', '--dry-run'], root);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /🧪 \[codex\]/);
  assert.match(full.stdout, /hub-full-1 · 真实页 渲染结果/);
});

// ---------------------------------------------------------------------------
// 5. hub status 增强
// ---------------------------------------------------------------------------

test('status 增强：隔离/毒批计数、权威日志路径提示、doctor 提示', () => {
  freshHubRoot();
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(
    path.join(paths.state, 'distill-state.json'),
    JSON.stringify({
      version: 1,
      processed: {},
      quarantined: { 'wukong/a.md': {}, 'wukong/b.md': {} },
      batchFailures: {},
      poisonedBatches: { sigX: {} },
    }),
  );
  const report = getStatusReport({ launchctl: () => ({ status: 1, stdout: '', stderr: '' }) });
  assert.match(report, /隔离快照 2 条 \/ 毒批隔离 1 个/);
  assert.match(report, /【日志与健康度】/);
  assert.match(report, new RegExp(`权威日志: ${paths.logs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(report, /桌面 .+ 为镜像，仅供查看/);
  assert.match(report, /运行 hub doctor 查看健康度报告/);
});
