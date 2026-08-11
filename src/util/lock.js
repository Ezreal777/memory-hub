/**
 * util/lock.js —— 跨进程文件互斥锁（H1 修复）。
 *
 * 背景：inflight.json / hash-state.json / config.json / writeback-log.json
 * 均为「读-改-写」整体覆盖的共享状态文件，daemon 与 CLI 并发时互相吞更新
 * （inflight 丢条目 → 回环抑制失效；hash-state 丢指纹 → 重复摄取等）。
 *
 * 实现：基于 O_EXCL lockfile 的跨进程互斥。
 * - withLock(target, fn)：抢占 `<target>.lock`（O_CREAT|O_EXCL 原子创建；
 *   target 已以 .lock 结尾时锁文件即 target 本身，避免双后缀），
 *   执行 fn 后释放；fn 可为同步或 async（async 时在 settle 后才释放）。
 * - 自旋重试 + 随机退避（初始 5ms 起步、指数放大至 200ms 封顶并叠加抖动）；
 * - 超时兜底：缺省 120s 未抢到锁抛出明确错误，绝不无限等待；
 *   等待期间周期性打印「等待锁中，持有者 pid=X」提示，避免用户误判卡死而重发命令；
 * - 心跳续期（H6 修复）：持锁方以 ~20s 间隔 touch 锁文件 mtime；
 *   陈旧判定 = 「持锁 pid 已死」或「心跳（mtime）距今超过 3 分钟」——
 *   不再按创建时间判龄（旧实现锁龄 60s 即判陈旧，而一次写回可持锁 90s+，
 *   会导致第二个进程删掉仍有效的锁闯入临界区，击穿 safe-write 互斥假设）。
 *   心跳同时覆盖 kill -9 + pid 复用的极端场景：复用者不会 touch 锁文件，3 分钟后自然判陈旧。
 * - 协议版本兼容（Task#10）：锁文件 JSON 带 `v: 2` 字段。旧版本进程写的锁
 *   （无 v 字段、也不会心跳续期）沿用旧语义判陈旧——pid 已死或创建时间戳 ts
 *   超过 60s——避免混版本运行时新代码等旧锁心跳等不到而误判活锁/破活锁双写。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, FILE_MODE } from './paths.js';

/** 抢锁缺省超时：120 秒（须大于一次写回的最长持锁时长，排队方不轻易放弃） */
export const LOCK_TIMEOUT_MS = 120 * 1000;

/** 心跳（锁文件 mtime）距今超过该时长视为陈旧锁（持锁方心跳间隔的 9 倍冗余） */
export const LOCK_STALE_MS = 3 * 60 * 1000;

/** 持锁方心跳间隔：~20s touch 一次锁文件 mtime */
export const LOCK_HEARTBEAT_MS = 20 * 1000;

/** 等待锁期间的提示日志间隔 */
export const LOCK_WAIT_LOG_MS = 15 * 1000;

/** 当前锁文件协议版本（v2 = 心跳续期语义；无 v 字段视为旧版锁） */
export const LOCK_PROTOCOL_VERSION = 2;

/** 旧版（无 v 字段）锁的陈旧阈值：创建时间戳 ts 距今超过 60s 即判陈旧（旧实现语义） */
export const LEGACY_LOCK_STALE_MS = 60 * 1000;

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
 * 目标文件对应的锁文件路径（同目录 `<file>.lock`）。
 * RV-O1：目标本身已以 `.lock` 结尾时直接复用（如全局写回锁 state/write.lock），
 * 避免出现 write.lock.lock 双后缀误导排障。
 * @param {string} file 被保护文件绝对路径
 * @returns {string}
 */
export function lockPathFor(file) {
  return file.endsWith('.lock') ? file : `${file}.lock`;
}

/** 同步休眠（Atomics.wait，不烧 CPU；失败退化为忙等） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 忙等兜底（正常环境不会走到这里）
    }
  }
}

/**
 * 尝试抢占锁文件（O_EXCL 原子创建，内容为 { v, pid, ts } JSON）。
 * @param {string} lockFile 锁文件路径
 * @returns {boolean} true 抢到；false 锁被他人持有
 * @throws {Error} 非 EEXIST 的系统错误直接抛出
 */
