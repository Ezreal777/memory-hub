/**
 * test/test-review-fixes.js —— Ultra Review 修复清单定向自测（H2/H4/H5/M1/M2/M3/L3）。
 *
 * 覆盖：
 * - H5：特殊标题（`*`/`- `/`@`/`|`/`&` 开头）快照写入→读回闭环（YAML 可解析）；
 * - H2b：writeFilesSafely mtime/size 守卫，读写间隙被外部修改 → deferred 且原内容不动；
 * - H2c：claude 条目已含 hubId 但 MEMORY.md 缺索引行 → 补写索引（自愈）；
 * - H4：distill 同 slug 撞名合并（旧正文保留 + hub-id 并集）；README slug 自动加后缀；
 * - M2：备份分池（full/writeback 各自限额，latestBackupDir 优先 full）；
 * - M1：五适配器摄取白名单 isIngestible（防用户文档被误摄取）；
 * - M3：dirWindow 命中只丢事件不写指纹（窗口内真实外部修改不被永久漏摄取）；
 * - L3：qoder category 非法字符（含 ../）回退 project_introduction。
 *
 * 运行：npm test 或 node test/test-review-fixes.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-rv-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

function freshTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

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
});

// ---------------------------------------------------------------------------
// H5：特殊标题快照写入 → 读回闭环
// ---------------------------------------------------------------------------

test('H5：特殊标题（*/-/@/|/& 开头）快照写入后 YAML 可解析、标题无损', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, storePaths } = await import('../src/hub-store.js');
  freshHubRoot();
  const home = freshTmpDir('mh-rv-h5-home-');
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const titles = ['*重要事项', '- 待办', '@用户', '| x', '&锚点', '> 引用', '`code`'];
  titles.forEach((t, i) => {
    // 源文件 frontmatter 用 JSON 字符串转义，保证输入本身可解析
    writeAt(memDir, `note-${i}.md`, `---\nname: ${JSON.stringify(t)}\n---\n正文 ${i}`);
  });
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const r = harvest(adapter);
  assert.equal(r.ingested, titles.length, '全部特殊标题条目都应被摄取');

  const snapDir = path.join(storePaths.sources, 'claude');
  const snaps = fs.readdirSync(snapDir).filter((n) => n.endsWith('.md'));
  assert.equal(snaps.length, titles.length);
  const readBack = [];
  for (const s of snaps) {
    // 关键断言：自研 frontmatter 序列化后仍可被 YAML 解析（此前 * 等开头会产出不可解析快照）
    const parsed = matter(fs.readFileSync(path.join(snapDir, s), 'utf8'));
    assert.ok(parsed.data && parsed.data.hubId, `${s} frontmatter 必须可解析出 hubId`);
    readBack.push(parsed.data.title);
  }
  for (const t of titles) {
    assert.ok(readBack.includes(t), `标题 "${t}" 写入→读回必须无损`);
  }
});

// ---------------------------------------------------------------------------
// H2b：mtime/size 守卫（读写间隙被外部修改 → deferred）
// ---------------------------------------------------------------------------

test('H2b：preStat 与写前 stat 不一致 → 抛 deferred 且目标文件不被覆盖', async () => {
  const { writeFilesSafely, statSafe } = await import('../src/adapters/write-utils.js');
  freshHubRoot();
  const dir = freshTmpDir('mh-rv-h2b-');
  const target = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(target, 'v1\n');
  const preStat = statSafe(target); // 读取时基准
  // 读写间隙被外部（App/用户）追加
  fs.appendFileSync(target, '外部追加\n');
  let deferredErr = null;
  try {
    writeFilesSafely([
      { path: target, content: 'v2-hub\n', preStat, app: 'codex', verifyOpts: {} },
    ]);
  } catch (err) {
    deferredErr = err;
  }
  assert.ok(deferredErr, '应抛出错误');
  assert.equal(deferredErr.deferred, true, '错误必须标记 deferred');
  assert.equal(fs.readFileSync(target, 'utf8'), 'v1\n外部追加\n', '外部追加内容绝不丢');
});

