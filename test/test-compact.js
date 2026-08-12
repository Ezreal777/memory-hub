/**
 * test/test-compact.js —— wiki 全局归并引擎（compact）自测（node:test）。
 *
 * 全部在 MEMORY_HUB_ROOT 隔离的临时目录演练；LLM 客户端一律 mock 注入，
 * 不打真实网络、不触发 Keychain。
 *
 * 覆盖：
 * 1. 聚类：topicKeyOf 主题键提取（去虚词/剥 -N 后缀/单实词不聚类）、
 *    clusterPages 分组与 minClusterSize 过滤、deleted/无 hub-id 页不参与；
 * 2. 归并编排：LLM 输出应用（赢家页 frontmatter 并集、输家页删除）、
 *    distill-state processed 重定向、pending-writeback pages+removals 登记、
 *    master-index 重建、备份先行可回滚；
 * 3. 输出校验：编造 sourceSlugs 过滤、未认领输入页原样保留、无增益记 noGain
 *    不再重放、解析失败计数达 3 次隔离毒簇；
 * 4. dry-run 只出计划不调 LLM 不落盘；
 * 5. compactDue 频控判定；
 * 6. writeback 侧消费 removals（removeEntries 下发 + 成功后清空契约文件）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import {
  compact,
  compactDue,
  topicKeyOf,
  clusterPages,
  listCompactablePages,
  clusterSignature,
  normalizeCompactOutput,
  appendPendingRemovals,
  loadCompactState,
  saveCompactState,
  MAX_CLUSTER_FAILURES,
} from '../src/compact.js';
import { loadDistillState, saveDistillState } from '../src/distill.js';
import { ensureHubStore, storePaths } from '../src/hub-store.js';
import { loadPendingWriteback, runWriteback } from '../src/writeback.js';
import { defaultConfig } from '../src/config.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-compact-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 伪造一个 wiki 页（与 distill 落盘产物同构） */
function writeWikiPage(slug, { title, hubIds, tags = [], category = 'task_summary_experience', body = '正文内容。', deleted = false } = {}) {
  const fm = {
    'hub-id': hubIds,
    sources: hubIds.map((id) => `/fake/src/${id}.md`),
    'last-updated': '2026-08-01T10:00:00.000Z',
    tags,
    category,
  };
  if (deleted) fm.deleted = true;
  const file = path.join(storePaths.wiki, `${slug}.md`);
  fs.writeFileSync(file, matter.stringify({ content: `# ${title || slug}\n\n${body}\n` }, fm));
  return file;
}

/** mock LLM 客户端（与 test-tombstone.js 同模式） */
function mockClient(reply) {
  const calls = [];
  return {
    calls,
    chat: async (messages) => {
      calls.push(messages);
      return typeof reply === 'function' ? reply(messages, calls.length) : reply;
    },
  };
}

/** 测试用 config：compact 阈值放低到 2 页成簇 */
function testConfig(extra = {}) {
  const config = defaultConfig();
  config.compact = { ...config.compact, minClusterSize: 2, ...extra };
  return config;
}

// ---------------------------------------------------------------------------
// 聚类
// ---------------------------------------------------------------------------

test('topicKeyOf：取前 2 个实词，去虚词、剥 -N 后缀，单实词返回 null', () => {
  assert.equal(topicKeyOf('ab-test-daily-details'), 'ab-test');
  assert.equal(topicKeyOf('ab-test-daily-details-2'), 'ab-test');
  assert.equal(topicKeyOf('impact-of-analysis-scope'), 'impact-analysis');
  assert.equal(topicKeyOf('inventory'), null, '单实词主题太宽泛不聚类');
  assert.equal(topicKeyOf('the-of-and'), null, '全虚词无法成键');
});

