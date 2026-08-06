/**
 * test/test-safe-write.js —— 安全层 + 配置层自测（node:test）。
 *
 * 全部在临时目录演练，不触碰任何 App 的真实记忆文件：
 * 1. safeWrite 正常写入通过；
 * 2. 坏 frontmatter 注入 → verify 失败 → 自动回滚，文件内容恢复原状；
 * 3. atomicAppend 不丢失原有内容；
 * 4. 备份保留策略：造 21 份备份，验证只保留最近 20 份；
 * 5. rollback 从备份目录恢复到原路径（含「最近一次」缺省场景）；
 * 6. config.json 首次生成：包含 5 个默认 app、权限 600、目录权限 700。
 *
 * 运行：npm test 或 node test/test-safe-write.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 每个用例独立隔离根目录；paths 层每次调用动态读取该环境变量
const tmpRoots = [];

/**
 * 新建一个隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。
 * @returns {string} 隔离根目录
 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hub-test-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/**
 * 在临时目录创建一个工作文件。
 * @param {string} name 文件名
 * @param {string} content 内容
 * @returns {string} 文件绝对路径
 */
function makeWorkFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hub-work-'));
  tmpRoots.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const GOOD_MD = [
  '---',
  'title: 测试记忆',
  'updated: 2026-08-05',
  'tags: [demo, hub]',
  '---',
  '',
  '# 正文',
  'HUB-MARKER-001',
  '',
].join('\n');

// 坏 frontmatter：未闭合的 YAML 序列，gray-matter 解析会抛错
const BAD_MD = ['---', 'title: [unclosed', '  bad: :', '---', '正文', ''].join('\n');

before(() => {
  freshHubRoot();
});

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

test('safeWrite 正常写入通过（frontmatter/标记/SHA-256 全校验）', async () => {
  const { safeWrite, verify } = await import('../src/safe-write.js');
  const file = makeWorkFile('good.md', '');
  fs.rmSync(file); // 模拟首次写入（无备份场景）

  const sha = crypto.createHash('sha256').update(GOOD_MD).digest('hex');
  const { backupPath } = safeWrite(file, GOOD_MD, {
    verifyOpts: {
      expectFrontmatter: ['title', 'updated', 'tags'],
      expectMarker: 'HUB-MARKER-001',
      expectSha256: sha,
    },
  });

  assert.equal(backupPath, null, '首次写入不应有备份');
  assert.equal(fs.readFileSync(file, 'utf8'), GOOD_MD);
  assert.equal(verify(file, { expectFrontmatter: ['title'] }).ok, true);
});

test('坏 frontmatter 注入触发自动回滚，文件内容恢复原状', async () => {
  const { safeWrite } = await import('../src/safe-write.js');
  const file = makeWorkFile('rollback-target.md', GOOD_MD);
  const verifyOpts = { expectFrontmatter: ['title', 'updated'] };

  // 第一次写入建立基线
  safeWrite(file, GOOD_MD, { verifyOpts });

  // 注入坏 frontmatter：必须抛错，且文件恢复为基线内容
  assert.throws(
    () => safeWrite(file, BAD_MD, { verifyOpts }),
    /safeWrite 校验失败并已回滚/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), GOOD_MD, '回滚后内容应与原状一致');
});

test('首次写入即校验失败时删除坏文件，不留残留', async () => {
  const { safeWrite } = await import('../src/safe-write.js');
  const file = makeWorkFile('never-existed.md', '');
  fs.rmSync(file);

  assert.throws(() => safeWrite(file, BAD_MD, { verifyOpts: { expectFrontmatter: true } }));
  assert.equal(fs.existsSync(file), false, '无备份的首次坏写入应删除坏文件');
});

test('atomicAppend 不丢失原有内容', async () => {
  const { atomicAppend } = await import('../src/safe-write.js');
  const base = '# 原有内容\n第一行\n';
  const file = makeWorkFile('append.md', base);

  const backupPath = atomicAppend(file, '第二行（追加）\n');

  assert.equal(fs.readFileSync(file, 'utf8'), base + '第二行（追加）\n');
  assert.ok(backupPath, '追加前应先备份');
  assert.equal(fs.readFileSync(backupPath, 'utf8'), base, '备份内容应为追加前状态');
});

test('备份保留策略：造 21 份备份后仅保留最近 20 份', async () => {
  const { backup, listBackupDirs, MAX_BACKUPS } = await import('../src/safe-write.js');
  freshHubRoot(); // 隔离，避免其他用例的备份干扰计数

  const src = makeWorkFile('retention-src.md', 'v0');
  const dirs = [];
  for (let i = 1; i <= 21; i += 1) {
    fs.writeFileSync(src, `v${i}`);
    const bp = backup(src);
    dirs.push(path.dirname(bp));
  }

  const remaining = listBackupDirs();
  assert.equal(MAX_BACKUPS, 20);
  assert.equal(remaining.length, 20, '应只保留 20 份备份目录');
  assert.ok(!fs.existsSync(dirs[0]), '最早的一份备份应被清理');
  assert.ok(fs.existsSync(dirs[20]), '最新的一份备份应保留');
});

