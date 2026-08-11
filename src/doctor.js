/**
 * doctor.js —— hub doctor 健康度体检（纯只读，绝不修改任何数据）。
 *
 * 背景（review 发现的可观测性痛点）：master-index 曾漏 46 页且 hub-id 全空、
 * 60+ 快照解析失败每轮重复报警、distill 曾积压 120 批、写回曾 qoder:failed
 * 无原因、备份池外遗留 19 个旧时间戳目录、wiki 曾有 24 组重复标题。
 * 本模块把这些盲区收敛为一次性体检报告，按 ✅/⚠️/❌ 分级：
 *
 *   1. 索引完整率：wiki 实际页面 vs master-index 收录（缺失示例 ≤10）、hub-id 回填率；
 *   2. 重复标题：按各页 H1/frontmatter title 统计重复组数；
 *   3. 隔离与失败：distill-state 的 quarantined / poisonedBatches / 未达隔离阈值的 batchFailures；
 *   4. distill 积压：未整理快照估算（复用 distill 的只读扫描，不隔离不落状态）；
 *   5. 写回健康：writeback-log 最近 N 条 failed 计数、pending-writeback.json 滞留超 24h、
 *      logs/writeback.log 最近失败记录；
 *   6. 备份池：full/writeback 池内数量 vs 上限、池外遗留目录数与总体积；
 *   7. 锁状态：state/*.lock 是否存在、持有者 pid 存活、心跳 mtime 新鲜度；
 *   8. 测试污染：wiki 中含测试标记（config.distill.testMarkers）的页面清单；
 *   9. tombstone 删除传播：待确认删除数、suspectedStorm 风暴标记数、
 *      长期未闭环（>7 天）数（MUST-2 安全阀可观测性）。
 *
 * 全部检查只读文件系统与状态文件，绝不创建目录、绝不写任何数据；
 * runDoctor() 返回结构化报告（--json 直接序列化），有 ❌ 时调用方以非零码退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { paths } from './util/paths.js';
import { isPidAlive, LOCK_STALE_MS } from './util/lock.js';
import { storePaths, loadTombstones } from './hub-store.js';
import { defaultConfig } from './config.js';
import { listWikiPages, readPageIndexMeta } from './index-builder.js';
import {
  loadDistillState,
  listUnprocessedSnapshots,
  hasTestMarker,
  TEST_MARKERS,
} from './distill.js';
import {
  loadWritebackLog,
  loadPendingWriteback,
  pendingWritebackPath,
  writebackDiagLogPath,
} from './writeback.js';
import { MAX_BACKUPS, MAX_FULL_BACKUPS, BACKUP_POOLS, backupPoolDir } from './safe-write.js';

/** 各检查项的缺失/污染示例最多列出条数 */
export const DOCTOR_EXAMPLE_LIMIT = 10;

/** distill 积压告警阈值（未整理快照条数；daemon 兜底扫描 1 小时一轮，少量积压属正常） */
export const BACKLOG_WARN_THRESHOLD = 50;

/** distill 积压异常阈值（超过视为整理链路卡死） */
export const BACKLOG_FAIL_THRESHOLD = 500;

/** 写回健康检查取 writeback-log 最近条数 */
export const WRITEBACK_RECENT_COUNT = 50;

/** pending-writeback.json 滞留判定阈值（超过视为写回链路卡死） */
export const PENDING_STALE_MS = 24 * 60 * 60 * 1000;

/** tombstone 长期未闭环判定阈值（登记超过 7 天仍未 wiki 标记 + App 清理完成） */
export const TOMBSTONE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 只读读取配置：doctor 纯只读钢线，不能用 loadConfig()（首次会惰性建目录/写默认配置）；
 * 读不到/损坏时回退 defaultConfig()（纯内存对象，无副作用）。
 * @returns {Object}
 */
function readConfigReadonly() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    if (raw && typeof raw === 'object') return { ...defaultConfig(), ...raw };
  } catch {
    // 不存在/损坏：默认配置兜底
  }
  return defaultConfig();
}

/** 分级图标 */
const LEVEL_ICONS = { ok: '✅', warn: '⚠️', fail: '❌' };

/** 构造统一的检查结果对象 */
function makeCheck(id, name, level, summary, details = [], data = {}) {
  return { id, name, level, summary, details, data };
}