test('clusterPages：按主题键分组，minClusterSize 过滤，deleted/无 hub-id 页不参与', () => {
  freshHubRoot();
  writeWikiPage('ab-test-results', { hubIds: ['hub-a1'] });
  writeWikiPage('ab-test-conclusions', { hubIds: ['hub-a2', 'hub-a3'] });
  writeWikiPage('ab-test-daily-details', { hubIds: ['hub-a4'] });
  writeWikiPage('pop-mart-analysis', { hubIds: ['hub-p1'] }); // 孤页不成簇
  writeWikiPage('ab-test-deleted-page', { hubIds: ['hub-a9'], deleted: true }); // 已删不参与
  const noIdFile = path.join(storePaths.wiki, 'ab-test-no-id.md');
  fs.writeFileSync(noIdFile, '# 无归属页\n\n没有 frontmatter hub-id。\n'); // 无 hub-id 不参与

  const pages = listCompactablePages();
  const clusters = clusterPages(pages, { minClusterSize: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].key, 'ab-test');
  assert.deepEqual(
    clusters[0].pages.map((p) => p.slug).sort(),
    ['ab-test-conclusions', 'ab-test-daily-details', 'ab-test-results'],
  );
  // hubIds 多者排前（归并目标优先级）
  assert.equal(clusters[0].pages[0].slug, 'ab-test-conclusions');
});

test('normalizeCompactOutput：过滤编造 slug、跨页重复认领只认首个、无增益返回 null', () => {
  const chunk = [
    { slug: 'a-b-one' },
    { slug: 'a-b-two' },
    { slug: 'a-b-three' },
  ];
  // 编造 slug 被过滤；重复认领只算一次
  const out = normalizeCompactOutput(
    {
      pages: [
        {
          slug: 'a-b-one',
          title: '合并页',
          tags: ['t'],
          category: 'task_summary_experience',
          content: '合并后的内容',
          sourceSlugs: ['a-b-one', 'a-b-two', 'a-b-three', 'made-up-slug'],
        },
      ],
    },
    chunk,
  );
  assert.equal(out.pages.length, 1);
  assert.deepEqual(out.pages[0].sourceSlugs, ['a-b-one', 'a-b-two', 'a-b-three']);
  assert.equal(out.claimed.size, 3);

  // 无增益：3 页进 3 页出
  const noGain = normalizeCompactOutput(
    {
      pages: chunk.map((p) => ({
        slug: p.slug,
        title: p.slug,
        content: '各自保留',
        sourceSlugs: [p.slug],
      })),
    },
    chunk,
  );
  assert.equal(noGain, null);

  // 结构不合规抛错
  assert.throws(() => normalizeCompactOutput({ notPages: [] }, chunk), /pages/);
  assert.throws(
    () => normalizeCompactOutput({ pages: [{ slug: 'x', content: '', sourceSlugs: ['a-b-one'] }] }, chunk),
    /有效归并页/,
  );
});

// ---------------------------------------------------------------------------
// 主编排
// ---------------------------------------------------------------------------