test('rollback 从指定备份目录恢复全部文件到原路径', async () => {
  const { backupTo, rollback } = await import('../src/safe-write.js');
  const { paths } = await import('../src/util/paths.js');
  freshHubRoot();

  // 两个文件归入同一个备份目录，模拟同批次写回前的整批备份
  const a = makeWorkFile('a.md', 'A0-原始内容');
  const b = makeWorkFile('b.md', 'B0-原始内容');
  const dir = path.join(paths.backups, '2026-08-05T00-00-00-000Z');
  backupTo(a, dir);
  backupTo(b, dir);

  // 模拟写回后内容被改坏
  fs.writeFileSync(a, 'A1-损坏');
  fs.writeFileSync(b, 'B1-损坏');

  const restored = rollback(dir, { 'a.md': a, 'b.md': b });

  assert.equal(restored.length, 2);
  assert.equal(fs.readFileSync(a, 'utf8'), 'A0-原始内容');
  assert.equal(fs.readFileSync(b, 'utf8'), 'B0-原始内容');
});

test('rollback 缺省使用最近一次备份目录', async () => {
  const { backup, rollback } = await import('../src/safe-write.js');
  freshHubRoot();

  const file = makeWorkFile('latest.md', '原始版本');
  backup(file); // 产生「最近一次」备份
  fs.writeFileSync(file, '被改坏的版本');

  const restored = rollback(undefined, { 'latest.md': file });

  assert.equal(restored.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '原始版本');
});

test('rollback 无 pathMap 时必须报错（防止误恢复）', async () => {
  const { backup, rollback } = await import('../src/safe-write.js');
  freshHubRoot();
  const file = makeWorkFile('nomap.md', 'x');
  backup(file);
  assert.throws(() => rollback(), /必须提供 pathMap/);
});

test('Bug#4：写回新增文件在 manifest 记为新增，rollback 时删除零残留；既有文件恢复行为不变', async () => {
  const { backupTo, rollback, readBackupManifest, MANIFEST_NAME } = await import('../src/safe-write.js');
  const { paths } = await import('../src/util/paths.js');
  freshHubRoot();

  // 既有文件 + 写回新建文件（备份时不存在）归入同一备份目录
  const existing = makeWorkFile('existing.md', 'E0-原始内容');
  const freshFile = path.join(path.dirname(existing), 'fresh-entry.md');
  assert.equal(fs.existsSync(freshFile), false);
  const dir = path.join(paths.backups, '2026-08-05T11-11-11-111Z');
  backupTo(existing, dir);
  const freshBackup = backupTo(freshFile, dir);
  assert.equal(freshBackup, null, '不存在的目标无备份文件');

  // manifest：既有记 existed=true，新建记 existed=false
  const manifest = readBackupManifest(dir);
  assert.equal(manifest['existing.md'].existed, true);
  assert.equal(manifest['existing.md'].origin, existing);
  assert.equal(manifest['fresh-entry.md'].existed, false);
  assert.equal(manifest['fresh-entry.md'].origin, freshFile);

  // 模拟写回：既有文件被改写 + 新建文件落盘
  fs.writeFileSync(existing, 'E1-写回后内容');
  fs.writeFileSync(freshFile, '写回新建的条目内容');

  const restored = rollback(dir, { 'existing.md': existing, 'fresh-entry.md': freshFile });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'E0-原始内容', '既有文件恢复原状（行为不变）');
  assert.equal(fs.existsSync(freshFile), false, '写回新增文件被删除，零残留');
  const removedRec = restored.find((r) => r.to === freshFile);
  assert.equal(removedRec.removed, true);
  assert.equal(restored.filter((r) => !r.removed).length, 1);

  // manifest.json 本身不会被当成备份内容写回目标
  assert.ok(fs.existsSync(path.join(dir, MANIFEST_NAME)), 'manifest 保留在备份目录供后续回滚');
});

test('N4：backupTo 将 app/hubId 归属记入 manifest（undefined 字段不污染）', async () => {
  const { backupTo, readBackupManifest } = await import('../src/safe-write.js');
  const { paths } = await import('../src/util/paths.js');
  freshHubRoot();

  const existing = makeWorkFile('n4-existing.md', 'N4-原始');
  const freshFile = path.join(path.dirname(existing), 'n4-fresh.md');
  const dir = path.join(paths.backups, '2026-08-06T00-00-00-000Z');
  backupTo(existing, dir, { app: 'qoder', hubId: undefined });
  backupTo(freshFile, dir, { app: 'qoder', hubId: 'HUB-N4-TEST' });

  const manifest = readBackupManifest(dir);
  assert.equal(manifest['n4-existing.md'].app, 'qoder', '既有文件记 app 归属');
  assert.ok(!('hubId' in manifest['n4-existing.md']), 'undefined 字段不入 manifest');
  assert.equal(manifest['n4-fresh.md'].app, 'qoder');
  assert.equal(manifest['n4-fresh.md'].hubId, 'HUB-N4-TEST', '新增文件记 hub-id 标记');
});

