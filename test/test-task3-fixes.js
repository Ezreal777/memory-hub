/**
 * test/test-task3-fixes.js —— Task #3 基础设施层修复定向自测（L1/L2/L3/L4/L5）。
 *
 * 覆盖：
 * - L2：genHubId 随机段改用 node:crypto（格式不变、批量生成不碰撞）；
 * - L3：getChangedFiles 快筛升级 mtime+size 双字段（mtime 相同但 size 变化不再漏判）；
 *   旧版 hash-state（无 size 字段）兼容：sha 重算一次不误判，并回填 size；
 * - L4：scan 保留用户手动禁用（enabled=false 不被重扫复活，notes 标注「检测到但保持禁用」）；
 *   scan 自动禁用（未找到）的 app 在被发现后仍正常重新启用；
 * - L5：probeQoder/probeClaude 多候选 slug 按目录 mtime 最新者选取（不再取 glob 首位），
 *   notes 列出全部候选；
 * - L1：config.json 已知死字段（hubRoot）加载时剔除、保存时落盘清洗，未知键不受影响。
 *
 * H6 锁心跳相关用例见 test/test-lock.js。
 * 全部在 MEMORY_HUB_ROOT 隔离环境演练，绝不触碰真实数据。
 *
 * 运行：npm test 或 node test/test-task3-fixes.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-task3-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 新建一个伪造的家目录。 */
function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-task3-home-'));
  tmpRoots.push(dir);
  return dir;
}

/** 递归写文件（自动建目录）。 */
function writeAt(base, rel, content = '') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 把路径 mtime 设为指定时间点（毫秒时间戳）。 */
function setMtime(p, ms) {
  const d = new Date(ms);
  fs.utimesSync(p, d, d);
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// L2：genHubId 改用 crypto 强随机（格式前缀兼容）
// ---------------------------------------------------------------------------

test('L2：genHubId 格式不变（hub-<14位时间戳>-<6位小写字母数字>）且批量生成不碰撞', async () => {
  const { genHubId } = await import('../src/hub-store.js');
  const ids = new Set();
  const N = 500;
  for (let i = 0; i < N; i += 1) {
    const id = genHubId();
    assert.match(id, /^hub-\d{14}-[a-z0-9]{6}$/, `格式须保持兼容：${id}`);
    ids.add(id);
  }
  // 同一秒内时间戳段相同，唯一性全靠随机段（36^6 空间下 500 个不应碰撞）
  assert.equal(ids.size, N, '批量生成的 hubId 不得碰撞');
});

// ---------------------------------------------------------------------------
// L3：变更检测快筛升级 mtime+size 双字段 + 旧 hash-state 兼容
// ---------------------------------------------------------------------------

test('L3：mtime 相同但 size 变化的写入（rsync/备份还原）不再被漏判', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, getChangedFiles, loadHashState } = await import('../src/hub-store.js');
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const foo = writeAt(home, '.claude/projects/proj/memory/foo.md', '---\nname: foo\n---\n内容A');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  // 把 mtime 钉在整毫秒上，避免亚毫秒精度在 utimes 恢复时丢失导致快筛比对失真
  const fixedMs = Date.now() - 5000;
  setMtime(foo, fixedMs);

  harvest(adapter);
  const rec = loadHashState().files[foo];
  assert.ok(rec, '首次摄取后有对账记录');
  assert.equal(rec.mtimeMs, fixedMs, '前置条件：记录的 mtime 为钉定值');
  assert.ok(Number.isFinite(rec.size), 'recordFile 应记录 size 字段');

  // 模拟保留 mtime 的写入：内容（长度）变化后把 mtime 拨回记录值
  fs.writeFileSync(foo, '---\nname: foo\n---\n内容A-变长了很多很多');
  setMtime(foo, fixedMs);
  assert.equal(fs.statSync(foo).mtimeMs, rec.mtimeMs, '前置条件：mtime 已恢复为记录值');

  const changed = getChangedFiles(adapter);
  assert.deepEqual(changed.modified, [foo], 'mtime 相同但 size 变化必须进 sha 精判并识别为 modified');
});

