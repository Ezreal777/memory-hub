/**
 * test/test-writeback.js —— 五个适配器写回侧 + 并行写回引擎自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 hub/backups/state，伪造各 App 目录结构。
 * 绝不触碰真实的 ~/.claude / ~/.codex / ~/.qoder / ~/.qoderwork / ~/.real。
 *
 * 覆盖：
 * 1. 五个适配器 render 输出格式合规（claude frontmatter、codex 标记块、qoder 四字段、
 *    qoderwork chat 块、wukong 时间戳段）；
 * 2. 幂等：同一 entry 写两次，第二次跳过，文件无重复；
 * 3. verify 失败触发回滚：注入坏内容后目标文件恢复原状；
 * 4. 批次门禁：batch3Enabled=false 时 qoderwork/wukong 被跳过，--force-batch3 放行；
 * 5. codex 标记区整区重写不破坏区外内容；claude MEMORY.md 索引只追加不重写；
 * 6. writeback 引擎：双 app 并行成功 + 单 app 失败隔离、writeback-log 记录正确。
 *
 * 运行：npm test 或 node test/test-writeback.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter, HUB_MARK_START, HUB_MARK_END } from '../src/adapters/codex.js';
import { QoderAdapter, REQUIRED_FIELDS } from '../src/adapters/qoder.js';
import { QoderworkAdapter, todayStr } from '../src/adapters/qoderwork.js';
import { WukongAdapter } from '../src/adapters/wukong.js';
import {
  runWriteback,
  loadWritebackLog,
  BATCH3_GATE_MSG,
  EFFECT_NOTES,
} from '../src/writeback.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-wb-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 新建一个伪造的家目录。 */
function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-wb-home-'));
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

/** 构造统一 Entry。 */
function mkEntry(hubId, title, body, extra = {}) {
  return {
    hubId,
    app: extra.app || 'wiki',
    file: extra.file || '',
    title,
    body,
    frontmatter: extra.frontmatter,
    mtime: 0,
    sha256: '',
  };
}

/** 在 hub/wiki/ 写入一个带 hub-id frontmatter 的整理页。 */
function writeWikiPage(hubIds, slug, title, body) {
  const wikiDir = path.join(process.env.MEMORY_HUB_ROOT, 'hub', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  const fm = {
    'hub-id': hubIds,
    sources: [`fake-source-${slug}`],
    'last-updated': new Date().toISOString(),
    tags: ['测试'],
  };
  const p = path.join(wikiDir, `${slug}.md`);
  fs.writeFileSync(p, matter.stringify(`# ${title}\n\n${body}\n`, fm));
  return p;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. render 输出格式合规（五个适配器）
// ---------------------------------------------------------------------------

test('render 格式合规：claude frontmatter / codex 标记块 / qoder 四字段 / qoderwork chat 块 / wukong 时间戳段', async () => {
  freshHubRoot();
  const entry = mkEntry('hub-20260805-a1b2c3', '测试条目', '正文第一行\n正文第二行');

  // claude：frontmatter name/description/metadata{node_type,type,hubId}
  const claude = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [] });
  const cText = claude.render(entry);
  const cFm = matter(cText).data;
  assert.equal(cFm.name, '测试条目');
  assert.equal(cFm.description, '正文第一行');
  assert.equal(cFm.metadata.node_type, 'memory');
  assert.equal(cFm.metadata.type, 'hub-sync');
  assert.equal(cFm.metadata.hubId, 'hub-20260805-a1b2c3');
  assert.match(claude.renderIndexLine(entry, 'test.md'), /^- \[测试条目\]\(test\.md\) — 正文第一行$/);

  // codex：### 标题 [hub-id] + 正文
  const codex = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [] });
  assert.match(codex.render(entry), /^### 测试条目 \[hub-20260805-a1b2c3\]\n\n正文第一行/);

  // qoder：四字段 frontmatter + 正文首行 [hub-id]
  const qoder = new QoderAdapter({ id: 'qoder', enabled: true, memory_paths: [] });
  const qFm = matter(qoder.render(entry)).data;
  for (const field of REQUIRED_FIELDS) {
    assert.ok(qFm[field] !== undefined, `qoder frontmatter 缺少 ${field}`);
  }
  assert.equal(qFm.source, 'memory-hub');
  assert.ok(Array.isArray(qFm.usage_scenario) && Array.isArray(qFm.keywords));
  assert.match(qoder.render(entry), /^---[\s\S]*?---\n\[hub-20260805-a1b2c3\]/);

  // qoderwork：成对 memory-chat 注释包裹 + ## Session 标题
  const qoderwork = new QoderworkAdapter({ id: 'qoderwork', enabled: true, memory_paths: [] });
  const wText = qoderwork.render(entry);
  assert.match(wText, /^<!-- memory-chat:hub-20260805-a1b2c3 -->/);
  assert.match(wText, /## Session: 测试条目/);
  assert.match(wText, /<!-- \/memory-chat:hub-20260805-a1b2c3 -->$/);

  // wukong：## YYYY-MM-DD HH:MM UTC 时间戳标题 + [hub-id] 标记
  const wukong = new WukongAdapter({ id: 'wukong', enabled: true, memory_paths: [] });
  const kText = wukong.render(entry);
  assert.match(kText, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\n\[hub-20260805-a1b2c3\] 测试条目/);
});

