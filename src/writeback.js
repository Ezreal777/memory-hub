/**
 * writeback.js —— 并行写回引擎（hub writeback）。
 *
 * 数据流：hub/wiki/ 整理后的页面（或 --from-sources 直接用 sources 快照透传）
 *   → 转换为统一 Entry → 各适配器 render/write（每 App 内串行）。
 *
 * 调度与安全：
 * - 跨 App 并行（Promise.allSettled），单 App 失败不影响其他（适配器隔离熔断）；
 * - 批次门禁：batch:3 适配器在 config.writeback.batch3Enabled=false 时跳过，
 *   --force-batch3 可临时放行；
 * - apps[].readOnly=true（或 notes 含 readOnly）的 App 只读不写回；
 * - 每条写回输出「何时生效」说明；
 * - H4 增量写回：默认消费 state/pending-writeback.json（distill 侧每轮成功后写入），
 *   只渲染/写回其中列出的页面；全部启用 app 写回成功后原子清空（tmp+rename）；
 *   文件不存在/为空时降级全量并记日志；{ full: true } 强制全量广播；
 * - M8 写后校验纳入生产管线：每个 App 写后调用 adapter.verify()，失败则按备份
 *   整体回滚本批写入并标记 failed（带具体原因）；
 * - 失败原因落 logs/writeback.log（异常消息/路径/备份目录，供用户自助排障）；
 * - 写回记录落 hub/state/writeback-log.json（时间/app/hub-id/结果/备份目录），
 *   供 rollback 与 status 使用；M5 轮转：JSONL 纯追加，保留最近 2000 条，
 *   超体积上限才全量重写裁剪；dry-run 不落盘、不记日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadConfig } from './config.js';
import { storePaths, loadTombstones, updateTombstones } from './hub-store.js';
import { atomicWrite, rollbackByManifest } from './safe-write.js';
import { paths, ensureDir, FILE_MODE } from './util/paths.js';
import { withLock } from './util/lock.js';
import { appendLogEntry } from './util/log.js';
import { createAdapters, ADAPTER_BATCHES } from './adapters/registry.js';
import { stripHubIdBlocks } from './distill.js';

/** 各 App「何时生效」说明（每条写回输出时附带） */
export const EFFECT_NOTES = {
  claude: '何时生效：直接加载型，新会话启动即加载',
  codex: '何时生效：直接加载型，新会话启动即加载',
  wukong: '何时生效：直接加载型，新会话启动即加载（注意云端同步覆盖风险）',
  qoder: '何时生效：索引型，知识中心面板收录后近实时生效',
  qoderwork: '何时生效：索引型，需 QoderWork 新会话对账或手动重建搜索索引后可被检索',
};

/** batch:3 门禁未开启时的固定提示 */
export const BATCH3_GATE_MSG = '跳过（高风险批次未开启，--force-batch3 可临时启用）';

/** 写回日志路径：hub/state/writeback-log.json */
export function writebackLogPath() {
  return path.join(storePaths.state, 'writeback-log.json');
}

/** M5 轮转：writeback-log 最多保留条数 */
export const WRITEBACK_LOG_MAX_RECORDS = 2000;

/** M5 轮转：超过该体积才触发全量重写裁剪（平时纯追加，避免每次全量读写） */
export const WRITEBACK_LOG_REWRITE_BYTES = 512 * 1024;

/** 写回诊断日志：logs/writeback.log（失败原因/增量降级等，供用户自助排障） */
export function writebackDiagLogPath() {
  return path.join(paths.logs, 'writeback.log');
}

/**
 * 追加一条写回诊断日志（含时间戳/级别；复用 util/log 的滚动轮转与桌面镜像）。
 * @param {string} level info|warn|error
 * @param {string} msg 日志正文
 */
function logWriteback(level, msg) {
  appendLogEntry(writebackDiagLogPath(), `[${new Date().toISOString()}] [${level}] ${msg}`);
}

/** 增量写回清单路径：state/pending-writeback.json（distill 侧每轮成功后写入/合并） */
export function pendingWritebackPath() {
  return path.join(paths.state, 'pending-writeback.json');
}

