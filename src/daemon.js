/**
 * daemon.js —— Memory Hub 后台守护（hub daemon）。
 *
 * 职责：
 * - pid O_EXCL 锁（state/daemon.pid）：存在且进程活着则拒绝二次启动，陈旧锁自动清理；
 * - daemon 主循环（runDaemon）：启动 watcher 监听摄取 + 事件驱动增量调度 ——
 *   watcher 每次真实摄取喂入变更累计窗口，窗口内条数/体积达阈值即（静默合并后）
 *   触发一轮 pipeline（distill → 有新页面立即 writeback，无需手动触发）；
 *   低于阈值的零星变更留给每小时一次的兜底扫描；启动后自动对账追赶停机
 *   期间的欠账。LLM 未配置时优雅降级，绝不做崩溃重试风暴；writeback 绝不传
 *   forceBatch3 —— 一律遵守 config.writeback.batch3Enabled；
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
import { compact, compactDue } from './compact.js';
import { promoteScan, promoteScanDue } from './promote.js';
import { primeApiKeyCache } from './keys.js';
import { appendLogEntry, rotateLogFile } from './util/log.js';

/** launchd 服务标签 */
export const LAUNCHD_LABEL = 'com.kuangju.memory-hub';

/** 兜底全量扫描间隔：1 小时（事件静默/低于阈值时的整理 + 写回幂等校验） */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** 事件触发阈值：窗口内摄取快照条数（达到即提前触发 pipeline） */
export const TRIGGER_COUNT = 5;
/** 事件触发阈值：窗口内摄取正文体积（字节估算） */
export const TRIGGER_BYTES = 64 * 1024;
/** 达阈值后的静默合并窗口：等编辑风暴平息再统一整理（每次新变更重置，省 token） */
export const QUIET_MS = 2 * 60 * 1000;
/** 达阈值后的最长推迟：持续编辑也不无限期推迟 */
export const MAX_DELAY_MS = 10 * 60 * 1000;
/** 启动追赶延迟：watcher 就绪后稍等稳定，再对账并补跑停机期间的欠账 */
export const STARTUP_CATCHUP_MS = 30 * 1000;

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
 * daemon 健康档案路径：state/daemon-health.json。
 * 背景：daemon 常驻进程的运行时故障（如 watcher 万级 fd 致 spawn EBADF 读不到
 * Keychain）在 CLI 上下文无法复现，外部只能翻日志猜；此档案由 daemon 自证：
 * 预热结果 + 每轮 pipeline 各环节结果 + 最近一次 LLM 成功时间，供 doctor 检查。
 */