// ---------------------------------------------------------------------------
// 2. claude：双文件写入 + 索引只追加 + 幂等 + verify 失败回滚
// ---------------------------------------------------------------------------

test('claude：双文件写入、索引只追加不重写、幂等跳过、verify 失败整体回滚', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const originalIndex = [
    '- [User Identity](user_identity.md) — 狂且，好朋友',
    '- [ODPS Config](odps_config.md) — MaxCompute 连接信息',
  ].join('\n') + '\n';
  writeAt(home, '.claude/projects/proj/memory/MEMORY.md', originalIndex);

  const adapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  const entry = mkEntry('hub-20260805-c1a2b3', '写回测试', '这是写回测试正文。');

  // 首次写入：条目文件 + 索引追加
  const r1 = await adapter.write([entry]);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].status, 'written');
  const entryFile = path.join(memDir, '写回测试.md');
  assert.ok(fs.existsSync(entryFile), '条目文件已创建');
  const fm = matter(fs.readFileSync(entryFile, 'utf8')).data;
  assert.equal(fm.metadata.hubId, 'hub-20260805-c1a2b3');

  const indexAfter = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  assert.ok(indexAfter.startsWith(originalIndex), '既有索引行一字未改（只追加）');
  assert.match(indexAfter, /- \[写回测试\]\(写回测试\.md\) — 这是写回测试正文。/);

  // verify 通过
  assert.equal(adapter.verify([entry]).ok, true);

  // 幂等：第二次写入跳过，索引无重复行
  const r2 = await adapter.write([entry]);
  assert.equal(r2[0].status, 'skipped');
  const indexAfter2 = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  assert.equal(indexAfter2, indexAfter, '重放不重复追加');
  assert.equal(indexAfter2.match(/写回测试\.md/g).length, 1, '索引行仅出现一次');

  // verify 失败 → 整体回滚：注入坏 render（无 frontmatter）
  const badAdapter = new ClaudeAdapter({ id: 'claude', enabled: true, memory_paths: [memDir] });
  badAdapter.render = () => '没有 frontmatter 的坏内容';
  const badEntry = mkEntry('hub-20260805-bad001', '坏条目', 'x');
  await assert.rejects(() => badAdapter.write([badEntry]), /校验失败/);
  assert.equal(
    fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8'),
    indexAfter2,
    '回滚后 MEMORY.md 恢复原状',
  );
  assert.ok(!fs.existsSync(path.join(memDir, '坏条目.md')), '首次写入的坏文件已删除，无残留');
});

// ---------------------------------------------------------------------------
// 3. codex：标记区整区重写、区外内容不受影响、幂等
// ---------------------------------------------------------------------------

