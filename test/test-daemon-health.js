/**
 * test/test-daemon-health.js —— daemon 健康档案与 doctor「daemon LLM 健康」检查自测。
 *
 * 背景：daemon 常驻进程的运行时故障（watcher 万级 fd 致 spawn EBADF 读不到
 * Keychain）在 CLI 上下文无法复现，曾潜伏 3 天。本组测试验证故障自证链路：
 * 1. runDaemon 落盘 daemon-health.json（prime 结果 + 每轮环节结果 + LLM 成功时间）；
 * 2. checkDaemonHealth 各分级规则：未运行/档案缺失/预热失败/存活超阈值无 LLM 成功/
 *    成功陈旧/正常，负样本必须报 ❌（这是当初漏检的场景）。
 *
 * 全部在 MEMORY_HUB_ROOT 临时目录演练，伪 daemon 用当前测试进程 pid（天然存活）。
 *
 * 运行：npm test 或 node test/test-daemon-health.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { daemonPidPath, daemonHealthPath } from '../src/daemon.js';
import {
  checkDaemonHealth,
  DAEMON_LLM_SILENCE_FAIL_MS,
  DAEMON_LLM_STALE_WARN_MS,
} from '../src/doctor.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-health-'));
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

/** 伪造运行中的 daemon：pid 文件写当前测试进程（天然存活） */
function fakeRunningDaemon(root) {
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(daemonPidPath(), `${process.pid}\n`);
}

/** 写健康档案（pid 缺省当前进程） */
function writeHealth(fields = {}) {
  const health = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    prime: { ok: true, primed: true, at: new Date().toISOString() },
    lastRound: null,
    lastLlmSuccessAt: null,
    updatedAt: new Date().toISOString(),
    ...fields,
  };
  fs.writeFileSync(daemonHealthPath(), JSON.stringify(health, null, 2));
  return health;
}

/** 写含 llm.keyRef 的配置（checkDaemonHealth 只读 config.json） */
function writeConfig(root, llm = { keyRef: 'idealab-free' }) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ llm }));
}

test('checkDaemonHealth：从未启用 → ✅；曾运行但当前未运行 → ⚠️', () => {
  const root = freshHubRoot();
  // 无任何运行痕迹：未启用属正常状态
  const never = checkDaemonHealth();
  assert.equal(never.level, 'ok');
  assert.match(never.summary, /未启用/);

  // 健康档案存在（曾运行）但进程已死：停摆告警
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  writeHealth({ pid: 99999999 });
  const stopped = checkDaemonHealth();
  assert.equal(stopped.level, 'warn');
  assert.match(stopped.summary, /曾运行但当前未运行/);
});

test('checkDaemonHealth：运行中但健康档案缺失/陈旧 pid → ⚠️', () => {
  const root = freshHubRoot();
  fakeRunningDaemon(root);
  const missing = checkDaemonHealth();
  assert.equal(missing.level, 'warn');
  assert.match(missing.summary, /健康档案缺失或陈旧/);

  // 档案 pid 与运行中 daemon 不符（旧进程遗留）同样判陈旧
  writeHealth({ pid: 99999999 });
  const stale = checkDaemonHealth();
  assert.equal(stale.level, 'warn');
  assert.match(stale.summary, /缺失或陈旧/);
});

test('checkDaemonHealth：API Key 预热失败 → ❌（Keychain 通路断）', () => {
  const root = freshHubRoot();
  fakeRunningDaemon(root);
  writeConfig(root);
  writeHealth({ prime: { ok: false, error: 'spawn 失败 code=EBADF', at: new Date().toISOString() } });
  const c = checkDaemonHealth();
  assert.equal(c.level, 'fail');
  assert.match(c.summary, /预热失败/);
  assert.ok(c.details.some((d) => d.includes('EBADF')));
});

test('checkDaemonHealth：存活超 2 小时无任何 LLM 成功 → ❌（当初漏检的负样本）', () => {
  const root = freshHubRoot();
  fakeRunningDaemon(root);
  writeConfig(root);
  const now = Date.now();
  const startedAt = new Date(now - DAEMON_LLM_SILENCE_FAIL_MS - 60000).toISOString();
  writeHealth({
    startedAt,
    lastRound: {
      reason: '兜底扫描',
      at: new Date().toISOString(),
      distill: { ok: false, error: 'resolveApiKey 失败：Keychain 中不存在条目' },
      compact: null,
      promote: null,
      writeback: { ok: true, apps: 'qoder:written' },
      error: null,
    },
  });
  const c = checkDaemonHealth(now);
  assert.equal(c.level, 'fail');
  assert.match(c.summary, /LLM 从未成功/);
  assert.ok(c.details.some((d) => d.includes('resolveApiKey')), '环节错误透传到 details');

  // 同样档案但 keyRef 未配置：LLM 按配置关闭，不误报
  writeConfig(root, {});
  const off = checkDaemonHealth(now);
  assert.equal(off.level, 'ok');
  assert.match(off.summary, /keyRef 未配置/);
});

test('checkDaemonHealth：存活未超阈值无成功 → ✅；成功陈旧 → ⚠️；近期成功 → ✅', () => {
  const root = freshHubRoot();
  fakeRunningDaemon(root);
  writeConfig(root);
  const now = Date.now();

  // 刚启动 10 分钟、尚无成功：不误报
  writeHealth({ startedAt: new Date(now - 600000).toISOString() });
  assert.equal(checkDaemonHealth(now).level, 'ok');

  // 曾成功但距今超 24 小时：告警
  writeHealth({
    startedAt: new Date(now - 3 * 24 * 3600000).toISOString(),
    lastLlmSuccessAt: new Date(now - DAEMON_LLM_STALE_WARN_MS - 60000).toISOString(),
  });
  const stale = checkDaemonHealth(now);
  assert.equal(stale.level, 'warn');
  assert.match(stale.summary, /小时前/);

  // 近期成功：正常
  writeHealth({
    startedAt: new Date(now - 3 * 24 * 3600000).toISOString(),
    lastLlmSuccessAt: new Date(now - 3600000).toISOString(),
  });
  const ok = checkDaemonHealth(now);
  assert.equal(ok.level, 'ok');
  assert.match(ok.summary, /最近 LLM 成功/);
});
