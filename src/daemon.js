/**
 * daemon.js —— Memory Hub 后台守护（hub daemon）。
 *
 * 职责：
 * - pid O_EXCL 锁（state/daemon.pid）：存在且进程活着则拒绝二次启动，陈旧锁自动清理；
 * - daemon 主循环（runDaemon）：启动 watcher 监听摄取 + 每 5 分钟尝试 distill（静默批量，
 *   LLM 未配置时优雅降级，绝不做崩溃重试风暴）+ 每 10 分钟尝试 writeback（仅当 wiki
 *   有新条目，且绝不传 forceBatch3 —— 一律遵守 config.writeback.batch3Enabled）；
 * - 日志落 logs/daemon.log（启动、各轮次结果、错误；错误只记录不退出）；
 * - SIGINT/SIGTERM 优雅停止（停 watcher、清 pid、保存状态）；
 * - launchd plist 生成与 install/uninstall/start/stop/status 封装（可逆、幂等）。
 *
 * 硬性约束：五个 App 目录只读（写回一律走既有 writeback 通道）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, ensureHubDirs, ensureDir, FILE_MODE } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import { loadConfig, defaultConfig } from './config.js';
import { Watcher } from './watcher.js';
import { distill } from './distill.js';
import { runWriteback, wikiToEntries } from './writeback.js';
import { appendLogEntry, rotateLogFile } from './util/log.js';

/** launchd 服务标签 */
export const LAUNCHD_LABEL = 'com.kuangju.memory-hub';

/** distill 轮询间隔：5 分钟 */
export const DISTILL_INTERVAL_MS = 5 * 60 * 1000;
/** writeback 轮询间隔：10 分钟 */
export const WRITEBACK_INTERVAL_MS = 10 * 60 * 1000;

/** H3：连续启动失败上限，超过后主动 bootout 自身，终止 KeepAlive 重启风暴 */
export const CRASH_LIMIT = 5;

/** M8：一切外部子进程（security/launchctl/which）统一超时 10s + SIGKILL 兜底 */
export const SUBPROCESS_TIMEOUT_MS = 10 * 1000;

/** 统一的子进程 spawnSync 选项（超时 + killSignal，失败由调用方降级） */
export const SUBPROCESS_OPTS = { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS, killSignal: 'SIGKILL' };

/** daemon 日志文件路径 */
export function daemonLogPath() {
  return path.join(paths.logs, 'daemon.log');
}

/**
 * 追加一条 daemon 日志（ISO 时间 + 级别 + 消息）。日志失败不影响主流程。
 * L1：统一走 appendLogEntry（超 5MB 自动滚动，保留最近 3 份）。
 * @param {string} level info / warn / error
 * @param {string} msg 日志内容（绝不包含密钥）
 */
export function logDaemon(level, msg) {
  appendLogEntry(daemonLogPath(), `${new Date().toISOString()}\t${level}\t${msg}`);
}

/**
 * 读取日志文件尾部若干行（不存在时返回空数组）。
 * @param {string} file 日志文件路径
 * @param {number} n 行数
 * @returns {string[]}
 */
export function tailLines(file, n = 10) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// pid O_EXCL 锁
// ---------------------------------------------------------------------------

/** daemon pid 文件路径：state/daemon.pid */
export function daemonPidPath() {
  return path.join(paths.state, 'daemon.pid');
}

/**
 * 判断 pid 是否存活（signal 0 探测；EPERM 视为存活——进程在但无权发信号）。
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 以 O_EXCL 方式抢占 pid 锁：写入当前进程 pid。
 * - 锁文件不存在：直接创建成功；
 * - 锁存在且进程活着：抛出错误（拒绝二次启动）；
 * - 锁存在但进程已死（陈旧锁）：清理后重试一次。
 * @returns {string} pid 文件路径
 * @throws {Error} daemon 已在运行时抛出
 */