test('codex：标记区整区重写不破坏区外内容，重放幂等', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  // 手工构造：标记区位于文件中部，区后还有内容（验证 after 段不被触碰）
  const agents = writeAt(home, 'ws/AGENTS.md', [
    '# Codex 配置',
    '这是前言，区外内容。',
    '',
    HUB_MARK_START,
    '### 旧条目 [hub-old-001]',
    '',
    '旧条目正文',
    HUB_MARK_END,
    '',
    '区后尾部内容，绝不能被改动。',
  ].join('\n'));

  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents] });
  const entry = mkEntry('hub-20260805-cdx001', '新条目', '新条目正文。');
  const r1 = await adapter.write([entry]);
  assert.equal(r1[0].status, 'written');

  const after1 = fs.readFileSync(agents, 'utf8');
  assert.ok(after1.includes('# Codex 配置'), '区前前言保留');
  assert.ok(after1.includes('这是前言，区外内容。'), '区外内容保留');
  assert.ok(after1.includes('区后尾部内容，绝不能被改动。'), '区后内容保留');
  assert.ok(after1.includes('### 旧条目 [hub-old-001]'), '区内旧条目保留');
  assert.ok(after1.includes('### 新条目 [hub-20260805-cdx001]'), '新条目已入区');
  assert.equal(adapter.verify([entry]).ok, true);

  // 重放：内容无变化 → skipped
  const r2 = await adapter.write([entry]);
  assert.equal(r2[0].status, 'skipped');
  assert.equal(fs.readFileSync(agents, 'utf8'), after1);

  // 无标记区的文件 → 文末追加创建，区外原文一字不动
  const agents2 = writeAt(home, 'ws2/AGENTS.md', '# 工作区\n原始内容。\n');
  const adapter2 = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents2] });
  await adapter2.write([entry]);
  const after2 = fs.readFileSync(agents2, 'utf8');
  assert.ok(after2.startsWith('# 工作区\n原始内容。'), '原内容保留在文件头部');
  assert.ok(after2.includes(HUB_MARK_START) && after2.includes(HUB_MARK_END));
});

// ---------------------------------------------------------------------------
// 4. qoder：分类目录写入 + 四字段自检拒写 + 幂等
// ---------------------------------------------------------------------------

test('qoder：写入 projects/<slug>/<category>/、四字段自检拒写、幂等跳过', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const root = path.join(home, '.qoder/memories/acct1');
  fs.mkdirSync(root, { recursive: true });

  const adapter = new QoderAdapter({
    id: 'qoder',
    enabled: true,
    memory_paths: [root],
    project_slug: 'Users-kuangju-Desktop',
  });
  const entry = mkEntry('hub-20260805-qd0001', '项目定位', '这是项目定位正文。', {
    frontmatter: { category: 'user_info', keywords: ['K1', 'K2'] },
  });

  const r1 = await adapter.write([entry]);
  assert.equal(r1[0].status, 'written');
  const target = path.join(root, 'projects/Users-kuangju-Desktop/user_info/项目定位.md');
  assert.ok(fs.existsSync(target), '写入 category=user_info 目录');
  const fm = matter(fs.readFileSync(target, 'utf8')).data;
  assert.equal(fm.title, '项目定位');
  assert.deepEqual(fm.keywords, ['K1', 'K2']);
  assert.equal(fm.source, 'memory-hub');
  assert.match(fs.readFileSync(target, 'utf8'), /\[hub-20260805-qd0001\]/, '正文首行含 hub-id 标记');
  assert.match(r1[0].note, /知识中心面板确认/, '输出成熟度提示');
  assert.equal(adapter.verify([entry]).ok, true);

  // 缺省 category → project_introduction
  const entry2 = mkEntry('hub-20260805-qd0002', '默认分类', '正文');
  await adapter.write([entry2]);
  assert.ok(
    fs.existsSync(path.join(root, 'projects/Users-kuangju-Desktop/project_introduction/默认分类.md')),
    '缺省 category 落到 project_introduction',
  );

  // 幂等：第二次写入跳过
  const r2 = await adapter.write([entry]);
  assert.equal(r2[0].status, 'skipped');

  // 写前自检：坏 render 缺字段 → 抛错拒写，磁盘无新增
  const badAdapter = new QoderAdapter({
    id: 'qoder',
    enabled: true,
    memory_paths: [root],
    project_slug: 'Users-kuangju-Desktop',
  });
  badAdapter.render = () => '---\ntitle: 只有标题\n---\n正文\n';
  await assert.rejects(
    () => badAdapter.write([mkEntry('hub-20260805-qdbad1', '坏条目', 'x')]),
    /写前自检失败/,
  );
  assert.ok(
    !fs.existsSync(path.join(root, 'projects/Users-kuangju-Desktop/project_introduction/坏条目.md')),
    '自检拒写后无文件落盘',
  );
});