test('H2b：preStat 一致时正常写入', async () => {
  const { writeFilesSafely, statSafe } = await import('../src/adapters/write-utils.js');
  freshHubRoot();
  const dir = freshTmpDir('mh-rv-h2b-ok-');
  const target = path.join(dir, 'a.md');
  fs.writeFileSync(target, 'v1\n');
  const preStat = statSafe(target);
  const { backupDir } = writeFilesSafely([
    { path: target, content: '[hub-x]\nv2\n', preStat, app: 'codex', hubId: 'hub-x', verifyOpts: { expectMarker: '[hub-x]' } },
  ]);
  assert.ok(backupDir);
  assert.equal(fs.readFileSync(target, 'utf8'), '[hub-x]\nv2\n');
});

// ---------------------------------------------------------------------------
// H2c：claude 索引自愈
// ---------------------------------------------------------------------------

test('H2c：条目文件已含 hubId 但 MEMORY.md 缺索引行 → 补写索引（自愈）', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  freshHubRoot();
  const memDir = freshTmpDir('mh-rv-h2c-');
  // 已存在的条目文件（frontmatter 含 hubId），但索引里没有它的行
  writeAt(memDir, 'entry-a.md', [
    '---',
    'name: "entry a"',
    'metadata:',
    '  hubId: hub-heal-1',
    '---',
    '既有正文',
  ].join('\n'));
  writeAt(memDir, 'MEMORY.md', '# Memory\n- [别的条目](other.md) — 摘要\n');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const results = await adapter.write([{ hubId: 'hub-heal-1', title: 'entry a', body: '既有正文' }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'written');
  assert.match(String(results[0].reason || ''), /自愈/);
  const index = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  assert.ok(index.includes('(entry-a.md)'), '索引行必须被补写');
  assert.ok(index.includes('- [别的条目](other.md)'), '索引既有行绝不重写');
});

// ---------------------------------------------------------------------------
// H4：distill 同 slug 撞名合并 + README 冲突后缀
// ---------------------------------------------------------------------------

/** 手工造一个合法快照文件（含 hubId 的 frontmatter + 正文） */
function writeSnapshot(sourcesDir, app, name, hubId, body) {
  const content = [
    '---',
    `hubId: "${hubId}"`,
    `app: "${app}"`,
    `title: "${name}"`,
    'ingestedAt: "2026-01-01T00:00:00.000Z"',
    '---',
    '',
    `# ${name}`,
    '',
    body,
    '',
  ].join('\n');
  return writeAt(path.join(sourcesDir, app), `${name}.md`, content);
}

function mockClient(pages) {
  return { chat: async () => JSON.stringify({ pages }) };
}

