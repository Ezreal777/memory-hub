/**
 * test/test-writeback-fixes.js —— 写回与适配器层 6 项修复自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 hub/backups/state/logs，伪造各 App 目录。
 * 绝不触碰真实的 ~/.memory-hub / ~/Desktop/Memory Hub / 各 App 记忆文件。
 *
 * 覆盖：
 * 1. H1 codex 多标记区自愈：findHubRegions / repairAgentsContent / repairFile /
 *    write 路径自动痊愈 / verify 区计数断言；
 * 2. H4 增量写回：pending-writeback.json 消费与清空、降级全量、失败保留、full 强制全量；
 * 3. M8 verify 纳入生产管线：写后校验失败 → 按备份回滚 + 标记 failed；
 * 4. N2 qoder 更新语义：内容比对原位重写、幂等跳过、category 变化也原位处理不搬移；
 * 5. 写回失败原因落 logs/writeback.log 诊断日志；
 * 6. M5 writeback-log 轮转：旧 JSON 数组迁移 JSONL、超限裁剪到最近 N 条；
 * 7. Task#9 repair 收敛增强：孤儿 start/end 标记清除、区外遗留 hub 块保守归并、
 *    用户伪块/围栏内容不触碰、strayBlocks 清单、verify 孤儿断言、幂等收敛。
 *
 * 运行：npm test 或 node test/test-writeback-fixes.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import {
  CodexAdapter,
  HUB_MARK_START,
  HUB_MARK_END,
  findHubRegions,
  splitHubRegion,
  repairAgentsContent,
  repairFile,
} from '../src/adapters/codex.js';
import { QoderAdapter } from '../src/adapters/qoder.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import {
  runWriteback,
  loadWritebackLog,
  appendWritebackLog,
  writebackLogPath,
  writebackDiagLogPath,
  pendingWritebackPath,
  loadPendingWriteback,
  clearPendingWriteback,
} from '../src/writeback.js';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-fix-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 新建一个伪造的家目录。 */
function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-fix-home-'));
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
function writeWikiPage(hubIds, slug, title, body, extraFm = {}) {
  const wikiDir = path.join(process.env.MEMORY_HUB_ROOT, 'hub', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  const fm = {
    'hub-id': hubIds,
    sources: [`fake-source-${slug}`],
    'last-updated': new Date().toISOString(),
    tags: ['测试'],
    ...extraFm,
  };
  const p = path.join(wikiDir, `${slug}.md`);
  fs.writeFileSync(p, matter.stringify(`# ${title}\n\n${body}\n`, fm));
  return p;
}

/** 写入增量清单 pending-writeback.json（distill 侧契约格式）。 */
function writePending(pages) {
  const file = pendingWritebackPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ updatedAt: new Date().toISOString(), pages }, null, 2)}\n`);
  return file;
}

/** 读取诊断日志全文（不存在返回空串）。 */
function readDiagLog() {
  try {
    return fs.readFileSync(writebackDiagLogPath(), 'utf8');
  } catch {
    return '';
  }
}

/** 构造一段标记区文本。 */
function region(...blocks) {
  return `${HUB_MARK_START}\n${blocks.join('\n\n')}\n${HUB_MARK_END}`;
}

const blockA1 = '### 条目A [hub-20260807-aaa001]\n\nA 第一版。';
const blockA2 = '### 条目A [hub-20260807-aaa001]\n\nA 第二版（应保留）。';
const blockB = '### 条目B [hub-20260807-bbb002]\n\nB 正文。';
const blockC = '### 条目C [hub-20260807-ccc003]\n\nC 正文。';

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

// ---------------------------------------------------------------------------
// 1. H1：findHubRegions / splitHubRegion 检测全部标记区
// ---------------------------------------------------------------------------

test('H1：findHubRegions 检测全部成对标记区，孤立 start 忽略', () => {
  const content = `# 前言\n\n${region(blockA1)}\n\n中间内容。\n\n${region(blockB)}\n\n尾部。\n`;
  const regions = findHubRegions(content);
  assert.equal(regions.length, 2);
  assert.ok(regions[0].body.includes('hub-20260807-aaa001'));
  assert.ok(regions[1].body.includes('hub-20260807-bbb002'));

  // splitHubRegion 按首区切分并附 count
  const split = splitHubRegion(content);
  assert.equal(split.count, 2);
  assert.ok(split.before.includes('# 前言'));
  assert.ok(split.region.includes('hub-20260807-aaa001'));
  assert.ok(split.after.includes('中间内容'), 'after 含首区之后的全部内容（含其余区）');

  // 孤立 start（其后无 end）不构成区
  const dangling = `${region(blockA1)}\n${HUB_MARK_START}\n残缺区无结尾\n`;
  assert.equal(findHubRegions(dangling).length, 1);

  // 无标记区
  assert.equal(findHubRegions('# 纯内容\n无标记区。\n').length, 0);
  assert.equal(splitHubRegion('# 纯内容\n').count, 0);
  assert.equal(splitHubRegion('# 纯内容\n').region, null);
});

// ---------------------------------------------------------------------------
// 2. H1：repairAgentsContent 多区合并去重（保留最后版本），区外内容保留
// ---------------------------------------------------------------------------