/** 只读列出目录下的一级子目录（目录不存在返回空数组） */
function listDirsIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** 递归统计目录体积（字节；读不到的条目跳过） */
function dirSizeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // 读不到跳过
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** 字节数人类可读化（B/KB/MB） */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// 1. 索引完整率
// ---------------------------------------------------------------------------

/**
 * 索引完整率：wiki 实际页面数 vs master-index 收录数（缺失示例 ≤10）+ hub-id 回填率。
 * 缺页 → ❌；索引含已删除页（陈旧行）或 hub-id 回填不全 → ⚠️。
 * @returns {Object} 检查结果
 */
export function checkIndex() {
  const pages = listWikiPages();
  const rels = pages.map((f) => path.relative(storePaths.wiki, f));
  let indexRaw = null;
  try {
    indexRaw = fs.readFileSync(storePaths.masterIndex, 'utf8');
  } catch {
    // 索引不存在
  }
  if (pages.length === 0 && indexRaw === null) {
    return makeCheck('index', '索引完整率', 'ok', 'wiki 尚无页面，无需索引', [], {
      pageCount: 0,
      indexedCount: 0,
      missingCount: 0,
      missingExamples: [],
      staleCount: 0,
      hubIdFilled: 0,
    });
  }
  if (indexRaw === null) {
    return makeCheck(
      'index',
      '索引完整率',
      'fail',
      `master-index.md 不存在（wiki 有 ${pages.length} 页），运行 hub index 重建`,
      [],
      {
        pageCount: pages.length,
        indexedCount: 0,
        missingCount: pages.length,
        missingExamples: rels.slice(0, DOCTOR_EXAMPLE_LIMIT),
        staleCount: 0,
        hubIdFilled: 0,
      },
    );
  }
  const indexed = new Set();
  for (const line of indexRaw.split(/\r?\n/)) {
    const m = line.match(/^-\s*\[.*?\]\((.*?)\)/);
    if (m) indexed.add(m[1]);
  }
  const relSet = new Set(rels);
  const missing = rels.filter((r) => !indexed.has(r));
  const stale = [...indexed].filter((r) => !relSet.has(r));
  const hubIdFilled = pages.filter((f) => readPageIndexMeta(f).hubIds.length > 0).length;
  const details = [];
  if (missing.length > 0) {
    details.push(
      `缺失 ${missing.length} 页（示例 ≤${DOCTOR_EXAMPLE_LIMIT}）: ${missing.slice(0, DOCTOR_EXAMPLE_LIMIT).join(', ')}`,
    );
  }
  if (stale.length > 0) details.push(`索引含 ${stale.length} 条已删除页面的陈旧行`);
  if (hubIdFilled < pages.length) {
    details.push(`hub-id 未回填 ${pages.length - hubIdFilled} 页（页面 frontmatter 缺 hub-id）`);
  }
  if (missing.length > 0 || stale.length > 0) details.push('运行 hub index 可全量重建索引');
  const level = missing.length > 0 ? 'fail' : stale.length > 0 || hubIdFilled < pages.length ? 'warn' : 'ok';
  return makeCheck(
    'index',
    '索引完整率',
    level,
    `wiki ${pages.length} 页 / 索引收录 ${indexed.size} 页（缺失 ${missing.length}），hub-id 回填 ${hubIdFilled}/${pages.length}`,
    details,
    {
      pageCount: pages.length,
      indexedCount: indexed.size,
      missingCount: missing.length,
      missingExamples: missing.slice(0, DOCTOR_EXAMPLE_LIMIT),
      staleCount: stale.length,
      hubIdFilled,
    },
  );
}

// ---------------------------------------------------------------------------
// 2. 重复标题
// ---------------------------------------------------------------------------

/**
 * 重复标题组数：按各页 H1/frontmatter title（readPageIndexMeta 同款解析）分组统计。
 * @returns {Object} 检查结果
 */
export function checkDuplicateTitles() {
  const byTitle = new Map();
  for (const file of listWikiPages()) {
    const meta = readPageIndexMeta(file);
    if (!byTitle.has(meta.title)) byTitle.set(meta.title, []);
    byTitle.get(meta.title).push(meta.rel);
  }
  const groups = [...byTitle.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([title, files]) => ({ title, pages: files }));
  const details = groups
    .slice(0, DOCTOR_EXAMPLE_LIMIT)
    .map((g) => `「${g.title}」×${g.pages.length}: ${g.pages.join(', ')}`);
  return makeCheck(
    'duplicate-titles',
    '重复标题',
    groups.length > 0 ? 'warn' : 'ok',
    groups.length > 0 ? `发现 ${groups.length} 组重复标题（建议人工归并）` : '无重复标题',
    details,
    { groupCount: groups.length, groups: groups.slice(0, DOCTOR_EXAMPLE_LIMIT) },
  );
}

