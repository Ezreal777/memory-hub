/**
 * test/test-adapters-hub.js —— 适配器只读侧 + 三层中转站 + 监听摄取自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 hub/state/logs，伪造家目录结构验证五个适配器。
 * 绝不触碰真实的 ~/.claude / ~/.codex / ~/.qoder / ~/.qoderwork / ~/.real。
 *
 * 覆盖：
 * 1. 五个适配器 parse 正确产出条目（qoder 无 frontmatter 文件被跳过并警告）；
 * 2. hash-state 首次全量摄取、二次无变化零摄取、改内容后精确识别变化文件；
 * 3. watcher 集成：改文件 → debounce 后 sources 出现快照 + hash-state 更新 → 再改验证增量
 *    → registerInflight 后自写触发的事件被抑制；
 * 4. master-index 生成正确。
 *
 * 运行：npm test 或 node test/test-adapters-hub.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-adapt-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 新建一个伪造的家目录。 */
function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-adapt-home-'));
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

/** 强制把文件 mtime 推到未来，确保对账快筛必然判定为变化。 */
function bumpMtime(p) {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(p, t, t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待条件成立（消除 chokidar 事件时序抖动导致的 flaky）。
 * @param {() => boolean} cond 条件函数
 * @param {number} [timeoutMs=4000] 超时
 * @param {number} [intervalMs=80] 轮询间隔
 */
async function waitFor(cond, timeoutMs = 4000, intervalMs = 80) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(intervalMs);
  }
  return cond();
}

/** 列出 sources/<app>/ 下的快照文件数 */
function countSnapshots(appId) {
  const dir = path.join(process.env.MEMORY_HUB_ROOT, 'hub', 'sources', appId);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. 五个适配器 parse 正确产出条目
// ---------------------------------------------------------------------------

test('claude：MEMORY.md 索引行 + 独立条目 frontmatter 均正确解析', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  writeAt(home, '.claude/projects/proj/memory/MEMORY.md', [
    '- [User Identity](user_identity.md) — 狂且，好朋友',
    '- [ODPS Config](odps_config.md) — MaxCompute 连接信息',
    '非索引行应被忽略',
  ].join('\n'));
  writeAt(home, '.claude/projects/proj/memory/user_identity.md', [
    '---',
    'name: user-identity',
    'description: "User name"',
    'metadata: ',
    '  node_type: memory',
    '  type: user',
    '---',
    '',
    '用户名叫狂且。',
  ].join('\n'));

  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const files = adapter.discover();
  assert.equal(files.length, 2, '发现 MEMORY.md + 独立条目');

  // 索引文件 → 每行一个条目
  const idx = adapter.parse(adapter.read(path.join(memDir, 'MEMORY.md')));
  assert.equal(idx.length, 2);
  assert.equal(idx[0].title, 'User Identity');
  assert.equal(idx[0].body, '狂且，好朋友');
  assert.equal(idx[0].frontmatter.target, 'user_identity.md');

  // 独立条目 → frontmatter 原始数据保留
  const entry = adapter.parse(adapter.read(path.join(memDir, 'user_identity.md')))[0];
  assert.equal(entry.title, 'user-identity');
  assert.equal(entry.frontmatter.metadata.node_type, 'memory');
  assert.equal(entry.frontmatter.metadata.type, 'user');
  assert.match(entry.body, /用户名叫狂且/);
});

test('codex：AGENTS.md 按 ## 分节，前言单独成条', async () => {
  const { CodexAdapter } = await import('../src/adapters/codex.js');
  const home = freshFakeHome();
  const agents = writeAt(home, 'ws/AGENTS.md', [
    '# Codex 配置',
    '这是前言说明。',
    '',
    '## 用户身份',
    '用户叫狂且。',
    '## ODPS 查询',
    '### 连接信息',
    '- project: cco',
  ].join('\n'));

  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents] });
  assert.deepEqual(adapter.discover(), [agents]);
  const entries = adapter.parse(adapter.read(agents));
  assert.equal(entries.length, 3, '前言 + 两节');
  assert.equal(entries[0].title, 'Codex 配置');
  assert.equal(entries[1].title, '用户身份');
  assert.equal(entries[2].title, 'ODPS 查询');
  assert.match(entries[2].body, /project: cco/, '节内含 ### 小节内容');
});