test('H1：repairAgentsContent 多区去重合并为单一区，重复块保留最后版本，区外内容原样', () => {
  const content = `# 工作区\n前言内容。\n\n${region(blockA1, blockB)}\n\n区间正文甲。\n\n${region(blockA2)}\n\n区间正文乙。\n\n${region(blockC)}\n\n尾部内容。\n`;
  const r = repairAgentsContent(content);
  assert.equal(r.changed, true);
  assert.equal(r.regionCount, 3);
  assert.equal(r.totalBlocks, 4);
  assert.equal(r.uniqueBlocks, 3);
  assert.equal(r.duplicateBlocks, 1);

  // 修复后仅剩单一标记区
  const healedRegions = findHubRegions(r.content);
  assert.equal(healedRegions.length, 1, '仅剩一个标记区');
  // 重复的 hub-id 保留最后出现的版本
  assert.ok(healedRegions[0].body.includes('A 第二版（应保留）'));
  assert.ok(!healedRegions[0].body.includes('A 第一版'));
  assert.ok(healedRegions[0].body.includes('B 正文'));
  assert.ok(healedRegions[0].body.includes('C 正文'));
  // 区外内容全部保留
  for (const text of ['# 工作区', '前言内容。', '区间正文甲。', '区间正文乙。', '尾部内容。']) {
    assert.ok(r.content.includes(text), `区外内容保留: ${text}`);
  }
  // 幂等：修复后再修复不再变化
  const again = repairAgentsContent(r.content);
  assert.equal(again.changed, false);
  assert.equal(again.regionCount, 1);

  // 单区/无区文件原样返回
  assert.equal(repairAgentsContent(`前言\n${region(blockA1)}\n`).changed, false);
  assert.equal(repairAgentsContent('# 无标记区\n').changed, false);
});

// ---------------------------------------------------------------------------
// 3. H1：repairFile 三态（missing/clean/repaired）+ 落盘修复带备份
// ---------------------------------------------------------------------------

test('H1：repairFile missing/clean/repaired 三态，落盘修复并产生备份', () => {
  freshHubRoot();
  const home = freshFakeHome();

  // missing：文件不存在
  const missing = repairFile(path.join(home, 'nope/AGENTS.md'));
  assert.equal(missing.status, 'missing');

  // clean：单一标记区无需修复
  const cleanPath = writeAt(home, 'clean/AGENTS.md', `# 干净\n${region(blockA1)}\n`);
  const clean = repairFile(cleanPath);
  assert.equal(clean.status, 'clean');
  assert.equal(clean.regionCount, 1);

  // repaired：多区文件被修复为单一区，且有备份目录可回溯
  const brokenContent = `# 坏文件\n\n${region(blockA1, blockB)}\n\n中间。\n\n${region(blockA2)}\n\n尾部。\n`;
  const brokenPath = writeAt(home, 'broken/AGENTS.md', brokenContent);
  const repaired = repairFile(brokenPath);
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.regionCount, 2);
  assert.equal(repaired.duplicateBlocks, 1);
  assert.ok(repaired.backupDir && fs.existsSync(repaired.backupDir), '备份目录存在');
  const healed = fs.readFileSync(brokenPath, 'utf8');
  assert.equal(findHubRegions(healed).length, 1);
  assert.ok(healed.includes('A 第二版（应保留）'));
  assert.ok(healed.includes('中间。') && healed.includes('尾部。'));
});

// ---------------------------------------------------------------------------
// 4. H1：codex write 路径自动自愈 + verify 区计数断言
// ---------------------------------------------------------------------------

test('H1：codex write 遇多标记区文件先自愈再合并，verify 断言区计数必须为 1', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const brokenContent = `# 工作区\n\n${region(blockA1)}\n\n中间内容。\n\n${region(blockA2, blockB)}\n\n尾部。\n`;
  const agents = writeAt(home, 'ws/AGENTS.md', brokenContent);
  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents] });

  // 自愈前：verify 因多标记区判失败
  const bad = adapter.verify([mkEntry('hub-20260807-bbb002', '条目B', 'B 正文。')]);
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => /存在 2 个 memory-hub 标记区/.test(r)), `区计数断言: ${bad.reasons}`);

  // 写回一条新条目：文件随写回自动痊愈为单一区
  const results = await adapter.write([mkEntry('hub-20260807-new004', '新条目', '新正文。')]);
  assert.equal(results[0].status, 'written');
  const after1 = fs.readFileSync(agents, 'utf8');
  assert.equal(findHubRegions(after1).length, 1, '写回后仅剩单一标记区');
  const body = findHubRegions(after1)[0].body;
  assert.ok(body.includes('A 第二版（应保留）') && !body.includes('A 第一版'), '重复块保留最后版本');
  assert.ok(body.includes('[hub-20260807-bbb002]') && body.includes('[hub-20260807-new004]'));
  assert.ok(after1.includes('中间内容。') && after1.includes('尾部。'), '区外内容保留');
  // hub-id 全区唯一（无重复块）
  assert.equal(after1.split('[hub-20260807-aaa001]').length - 1, 1);

  // 自愈后：verify 通过
  const ok = adapter.verify([mkEntry('hub-20260807-new004', '新条目', '新正文。')]);
  assert.equal(ok.ok, true, `verify 应通过: ${ok.reasons}`);
});