/**
 * 读取增量写回清单（H4）。契约（与 distill 侧逐字一致）：
 * {"updatedAt":"<ISO>","pages":[{"path":"<wiki文件名如 foo.md>","hubIds":["hub-..."]}]}
 * @returns {{ updatedAt: string, pages: { path: string, hubIds: string[] }[] }|null}
 *   文件不存在/损坏/结构不符时返回 null（调用方降级全量）
 */
export function loadPendingWriteback() {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingWritebackPath(), 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.pages)) return raw;
  } catch {
    // 不存在或损坏：降级全量
  }
  return null;
}

/**
 * 原子清空增量清单（tmp+rename；文件不存在时为无操作）。
 * 仅在「本轮全部启用 app 写回成功」后由 runWriteback 调用。
 * MUST-1：与 distill 侧 appendPendingWriteback 共用同一把锁（pending-writeback.json.lock），
 * 消费-清空与生产-合并互斥；传入 expectedUpdatedAt 时锁内比对——若文件已被
 * distill 在本轮写回窗口内更新（updatedAt 不一致）则不清空，保留新登记的页面
 * 供下轮消费，确保「清空的只能是本轮读到并消费过的那份」。
 * @param {string} [expectedUpdatedAt] 本轮消费的清单 updatedAt；缺省无条件清空（兼容旧调用）
 * @returns {boolean} true 已清空（或文件不存在）；false 清单已被更新而跳过清空
 */
export function clearPendingWriteback(expectedUpdatedAt) {
  const file = pendingWritebackPath();
  if (!fs.existsSync(file)) return true;
  return withLock(file, () => {
    if (expectedUpdatedAt !== undefined) {
      const cur = loadPendingWriteback();
      if (cur && cur.updatedAt !== expectedUpdatedAt) {
        logWriteback(
          'warn',
          `pending-writeback.json 在写回窗口内被更新（updatedAt=${cur.updatedAt}），保留新增页面不清空`,
        );
        return false;
      }
    }
    atomicWrite(
      file,
      `${JSON.stringify({ updatedAt: new Date().toISOString(), pages: [] }, null, 2)}\n`,
      { mode: FILE_MODE },
    );
    return true;
  });
}

/**
 * 全局写回锁路径：~/.memory-hub/state/write.lock（H2 修复）。
 * daemon 与 CLI 的 runWriteback 真实写入段全部持此锁，
 * 避免两个进程同时对同一 App 记忆文件做「读全文→合并→替换」互相吞内容。
 * RV-O1：实际锁文件就叫 state/write.lock（lockPathFor 对 .lock 结尾的目标不追加双后缀）。
 * @returns {string}
 */
export function writeLockPath() {
  return path.join(paths.state, 'write.lock');
}

/**
 * 读取写回日志（数组）；不存在/损坏时返回空数组。
 * M5：兼容两种格式——旧版 JSON 数组（整文件一个数组）与新版 JSONL（每行一条，
 * 支持纯追加）；旧格式在下次追加时自动迁移为 JSONL。
 * @returns {Object[]}
 */
export function loadWritebackLog() {
  let raw;
  try {
    raw = fs.readFileSync(writebackLogPath(), 'utf8');
  } catch {
    return []; // 首次运行：空日志
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    // 旧版 JSON 数组格式
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr;
    } catch {
      // 损坏：空日志
    }
    return [];
  }
  const out = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // 半行损坏：跳过单条，不影响其余
    }
  }
  return out;
}

/** 把记录数组序列化为 JSONL 文本（每行一条） */
function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * 追加写回日志记录（跨进程锁内执行，600 权限）。
 * H1：整个追加过程套跨进程锁，daemon 与 CLI 并发写回不再丢日志条目。
 * M5：JSONL 纯追加（O(新增条数)，不再每次全量读写）；仅当文件超过体积上限才
 * 全量重写裁剪到最近 maxRecords 条；旧版 JSON 数组格式首次追加时自动迁移。
 * @param {Object[]} records { time, app, hubId, result, backupDir }[]
 * @param {{ maxRecords?: number, rewriteBytes?: number }} [opts] 轮转阈值（测试可注入小值）
 */