// ---------------------------------------------------------------------------
// 5. qoderwork：只追加当天 daily、绝不写 MEMORY.md、幂等
// ---------------------------------------------------------------------------

test('qoderwork：只追加当天 memory/YYYY-MM-DD.md，绝不写 MEMORY.md，幂等跳过', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const main = path.join(home, '.qoderwork/awareness/main');
  const memOriginal = '## 原有条目\n原生内容。\n';
  writeAt(home, '.qoderwork/awareness/main/MEMORY.md', memOriginal);

  const adapter = new QoderworkAdapter({ id: 'qoderwork', enabled: true, memory_paths: [main] });
  const entry = mkEntry('hub-20260805-qw0001', '写回会话', '- 会话要点一\n- 会话要点二');

  const r1 = await adapter.write([entry]);
  assert.equal(r1[0].status, 'written');
  const dailyPath = path.join(main, 'memory', `${todayStr()}.md`);
  assert.ok(fs.existsSync(dailyPath), '当天 daily 文件已创建');
  const daily = fs.readFileSync(dailyPath, 'utf8');
  assert.match(daily, /<!-- memory-chat:hub-20260805-qw0001 -->/);
  assert.match(daily, /<!-- \/memory-chat:hub-20260805-qw0001 -->/);
  assert.match(daily, /## Session: 写回会话/);
  assert.match(r1[0].note, /重建搜索索引/, '输出索引提示');
  assert.equal(fs.readFileSync(path.join(main, 'MEMORY.md'), 'utf8'), memOriginal, 'MEMORY.md 未被触碰');
  assert.equal(adapter.verify([entry]).ok, true);

  // 幂等：第二次写入跳过，daily 无重复块
  const r2 = await adapter.write([entry]);
  assert.equal(r2[0].status, 'skipped');
  const daily2 = fs.readFileSync(dailyPath, 'utf8');
  assert.equal(daily2.match(/memory-chat:hub-20260805-qw0001/g).length, 2, '开闭标记各仅一次');
});

test('qoderwork：幂等与校验跨全部 daily 文件（昨天写过的条目隔天不重灌）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const main = path.join(home, '.qoderwork/awareness/main');

  // 模拟昨天已写入的条目（历史日期 daily 文件里已有成对标记）
  writeAt(home, '.qoderwork/awareness/main/memory/2026-01-02.md', [
    '<!-- memory-chat:hub-20260805-qw0002 -->',
    '## Session: 昨天写的会话',
    '旧内容。',
    '<!-- /memory-chat:hub-20260805-qw0002 -->',
    '',
  ].join('\n'));

  const adapter = new QoderworkAdapter({ id: 'qoderwork', enabled: true, memory_paths: [main] });
  const entry = mkEntry('hub-20260805-qw0002', '昨天写的会话', '新一轮全量写回的同一条目。');

  // 隔天重放：跳过，不在今天的 daily 文件里重写
  const r = await adapter.write([entry]);
  assert.equal(r[0].status, 'skipped', '历史 daily 已含条目应跳过');
  assert.match(r[0].targets[0], /2026-01-02\.md$/, '命中的是历史日期文件');
  assert.ok(!fs.existsSync(path.join(main, 'memory', `${todayStr()}.md`)), '今天的 daily 文件不应被创建');

  // 校验同口径：历史文件里的条目不误判为缺失
  const check = adapter.verify([entry]);
  assert.equal(check.ok, true, '跨文件校验应通过');
  assert.deepEqual(check.failedIds, [], '无失败条目');

  // 真正缺失的条目仍能报出 failedIds（N3 按条目回滚依据）
  const missing = mkEntry('hub-20260805-qw9999', '不存在的条目', '正文');
  const check2 = adapter.verify([missing]);
  assert.equal(check2.ok, false);
  assert.deepEqual(check2.failedIds, ['hub-20260805-qw9999']);
});

