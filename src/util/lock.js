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
 * - 超时兜底：缺省 10s 未抢到锁抛出明确错误，绝不无限等待；
 * - 陈旧锁清理：锁文件内记录持锁 pid，pid 已死（或锁龄超过 STALE 阈值，
 *   覆盖 kill -9 来不及删锁的场景）即视为陈旧锁，删除后重抢。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, FILE_MODE } from './paths.js';

/** 抢锁缺省超时：10 秒 */
export const LOCK_TIMEOUT_MS = 10 * 1000;

/** 锁龄超过该时长一律视为陈旧锁（覆盖持锁进程被 kill -9 且 pid 恰好复用的极端场景） */
export const LOCK_STALE_MS = 60 * 1000;

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
 * 尝试抢占锁文件（O_EXCL 原子创建，内容为 { pid, ts } JSON）。
 * @param {string} lockFile 锁文件路径
 * @returns {boolean} true 抢到；false 锁被他人持有
 * @throws {Error} 非 EEXIST 的系统错误直接抛出
 */
function tryAcquire(lockFile) {
  try {
    const fd = fs.openSync(lockFile, 'wx'); // O_CREAT | O_EXCL
    try {
      fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`);
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
 * 判断现存锁是否为陈旧锁（持锁 pid 已死，或锁龄超过 STALE 阈值）。
 * @param {string} lockFile 锁文件路径
 * @returns {boolean}
 */
function isStaleLock(lockFile) {
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    // 内容不可读（半写/空文件）：再看文件年龄，超过 STALE 才清理，避免误删刚创建的锁
    try {
      return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false; // 恰好被删：交给下一轮 EEXIST/创建流程
    }
  }
  if (!info || typeof info !== 'object') return true; // 内容非法视为陈旧
  if (!isPidAlive(Number(info.pid))) return true;
  if (Number.isFinite(info.ts) && Date.now() - info.ts > LOCK_STALE_MS) return true;
  return false;
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
 * }} [opts]
 * @returns {T | Promise<T>} fn 的返回值（fn 为 async 时返回 Promise）
 * @throws {Error} 超时仍未抢到锁时抛出（含锁路径与超时时长）
 */
export function withLock(file, fn, opts = {}) {
  const lockFile = opts.lockFile || lockPathFor(file);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : LOCK_TIMEOUT_MS;
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + timeoutMs;
  let delay = 5;

  for (;;) {
    if (tryAcquire(lockFile)) break;
    // 陈旧锁（pid 已死 / 锁龄超限）：清理后立刻重抢（不 sleep，走 O_EXCL 防并发竞争）
    if (isStaleLock(lockFile)) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`withLock 抢锁超时（${timeoutMs}ms）：${lockFile} 被其他进程长期持有`);
    }
    // 随机退避：delay 指数放大（封顶 200ms）+ 0~50% 抖动，避免多进程同步碰撞
    sleepSync(delay + Math.floor(Math.random() * Math.max(1, delay >> 1)));
    delay = Math.min(delay * 2, 200);
  }

  const release = () => {
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
