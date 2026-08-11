/**
 * test/test-lock.js —— util/lock.js 跨进程锁自测（H1）。
 *
 * 覆盖：
 * 1. withLock 基本互斥与释放（同步/async fn）；
 * 2. 陈旧锁清理（持锁 pid 已死 → 自动重抢）；
 * 3. 抢锁超时兜底（锁被存活进程长期持有 → 抛明确错误）；
 * 4. 多进程并发不丢更新：N 个子进程各自 withLock 对同一 JSON 做 RMW 自增，
 *    最终计数 = N × M（无锁时必丢更新）；
 * 5. 多进程并发 registerInflight 不丢条目（H1 核心场景：daemon 与 CLI 并发）；
 * 6. H6 心跳机制：心跳新鲜时锁龄再大也不可破、心跳僵死/pid 已死可破、
 *    持锁期间心跳续期、异常路径定时器不泄漏、等待期间打印持有者提示。
 *
 * 运行：npm test 或 node test/test-lock.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  withLock,
  lockPathFor,
  isPidAlive,
  LOCK_TIMEOUT_MS,
  LOCK_STALE_MS,
  LOCK_HEARTBEAT_MS,
} from '../src/util/lock.js';

const tmpRoots = [];

function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** 也切 MEMORY_HUB_ROOT，供 inflight 相关用例隔离 */
function freshHubRoot() {
  const dir = freshDir('mh-lock-root-');
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 找一个必然不存活的 pid（超出系统 pid 上限，kill 探测必 ESRCH） */
function deadPid() {
  let pid = 4000000;
  while (isPidAlive(pid)) pid += 100007;
  return pid;
}

/** 启动一个 node 子进程执行 ESM 内联脚本，返回退出 Promise */
function runChild(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`子进程退出码 ${code}: ${err}`));
    });
  });
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock：同步 fn 互斥执行且执行后释放锁', () => {
  const dir = freshDir('mh-lock-basic-');
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{}');
  const r = withLock(file, () => 42);
  assert.equal(r, 42);
  assert.equal(fs.existsSync(lockPathFor(file)), false, '执行后锁文件应已释放');
});

test('withLock：async fn settle 之后才释放锁', async () => {
  const dir = freshDir('mh-lock-async-');
  const file = path.join(dir, 'state.json');
  let released = false;
  const lockFile = lockPathFor(file);
  const p = withLock(file, async () => {
    await new Promise((r) => setTimeout(r, 50));
    released = !fs.existsSync(lockFile) === false && true; // 此时锁仍在
    return 'done';
  });
  // 持锁期间锁文件存在
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(await p, 'done');
  assert.equal(released, true, 'async 临界区内锁应保持');
  assert.equal(fs.existsSync(lockFile), false, 'settle 后锁文件应已释放');
});