test('qoderwork：每日配额防灌爆——超额条目 skipped 后续轮次续写', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const main = path.join(home, '.qoderwork/awareness/main');
  const { QODERWORK_DAILY_QUOTA } = await import('../src/adapters/qoderwork.js');

  // 当天文件预填到只剩 1 个配额
  const blocks = [];
  for (let i = 0; i < QODERWORK_DAILY_QUOTA - 1; i += 1) {
    blocks.push(`<!-- memory-chat:native-${i} -->`, `块 ${i}`, `<!-- /memory-chat:native-${i} -->`, '');
  }
  writeAt(home, `.qoderwork/awareness/main/memory/${todayStr()}.md`, blocks.join('\n'));

  const adapter = new QoderworkAdapter({ id: 'qoderwork', enabled: true, memory_paths: [main] });
  const e1 = mkEntry('hub-20260805-quota1', '配额内条目', '能写入。');
  const e2 = mkEntry('hub-20260805-quota2', '超额条目', '本轮该跳过。');

  const r = await adapter.write([e1, e2]);
  assert.equal(r[0].status, 'written', '配额内正常写入');
  assert.equal(r[1].status, 'skipped', '超额条目跳过');
  assert.match(r[1].reason, /配额已满/);
  const daily = fs.readFileSync(path.join(main, 'memory', `${todayStr()}.md`), 'utf8');
  assert.ok(daily.includes('memory-chat:hub-20260805-quota1'));
  assert.ok(!daily.includes('memory-chat:hub-20260805-quota2'), '超额条目未落盘');
});

// ---------------------------------------------------------------------------
// 6. wukong：时间戳段追加、幂等、只读配置、锁/同步忙碌延迟重试后放弃
// ---------------------------------------------------------------------------

