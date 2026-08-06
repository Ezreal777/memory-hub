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
 * - 写回记录落 hub/state/writeback-log.json（时间/app/hub-id/结果/备份目录），
 *   供 rollback 与 status 使用；dry-run 不落盘、不记日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadConfig } from './config.js';
import { storePaths } from './hub-store.js';
import { atomicWrite } from './safe-write.js';
import { paths, FILE_MODE } from './util/paths.js';
import { withLock } from './util/lock.js';
import { createAdapters, ADAPTER_BATCHES } from './adapters/registry.js';

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

/**
 * 全局写回锁路径：~/.memory-hub/state/write.lock（H2 修复）。
 * daemon 与 CLI 的 runWriteback 真实写入段全部持此锁，
 * 避免两个进程同时对同一 App 记忆文件做「读全文→合并→替换」互相吞内容。
 * @returns {string}
 */
export function writeLockPath() {
  return path.join(paths.state, 'write.lock');
}

/**
 * 读取写回日志（数组）；不存在/损坏时返回空数组。
 * @returns {Object[]}
 */
export function loadWritebackLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(writebackLogPath(), 'utf8'));
    if (Array.isArray(raw)) return raw;
  } catch {
    // 首次运行或损坏：空日志
  }
  return [];
}

/**
 * 追加写回日志记录（原子写，600 权限）。
 * H1：整个「读-追加-写」套跨进程锁，daemon 与 CLI 并发写回不再丢日志条目。
 * @param {Object[]} records { time, app, hubId, result, backupDir }[]
 */
export function appendWritebackLog(records) {
  if (!Array.isArray(records) || records.length === 0) return;
  withLock(writebackLogPath(), () => {
    const log = loadWritebackLog();
    log.push(...records);
    atomicWrite(writebackLogPath(), `${JSON.stringify(log, null, 2)}\n`, { mode: FILE_MODE });
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
 * 汇总单个 App 内逐条结果的整体状态。
 * @param {Object[]} results adapter.write 返回
 * @returns {string} written / deferred / skipped
 */
function summarizeAppStatus(results) {
  const statuses = results.map((r) => r.status);
  if (statuses.includes('written')) return 'written';
  if (statuses.includes('deferred')) return 'deferred';
  return 'skipped';
}

/**
 * 单个 App 的写回任务（批次门禁 → readOnly → dry-run 渲染 / 真实写入）。
 * @param {Object} adapter 适配器实例
 * @param {Object[]} entries Entry[]
 * @param {Object} opts runWriteback 选项透传
 * @param {Object} config 配置对象
 * @returns {Promise<Object>} App 级结果
 */
async function runAppWriteback(adapter, entries, opts, config) {
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

  // 真实写入：适配器内部串行；write 内部已含 备份→inflight→原子写→verify→回滚
  const results = await adapter.write(entries, opts);
  return {
    app: adapter.id,
    batch,
    status: summarizeAppStatus(results),
    effectNote: EFFECT_NOTES[adapter.id],
    entries: results,
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
 *   config?: Object,       // 配置；缺省 loadConfig()
 *   adapters?: Object[],   // 可注入适配器数组（测试用）
 * }} [opts]
 * @returns {Promise<{ ok: boolean, entryCount: number, appResults: Object[], logPath?: string }>}
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
  if (entries.length === 0) {
    return {
      ok: true,
      entryCount: 0,
      appResults: [],
      message: opts.fromSources
        ? 'sources/ 中没有可透传的快照条目'
        : 'wiki/ 中没有可写回的页面（先运行 hub distill，或用 --from-sources 透传 sources）',
    };
  }

  // H2：真实写入段持全局跨进程写锁（state/write.lock，daemon 与 CLI 共用），
  // 避免与 App/用户的并发写入在「读→合并→替换」间隙互相吞内容；dry-run 无写入不加锁。
  const appResults = opts.dryRun
    ? await doWritebackPass()
    : await withLock(writeLockPath(), () => doWritebackPass());

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
        for (const er of r.entries || []) {
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
  }

  return {
    ok: appResults.some((r) => ['written', 'dry-run'].includes(r.status)),
    entryCount: entries.length,
    appResults,
    logPath: opts.dryRun ? undefined : writebackLogPath(),
  };

  /** 跨 App 并行、单 App 失败隔离熔断（Promise.allSettled） */
  async function doWritebackPass() {
    const settled = await Promise.allSettled(
      adapters.map((adapter) => runAppWriteback(adapter, entries, opts, config)),
    );
    return settled.map((s, i) => {
      const adapter = adapters[i];
      if (s.status === 'rejected') {
        return {
          app: adapter.id,
          batch: ADAPTER_BATCHES[adapter.id] || 1,
          status: 'failed',
          error: s.reason?.message || String(s.reason),
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
  }
  if (result.logPath) lines.push(`📝 写回日志: ${result.logPath}`);
  return lines.join('\n');
}
