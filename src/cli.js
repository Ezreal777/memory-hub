#!/usr/bin/env node
/**
 * cli.js —— Memory Hub CLI 入口（命令收口版）。
 *
 * 命令全集：
 *   hub init        首次引导（建目录 + 默认 config + scan + 下一步指引）
 *   hub config      查看（或惰性生成）当前配置
 *   hub scan        探测五个 App 的记忆位置并写回 config.json
 *   hub keys        Keychain 密钥管理（list / --sync / use <name>）
 *   hub watch       前台监听增量摄取
 *   hub index       重建主索引（rebuildMasterIndex：全量收录 + hub-id 回填）
 *   hub distill     LLM 整理 sources → wiki
 *   hub compact     wiki 全局归并：同主题近似页簇 LLM 归并为少数页（--dry-run 预览）
 *   hub writeback   wiki 并行写回各 App（默认增量；--full 全量；--repair 修复 codex 多标记区）
 *   hub doctor      健康度体检（纯只读，✅/⚠️/❌ 分级；--json 结构化输出）
 *   hub search      wiki 关键词检索（grep 级，多关键词 AND，大小写不敏感）
 *   hub tombstone   删除传播管理（list / apply [--dry-run] / drop；MUST-2 安全阀）
 *   hub backup      对全部已发现 app 的记忆文件做一次快照备份
 *   hub rollback    从备份目录原子恢复（二次确认，--yes 跳过）
 *   hub sync        单次全链路：harvest → distill → writeback（排障/验证）
 *   hub status      一屏汇总状态
 *   hub daemon …    launchd 守护：run/install/uninstall/start/stop/status
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { loadConfig } from './config.js';
import { paths, ensureHubDirs, ensureDir, FILE_MODE } from './util/paths.js';
import { scanApps, formatScanSummary } from './scan.js';
import { listKeys, syncKeys, useKey } from './keys.js';
import { Watcher } from './watcher.js';
import { createAdapters } from './adapters/registry.js';
import {
  ensureHubStore,
  harvest,
  storePaths,
  loadTombstones,
  removeTombstones,
} from './hub-store.js';
import { rebuildMasterIndex } from './index-builder.js';
import { repairFile } from './adapters/codex.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { searchWiki, formatSearchResults } from './search.js';
import { distill, loadDistillState, applyTombstones } from './distill.js';
import { compact } from './compact.js';
import {
  runWriteback,
  formatWritebackSummary,
  loadWritebackLog,
} from './writeback.js';
import {
  atomicWrite,
  createBackupDir,
  latestBackupDir,
  listBackupDirs,
  rollback,
  MAX_BACKUPS,
  MAX_FULL_BACKUPS,
} from './safe-write.js';
import {
  runDaemon,
  installDaemon,
  uninstallDaemon,
  startDaemon,
  stopDaemon,
  formatDaemonStatus,
  detectDaemonState,
  tailLines,
  LAUNCHD_LABEL,
} from './daemon.js';

/**
 * SHOULD-6：CLI 交互命令的抢锁超时（30s）。daemon 内部调用维持 withLock 默认 120s；
 * 交互场景等 30s 仍抢不到基本可判定锁被 daemon 长写回持有，尽快提示而非干等。
 */
export const CLI_LOCK_TIMEOUT_MS = 30 * 1000;

/**
 * 判断异常是否为抢锁超时，并给出面向用户的友好提示。
 * @param {Error} err
 * @returns {string|null} 是抢锁超时则返回提示文案，否则 null
 */
export function lockTimeoutHint(err) {
  return /抢锁超时/.test(String(err?.message || ''))
    ? '锁被 daemon 持有，请稍后再试（daemon 正在整理/写回，通常 1-2 分钟内完成）'
    : null;
}

const program = new Command();

program
  .name('hub')
  .description('Memory Hub —— AI App 记忆中转站')
  .version('0.1.0');

// 查看当前配置（首次执行会惰性生成默认 config.json）
program
  .command('config')
  .description('查看（或惰性生成）当前配置')
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
    console.error(`# 配置文件: ${paths.config} (权限 ${fs.statSync(paths.config).mode.toString(8)})`);
  });

// hub scan —— 探测五个 App 的记忆位置并写回 config.json（只读探测，幂等）
program
  .command('scan')
  .description('探测五个 App 的记忆位置并写回 config.json')
  .action(() => {
    const rows = scanApps();
    console.log(formatScanSummary(rows));
  });