// ---------------------------------------------------------------------------
// 5. H4：增量写回消费 pending-writeback.json，全部成功后原子清空
// ---------------------------------------------------------------------------

test('H4：增量写回只渲染清单页面，全部 app 成功后清空 pending-writeback.json', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  fs.mkdirSync(memDir, { recursive: true });
  writeWikiPage(['hub-20260807-inc001'], 'inc-page-a', '增量页A', '增量正文A。');
  writeWikiPage(['hub-20260807-inc002'], 'inc-page-b', '增量页B', '增量正文B。');
  writePending([{ path: 'inc-page-a.md', hubIds: ['hub-20260807-inc001'] }]);

  const config = {
    apps: [{ id: 'claude', enabled: true, memory_paths: [memDir] }],
    writeback: { batch3Enabled: false },
  };
  const result = await runWriteback({ config, adapters: [new ClaudeAdapter(config.apps[0])] });
  assert.equal(result.mode, 'incremental');
  assert.equal(result.entryCount, 1, '只写回清单中列出的 1 个页面');
  assert.ok(fs.existsSync(path.join(memDir, '增量页A.md')), '清单页面已写回');
  assert.ok(!fs.existsSync(path.join(memDir, '增量页B.md')), '清单外页面未被广播');

  // 全部成功 → pending 已原子清空（pages 归空，文件仍在）
  const pending = loadPendingWriteback();
  assert.ok(pending, '清空后文件仍可解析');
  assert.equal(pending.pages.length, 0, 'pages 已清空');

  // 清空后再次写回：pages 为空 → 降级全量，页B 也被写回
  const r2 = await runWriteback({ config, adapters: [new ClaudeAdapter(config.apps[0])] });
  assert.equal(r2.mode, 'full');
  assert.ok(fs.existsSync(path.join(memDir, '增量页B.md')), '降级全量后清单外页面写回');
});

// ---------------------------------------------------------------------------
// 6. H4：pending 不存在时降级全量并记诊断日志；full:true 强制全量
// ---------------------------------------------------------------------------

test('H4：pending 不存在降级全量并记日志；full:true 强制全量且不清空 pending', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  fs.mkdirSync(memDir, { recursive: true });
  writeWikiPage(['hub-20260807-ful001'], 'ful-page-a', '全量页A', '全量正文A。');
  writeWikiPage(['hub-20260807-ful002'], 'ful-page-b', '全量页B', '全量正文B。');

  const config = {
    apps: [{ id: 'claude', enabled: true, memory_paths: [memDir] }],
    writeback: { batch3Enabled: false },
  };

  // pending 不存在 → 降级全量 + 诊断日志
  const r1 = await runWriteback({ config, adapters: [new ClaudeAdapter(config.apps[0])] });
  assert.equal(r1.mode, 'full');
  assert.equal(r1.entryCount, 2);
  assert.ok(readDiagLog().includes('降级全量写回'), '降级记入 logs/writeback.log');

  // full:true → 即使 pending 只列 1 页也全量广播，且 pending 原样保留
  const memDir2 = path.join(home, '.claude2/projects/proj/memory');
  fs.mkdirSync(memDir2, { recursive: true });
  writePending([{ path: 'ful-page-a.md', hubIds: ['hub-20260807-ful001'] }]);
  const config2 = {
    apps: [{ id: 'claude', enabled: true, memory_paths: [memDir2] }],
    writeback: { batch3Enabled: false },
  };
  const r2 = await runWriteback({ config: config2, adapters: [new ClaudeAdapter(config2.apps[0])], full: true });
  assert.equal(r2.mode, 'full');
  assert.equal(r2.entryCount, 2, 'full:true 忽略清单全量广播');
  assert.ok(fs.existsSync(path.join(memDir2, '全量页B.md')));
  assert.equal(loadPendingWriteback().pages.length, 1, 'full 模式不消费不清空 pending');
});

// ---------------------------------------------------------------------------
// 7. H4：写回失败保留 pending 供下轮重试 + 失败原因落诊断日志
// ---------------------------------------------------------------------------

test('H4+失败日志：app 失败时保留 pending-writeback.json，失败原因落诊断日志', async () => {
  freshHubRoot();
  writeWikiPage(['hub-20260807-fail01'], 'fail-page', '失败页', '失败正文。');
  writePending([{ path: 'fail-page.md', hubIds: ['hub-20260807-fail01'] }]);

  const failing = {
    id: 'claude',
    render: () => '',
    write: async () => {
      throw new Error('模拟磁盘只读 EACCES: /fake/target.md');
    },
  };
  const config = { apps: [{ id: 'claude', enabled: true, memory_paths: ['/tmp/fake'] }], writeback: {} };
  const result = await runWriteback({ config, adapters: [failing] });
  assert.equal(result.mode, 'incremental');
  assert.equal(result.appResults[0].status, 'failed');

  // pending 保留（下轮重试）
  assert.equal(loadPendingWriteback().pages.length, 1, '失败时保留 pending');

  // 诊断日志含 app、具体异常消息与路径
  const diag = readDiagLog();
  assert.ok(diag.includes('[claude] 写回失败'), '诊断日志含 app 标识');
  assert.ok(diag.includes('模拟磁盘只读 EACCES: /fake/target.md'), '诊断日志含具体原因与路径');
  assert.ok(diag.includes('保留 pending-writeback.json'), '记录保留决策');
});

