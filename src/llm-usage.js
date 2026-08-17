/**
 * llm-usage.js —— LLM 调用预算台账与主动限频刹车（供 llmClient 内嵌调用）。
 *
 * 背景：idealab 免费 AK 额度为 200 次/天 + 10 次/60 分钟，且失败调用照样计数；
 * 用户电脑在线时段约 10:00-22:00，若 hub 每小时烧满 10 次，用户自己的交互调用
 * 会持续撞小时限流。本模块让 hub 主动让位：
 * - 台账 state/llm-usage.json：{ date, dayCount, hourStart, hourCount }，
 *   每次真实发起 chat 前登记（含重试的每次尝试——网关同样计数）；
 * - 预算检查：config.llm.hourlyCallCap / dailyCallCap（0 或缺省 = 不启用）；
 *   超额由 llmClient 抛 rateLimited 错误，调用方走既有冷却刹车——
 *   日预算 reason 含「请明天再来」→ 冷却到本地次日凌晨；小时预算 → 冷却 60 分钟。
 *
 * 独立成模块的原因：llmClient 需要调用而 distill 依赖 llmClient，
 * 放 distill.js（冷却刹车所在地）会形成循环依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { storePaths } from './hub-store.js';
import { loadConfig } from './config.js';
import { withLock } from './util/lock.js';
import { atomicWrite } from './safe-write.js';
import { FILE_MODE } from './util/paths.js';

/** 小时预算的滚动窗口时长 */
export const HOUR_WINDOW_MS = 60 * 60 * 1000;

/** 用量台账文件：state/llm-usage.json */
export function llmUsagePath() {
  return path.join(storePaths.state, 'llm-usage.json');
}

/** 本地自然日字符串（YYYY-MM-DD，网关日额度按本地日重置） */
function localDateStr(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 读取台账并按当前时间滚动窗口（跨日清日计数、超时清小时窗口）。纯读不落盘。
 * @param {number} [nowMs]
 * @returns {{ date: string, dayCount: number, hourStart: string, hourCount: number }}
 */
export function loadLlmUsage(nowMs = Date.now()) {
  let u = null;
  try {
    u = JSON.parse(fs.readFileSync(llmUsagePath(), 'utf8'));
  } catch {
    // 无台账/损坏：从零开始
  }
  const today = localDateStr(nowMs);
  if (!u || typeof u !== 'object' || u.date !== today) {
    return { date: today, dayCount: 0, hourStart: new Date(nowMs).toISOString(), hourCount: 0 };
  }
  const hourStartMs = Date.parse(u.hourStart || '');
  if (!Number.isFinite(hourStartMs) || nowMs - hourStartMs >= HOUR_WINDOW_MS) {
    return { date: today, dayCount: u.dayCount || 0, hourStart: new Date(nowMs).toISOString(), hourCount: 0 };
  }
  return {
    date: today,
    dayCount: u.dayCount || 0,
    hourStart: u.hourStart,
    hourCount: u.hourCount || 0,
  };
}

/**
 * 登记一次 LLM 调用尝试（chat 每次真实发请求前调用，成功失败都计）。
 * @param {number} [nowMs]
 * @returns {{ dayCount: number, hourCount: number }} 登记后的计数
 */
export function recordLlmCall(nowMs = Date.now()) {
  let after = null;
  withLock(llmUsagePath(), () => {
    const u = loadLlmUsage(nowMs);
    u.dayCount += 1;
    u.hourCount += 1;
    atomicWrite(llmUsagePath(), `${JSON.stringify(u, null, 2)}\n`, { mode: FILE_MODE });
    after = { dayCount: u.dayCount, hourCount: u.hourCount };
  });
  return after;
}

/**
 * 预算检查：读 config.llm.hourlyCallCap / dailyCallCap（0/缺省 = 不启用）。
 * @param {number} [nowMs]
 * @returns {{ exceeded: boolean, reason: string, dayCount: number, hourCount: number,
 *   dailyCallCap: number, hourlyCallCap: number }}
 */
export function llmBudgetState(nowMs = Date.now()) {
  let llm = {};
  try {
    llm = loadConfig().llm || {};
  } catch {
    // 配置读不到：不启用预算（宁可放行也不误刹）
  }
  const dailyCallCap = Number(llm.dailyCallCap) || 0;
  const hourlyCallCap = Number(llm.hourlyCallCap) || 0;
  const u = loadLlmUsage(nowMs);
  const base = { dayCount: u.dayCount, hourCount: u.hourCount, dailyCallCap, hourlyCallCap };
  if (dailyCallCap > 0 && u.dayCount >= dailyCallCap) {
    return {
      ...base,
      exceeded: true,
      // 「请明天再来」是既有冷却刹车的时长路由关键字（冷却到本地次日凌晨）
      reason: `hub 今日 LLM 预算 ${dailyCallCap} 次已用完（已计 ${u.dayCount} 次，为交互使用保留余量），请明天再来`,
    };
  }
  if (hourlyCallCap > 0 && u.hourCount >= hourlyCallCap) {
    return {
      ...base,
      exceeded: true,
      reason: `hub 小时 LLM 预算 ${hourlyCallCap} 次已用完（窗口 ${u.hourStart} 起已计 ${u.hourCount} 次，为交互使用保留余量）`,
    };
  }
  return { ...base, exceeded: false, reason: '' };
}