export function appendWritebackLog(records, opts = {}) {
  if (!Array.isArray(records) || records.length === 0) return;
  const maxRecords = opts.maxRecords ?? WRITEBACK_LOG_MAX_RECORDS;
  const rewriteBytes = opts.rewriteBytes ?? WRITEBACK_LOG_REWRITE_BYTES;
  const file = writebackLogPath();
  withLock(file, () => {
    let legacy = false;
    try {
      legacy = fs.readFileSync(file, 'utf8').trimStart().startsWith('[');
    } catch {
      // 文件不存在：直接走 JSONL 追加
    }
    if (legacy) {
      // 旧版 JSON 数组 → 一次性迁移为 JSONL 并裁剪
      const log = [...loadWritebackLog(), ...records].slice(-maxRecords);
      atomicWrite(file, toJsonl(log), { mode: FILE_MODE });
      return;
    }
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, toJsonl(records), { mode: FILE_MODE });
    try {
      if (fs.statSync(file).size > rewriteBytes) {
        atomicWrite(file, toJsonl(loadWritebackLog().slice(-maxRecords)), { mode: FILE_MODE });
      }
    } catch {
      // 裁剪失败不影响主流程，下次追加重试
    }
  });
}

/** 去掉正文首个 `# 一级标题` 行（各 App 渲染时会自带标题，避免重复） */
function stripFirstH1(body) {
  const lines = String(body || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (idx !== -1) lines.splice(idx, 1);
  return lines.join('\n').trim();
}

/** 递归列出 wiki/ 下的 .md 页面（跳过 README.md 与隐藏文件） */
function listWikiPages() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') out.push(full);
    }
  };
  walk(storePaths.wiki);
  return out.sort();
}

/**
 * 把 wiki 页面转换为统一 Entry（hubIds 取 frontmatter `hub-id`，主 hubId 取首个）。
 * @returns {Object[]} Entry[]
 */