function tryAcquire(lockFile) {
  try {
    const fd = fs.openSync(lockFile, 'wx'); // O_CREAT | O_EXCL
    try {
      fs.writeSync(fd, `${JSON.stringify({ v: LOCK_PROTOCOL_VERSION, pid: process.pid, ts: Date.now() })}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(lockFile, FILE_MODE);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

/**
 * 判断现存锁是否为陈旧锁。
 * - v:2 锁（心跳协议）：持锁 pid 已死，或心跳（锁文件 mtime）距今超过 STALE 阈值。
 *   H6：绝不按创建时间（内容里的 ts）判龄——持锁进程存活且心跳新鲜时，锁永远有效。
 * - 旧版锁（无 v 字段，写锁进程不会心跳续期）：沿用旧语义——pid 已死，
 *   或创建时间戳 ts 距今超过 LEGACY_LOCK_STALE_MS（60s）即判陈旧。
 *   若按心跳判会因旧进程从不 touch mtime 而把活锁误判 3 分钟陈旧后破锁，导致双写。
 * @param {string} lockFile 锁文件路径
 * @returns {boolean}
 */
function isStaleLock(lockFile) {
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    // 内容不可读（半写/空文件）：只看心跳（mtime），超过 STALE 才清理，避免误删刚创建的锁
    try {
      return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false; // 恰好被删：交给下一轮 EEXIST/创建流程
    }
  }
  if (!info || typeof info !== 'object') return true; // 内容非法视为陈旧
  if (!isPidAlive(Number(info.pid))) return true;
  // 旧版锁（无 v 字段）：不心跳续期，按创建时间 ts 判龄（旧语义）
  if (info.v === undefined) {
    const ts = Number(info.ts);
    return !Number.isFinite(ts) || Date.now() - ts > LEGACY_LOCK_STALE_MS;
  }
  // v:2 锁：pid 存活时看心跳——持锁方每 LOCK_HEARTBEAT_MS touch 一次 mtime，超过 STALE 视为僵死
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // 恰好被删：交给下一轮
  }
}

/**
 * 读取锁文件中记录的持锁 pid（仅用于等待日志展示，读不到返回 null）。
 * @param {string} lockFile 锁文件路径
 * @returns {number | null}
 */
function readLockHolderPid(lockFile) {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return Number.isInteger(info?.pid) ? info.pid : null;
  } catch {
    return null;
  }
}

/**
 * 在跨进程互斥锁保护下执行 fn（对 file 的「读-改-写」必须整体包进来）。
 *
 * @template T
 * @param {string} file 被保护的目标文件路径（锁为其同目录 `<file>.lock`）
 * @param {() => T | Promise<T>} fn 临界区逻辑
 * @param {{
 *   timeoutMs?: number,   // 抢锁超时；缺省 LOCK_TIMEOUT_MS
 *   lockFile?: string,    // 自定义锁文件路径（如多个目标共用一把全局锁）
 *   heartbeatMs?: number, // 持锁心跳间隔；缺省 LOCK_HEARTBEAT_MS（测试可缩短）
 *   waitLogMs?: number,   // 等待提示日志间隔；缺省 LOCK_WAIT_LOG_MS（测试可缩短）
 * }} [opts]
 * @returns {T | Promise<T>} fn 的返回值（fn 为 async 时返回 Promise）
 * @throws {Error} 超时仍未抢到锁时抛出（含锁路径与超时时长）
 */
export function withLock(file, fn, opts = {}) {
  const lockFile = opts.lockFile || lockPathFor(file);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : LOCK_TIMEOUT_MS;
  const heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : LOCK_HEARTBEAT_MS;
  const waitLogMs = Number.isFinite(opts.waitLogMs) ? opts.waitLogMs : LOCK_WAIT_LOG_MS;
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  let nextWaitLogAt = Date.now() + waitLogMs;

  for (;;) {
    if (tryAcquire(lockFile)) break;
    // 陈旧锁（pid 已死 / 心跳超限）：清理后立刻重抢（不 sleep，走 O_EXCL 防并发竞争）
    if (isStaleLock(lockFile)) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`withLock 抢锁超时（${timeoutMs}ms）：${lockFile} 被其他进程长期持有`);
    }
    // 等待提示：周期性告知持有者 pid，避免用户误判卡死而 Ctrl-C 重发命令（重发正是破锁高发场景）
    if (Date.now() >= nextWaitLogAt) {
      const holder = readLockHolderPid(lockFile);
      console.error(`[lock] 等待锁中，持有者 pid=${holder ?? '未知'}：${lockFile}`);
      nextWaitLogAt = Date.now() + waitLogMs;
    }
    // 随机退避：delay 指数放大（封顶 200ms）+ 0~50% 抖动，避免多进程同步碰撞
    sleepSync(delay + Math.floor(Math.random() * Math.max(1, delay >> 1)));
    delay = Math.min(delay * 2, 200);
  }

  // 心跳续期：持锁期间周期 touch 锁文件 mtime，向等待方证明「我还活着」。
  // unref() 防止定时器泄漏阻止进程退出；锁文件被外力清除时 touch 失败静默（无从续期）。
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch {
      // 锁文件已不存在（被外力清理）：静默，等待 release 收尾
    }
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const release = () => {
    clearInterval(heartbeat); // 异常/正常路径都经此清理，绝不泄漏定时器
    fs.rmSync(lockFile, { force: true });
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    release();
    throw err;
  }
  // async fn：settle 之后才释放锁
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => {
        release();
        return v;
      },
      (err) => {
        release();
        throw err;
      },
    );
  }
  release();
  return result;
}
