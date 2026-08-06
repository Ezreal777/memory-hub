/**
 * test/test-inflight.js —— 回环抑制跨进程持久化自测（node:test）。
 *
 * Bug#3 修复验证：inflight 状态持久化为共享文件 hub/state/inflight.json，
 * CLI 进程登记 → daemon/watcher 进程（此处用独立子进程模拟）读取后正确抑制。
 *
 * 覆盖：
 * 1. 跨进程：进程 A（子进程 node -e）register → 进程 B（本测试）consume 命中；
 * 2. hash 不匹配（外部改动）→ 不抑制，且登记被消费清除；
 * 3. 同进程 register → consume → 再次 consume 不命中（消费即清除）；
 * 4. TTL 过期条目自动清理，不再抑制；
 * 5. clearInflight 主动清除；
 * 6. N1 目录级宽限窗口：窗口内目录下任意文件（路径/hash 均变）一律抑制；
 * 7. N1 窗口过期后不再抑制，且不影响其他目录。
 *
 * consumeInflight 返回值说明：命中返回详情对象 { match: 'exact'|'dirWindow' }（truthy），
 * 未命中返回 null（falsy）。
 *
 * 运行：npm test 或 node test/test-inflight.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  registerInflight,
  clearInflight,
  consumeInflight,
  registerDirWindow,
  loadInflightEntries,
  loadDirWindows,
  saveInflightEntries,
  inflightStorePath,
  INFLIGHT_TTL_MS,
  DIR_WINDOW_TTL_MS,
} from '../src/inflight.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-inflight-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

const sha256Of = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 模块绝对 URL（供子进程 import） */
const MODULE_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inflight.js'),
).href;

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

test('Bug#3 跨进程：进程 A（子进程）register → 进程 B（watcher 判定）正确抑制', () => {
  const root = freshHubRoot();
  const target = path.join(root, 'fake-app', 'MEMORY.md');
  const content = '写回引擎写入的内容（跨进程验证）';
  const sha = sha256Of(content);

  // 进程 A：独立子进程执行 registerInflight（模拟 CLI 写回进程）
  const code =
    `import { registerInflight } from ${JSON.stringify(MODULE_URL)};` +
    `registerInflight(${JSON.stringify(target)}, ${JSON.stringify(sha)});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, MEMORY_HUB_ROOT: root },
  });

  // 登记已落到共享文件
  assert.ok(fs.existsSync(inflightStorePath()), 'inflight.json 已创建');
  const entries = loadInflightEntries();
  assert.equal(entries[path.resolve(target)]?.sha256, sha);

  // 进程 B（本进程模拟 daemon watcher 判定）：hash 命中 → 抑制
  const hit = consumeInflight(target, sha);
  assert.ok(hit, '跨进程命中自写回环，应抑制');
  assert.equal(hit.match, 'exact');
  // 消费后清除：再次判定不再命中
  assert.equal(consumeInflight(target, sha), null, '条目消费后即清除');
});

test('跨进程登记但 hash 不匹配（外部改动）→ 不抑制且清除登记', () => {
  const root = freshHubRoot();
  const target = path.join(root, 'fake-app', 'note.md');
  const code =
    `import { registerInflight } from ${JSON.stringify(MODULE_URL)};` +
    `registerInflight(${JSON.stringify(target)}, ${JSON.stringify(sha256Of('预期内容'))});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, MEMORY_HUB_ROOT: root },
  });

  // 实际内容被外部再次改动 → hash 不同 → 不算自写回环
  assert.equal(consumeInflight(target, sha256Of('外部改动后的内容')), null);
  // 残留登记已被消费清除，不影响后续
  assert.deepEqual(loadInflightEntries(), {});
});

test('同进程 register → consume 命中；重复 consume 不再命中', () => {
  freshHubRoot();
  const target = '/tmp/fake/inflight/same-proc.md';
  const sha = sha256Of('同进程内容');
  registerInflight(target, sha);
  assert.ok(consumeInflight(target, sha));
  assert.equal(consumeInflight(target, sha), null);
});

test('TTL 过期条目自动清理：超过 10 分钟未消费的登记不再抑制', () => {
  freshHubRoot();
  assert.equal(INFLIGHT_TTL_MS, 10 * 60 * 1000);
  const target = '/tmp/fake/inflight/expired.md';
  const sha = sha256Of('过期内容');
  // 手工写入一条过期登记（ts 早于 TTL）
  saveInflightEntries({
    [path.resolve(target)]: { sha256: sha, ts: Date.now() - INFLIGHT_TTL_MS - 1000 },
  });
  assert.deepEqual(loadInflightEntries(), {}, '读取即剔除过期条目');
  assert.equal(consumeInflight(target, sha), null, '过期登记不产生抑制');
});

