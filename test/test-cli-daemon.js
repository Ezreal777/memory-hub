/**
 * test/test-cli-daemon.js —— CLI 收口 + daemon/launchd 自测（node:test）。
 *
 * 全部在 MEMORY_HUB_ROOT 隔离的临时目录演练；launchctl 一律用注入桩，
 * 绝不真正 bootstrap/bootout 真实 launchd 服务，绝不触碰真实 App 目录。
 *
 * 覆盖：
 * 1. pid O_EXCL 锁：存活 pid 拒绝二次启动、陈旧锁自动清理、释放后可重入；
 * 2. plist 生成内容正确（Label / ProgramArguments / RunAtLoad / KeepAlive /
 *    ThrottleInterval / StandardOutPath / StandardErrorPath / HOME）；
 * 3. install/uninstall 幂等（自定义 plist 输出路径 + launchctl 桩），
 *    bootstrap 失败回退 load；
 * 4. hub status 在隔离环境输出完整（app/daemon/watcher/distill/writeback-log/backups）；
 * 5. hub sync 在隔离环境跑通全链路（harvest → distill 优雅降级 → writeback）；
 * 6. hub backup + rollback：同一时间戳目录 + manifest 映射、无 manifest 拒绝执行、
 *    二次确认（取消不写入 / 确认恢复 / --yes 跳过）；
 * 7. daemon 主循环：启动持锁、二次启动拒绝、优雅停止释放锁、日志落盘；
 * 8. RV-O2：config 损坏降级期间周期性重复 warn，修复后热加载自动恢复。
 *
 * 运行：npm test 或 node test/test-cli-daemon.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfig, updateApp } from '../src/config.js';
import { paths, ensureHubDirs } from '../src/util/paths.js';
import { scanApps } from '../src/scan.js';
import {
  acquirePidLock,
  releasePidLock,
  daemonPidPath,
  daemonLogPath,
  buildPlist,
  installDaemon,
  uninstallDaemon,
  runDaemon,
  LAUNCHD_LABEL,
} from '../src/daemon.js';
import { getStatusReport, runSync, backupAllApps, rollbackBackup, resolveBackupDir } from '../src/cli.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cli-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 新建一个普通临时目录（伪造家目录 / app 记忆目录用）。 */
function freshTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** 递归写文件（自动建目录），返回绝对路径。 */
function writeAt(base, rel, content = '') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. pid O_EXCL 锁
// ---------------------------------------------------------------------------

test('pid 锁：伪造存活 pid 时拒绝二次启动；陈旧锁自动清理；释放后可重入', () => {
  freshHubRoot();
  ensureHubDirs();
  const pidFile = daemonPidPath();

  // 1) 预置一个【存活】进程的 pid（本进程）→ 必须拒绝
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  assert.throws(() => acquirePidLock(), /已在运行/);

  // 2) 陈旧锁：写入一个已退出子进程的 pid → 自动清理并抢锁成功
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(child.pid > 0, '测试前提：能拿到已退出子进程的 pid');
  fs.writeFileSync(pidFile, `${child.pid}\n`);
  acquirePidLock();
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(process.pid));

  // 3) 释放后可重入
  releasePidLock();
  assert.equal(fs.existsSync(pidFile), false);
  acquirePidLock();
  releasePidLock();
});

// ---------------------------------------------------------------------------
// 2. plist 生成
// ---------------------------------------------------------------------------

test('plist 生成：关键字段全部正确', () => {
  const plist = buildPlist({
    nodePath: '/opt/test/bin/node',
    cliPath: '/test/memory-hub/src/cli.js',
    home: '/Users/tester',
    logDir: '/Users/tester/.memory-hub/logs',
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.kuangju\.memory-hub<\/string>/);
  // ProgramArguments：node 绝对路径 + cli.js + daemon run
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<string>\/opt\/test\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/test\/memory-hub\/src\/cli\.js<\/string>/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  // RunAtLoad / KeepAlive{SuccessfulExit:false} / ThrottleInterval
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  // stdout/err 日志与 HOME 环境变量
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/tester\/\.memory-hub\/logs\/launchd\.out\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/tester\/\.memory-hub\/logs\/launchd\.err\.log<\/string>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>HOME<\/key>\s*<string>\/Users\/tester<\/string>/);
});