// ---------------------------------------------------------------------------
// 8. H4：清单页面已全部不存在 → 清空 pending 防死循环
// ---------------------------------------------------------------------------

test('H4：清单页面全部不存在时清空 pending 防死循环', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const memDir = path.join(home, '.claude/projects/proj/memory');
  fs.mkdirSync(memDir, { recursive: true });
  writeWikiPage(['hub-20260807-gone01'], 'alive-page', '存活页', '存活正文。');
  writePending([{ path: 'deleted-page.md', hubIds: ['hub-20260807-dead01'] }]);

  const config = {
    apps: [{ id: 'claude', enabled: true, memory_paths: [memDir] }],
    writeback: { batch3Enabled: false },
  };
  const result = await runWriteback({ config, adapters: [new ClaudeAdapter(config.apps[0])] });
  assert.equal(result.mode, 'incremental');
  assert.equal(result.entryCount, 0);
  assert.match(result.message, /已清空 pending-writeback\.json/);
  assert.equal(loadPendingWriteback().pages.length, 0, 'pending 已清空');
  assert.ok(!fs.existsSync(path.join(memDir, '存活页.md')), '本轮未写任何页面');

  // clearPendingWriteback 对不存在的文件是无操作
  fs.rmSync(pendingWritebackPath(), { force: true });
  clearPendingWriteback();
  assert.ok(!fs.existsSync(pendingWritebackPath()));
});

// ---------------------------------------------------------------------------
// 9. M8：写后校验失败 → 按备份回滚 + 标记 failed（带原因）
// ---------------------------------------------------------------------------

test('M8：adapter.verify 失败时按备份回滚本批写入并标记 failed', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const original = '# 工作区\n原始内容基准。\n';
  const agents = writeAt(home, 'ws/AGENTS.md', original);
  writeWikiPage(['hub-20260807-vrf001'], 'verify-page', '校验主题', '校验正文。');

  const config = {
    apps: [{ id: 'codex', enabled: true, memory_paths: [agents] }],
    writeback: { batch3Enabled: false },
  };
  // 真实写入 + 注入必然失败的 verify（模拟写后被外部破坏/校验不达标）
  const adapter = new CodexAdapter(config.apps[0]);
  adapter.verify = () => ({ ok: false, reasons: ['注入的校验失败：标记区被外部破坏'] });

  const result = await runWriteback({ config, adapters: [adapter] });
  const app = result.appResults[0];
  assert.equal(app.status, 'failed');
  assert.match(app.error, /写回后校验失败（已按备份回滚）/);
  assert.match(app.error, /注入的校验失败/);
  assert.ok(Array.isArray(app.backupDirs) && app.backupDirs.length > 0, '带备份目录');

  // 目标文件已按备份回滚到原始内容
  assert.equal(fs.readFileSync(agents, 'utf8'), original, '写入已回滚');

  // 失败原因落诊断日志 + writeback-log 记 failed
  assert.ok(readDiagLog().includes('注入的校验失败'), '诊断日志含校验失败原因');
  const failRec = loadWritebackLog().find((r) => r.app === 'codex' && r.result.startsWith('failed'));
  assert.ok(failRec, 'writeback-log 有 failed 记录');
});

test('M8：verify 通过时正常 written（生产管线确实调用了 verify）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const agents = writeAt(home, 'ws/AGENTS.md', '# 工作区\n内容。\n');
  writeWikiPage(['hub-20260807-vok001'], 'vok-page', '校验通过主题', '正文。');

  const config = {
    apps: [{ id: 'codex', enabled: true, memory_paths: [agents] }],
    writeback: { batch3Enabled: false },
  };
  const adapter = new CodexAdapter(config.apps[0]);
  let verifyCalled = 0;
  const origVerify = adapter.verify.bind(adapter);
  adapter.verify = (entries) => {
    verifyCalled += 1;
    return origVerify(entries);
  };
  const result = await runWriteback({ config, adapters: [adapter] });
  assert.equal(result.appResults[0].status, 'written');
  assert.equal(verifyCalled, 1, '写后校验被生产管线调用');
  assert.ok(fs.readFileSync(agents, 'utf8').includes('[hub-20260807-vok001]'));
});

// ---------------------------------------------------------------------------
// 10. M6：qoder 内容比对更新（原位重写）与幂等跳过
// ---------------------------------------------------------------------------