export function wikiToEntries() {
  const entries = [];
  for (const page of listWikiPages()) {
    let content;
    try {
      content = fs.readFileSync(page, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = matter(content);
    } catch {
      continue;
    }
    const fm = parsed.data || {};
    if (fm.deleted === true) continue; // 删除传播：整页已标 tombstone，不再写回
    const rawIds = fm['hub-id'];
    const hubIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
    if (hubIds.length === 0) continue; // 无 hub-id 归属的页面无法做幂等写回
    const titleMatch = String(parsed.content || '').match(/^#\s+(.*)$/m);
    const title = String(titleMatch ? titleMatch[1] : fm.title || path.basename(page, '.md')).trim();
    entries.push({
      hubId: hubIds[0],
      hubIds,
      app: 'wiki',
      file: page,
      title,
      body: stripFirstH1(parsed.content),
      frontmatter: {
        category: fm.category,
        keywords: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
        usage_scenario: fm['usage-scenario'] || fm.usage_scenario,
      },
      mtime: 0,
      sha256: '',
    });
  }
  return entries;
}

/**
 * 直接用 sources 快照构建 Entry（--from-sources 透传测试模式）。
 * @returns {Object[]} Entry[]
 */
export function sourcesToEntries() {
  const entries = [];
  let apps;
  try {
    apps = fs.readdirSync(storePaths.sources, { withFileTypes: true });
  } catch {
    return entries;
  }
  const files = [];
  for (const a of apps) {
    if (!a.isDirectory()) continue;
    let fsEntries;
    try {
      fsEntries = fs.readdirSync(path.join(storePaths.sources, a.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of fsEntries) {
      if (f.isFile() && f.name.endsWith('.md')) files.push(path.join(storePaths.sources, a.name, f.name));
    }
  }
  for (const file of files.sort()) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = matter(content);
      const hubId = String(parsed.data?.hubId || '');
      if (!hubId) continue;
      entries.push({
        hubId,
        hubIds: [hubId],
        app: String(parsed.data?.app || ''),
        file,
        title: String(parsed.data?.title || path.basename(file, '.md')).trim(),
        body: stripFirstH1(parsed.content),
        frontmatter: {},
        mtime: 0,
        sha256: '',
      });
    } catch {
      // 单文件损坏跳过，不影响其余
    }
  }
  return entries;
}

/**
 * 汇总单个 App 内逐条结果的整体状态（removed 视同 written：均为有效磁盘变更）。
 * @param {Object[]} results adapter.write / adapter.removeEntries 返回的合并数组
 * @returns {string} written / deferred / skipped
 */
function summarizeAppStatus(results) {
  const statuses = results.map((r) => r.status);
  if (statuses.includes('written') || statuses.includes('removed')) return 'written';
  if (statuses.includes('deferred')) return 'deferred';
  return 'skipped';
}

/**
 * 单个 App 的写回任务（批次门禁 → readOnly → dry-run 渲染 / 真实写入）。
 * @param {Object} adapter 适配器实例
 * @param {Object[]} entries Entry[]
 * @param {Object} opts runWriteback 选项透传
 * @param {Object} config 配置对象
 * @param {string[]} [removalIds] 删除传播：需从该 App 移除的 tombstoned hubId
 * @returns {Promise<Object>} App 级结果
 */
async function runAppWriteback(adapter, entries, opts, config, removalIds = []) {
  const batch = ADAPTER_BATCHES[adapter.id] || 1;
  const appCfg = (config.apps || []).find((a) => a.id === adapter.id) || {};

  // 只读配置：apps[].readOnly=true 或 notes 含 readOnly
  if (appCfg.readOnly === true || /read[-_ ]?only/i.test(String(appCfg.notes || ''))) {
    return { app: adapter.id, batch, status: 'skipped', reason: '已配置为只读（readOnly），不写回', entries: [] };
  }
  // 批次门禁：batch:3 默认禁用
  if (batch === 3 && !(config.writeback?.batch3Enabled === true || opts.forceBatch3 === true)) {
    return { app: adapter.id, batch, status: 'skipped', reason: BATCH3_GATE_MSG, entries: [] };
  }
  // dry-run：只打印 render 结果，不产生任何写入
  if (opts.dryRun) {
    const rendered = entries.map((e) => ({
      hubId: e.hubId,
      status: 'dry-run',
      title: e.title,
      render: adapter.render(e),
    }));
    return { app: adapter.id, batch, status: 'dry-run', effectNote: EFFECT_NOTES[adapter.id], entries: rendered };
  }

  // 删除传播：先移除 tombstoned 条目（removeEntries 内部走 备份→删除哨兵 inflight→删除），
  // 再写回本轮条目；适配器未实现 removeEntries（如只读型）则跳过
  let removalResults = [];
  if (removalIds.length > 0 && typeof adapter.removeEntries === 'function') {
    removalResults = await adapter.removeEntries(removalIds);
  }

  // 真实写入：适配器内部串行；write 内部已含 备份→inflight→原子写→verify→回滚
  // （entries 为空时跳过：codex.write([]) 会误建空标记区）
  const results = entries.length > 0 ? await adapter.write(entries, opts) : [];

  // M8：写后校验纳入生产管线——仅对本轮真正 written 的条目执行整体校验。
  // N3 按条目粒度回滚：适配器 verify 若返回 failedIds（如 qoder，客户端整理机制
  // 可能清理个别刚写入的文件），则只回滚失败条目并标记 deferred（下轮重试），
  // 同批其他成功条目不受连累；未返回 failedIds 的适配器保持原整批回滚语义。
  const writtenIds = new Set(results.filter((r) => r.status === 'written').map((r) => r.hubId));
  if (writtenIds.size > 0 && typeof adapter.verify === 'function') {
    const written = entries.filter((e) => writtenIds.has(e.hubId));
    let check;
    try {
      check = adapter.verify(written);
    } catch (err) {
      check = { ok: false, reasons: [`verify 抛出异常: ${err.message}`] };
    }
    if (!check.ok) {
      const failedIds = new Set(
        Array.isArray(check.failedIds) ? check.failedIds.filter((id) => writtenIds.has(id)) : [],
      );
      const rollbackErrors = [];
      if (failedIds.size > 0) {
        // 按条目粒度：只回滚失败条目对应的备份目录，失败条目降级 deferred 保留下轮重试
        for (const r of results) {
          if (r.status !== 'written' || !failedIds.has(r.hubId)) continue;
          if (r.backupDir) {
            try {
              rollbackByManifest(r.backupDir);
            } catch (err) {
              rollbackErrors.push(`回滚 ${r.backupDir} 失败: ${err.message}`);
            }
          }
          r.status = 'deferred';
          r.reason = '写回后校验未通过（目标文件被外部清理/篡改），已回滚该条，下轮重试';
        }
        const reasons = [...(check.reasons || []), ...rollbackErrors];
        logWriteback(
          'warn',
          `[${adapter.id}] 写后校验 ${failedIds.size} 条未通过（已按条目回滚并标记 deferred，其余 ${writtenIds.size - failedIds.size} 条保留）: ${reasons.join('; ')}`,
        );
      } else {
        // 无法定位具体失败条目：保守回退整批回滚
        const backupDirs = [
          ...new Set(results.map((r) => r.backupDir).filter(Boolean)),
        ];
        for (const dir of backupDirs) {
          try {
            rollbackByManifest(dir);
          } catch (err) {
            rollbackErrors.push(`回滚 ${dir} 失败: ${err.message}`);
          }
        }
        const reasons = [...(check.reasons || []), ...rollbackErrors];
        return {
          app: adapter.id,
          batch,
          status: 'failed',
          error: `写回后校验失败（已按备份回滚）: ${reasons.join('; ')}`,
          backupDirs,
          entries: results,
          ...(removalResults.length > 0 ? { removed: removalResults } : {}),
        };
      }
    }
  }

  return {
    app: adapter.id,
    batch,
    status: summarizeAppStatus([...results, ...removalResults]),
    effectNote: EFFECT_NOTES[adapter.id],
    entries: results,
    ...(removalResults.length > 0 ? { removed: removalResults } : {}),
  };
}

/**
 * 执行一次并行写回。
 * @param {{
 *   app?: string,          // 仅写回指定 app id
 *   dryRun?: boolean,      // 只打印 render 结果，不写盘
 *   entry?: string,        // 仅写回指定 hub-id（匹配条目的 hubIds 集合）
 *   fromSources?: boolean, // 数据源改用 sources 快照（透传测试）
 *   forceBatch3?: boolean, // 临时放行 batch:3 高风险批次
 *   full?: boolean,        // H4：强制全量广播（忽略 pending-writeback.json）
 *   forceTombstones?: boolean, // MUST-2：绕过 autoPropagate 开关与 suspectedStorm 过滤，强制执行删除传播（hub tombstone apply 用）
 *   removalsOnly?: boolean, // MUST-2：只做 tombstone 移除不写回任何条目（hub tombstone apply 用）
 *   lockTimeoutMs?: number, // SHOULD-6：全局写锁抢锁超时；缺省 120s（CLI 交互命令传 30s）
 *   config?: Object,       // 配置；缺省 loadConfig()
 *   adapters?: Object[],   // 可注入适配器数组（测试用）
 * }} [opts]
 * @returns {Promise<{ ok: boolean, mode?: string, entryCount: number, appResults: Object[], logPath?: string }>}
 */
export async function runWriteback(opts = {}) {
  const config = opts.config || loadConfig();
  let adapters = opts.adapters || createAdapters(config);
  if (opts.app) {
    adapters = adapters.filter((a) => a.id === opts.app);
    if (adapters.length === 0) {
      return {
        ok: false,
        entryCount: 0,
        appResults: [],
        error: `没有可写回的适配器 "${opts.app}"（未启用、memory_paths 为空或 id 不存在）`,
      };
    }
  }

  let entries = opts.fromSources ? sourcesToEntries() : wikiToEntries();
  if (opts.entry) {
    entries = entries.filter(
      (e) => (Array.isArray(e.hubIds) && e.hubIds.includes(opts.entry)) || e.hubId === opts.entry,
    );
  }

  // 删除传播：tombstoned hubId 一律不渲染写回（即使 wiki 尚未标记也先过滤）；
  // 尚未 appsCleaned 的 tombstone 本轮顺带做一次 App 侧移除（dry-run 不动盘）
  let tombstones = {};
  try {
    tombstones = loadTombstones().tombstones || {};
  } catch {
    tombstones = {};
  }
  const tombSet = new Set(Object.keys(tombstones));
  if (tombSet.size > 0) {
    entries = entries
      .map((e) => {
        const ids = Array.isArray(e.hubIds) && e.hubIds.length > 0 ? e.hubIds : [e.hubId];
        const kept = ids.filter((id) => !tombSet.has(id));
        if (kept.length === 0) return null;
        if (kept.length === ids.length) return e;
        // 部分 tombstone：除收窄 hubIds 外，同步剔除正文中被删条目的标记块，
        // 避免已删内容随存活条目重新渲染回各 App
        const gone = ids.filter((id) => tombSet.has(id));
        return { ...e, hubId: kept[0], hubIds: kept, body: stripHubIdBlocks(e.body, gone) };
      })
      .filter(Boolean);
  }
  const removalIds = opts.dryRun ? [] : computeRemovalIds();

  /**
   * MUST-2 删除传播安全阀：
   * - config.tombstone.autoPropagate=false（保守默认）时不做 removeEntries，
   *   仅记日志提示待确认数（证据链仍在 tombstones.json，由 hub tombstone apply 显式执行）；
   * - 开启自动传播时，跳过 suspectedStorm（风暴熔断标记）条目，需人工确认；
   * - opts.forceTombstones（hub tombstone apply）绕过开关与风暴过滤。
   */
  function computeRemovalIds() {
    const pendingRemoval = [...tombSet].filter((id) => !tombstones[id].appsCleaned);
    if (pendingRemoval.length === 0) return [];
    const propagate = opts.forceTombstones === true || config.tombstone?.autoPropagate === true;
    if (!propagate) {
      logWriteback(
        'info',
        `有 ${pendingRemoval.length} 条待确认的删除（tombstone.autoPropagate=false），运行 hub tombstone apply 显式执行传播`,
      );
      return [];
    }
    const ids = opts.forceTombstones === true
      ? pendingRemoval
      : pendingRemoval.filter((id) => tombstones[id].suspectedStorm !== true);
    const stormSkipped = pendingRemoval.length - ids.length;
    if (stormSkipped > 0) {
      logWriteback(
        'warn',
        `跳过 ${stormSkipped} 条疑似删除风暴（suspectedStorm）的 tombstone 自动传播，需 hub tombstone apply 人工确认`,
      );
    }
    return ids;
  }

  // MUST-2：removalsOnly 模式（hub tombstone apply）只做移除，不写回任何条目
  if (opts.removalsOnly) entries = [];

  // H4 增量写回：默认（非 full / 非定向 CLI 操作）消费 pending-writeback.json，
  // 只写回其中列出的页面；文件不存在/为空时降级全量并记一条日志。
  const incrementalEligible = !opts.full && !opts.fromSources && !opts.app && !opts.entry && !opts.removalsOnly;
  let incremental = false;
  let pendingUpdatedAt; // MUST-1：记住本轮消费的清单版本，清空时比对防误清 distill 新增页面
  if (incrementalEligible) {
    const pending = loadPendingWriteback();
    if (!pending || pending.pages.length === 0) {
      logWriteback('info', 'pending-writeback.json 不存在或为空，降级全量写回');
    } else {
      incremental = true;
      pendingUpdatedAt = pending.updatedAt;
      const wanted = new Set(pending.pages.map((p) => String(p.path)));
      // SHOULD-4 路径匹配收紧：basename 匹配仅对 wiki 根目录顶层文件生效，
      // 子目录页面只认相对 wiki 根的精确路径（防子目录同名碰撞）
      entries = entries.filter((e) => {
        if (wanted.has(path.relative(storePaths.wiki, e.file))) return true;
        return path.dirname(e.file) === storePaths.wiki && wanted.has(path.basename(e.file));
      });
      if (entries.length === 0 && removalIds.length === 0) {
        // 清单页面已全部不存在（被删除/重命名）：清空防死循环（updatedAt 不一致时保留新增页面）
        const cleared = opts.dryRun ? false : clearPendingWriteback(pendingUpdatedAt);
        return {
          ok: true,
          mode: 'incremental',
          entryCount: 0,
          appResults: [],
          message: cleared
            ? '增量清单中的页面已不存在，已清空 pending-writeback.json'
            : '增量清单中的页面已不存在（清单已被更新，保留新增页面）',
        };
      }
    }
  }

  if (entries.length === 0 && removalIds.length === 0) {
    return {
      ok: true,
      mode: incremental ? 'incremental' : 'full',
      entryCount: 0,
      appResults: [],
      message: opts.fromSources
        ? 'sources/ 中没有可透传的快照条目'
        : 'wiki/ 中没有可写回的页面（先运行 hub distill，或用 --from-sources 透传 sources）',
    };
  }

  // H2：真实写入段持全局跨进程写锁（state/write.lock，daemon 与 CLI 共用），
  // 避免与 App/用户的并发写入在「读→合并→替换」间隙互相吞内容；dry-run 无写入不加锁。
  // SHOULD-6：CLI 交互命令可传较短 lockTimeoutMs（如 30s），缺省仍为 120s（daemon 内部）。
  const appResults = opts.dryRun
    ? await doWritebackPass()
    : await withLock(writeLockPath(), () => doWritebackPass(), { timeoutMs: opts.lockTimeoutMs });

  // 写回日志（dry-run 不记录）
  if (!opts.dryRun) {
    const records = [];
    const now = () => new Date().toISOString();
    for (const r of appResults) {
      if (r.status === 'skipped') {
        // Bug#5 修复：App 级无 reason 时（幂等跳过等）从逐条结果里汇总原因，
        // 绝不让日志出现 "skipped: undefined"
        const entryReasons = [
          ...new Set((r.entries || []).map((e) => e.reason).filter(Boolean)),
        ];
        const reason = r.reason || (entryReasons.length > 0 ? entryReasons.join('; ') : '内容无变化或已写入（幂等跳过）');
        records.push({ time: now(), app: r.app, hubId: '*', result: `skipped: ${reason}`, backupDir: null });
      } else if (r.status === 'failed') {
        records.push({ time: now(), app: r.app, hubId: '*', result: `failed: ${r.error}`, backupDir: null });
      } else {
        for (const er of [...(r.entries || []), ...(r.removed || [])]) {
          // 逐条记录附带 reason（如 skipped/deferred 的具体原因），便于 status 展示
          const result = er.reason ? `${er.status}: ${er.reason}` : er.status;
          records.push({
            time: now(),
            app: r.app,
            hubId: er.hubId || '*',
            result,
            backupDir: er.backupDir || null,
          });
        }
      }
    }
    if (records.length > 0) appendWritebackLog(records);

    // 失败原因落诊断日志（异常消息/备份目录/堆栈首行，供用户自助排障）
    for (const r of appResults) {
      if (r.status !== 'failed') continue;
      const parts = [`[${r.app}] 写回失败: ${r.error}`];
      if (Array.isArray(r.backupDirs) && r.backupDirs.length > 0) {
        parts.push(`备份目录: ${r.backupDirs.join(', ')}`);
      }
      if (r.errorStack) parts.push(`堆栈: ${String(r.errorStack).split('\n').slice(0, 3).join(' | ')}`);
      logWriteback('error', parts.join(' —— '));
    }

    // H4：全部启用 app 写回成功（无 failed 且无 deferred 条目）才清空增量清单，
    // 否则保留下一轮重试（skipped 视为成功——幂等/门禁跳过不阻塞清空）。
    // MUST-1：传入本轮消费的 updatedAt，若 distill 在写回窗口内已合并新页面则不清空。
    if (incremental) {
      const allOk = appResults.every(
        (r) => r.status !== 'failed' && !(r.entries || []).some((e) => e.status === 'deferred'),
      );
      if (allOk) {
        clearPendingWriteback(pendingUpdatedAt);
      } else {
        logWriteback('warn', '本轮存在 failed/deferred，保留 pending-writeback.json 供下轮重试');
      }
    }

    // 删除传播：全量 App 均完成移除（无 failed、无 removed deferred）才打 appsCleaned 点；
    // 定向 --app 不打点（其余 App 尚未清理，下轮全量写回时重试）
    if (removalIds.length > 0 && !opts.app) {
      const removalOk = appResults.every(
        (r) => r.status !== 'failed' && !(r.removed || []).some((e) => e.status === 'deferred'),
      );
      if (removalOk) {
        try {
          updateTombstones(removalIds, { appsCleaned: new Date().toISOString() });
        } catch (err) {
          logWriteback('warn', `tombstone appsCleaned 打点失败（下轮重试）: ${err.message}`);
        }
      } else {
        logWriteback('warn', '删除传播存在 failed/deferred，保留 tombstone 供下轮重试移除');
      }
    }
  }

  return {
    ok: appResults.some((r) => ['written', 'dry-run'].includes(r.status)),
    mode: incremental ? 'incremental' : 'full',
    entryCount: entries.length,
    appResults,
    logPath: opts.dryRun ? undefined : writebackLogPath(),
  };

  /** 跨 App 并行、单 App 失败隔离熔断（Promise.allSettled） */
  async function doWritebackPass() {
    const settled = await Promise.allSettled(
      adapters.map((adapter) => runAppWriteback(adapter, entries, opts, config, removalIds)),
    );
    return settled.map((s, i) => {
      const adapter = adapters[i];
      if (s.status === 'rejected') {
        return {
          app: adapter.id,
          batch: ADAPTER_BATCHES[adapter.id] || 1,
          status: 'failed',
          error: s.reason?.message || String(s.reason),
          errorStack: s.reason?.stack,
          backupDirs: s.reason?.backupDir ? [s.reason.backupDir] : [],
          entries: [],
        };
      }
      return s.value;
    });
  }
}

/**
 * 把写回结果格式化为人类可读摘要（CLI 输出用）。
 * @param {Object} result runWriteback 返回值
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {string}
 */
export function formatWritebackSummary(result, opts = {}) {
  const lines = [];
  // SHOULD-7：明确打印写回模式（incremental|full）与本轮条目数
  if (result.mode) lines.push(`📦 mode: ${result.mode}，条目数: ${result.entryCount ?? 0}`);
  if (result.error) lines.push(`❌ ${result.error}`);
  if (result.message) lines.push(`ℹ️ ${result.message}`);
  for (const r of result.appResults || []) {
    const icon = r.status === 'written' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'dry-run' ? '🧪' : '⏭️';
    lines.push(`${icon} [${r.app}] (batch:${r.batch}) ${r.status}${r.reason ? ` —— ${r.reason}` : ''}${r.error ? ` —— ${r.error}` : ''}`);
    if (r.effectNote && (r.status === 'written' || r.status === 'dry-run')) {
      lines.push(`   ${r.effectNote}`);
    }
    for (const er of r.entries || []) {
      if (opts.dryRun || er.status === 'dry-run') {
        lines.push(`   --- ${er.hubId}${er.title ? ` · ${er.title}` : ''} 渲染结果 ---`);
        for (const l of String(er.render || '').split(/\r?\n/)) {
          lines.push(`   | ${l}`);
        }
        continue;
      }
      const target = Array.isArray(er.targets) ? er.targets.join(' + ') : '';
      lines.push(`   - ${er.hubId}: ${er.status}${er.reason ? `（${er.reason}）` : ''}${target ? ` → ${target}` : ''}`);
      if (er.note) lines.push(`     ⚠️ ${er.note}`);
    }
    for (const er of r.removed || []) {
      const target = Array.isArray(er.targets) ? er.targets.join(' + ') : '';
      lines.push(`   - ${er.hubId}: ${er.status}（删除传播）${target ? ` → ${target}` : ''}`);
    }
  }
  if (result.logPath) lines.push(`📝 写回日志: ${result.logPath}`);
  return lines.join('\n');
}