test('L3：旧版 hash-state（无 size 字段）不误判 modified，sha 重算一次后回填 size', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, getChangedFiles, loadHashState, storePaths } = await import('../src/hub-store.js');
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const foo = writeAt(home, '.claude/projects/proj/memory/foo.md', '---\nname: foo\n---\n内容A');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });

  harvest(adapter);
  // 手工降级为旧版 state：删掉 size 字段（模拟升级前的存量数据）
  const raw = JSON.parse(fs.readFileSync(storePaths.hashState, 'utf8'));
  for (const rec of Object.values(raw.files)) {
    delete rec.size;
  }
  fs.writeFileSync(storePaths.hashState, JSON.stringify(raw, null, 2));
  assert.equal(loadHashState().files[foo].size, undefined, '前置条件：state 已无 size');

  // 内容未变：不得误判 modified；且 sha 一致后应回填 size（后续轮次走快筛）
  const changed = getChangedFiles(adapter);
  assert.deepEqual(changed.modified, [], '旧 state 无 size 且内容未变时不误判');
  assert.deepEqual(changed.added, []);
  const rec = loadHashState().files[foo];
  assert.equal(rec.size, fs.statSync(foo).size, 'sha 重算一致后应回填 size 字段');
  assert.ok(rec.sha256, '回填不得破坏既有 sha256');
});

// ---------------------------------------------------------------------------
// L4：scan 保留用户手动禁用（与 readOnly 保留逻辑同风格）
// ---------------------------------------------------------------------------

test('L4：用户手动禁用的 app 重扫保持禁用，notes 标注「检测到但保持禁用」且幂等', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig, updateApp } = await import('../src/config.js');
  freshHubRoot();
  const home = freshFakeHome();
  writeAt(home, '.claude/projects/proj-alpha/memory/MEMORY.md', '# m\n');

  // 首扫：发现并启用
  scanApps({ home });
  assert.equal(loadConfig().apps.find((a) => a.id === 'claude').enabled, true);

  // 用户出于谨慎手动禁用
  updateApp('claude', { enabled: false });

  // 重扫：不得复活，notes 提示保持禁用
  const rows = scanApps({ home });
  const row = rows.find((r) => r.id === 'claude');
  assert.equal(row.found, true, '仍能检测到');
  assert.equal(row.enabled, false, '重扫不得复活手动禁用的 app');
  const app = loadConfig().apps.find((a) => a.id === 'claude');
  assert.equal(app.enabled, false);
  assert.match(app.notes, /检测到但保持禁用/);
  assert.deepEqual(app.memory_paths, [path.join(home, '.claude/projects/proj-alpha/memory')], '路径仍正常回填');

  // 再扫一次：仍禁用且 config 稳定（幂等，标注不重复叠加）
  scanApps({ home });
  const again = loadConfig().apps.find((a) => a.id === 'claude');
  assert.equal(again.enabled, false);
  assert.equal(again.notes, app.notes, '重复扫描 notes 不得叠加漂移');
});

test('L4：scan 自动禁用（未找到）的 app 在被发现后正常重新启用', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig } = await import('../src/config.js');
  freshHubRoot();
  const home = freshFakeHome();

  // 首扫：qoderwork 缺席 → 自动禁用，notes=未找到
  scanApps({ home });
  const before = loadConfig().apps.find((a) => a.id === 'qoderwork');
  assert.equal(before.enabled, false);
  assert.match(before.notes, /未找到/);

  // 用户随后安装了 qoderwork → 重扫应重新启用（自动禁用不粘滞）
  writeAt(home, '.qoderwork/awareness/main/MEMORY.md', '# m\n');
  scanApps({ home });
  const after2 = loadConfig().apps.find((a) => a.id === 'qoderwork');
  assert.equal(after2.enabled, true, '此前因未找到被自动禁用的 app，发现后应重新启用');
});

// ---------------------------------------------------------------------------
// L5：多候选 slug 按目录 mtime 最新者选取（稳定，不随 glob 顺序跳变）
// ---------------------------------------------------------------------------

