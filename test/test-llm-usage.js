/**
 * test/test-llm-usage.js —— LLM 预算台账与主动限频刹车自测。
 *
 * 背景：idealab 免费 AK 200 次/天 + 10 次/60 分钟，失败也计数；用户在线时段
 * 10:00-22:00，hub 需主动让位（hourlyCallCap/dailyCallCap）给交互使用留余量。
 *
 * 覆盖：
 * 1. 台账窗口滚动：小时窗超时清零、跨日清零、损坏文件从零开始；
 * 2. 预算规则：缺省（0/缺失）不启用；小时/日预算超额与 reason 关键字
 *    （日预算含「请明天再来」→ 既有冷却刹车路由到次日凌晨）；
 * 3. llmClient 集成：超额时不发请求直接抛 rateLimited；每次尝试都登记；
 * 4. 与冷却刹车联动：startLlmCooldown(日预算 reason) 冷却到本地次日凌晨。
 *
 * 全部在 MEMORY_HUB_ROOT 临时目录演练。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  llmUsagePath,
  loadLlmUsage,
  recordLlmCall,
  llmBudgetState,
  HOUR_WINDOW_MS,
} from '../src/llm-usage.js';
import { createLlmClient } from '../src/llmClient.js';
import { startLlmCooldown, llmCooldownRemaining } from '../src/distill.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-usage-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

after(() => {
  delete process.env.MEMORY_HUB_ROOT;
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结果
    }
  }
});

/** 写含预算配置的 config.json */
function writeCaps(root, caps) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ llm: { ...caps } }));
}

test('台账窗口滚动：小时窗超时清零、跨日清零、损坏文件从零开始', () => {
  freshHubRoot();
  const t0 = Date.parse('2026-09-01T03:00:00'); // 本地时间
  recordLlmCall(t0);
  recordLlmCall(t0 + 1000);
  let u = loadLlmUsage(t0 + 2000);
  assert.equal(u.dayCount, 2);
  assert.equal(u.hourCount, 2);

  // 小时窗超时：hourCount 清零，dayCount 保留
  u = loadLlmUsage(t0 + HOUR_WINDOW_MS + 1);
  assert.equal(u.dayCount, 2);
  assert.equal(u.hourCount, 0);

  // 跨日：全部清零
  u = loadLlmUsage(t0 + 24 * 60 * 60 * 1000);
  assert.equal(u.dayCount, 0);
  assert.equal(u.hourCount, 0);

  // 台账损坏：从零开始不崩溃
  fs.writeFileSync(llmUsagePath(), '{broken');
  u = loadLlmUsage(t0);
  assert.equal(u.dayCount, 0);
});

test('预算规则：缺省不启用；小时/日预算超额与 reason 关键字', () => {
  const root = freshHubRoot();
  const t0 = Date.parse('2026-09-01T10:00:00');
  for (let i = 0; i < 20; i += 1) recordLlmCall(t0 + i);

  // 缺省（无 config caps）：不启用，20 次也不刹
  assert.equal(llmBudgetState(t0 + 100).exceeded, false);

  // 小时预算 8：超额，reason 不含「请明天再来」（走 60 分钟冷却）
  writeCaps(root, { hourlyCallCap: 8 });
  const hourly = llmBudgetState(t0 + 100);
  assert.equal(hourly.exceeded, true);
  assert.match(hourly.reason, /小时 LLM 预算 8 次已用完/);
  assert.doesNotMatch(hourly.reason, /请明天再来/);

  // 小时窗过期后解除（日预算未配）
  assert.equal(llmBudgetState(t0 + HOUR_WINDOW_MS + 1).exceeded, false);

  // 日预算 15：超额，reason 含「请明天再来」
  writeCaps(root, { dailyCallCap: 15 });
  const daily = llmBudgetState(t0 + 100);
  assert.equal(daily.exceeded, true);
  assert.match(daily.reason, /今日 LLM 预算 15 次已用完/);
  assert.match(daily.reason, /请明天再来/);
});

test('llmClient 集成：超额直接抛 rateLimited 且不发请求；每次尝试都登记', async () => {
  const root = freshHubRoot();
  writeCaps(root, { hourlyCallCap: 2 });
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
  const client = createLlmClient({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetchImpl, budgetEnabled: true });

  assert.equal(await client.chat([{ role: 'user', content: 'a' }]), 'ok');
  assert.equal(await client.chat([{ role: 'user', content: 'b' }]), 'ok');
  assert.equal(fetchCalls, 2);
  assert.equal(loadLlmUsage().hourCount, 2, '每次真实请求前登记');

  // 第 3 次：预算刹车，rateLimited 且零请求
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'c' }]),
    (err) => err.rateLimited === true && /预算刹车/.test(err.message),
  );
  assert.equal(fetchCalls, 2, '超额后不再发真实请求');

  // 缺省行为：注入 fetchImpl 且未显式开启 → 不记账也不刹车（防测试污染真实台账）
  const mockOnly = createLlmClient({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', fetchImpl });
  assert.equal(await mockOnly.chat([{ role: 'user', content: 'd' }]), 'ok');
  assert.equal(loadLlmUsage().hourCount, 2, 'mock 客户端不记账');
});

test('与冷却刹车联动：日预算 reason 冷却到本地次日凌晨', () => {
  freshHubRoot();
  const now = Date.parse('2026-09-01T15:00:00');
  const until = startLlmCooldown('LLM 预算刹车: hub 今日 LLM 预算 150 次已用完，请明天再来', now);
  const untilMs = Date.parse(until);
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  assert.equal(untilMs, nextMidnight.getTime(), '冷却到本地次日凌晨（日额度重置点）');
  assert.ok(llmCooldownRemaining(now).remainMs > 8 * 60 * 60 * 1000);
});