export function acquirePidLock() {
  ensureDir(paths.state);
  const pidFile = daemonPidPath();
  const create = () => {
    const fd = fs.openSync(pidFile, 'wx'); // O_CREAT | O_EXCL
    try {
      fs.writeSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    create();
    return pidFile;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let existing = NaN;
    try {
      existing = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      // 读取失败按陈旧锁处理
    }
    if (isPidAlive(existing)) {
      throw new Error(`daemon 已在运行（pid ${existing}），拒绝二次启动`);
    }
    // 陈旧锁：清理后重试一次（仍走 O_EXCL，防并发竞争）
    fs.rmSync(pidFile, { force: true });
    create();
    return pidFile;
  }
}

/** 释放 pid 锁（删除 pid 文件，幂等）。 */
export function releasePidLock() {
  fs.rmSync(daemonPidPath(), { force: true });
}

// ---------------------------------------------------------------------------
// plist 生成
// ---------------------------------------------------------------------------

/** 缺省 plist 路径：~/Library/LaunchAgents/com.kuangju.memory-hub.plist */
export function defaultPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/**
 * 探测真实 node 可执行路径：先 which node，再 realpath 解析掉符号链接，
 * 避免把 nvm shim / 软链写进 plist 导致 launchd 环境启动失败。
 * @returns {string} node 绝对路径
 * @throws {Error} 未找到 node 时抛出
 */
export function resolveNodePath() {
  const r = spawnSync('which', ['node'], SUBPROCESS_OPTS); // M8：timeout 兜底
  const candidate = String(r.stdout || '').trim().split('\n')[0];
  if (!candidate) {
    throw new Error('resolveNodePath 失败：which node 未返回任何结果');
  }
  return fs.realpathSync(candidate);
}

/** XML 文本转义（plist 内容安全） */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 生成 launchd plist 内容。
 * @param {{
 *   nodePath?: string,  // node 绝对路径；缺省 resolveNodePath() 探测
 *   cliPath?: string,   // cli.js 绝对路径；缺省取本模块同目录 cli.js
 *   home?: string,      // EnvironmentVariables.HOME；缺省 os.homedir()
 *   logDir?: string,    // launchd.{out,err}.log 目录；缺省 paths.logs
 * }} [opts]
 * @returns {string} plist XML 文本
 */
export function buildPlist(opts = {}) {
  const nodePath = opts.nodePath || resolveNodePath();
  const cliPath = opts.cliPath || fileURLToPath(new URL('./cli.js', import.meta.url));
  const home = opts.home || os.homedir();
  const logDir = opts.logDir || paths.logs;
  const out = path.join(logDir, 'launchd.out.log');
  const err = path.join(logDir, 'launchd.err.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(LAUNCHD_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(cliPath)}</string>`,
    '    <string>daemon</string>',
    '    <string>run</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>30</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(out)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(err)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>HOME</key>',
    `    <string>${xmlEscape(home)}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// launchctl 封装（runner 可注入，测试用桩替代，绝不真正 bootstrap）
// ---------------------------------------------------------------------------

/** 缺省 launchctl 执行器（spawnSync，返回 { status, stdout, stderr }；M8：timeout 兜底） */
function defaultLaunchctl(args) {
  return spawnSync('launchctl', args, SUBPROCESS_OPTS);
}

/** 取 uid（注入优先，便于测试） */
function uidOf(opts) {
  return opts.uid ?? process.getuid?.() ?? 501;
}

/**
 * 安装 daemon：写 plist → launchctl bootstrap（失败回退 load）。幂等：重复安装
 * 先 bootout 旧实例再重新注册。
 * @param {{
 *   plistPath?: string,                 // 自定义 plist 输出路径（测试隔离用）
 *   launchctl?: (args: string[]) => any, // 注入的执行器桩
 *   uid?: number,
 *   nodePath?: string, cliPath?: string, home?: string, logDir?: string,
 * }} [opts]
 * @returns {{ plistPath: string, label: string, via: string }}
 * @throws {Error} bootstrap 与 load 均失败时抛出
 */
export function installDaemon(opts = {}) {
  const plistPath = opts.plistPath || defaultPlistPath();
  const run = opts.launchctl || defaultLaunchctl;
  const uid = uidOf(opts);

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  atomicWrite(plistPath, buildPlist(opts), { mode: FILE_MODE });

  // 幂等重装：先尝试 bootout 旧实例（未加载时忽略错误）
  run(['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);

  const bootstrap = run(['bootstrap', `gui/${uid}`, plistPath]);
  if (bootstrap.status === 0) {
    return { plistPath, label: LAUNCHD_LABEL, via: 'bootstrap' };
  }
  // 回退：旧式 launchctl load
  const load = run(['load', plistPath]);
  if (load.status === 0) {
    return { plistPath, label: LAUNCHD_LABEL, via: 'load' };
  }
  const msg = String(load.stderr || bootstrap.stderr || '').trim();
  throw new Error(`launchctl 注册失败（bootstrap 与 load 均失败）: ${msg}`);
}

/**
 * 卸载 daemon：launchctl bootout（回退 unload）→ 删除 plist。幂等：
 * 未安装/已卸载时重复执行不报错。
 * @param {Object} [opts] 同 installDaemon（launchctl/plistPath/uid 可注入）
 * @returns {{ plistPath: string, label: string }}
 */
export function uninstallDaemon(opts = {}) {
  const plistPath = opts.plistPath || defaultPlistPath();
  const run = opts.launchctl || defaultLaunchctl;
  const uid = uidOf(opts);

  // bootout / unload 均容错（服务可能本就未注册）
  run(['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
  if (fs.existsSync(plistPath)) {
    run(['unload', plistPath]);
  }
  fs.rmSync(plistPath, { force: true });
  return { plistPath, label: LAUNCHD_LABEL };
}

/**
 * 启动 daemon（kickstart，回退 launchctl start）。
 * H3：启动前校验 plist 内的 node 可执行路径仍存在，失效时给出可读错误与修复指引。
 * @param {Object} [opts] launchctl/uid 可注入
 * @returns {{ via: string }}
 */
export function startDaemon(opts = {}) {
  // H3：plist 内 node 路径失效（升级/删除 node）时给出可读日志而非 launchd 无声重试
  const plistPath = opts.plistPath || defaultPlistPath();
  try {
    const plist = fs.readFileSync(plistPath, 'utf8');
    const m = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
    const nodePath = m?.[1];
    if (nodePath && !fs.existsSync(nodePath)) {
      throw new Error(
        `plist 中的 node 可执行路径已失效: ${nodePath}。请先修复 node 安装，再执行 hub daemon install 重新生成 plist`,
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // plist 不存在时交给 launchctl 报错
  }
  const run = opts.launchctl || defaultLaunchctl;
  const uid = uidOf(opts);
  const kick = run(['kickstart', `gui/${uid}/${LAUNCHD_LABEL}`]);
  if (kick.status === 0) return { via: 'kickstart' };
  const start = run(['start', LAUNCHD_LABEL]);
  if (start.status !== 0) {
    throw new Error(`launchctl 启动失败: ${String(start.stderr || kick.stderr || '').trim()}`);
  }
  return { via: 'start' };
}

/**
 * 停止 daemon：SIGTERM 触发优雅退出（exit 0），配合 KeepAlive{SuccessfulExit:false}
 * 不会被 launchd 重新拉起。
 * @param {Object} [opts] launchctl/uid 可注入
 * @returns {{ via: string }}
 */
export function stopDaemon(opts = {}) {
  const run = opts.launchctl || defaultLaunchctl;
  const uid = uidOf(opts);
  const kill = run(['kill', 'SIGTERM', `gui/${uid}/${LAUNCHD_LABEL}`]);
  if (kill.status === 0) return { via: 'kill SIGTERM' };
  const stop = run(['stop', LAUNCHD_LABEL]);
  if (stop.status !== 0) {
    throw new Error(`launchctl 停止失败: ${String(stop.stderr || kill.stderr || '').trim()}`);
  }
  return { via: 'stop' };
}

/**
 * 查询 launchd 注册状态（launchctl print）。
 * @param {Object} [opts] launchctl/uid 可注入
 * @returns {{ loaded: boolean, pid: number|null, raw: string }}
 */
export function launchctlStatus(opts = {}) {
  const run = opts.launchctl || defaultLaunchctl;
  const uid = uidOf(opts);
  const r = run(['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
  if (r.status !== 0) return { loaded: false, pid: null, raw: '' };
  const raw = String(r.stdout || '');
  const m = raw.match(/\bpid\s*=\s*(\d+)/);
  return { loaded: true, pid: m ? Number(m[1]) : null, raw };
}

/**
 * 综合探测 daemon 运行状态：优先 pid 文件（隔离环境友好），回退 launchctl print。
 * @param {Object} [opts] launchctl/uid 可注入
 * @returns {{ running: boolean, pid: number|null, source: 'pid'|'launchctl'|null }}
 */
export function detectDaemonState(opts = {}) {
  let pidFromFile = NaN;
  try {
    pidFromFile = parseInt(fs.readFileSync(daemonPidPath(), 'utf8').trim(), 10);
  } catch {
    // 无 pid 文件
  }
  if (isPidAlive(pidFromFile)) {
    return { running: true, pid: pidFromFile, source: 'pid' };
  }
  const ls = launchctlStatus(opts);
  if (ls.loaded) {
    return { running: ls.pid !== null, pid: ls.pid, source: 'launchctl' };
  }
  return { running: false, pid: null, source: null };
}

/**
 * 格式化 daemon 状态报告（hub daemon status 用）：
 * launchctl 状态、pid、daemon.log 尾 10 行。
 * @param {Object} [opts] launchctl/uid 可注入
 * @returns {string}
 */
export function formatDaemonStatus(opts = {}) {
  const state = detectDaemonState(opts);
  const ls = launchctlStatus(opts);
  const lines = [];
  lines.push(`launchd 标签: ${LAUNCHD_LABEL}`);
  lines.push(`launchctl 状态: ${ls.loaded ? '已注册' : '未注册（未安装或已卸载）'}`);
  lines.push(
    state.running
      ? `运行状态: ✅ 运行中（pid ${state.pid}，探测来源 ${state.source}）`
      : '运行状态: ⛔ 未运行',
  );
  lines.push(`pid 文件: ${daemonPidPath()}`);
  lines.push(`plist: ${opts.plistPath || defaultPlistPath()}`);
  lines.push('');
  lines.push(`最近日志（${daemonLogPath()} 尾 10 行）:`);
  const tail = tailLines(daemonLogPath(), 10);
  if (tail.length === 0) {
    lines.push('  （暂无日志）');
  } else {
    for (const l of tail) lines.push(`  ${l}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// daemon 主循环
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// H3：启动失败计数（防 KeepAlive 重启风暴）
// ---------------------------------------------------------------------------

/** 连续启动失败计数文件：state/crash-count.json */
export function crashCountPath() {
  return path.join(paths.state, 'crash-count.json');
}

/**
 * 递增启动失败计数并返回新值（文件损坏视为 0 起步）。
 * @returns {number}
 */
export function bumpCrashCount() {
  let n = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(crashCountPath(), 'utf8'));
    n = Number.isFinite(raw?.count) ? raw.count : 0;
  } catch {
    // 首次或损坏：从 0 计
  }
  n += 1;
  try {
    ensureDir(paths.state);
    atomicWrite(crashCountPath(), `${JSON.stringify({ count: n, at: new Date().toISOString() })}\n`, { mode: FILE_MODE });
  } catch {
    // 计数落盘失败不阻塞启动
  }
  return n;
}

/** 重置启动失败计数（watcher 就绪即视为启动成功）。 */
export function resetCrashCount() {
  fs.rmSync(crashCountPath(), { force: true });
}

/**
 * L5：清扫监听目录下陈旧的安全写入临时文件（`*.tmp-<pid>-<ts>`）。
 * 仅清理自身模式且（持锁 pid 已死或文件龄超 1 小时）的文件，绝不误删活跃写入。
 * @param {string[]} dirs 待清扫目录（各适配器 watchPaths）
 * @returns {number} 清理文件数
 */
export function sweepStaleTmpFiles(dirs) {
  const TMP_RE = /\.tmp-(\d+)-(\d+)$/;
  const now = Date.now();
  let removed = 0;
  const stack = [...dirs.map((d) => path.resolve(d))];
  const seen = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      const m = e.name.match(TMP_RE);
      if (!m) continue;
      try {
        const st = fs.statSync(full);
        const staleByAge = now - st.mtimeMs > 60 * 60 * 1000;
        const staleByPid = !isPidAlive(Number(m[1]));
        if (staleByAge || staleByPid) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        // 恰好被删：跳过
      }
    }
  }
  return removed;
}