// ---------------------------------------------------------------------------
// 3. 隔离与失败（distill-state）
// ---------------------------------------------------------------------------

/**
 * 隔离与失败：quarantined 隔离快照数 / poisonedBatches 毒批数 /
 * batchFailures 中尚未达隔离阈值的批次数。
 * @param {Object} [state] distill 状态（缺省现读，纯只读）
 * @returns {Object} 检查结果
 */
export function checkQuarantine(state) {
  const st = state || loadDistillState();
  const quarantined = Object.keys(st.quarantined || {}).length;
  const poisoned = Object.keys(st.poisonedBatches || {}).length;
  const pendingFailures = Object.keys(st.batchFailures || {}).filter(
    (k) => !(st.poisonedBatches || {})[k],
  ).length;
  const details = [];
  if (quarantined > 0) {
    details.push(
      `隔离快照示例（≤${DOCTOR_EXAMPLE_LIMIT}）: ${Object.keys(st.quarantined).slice(0, DOCTOR_EXAMPLE_LIMIT).join(', ')}（位于 ${path.relative(storePaths.root, path.join(storePaths.sources, '_quarantine'))}/）`,
    );
  }
  if (poisoned > 0) details.push('毒批已停止重放，需人工检查 state/distill-state.json 的 poisonedBatches');
  if (pendingFailures > 0) details.push(`另有 ${pendingFailures} 个批次解析失败但未达隔离阈值（下轮会继续重试）`);
  const anyIssue = quarantined > 0 || poisoned > 0 || pendingFailures > 0;
  return makeCheck(
    'quarantine',
    '隔离与失败',
    anyIssue ? 'warn' : 'ok',
    `隔离快照 ${quarantined} 条 / 毒批 ${poisoned} 个 / 未达隔离阈值的失败批次 ${pendingFailures} 个`,
    details,
    { quarantined, poisonedBatches: poisoned, pendingBatchFailures: pendingFailures },
  );
}

// ---------------------------------------------------------------------------
// 4. distill 积压
// ---------------------------------------------------------------------------

/**
 * distill 积压：未整理快照估算（复用 distill 的只读扫描——不开 quarantine，
 * 不移动文件、不落状态）。
 * @param {Object} [state] distill 状态（缺省现读）
 * @returns {Object} 检查结果
 */
export function checkBacklog(state) {
  const st = state || loadDistillState();
  const pending = listUnprocessedSnapshots(st).length;
  const level = pending > BACKLOG_FAIL_THRESHOLD ? 'fail' : pending > BACKLOG_WARN_THRESHOLD ? 'warn' : 'ok';
  const details =
    level === 'ok'
      ? []
      : [`超过${level === 'fail' ? '异常' : '告警'}阈值（⚠️>${BACKLOG_WARN_THRESHOLD} / ❌>${BACKLOG_FAIL_THRESHOLD}），可手动运行 hub distill 消化积压`];
  return makeCheck(
    'backlog',
    'distill 积压',
    level,
    `未整理快照约 ${pending} 条`,
    details,
    { pendingSnapshots: pending, warnThreshold: BACKLOG_WARN_THRESHOLD, failThreshold: BACKLOG_FAIL_THRESHOLD },
  );
}

// ---------------------------------------------------------------------------
// 5. 写回健康
// ---------------------------------------------------------------------------

/**
 * 写回健康：writeback-log 最近 N 条 failed 计数、pending-writeback.json 滞留超 24h、
 * logs/writeback.log 最近失败记录。滞留 → ❌；仅有失败记录 → ⚠️。
 * @returns {Object} 检查结果
 */