test('qoder：动态发现 category，合规条目产出、无 frontmatter 跳过并警告', async () => {
  const { QoderAdapter } = await import('../src/adapters/qoder.js');
  const home = freshFakeHome();
  const root = path.join(home, '.qoder/memories/acct1');
  const good = writeAt(home, '.qoder/memories/acct1/projects/proj1/project_introduction/good.md', [
    '---',
    'title: "项目定位"',
    'usage_scenario: ["诊断"]',
    'keywords:',
    '    - "RAG"',
    'source: user',
    '---',
    '',
    '这是正文。',
  ].join('\n'));
  const bad = writeAt(home, '.qoder/memories/acct1/projects/proj1/user_info/bad.md', '纯文本没有 frontmatter');

  const adapter = new QoderAdapter({ id: 'qoder', enabled: true, memory_paths: [root] });
  const files = adapter.discover();
  assert.equal(files.length, 2, '动态发现两个 category 下的文件');

  const goodEntries = adapter.parse(adapter.read(good));
  assert.equal(goodEntries.length, 1);
  assert.equal(goodEntries[0].title, '项目定位');
  assert.deepEqual(goodEntries[0].frontmatter.usage_scenario, ['诊断']);
  assert.deepEqual(goodEntries[0].frontmatter.keywords, ['RAG']);

  const badEntries = adapter.parse(adapter.read(bad));
  assert.equal(badEntries.length, 0, '无 frontmatter 被跳过');
  assert.ok(adapter.warnings.length >= 1, '记录了跳过警告');
  assert.match(adapter.warnings[0], /bad\.md/);
});

test('qoderwork：§ 分隔 + importance 注释 + daily memory-chat 块', async () => {
  const { QoderworkAdapter } = await import('../src/adapters/qoderwork.js');
  const home = freshFakeHome();
  const main = path.join(home, '.qoderwork/awareness/main');
  writeAt(home, '.qoderwork/awareness/main/MEMORY.md', [
    '<!-- importance: critical -->',
    '## 数据报告风格',
    '- 客观第三人称。',
    '§',
    '无标题的纯段落条目，直接以文字开始。',
    '§',
    '<!-- importance: normal -->',
    '## 另一个条目',
    '正文内容。',
  ].join('\n'));
  writeAt(home, '.qoderwork/awareness/main/memory/2026-01-01.md', [
    '<!-- memory-chat:abc123 -->',
    '## Session: 泡泡玛特诊断',
    '- 完成报告生成',
    '<!-- /memory-chat:abc123 -->',
  ].join('\n'));
  // 索引/状态文件必须被忽略
  writeAt(home, '.qoderwork/awareness/main/.index.sqlite', 'binary');
  writeAt(home, '.qoderwork/awareness/main/.hash-state.json', '{}');

  const adapter = new QoderworkAdapter({ id: 'qoderwork', enabled: true, memory_paths: [main] });
  const files = adapter.discover();
  assert.ok(files.some((f) => f.endsWith('MEMORY.md')));
  assert.ok(files.some((f) => f.endsWith('2026-01-01.md')));
  assert.ok(!files.some((f) => f.includes('.index.sqlite')), 'sqlite 被忽略');
  assert.ok(!files.some((f) => f.includes('.hash-state.json')), '索引状态被忽略');

  const memEntries = adapter.parse(adapter.read(path.join(main, 'MEMORY.md')));
  assert.equal(memEntries.length, 3, '三个 § 分块');
  assert.equal(memEntries[0].title, '数据报告风格');
  assert.equal(memEntries[0].frontmatter.importance, 'critical');
  assert.match(memEntries[1].title, /无标题的纯段落条目/, '无标题段落取首行作标题');
  assert.equal(memEntries[2].frontmatter.importance, 'normal');

  const dailyEntries = adapter.parse(adapter.read(path.join(main, 'memory/2026-01-01.md')));
  assert.equal(dailyEntries.length, 1);
  assert.equal(dailyEntries[0].title, '泡泡玛特诊断');
  assert.equal(dailyEntries[0].frontmatter.chatId, 'abc123');
});