test('M6：qoder 内容一致跳过、内容更新原位重写（不产生重复文件）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const root = path.join(home, '.qoder/memories/acct1');
  fs.mkdirSync(root, { recursive: true });
  const appCfg = { id: 'qoder', enabled: true, memory_paths: [root], project_slug: 'proj' };

  const adapter = new QoderAdapter(appCfg);
  const entryV1 = mkEntry('hub-20260807-qdr001', 'Qoder主题', '第一版正文。');

  // 首次写入：落 project_introduction（缺省 category）
  const r1 = await adapter.write([entryV1]);
  assert.equal(r1[0].status, 'written');
  const target = r1[0].targets[0];
  assert.ok(target.includes(path.join('projects', 'proj', 'project_introduction')));
  assert.ok(fs.readFileSync(target, 'utf8').includes('第一版正文。'));

  // 重放同内容：skipped（幂等）
  const r2 = await adapter.write([entryV1]);
  assert.equal(r2[0].status, 'skipped');
  assert.match(r2[0].reason, /内容无变化/);

  // wiki 页更新：同一 hubId 内容变化 → 原位重写同一文件，不产生重复
  const entryV2 = mkEntry('hub-20260807-qdr001', 'Qoder主题', '第二版正文（更新传播）。');
  const r3 = await adapter.write([entryV2]);
  assert.equal(r3[0].status, 'written');
  assert.match(r3[0].reason, /原位重写/);
  assert.equal(r3[0].targets[0], target, '更新写入同一文件');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('第二版正文（更新传播）。'));
  assert.ok(!content.includes('第一版正文。'));
  // 全项目仅存一个含该 hubId 的文件
  const all = fs.globSync(path.join(root, 'projects', 'proj', '*', '*.md'));
  const hits = all.filter((p) => fs.readFileSync(p, 'utf8').includes('hub-20260807-qdr001'));
  assert.equal(hits.length, 1, '无重复文件');
});

// ---------------------------------------------------------------------------
// 11. N2：qoder category 变化 → 尊重现状原位处理，绝不搬移
// ---------------------------------------------------------------------------

test('N2：qoder category 变化时尊重现状原位处理（不搬移，避免与客户端整理拉锯）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const root = path.join(home, '.qoder/memories/acct1');
  fs.mkdirSync(root, { recursive: true });
  const adapter = new QoderAdapter({ id: 'qoder', enabled: true, memory_paths: [root], project_slug: 'proj' });

  // 首次写入缺省 category
  const v1 = mkEntry('hub-20260807-mov001', '移动主题', '正文。');
  const r1 = await adapter.write([v1]);
  const oldPath = r1[0].targets[0];
  assert.ok(oldPath.includes('project_introduction'));

  // distill 侧后续给出不同 category + 内容不变 → 幂等跳过，文件不动
  const v2 = mkEntry('hub-20260807-mov001', '移动主题', '正文。', {
    frontmatter: { category: 'development_code_specification' },
  });
  const r2 = await adapter.write([v2]);
  assert.equal(r2[0].status, 'skipped', 'category 变化但内容一致 → 幂等跳过');
  assert.ok(fs.existsSync(oldPath), '文件保留在原目录，未被搬移');

  // category 变化 + 内容更新 → 在文件当前所在目录原位重写（尊重 Qoder 归类）
  const v3 = mkEntry('hub-20260807-mov001', '移动主题', '更新后正文。', {
    frontmatter: { category: 'development_code_specification' },
  });
  const r3 = await adapter.write([v3]);
  assert.equal(r3[0].status, 'written');
  assert.match(r3[0].reason, /原位重写/);
  assert.equal(r3[0].targets[0], oldPath, '在原目录原位重写，不搬移到新 category');
  assert.ok(fs.readFileSync(oldPath, 'utf8').includes('更新后正文。'));
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'proj', 'development_code_specification')) ||
    fs.globSync(path.join(root, 'projects', 'proj', 'development_code_specification', '*.md')).length === 0,
    '新 category 目录未产生文件');
  // 全项目仅存一个含该 hubId 的文件
  const all = fs.globSync(path.join(root, 'projects', 'proj', '*', '*.md'));
  const hits = all.filter((p) => fs.readFileSync(p, 'utf8').includes('hub-20260807-mov001'));
  assert.equal(hits.length, 1);

  // 非法 category（路径穿越）回退缺省目录
  const evil = mkEntry('hub-20260807-evil01', '恶意条目', '正文。', {
    frontmatter: { category: '../../escape' },
  });
  const r4 = await adapter.write([evil]);
  assert.ok(r4[0].targets[0].includes('project_introduction'), '非法 category 回退缺省');
});

// ---------------------------------------------------------------------------
// 12. M5：writeback-log 旧 JSON 数组迁移 JSONL + 超限裁剪
// ---------------------------------------------------------------------------