test('L5：qoder 多项目按目录 mtime 最新者选 project_slug，notes 列出全部候选', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig } = await import('../src/config.js');
  freshHubRoot();
  const home = freshFakeHome();
  writeAt(home, '.qoder/memories/acc1/projects/proj-old/experience/a.md', 'x');
  writeAt(home, '.qoder/memories/acc1/projects/proj-new/experience/b.md', 'y');
  const oldDir = path.join(home, '.qoder/memories/acc1/projects/proj-old');
  const newDir = path.join(home, '.qoder/memories/acc1/projects/proj-new');
  // 文件写入会刷新目录 mtime，最后统一设定：proj-new 最新
  setMtime(oldDir, Date.now() - 60 * 60 * 1000);
  setMtime(newDir, Date.now() - 60 * 1000);

  scanApps({ home });
  const qoder = loadConfig().apps.find((a) => a.id === 'qoder');
  assert.equal(qoder.project_slug, 'proj-new', '应选 mtime 最新的项目');
  assert.match(qoder.notes, /proj-new/);
  assert.match(qoder.notes, /proj-old/, 'notes 应列出全部候选 slug');

  // mtime 反转后重扫：slug 跟随最新目录（选取规则确定，不受 glob 顺序影响）
  setMtime(oldDir, Date.now());
  scanApps({ home });
  const flipped = loadConfig().apps.find((a) => a.id === 'qoder');
  assert.equal(flipped.project_slug, 'proj-old', 'mtime 反转后应选新的最新者');
});

test('L5：claude 多项目按项目目录 mtime 最新者选 project_slug，memory_paths 全保留', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig } = await import('../src/config.js');
  freshHubRoot();
  const home = freshFakeHome();
  writeAt(home, '.claude/projects/proj-a/memory/MEMORY.md', '# a\n');
  writeAt(home, '.claude/projects/proj-b/memory/MEMORY.md', '# b\n');
  setMtime(path.join(home, '.claude/projects/proj-a'), Date.now() - 60 * 60 * 1000);
  setMtime(path.join(home, '.claude/projects/proj-b'), Date.now() - 60 * 1000);

  const rows = scanApps({ home });
  const claude = rows.find((r) => r.id === 'claude');
  assert.equal(claude.project_slug, 'proj-b', '应选 mtime 最新的项目');
  assert.match(claude.notes, /proj-a/);
  assert.match(claude.notes, /proj-b/);
  assert.deepEqual(
    [...claude.memory_paths].sort(),
    [
      path.join(home, '.claude/projects/proj-a/memory'),
      path.join(home, '.claude/projects/proj-b/memory'),
    ].sort(),
    '全部项目的 memory 目录都保留',
  );
  const config = loadConfig().apps.find((a) => a.id === 'claude');
  assert.equal(config.project_slug, 'proj-b');
});

// ---------------------------------------------------------------------------
// L1：config 已知死字段清洗（只删 hubRoot，未知键保留）
// ---------------------------------------------------------------------------

test('L1：加载时剔除死字段 hubRoot，保存时落盘清洗，其他未知键不受影响', async () => {
  const root = freshHubRoot();
  const { loadConfig, updateConfig, DEAD_CONFIG_KEYS } = await import('../src/config.js');
  assert.ok(DEAD_CONFIG_KEYS.includes('hubRoot'), '死字段清单须包含 hubRoot');

  // 伪造存量配置：带死字段 hubRoot + 其他小组新增的未知配置块
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    hubRoot: '~/.memory-hub/hub',
    debounceMs: 3000,
    experimental: { searchIndex: true },
  }, null, 2));

  // 加载：死字段被剔除，未知键与用户字段保留
  const config = loadConfig();
  assert.equal(config.hubRoot, undefined, '死字段 hubRoot 加载时应剔除');
  assert.deepEqual(config.experimental, { searchIndex: true }, '未知键不得被误删');
  assert.equal(config.debounceMs, 3000, '用户既有字段保留');

  // 保存（任意一次落盘）后磁盘文件同样干净
  updateConfig({});
  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.ok(!('hubRoot' in onDisk), '落盘后死字段应已清洗');
  assert.deepEqual(onDisk.experimental, { searchIndex: true }, '未知键随保存完整留存');
  assert.equal(onDisk.debounceMs, 3000);
});