test('N2：rollback 对客户端改名后的新增文件按 hub-id 扫描清理；找不到时明确提示不静默', async () => {
  const { backupTo, rollback } = await import('../src/safe-write.js');
  const { paths } = await import('../src/util/paths.js');
  freshHubRoot();

  // 场景一：新增文件被客户端改名（原路径消失，同目录新文件含 hub-id 标记）
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hub-n2-'));
  tmpRoots.push(workDir);
  const freshFile = path.join(workDir, 'hub-n2-test-条目.md');
  const dir = path.join(paths.backups, '2026-08-06T01-01-01-000Z');
  backupTo(freshFile, dir, { app: 'qoder', hubId: 'HUB-N2-TEST' });

  // 模拟写回 → 客户端改名：原路径消失，改名后文件正文仍含 hub-id 标记
  fs.writeFileSync(freshFile, '[HUB-N2-TEST]\n写回正文');
  const renamed = path.join(workDir, '[HUB-N2-TEST]_条目.md');
  fs.renameSync(freshFile, renamed);
  fs.writeFileSync(renamed, '---\nsource: auto\n---\n[HUB-N2-TEST]\n写回正文（frontmatter 被重写）');

  const restored = rollback(dir, { 'hub-n2-test-条目.md': freshFile });
  assert.equal(fs.existsSync(renamed), false, '改名后的新增文件被按 hub-id 匹配删除');
  const rec = restored.find((r) => r.removed);
  assert.ok(rec, '清单包含删除记录');
  assert.equal(rec.to, renamed);
  assert.equal(rec.renamed, true, '标记为客户端改名清理');

  // 场景二：原路径消失且同目录无任何匹配文件 → missing 条目，不静默
  const fresh2 = path.join(workDir, 'never-found.md');
  const dir2 = path.join(paths.backups, '2026-08-06T01-01-02-000Z');
  backupTo(fresh2, dir2, { app: 'qoder', hubId: 'HUB-N2-GONE' });
  // 写回后文件被彻底移除（无任何含标记文件存在）
  fs.writeFileSync(fresh2, '[HUB-N2-GONE]\nx');
  fs.rmSync(fresh2);

  const restored2 = rollback(dir2, { 'never-found.md': fresh2 });
  const miss = restored2.find((r) => r.missing);
  assert.ok(miss, '找不到时返回 missing 条目供调用方提示');
  assert.equal(miss.to, fresh2);
  assert.equal(restored2.filter((r) => r.removed).length, 0);
});

test('config.json 首次生成：5 个默认 app、权限 600、目录权限 700', async () => {
  const { loadConfig, updateApp, APP_IDS } = await import('../src/config.js');
  const { paths } = await import('../src/util/paths.js');
  // 注意：这里特意用一个「尚未创建」的目录，验证惰性创建；
  // freshHubRoot() 用 mkdtempSync 会预先建目录，不能用于此断言。
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hub-parent-'));
  tmpRoots.push(parent);
  const root = path.join(parent, 'hub-root');
  process.env.MEMORY_HUB_ROOT = root;
  assert.equal(fs.existsSync(root), false, '惰性创建：首次 load 前根目录不应存在');

  const config = loadConfig();

  // 结构与默认值
  assert.deepEqual(
    config.apps.map((a) => a.id),
    APP_IDS,
    '应包含 5 个默认 app',
  );
  assert.ok(config.apps.every((a) => a.enabled === true), 'enabled 默认 true');
  assert.ok(config.apps.every((a) => Array.isArray(a.memory_paths) && a.memory_paths.length === 0));
  assert.equal(config.debounceMs, 2000);
  assert.equal(config.pollIntervalMs, 60000);
  // L6：hubRoot 死配置已移除（数据根目录一律用 MEMORY_HUB_ROOT 环境变量指定）
  assert.equal(config.hubRoot, undefined);
  assert.equal(config.writeback.batch3Enabled, false, '高风险批次默认关闭');
  assert.deepEqual(config.llm, { baseUrl: '', model: '', keyRef: '' });

  // 权限
  assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600, 'config.json 权限应为 600');
  assert.equal(fs.statSync(root).mode & 0o777, 0o700, '数据根目录权限应为 700');
  assert.equal(fs.statSync(paths.backups).mode & 0o777, 0o700);

  // updateApp 落盘后可被重新读取
  updateApp('qoder', { enabled: false, memory_paths: ['/tmp/fake-qoder/CLAUDE.md'] });
  const reloaded = loadConfig();
  const qoder = reloaded.apps.find((a) => a.id === 'qoder');
  assert.equal(qoder.enabled, false);
  assert.deepEqual(qoder.memory_paths, ['/tmp/fake-qoder/CLAUDE.md']);
  assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600, '更新后权限仍为 600');
});