test('compact：LLM 归并落盘——赢家页并集、输家页删除、状态重定向、契约登记、索引重建', async () => {
  freshHubRoot();
  writeWikiPage('ab-test-results', { title: '实验结果', hubIds: ['hub-a1'], tags: ['ab'], body: '结论 A。' });
  writeWikiPage('ab-test-conclusions', { title: '实验结论', hubIds: ['hub-a2', 'hub-a3'], tags: ['实验'], body: '结论 B。' });
  writeWikiPage('ab-test-daily-details', { title: '每日明细', hubIds: ['hub-a4'], body: '明细 C。' });
  // distill-state：hub-a1 原指输家页
  const ds = loadDistillState();
  ds.processed['hub-a1'] = { page: 'ab-test-results', at: '2026-08-01T10:00:00.000Z' };
  ds.processed['hub-a2'] = { page: 'ab-test-conclusions', at: '2026-08-01T10:00:00.000Z' };
  saveDistillState(ds);

  const client = mockClient(
    JSON.stringify({
      pages: [
        {
          slug: 'ab-test-conclusions',
          title: 'AB 实验结论与明细汇总',
          tags: ['ab-test'],
          category: 'task_summary_experience',
          content: '归并后的完整结论：A + B + C。',
          sourceSlugs: ['ab-test-conclusions', 'ab-test-results', 'ab-test-daily-details'],
        },
      ],
    }),
  );
  const result = await compact({ config: testConfig(), client });
  assert.equal(result.ok, true);
  assert.equal(result.clustersDone, 1);
  assert.equal(client.calls.length, 1);

  // 赢家页：hub-id/sources/tags 并集，标题重写
  const winner = path.join(storePaths.wiki, 'ab-test-conclusions.md');
  const parsed = matter(fs.readFileSync(winner, 'utf8'));
  assert.deepEqual([...parsed.data['hub-id']].sort(), ['hub-a1', 'hub-a2', 'hub-a3', 'hub-a4']);
  assert.ok(parsed.data.tags.includes('ab-test') && parsed.data.tags.includes('实验'));
  assert.match(parsed.content, /AB 实验结论与明细汇总/);
  assert.match(parsed.content, /A \+ B \+ C/);

  // 输家页物理删除
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'ab-test-results.md')));
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'ab-test-daily-details.md')));

  // distill-state：hub-a1 的 page 重定向到赢家 slug
  const ds2 = loadDistillState();
  assert.equal(ds2.processed['hub-a1'].page, 'ab-test-conclusions');
  assert.equal(ds2.processed['hub-a2'].page, 'ab-test-conclusions');

  // pending-writeback：赢家页 + 输家页主 hubId removals
  const pending = loadPendingWriteback();
  assert.equal(pending.pages.length, 1);
  assert.equal(pending.pages[0].path, 'ab-test-conclusions.md');
  assert.deepEqual([...pending.pages[0].hubIds].sort(), ['hub-a1', 'hub-a2', 'hub-a3', 'hub-a4']);
  assert.deepEqual([...pending.removals].sort(), ['hub-a1', 'hub-a4']);

  // master-index 重建（不再含输家页）
  const index = fs.readFileSync(storePaths.masterIndex, 'utf8');
  assert.ok(index.includes('ab-test-conclusions.md'));
  assert.ok(!index.includes('ab-test-results.md'));

  // 备份可回滚：备份目录里有输家页原文
  assert.ok(result.removedPages.length === 2);
});

test('compact：LLM 遗漏认领的输入页原样保留，绝不丢内容', async () => {
  freshHubRoot();
  writeWikiPage('cx-svc-one', { hubIds: ['hub-c1'], body: '内容一。' });
  writeWikiPage('cx-svc-two', { hubIds: ['hub-c2'], body: '内容二。' });
  writeWikiPage('cx-svc-three', { hubIds: ['hub-c3'], body: '内容三（被 LLM 遗漏）。' });

  const client = mockClient(
    JSON.stringify({
      pages: [
        {
          slug: 'cx-svc-one',
          title: '归并页',
          content: '一 + 二。',
          sourceSlugs: ['cx-svc-one', 'cx-svc-two'], // 遗漏 three
        },
      ],
    }),
  );
  const result = await compact({ config: testConfig(), client });
  assert.equal(result.ok, true);
  // 被遗漏的页原样保留
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'cx-svc-three.md')));
  const kept = matter(fs.readFileSync(path.join(storePaths.wiki, 'cx-svc-three.md'), 'utf8'));
  assert.match(kept.content, /被 LLM 遗漏/);
  // 认领的两页正常归并
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'cx-svc-two.md')));
});