export function checkWriteback() {
  const recent = loadWritebackLog().slice(-WRITEBACK_RECENT_COUNT);
  const failedCount = recent.filter((r) => /^failed/.test(String(r.result || ''))).length;

  // pending-writeback.json 滞留：有待写页面且 updatedAt 距今超 24h（时间不可解析按滞留算）
  const pending = loadPendingWriteback();
  let pendingStale = false;
  let pendingAgeMs = null;
  const pendingPages = pending && Array.isArray(pending.pages) ? pending.pages.length : 0;
  if (pendingPages > 0) {
    const t = Date.parse(pending.updatedAt);
    pendingAgeMs = Number.isFinite(t) ? Date.now() - t : null;
    pendingStale = pendingAgeMs === null || pendingAgeMs > PENDING_STALE_MS;
  }

  // 诊断日志 logs/writeback.log 最近失败记录（尾 50 行内的 [error]）
  let diagErrors = [];
  try {
    diagErrors = fs
      .readFileSync(writebackDiagLogPath(), 'utf8')
      .trim()
      .split('\n')
      .slice(-50)
      .filter((l) => l.includes('[error]'));
  } catch {
    // 无诊断日志：视为无失败
  }

  const details = [];
  if (failedCount > 0) details.push(`writeback-log 最近 ${recent.length} 条中 failed ${failedCount} 条`);
  if (pendingStale) {
    details.push(
      `pending-writeback.json 滞留 ${pendingAgeMs === null ? '未知时长（updatedAt 不可解析）' : `${Math.round(pendingAgeMs / 3600000)}h`}（${pendingPages} 页待写回，超 24h 视为链路卡死）: ${pendingWritebackPath()}`,
    );
  }
  if (diagErrors.length > 0) {
    details.push(`writeback.log 近 50 行含 ${diagErrors.length} 条失败记录，最近一条: ${diagErrors[diagErrors.length - 1]}`);
  }
  const level = pendingStale ? 'fail' : failedCount > 0 || diagErrors.length > 0 ? 'warn' : 'ok';
  return makeCheck(
    'writeback',
    '写回健康',
    level,
    `最近 ${recent.length} 条写回记录 failed ${failedCount} 条；增量清单${pendingPages > 0 ? `待写 ${pendingPages} 页${pendingStale ? '（已滞留超 24h）' : ''}` : '无滞留'}；诊断日志近 50 行失败 ${diagErrors.length} 条`,
    details,
    {
      recentCount: recent.length,
      failedCount,
      pendingPages,
      pendingStale,
      pendingAgeMs,
      diagErrorCount: diagErrors.length,
    },
  );
}

// ---------------------------------------------------------------------------
// 6. 备份池
// ---------------------------------------------------------------------------

/**
 * 备份池：full/writeback 池内数量 vs 各自上限、池外遗留目录数与总体积。
 * @returns {Object} 检查结果
 */
export function checkBackups() {
  const fullDirs = listDirsIn(backupPoolDir('full'));
  const wbDirs = listDirsIn(backupPoolDir('writeback'));
  const strayDirs = listDirsIn(paths.backups).filter((d) => !BACKUP_POOLS.includes(path.basename(d)));
  const straySize = strayDirs.reduce((sum, d) => sum + dirSizeBytes(d), 0);
  const details = [];
  if (fullDirs.length > MAX_FULL_BACKUPS) details.push(`full 池超限（${fullDirs.length} > ${MAX_FULL_BACKUPS}），下次备份会自动裁剪`);
  if (wbDirs.length > MAX_BACKUPS) details.push(`writeback 池超限（${wbDirs.length} > ${MAX_BACKUPS}），下次备份会自动裁剪`);
  if (strayDirs.length > 0) {
    details.push(
      `池外遗留目录（池管理之外，不参与限额淘汰，示例 ≤${DOCTOR_EXAMPLE_LIMIT}）: ${strayDirs.slice(0, DOCTOR_EXAMPLE_LIMIT).map((d) => path.basename(d)).join(', ')}`,
    );
    details.push('确认无回滚价值后可人工清理（doctor 只报告，绝不代删）');
  }
  const anyIssue = fullDirs.length > MAX_FULL_BACKUPS || wbDirs.length > MAX_BACKUPS || strayDirs.length > 0;
  return makeCheck(
    'backups',
    '备份池',
    anyIssue ? 'warn' : 'ok',
    `full 池 ${fullDirs.length}/${MAX_FULL_BACKUPS}、writeback 池 ${wbDirs.length}/${MAX_BACKUPS}、池外遗留 ${strayDirs.length} 个（共 ${formatBytes(straySize)}）`,
    details,
    {
      fullCount: fullDirs.length,
      fullLimit: MAX_FULL_BACKUPS,
      writebackCount: wbDirs.length,
      writebackLimit: MAX_BACKUPS,
      strayCount: strayDirs.length,
      strayBytes: straySize,
      strayExamples: strayDirs.slice(0, DOCTOR_EXAMPLE_LIMIT),
    },
  );
}