// hub keys —— Keychain 密钥管理（list / --sync / use <name>）
const keysCmd = program
  .command('keys')
  .description('管理 LLM API Key（macOS Keychain，输出一律脱敏）')
  .option('--sync', '只读同步密钥来源到 Keychain（codex-openai / idealab / claude-anthropic）')
  .action((opts) => {
    if (opts.sync) {
      let results;
      try {
        results = syncKeys();
      } catch (err) {
        // 错误信息已在 keys.js 内部脱敏（不含密钥明文），这里只展示消息不打印堆栈
        console.error(`❌ 同步失败: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      if (results.length === 0) {
        console.log('未发现任何可同步的密钥来源（已检查 ~/.codex/auth.json、~/.zshrc、~/.zprofile）');
        return;
      }
      for (const r of results) {
        // L4：覆盖既有条目时明确提示，绝不静默覆盖
        console.log(
          r.overwritten
            ? `已覆盖既有条目 ${r.name}（来源: ${r.origin}，值: ${r.masked}）`
            : `已同步 ${r.name}（来源: ${r.origin}，值: ${r.masked}）`,
        );
      }
      console.log('提示: 用 hub keys use <name> 切换 config.llm.keyRef');
      return;
    }
    // 缺省行为：列出 Keychain 条目（脱敏）
    const entries = listKeys();
    if (entries.length === 0) {
      console.log('Keychain 中暂无 memory-hub 条目，可运行 hub keys --sync 同步');
      return;
    }
    for (const e of entries) {
      console.log(`${e.name}\t${e.masked}`);
    }
  });

keysCmd
  .command('list')
  .description('列出 Keychain 中 memory-hub 的条目（脱敏展示）')
  .action(() => {
    const entries = listKeys();
    if (entries.length === 0) {
      console.log('Keychain 中暂无 memory-hub 条目，可运行 hub keys --sync 同步');
      return;
    }
    for (const e of entries) {
      console.log(`${e.name}\t${e.masked}`);
    }
  });

keysCmd
  .command('use <name>')
  .description('切换 config.llm.keyRef 指向指定 Keychain 条目（可选一并配置 LLM 端点）')
  // M5：补齐 init 引导承诺的 llm.baseUrl / llm.model 配置入口（新增选项，向后兼容）
  .option('--base-url <url>', '同时落盘 config.llm.baseUrl（OpenAI 兼容端点）')
  .option('--model <model>', '同时落盘 config.llm.model')
  .action((name, opts) => {
    useKey(name, { baseUrl: opts.baseUrl, model: opts.model });
    const extra = [];
    if (opts.baseUrl) extra.push(`llm.baseUrl=${opts.baseUrl}`);
    if (opts.model) extra.push(`llm.model=${opts.model}`);
    console.log(
      `已将 llm.keyRef 切换为 "${name}"${extra.length > 0 ? `，并配置 ${extra.join('、')}` : ''}`,
    );
  });

// hub watch —— 前台监听全部已启用 App 的记忆目录，增量摄取到中转站（Ctrl-C 退出）
program
  .command('watch')
  .description('监听五个 App 的记忆目录并增量摄取到中转站（前台运行，Ctrl-C 退出）')
  .action(async () => {
    const config = loadConfig();
    const watcher = new Watcher(config);
    if (watcher.adapters.length === 0) {
      console.error('没有可监听的已启用 App（enabled=true 且 memory_paths 非空），请先运行 hub scan');
      process.exit(1);
    }
    watcher.start({ signals: true });
    console.log(`[watch] 已监听 ${watcher.allWatchPaths().length} 个路径：`);
    for (const adapter of watcher.adapters) {
      console.log(`  - ${adapter.id}: ${adapter.watchPaths().join(' ; ')}`);
    }
    console.log('[watch] debounce=%dms, poll=%dms。Ctrl-C 退出。', watcher.debounceMs, watcher.pollIntervalMs);
    // 前台常驻：watcher 的 persistent chokidar 已保持事件循环存活
  });

// hub index —— 重新生成 _index/master-index.md（扫 wiki/）
// H7 接线：改调 index-builder.rebuildMasterIndex（全量收录、头部计数用实际值、hub-id 回填）
program
  .command('index')
  .description('扫描 wiki/ 全量重建主索引 _index/master-index.md（含 hub-id 回填）')
  .action(() => {
    const p = rebuildMasterIndex();
    console.log(`已生成主索引: ${p}`);
  });

// hub distill —— LLM 整理：把 sources/ 未整理快照归并为 wiki 主题页
program
  .command('distill')
  .description('用 LLM 把 sources/ 中未整理的原始快照归并为 wiki 主题页（脱敏后落盘）')
  .option('--dry-run', '只打印将产生的页面变更，不落盘不改状态')
  .option('--max-pages <n>', '本次最多产出的 wiki 页数', (v) => parseInt(v, 10))
  .option('--max-batches <n>', '本次最多处理的批次数（每批一次 LLM 调用，剩余下轮继续）', (v) => parseInt(v, 10))
  .action(async (opts) => {
    let result;
    try {
      result = await distill({ dryRun: !!opts.dryRun, maxPages: opts.maxPages, maxBatches: opts.maxBatches });
    } catch (err) {
      // SHOULD-6：状态文件锁被 daemon 持有时给明确提示，而非裸抛堆栈
      const hint = lockTimeoutHint(err);
      console.error(hint ? `⚠️ ${hint}` : `⚠️ 整理失败: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      // LLM 失败优雅降级：sources 保留，下次重试
      const hint = lockTimeoutHint({ message: result.error });
      console.error(
        hint
          ? `⚠️ ${hint}`
          : `⚠️ 整理失败（sources 已保留，下次可重试）: ${result.error}`,
      );
      process.exitCode = 1;
      return;
    }
    if (result.pending === 0) {
      console.log(result.message || '没有待整理的原始快照');
      return;
    }
    if (result.dryRun) {
      console.log(`[dry-run] 待整理快照 ${result.pending} 条，将产生 ${result.pages.length} 个页面（不落盘）：`);
      for (const p of result.pages) {
        console.log(`  - wiki/${p.slug}.md · ${p.title}`);
        console.log(`    归并 hubId: ${p.hubIds.join(', ')}`);
        console.log(`    来源: ${p.sources.join(' ; ')}`);
      }
      return;
    }
    console.log(`✅ 整理完成：待整理 ${result.pending} 条，本次处理 ${result.batches}/${result.totalBatches} 批 → ${result.written.length} 个页面（归并 hubId ${result.processed} 个）`);
    for (const p of result.pages) {
      console.log(`  - wiki/${p.slug}.md · ${p.title}（${p.hubIds.length} 条归并）`);
    }
    if (result.error) {
      console.error(`⚠️ 部分批次失败（已完成批次不受影响，未处理快照下次重试）: ${result.error}`);
    }
    if (result.totalBatches > result.batches) {
      console.log(`ℹ️ 尚余 ${result.totalBatches - result.batches} 批未处理，再次执行 hub distill 或等 daemon 下轮继续`);
    }
    console.log(`主索引已更新: ${result.index}`);
  });

// ---------------------------------------------------------------------------
// hub compact —— wiki 全局归并：同主题近似页簇 LLM 归并为少数页
// ---------------------------------------------------------------------------
program
  .command('compact')
  .description('把 wiki 中同主题的近似重复页簇用 LLM 归并为少数页（输家页备份后删除，App 侧自动同步）')
  .option('--dry-run', '只打印聚类计划（哪些页会被归并），不调 LLM、不落盘')
  .option('--topic <key>', '定向只处理指定主题键（如 ab-test，试点验证用）')
  .option('--max-clusters <n>', '本轮最多处理的簇数（缺省读 config.compact.maxClustersPerRun）', (v) => parseInt(v, 10))
  .action(async (opts) => {
    let result;
    try {
      result = await compact({ dryRun: !!opts.dryRun, topicKey: opts.topic, maxClusters: opts.maxClusters });
    } catch (err) {
      const hint = lockTimeoutHint(err);
      console.error(hint ? `⚠️ ${hint}` : `⚠️ 归并失败: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      const hint = lockTimeoutHint({ message: result.error });
      console.error(hint ? `⚠️ ${hint}` : `⚠️ 归并失败（wiki 未动，下次可重试）: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.clusters === 0) {
      console.log(result.message || '没有需要归并的近似主题簇');
      return;
    }
    if (result.dryRun) {
      console.log(`[dry-run] 共 ${result.clusters} 个可归并簇（不调 LLM、不落盘）：`);
      for (const c of result.plan) {
        console.log(`  - ${c.key}（${c.count} 页）: ${c.slugs.join(', ')}`);
      }
      return;
    }
    console.log(`✅ 归并完成：处理 ${result.clustersDone}/${result.clusters} 簇（LLM 调用 ${result.llmCalls} 次）→ 归并出 ${result.merged.length} 页，删除 ${result.removedPages.length} 页`);
    for (const p of result.merged) {
      console.log(`  - ${path.relative(storePaths.wiki, p)}`);
    }
    if (result.error) {
      console.error(`⚠️ 部分块失败（已完成块不受影响，下轮重试）: ${result.error}`);
    }
    if (result.clusters > result.clustersDone) {
      console.log(`ℹ️ 尚余 ${result.clusters - result.clustersDone} 簇未处理，再次执行 hub compact 或等 daemon 下轮继续`);
    }
    if (result.merged.length > 0) {
      console.log(`主索引已更新: ${result.index}；App 侧将在下次写回时同步（或手动 hub writeback）`);
    }
  });

// ---------------------------------------------------------------------------
// hub writeback —— 并行写回：wiki（或 sources）条目 → 各 App 记忆文件
// ---------------------------------------------------------------------------

/**
 * hub writeback --repair：调 codex 的 repairFile 修复 AGENTS.md 多标记区
 * （去重合并，走备份→原子写→校验→失败回滚）。默认目标从 config 读 codex 的
 * memory_paths；目前仅支持 codex（其余 app 无标记区语义）。
 * @param {{ app?: string, config?: Object }} [opts]
 * @returns {{ ok: boolean, error?: string, results?: Object[] }} results 为逐文件三态结果
 */
export function runWritebackRepair(opts = {}) {
  const appId = opts.app || 'codex';
  if (appId !== 'codex') {
    return { ok: false, error: `--repair 目前仅支持 codex（AGENTS.md 多标记区修复），收到 "${appId}"` };
  }
  const config = opts.config || loadConfig();
  const appCfg = (config.apps || []).find((a) => a.id === 'codex') || {};
  const targets = Array.isArray(appCfg.memory_paths) ? appCfg.memory_paths : [];
  if (targets.length === 0) {
    return { ok: false, error: 'config 中 codex 没有 memory_paths（先运行 hub scan 探测 AGENTS.md 位置）' };
  }
  const results = targets.map((file) => {
    try {
      return repairFile(file);
    } catch (err) {
      // 单文件失败隔离（repairFile 内部失败会自动按备份回滚），不影响其余目标
      return { path: file, status: 'error', error: err.message };
    }
  });
  return { ok: results.every((r) => r.status !== 'error'), results };
}

/**
 * 把 --repair 结果格式化为人类可读摘要（三态 + 去重统计）。
 * @param {Object} repair runWritebackRepair 返回值
 * @returns {string}
 */
export function formatRepairSummary(repair) {
  if (repair.error) return `❌ ${repair.error}`;
  const lines = ['codex AGENTS.md 标记区修复（--repair）:'];
  for (const r of repair.results) {
    if (r.status === 'missing') {
      lines.push(`  ⚠️ ${r.path} —— missing：文件不存在（scan 探测的路径可能已失效）`);
    } else if (r.status === 'clean') {
      lines.push(`  ✅ ${r.path} —— clean：标记区正常（区数 ${r.regionCount}），无需修复`);
    } else if (r.status === 'repaired') {
      lines.push(
        `  🔧 ${r.path} —— repaired：${r.regionCount} 个标记区合并为 1 个，` +
          `块 ${r.totalBlocks} → ${r.uniqueBlocks}（去重 ${r.duplicateBlocks}）`,
      );
      if (r.backupDir) lines.push(`     备份: ${r.backupDir}（可 hub rollback --dir 恢复）`);
    } else {
      lines.push(`  ❌ ${r.path} —— ${r.status}：${r.error || '未知错误'}`);
    }
  }
  return lines.join('\n');
}

program
  .command('writeback')
  .description('把 wiki 整理页并行写回各 App 记忆文件（默认增量：消费 pending-writeback.json 清单）')
  .option('--app <id>', '仅写回指定 app（claude|codex|qoder|qoderwork|wukong）')
  .option('--dry-run', '只打印各适配器的 render 结果，不产生任何写入')
  .option('--entry <hubId>', '仅写回包含指定 hub-id 的条目')
  .option('--from-sources', '数据源改用 sources/ 快照（透传测试）')
  .option('--force-batch3', '临时放行 batch:3 高风险批次（qoderwork/wukong）')
  .option('--full', '强制全量广播（忽略 pending-writeback.json 增量清单）')
  .option('--repair', '修复 codex AGENTS.md 多标记区（去重合并，含备份；仅支持 --app codex）')
  .action(async (opts) => {
    // --repair：独立的修复流程，不进入写回管线
    if (opts.repair) {
      const repair = runWritebackRepair({ app: opts.app });
      console.log(formatRepairSummary(repair));
      if (!repair.ok) process.exitCode = 1;
      return;
    }
    let result;
    try {
      result = await runWriteback({
        app: opts.app,
        dryRun: !!opts.dryRun,
        entry: opts.entry,
        fromSources: !!opts.fromSources,
        forceBatch3: !!opts.forceBatch3,
        full: !!opts.full,
        // SHOULD-6：交互命令 30s 抢锁超时（daemon 内部调用不传，维持 120s 默认）
        lockTimeoutMs: CLI_LOCK_TIMEOUT_MS,
      });
    } catch (err) {
      const hint = lockTimeoutHint(err);
      console.error(hint ? `⚠️ ${hint}` : `❌ 写回失败: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(formatWritebackSummary(result, { dryRun: !!opts.dryRun }));
    if (!result.ok && result.error) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// hub init —— 首次引导
// ---------------------------------------------------------------------------

/**
 * 首次引导：创建 ~/.memory-hub 结构 → 生成默认 config → 自动 scan → 打印下一步指引。
 */
export function runInit() {
  ensureHubDirs();
  ensureHubStore();
  loadConfig(); // 惰性生成默认 config.json（600 权限）
  console.log(`✅ 数据目录已就绪: ${paths.root}`);
  console.log(`   配置文件: ${paths.config}`);
  console.log(`   中转站（桌面可视）: ${paths.hub}`);
  console.log(`   日志（桌面镜像 / 底层权威份）: ${paths.userLogs} / ${paths.logs}`);
  console.log('');
  console.log('自动执行 hub scan，探测五个 App 的记忆位置…');
  const rows = scanApps();
  console.log(formatScanSummary(rows));
  console.log('');
  console.log('下一步指引：');
  console.log('  1. hub keys --sync        # 只读同步 LLM 密钥到 Keychain（distill 需要）');
  console.log('  2. hub keys use <name> [--base-url <url>] [--model <model>]');
  console.log('                            # 切换 config.llm.keyRef，并补齐 llm.baseUrl/model');
  console.log('  3. hub daemon install     # 安装 launchd 后台守护（开机自启 + 崩溃自拉起）');
  console.log('  4. hub status             # 随时查看一屏汇总状态');
}

program
  .command('init')
  .description('首次引导：创建 ~/.memory-hub 结构、生成默认配置、自动 scan')
  .action(() => {
    runInit();
  });

// ---------------------------------------------------------------------------
// hub backup —— 对全部已发现 app 的记忆文件做一次快照备份
// ---------------------------------------------------------------------------

/**
 * 收集单个 app 的记忆文件清单：memory_paths 中的文件直接收录，
 * 目录则递归收集 .md（跳过隐藏文件与一切 sqlite/索引）。
 * @param {Object} appCfg config.apps 条目
 * @returns {string[]} 文件绝对路径（去重排序）
 */
export function collectMemoryFiles(appCfg) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // 隐藏文件一律跳过
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) files.push(full);
    }
  };
  for (const p of appCfg.memory_paths || []) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) files.push(p);
      else if (st.isDirectory()) walk(p);
    } catch {
      // 路径失效跳过，不影响其余
    }
  }
  return [...new Set(files)].sort();
}

/**
 * 对 config 中所有已发现（enabled 且 memory_paths 非空）的 app 记忆文件
 * 做一次快照备份：全部归入同一时间戳备份目录，并写 manifest.json
 * （备份文件名 → { app, 原路径 }）供 rollback 做路径映射。
 * @param {{ config?: Object }} [opts]
 * @returns {{ dir: string, count: number, manifest: Object }}
 */
export function backupAllApps(opts = {}) {
  const config = opts.config || loadConfig();
  ensureHubDirs();
  // M2：全量备份独立分池 backups/full/（与 writeback 每批备份池分离，各自限额，
  // 互不挤出；createBackupDir 内含唯一时间戳目录创建与统一 prune）
  const dir = createBackupDir('full');

  const manifest = {};
  let count = 0;
  for (const app of config.apps || []) {
    if (app.enabled !== true) continue;
    if (!Array.isArray(app.memory_paths) || app.memory_paths.length === 0) continue;
    for (const file of collectMemoryFiles(app)) {
      // 备份名加 app 前缀避免跨 app 同名冲突；仍冲突则追加序号
      let name = `${app.id}__${path.basename(file)}`;
      let k = 2;
      while (manifest[name]) {
        name = `${app.id}__${path.basename(file)}-${k}`;
        k += 1;
      }
      const dest = path.join(dir, name);
      fs.copyFileSync(file, dest);
      fs.chmodSync(dest, FILE_MODE);
      manifest[name] = { app: app.id, origin: file };
      count += 1;
    }
  }
  atomicWrite(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  return { dir, count, manifest };
}

program
  .command('backup')
  .description('对全部已发现 app 的记忆文件做一次快照备份（同一时间戳目录）')
  .action(() => {
    const { dir, count } = backupAllApps();
    if (count === 0) {
      console.log('没有可备份的记忆文件（请先运行 hub scan 探测 app）');
      return;
    }
    console.log(`✅ 已备份 ${count} 个记忆文件`);
    console.log(`备份目录: ${dir}`);
    console.log(`路径映射: ${path.join(dir, 'manifest.json')}（rollback 依赖）`);
  });

// ---------------------------------------------------------------------------
// hub rollback —— 产品化回滚（二次确认 + 原子恢复）
// ---------------------------------------------------------------------------

/** readline 二次确认（y/yes 视为确认） */
async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * 解析 rollback 目标备份目录（N3 修复）：
 * - 缺省取最近一次备份；
 * - 传完整路径且存在 → 直接使用；
 * - 传备份目录名或时间戳名片段（前缀匹配）→ 在 backups 下查找；
 * - 找不到时错误提示列出全部可用备份目录，不再误导为「无备份」。
 * @param {string} [dirArg] --dir 参数
 * @returns {string|null} 备份目录绝对路径
 */
export function resolveBackupDir(dirArg) {
  if (!dirArg) return latestBackupDir();
  if (fs.existsSync(dirArg)) return dirArg;
  // 按备份目录名（时间戳名）前缀片段匹配
  const candidates = listBackupDirs().filter((d) => path.basename(d).startsWith(dirArg));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `rollback 失败：--dir 片段 "${dirArg}" 匹配到多个备份目录，请提供更精确的名称：\n` +
        candidates.map((d) => `  - ${path.basename(d)}`).join('\n'),
    );
  }
  const available = listBackupDirs();
  throw new Error(
    `rollback 失败：找不到匹配 "${dirArg}" 的备份目录` +
      (available.length > 0
        ? `，可用备份目录：\n${available.map((d) => `  - ${path.basename(d)}`).join('\n')}`
        : '（尚无任何备份，请先运行 hub backup）'),
  );
}

/**
 * 从指定（缺省最近一次）备份目录恢复记忆文件：
 * - 依赖备份目录内 manifest.json 的路径映射；无映射拒绝执行；
 * - 恢复走 safe-write.rollback（原子写）；
 * - 恢复前二次确认，--yes 跳过（测试可注入 confirm 函数）。
 * @param {{ dir?: string, app?: string, yes?: boolean, confirm?: Function }} [opts]
 *   dir 支持完整路径或备份目录时间戳名/前缀片段（N3）
 * @returns {Promise<{ cancelled?: boolean, dir: string, restored?: Object[] }>}
 */
export async function rollbackBackup(opts = {}) {
  const dir = resolveBackupDir(opts.dir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('rollback 失败：找不到可用的备份目录（请先运行 hub backup）');
  }
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`rollback 拒绝执行：备份目录缺少 manifest.json 路径映射（${dir}）`);
  }
  let names = Object.keys(manifest).filter((n) => manifest[n]?.origin);
  if (opts.app) names = names.filter((n) => manifest[n].app === opts.app);
  if (names.length === 0) {
    throw new Error(`rollback 失败：该备份中没有可恢复的条目${opts.app ? `（app=${opts.app}）` : ''}`);
  }
  const pathMap = {};
  for (const n of names) pathMap[n] = manifest[n].origin;

  console.log(`备份目录: ${dir}`);
  console.log(`将恢复 ${names.length} 个文件（按 app 分组）：`);
  // N4：清单按 app 分组展示；旧备份 manifest 无 app 字段时归入「未标注」，不再显示 [undefined]
  const byApp = new Map();
  for (const n of names) {
    const app = manifest[n].app || '未标注';
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app).push(manifest[n].origin);
  }
  for (const [app, origins] of [...byApp.entries()].sort()) {
    console.log(`  [${app}]`);
    for (const origin of origins) console.log(`    - ${origin}`);
  }

  if (!opts.yes) {
    const confirmFn = opts.confirm || askYesNo;
    const ok = await confirmFn('确认回滚到该备份时点的状态？(y/N) ');
    if (!ok) {
      console.log('已取消，未做任何写入');
      return { cancelled: true, dir };
    }
  }
  const restored = rollback(dir, pathMap);
  const recovered = restored.filter((r) => !r.removed && !r.missing);
  const removedNew = restored.filter((r) => r.removed);
  console.log(
    `✅ 回滚完成：已恢复 ${recovered.length} 个文件（原子写）` +
      (removedNew.length > 0 ? `，删除写回新增 ${removedNew.length} 个文件（零残留）` : ''),
  );
  for (const r of restored) {
    if (r.missing) {
      console.log(`  - ⚠️ ${r.to}（新增文件未找到：可能被客户端改名且未命中 hub-id 标记，请人工确认）`);
    } else if (r.removed) {
      console.log(`  - ${r.to}（新增文件，已删除${r.renamed ? '；客户端改名文件按 hub-id 匹配清理' : ''}）`);
    } else {
      console.log(`  - ${r.to}`);
    }
  }
  return { cancelled: false, dir, restored };
}

program
  .command('rollback')
  .description('从备份目录原子恢复记忆文件（缺省最近一次备份，恢复前二次确认）')
  .option('--dir <备份目录>', '指定备份目录（缺省最近一次）')
  .option('--app <id>', '仅恢复指定 app（claude|codex|qoder|qoderwork|wukong）')
  .option('--yes', '跳过二次确认')
  .action(async (opts) => {
    try {
      await rollbackBackup({ dir: opts.dir, app: opts.app, yes: !!opts.yes });
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// hub sync —— 单次全链路：harvest 全量对账 → distill → writeback
// ---------------------------------------------------------------------------

/**
 * 单次全链路（排障与验证用）：
 * 1. harvest 全量对账摄取；2. distill（LLM 未配置优雅降级）；
 * 3. writeback（遵守 config.writeback.batch3Enabled，绝不传 forceBatch3）。
 * @param {{ config?: Object, adapters?: Object[] }} [opts]
 */
export async function runSync(opts = {}) {
  const config = opts.config || loadConfig();
  const adapters = opts.adapters || createAdapters(config);

  console.log(`[sync] 1/3 harvest 全量对账（${adapters.length} 个已启用适配器）`);
  let ingested = 0;
  let files = 0;
  let removed = 0;
  for (const adapter of adapters) {
    try {
      const r = harvest(adapter);
      ingested += r.ingested;
      files += r.files;
      removed += r.removed;
      console.log(`  - ${adapter.id}: 变化文件 ${r.files} 个，摄取 ${r.ingested} 条快照，移除状态 ${r.removed} 个`);
    } catch (err) {
      console.log(`  - ${adapter.id}: 对账异常 ${err.message}（隔离，不影响其余 app）`);
    }
  }
  console.log(`  合计：变化文件 ${files} 个 / 摄取 ${ingested} 条 / 移除 ${removed} 个`);

  console.log('[sync] 2/3 distill（LLM 整理）');
  let distillResult;
  try {
    distillResult = await distill({ config });
  } catch (err) {
    distillResult = { ok: false, error: err.message };
  }
  if (!distillResult.ok) {
    console.log(`  ⚠️ distill 优雅降级：${distillResult.error}（sources 保留，后续可重试）`);
  } else if (distillResult.pending === 0) {
    console.log(`  ${distillResult.message || '没有待整理的原始快照'}`);
  } else {
    console.log(`  ✅ ${distillResult.pending} 条快照 → ${distillResult.written.length} 个 wiki 页面`);
  }

  console.log('[sync] 3/3 writeback（遵守 config.writeback.batch3Enabled，不传 forceBatch3）');
  const wb = await runWriteback({ config });
  console.log(formatWritebackSummary(wb));
  return { ingested, files, removed, distill: distillResult, writeback: wb };
}

program
  .command('sync')
  .description('单次全链路：harvest 全量对账 → distill → writeback（排障与验证）')
  .action(async () => {
    await runSync();
  });

// ---------------------------------------------------------------------------
// hub status —— 一屏汇总
// ---------------------------------------------------------------------------

/**
 * 生成一屏汇总状态报告：五个 app 发现状态 / daemon 运行状态 / watcher 最近活动 /
 * distill 进度 / writeback-log 最近 5 条 / backups 现存份数。
 * @param {{ launchctl?: Function, uid?: number }} [opts] daemon 探测可注入（测试用）
 * @returns {string} 报告文本
 */
export function getStatusReport(opts = {}) {
  const config = loadConfig();
  const lines = [];
  lines.push('════════ Memory Hub 状态汇总 ════════');
  lines.push(`数据根目录: ${paths.root}`);
  lines.push(`中转站（桌面可视）: ${paths.hub}`);
  lines.push('');

  // 1. 五个 app 的发现状态 / 路径 / enabled
  lines.push('【App 发现状态】');
  for (const app of config.apps) {
    const hasPaths = Array.isArray(app.memory_paths) && app.memory_paths.length > 0;
    const status =
      app.enabled === true && hasPaths
        ? '✅ 已发现·启用'
        : app.enabled === true
          ? '⚠️ 启用·无路径'
          : '❌ 未启用';
    lines.push(`  ${app.id.padEnd(10)} ${status}`);
    if (hasPaths) lines.push(`             路径: ${app.memory_paths.join(' ; ')}`);
  }
  lines.push('');

  // 2. daemon 运行状态（pid 检测 + launchctl print）
  lines.push('【daemon】');
  const state = detectDaemonState(opts);
  lines.push(
    state.running
      ? `  运行中 ✅（pid ${state.pid}，探测来源: ${state.source}，标签 ${LAUNCHD_LABEL}）`
      : `  未运行 ⛔（launchd 标签 ${LAUNCHD_LABEL}）`,
  );
  lines.push('');

  // 3. watcher 最近活动（logs/watcher.log 尾行）
  lines.push('【watcher】');
  const watcherTail = tailLines(path.join(paths.logs, 'watcher.log'), 1);
  lines.push(`  最近活动: ${watcherTail.length > 0 ? watcherTail[0] : '（无记录）'}`);
  lines.push('');

  // 4. distill 进度（含隔离/毒批计数，详情看 hub doctor）
  lines.push('【distill】');
  const ds = loadDistillState();
  lines.push(`  已整理 hubId: ${Object.keys(ds.processed).length} 条`);
  lines.push(
    `  隔离快照 ${Object.keys(ds.quarantined || {}).length} 条 / 毒批隔离 ${Object.keys(ds.poisonedBatches || {}).length} 个`,
  );
  lines.push('');

  // 5. writeback-log 最近 5 条
  lines.push('【writeback-log 最近 5 条】');
  const log = loadWritebackLog().slice(-5);
  if (log.length === 0) {
    lines.push('  （暂无写回记录）');
  } else {
    for (const r of log) {
      lines.push(`  ${r.time}  [${r.app}] ${r.hubId}  ${r.result}${r.backupDir ? `  备份: ${r.backupDir}` : ''}`);
    }
  }
  lines.push('');

  // 6. backups 现存份数（M2：全量与写回分池，各自限额）
  lines.push('【backups】');
  lines.push(
    `  现存 ${listBackupDirs().length} 份（全量池上限 ${MAX_FULL_BACKUPS} / 写回池上限 ${MAX_BACKUPS}，目录: ${paths.backups}）`,
  );
  lines.push('');

  // 7. 日志与健康度提示（权威份在底层，桌面仅镜像）
  lines.push('【日志与健康度】');
  lines.push(`  权威日志: ${paths.logs}（桌面 ${paths.userLogs} 为镜像，仅供查看）`);
  lines.push('  运行 hub doctor 查看健康度报告（索引/隔离/积压/写回/备份/锁/测试污染）');
  return lines.join('\n');
}

program
  .command('status')
  .description('一屏汇总：app 发现状态 / daemon / watcher / distill / writeback-log / backups')
  .action(() => {
    console.log(getStatusReport());
  });

// ---------------------------------------------------------------------------
// hub doctor —— 健康度体检（纯只读）
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('健康度体检（纯只读）：索引完整率/重复标题/隔离与失败/distill 积压/写回健康/备份池/锁状态/测试污染')
  .option('--json', '输出结构化 JSON 报告')
  .action((opts) => {
    const report = runDoctor();
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    // 有 ❌ 项时以非零码退出（脚本可据此告警）
    if (!report.ok) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// hub search —— wiki 关键词检索（grep 级）
// ---------------------------------------------------------------------------

program
  .command('search <keywords...>')
  .description('检索 wiki（标题/tags/frontmatter/正文；大小写不敏感，多关键词 AND）')
  .option('--limit <n>', '最多显示的命中条数（缺省 20）', (v) => parseInt(v, 10))
  .action((keywords, opts) => {
    console.log(formatSearchResults(searchWiki(keywords, { limit: opts.limit })));
  });

// ---------------------------------------------------------------------------
// hub tombstone —— 删除传播管理（MUST-2 安全阀的显式操作面）
// ---------------------------------------------------------------------------

/**
 * 把 tombstone 清单按闭环进度分为三态：
 * - pendingWiki：待 wiki 标记（未 wikiApplied）；
 * - pendingApps：wiki 已标记、待写回清理（wikiApplied 且未 appsCleaned）；
 * - closed：已闭环（wikiApplied 且 appsCleaned）。
 * @param {Object} [state] loadTombstones 结果（缺省现读）
 * @returns {{ pendingWiki: Object[], pendingApps: Object[], closed: Object[] }}
 */
export function classifyTombstones(state = loadTombstones()) {
  const groups = { pendingWiki: [], pendingApps: [], closed: [] };
  for (const [hubId, t] of Object.entries(state.tombstones || {})) {
    const row = { hubId, ...t };
    if (!t.wikiApplied) groups.pendingWiki.push(row);
    else if (!t.appsCleaned) groups.pendingApps.push(row);
    else groups.closed.push(row);
  }
  return groups;
}

/** 单条 tombstone 的展示行（含 suspectedStorm 风暴标记） */
function tombstoneRow(t) {
  const storm = t.suspectedStorm === true ? ' 🌩️疑似风暴' : '';
  return `  - ${t.hubId}  [${t.app || '?'}]  删于 ${t.deletedAt || '?'}${storm}${t.source ? `\n    源: ${t.source}` : ''}`;
}

/**
 * 格式化 hub tombstone list 输出（三态 + 风暴标记 + 自动传播开关状态）。
 * @param {Object} [state] loadTombstones 结果（缺省现读）
 * @param {Object} [config] 配置（缺省 loadConfig）
 * @returns {string}
 */
export function formatTombstoneList(state = loadTombstones(), config = loadConfig()) {
  const groups = classifyTombstones(state);
  const total = groups.pendingWiki.length + groups.pendingApps.length + groups.closed.length;
  const stormCount = [...groups.pendingWiki, ...groups.pendingApps, ...groups.closed].filter(
    (t) => t.suspectedStorm === true,
  ).length;
  const auto = config.tombstone?.autoPropagate === true;
  const lines = [];
  lines.push(`tombstone 共 ${total} 条（自动传播: ${auto ? '开启' : '关闭'}，疑似风暴 ${stormCount} 条）`);
  if (total === 0) {
    lines.push('（清单为空）');
    return lines.join('\n');
  }
  lines.push('', `【待 wiki 标记】${groups.pendingWiki.length} 条`);
  for (const t of groups.pendingWiki) lines.push(tombstoneRow(t));
  lines.push('', `【待写回清理】${groups.pendingApps.length} 条`);
  for (const t of groups.pendingApps) lines.push(tombstoneRow(t));
  lines.push('', `【已闭环】${groups.closed.length} 条`);
  for (const t of groups.closed) lines.push(tombstoneRow(t));
  if (!auto && groups.pendingWiki.length + groups.pendingApps.length > 0) {
    lines.push('', '提示: 自动传播已关闭，运行 hub tombstone apply [--dry-run] 显式执行传播');
  }
  return lines.join('\n');
}

/**
 * 预览一次 tombstone apply 的影响面（纯只读，不动任何数据）：
 * - 待 wiki 标记的 hubId 命中哪些 wiki 页（整页删除 vs 部分剔除，与
 *   applyTombstones 同样只扫 wiki 根目录顶层页）；
 * - 待写回清理的 hubId 将从哪些启用 App（可写、非 readOnly）移除。
 * @param {{ state?: Object, config?: Object }} [opts] 可注入状态/配置（测试用）
 * @returns {{ pendingWikiIds: string[], removalIds: string[], stormIds: string[],
 *   deletedPages: string[], updatedPages: string[], apps: string[] }}
 */
export function previewTombstoneApply(opts = {}) {
  const state = opts.state || loadTombstones();
  const config = opts.config || loadConfig();
  const entries = Object.entries(state.tombstones || {});
  const pendingWikiIds = entries.filter(([, t]) => !t.wikiApplied).map(([id]) => id);
  const removalIds = entries.filter(([, t]) => !t.appsCleaned).map(([id]) => id);
  const stormIds = entries.filter(([, t]) => t.suspectedStorm === true).map(([id]) => id);

  // 命中页扫描：与 applyTombstones ② 同范围（wiki 根目录顶层 .md，跳过 README）
  const pendingSet = new Set(pendingWikiIds);
  const deletedPages = [];
  const updatedPages = [];
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(storePaths.wiki, { withFileTypes: true });
  } catch {
    dirEntries = [];
  }
  for (const e of dirEntries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'README.md') continue;
    let parsed;
    try {
      parsed = matter(fs.readFileSync(path.join(storePaths.wiki, e.name), 'utf8'));
    } catch {
      continue;
    }
    const rawIds = parsed.data?.['hub-id'];
    const pageIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
    const hit = pageIds.filter((id) => pendingSet.has(id));
    if (hit.length === 0) continue;
    if (hit.length === pageIds.length) deletedPages.push(e.name);
    else updatedPages.push(e.name);
  }

  // 受影响的写回目标 App：启用、有路径、非只读
  const apps = (config.apps || [])
    .filter(
      (a) =>
        a.enabled === true &&
        Array.isArray(a.memory_paths) &&
        a.memory_paths.length > 0 &&
        a.readOnly !== true &&
        !/read[-_ ]?only/i.test(String(a.notes || '')),
    )
    .map((a) => a.id);
  return { pendingWikiIds, removalIds, stormIds, deletedPages, updatedPages, apps };
}

/** 把影响面预览格式化为人类可读文本（dry-run 与执行前确认共用） */
export function formatTombstonePreview(preview) {
  const lines = [];
  lines.push(`待 wiki 标记: ${preview.pendingWikiIds.length} 条 hubId`);
  lines.push(
    `  → 整页删除 ${preview.deletedPages.length} 页${preview.deletedPages.length > 0 ? `: ${preview.deletedPages.join(', ')}` : ''}`,
  );
  lines.push(
    `  → 部分剔除 ${preview.updatedPages.length} 页${preview.updatedPages.length > 0 ? `: ${preview.updatedPages.join(', ')}` : ''}`,
  );
  lines.push(`待写回清理: ${preview.removalIds.length} 条 hubId → 目标 App: ${preview.apps.join(', ') || '（无）'}`);
  if (preview.stormIds.length > 0) {
    lines.push(`⚠️ 其中 ${preview.stormIds.length} 条带 suspectedStorm 风暴标记，本次将一并执行（确认前请核实）`);
  }
  return lines.join('\n');
}

/**
 * 显式执行一次 tombstone 传播（hub tombstone apply，不带 --dry-run）：
 * ① applyTombstones(force)：wiki 标记 + 重放防护（含 suspectedStorm 条目）；
 * ② runWriteback(removalsOnly + forceTombstones)：各 App 侧条目移除与 appsCleaned 闭环。
 * @param {{ config?: Object, adapters?: Object[], lockTimeoutMs?: number }} [opts] 测试可注入
 * @returns {Promise<{ tombstone: Object, writeback: Object }>}
 */
export async function runTombstoneApply(opts = {}) {
  const config = opts.config || loadConfig();
  const tombstone = applyTombstones(loadDistillState(), { config, force: true });
  const writeback = await runWriteback({
    config,
    adapters: opts.adapters,
    removalsOnly: true,
    forceTombstones: true,
    lockTimeoutMs: opts.lockTimeoutMs ?? CLI_LOCK_TIMEOUT_MS,
  });
  return { tombstone, writeback };
}

const tombstoneCmd = program
  .command('tombstone')
  .description('删除传播管理：list 三态清单 / apply 显式传播（--dry-run 预览）/ drop 撤销误登记');

tombstoneCmd
  .command('list')
  .description('列出全部 tombstone（三态：待 wiki 标记/待写回清理/已闭环，含 suspectedStorm 标记）')
  .action(() => {
    console.log(formatTombstoneList());
  });

tombstoneCmd
  .command('apply')
  .description('显式执行删除传播（含 suspectedStorm 条目；--dry-run 只预览影响面，执行需 --yes 确认）')
  .option('--dry-run', '只预览将影响的 wiki 页与各 App 目标，不做任何写入')
  .option('--yes', '跳过交互确认直接执行')
  .action(async (opts) => {
    const preview = previewTombstoneApply();
    if (preview.pendingWikiIds.length === 0 && preview.removalIds.length === 0) {
      console.log('没有待传播的 tombstone（清单为空或已全部闭环）');
      return;
    }
    console.log(formatTombstonePreview(preview));
    if (opts.dryRun) {
      console.log('[dry-run] 仅预览，未做任何写入');
      return;
    }
    if (!opts.yes) {
      const ok = await askYesNo('确认执行上述删除传播？（不可逆，建议先 hub backup）(y/N) ');
      if (!ok) {
        console.log('已取消，未做任何写入');
        return;
      }
    }
    try {
      const { tombstone, writeback } = await runTombstoneApply();
      console.log(
        `✅ wiki 侧：整页删除 ${tombstone.deletedPages.length} 页 / 部分剔除 ${tombstone.updatedPages.length} 页 / 解除（源已重建）${tombstone.lifted.length} 条`,
      );
      console.log(formatWritebackSummary(writeback));
    } catch (err) {
      const hint = lockTimeoutHint(err);
      console.error(hint ? `⚠️ ${hint}` : `❌ 传播失败: ${err.message}`);
      process.exitCode = 1;
    }
  });

tombstoneCmd
  .command('drop [hubId]')
  .description('撤销误登记的 tombstone（指定 hubId，或 --all-storm 批量撤销全部风暴标记条目）')
  .option('--all-storm', '撤销全部带 suspectedStorm 标记的条目')
  .action((hubId, opts) => {
    if (opts.allStorm) {
      const { tombstones } = loadTombstones();
      const ids = Object.entries(tombstones)
        .filter(([, t]) => t.suspectedStorm === true)
        .map(([id]) => id);
      if (ids.length === 0) {
        console.log('没有带 suspectedStorm 标记的 tombstone');
        return;
      }
      const removed = removeTombstones(ids);
      console.log(`✅ 已撤销 ${removed.length} 条风暴标记的 tombstone（对应记忆不会被删除传播）`);
      return;
    }
    if (!hubId) {
      console.error('❌ 请指定要撤销的 hubId，或用 --all-storm 批量撤销风暴标记条目');
      process.exitCode = 1;
      return;
    }
    const removed = removeTombstones([hubId]);
    if (removed.length === 0) {
      console.error(`❌ 未找到 tombstone "${hubId}"（hub tombstone list 查看现存清单）`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ 已撤销 tombstone ${hubId}（对应记忆不会被删除传播）`);
  });

// ---------------------------------------------------------------------------
// hub daemon —— launchd 后台守护
// ---------------------------------------------------------------------------

const daemonCmd = program
  .command('daemon')
  .description('launchd 后台守护管理（install/uninstall/start/stop/status/run）');

daemonCmd
  .command('run')
  .description('前台运行 daemon 主循环（由 launchd 调用，勿手动执行）')
  .action(async () => {
    try {
      await runDaemon();
    } catch (err) {
      console.error(`daemon 启动失败: ${err.message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command('install')
  .description('生成 plist 并注册 launchd 服务（幂等，重复执行自动重装）')
  .action(() => {
    try {
      const r = installDaemon();
      console.log(`✅ daemon 已安装（launchctl ${r.via}）`);
      console.log(`  标签: ${r.label}`);
      console.log(`  plist: ${r.plistPath}`);
      console.log('  日志: ~/.memory-hub/logs/daemon.log（launchd stdout/err 另落 launchd.out/err.log）');
    } catch (err) {
      console.error(`❌ 安装失败: ${err.message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command('uninstall')
  .description('注销 launchd 服务并删除 plist（幂等）')
  .action(() => {
    const r = uninstallDaemon();
    console.log(`✅ daemon 已卸载（plist 已删除: ${r.plistPath}）`);
  });

daemonCmd
  .command('start')
  .description('立即启动 daemon（launchctl kickstart）')
  .action(() => {
    try {
      const r = startDaemon();
      console.log(`✅ 已请求启动 daemon（launchctl ${r.via}）`);
    } catch (err) {
      console.error(`❌ 启动失败: ${err.message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command('stop')
  .description('优雅停止 daemon（SIGTERM；正常退出不会被 KeepAlive 重拉）')
  .action(() => {
    try {
      const r = stopDaemon();
      console.log(`✅ 已请求停止 daemon（launchctl ${r.via}）`);
    } catch (err) {
      console.error(`❌ 停止失败: ${err.message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command('status')
  .description('查看 launchd 状态、pid 与最近日志尾 10 行')
  .action(() => {
    console.log(formatDaemonStatus());
  });

// 仅作为主入口直接执行时才 parse（被测试 import 时不触发 CLI 解析）
const isMainModule = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMainModule) {
  program.parse();
}