test('M5：writeback-log 旧 JSON 数组自动迁移 JSONL，超体积裁剪到最近 N 条', () => {
  freshHubRoot();
  const file = writebackLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 旧版 JSON 数组格式 → 首次追加自动迁移为 JSONL
  const legacy = [{ time: 't0', app: 'claude', hubId: 'hub-old', result: 'written', backupDir: null }];
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  appendWritebackLog([{ time: 't1', app: 'codex', hubId: 'hub-new', result: 'written', backupDir: null }]);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.trimStart().startsWith('['), '已迁移为 JSONL（非 JSON 数组）');
  const migrated = loadWritebackLog();
  assert.equal(migrated.length, 2, '迁移保留旧记录 + 新记录');
  assert.equal(migrated[0].hubId, 'hub-old');
  assert.equal(migrated[1].hubId, 'hub-new');

  // 平时纯追加：未超体积阈值不重写（记录只增）
  appendWritebackLog([{ time: 't2', app: 'claude', hubId: 'hub-2', result: 'skipped: 幂等', backupDir: null }]);
  assert.equal(loadWritebackLog().length, 3);

  // 超体积阈值 → 全量重写裁剪到最近 maxRecords 条
  const many = [];
  for (let i = 0; i < 50; i += 1) {
    many.push({ time: `t${i + 3}`, app: 'claude', hubId: `hub-bulk-${i}`, result: 'written', backupDir: null });
  }
  appendWritebackLog(many, { maxRecords: 10, rewriteBytes: 64 });
  const trimmed = loadWritebackLog();
  assert.equal(trimmed.length, 10, '裁剪到最近 10 条');
  assert.equal(trimmed[9].hubId, 'hub-bulk-49', '保留的是最新记录');
  assert.equal(trimmed[0].hubId, 'hub-bulk-40');

  // 半行损坏容忍：追加坏行后 load 跳过坏行不影响其余
  fs.appendFileSync(file, '{broken json line\n');
  appendWritebackLog([{ time: 'tx', app: 'codex', hubId: 'hub-after-broken', result: 'written', backupDir: null }]);
  const withBroken = loadWritebackLog();
  assert.ok(withBroken.some((r) => r.hubId === 'hub-after-broken'));
  assert.ok(withBroken.every((r) => typeof r === 'object'));
});

// ---------------------------------------------------------------------------
// 13. Task#9：孤儿标记清除（清理实战形态：孤儿 end 多于 start）
// ---------------------------------------------------------------------------

test('Task#9：repairAgentsContent 清除全部孤儿 start/end 标记并规整空行，orphanMarkers 计数正确', () => {
  // 实战缩小版：顶部连续孤儿 end、区后孤儿 end、尾部孤儿 start（无配对 end）
  const content = [
    '# 工作区',
    '',
    HUB_MARK_END,
    HUB_MARK_END,
    '',
    region(blockA1),
    '',
    HUB_MARK_END,
    '',
    '用户内容甲。',
    '',
    HUB_MARK_START,
    '',
    '尾部内容。',
    '',
  ].join('\n');
  const r = repairAgentsContent(content);
  assert.equal(r.changed, true);
  assert.equal(r.regionCount, 1);
  assert.equal(r.orphanMarkers, 4, '2 顶部 end + 1 区后 end + 1 尾部 start');
  assert.deepEqual(r.strayBlocks, []);
  // 修复后恰好剩一对标记、单一区
  assert.equal(r.content.split(HUB_MARK_START).length - 1, 1);
  assert.equal(r.content.split(HUB_MARK_END).length - 1, 1);
  assert.equal(findHubRegions(r.content).length, 1);
  // 区内块与区外用户内容原样保留
  assert.ok(r.content.includes('[hub-20260807-aaa001]'));
  assert.ok(r.content.includes('用户内容甲。') && r.content.includes('尾部内容。'));
  // 紧邻空行规整：删标记处不留连续空行
  assert.ok(!r.content.includes('\n\n\n'), '孤儿标记删除处不留连续空行');
  // 幂等：第二次 repair 判定 clean
  const again = repairAgentsContent(r.content);
  assert.equal(again.changed, false);
  assert.equal(again.orphanMarkers, 0);
});

// ---------------------------------------------------------------------------
// 14. Task#9：区外遗留 hub 块保守归并，用户伪块与围栏内容不触碰
// ---------------------------------------------------------------------------

test('Task#9：区外遗留 hub 块归并入单一区（区内版本优先），非 hub- 前缀伪块与围栏内示例不触碰', () => {
  const strayDup = '### 条目A远古残留 [hub-20260807-aaa001]\n\nA 远古残留版。';
  const strayNew = '### 迷路条目 [hub-20260807-str001]\n\n迷路正文。';
  const userFake = '### 用户自有条目 [note-123]\n\n用户自己的内容，一个字都不许动。';
  const fenced = `\`\`\`md
### 围栏示例 [hub-20260807-doc001]

围栏内示例不许动。
${HUB_MARK_END}
\`\`\``;
  const content = `# 前言\n\n${strayDup}\n\n${region(blockA2)}\n\n${fenced}\n\n## 用户章节\n\n${userFake}\n\n${strayNew}\n`;
  const r = repairAgentsContent(content);
  assert.equal(r.changed, true);
  assert.equal(r.orphanMarkers, 0, '围栏内标记不计孤儿');
  assert.deepEqual(r.strayBlocks, [], '块边界均可安全判定');
  assert.equal(r.totalBlocks, 3, '区内 1 块 + 区外归并 2 块');
  assert.equal(r.uniqueBlocks, 2);
  assert.equal(r.duplicateBlocks, 1);

  const regions = findHubRegions(r.content);
  assert.equal(regions.length, 1);
  // 重复 hub-id：区内版本优先，远古残留被压制且仅存一份
  assert.ok(regions[0].body.includes('A 第二版（应保留）'));
  assert.ok(!r.content.includes('A 远古残留版'));
  assert.equal(r.content.split('[hub-20260807-aaa001]').length - 1, 1);
  // 区外新 hub 块已收编进区
  assert.ok(regions[0].body.includes('[hub-20260807-str001]') && regions[0].body.includes('迷路正文。'));
  // 用户伪块（非 hub- 前缀）原地不动且不入区
  assert.ok(r.content.includes(userFake), '用户伪块逐字保留');
  assert.ok(!regions[0].body.includes('note-123'), '用户伪块未被误吞入区');
  // 代码围栏内的 hub 样式示例与标记逐字保留
  assert.ok(r.content.includes(fenced), '围栏内容逐字保留');
  // 幂等：第二次 repair clean
  const again = repairAgentsContent(r.content);
  assert.equal(again.changed, false);
  assert.equal(again.orphanMarkers, 0);
  assert.deepEqual(again.strayBlocks, []);
});