test('H4：同 slug 撞名时合并旧页（hub-id 并集 + 旧正文保留 + 更新区追加）', async () => {
  const { distill } = await import('../src/distill.js');
  const { storePaths, ensureHubStore } = await import('../src/hub-store.js');
  freshHubRoot();
  ensureHubStore();
  writeSnapshot(storePaths.sources, 'claude', 'snap-a', 'hub-batch1', '第一批内容');
  const r1 = await distill({
    client: mockClient([{ slug: 'topic-x', title: '主题 X', tags: ['t1'], hubIds: ['hub-batch1'], content: '第一批整理结果' }]),
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.written.length, 1);

  // 第二批快照，LLM 再次给出同一 slug
  writeSnapshot(storePaths.sources, 'claude', 'snap-b', 'hub-batch2', '第二批内容');
  const r2 = await distill({
    client: mockClient([{ slug: 'topic-x', title: '主题 X', tags: ['t2'], hubIds: ['hub-batch2'], content: '第二批整理结果' }]),
  });
  assert.equal(r2.ok, true);

  const page = fs.readFileSync(path.join(storePaths.wiki, 'topic-x.md'), 'utf8');
  const parsed = matter(page);
  // hub-id / sources / tags 并集
  assert.deepEqual(parsed.data['hub-id'].sort(), ['hub-batch1', 'hub-batch2']);
  assert.deepEqual(parsed.data.tags.sort(), ['t1', 't2']);
  // 旧正文绝不丢，新内容进「更新」区
  assert.ok(page.includes('第一批整理结果'), '旧批次正文必须保留');
  assert.ok(page.includes('第二批整理结果'), '新批次正文必须写入');
  assert.match(page, /## 更新（/);
});

test('H4：slug 为 README/隐藏名时自动加后缀，不覆盖占位文件', async () => {
  const { normalizePages } = await import('../src/distill.js');
  const pages = normalizePages({
    pages: [
      { slug: 'README', title: '自述', hubIds: ['h1'], content: 'x' },
      { slug: '.hidden', title: '隐藏', hubIds: ['h2'], content: 'y' },
    ],
  });
  assert.equal(pages[0].slug, 'README-page', 'README 冲突自动加后缀（不区分大小写判定）');
  assert.equal(pages[1].slug.startsWith('.hidden'), false, '隐藏名必须被改');
});

// ---------------------------------------------------------------------------
// M2：备份分池
// ---------------------------------------------------------------------------

test('M2：备份分池（full/writeback 各自限额，latestBackupDir 优先 full 池）', async () => {
  const { createBackupDir, latestBackupDir, listBackupDirs, pruneBackups, backupPoolDir } =
    await import('../src/safe-write.js');
  const { paths } = await import('../src/util/paths.js');
  freshHubRoot();

  const fullDir = createBackupDir('full');
  assert.ok(fullDir.startsWith(backupPoolDir('full') + path.sep), 'full 池目录必须在 backups/full/ 下');
  const wbDir = createBackupDir('writeback');
  assert.ok(wbDir.startsWith(backupPoolDir('writeback') + path.sep), '写回池目录必须在 backups/writeback/ 下');
  // rollback 缺省优先 full 池最新（即使 writeback 更新）
  assert.equal(latestBackupDir(), fullDir);
  // listBackupDirs 两池都搜
  const all = listBackupDirs();
  assert.ok(all.includes(fullDir) && all.includes(wbDir));

  // full 池限额 10：造 12 份后 prune 只留 10
  for (let i = 0; i < 10; i += 1) {
    const d = createBackupDir('full');
    fs.writeFileSync(path.join(d, 'manifest.json'), '{}');
  }
  pruneBackups();
  const fulls = fs.readdirSync(backupPoolDir('full')).filter((n) => !n.startsWith('.'));
  assert.equal(fulls.length, 10, `full 池应限额 10 份，实际 ${fulls.length}`);
  assert.ok(fs.existsSync(paths.backups), 'backups 根目录存在');
});

// ---------------------------------------------------------------------------
// M1：摄取白名单
// ---------------------------------------------------------------------------

test('M1：isIngestible 白名单与各适配器 discover 口径一致', async () => {
  const { WukongAdapter } = await import('../src/adapters/wukong.js');
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { QoderworkAdapter } = await import('../src/adapters/qoderwork.js');
  const { QoderAdapter } = await import('../src/adapters/qoder.js');

  // wukong：仅三个顶层文件，任意用户文档拒收
  const ws = freshTmpDir('mh-rv-m1-wk-');
  const wk = new WukongAdapter({ id: 'wukong', enabled: true, memory_paths: [ws] });
  writeAt(ws, 'MEMORY.md', 'x');
  writeAt(ws, 'notes.txt', 'x');
  writeAt(ws, 'sub/MEMORY.md', 'x');
  assert.equal(wk.isIngestible(path.join(ws, 'MEMORY.md')), true);
  assert.equal(wk.isIngestible(path.join(ws, 'USER.md')), true);
  assert.equal(wk.isIngestible(path.join(ws, 'notes.txt')), false, '用户文档绝不允许摄取');
  assert.equal(wk.isIngestible(path.join(ws, 'sub/MEMORY.md')), false, '非顶层文件拒收');

  // claude：仅 memory 目录下直接 .md
  const cm = freshTmpDir('mh-rv-m1-cl-');
  const cl = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [cm] });
  assert.equal(cl.isIngestible(path.join(cm, 'MEMORY.md')), true);
  assert.equal(cl.isIngestible(path.join(cm, 'data.json')), false);
  assert.equal(cl.isIngestible(path.join(cm, 'sub', 'x.md')), false, '非顶层 md 拒收');

  // qoderwork：顶层三个 md + memory/*.md，其余拒收
  const qw = freshTmpDir('mh-rv-m1-qw-');
  const qa = new QoderworkAdapter({ id: 'qoderwork', enabled: true, memory_paths: [qw] });
  assert.equal(qa.isIngestible(path.join(qw, 'MEMORY.md')), true);
  assert.equal(qa.isIngestible(path.join(qw, 'memory', '2026-01-01.md')), true);
  assert.equal(qa.isIngestible(path.join(qw, 'memory', 'idx.sqlite')), false);
  assert.equal(qa.isIngestible(path.join(qw, '随便文档.md')), false, '顶层任意 md 拒收');
  assert.equal(qa.isIngestible(path.join(qw, 'other', 'x.md')), false);

  // qoder：仅 projects/<slug>/<category>/*.md（四层相对路径）
  const qr = freshTmpDir('mh-rv-m1-qd-');
  const qd = new QoderAdapter({ id: 'qoder', enabled: true, memory_paths: [qr] });
  assert.equal(qd.isIngestible(path.join(qr, 'projects', 'p', 'user_info', 'a.md')), true);
  assert.equal(qd.isIngestible(path.join(qr, 'projects', 'p', 'a.md')), false);
  assert.equal(qd.isIngestible(path.join(qr, 'scratch.txt')), false);
});