test('wukong：workspace 三文件按 ## 时间戳/标题分节，排除 .lock/.sync_node', async () => {
  const { WukongAdapter } = await import('../src/adapters/wukong.js');
  const home = freshFakeHome();
  const ws = path.join(home, '.real/users/u1/workspace');
  writeAt(home, '.real/users/u1/workspace/MEMORY.md', [
    '',
    '## 2026-06-10 01:52 UTC',
    'User subscribes to daily report.',
    '',
    '## 记忆测试',
    '外部写入测试条目。',
  ].join('\n'));
  writeAt(home, '.real/users/u1/workspace/SOUL.md', '## 风格\n果断执行。');
  writeAt(home, '.real/users/u1/workspace/MEMORY.md.lock', '');
  writeAt(home, '.real/users/u1/workspace/.sync_node/x', 'y');

  const adapter = new WukongAdapter({ id: 'wukong', enabled: true, memory_paths: [ws] });
  const files = adapter.discover();
  assert.ok(files.some((f) => f.endsWith('MEMORY.md')));
  assert.ok(files.some((f) => f.endsWith('SOUL.md')));
  assert.ok(!files.some((f) => f.endsWith('MEMORY.md.lock')), '.lock 被排除');

  const entries = adapter.parse(adapter.read(path.join(ws, 'MEMORY.md')));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, '2026-06-10 01:52 UTC', '时间戳标题');
  assert.equal(entries[1].title, '记忆测试');
});

// ---------------------------------------------------------------------------
// 2. hash-state 对账：全量 / 零变化 / 精确识别
// ---------------------------------------------------------------------------

test('hash-state：首次全量摄取、二次零摄取、改内容后精确识别变化文件', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, getChangedFiles, loadHashState } = await import('../src/hub-store.js');
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const foo = writeAt(home, '.claude/projects/proj/memory/foo.md', '---\nname: foo\n---\n内容A');
  const bar = writeAt(home, '.claude/projects/proj/memory/bar.md', '---\nname: bar\n---\n内容B');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });

  // 首次全量
  const first = harvest(adapter);
  assert.equal(first.files, 2, '首次摄取两个文件');
  assert.equal(first.ingested, 2);
  const state = loadHashState();
  assert.ok(state.files[foo], 'hash-state 记录 foo');
  assert.ok(state.files[bar], 'hash-state 记录 bar');

  // 二次无变化 → 零摄取
  const second = harvest(adapter);
  assert.equal(second.ingested, 0, '无变化时零摄取');
  assert.equal(second.files, 0);

  // 只改 foo → 精确识别
  fs.writeFileSync(foo, '---\nname: foo\n---\n内容A-已改');
  bumpMtime(foo);
  const changed = getChangedFiles(adapter);
  assert.deepEqual(changed.modified, [foo], '仅识别出被改的 foo');
  assert.deepEqual(changed.added, []);

  const third = harvest(adapter);
  assert.equal(third.ingested, 1, '仅重摄取 foo');
});

test('hash-state：源文件删除后被识别为 removed 并清理状态', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, getChangedFiles, loadHashState } = await import('../src/hub-store.js');
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const gone = writeAt(home, '.claude/projects/proj/memory/gone.md', '---\nname: gone\n---\nx');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });

  harvest(adapter);
  assert.ok(loadHashState().files[gone]);

  fs.rmSync(gone);
  const changed = getChangedFiles(adapter);
  assert.deepEqual(changed.removed, [gone], '删除文件被识别为 removed');

  harvest(adapter);
  assert.equal(loadHashState().files[gone], undefined, '状态已清理');
});

// ---------------------------------------------------------------------------
// 3. watcher 集成：改文件 → 快照 + hash-state；再改增量；自写回环抑制
// ---------------------------------------------------------------------------