test('wukong：时间戳段追加、幂等跳过、readOnly 不写回、锁忙碌延迟重试后放弃', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const ws = path.join(home, '.real/users/u1/workspace');
  const memOriginal = '\n## 2026-06-10 01:52 UTC\n原有条目。\n';
  writeAt(home, '.real/users/u1/workspace/MEMORY.md', memOriginal);
  writeAt(home, '.real/users/u1/workspace/MEMORY.md.lock', ''); // 0 字节常驻锁 → 空闲

  const adapter = new WukongAdapter({ id: 'wukong', enabled: true, memory_paths: [ws] });
  const entry = mkEntry('hub-20260805-wk0001', '写回段落', '悟空写回正文。');

  const r1 = await adapter.write([entry]);
  assert.equal(r1[0].status, 'written');
  const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
  assert.ok(mem.startsWith(memOriginal), '原内容保留（追加式）');
  assert.match(mem, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m, '时间戳标题段');
  assert.match(mem, /\[hub-20260805-wk0001\] 写回段落/);
  assert.match(r1[0].note, /云端同步覆盖风险/, '输出覆盖风险提示');
  assert.equal(adapter.verify([entry]).ok, true);

  // 幂等：第二次写入跳过
  const r2 = await adapter.write([entry]);
  assert.equal(r2[0].status, 'skipped');
  assert.equal(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8'), mem);

  // readOnly 配置 → 不写回
  const roAdapter = new WukongAdapter({ id: 'wukong', enabled: true, memory_paths: [ws], readOnly: true });
  const r3 = await roAdapter.write([mkEntry('hub-20260805-wk0002', '只读测试', 'x')]);
  assert.equal(r3[0].status, 'skipped');
  assert.match(r3[0].reason, /只读/);
  assert.equal(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8'), mem, 'readOnly 未改动文件');

  // 锁忙碌（lock 文件 > 0 字节）→ 延迟重试（注入小间隔）后放弃并记录
  fs.writeFileSync(path.join(ws, 'MEMORY.md.lock'), 'busy');
  const r4 = await adapter.write([mkEntry('hub-20260805-wk0003', '忙碌测试', 'x')], {
    maxRetries: 2,
    retryDelayMs: 5,
  });
  assert.equal(r4[0].status, 'deferred');
  assert.match(r4[0].reason, /重试 2 次后放弃/);
  assert.ok(!fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8').includes('hub-20260805-wk0003'));
  fs.writeFileSync(path.join(ws, 'MEMORY.md.lock'), ''); // 还原 0 字节

  // .sync_node 近 5 分钟有活动 → 同样判定忙碌
  writeAt(home, '.real/users/u1/workspace/.sync_node/sync.log', 'active');
  const r5 = await adapter.write([mkEntry('hub-20260805-wk0004', '同步测试', 'x')], {
    maxRetries: 1,
    retryDelayMs: 5,
  });
  assert.equal(r5[0].status, 'deferred');
  assert.match(r5[0].reason, /sync_node/);
});

// ---------------------------------------------------------------------------
// 7. writeback 引擎：批次门禁 + --force-batch3 放行
// ---------------------------------------------------------------------------

test('writeback 引擎：batch3Enabled=false 时 qoderwork/wukong 被跳过，--force-batch3 放行', async () => {
  const root = freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const qwDir = path.join(home, '.qoderwork/awareness/main');
  const wsDir = path.join(home, '.real/users/u1/workspace');
  fs.mkdirSync(memDir, { recursive: true });
  writeWikiPage(['hub-20260805-gate01'], 'gate-topic', '门禁主题', '门禁测试正文。');

  const config = {
    apps: [
      { id: 'claude', enabled: true, memory_paths: [memDir] },
      { id: 'qoderwork', enabled: true, memory_paths: [qwDir] },
      { id: 'wukong', enabled: true, memory_paths: [wsDir] },
    ],
    writeback: { batch3Enabled: false },
  };
  const makeAdapters = () => [
    new ClaudeAdapter(config.apps[0]),
    new QoderworkAdapter(config.apps[1]),
    new WukongAdapter(config.apps[2]),
  ];

  // 门禁关闭：batch:3 两家跳过（固定话术），claude 正常写入
  const r1 = await runWriteback({ config, adapters: makeAdapters() });
  const byApp1 = Object.fromEntries(r1.appResults.map((r) => [r.app, r]));
  assert.equal(byApp1.claude.status, 'written');
  assert.equal(byApp1.qoderwork.status, 'skipped');
  assert.equal(byApp1.qoderwork.reason, BATCH3_GATE_MSG);
  assert.equal(byApp1.wukong.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(qwDir, 'memory')), 'qoderwork 未产生任何文件');
  assert.ok(!fs.existsSync(path.join(wsDir, 'MEMORY.md')), 'wukong 未产生任何文件');

  // --force-batch3 放行：两家真实写入
  const r2 = await runWriteback({ config, adapters: makeAdapters(), forceBatch3: true });
  const byApp2 = Object.fromEntries(r2.appResults.map((r) => [r.app, r]));
  assert.equal(byApp2.qoderwork.status, 'written');
  assert.equal(byApp2.wukong.status, 'written');
  assert.ok(fs.existsSync(path.join(qwDir, 'memory', `${todayStr()}.md`)));
  assert.ok(fs.readFileSync(path.join(wsDir, 'MEMORY.md'), 'utf8').includes('hub-20260805-gate01'));
  // claude 幂等跳过（第一次已写入）
  assert.equal(byApp2.claude.entries[0].status, 'skipped');
  assert.ok(fs.existsSync(root), 'hub root 存在');
});

// ---------------------------------------------------------------------------
// 8. writeback 引擎：双 app 并行成功 + 单 app 失败隔离 + writeback-log
// ---------------------------------------------------------------------------

test('writeback 引擎：双 app 并行成功 + 单 app 失败隔离、writeback-log 记录正确', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  const agents = writeAt(home, 'ws/AGENTS.md', '# Codex\n前言。\n');
  fs.mkdirSync(memDir, { recursive: true });
  writeWikiPage(['hub-20260805-par001'], 'parallel-topic', '并行主题', '并行写回正文。');

  const config = {
    apps: [
      { id: 'claude', enabled: true, memory_paths: [memDir] },
      { id: 'codex', enabled: true, memory_paths: [agents] },
      { id: 'qoder', enabled: true, memory_paths: [path.join(home, '.qoder/memories/acct1')], project_slug: 'proj' },
    ],
    writeback: { batch3Enabled: false },
  };
  // 注入一个必然失败的 qoder 适配器，验证单 app 失败不影响其他
  const failingQoder = {
    id: 'qoder',
    render: () => '',
    write: async () => {
      throw new Error('模拟写回失败');
    },
  };

  const result = await runWriteback({
    config,
    adapters: [new ClaudeAdapter(config.apps[0]), new CodexAdapter(config.apps[1]), failingQoder],
  });
  const byApp = Object.fromEntries(result.appResults.map((r) => [r.app, r]));
  assert.equal(byApp.claude.status, 'written', 'claude 并行写成功');
  assert.equal(byApp.codex.status, 'written', 'codex 并行写成功');
  assert.equal(byApp.qoder.status, 'failed', 'qoder 失败被隔离');
  assert.match(byApp.qoder.error, /模拟写回失败/);
  // 各 app 附带「何时生效」说明
  assert.equal(byApp.claude.effectNote, EFFECT_NOTES.claude);
  assert.equal(byApp.codex.effectNote, EFFECT_NOTES.codex);
  // claude/codex 实际落盘
  assert.ok(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8').includes('并行主题'));
  assert.ok(fs.readFileSync(agents, 'utf8').includes('[hub-20260805-par001]'));

  // writeback-log：时间/app/hub-id/结果/备份目录 字段齐全
  const log = loadWritebackLog();
  const claudeRec = log.find((r) => r.app === 'claude' && r.hubId === 'hub-20260805-par001');
  const qoderRec = log.find((r) => r.app === 'qoder');
  assert.ok(claudeRec, 'claude 记录存在');
  assert.equal(claudeRec.result, 'written');
  assert.ok(claudeRec.backupDir === null || typeof claudeRec.backupDir === 'string');
  assert.ok(claudeRec.time, '有时间戳');
  assert.ok(qoderRec && qoderRec.result.startsWith('failed'), '失败记录存在');
});

// ---------------------------------------------------------------------------
// 9. writeback 引擎：--dry-run 不落盘、--entry 过滤、--app 单家、--from-sources
// ---------------------------------------------------------------------------

test('writeback 引擎：dry-run 不落盘、--entry 过滤、--app 单家、--from-sources 透传', async () => {
  const root = freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  fs.mkdirSync(memDir, { recursive: true });
  writeWikiPage(['hub-20260805-dry001'], 'dry-topic', '演练主题', '演练正文。');

  const config = {
    apps: [{ id: 'claude', enabled: true, memory_paths: [memDir] }],
    writeback: { batch3Enabled: false },
  };
  const adapters = [new ClaudeAdapter(config.apps[0])];

  // dry-run：只打印 render，不产生任何写入
  const dry = await runWriteback({ config, adapters, dryRun: true });
  assert.equal(dry.appResults[0].status, 'dry-run');
  assert.match(dry.appResults[0].entries[0].render, /metadata/, '打印了 render 结果');
  assert.ok(!fs.existsSync(path.join(memDir, 'MEMORY.md')), 'dry-run 未落盘');
  assert.equal(loadWritebackLog().length, 0, 'dry-run 不记日志');

  // --entry 过滤：不存在的 hubId → 空结果提示
  const miss = await runWriteback({ config, adapters, entry: 'hub-nonexistent' });
  assert.match(miss.message, /没有可写回的页面/);

  // --app 单家 + 真实写入
  const one = await runWriteback({ config, adapters, app: 'claude' });
  assert.equal(one.appResults[0].status, 'written');
  assert.ok(fs.existsSync(path.join(memDir, '演练主题.md')));

  // --app 未知 id → 明确错误
  const bad = await runWriteback({ config, adapters, app: 'unknown' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /没有可写回的适配器/);

  // --from-sources：直接用 sources 快照透传
  const snapDir = path.join(root, 'hub', 'sources', 'claude');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapDir, '20260805-000000-snap.md'),
    '---\nhubId: hub-20260805-src001\napp: claude\ntitle: 透传条目\ningestedAt: 2026-08-05\nsha256: x\n---\n\n# 透传条目\n\n透传正文。\n',
  );
  const fromSrc = await runWriteback({ config, adapters, fromSources: true, entry: 'hub-20260805-src001' });
  assert.equal(fromSrc.appResults[0].status, 'written');
  assert.ok(fs.existsSync(path.join(memDir, '透传条目.md')));
});

