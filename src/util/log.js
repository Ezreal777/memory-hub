/**
 * util/log.js —— 统一日志追加入口（含滚动轮转，L1 修复）。
 *
 * watcher.log / daemon.log / launchd.*.log 此前无轮转，长期运行无限增长。
 * 现统一走 appendLogEntry：单文件超过 LOG_MAX_BYTES（5MB）即滚动——
 * file.log → file.log.1 → file.log.2 → file.log.3，仅保留最近 LOG_KEEP 份，
 * 最旧一份直接丢弃。滚动与追加失败均静默降级（日志绝不影响主流程）。
 *
 * launchd.out/err.log 由 launchd 直接追加、进程无法拦截，
 * 由 daemon 启动时调用 rotateLogFile 做一次同策略轮转。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

/** 单个日志文件滚动阈值：5MB */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 滚动保留份数：最近 3 份（不含当前活动文件） */
export const LOG_KEEP = 3;

/**
 * 滚动单个日志文件（幂等：文件不存在/未超限均不做任何事）。
 * file → file.1；既有 file.1 → file.2；依此类推，file.LOG_KEEP 被丢弃。
 * @param {string} file 日志文件绝对路径
 * @param {{ force?: boolean }} [opts] force=true 时无视大小阈值强制滚动
 * @returns {boolean} 是否发生了滚动
 */
export function rotateLogFile(file, opts = {}) {
  try {
    const st = fs.statSync(file);
    if (!opts.force && st.size < LOG_MAX_BYTES) return false;
    // 最旧一份先挪走/丢弃，再依次前移，避免覆盖
    fs.rmSync(`${file}.${LOG_KEEP}`, { force: true });
    for (let i = LOG_KEEP - 1; i >= 1; i -= 1) {
      if (fs.existsSync(`${file}.${i}`)) {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加一条日志（先按需滚动，再 appendFileSync）。失败静默。
 * @param {string} file 日志文件绝对路径
 * @param {string} line 完整日志行（调用方自行拼好时间戳/级别）
 */
export function appendLogEntry(file, line) {
  try {
    ensureDir(path.dirname(file));
    rotateLogFile(file);
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}