// ---------------------------------------------------------------------------
// 7. 锁状态
// ---------------------------------------------------------------------------

/**
 * 锁状态：扫描 state/*.lock（含全局写回锁 write.lock），逐把检查持有者 pid 存活
 * 与心跳（mtime）新鲜度。持有者已死或心跳超 LOCK_STALE_MS → ⚠️（withLock 会自动清理，
 * doctor 只报告不代清）。
 * @returns {Object} 检查结果
 */
export function checkLocks() {
  let lockFiles = [];
  try {
    lockFiles = fs
      .readdirSync(paths.state)
      .filter((n) => n.endsWith('.lock'))
      .map((n) => path.join(paths.state, n));
  } catch {
    // state 目录不存在：无锁
  }
  const locks = [];
  for (const file of lockFiles) {
    let pid = null;
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(info?.pid)) pid = info.pid;
    } catch {
      // 内容不可读：pid 未知
    }
    let ageMs = null;
    try {
      ageMs = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue; // 恰好被释放：跳过
    }
    const alive = isPidAlive(pid);
    const heartbeatFresh = ageMs <= LOCK_STALE_MS;
    locks.push({ file, pid, alive, ageMs: Math.round(ageMs), heartbeatFresh, stale: !alive || !heartbeatFresh });
  }
  const staleLocks = locks.filter((l) => l.stale);
  const details = locks.map(
    (l) =>
      `${path.basename(l.file)}: 持有者 pid ${l.pid ?? '未知'}（${l.alive ? '存活' : '已退出'}），心跳 ${Math.round(l.ageMs / 1000)}s 前（${l.heartbeatFresh ? '新鲜' : `超 ${Math.round(LOCK_STALE_MS / 1000)}s 陈旧`}）`,
  );
  if (staleLocks.length > 0) details.push('陈旧锁由下一次 withLock 抢锁时自动清理，doctor 不代清');
  const summary =
    locks.length === 0
      ? '无锁文件（空闲）'
      : staleLocks.length > 0
        ? `发现 ${staleLocks.length}/${locks.length} 把陈旧锁（持有者已退出或心跳过期）`
        : `${locks.length} 把锁在持（持有者存活、心跳新鲜，属正常运行）`;
  return makeCheck('locks', '锁状态', staleLocks.length > 0 ? 'warn' : 'ok', summary, details, {
    lockCount: locks.length,
    staleCount: staleLocks.length,
    locks,
  });
}

// ---------------------------------------------------------------------------
// 8. 测试污染探测
// ---------------------------------------------------------------------------

/**
 * 测试污染：wiki 中含 TEST_MARKERS（HUB-TEST/冒烟测试 等）的页面清单。
 * 污染页会经写回扩散到各 App，因此计 ❌（清理属后续数据任务，doctor 只探测）。
 * @returns {Object} 检查结果
 */
export function checkTestMarkers() {
  const polluted = [];
  for (const file of listWikiPages()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // 全文（frontmatter + 正文）匹配任一测试标记即视为污染
    if (hasTestMarker({ title: '', body: raw })) {
      polluted.push(path.relative(storePaths.wiki, file));
    }
  }
  const details =
    polluted.length > 0
      ? [
          `污染页面（≤${DOCTOR_EXAMPLE_LIMIT}）: ${polluted.slice(0, DOCTOR_EXAMPLE_LIMIT).join(', ')}`,
          `标记清单: ${TEST_MARKERS.join(' / ')}（这些页面会经写回扩散到各 App，建议尽快清理）`,
        ]
      : [];
  return makeCheck(
    'test-markers',
    '测试污染',
    polluted.length > 0 ? 'fail' : 'ok',
    polluted.length > 0 ? `发现 ${polluted.length} 个含测试标记的 wiki 页面` : '未发现测试标记污染',
    details,
    { pollutedCount: polluted.length, pollutedPages: polluted.slice(0, DOCTOR_EXAMPLE_LIMIT) },
  );
}

// ---------------------------------------------------------------------------
// 9. tombstone 删除传播（MUST-2 安全阀可观测性）
// ---------------------------------------------------------------------------