// ---------------------------------------------------------------------------
// 10. Bug#5：writeback-log 中 skipped 记录必须携带 reason（不再出现 undefined）
// ---------------------------------------------------------------------------

test('Bug#5：writeback-log 的 skipped 记录携带 reason，绝无 "skipped: undefined"', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const agents = writeAt(home, 'ws/AGENTS.md', '# Codex\n前言。\n');
  writeWikiPage(['hub-20260805-log001'], 'log-topic', '日志主题', '日志测试正文。');

  const config = {
    apps: [{ id: 'codex', enabled: true, memory_paths: [agents] }],
    writeback: { batch3Enabled: false },
  };
  const makeAdapters = () => [new CodexAdapter(config.apps[0])];

  // 第一次真实写入
  await runWriteback({ config, adapters: makeAdapters() });
  // 第二次重放：全量幂等跳过（App 级 skipped 且无顶层 reason，正是旧 bug 场景）
  const r2 = await runWriteback({ config, adapters: makeAdapters() });
  assert.equal(r2.appResults[0].status, 'skipped');

  const log = loadWritebackLog();
  for (const rec of log) {
    assert.ok(!String(rec.result).includes('undefined'), `日志出现 undefined: ${rec.result}`);
  }
  const skipRecs = log.filter((r) => r.app === 'codex' && r.result.startsWith('skipped'));
  assert.ok(skipRecs.length > 0, '存在 skipped 记录');
  for (const r of skipRecs) {
    assert.match(r.result, /^skipped: .+/, 'skipped 后必须跟具体原因');
    assert.ok(r.result.length > 'skipped: '.length);
  }
});

