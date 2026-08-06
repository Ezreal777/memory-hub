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
import { loadConfig } from './config.js';
import { Watcher } from './watcher.js';
import { distill } from './distill.js';
import { runWriteback, wikiToEntries } from './writeback.js';

/** launchd 服务标签 */
export const LAUNCHD_LABEL = 'com.kuangju.memory-hub';

/** distill 轮询间隔：5 分钟 */
export const DISTILL_INTERVAL_MS = 5 * 60 * 1000;
/** writeback 轮询间隔：10 分钟 */
export const WRITEBACK_INTERVAL_MS = 10 * 60 * 1000;

/** daemon 日志文件路径 */
export function daemonLogPath() {
  return path.join(paths.logs, 'daemon.log');
}

/**
 * 追加一条 daemon 日志（ISO 时间 + 级别 + 消息）。日志失败不影响主流程。
 * @param {string} level info / warn / error
 * @param {string} msg 日志内容（绝不包含密钥）
 */
export function logDaemon(level, msg) {
  try {
    ensureDir(paths.logs);
    fs.appendFileSync(daemonLogPath(), `${new Date().toISOString()}\t${level}\t${msg}\n`);
  } catch {
    // 日志失败静默
  }
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
  const r = spawnSync('which', ['node'], { encoding: 'utf8' });
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

/** 缺省 launchctl 执行器（spawnSync，返回 { status, stdout, stderr }） */
function defaultLaunchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
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
 * @param {Object} [opts] launchctl/uid 可注入
 * @returns {{ via: string }}
 */
export function startDaemon(opts = {}) {
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
 * }} [opts]
 * @returns {Promise<{ stop: Function }>} 控制句柄
 * @throws {Error} pid 锁被存活进程占用时抛出
 */
export async function runDaemon(opts = {}) {
  const config = opts.config || loadConfig();
  ensureHubDirs();

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

  let stopping = false;

  // 3. 定时 distill（静默批量；LLM 未配置/调用失败优雅降级，只记录不重试风暴）
  const distillTimer = setInterval(async () => {
    if (stopping) return;
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
    }
  }, distillMs);

  // 4. 定时 writeback（仅当 wiki 有条目；绝不传 forceBatch3，遵守 batch3Enabled 门禁）
  const writebackTimer = setInterval(async () => {
    if (stopping) return;
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
    }
  }, writebackMs);

  // 5. 优雅停止：停 watcher、清定时器、释放 pid 锁，exit 0（KeepAlive 不重拉）
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    logDaemon('info', `收到 ${sig}，优雅停止`);
    clearInterval(distillTimer);
    clearInterval(writebackTimer);
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
  logDaemon('info', 'watcher 就绪，daemon 进入常驻循环');

  return {
    watcher,
    /** 测试/内部用：不退出进程地停止全部资源 */
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(distillTimer);
      clearInterval(writebackTimer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await watcher.stop();
      releasePidLock();
      logDaemon('info', 'daemon 已停止（stop 句柄），pid 锁已释放');
    },
  };
}