export function daemonHealthPath() {
  return path.join(paths.state, 'daemon-health.json');
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
    // chokidar 4（无 fsevents）在 macOS 上每监听文件占一个 kqueue fd，万级文件目录
    // 会顶满 launchd 缺省 fd 上限（256/10240）导致 spawnSync EBADF（读 Keychain 失败）
    '  <key>SoftResourceLimits</key>',
    '  <dict>',
    '    <key>NumberOfFiles</key>',
    '    <integer>65536</integer>',
    '  </dict>',
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
 * 流程：pid O_EXCL 锁 → 启动 watcher（onIngest 喂入变更累计窗口）→ 事件驱动调度
 * （窗口内条数/体积达阈值 → 静默合并 → pipeline：distill → 有新页面立即 writeback）
 * + 每小时兜底扫描 + 启动追赶对账 → SIGINT/SIGTERM 优雅停止。
 * 错误一律记录日志后继续，不退出、不重试风暴。
 *
 * @param {{
 *   config?: Object,              // 配置；缺省 loadConfig()
 *   sweepIntervalMs?: number,     // 兜底扫描间隔（缺省 config.daemon.sweepIntervalMs / 1 小时）
 *   triggerCount?: number,        // 窗口条数阈值（缺省 config.daemon.triggerCount / 5）
 *   triggerBytes?: number,        // 窗口体积阈值（缺省 config.daemon.triggerBytes / 64KB）
 *   quietMs?: number,             // 达阈值后静默合并窗口（缺省 config.daemon.quietMs / 2 分钟）
 *   maxDelayMs?: number,          // 达阈值后最长推迟（缺省 config.daemon.maxDelayMs / 10 分钟）
 *   startupCatchupMs?: number,    // 启动追赶延迟（缺省 30s）
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

  const dcfg = config.daemon || {};
  const sweepMs = opts.sweepIntervalMs ?? dcfg.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const triggerCount = opts.triggerCount ?? dcfg.triggerCount ?? TRIGGER_COUNT;
  const triggerBytes = opts.triggerBytes ?? dcfg.triggerBytes ?? TRIGGER_BYTES;
  const quietMs = opts.quietMs ?? dcfg.quietMs ?? QUIET_MS;
  const maxDelayMs = opts.maxDelayMs ?? dcfg.maxDelayMs ?? MAX_DELAY_MS;
  const startupCatchupMs = opts.startupCatchupMs ?? STARTUP_CATCHUP_MS;
  const distillFn = opts.distillFn || distill;
  const writebackFn = opts.writebackFn || runWriteback;
  const compactFn = opts.compactFn || compact;
  const compactDueFn = opts.compactDueFn || compactDue;
  // 晋升提名调度（同 compact 模式：可注入，兜底轮到期触发）
  const promoteScanFn = opts.promoteScanFn || promoteScan;
  const promoteScanDueFn = opts.promoteScanDueFn || promoteScanDue;

  logDaemon(
    'info',
    `daemon 启动 pid=${process.pid} 兜底扫描=${sweepMs}ms 触发阈值=${triggerCount}条/${triggerBytes}字节 静默窗口=${quietMs}ms 最长推迟=${maxDelayMs}ms`,
  );

  let stopping = false;

  // 健康档案：daemon 运行时自证（预热/每轮环节结果/最近 LLM 成功时间），
  // 写失败只降级不影响主流程；doctor 据此判断「存活但 LLM 从未成功」类故障
  const health = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    prime: null,
    lastRound: null,
    lastLlmSuccessAt: null,
    updatedAt: null,
  };
  const saveHealth = () => {
    try {
      health.updatedAt = new Date().toISOString();
      atomicWrite(daemonHealthPath(), `${JSON.stringify(health, null, 2)}\n`);
    } catch (err) {
      logDaemon('warn', `健康档案写入失败（不影响主流程）: ${err.message}`);
    }
  };

  // 2. 事件驱动调度：变更累计窗口 + 静默合并 + 最长推迟兜底。
  // 低于阈值的零星变更不单独触发（留给兜底扫描），避免频繁 LLM 调用烧 token。
  const acc = { count: 0, bytes: 0 };
  let quietTimer = null;
  let deadlineTimer = null;
  let startupTimer = null;
  let pipelineBusy = false;
  let pipelineRerun = false;

  const clearTriggerTimers = () => {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };

  const firePipeline = (reason) => {
    clearTriggerTimers();
    runPipeline(reason); // 异步执行，异常内部消化
  };

  // watcher 每次真实摄取回调：累计窗口，达阈值后进入静默合并（每次新变更重置，
  // deadline 保证持续编辑也不会无限期推迟）
  const onIngest = (info) => {
    if (stopping) return;
    acc.count += info.count || 0;
    acc.bytes += info.bytes || 0;
    if (acc.count < triggerCount && acc.bytes < triggerBytes) return; // 低于阈值：等兜底扫描
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => firePipeline('阈值触发'), quietMs);
    if (quietTimer.unref) quietTimer.unref();
    if (!deadlineTimer) {
      deadlineTimer = setTimeout(() => firePipeline('阈值触发-最长推迟到期'), maxDelayMs);
      if (deadlineTimer.unref) deadlineTimer.unref();
    }
  };

  // pipeline：distill →（产出新页面立即）writeback，一气呵成，无需手动触发；
  // 兜底轮（扫描/追赶）额外跑一次写回幂等校验，补齐上轮写回失败的欠账。
  async function runPipeline(reason) {
    if (stopping) return;
    if (pipelineBusy) {
      pipelineRerun = true; // 忙则记账，跑完立刻补一轮（变更已在窗口里，不丢）
      return;
    }
    pipelineBusy = true;
    const window = { count: acc.count, bytes: acc.bytes };
    acc.count = 0;
    acc.bytes = 0;
    const isSweep = reason !== '阈值触发' && reason !== '阈值触发-最长推迟到期';
    let hasBacklog = false; // 本轮受 maxBatches 限额未处理完的积压批次
    // 本轮健康记录：各环节 ok/error 落档，finally 统一写入健康档案
    const round = { reason, at: new Date().toISOString(), distill: null, compact: null, promote: null, writeback: null, error: null };
    try {
      let distilledNew = false;
      const r = await distillFn({ config });
      if (!r.ok) {
        round.distill = { ok: false, error: r.error };
        logDaemon('warn', `[${reason}] distill 降级跳过（sources 保留，下轮再试）: ${r.error}`);
      } else if (r.pending > 0) {
        distilledNew = (r.written?.length ?? 0) > 0;
        hasBacklog = Number.isFinite(r.totalBatches) && r.totalBatches > (r.batches ?? 0);
        round.distill = { ok: true, pending: r.pending, written: r.written?.length ?? 0, batches: r.batches ?? 0 };
        // 有真实产出即视为 LLM 通路验证成功（pending=0 轮次不发起调用，不计）
        if (distilledNew) health.lastLlmSuccessAt = new Date().toISOString();
        logDaemon(
          'info',
          `[${reason}] distill 完成: ${r.pending} 条快照（窗口累计 ${window.count} 条/${window.bytes} 字节）→ ${r.written?.length ?? 0} 个页面${hasBacklog ? `，尚余 ${r.totalBatches - r.batches} 批积压，稍后续跑` : ''}`,
        );
      }
      // pending === 0 且非兜底轮时无事发生，不打扰日志

      // wiki 全局归并（compact）：只在兜底/追赶轮且到期（缺省 24h）时触发，
      // 避开活跃编辑窗口；归并产物登记 pending-writeback，由后续写回同步 App 侧
      let compacted = false;
      if (isSweep && compactDueFn(config)) {
        try {
          const c = await compactFn({ config });
          if (!c.ok) {
            round.compact = { ok: false, error: c.error };
            logDaemon('warn', `[${reason}] compact 降级跳过（下轮重试）: ${c.error}`);
          } else if ((c.merged?.length ?? 0) > 0) {
            compacted = true;
            round.compact = { ok: true, merged: c.merged.length, llmCalls: c.llmCalls ?? 0 };
            if ((c.llmCalls ?? 0) > 0) health.lastLlmSuccessAt = new Date().toISOString();
            logDaemon(
              'info',
              `[${reason}] compact 完成: ${c.clustersDone}/${c.clusters} 簇（LLM 调用 ${c.llmCalls} 次）→ 归并出 ${c.merged.length} 页、删除 ${c.removedPages.length} 页${c.error ? `（部分块失败: ${c.error}）` : ''}`,
            );
          }
        } catch (err) {
          round.compact = { ok: false, error: err.message };
          logDaemon('warn', `[${reason}] compact 异常（跳过，下轮重试）: ${err.message}`);
        }
      }

      // 晋升提名（promote scan）：只在兜底/追赶轮且到期（缺省每周）时触发；
      // 只产出提名清单供用户 hub promote list/apply 确认，不自动写 core 页
      if (isSweep && promoteScanDueFn(config)) {
        try {
          const p = await promoteScanFn({ config });
          if (!p.ok) {
            round.promote = { ok: false, error: p.error };
            logDaemon('warn', `[${reason}] promote scan 跳过: ${p.error}`);
          } else if (p.nominated > 0) {
            round.promote = { ok: true, nominated: p.nominated, llm: p.llm };
            logDaemon(
              'info',
              `[${reason}] promote scan 完成: 扫描 ${p.scanned} 页→提名 ${p.nominated} 条（LLM: ${p.llm}），运行 hub promote list 确认`,
            );
          }
        } catch (err) {
          round.promote = { ok: false, error: err.message };
          logDaemon('warn', `[${reason}] promote scan 异常（跳过，下轮重试）: ${err.message}`);
        }
      }

      if (distilledNew || compacted || isSweep) {
        const entries = wikiToEntries();
        if (entries.length > 0) {
          const w = await writebackFn({ config }); // 绝不传 forceBatch3，遵守 batch3Enabled 门禁
          const summary = (w.appResults || []).map((a) => `${a.app}:${a.status}`).join(', ');
          round.writeback = { ok: !(w.appResults || []).some((a) => a.status === 'failed'), apps: summary };
          const noteworthy = (w.appResults || []).some((a) => a.status === 'written' || a.status === 'failed');
          // 兜底轮全为幂等跳过时不刷日志，避免每小时一条噪音
          if (noteworthy || distilledNew || compacted) {
            logDaemon('info', `[${reason}] writeback 完成: ${entries.length} 条目（${summary || '无适配器'}）`);
          }
        }
      }
    } catch (err) {
      round.error = err.message;
      logDaemon('error', `[${reason}] pipeline 异常: ${err.message}`);
    } finally {
      health.lastRound = round;
      saveHealth();
      pipelineBusy = false;
      if (pipelineRerun || (hasBacklog && !stopping)) {
        // 积压未清（如停机欠账首次追赶）或运行期间又有触发：稍作喘息后续跑，
        // 直到清底，不等下一个兜底扫描
        pipelineRerun = false;
        const t = setTimeout(() => runPipeline('补跑'), 5000);
        if (t.unref) t.unref();
      }
    }
  }

  // 3. 启动 watcher 前预热 API Key：watcher（chokidar 4 kqueue）持有万级常开 fd 后，
  // macOS 26 的 posix_spawn 必现 EBADF，常驻期间无法再调 security 读 Keychain；
  // 此刻 spawn 仍可用，先把密钥预热进内存（失败只降级告警，LLM 环节照旧跳过重试）
  try {
    const primed = primeApiKeyCache();
    health.prime = { ok: true, primed, at: new Date().toISOString() };
    logDaemon('info', primed ? 'API Key 已预热到进程内存（watcher 启动后 Keychain 不可用，走缓存）' : 'llm.keyRef 未配置，跳过 API Key 预热');
  } catch (err) {
    health.prime = { ok: false, error: err.message, at: new Date().toISOString() };
    logDaemon('warn', `API Key 预热失败（LLM 环节将降级跳过）: ${err.message}`);
  }
  saveHealth();

  // 3.1 启动 watcher（信号由 daemon 统一接管；onIngest 喂入变更累计窗口）
  const watcher = new Watcher(config, { onIngest });
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

  // 4. 兜底扫描：每 sweepMs 一轮（摄取层对账由 watcher 60s 轮询负责，这里补跑
  // 低于阈值的零星变更整理 + 写回幂等校验，即“1 小时兜底”）
  const sweepTimer = setInterval(() => firePipeline('兜底扫描'), sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

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
    clearInterval(sweepTimer);
    clearTriggerTimers();
    if (startupTimer) clearTimeout(startupTimer);
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

  // 7. 启动追赶：稍等稳定后先对账补摄取停机期间的变更，再补跑一轮 pipeline
  // （无需手动 hub sync，停机欠账自动收敛）
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (stopping) return;
    try {
      watcher.reconcile();
    } catch (err) {
      logDaemon('warn', `启动对账异常: ${err.message}`);
    }
    firePipeline('启动追赶');
  }, startupCatchupMs);
  if (startupTimer.unref) startupTimer.unref();

  return {
    watcher,
    /** 测试/内部用：不退出进程地停止全部资源 */
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(sweepTimer);
      clearTriggerTimers();
      if (startupTimer) clearTimeout(startupTimer);
      if (degradedTimer) clearInterval(degradedTimer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await watcher.stop();
      releasePidLock();
      logDaemon('info', 'daemon 已停止（stop 句柄），pid 锁已释放');
    },
  };
}