// ---------------------------------------------------------------------------
// 15. Task#9：无法安全判定边界的区外块只列 strayBlocks 不动原文
// ---------------------------------------------------------------------------

test('Task#9：未闭合围栏的区外 hub 块不归并只列入 strayBlocks，不阻塞幂等收敛', () => {
  const unsafe = '### 半截块 [hub-20260807-bad001]\n\n```js\nconsole.log(1)\n// 围栏没闭合';
  const content = `# 前言\n\n${region(blockB)}\n\n${HUB_MARK_END}\n\n${unsafe}\n`;
  const r = repairAgentsContent(content);
  assert.equal(r.changed, true, '孤儿 end 触发修复');
  assert.equal(r.orphanMarkers, 1);
  assert.equal(r.strayBlocks.length, 1);
  assert.equal(r.strayBlocks[0].hubId, 'hub-20260807-bad001');
  assert.equal(r.strayBlocks[0].title, '半截块');
  assert.match(r.strayBlocks[0].reason, /围栏/);
  // 半截块原文保留、未入区
  assert.ok(r.content.includes(unsafe), '无法安全判定边界的块原文保留');
  assert.ok(!findHubRegions(r.content)[0].body.includes('bad001'), '未被归并入区');
  // 幂等：strayBlocks 仍列出但不阻塞 clean（第二次 changed=false）
  const again = repairAgentsContent(r.content);
  assert.equal(again.changed, false);
  assert.equal(again.strayBlocks.length, 1, '未收敛块持续可见于清单');
});

// ---------------------------------------------------------------------------
// 16. Task#9：无成对区文件的 repairFile 两态（纯孤儿标记 / 区外块新建区）
// ---------------------------------------------------------------------------

test('Task#9：repairFile 无成对区——纯孤儿标记清除后无标记区；区外 hub 块则文末新建单一区', () => {
  freshHubRoot();
  const home = freshFakeHome();

  // 只有孤儿标记：清除后不留任何标记（expectMarker 按结果动态放空）
  const p1 = writeAt(home, 'a/AGENTS.md', `# 用户\n\n${HUB_MARK_END}\n${HUB_MARK_END}\n\n内容。\n`);
  const r1 = repairFile(p1);
  assert.equal(r1.status, 'repaired');
  assert.equal(r1.orphanMarkers, 2);
  assert.deepEqual(r1.strayBlocks, []);
  const c1 = fs.readFileSync(p1, 'utf8');
  assert.ok(!c1.includes(HUB_MARK_START) && !c1.includes(HUB_MARK_END), '无块可收编时不新建空区');
  assert.ok(c1.includes('# 用户') && c1.includes('内容。'));
  assert.equal(repairFile(p1).status, 'clean', '第二次 repair clean');

  // 无区但有区外 hub 块：文末新建单一区收编
  const p2 = writeAt(home, 'b/AGENTS.md', '# 用户\n\n### 迷路 [hub-20260807-x0001]\n\n迷路正文。\n');
  const r2 = repairFile(p2);
  assert.equal(r2.status, 'repaired');
  assert.ok(r2.backupDir && fs.existsSync(r2.backupDir), '修复必须留备份');
  const regions2 = findHubRegions(fs.readFileSync(p2, 'utf8'));
  assert.equal(regions2.length, 1);
  assert.ok(regions2[0].body.includes('[hub-20260807-x0001]') && regions2[0].body.includes('迷路正文。'));
  const c2again = repairFile(p2);
  assert.equal(c2again.status, 'clean');
  assert.equal(c2again.orphanMarkers, 0);
  assert.deepEqual(c2again.strayBlocks, [], 'clean 返回也携带新增字段');
});

// ---------------------------------------------------------------------------
// 17. Task#9：极端损坏形态一次收敛 + 写路径自愈
// ---------------------------------------------------------------------------