test('withLock：fn 抛错也释放锁', () => {
  const dir = freshDir('mh-lock-throw-');
  const file = path.join(dir, 'state.json');
  assert.throws(() => withLock(file, () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(fs.existsSync(lockPathFor(file)), false);
});

test('withLock：陈旧锁（持锁 pid 已死）自动清理并重抢', () => {
  const dir = freshDir('mh-lock-stale-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid(), ts: Date.now() }));
  const r = withLock(file, () => 'reclaimed');
  assert.equal(r, 'reclaimed');
  assert.equal(fs.existsSync(lockFile), false);
});

test('withLock：锁被存活进程持有时抢锁超时抛出明确错误', () => {
  const dir = freshDir('mh-lock-timeout-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  // 用当前进程 pid 伪造一把“正在被持有”的锁
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  assert.throws(
    () => withLock(file, () => 'never', { timeoutMs: 200 }),
    /抢锁超时/,
  );
  fs.rmSync(lockFile, { force: true });
});

test('H1 多进程并发：N 个子进程 RMW 同一 JSON 计数不丢更新', async () => {
  const dir = freshDir('mh-lock-mp-');
  const file = path.join(dir, 'counter.json');
  fs.writeFileSync(file, JSON.stringify({ count: 0 }));
  const N = 6; // 子进程数
  const M = 25; // 每进程 RMW 次数
  const script = `
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(`${SRC}util/lock.js`)};
    const file = process.argv[1];
    const M = Number(process.argv[2]);
    for (let i = 0; i < M; i += 1) {
      withLock(file, () => {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        j.count += 1;
        fs.writeFileSync(file, JSON.stringify(j));
      });
    }
  `;
  await Promise.all(
    Array.from({ length: N }, () => runChild(script, [file, String(M)])),
  );
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(final.count, N * M, `${N} 进程 × ${M} 次 RMW 不得丢更新`);
});

test('H1 多进程并发：并发 registerInflight 不丢条目（daemon 与 CLI 并发场景）', async () => {
  freshHubRoot();
  const N = 8; // 子进程数（每进程登记 1 条互不相同的条目）
  const script = `
    import { registerInflight } from ${JSON.stringify(`${SRC}inflight.js`)};
    const id = process.argv[1];
    registerInflight('/tmp/mh-mp-' + id, 'sha-' + id);
  `;
  await Promise.all(
    Array.from({ length: N }, (_, i) => runChild(script, [`proc-${i}`])),
  );
  const { loadInflightEntries } = await import('../src/inflight.js');
  const entries = loadInflightEntries();
  for (let i = 0; i < N; i += 1) {
    assert.ok(entries[`/tmp/mh-mp-proc-${i}`], `条目 proc-${i} 不得丢失`);
  }
});

// ---------------------------------------------------------------------------
// RV-O1：.lock 结尾的目标不追加双后缀（全局写回锁实际文件就是 state/write.lock）
// ---------------------------------------------------------------------------

test('RV-O1：lockPathFor 对 .lock 结尾目标不再追加后缀，普通目标仍追加', () => {
  assert.equal(lockPathFor('/x/state/write.lock'), '/x/state/write.lock', '不得出现 write.lock.lock');
  assert.equal(lockPathFor('/x/state/inflight.json'), '/x/state/inflight.json.lock');
});

test('RV-O1：全局写回锁持锁期间实际锁文件恰为 state/write.lock', async () => {
  freshHubRoot();
  const { writeLockPath } = await import('../src/writeback.js');
  const lockTarget = writeLockPath();
  assert.equal(lockTarget.endsWith(path.join('state', 'write.lock')), true);
  await withLock(lockTarget, async () => {
    assert.equal(fs.existsSync(lockTarget), true, '持锁期间应存在 state/write.lock');
    assert.equal(fs.existsSync(`${lockTarget}.lock`), false, 'write.lock.lock 双后缀不得存在');
  });
  assert.equal(fs.existsSync(lockTarget), false, '释放后锁文件应已删除');
});

// ---------------------------------------------------------------------------
// H6：锁心跳机制——陈旧判定改为「pid 不存活 或 心跳（mtime）超限」，不再按创建时间判龄
// ---------------------------------------------------------------------------

test('H6：阈值升级——等待超时 120s、心跳陈旧阈值 3 分钟、心跳间隔 ~20s', () => {
  assert.equal(LOCK_TIMEOUT_MS, 120 * 1000, '排队方等待超时须大于一次写回的最长持锁时长（90s+）');
  assert.equal(LOCK_STALE_MS, 3 * 60 * 1000);
  assert.equal(LOCK_HEARTBEAT_MS, 20 * 1000);
  assert.ok(LOCK_HEARTBEAT_MS * 3 < LOCK_STALE_MS, '陈旧阈值须留多个心跳周期的冗余');
});

test('H6 防破锁：持锁 pid 存活且心跳新鲜时，创建时间再久也不可破（只能超时）', () => {
  const dir = freshDir('mh-lock-h6-keep-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  // 旧实现的击穿场景：ts（创建时间）已过 10 分钟，但持锁进程存活且 mtime（心跳）新鲜——
  // 旧版按锁龄 60s 判陈旧会删锁闯入；新版必须抢锁超时而非破锁（v:2 心跳协议锁）
  fs.writeFileSync(lockFile, JSON.stringify({ v: 2, pid: process.pid, ts: Date.now() - 10 * 60 * 1000 }));
  assert.throws(
    () => withLock(file, () => 'never', { timeoutMs: 300 }),
    /抢锁超时/,
    '心跳新鲜的活锁绝不可被破除',
  );
  assert.equal(fs.existsSync(lockFile), true, '锁文件应完好无损（未被误删）');
  fs.rmSync(lockFile, { force: true });
});

test('H6 可破锁：持锁 pid 存活但心跳（mtime）超过 3 分钟 → 判僵死可破', () => {
  const dir = freshDir('mh-lock-h6-dead-hb-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  fs.writeFileSync(lockFile, JSON.stringify({ v: 2, pid: process.pid, ts: Date.now() }));
  // 把心跳（mtime）回拨到 4 分钟前：模拟持锁进程僵死/pid 被复用（复用者不会续期）
  const old = new Date(Date.now() - 4 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const r = withLock(file, () => 'reclaimed', { timeoutMs: 500 });
  assert.equal(r, 'reclaimed', '心跳僵死的锁应可被破除重抢');
  assert.equal(fs.existsSync(lockFile), false);
});

test('H6 可破锁：持锁 pid 已死 → 心跳再新鲜也立即可破', () => {
  const dir = freshDir('mh-lock-h6-dead-pid-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  // mtime 新鲜（刚写入）但 pid 必死 → 不等心跳超限，立即判陈旧
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid(), ts: Date.now() }));
  const r = withLock(file, () => 'ok', { timeoutMs: 500 });
  assert.equal(r, 'ok');
  assert.equal(fs.existsSync(lockFile), false);
});

test('H6 心跳续期：async 长临界区内锁文件 mtime 被周期 touch 刷新', async () => {
  const dir = freshDir('mh-lock-h6-hb-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  let mtimeAtStart = 0;
  let mtimeNearEnd = 0;
  await withLock(
    file,
    async () => {
      mtimeAtStart = fs.statSync(lockFile).mtimeMs;
      // 把 mtime 人为回拨 10 分钟：若心跳真在跳，会把它 touch 回当前时间
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(lockFile, old, old);
      await new Promise((r) => setTimeout(r, 200)); // 跨越至少 4 个心跳周期（40ms）
      mtimeNearEnd = fs.statSync(lockFile).mtimeMs;
      return 'held';
    },
    { heartbeatMs: 40 },
  );
  assert.ok(mtimeAtStart > 0);
  assert.ok(
    Date.now() - mtimeNearEnd < 5 * 60 * 1000,
    `心跳应把回拨 10 分钟的 mtime 重新 touch 至近期（实测距今 ${Date.now() - mtimeNearEnd}ms）`,
  );
  assert.equal(fs.existsSync(lockFile), false, '释放后锁文件应已删除');
});

test('H6 定时器清理：fn 抛错/正常返回后心跳停止，锁不会被“幽灵心跳”复活', async () => {
  const dir = freshDir('mh-lock-h6-cleanup-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);

  // 异常路径：抛错后锁已释放，等足多个心跳周期，锁文件不得被残留定时器重建/重 touch
  assert.throws(
    () => withLock(file, () => {
      throw new Error('boom');
    }, { heartbeatMs: 30 }),
    /boom/,
  );
  assert.equal(fs.existsSync(lockFile), false);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fs.existsSync(lockFile), false, '心跳定时器应已清理，不得复活锁文件');

  // async 正常路径同理
  await withLock(file, async () => 'ok', { heartbeatMs: 30 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fs.existsSync(lockFile), false);
});

test('H6 等待提示：抢锁等待期间周期打印「等待锁中，持有者 pid=X」', () => {
  const dir = freshDir('mh-lock-h6-waitlog-');
  const file = path.join(dir, 'state.json');
  const lockFile = lockPathFor(file);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));

  const logs = [];
  const origError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    assert.throws(
      () => withLock(file, () => 'never', { timeoutMs: 250, waitLogMs: 60 }),
      /抢锁超时/,
    );
  } finally {
    console.error = origError;
    fs.rmSync(lockFile, { force: true });
  }
  const waitLogs = logs.filter((l) => l.includes('等待锁中'));
  assert.ok(waitLogs.length >= 1, `等待期间应至少打印一条提示（实得 ${logs.length} 条日志）`);
  assert.ok(waitLogs[0].includes(`pid=${process.pid}`), '提示应含持有者 pid');
});