// ---------------------------------------------------------------------------
// 3. install / uninstall 幂等（launchctl 桩 + 自定义 plist 路径）
// ---------------------------------------------------------------------------

test('daemon install/uninstall：幂等 + bootstrap 失败回退 load', () => {
  freshHubRoot();
  const plistPath = path.join(freshTmpDir('mh-plist-'), `${LAUNCHD_LABEL}.plist`);
  const calls = [];
  const launchctl = (args) => {
    calls.push([...args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const opts = { plistPath, launchctl, uid: 501, nodePath: '/n', cliPath: '/c', home: '/h' };

  // 首次安装：写 plist + bootstrap
  const r1 = installDaemon(opts);
  assert.equal(r1.via, 'bootstrap');
  assert.equal(fs.existsSync(plistPath), true);
  assert.match(fs.readFileSync(plistPath, 'utf8'), /com\.kuangju\.memory-hub/);
  assert.ok(calls.some((c) => c[0] === 'bootstrap' && c[1] === 'gui/501' && c[2] === plistPath));

  // 重复安装：幂等（先 bootout 旧实例再重新 bootstrap，不报错）
  const r2 = installDaemon(opts);
  assert.equal(r2.via, 'bootstrap');
  assert.equal(fs.existsSync(plistPath), true);

  // bootstrap 失败 → 回退 load
  calls.length = 0;
  const fallback = (args) => {
    calls.push([...args]);
    if (args[0] === 'bootstrap') return { status: 5, stdout: '', stderr: 'Bootstrap failed' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const r3 = installDaemon({ ...opts, launchctl: fallback });
  assert.equal(r3.via, 'load');
  assert.ok(calls.some((c) => c[0] === 'load' && c[1] === plistPath));

  // 卸载：bootout + 删除 plist
  uninstallDaemon({ plistPath, launchctl, uid: 501 });
  assert.equal(fs.existsSync(plistPath), false);

  // 重复卸载：幂等，不报错
  assert.doesNotThrow(() => uninstallDaemon({ plistPath, launchctl, uid: 501 }));
});

// ---------------------------------------------------------------------------
// 4. hub status（隔离环境）
// ---------------------------------------------------------------------------

test('hub status：隔离环境输出一屏汇总（app/daemon/distill/writeback-log/backups）', () => {
  freshHubRoot();
  ensureHubDirs();
  loadConfig();
  updateApp('claude', { enabled: true, memory_paths: ['/tmp/fake-memory'] });

  // 种子数据：watcher.log / distill-state / writeback-log / 一个备份目录（内部状态已迁至底层 paths.state）
  fs.appendFileSync(path.join(paths.logs, 'watcher.log'), '2026-08-06T10:00:00.000Z\tclaude\tadd 摄取 1 条快照\t/tmp/fake-memory/x.md\n');
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(
    path.join(paths.state, 'distill-state.json'),
    JSON.stringify({ version: 1, processed: { 'hub-a': { page: 'p', at: '' }, 'hub-b': { page: 'p', at: '' } } }),
  );
  const log = [];
  for (let i = 1; i <= 6; i += 1) {
    log.push({ time: `2026-08-06T0${i}:00:00.000Z`, app: 'claude', hubId: `hub-${i}`, result: 'written', backupDir: null });
  }
  fs.writeFileSync(path.join(paths.state, 'writeback-log.json'), JSON.stringify(log));
  fs.mkdirSync(path.join(paths.backups, '2026-08-06T00-00-00-000Z'), { recursive: true });

  // launchctl 桩：未注册
  const report = getStatusReport({ launchctl: () => ({ status: 1, stdout: '', stderr: '' }) });

  assert.match(report, /claude/);
  assert.match(report, /已发现·启用/);
  assert.match(report, /\/tmp\/fake-memory/);
  assert.match(report, /daemon/);
  assert.match(report, /未运行/);
  assert.match(report, /watcher/);
  assert.match(report, /add 摄取 1 条快照/);
  assert.match(report, /已整理 hubId: 2/);
  // writeback-log 只显示最近 5 条：hub-6 在，hub-1 不在
  assert.match(report, /hub-6/);
  assert.ok(!/hub-1\s/.test(report), 'hub-1 应被截断（只保留最近 5 条）');
  assert.match(report, /现存 1 份/);
});

// ---------------------------------------------------------------------------
// 5. hub sync（隔离环境全链路）
// ---------------------------------------------------------------------------

test('hub sync：隔离环境跑通 harvest → distill 优雅降级 → writeback', async () => {
  freshHubRoot();
  const fakeHome = freshTmpDir('mh-cli-home-');
  // 伪造 claude 记忆目录：MEMORY.md 索引 + 一个独立条目文件
  writeAt(fakeHome, '.claude/projects/proj-a/memory/MEMORY.md', '- [测试记忆](test-memory.md) — 一句话摘要\n');
  writeAt(
    fakeHome,
    '.claude/projects/proj-a/memory/test-memory.md',
    '---\nname: 测试记忆\ndescription: 一句话摘要\n---\n这是条目正文。\n',
  );

  // scan 回填 config（只探测伪造家目录）
  const rows = scanApps({ home: fakeHome });
  assert.equal(rows.find((r) => r.id === 'claude').found, true);

  const result = await runSync();

  // 1) harvest：摄取到快照（仅条目文件 1 条；MEMORY.md 索引行不摄取，见 claude 适配器）
  assert.ok(result.ingested >= 1, `期望至少摄取 1 条快照，实际 ${result.ingested}`);
  const sourcesDir = path.join(paths.hub, 'sources', 'claude');
  assert.ok(fs.existsSync(sourcesDir) && fs.readdirSync(sourcesDir).length >= 1);

  // 2) distill：LLM 未配置 → 优雅降级（ok=false 且不抛异常）
  assert.equal(result.distill.ok, false);
  assert.match(String(result.distill.error), /llm|LLM/);

  // 3) writeback：wiki 为空 → 无可写回条目（不报错）
  assert.equal(result.writeback.entryCount, 0);
  assert.match(String(result.writeback.message), /wiki/);
});

// ---------------------------------------------------------------------------
// 6. backup + rollback（二次确认）
// ---------------------------------------------------------------------------

test('backup/rollback：同一时间戳备份 + manifest 映射 + 二次确认逻辑', async () => {
  freshHubRoot();
  ensureHubDirs();
  loadConfig();

  // 伪造一个已发现的 claude app：memory 目录内两个 .md
  const memDir = freshTmpDir('mh-cli-mem-');
  const originA = writeAt(memDir, 'MEMORY.md', 'index-v1\n');
  const originB = writeAt(memDir, 'note.md', 'note-v1\n');
  updateApp('claude', { enabled: true, memory_paths: [memDir] });

  // backup：全部文件归入同一时间戳目录 + manifest
  const { dir, count, manifest } = backupAllApps();
  assert.equal(count, 2);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.equal(Object.keys(manifest).length, 2);
  for (const [name, meta] of Object.entries(manifest)) {
    assert.equal(meta.app, 'claude');
    assert.ok(fs.existsSync(path.join(dir, name)));
  }

  // 修改原文件后：取消确认 → 不做任何写入
  fs.writeFileSync(originA, 'index-v2-modified\n');
  const cancelled = await rollbackBackup({ dir, confirm: async () => false });
  assert.equal(cancelled.cancelled, true);
  assert.equal(fs.readFileSync(originA, 'utf8'), 'index-v2-modified\n');

  // 确认 → 原子恢复
  const done = await rollbackBackup({ dir, confirm: async () => true });
  assert.equal(done.cancelled, false);
  assert.equal(fs.readFileSync(originA, 'utf8'), 'index-v1\n');
  assert.equal(fs.readFileSync(originB, 'utf8'), 'note-v1\n');

  // --yes 跳过确认
  fs.writeFileSync(originA, 'index-v3\n');
  await rollbackBackup({ dir, yes: true });
  assert.equal(fs.readFileSync(originA, 'utf8'), 'index-v1\n');

  // --app 过滤：该备份没有 codex 条目 → 明确报错
  await assert.rejects(() => rollbackBackup({ dir, app: 'codex', yes: true }), /没有可恢复的条目/);

  // 无 manifest 的备份目录 → 拒绝执行
  const badDir = freshTmpDir('mh-cli-badbackup-');
  fs.writeFileSync(path.join(badDir, 'claude__MEMORY.md'), 'whatever\n');
  await assert.rejects(() => rollbackBackup({ dir: badDir, yes: true }), /manifest/);
});

test('N3：rollback --dir 支持时间戳名/前缀片段；找不到时报错列出可用备份目录', async () => {
  freshHubRoot();
  ensureHubDirs();
  loadConfig();
  const memDir = freshTmpDir('mh-cli-n3-');
  const origin = writeAt(memDir, 'a.md', 'n3-v1\n');
  updateApp('claude', { enabled: true, memory_paths: [memDir] });
  const { dir } = backupAllApps();
  const tsName = path.basename(dir);

  // 完整时间戳名（非完整路径）→ 可解析并恢复
  fs.writeFileSync(origin, 'n3-改坏\n');
  const done = await rollbackBackup({ dir: tsName, yes: true });
  assert.equal(done.dir, dir);
  assert.equal(fs.readFileSync(origin, 'utf8'), 'n3-v1\n');

  // 前缀片段 → 唯一匹配
  fs.writeFileSync(origin, 'n3-改坏-2\n');
  const done2 = await rollbackBackup({ dir: tsName.slice(0, tsName.length - 6), yes: true });
  assert.equal(done2.dir, dir);
  assert.equal(fs.readFileSync(origin, 'utf8'), 'n3-v1\n');

  // 找不到 → 错误提示列出可用备份目录（不再误导为「无备份」）
  await assert.rejects(
    () => rollbackBackup({ dir: '1999-01-01T00-00-00', yes: true }),
    (err) => /找不到匹配/.test(err.message) && err.message.includes(tsName),
  );

  // resolveBackupDir 单元断言：完整路径/时间戳名直通；无匹配时报错带清单
  assert.equal(resolveBackupDir(dir), dir);
  assert.equal(resolveBackupDir(tsName), dir);
  assert.throws(() => resolveBackupDir('1999-01-01'), /找不到匹配|尚无任何备份/);

  // 前缀歧义（日期前缀同时匹配两个备份目录）→ 报错要求更精确
  const second = backupAllApps();
  const datePrefix = path.basename(second.dir).slice(0, 10);
  assert.throws(() => resolveBackupDir(datePrefix), /匹配到多个备份目录/);
});

test('N4：写回自身备份的 manifest 记录 app 归属；rollback 清单按 app 分组不再显示 [undefined]', async () => {
  freshHubRoot();
  ensureHubDirs();
  loadConfig();
  const { writeFilesSafely } = await import('../src/adapters/write-utils.js');
  const { readBackupManifest } = await import('../src/safe-write.js');

  const memDir = freshTmpDir('mh-cli-n4-');
  const target = path.join(memDir, 'entry.md');
  const { backupDir } = writeFilesSafely([
    { path: target, content: '[HUB-N4-X]\n正文', app: 'qoder', hubId: 'HUB-N4-X' },
  ]);

  // manifest：新增条目带 app/hubId/existed=false
  const manifest = readBackupManifest(backupDir);
  assert.equal(manifest['entry.md'].app, 'qoder', '写回备份 manifest 记录 app 归属');
  assert.equal(manifest['entry.md'].hubId, 'HUB-N4-X');
  assert.equal(manifest['entry.md'].existed, false);

  // 捕获输出：清单按 app 分组，不再出现 [undefined]
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await rollbackBackup({ dir: backupDir, yes: true });
  } finally {
    console.log = origLog;
  }
  const out = logs.join('\n');
  assert.match(out, /\[qoder\]/, '清单含 app 分组标题');
  assert.ok(!out.includes('[undefined]'), '清单不得显示 [undefined]');
  assert.equal(fs.existsSync(target), false, 'rollback 后新增文件被删除');
});

// ---------------------------------------------------------------------------
// 7. daemon 主循环（持锁 / 拒绝二次启动 / 优雅停止）
// ---------------------------------------------------------------------------

test('daemon 主循环：启动持锁、二次启动拒绝、兜底扫描触发、优雅停止释放锁、日志落盘', async () => {
  freshHubRoot();
  const watchDir = freshTmpDir('mh-cli-watch-');
  loadConfig();
  updateApp('claude', { enabled: true, memory_paths: [watchDir] });

  let distillCalls = 0;
  const handle = await runDaemon({
    config: loadConfig(),
    sweepIntervalMs: 40,
    startupCatchupMs: 60 * 60 * 1000, // 启动追赶推到测试外，只验兜底扫描
    distillFn: async () => {
      distillCalls += 1;
      return { ok: false, error: 'llm.baseUrl / llm.model 未配置（测试降级）' };
    },
    writebackFn: async () => ({ appResults: [] }),
  });

  // 启动后持锁 + 日志落盘
  assert.equal(fs.existsSync(daemonPidPath()), true);
  assert.equal(fs.readFileSync(daemonPidPath(), 'utf8').trim(), String(process.pid));
  assert.match(fs.readFileSync(daemonLogPath(), 'utf8'), /daemon 启动/);

  // 二次启动拒绝（pid 锁被存活进程占用）
  await assert.rejects(
    () => runDaemon({ config: loadConfig(), distillFn: async () => ({ ok: true, pending: 0 }) }),
    /已在运行/,
  );

  // 等兜底扫描至少触发一轮：distill 降级只记日志不退出、不重试风暴
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(distillCalls >= 1, '兜底扫描应至少触发一轮 distill');
  assert.match(fs.readFileSync(daemonLogPath(), 'utf8'), /distill 降级跳过/);

  // 优雅停止：释放 pid 锁
  await handle.stop();
  assert.equal(fs.existsSync(daemonPidPath()), false);
});

test('daemon 事件驱动：低于阈值不触发，达阈值静默合并后触发 distill 并链式 writeback', async () => {
  freshHubRoot();
  const watchDir = freshTmpDir('mh-cli-trigger-');
  loadConfig();
  updateApp('claude', { enabled: true, memory_paths: [watchDir] });

  // 预置一个带 hub-id 的 wiki 页，让链式 writeback 有可写回条目
  const wikiDir = path.join(paths.hub, 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(wikiDir, 'trigger-page.md'),
    '---\nhub-id: hub-trigger-1\n---\n# 触发测试页\n\n正文。\n',
  );

  let distillCalls = 0;
  let writebackCalls = 0;
  const handle = await runDaemon({
    config: loadConfig(),
    sweepIntervalMs: 60 * 60 * 1000, // 兜底扫描推到测试外，只验事件触发
    startupCatchupMs: 60 * 60 * 1000,
    triggerCount: 3,
    triggerBytes: 1024 * 1024,
    quietMs: 30,
    maxDelayMs: 10 * 1000,
    distillFn: async () => {
      distillCalls += 1;
      return { ok: true, pending: 3, written: [path.join(wikiDir, 'trigger-page.md')] };
    },
    writebackFn: async () => {
      writebackCalls += 1;
      return { appResults: [{ app: 'claude', status: 'written' }] };
    },
  });

  // 低于阈值（2 < 3）：静默窗口过后也不触发（留给兜底扫描）
  handle.watcher.notifyIngest({ app: 'claude', count: 1, bytes: 10 });
  handle.watcher.notifyIngest({ app: 'claude', count: 1, bytes: 10 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(distillCalls, 0, '低于阈值不得触发 distill');

  // 第三条达阈值 → 静默合并 30ms 后触发一轮 pipeline（distill + 链式 writeback）
  handle.watcher.notifyIngest({ app: 'claude', count: 1, bytes: 10 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(distillCalls, 1, '达阈值后应触发一轮 distill（静默合并为一次）');
  assert.equal(writebackCalls, 1, 'distill 产出新页面后应立即链式 writeback，无需手动触发');
  const log = fs.readFileSync(daemonLogPath(), 'utf8');
  assert.match(log, /\[阈值触发\] distill 完成/);
  assert.match(log, /\[阈值触发\] writeback 完成/);

  // 窗口已清零：后续零星变更不再重复触发
  handle.watcher.notifyIngest({ app: 'claude', count: 1, bytes: 10 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(distillCalls, 1, '触发后窗口清零，零星变更不得重复触发');

  await handle.stop();
});

// ---------------------------------------------------------------------------
// 8. RV-O2：降级配置期间周期性重复 warn，config 修复后自动恢复并停止提醒
// ---------------------------------------------------------------------------

test('RV-O2：config 损坏降级期间周期性重复 warn，修复后热加载恢复', async () => {
  freshHubRoot();
  ensureHubDirs();
  // 写入非法 config.json → 入口 loadConfig 抛错 → 降级 defaultConfig
  fs.writeFileSync(paths.config, '{ 非法 JSON');

  const handle = await runDaemon({
    sweepIntervalMs: 60 * 60 * 1000, // 长间隔，排除干扰
    startupCatchupMs: 60 * 60 * 1000,
    degradedWarnIntervalMs: 30,
    distillFn: async () => ({ ok: true, pending: 0 }),
    writebackFn: async () => ({ appResults: [] }),
  });

  // 降级期间至少两轮提醒：重复 warn 而非只记一条
  await new Promise((r) => setTimeout(r, 120));
  let log = fs.readFileSync(daemonLogPath(), 'utf8');
  assert.match(log, /config\.json 加载失败，降级使用缺省配置/, '启动时应记一次 error');
  const warns = log.match(/config\.json 解析失败，正在使用缺省配置/g) || [];
  assert.ok(warns.length >= 2, `降级期间应周期性重复 warn（实际 ${warns.length} 条）`);

  // 修复 config.json → 下一轮自动恢复，停止提醒并记 info
  fs.writeFileSync(paths.config, JSON.stringify(loadConfigSchema()));
  await new Promise((r) => setTimeout(r, 120));
  log = fs.readFileSync(daemonLogPath(), 'utf8');
  assert.match(log, /config\.json 已恢复可解析/, '恢复后应记 info');
  const warnsBefore = warns.length;
  await new Promise((r) => setTimeout(r, 80));
  const warnsAfter = (fs.readFileSync(daemonLogPath(), 'utf8').match(/正在使用缺省配置/g) || []).length;
  assert.equal(warnsAfter, warnsBefore, '恢复后不得继续记降级 warn');

  await handle.stop();
  assert.equal(fs.existsSync(daemonPidPath()), false);
});

/** 造一份最小合法 config（基于缺省配置，避免 mergeWithDefaults 依赖） */
function loadConfigSchema() {
  // 直接复用 defaultConfig 产出，保证 loadConfig 可解析
  return { apps: [], llm: {}, writeback: {} };
}