/** 清理实战缩小版：多区 + 成批孤儿 end + 孤儿 start + 区外遗留块。 */
function extremeBrokenAgents() {
  const orphanEnds = Array(8).fill(HUB_MARK_END).join('\n');
  return [
    '# 工作区',
    '',
    orphanEnds,
    '',
    region(blockA1),
    '',
    '### 区外残留 [hub-20260807-out001]',
    '',
    '区外残留正文。',
    '',
    region(blockA2, blockB),
    '',
    orphanEnds,
    '',
    HUB_MARK_START,
    '',
    '用户尾部内容。',
    '',
  ].join('\n');
}

test('Task#9：极端损坏（多区+16 孤儿 end+孤儿 start+区外块）repairFile 一次收敛，第二次 clean', () => {
  freshHubRoot();
  const home = freshFakeHome();
  const p = writeAt(home, 'ws/AGENTS.md', extremeBrokenAgents());
  const r = repairFile(p);
  assert.equal(r.status, 'repaired');
  assert.equal(r.regionCount, 2);
  assert.equal(r.orphanMarkers, 17, '16 孤儿 end + 1 孤儿 start');
  assert.equal(r.totalBlocks, 4, '区内 3 块 + 区外归并 1 块');
  assert.equal(r.uniqueBlocks, 3);
  assert.equal(r.duplicateBlocks, 1);
  assert.deepEqual(r.strayBlocks, []);
  assert.ok(r.backupDir && fs.existsSync(r.backupDir));

  const healed = fs.readFileSync(p, 'utf8');
  assert.equal(healed.split(HUB_MARK_START).length - 1, 1, '全文恰一个 start');
  assert.equal(healed.split(HUB_MARK_END).length - 1, 1, '全文恰一个 end');
  const body = findHubRegions(healed)[0].body;
  assert.ok(body.includes('A 第二版（应保留）') && !healed.includes('A 第一版'));
  assert.ok(body.includes('[hub-20260807-bbb002]') && body.includes('[hub-20260807-out001]'));
  assert.ok(healed.includes('用户尾部内容。'), '区外用户内容保留');
  // 幂等：同一损坏输入连续 repair 两次，第二次必须 clean
  const second = repairFile(p);
  assert.equal(second.status, 'clean');
  assert.equal(second.orphanMarkers, 0);
});

test('Task#9：codex 写路径遇孤儿标记/区外块同样自动收敛（buildMergedContent 自愈）', async () => {
  freshHubRoot();
  const home = freshFakeHome();
  const agents = writeAt(home, 'ws/AGENTS.md', extremeBrokenAgents());
  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents] });
  const results = await adapter.write([mkEntry('hub-20260807-new009', '新条目', '新正文。')]);
  assert.equal(results[0].status, 'written');
  const after1 = fs.readFileSync(agents, 'utf8');
  assert.equal(after1.split(HUB_MARK_START).length - 1, 1);
  assert.equal(after1.split(HUB_MARK_END).length - 1, 1);
  const body = findHubRegions(after1)[0].body;
  assert.ok(body.includes('[hub-20260807-new009]') && body.includes('[hub-20260807-out001]'));
  assert.ok(after1.includes('用户尾部内容。'));
  const ok = adapter.verify([mkEntry('hub-20260807-new009', '新条目', '新正文。')]);
  assert.equal(ok.ok, true, `写后 verify 应通过: ${ok.reasons}`);
});

// ---------------------------------------------------------------------------
// 18. Task#9：verify 孤儿标记断言 + clean 判定收紧
// ---------------------------------------------------------------------------

test('Task#9：verify 新增无孤儿标记断言；单区+孤儿标记不再判 clean，repairFile 后 verify 通过', () => {
  freshHubRoot();
  const home = freshFakeHome();
  // 旧版判定会误判 clean 的形态：区数==1 但带 1 个孤儿 end
  const agents = writeAt(home, 'ws/AGENTS.md', `# 工作区\n\n${region(blockB)}\n\n${HUB_MARK_END}\n\n尾部。\n`);
  const adapter = new CodexAdapter({ id: 'codex', enabled: true, memory_paths: [agents] });

  const bad = adapter.verify([mkEntry('hub-20260807-bbb002', '条目B', 'B 正文。')]);
  assert.equal(bad.ok, false);
  assert.ok(
    bad.reasons.some((r) => /存在 1 个孤儿 memory-hub 标记/.test(r)),
    `孤儿标记断言: ${bad.reasons}`,
  );

  const rep = repairFile(agents);
  assert.equal(rep.status, 'repaired', 'clean 判定收紧：区数==1 但有孤儿标记也要修');
  assert.equal(rep.regionCount, 1);
  assert.equal(rep.orphanMarkers, 1);
  assert.deepEqual(rep.strayBlocks, []);
  assert.ok(fs.readFileSync(agents, 'utf8').includes('尾部。'), '区外内容保留');

  const ok = adapter.verify([mkEntry('hub-20260807-bbb002', '条目B', 'B 正文。')]);
  assert.equal(ok.ok, true, `修复后 verify 应通过: ${ok.reasons}`);
  // clean 返回携带新增字段（向后兼容：仅新增）
  const clean = repairFile(agents);
  assert.equal(clean.status, 'clean');
  assert.equal(clean.orphanMarkers, 0);
  assert.deepEqual(clean.strayBlocks, []);
});