// ---------------------------------------------------------------------------
// M3：dirWindow 命中不写指纹
// ---------------------------------------------------------------------------

test('M3：dirWindow 命中只丢事件不记指纹（窗口内真实外部修改不被永久漏摄取）', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, loadHashState } = await import('../src/hub-store.js');
  const { registerDirWindow } = await import('../src/inflight.js');
  freshHubRoot();
  const memDir = freshTmpDir('mh-rv-m3-');
  const file = writeAt(memDir, 'MEMORY.md', '- [a](a.md) — 摘要1\n');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const first = harvest(adapter);
  assert.equal(first.ingested, 1);
  const oldSha = loadHashState().files[file].sha256;

  // 写回登记目录宽限窗口后，文件被「外部」真实修改
  registerDirWindow(memDir);
  fs.writeFileSync(file, '- [a](a.md) — 摘要1\n- [b](b.md) — 摘要2\n');
  const second = harvest(adapter);
  assert.equal(second.ingested, 0, 'dirWindow 命中期间事件被抑制');
  assert.equal(loadHashState().files[file].sha256, oldSha, '抑制期间绝不写新指纹（否则窗口过期后也漏摄取）');
});

// ---------------------------------------------------------------------------
// L3：qoder category 路径穿越防护
// ---------------------------------------------------------------------------

test('L3：category 非法字符（含 ../）回退 project_introduction', async () => {
  const { QoderAdapter } = await import('../src/adapters/qoder.js');
  const qd = new QoderAdapter({ id: 'qoder', enabled: true, memory_paths: ['/tmp/x'] });
  assert.equal(qd.categoryOf({ frontmatter: { category: '../evil' } }), 'project_introduction');
  assert.equal(qd.categoryOf({ frontmatter: { category: 'a/b' } }), 'project_introduction');
  assert.equal(qd.categoryOf({ category: '中文目录' }), 'project_introduction');
  assert.equal(qd.categoryOf({ frontmatter: { category: 'user_info' } }), 'user_info', '合法 category 原样保留');
  assert.equal(qd.categoryOf({}), 'project_introduction');
});