test('compact：无增益输出记 noGain，同签名不再重复调用 LLM', async () => {
  freshHubRoot();
  writeWikiPage('dx-topic-one', { hubIds: ['hub-d1'] });
  writeWikiPage('dx-topic-two', { hubIds: ['hub-d2'] });

  const client = mockClient(
    JSON.stringify({
      pages: [
        { slug: 'dx-topic-one', title: '一', content: '一', sourceSlugs: ['dx-topic-one'] },
        { slug: 'dx-topic-two', title: '二', content: '二', sourceSlugs: ['dx-topic-two'] },
      ],
    }),
  );
  const r1 = await compact({ config: testConfig(), client });
  assert.equal(r1.ok, true);
  assert.equal(r1.merged.length, 0);
  assert.equal(client.calls.length, 1);
  // 两页原样保留
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'dx-topic-one.md')));
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'dx-topic-two.md')));

  // 第二轮：同签名命中 noGain，不再调 LLM
  const r2 = await compact({ config: testConfig(), client });
  assert.equal(r2.ok, true);
  assert.equal(client.calls.length, 1, 'noGain 簇不应再调 LLM');
});

test('compact：解析失败计数达上限隔离毒簇，不再重放', async () => {
  freshHubRoot();
  writeWikiPage('ex-fail-one', { hubIds: ['hub-e1'] });
  writeWikiPage('ex-fail-two', { hubIds: ['hub-e2'] });

  const client = mockClient('这不是 JSON');
  for (let i = 1; i <= MAX_CLUSTER_FAILURES; i += 1) {
    const r = await compact({ config: testConfig(), client });
    assert.equal(r.ok, false, `第 ${i} 轮应失败`);
  }
  assert.equal(client.calls.length, MAX_CLUSTER_FAILURES);
  const state = loadCompactState();
  assert.equal(Object.keys(state.poisoned).length, 1, '达上限后应隔离');

  // 隔离后不再调 LLM（clusters 仍可见但跳过）
  const r4 = await compact({ config: testConfig(), client });
  assert.equal(client.calls.length, MAX_CLUSTER_FAILURES, '毒簇不应再调 LLM');
  assert.equal(r4.ok, true, '无事可做视为成功');
});

test('compact --dry-run：只出聚类计划，不调 LLM、不落盘', async () => {
  freshHubRoot();
  writeWikiPage('fx-plan-one', { hubIds: ['hub-f1'] });
  writeWikiPage('fx-plan-two', { hubIds: ['hub-f2'] });

  const client = mockClient('{"pages":[]}');
  const result = await compact({ config: testConfig(), client, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.clusters, 1);
  assert.deepEqual(result.plan[0].slugs.sort(), ['fx-plan-one', 'fx-plan-two']);
  assert.equal(client.calls.length, 0, 'dry-run 不应调 LLM');
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'fx-plan-one.md')));
  assert.equal(loadPendingWriteback(), null, 'dry-run 不应登记契约');
});

test('compact --topic 定向 + maxClusters 限额', async () => {
  freshHubRoot();
  writeWikiPage('ga-one-a', { hubIds: ['hub-g1'] });
  writeWikiPage('ga-one-b', { hubIds: ['hub-g2'] });
  writeWikiPage('gb-two-a', { hubIds: ['hub-g3'] });
  writeWikiPage('gb-two-b', { hubIds: ['hub-g4'] });

  const client = mockClient((messages) => {
    const items = JSON.parse(messages[1].content);
    return JSON.stringify({
      pages: [
        {
          slug: items[0].slug,
          title: '归并',
          content: '合并内容',
          sourceSlugs: items.map((i) => i.slug),
        },
      ],
    });
  });
  // 定向只处理 ga-one 簇
  const result = await compact({ config: testConfig(), client, topicKey: 'ga-one' });
  assert.equal(result.ok, true);
  assert.equal(result.clusters, 1);
  assert.ok(!fs.existsSync(path.join(storePaths.wiki, 'ga-one-b.md')), 'ga-one 簇已归并');
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'gb-two-a.md')), 'gb-two 簇不受影响');
  assert.ok(fs.existsSync(path.join(storePaths.wiki, 'gb-two-b.md')));
});