/**
 * tombstone 检查：三态统计（待 wiki 标记 / 待写回清理 / 已闭环）、suspectedStorm
 * 风暴标记数、长期未闭环（>7 天）数；autoPropagate 关闭时提示待确认删除数。
 * 风暴标记或长期未闭环 → ⚠️（处置需 hub tombstone 命令，doctor 只报告）。
 * @returns {Object} 检查结果
 */
export function checkTombstones() {
  const { tombstones } = loadTombstones();
  const entries = Object.entries(tombstones || {});
  const config = readConfigReadonly();
  const autoPropagate = config.tombstone?.autoPropagate === true;
  let pendingWiki = 0;
  let pendingApps = 0;
  let closed = 0;
  let storm = 0;
  let stale = 0;
  const now = Date.now();
  for (const [, t] of entries) {
    if (!t.wikiApplied) pendingWiki += 1;
    else if (!t.appsCleaned) pendingApps += 1;
    else closed += 1;
    if (t.suspectedStorm === true) storm += 1;
    const deletedTs = Date.parse(t.deletedAt);
    if ((!t.wikiApplied || !t.appsCleaned) && Number.isFinite(deletedTs) && now - deletedTs > TOMBSTONE_STALE_MS) {
      stale += 1;
    }
  }
  const pending = pendingWiki + pendingApps;
  const details = [];
  if (!autoPropagate && pending > 0) {
    details.push(
      `有 ${pending} 条待确认的删除（tombstone.autoPropagate=false，不会自动传播）：hub tombstone list 查看，hub tombstone apply 显式执行`,
    );
  }
  if (storm > 0) {
    details.push(`${storm} 条带 suspectedStorm 风暴标记（自动传播跳过）：误登记用 hub tombstone drop --all-storm 撤销，真删除用 hub tombstone apply 确认`);
  }
  if (stale > 0) {
    details.push(`${stale} 条登记超过 7 天仍未闭环（删除传播链路可能卡住或等待人工确认）`);
  }
  const level = storm > 0 || stale > 0 ? 'warn' : 'ok';
  return makeCheck(
    'tombstones',
    '删除传播',
    level,
    entries.length === 0
      ? '无 tombstone 登记'
      : `待 wiki 标记 ${pendingWiki} / 待写回清理 ${pendingApps} / 已闭环 ${closed}；风暴标记 ${storm}，超 7 天未闭环 ${stale}（autoPropagate=${autoPropagate ? 'on' : 'off'}）`,
    details,
    { total: entries.length, pendingWiki, pendingApps, closed, suspectedStorm: storm, staleCount: stale, autoPropagate },
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 执行全部健康度检查（纯只读）。
 * @returns {{ generatedAt: string, root: string, hub: string,
 *   checks: Object[], counts: { ok: number, warn: number, fail: number }, ok: boolean }}
 *   ok=false（存在 ❌）时调用方应以非零码退出
 */
export function runDoctor() {
  const state = loadDistillState();
  const checks = [
    checkIndex(),
    checkDuplicateTitles(),
    checkQuarantine(state),
    checkBacklog(state),
    checkWriteback(),
    checkBackups(),
    checkLocks(),
    checkTestMarkers(),
    checkTombstones(),
  ];
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.level] += 1;
  return {
    generatedAt: new Date().toISOString(),
    root: paths.root,
    hub: paths.hub,
    checks,
    counts,
    ok: counts.fail === 0,
  };
}

/**
 * 把 runDoctor 报告格式化为人类可读文本（✅/⚠️/❌ 分级）。
 * @param {Object} report runDoctor 返回值
 * @returns {string}
 */
export function formatDoctorReport(report) {
  const lines = [];
  lines.push('════════ Memory Hub 健康度报告（hub doctor，纯只读）════════');
  lines.push(`数据根目录: ${report.root}　中转站: ${report.hub}`);
  lines.push('');
  for (const c of report.checks) {
    lines.push(`${LEVEL_ICONS[c.level]} 【${c.name}】${c.summary}`);
    for (const d of c.details || []) lines.push(`     - ${d}`);
  }
  lines.push('');
  const { ok, warn, fail } = report.counts;
  const verdict = fail > 0 ? '存在异常项，建议尽快处理' : warn > 0 ? '有告警项，建议关注' : '一切正常';
  lines.push(`结论: ✅ ${ok} 项正常 / ⚠️ ${warn} 项告警 / ❌ ${fail} 项异常 —— ${verdict}`);
  return lines.join('\n');
}