test('watcher 集成：修改 → 快照出现 + hash-state 更新 → 增量 → 自写被抑制', async () => {
  const { Watcher, registerInflight } = await import('../src/watcher.js');
  const { loadHashState } = await import('../src/hub-store.js');
  const { sha256Of } = await import('../src/adapters/base.js');
  const root = freshHubRoot();
  const home = freshFakeHome();
  const ws = path.join(home, '.real/users/u1/workspace');
  const memFile = writeAt(home, '.real/users/u1/workspace/MEMORY.md', '## 2026-06-10 01:52 UTC\n初始内容\n');

  const config = {
    apps: [{ id: 'wukong', enabled: true, memory_paths: [ws] }],
    debounceMs: 200,
    pollIntervalMs: 999999, // 测试期间不触发轮询
  };
  const watcher = new Watcher(config);
  watcher.start({ signals: false });
  await watcher.whenReady();
  assert.equal(countSnapshots('wukong'), 0, 'ignoreInitial：启动时不摄取');

  // 第一次修改 → debounce 后出现快照 + hash-state 更新
  fs.writeFileSync(memFile, '## 2026-06-10 01:52 UTC\n第一次修改\n');
  bumpMtime(memFile);
  assert.ok(await waitFor(() => countSnapshots('wukong') >= 1), '第一次修改产生快照');
  assert.ok(await waitFor(() => !!loadHashState().files[memFile]), 'hash-state 已记录该文件');
  const afterFirst = countSnapshots('wukong');

  // 第二次修改 → 增量再产生一个快照
  fs.writeFileSync(memFile, '## 2026-06-10 01:52 UTC\n第二次修改\n');
  bumpMtime(memFile);
  assert.ok(await waitFor(() => countSnapshots('wukong') >= afterFirst + 1), '第二次修改增量产生快照');

  // 自写回环抑制：registerInflight 后自写触发的事件被丢弃
  await sleep(400); // 等第二次事件完全落定，避免 debounce 交叠
  const before = countSnapshots('wukong');
  const selfContent = '## 2026-06-10 01:52 UTC\n写回引擎自写内容\n';
  registerInflight(memFile, sha256Of(selfContent));
  fs.writeFileSync(memFile, selfContent);
  bumpMtime(memFile);
  // 抑制 = 等足够久也不新增快照（反向断言）
  await sleep(1200);
  assert.equal(countSnapshots('wukong'), before, '自写事件被抑制，未产生新快照');

  await watcher.stop();
});

// ---------------------------------------------------------------------------
// 4. master-index 生成
// ---------------------------------------------------------------------------

test('master-index：空 wiki 输出空索引说明；有页面时一行一摘要', async () => {
  const { generateMasterIndex, storePaths, ensureHubStore } = await import('../src/hub-store.js');
  freshHubRoot();
  ensureHubStore();

  // 空 wiki → 空索引说明
  const emptyIdx = generateMasterIndex();
  const emptyContent = fs.readFileSync(emptyIdx, 'utf8');
  assert.match(emptyContent, /尚无任何页面/);

  // 写入一个 wiki 页面 → 索引包含一行摘要
  const page = path.join(storePaths.wiki, 'topic-a.md');
  fs.writeFileSync(page, '# 主题 A\n\n这是主题 A 的摘要内容。\n');
  generateMasterIndex();
  const content = fs.readFileSync(storePaths.masterIndex, 'utf8');
  assert.match(content, /\[主题 A\]\(topic-a\.md\)/);
  assert.match(content, /这是主题 A 的摘要内容/);
});

test('sources 快照：文件头含来源元数据块（app/源路径/sha256）', async () => {
  const { ClaudeAdapter } = await import('../src/adapters/claude.js');
  const { harvest, storePaths } = await import('../src/hub-store.js');
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const src = writeAt(home, '.claude/projects/proj/memory/note.md', '---\nname: note\n---\n快照正文');
  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  harvest(adapter);

  const snapDir = path.join(storePaths.sources, 'claude');
  const snaps = fs.readdirSync(snapDir).filter((n) => n.endsWith('.md'));
  assert.equal(snaps.length, 1);
  const snapContent = fs.readFileSync(path.join(snapDir, snaps[0]), 'utf8');
  assert.match(snapContent, /^---/, '以元数据块开头');
  // H5：yamlScalar 一律 JSON.stringify 输出（保证任意标题/值均产出可解析 YAML）
  assert.match(snapContent, /app: "claude"/);
  assert.match(snapContent, /source: /);
  assert.match(snapContent, /sha256: /);
  assert.match(snapContent, /快照正文/);
  assert.ok(snaps[0].match(/^\d{8}-\d{6}-/), '快照文件名含时间戳前缀');
});