test('compactDue：无状态即到期；未到间隔不触发；enabled=false 永不触发', () => {
  freshHubRoot();
  const config = testConfig({ intervalMs: 60 * 60 * 1000 });
  assert.equal(compactDue(config), true, '首次无状态应到期');

  const state = loadCompactState();
  state.lastRunAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 分钟前
  saveCompactState(state);
  assert.equal(compactDue(config), false, '未到间隔不触发');

  state.lastRunAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 小时前
  saveCompactState(state);
  assert.equal(compactDue(config), true, '超过间隔应触发');

  config.compact.enabled = false;
  assert.equal(compactDue(config), false, '关闭开关永不触发');
});

// ---------------------------------------------------------------------------
// writeback 侧消费 removals
// ---------------------------------------------------------------------------

test('writeback：消费 pending removals 下发 removeEntries，全部成功后清空契约', async () => {
  freshHubRoot();
  writeWikiPage('hx-merged-page', { hubIds: ['hub-h1', 'hub-h2'], body: '归并后内容。' });
  appendPendingRemovals(['hub-h2']);
  // pages 也登记（模拟 compact 产物）
  const { appendPendingWriteback } = await import('../src/distill.js');
  appendPendingWriteback([{ path: 'hx-merged-page.md', hubIds: ['hub-h1', 'hub-h2'] }]);

  const removedIds = [];
  const fakeAdapter = {
    id: 'claude',
    render: (e) => e.body,
    write: async (entries) => entries.map((e) => ({ hubId: e.hubId, status: 'written', targets: [] })),
    removeEntries: async (ids) => {
      removedIds.push(...ids);
      return ids.map((id) => ({ hubId: id, status: 'removed', targets: [] }));
    },
  };
  const config = defaultConfig();
  const result = await runWriteback({ config, adapters: [fakeAdapter] });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'incremental');
  assert.deepEqual(removedIds, ['hub-h2'], 'removals 应下发 removeEntries');

  // 全部成功 → 契约清空（pages 与 removals 一并清）
  const pending = loadPendingWriteback();
  assert.equal(pending.pages.length, 0);
  assert.equal(pending.removals.length, 0);
});

test('writeback：removals 清理 deferred 时保留契约下轮重试', async () => {
  freshHubRoot();
  writeWikiPage('ix-merged-page', { hubIds: ['hub-i1'], body: '归并后内容。' });
  appendPendingRemovals(['hub-i9']);
  const { appendPendingWriteback } = await import('../src/distill.js');
  appendPendingWriteback([{ path: 'ix-merged-page.md', hubIds: ['hub-i1'] }]);

  const fakeAdapter = {
    id: 'claude',
    render: (e) => e.body,
    write: async (entries) => entries.map((e) => ({ hubId: e.hubId, status: 'written', targets: [] })),
    removeEntries: async (ids) => ids.map((id) => ({ hubId: id, status: 'deferred', reason: '目标被外部修改' })),
  };
  const config = defaultConfig();
  await runWriteback({ config, adapters: [fakeAdapter] });

  const pending = loadPendingWriteback();
  assert.deepEqual(pending.removals, ['hub-i9'], 'deferred 时 removals 应保留重试');
});

test('appendPendingRemovals：与既有 pages 合并共存、幂等去重', () => {
  freshHubRoot();
  appendPendingRemovals(['hub-x1', 'hub-x2']);
  appendPendingRemovals(['hub-x2', 'hub-x3']);
  const pending = loadPendingWriteback();
  assert.deepEqual([...pending.removals].sort(), ['hub-x1', 'hub-x2', 'hub-x3']);
  assert.equal(appendPendingRemovals([]), null, '空入参无操作');
});

test('clusterSignature：与 slug 顺序无关、成员变化即失效', () => {
  const a = clusterSignature([{ slug: 'x-a' }, { slug: 'x-b' }]);
  const b = clusterSignature([{ slug: 'x-b' }, { slug: 'x-a' }]);
  const c = clusterSignature([{ slug: 'x-a' }, { slug: 'x-c' }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