test('clearInflight 主动清除登记（写回失败回滚路径）', () => {
  freshHubRoot();
  const target = '/tmp/fake/inflight/cleared.md';
  const sha = sha256Of('将被清除');
  registerInflight(target, sha);
  clearInflight(target, sha);
  assert.equal(consumeInflight(target, sha), null, '清除后不再抑制');
  assert.deepEqual(loadInflightEntries(), {});
});

// ---------------------------------------------------------------------------
// N1：目录级宽限窗口（qoder 客户端写回后改名/重写 frontmatter 的覆盖）
// ---------------------------------------------------------------------------

test('N1 目录窗口：窗口内目录下任意新文件（路径/hash 均变）一律抑制', () => {
  freshHubRoot();
  assert.equal(DIR_WINDOW_TTL_MS, 120 * 1000);
  const dir = '/tmp/fake/qoder/projects/demo/project_introduction';
  registerDirWindow(dir);
  assert.ok(loadDirWindows()[path.resolve(dir)], '窗口已登记');

  // 模拟客户端改名：新路径 + 新内容（hash 与写回时完全不同）→ 仍被抑制
  const renamed = path.join(dir, '[hub-abc]_条目.md');
  const hit = consumeInflight(renamed, sha256Of('客户端重写后的全新内容'));
  assert.ok(hit, '目录窗口内改名文件应被抑制');
  assert.equal(hit.match, 'dirWindow');
  assert.equal(hit.dir, path.resolve(dir));

  // 窗口不随消费移除：窗口内再来一个事件仍被抑制
  assert.ok(consumeInflight(path.join(dir, 'another.md'), sha256Of('x')));

  // 窗口目录之外的文件不受影响（精确匹配保持原语义）
  assert.equal(consumeInflight('/tmp/fake/claude/MEMORY.md', sha256Of('x')), null);
});

test('N1 目录窗口：子目录也在窗口内；窗口过期后不再抑制', () => {
  freshHubRoot();
  const dir = '/tmp/fake/qoder/projects/demo/cat';
  // 手工登记一条已过期窗口（ts 早于 TTL）
  saveInflightEntries({}, { [path.resolve(dir)]: { ts: Date.now() - DIR_WINDOW_TTL_MS - 1000, ttlMs: DIR_WINDOW_TTL_MS } });
  assert.deepEqual(loadDirWindows(), {}, '读取即剔除过期窗口');
  assert.equal(consumeInflight(path.join(dir, 'sub', 'a.md'), sha256Of('y')), null, '过期窗口不产生抑制');

  // 未过期窗口：子目录路径同样命中
  registerDirWindow(dir);
  assert.ok(consumeInflight(path.join(dir, 'sub', 'a.md'), sha256Of('y')));
});

test('N1 目录窗口：跨进程登记（子进程 registerDirWindow → 本进程判定命中）', () => {
  const root = freshHubRoot();
  const dir = path.join(root, 'qoder', 'projects', 'demo', 'project_introduction');
  const code =
    `import { registerDirWindow } from ${JSON.stringify(MODULE_URL)};` +
    `registerDirWindow(${JSON.stringify(dir)});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, MEMORY_HUB_ROOT: root },
  });
  const renamed = path.join(dir, '[HUB-N4]_改名后.md');
  const hit = consumeInflight(renamed, sha256Of('任意内容'));
  assert.ok(hit, '跨进程目录窗口应命中');
  assert.equal(hit.match, 'dirWindow');
});

test('N1 精确登记与目录窗口共存：精确条目先被消费，窗口继续生效', () => {
  freshHubRoot();
  const dir = '/tmp/fake/qoder/cat';
  const target = path.join(dir, 'entry.md');
  const sha = sha256Of('写回内容');
  registerInflight(target, sha);
  registerDirWindow(dir);

  // 精确命中（消费精确条目）
  assert.equal(consumeInflight(target, sha).match, 'exact');
  // 窗口仍在：改名文件继续被抑制
  assert.equal(consumeInflight(path.join(dir, 'renamed.md'), sha256Of('z')).match, 'dirWindow');
});