// ---------------------------------------------------------------------------
// 11. Bug#6：codex 首次插入标记区时区外内容与原文件逐字节一致
// ---------------------------------------------------------------------------

test('Bug#6：codex 首次插入标记区不多补空行，区外内容逐字节一致', async () => {
  freshHubRoot();
  const home = freshFakeHome();

  // 情形一：原文以换行结尾
  const original = '# 工作区\n原始内容，逐字节比对基准。\n';
  const agents = writeAt(home, 'ws/AGENTS.md', original);
  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents] });
  await adapter.write([mkEntry('hub-20260805-b6a001', 'B6 条目', '正文。')]);
  const after = fs.readFileSync(agents, 'utf8');
  const idx = after.indexOf(HUB_MARK_START);
  assert.ok(idx > 0);
  assert.equal(after.slice(0, idx), original, '区外内容与原文件逐字节一致（无多余空行）');
  assert.equal(after.split('\n\n' + HUB_MARK_START).length, 1, '标记区前不存在多余空行');

  // 情形二：原文末尾无换行 → 仅补一个换行分隔，不补空行
  const original2 = '# 无尾换行\n内容';
  const agents2 = writeAt(home, 'ws2/AGENTS.md', original2);
  const adapter2 = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents2] });
  await adapter2.write([mkEntry('hub-20260805-b6b002', 'B6 条目二', '正文。')]);
  const after2 = fs.readFileSync(agents2, 'utf8');
  assert.ok(
    after2.startsWith(`${original2}\n${HUB_MARK_START}\n`),
    '仅补一个换行分隔后紧跟标记区（不多补空行）',
  );
  assert.equal(after2.slice(0, after2.indexOf(HUB_MARK_START)), `${original2}\n`);
});