/**
 * daemon 主循环（hub daemon run 的前台进程体，由 launchd 拉起）。
 *
 * 流程：pid O_EXCL 锁 → 启动 watcher → 定时器（5min distill / 10min writeback）
 * → SIGINT/SIGTERM 优雅停止（停 watcher、清 pid、保存状态）。
 * 错误一律记录日志后继续，不退出、不重试风暴。
 *
 * @param {{
 *   config?: Object,              // 配置；缺省 loadConfig()
 *   distillIntervalMs?: number,   // distill 轮询间隔（缺省 5 分钟）
 *   writebackIntervalMs?: number, // writeback 轮询间隔（缺省 10 分钟）
 *   distillFn?: Function,         // 可注入（测试用）
 *   writebackFn?: Function,       // 可注入（测试用）
 *   degradedWarnIntervalMs?: number, // RV-O2：降级配置周期提醒间隔（缺省 30 分钟）
 * }} [opts]
 * @returns {Promise<{ stop: Function }>} 控制句柄
 * @throws {Error} pid 锁被存活进程占用时抛出
 */
export async function runDaemon(opts = {}) {
  // H3：config 损坏时降级 defaultConfig 并记 error，绝不在入口抛出
  // （否则 KeepAlive + ThrottleInterval 30s 会形成崩溃重启风暴）
  let config = opts.config;
  let configDegraded = false;
  if (!config) {
    try {
      config = loadConfig();
    } catch (err) {
      configDegraded = true;
      config = defaultConfig();
      logDaemon('error', `config.json 加载失败，降级使用缺省配置: ${err.message}（请修复 ~/.memory-hub/config.json）`);
    }
  }
  ensureHubDirs();

  // H3：启动失败计数；超过 CRASH_LIMIT 主动 bootout 自身并留下明确日志，
  // 终止 KeepAlive 无限重启风暴（而非每 30 秒刷一次 err 日志）
  const crashN = bumpCrashCount();
  if (crashN > CRASH_LIMIT) {
    logDaemon('error', `连续 ${crashN} 次启动失败（上限 ${CRASH_LIMIT}），主动 bootout 自身终止重启风暴。请检查 logs/launchd.err.log 与 config.json 后重新 hub daemon install`);
    try {
      defaultLaunchctl(['bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
    } catch {
      // bootout 失败不阻塞退出
    }
    process.exit(1);
  }

  // L1：launchd.out/err.log 由 launchd 直接追加无法拦截，启动时做一次同策略轮转
  rotateLogFile(path.join(paths.logs, 'launchd.out.log'));
  rotateLogFile(path.join(paths.logs, 'launchd.err.log'));

  // 1. pid O_EXCL 锁：存在且进程活着则抛错（cli 层转 exit 1）
  acquirePidLock();

  const distillMs = opts.distillIntervalMs ?? DISTILL_INTERVAL_MS;
  const writebackMs = opts.writebackIntervalMs ?? WRITEBACK_INTERVAL_MS;
  const distillFn = opts.distillFn || distill;
  const writebackFn = opts.writebackFn || runWriteback;

  logDaemon('info', `daemon 启动 pid=${process.pid} distill 间隔=${distillMs}ms writeback 间隔=${writebackMs}ms`);

  // 2. 启动 watcher（信号由 daemon 统一接管）
  const watcher = new Watcher(config);
  watcher.start({ signals: false });
  const watchPaths = watcher.allWatchPaths();
  logDaemon('info', `watcher 监听 ${watchPaths.length} 个路径: ${watchPaths.join(' ; ') || '（无）'}`);

  // L5：启动时清扫 kill -9 遗留的陈旧 .tmp-* 安全写入临时文件
  try {
    const swept = sweepStaleTmpFiles(watchPaths);
    if (swept > 0) logDaemon('info', `已清扫 ${swept} 个陈旧临时文件（.tmp-*）`);
  } catch (err) {
    logDaemon('warn', `陈旧临时文件清扫异常: ${err.message}`);
  }

  let stopping = false;

  // 3. 定时 distill（静默批量；LLM 未配置/调用失败优雅降级，只记录不重试风暴）
  // M7：busy 标志防两轮重叠（重叠轮次跳过并记日志）
  let distillBusy = false;
  const distillTimer = setInterval(async () => {
    if (stopping) return;
    if (distillBusy) {
      logDaemon('warn', 'distill 上一轮仍在进行，跳过本轮');
      return;
    }
    distillBusy = true;
    try {
      const r = await distillFn({ config });
      if (!r.ok) {
        logDaemon('warn', `distill 降级跳过（sources 保留，下轮再试）: ${r.error}`);
      } else if (r.pending > 0) {
        logDaemon('info', `distill 完成: ${r.pending} 条快照 → ${r.written?.length ?? 0} 个页面`);
      }
      // pending === 0 时无事发生，不打扰日志
    } catch (err) {
      logDaemon('error', `distill 异常: ${err.message}`);
    } finally {
      distillBusy = false;
    }
  }, distillMs);

  // 4. 定时 writeback（仅当 wiki 有条目；绝不传 forceBatch3，遵守 batch3Enabled 门禁）
  // M7：busy 标志防两轮重叠
  let writebackBusy = false;
  const writebackTimer = setInterval(async () => {
    if (stopping) return;
    if (writebackBusy) {
      logDaemon('warn', 'writeback 上一轮仍在进行，跳过本轮');
      return;
    }
    writebackBusy = true;
    try {
      const entries = wikiToEntries();
      if (entries.length === 0) return; // wiki 无条目，不触发写回
      const r = await writebackFn({ config });
      const summary = (r.appResults || [])
        .map((a) => `${a.app}:${a.status}`)
        .join(', ');
      logDaemon('info', `writeback 完成: ${entries.length} 条目（${summary || '无适配器'}）`);
    } catch (err) {
      logDaemon('error', `writeback 异常: ${err.message}`);
    } finally {
      writebackBusy = false;
    }
  }, writebackMs);

  // 5. RV-O2：降级配置期间周期性重复提醒（缺省每 30 分钟），直到 config 恢复正常；
  //    恢复后热加载新配置（同一 config 对象引用，定时器闭包直接生效），
  //    watcher 监听路径变化仍需重启 daemon 才能生效，日志中已注明。
  let degradedTimer = null;
  if (configDegraded) {
    const degradedMs = Number.isFinite(opts.degradedWarnIntervalMs)
      ? opts.degradedWarnIntervalMs
      : 30 * 60 * 1000;
    degradedTimer = setInterval(() => {
      if (stopping) return;
      try {
        const fresh = loadConfig();
        Object.assign(config, fresh);
        configDegraded = false;
        clearInterval(degradedTimer);
        degradedTimer = null;
        logDaemon('info', 'config.json 已恢复可解析，daemon 已热加载新配置（watcher 监听路径如有变化需 hub daemon stop → start 生效）');
      } catch {
        logDaemon('warn', 'config.json 解析失败，正在使用缺省配置，请修复后重启 daemon');
      }
    }, degradedMs);
  }

  // 6. 优雅停止：停 watcher、清定时器、释放 pid 锁，exit 0（KeepAlive 不重拉）
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    logDaemon('info', `收到 ${sig}，优雅停止`);
    clearInterval(distillTimer);
    clearInterval(writebackTimer);
    if (degradedTimer) clearInterval(degradedTimer);
    try {
      await watcher.stop();
    } catch (err) {
      logDaemon('error', `watcher 停止异常: ${err.message}`);
    }
    releasePidLock();
    logDaemon('info', 'daemon 已停止，pid 锁已释放');
    process.exit(0);
  };
  const onSigint = () => shutdown('SIGINT');
  const onSigterm = () => shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  await watcher.whenReady();
  // H3：watcher 就绪即视为启动成功，重置连续失败计数
  resetCrashCount();
  logDaemon('info', 'watcher 就绪，daemon 进入常驻循环');

  return {
    watcher,
    /** 测试/内部用：不退出进程地停止全部资源 */
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(distillTimer);
      clearInterval(writebackTimer);
      if (degradedTimer) clearInterval(degradedTimer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await watcher.stop();
      releasePidLock();
      logDaemon('info', 'daemon 已停止（stop 句柄），pid 锁已释放');
    },
  };
}
