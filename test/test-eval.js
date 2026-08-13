/**
 * test/test-eval.js —— 记忆效果评测引擎（hub eval）自测（node:test）。
 *
 * 覆盖：
 * 1. samplePagesForProbes：主题键去重、信息量优先排序与限量；
 * 2. normalizeProbes：编造 slug 过滤、缺字段丢弃、泛词关键词过滤；
 * 3. generateProbes：LLM mock 出题 → 落盘 state/eval-probes.json；
 * 4. coverageCheck：wiki 基准命中 + App 语料命中/未命中判定；
 * 5. pipelineMetrics：写回日志成功率统计与 distill 对账分类计数。
 *
 * 全部在 MEMORY_HUB_ROOT 隔离的临时目录演练；LLM 客户端 mock 注入。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import {
  samplePagesForProbes,
  normalizeProbes,
  generateProbes,
  coverageCheck,
  pipelineMetrics,
  loadProbes,
} from '../src/eval.js';
import { ensureHubStore, storePaths } from '../src/hub-store.js';
import { appendWritebackLog } from '../src/writeback.js';
import { defaultConfig } from '../src/config.js';

const tmpRoots = [];

function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-eval-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  ensureHubStore();
  return dir;
}

function writeWikiPage(slug, { title, hubIds, body }) {
  const fm = { 'hub-id': hubIds, sources: [], 'last-updated': '2026-08-13T10:00:00.000Z', tags: [], category: 'task_summary_experience' };
  const file = path.join(storePaths.wiki, `${slug}.md`);
  fs.writeFileSync(file, matter.stringify({ content: `# ${title || slug}\n\n${body}\n` }, fm));
  return file;
}

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

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('samplePagesForProbes：同主题只取信息量最大的一页，按 hubIds 数排序限量', () => {
  const pages = [
    { slug: 'ab-test-one', hubIds: ['a'], bytes: 100 },
    { slug: 'ab-test-two', hubIds: ['a', 'b', 'c'], bytes: 200 },
    { slug: 'odps-data-guide', hubIds: ['d', 'e'], bytes: 500 },
    { slug: 'html-report-spec', hubIds: ['f'], bytes: 300 },
  ];
  const sampled = samplePagesForProbes(pages, 2);
  assert.equal(sampled.length, 2);
  assert.equal(sampled[0].slug, 'ab-test-two', '同主题去重后取 hubIds 最多者');
  assert.equal(sampled[1].slug, 'odps-data-guide');
});

test('normalizeProbes：编造 slug 过滤、缺字段丢弃、短泛词过滤', () => {
  const sampled = [{ slug: 'ab-test-two' }, { slug: 'odps-data-guide' }];
  const probes = normalizeProbes(
    {
      probes: [
        { slug: 'ab-test-two', question: '显著指标是什么？', answer: '道歉重来率 13%', keywords: ['道歉重来率', '13%', '率'] },
        { slug: 'made-up-page', question: 'x', answer: 'y', keywords: ['z1'] },
        { slug: 'odps-data-guide', question: '缺答案', answer: '', keywords: ['k1'] },
      ],
    },
    sampled,
  );
  assert.equal(probes.length, 1, '只保留合法探针');
  assert.equal(probes[0].sourcePage, 'ab-test-two.md');
  assert.deepEqual(probes[0].keywords, ['道歉重来率', '13%'], '单字符泛词被过滤');
  assert.throws(() => normalizeProbes({ notProbes: [] }, sampled), /probes/);
});

test('generateProbes + coverageCheck：LLM 出题落盘，覆盖度按判据关键词判定', async () => {
  freshHubRoot();
  writeWikiPage('ab-test-findings', {
    title: 'AB 实验结论',
    hubIds: ['hub-a1', 'hub-a2'],
    body: '唯一显著指标是道歉重来率：测试组 13% 对照组 4.6%。',
  });
  writeWikiPage('odps-field-spec', {
    title: '字段规范',
    hubIds: ['hub-b1'],
    body: '高阶版判定必须用 robot_version 字段。',
  });

  const client = mockClient(
    JSON.stringify({
      probes: [
        { slug: 'ab-test-findings', question: '实验唯一显著指标？', answer: '道歉重来率 13% vs 4.6%', keywords: ['道歉重来率', '4.6%'] },
        { slug: 'odps-field-spec', question: '高阶版判定用什么字段？', answer: 'robot_version', keywords: ['robot_version'] },
      ],
    }),
  );
  const config = defaultConfig();
  const g = await generateProbes({ config, client });
  assert.equal(g.ok, true);
  assert.equal(g.probes.length, 2);
  assert.equal(loadProbes().probes.length, 2, '探针集已落盘');

  // 伪造两个 App 的记忆语料：claude 覆盖第一题，codex 两题都覆盖
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-eval-home-'));
  tmpRoots.push(home);
  const claudeDir = path.join(home, 'claude-mem');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'a.md'), '实验结论：道歉重来率显著上升。');
  const codexFile = path.join(home, 'AGENTS.md');
  fs.writeFileSync(codexFile, '道歉重来率 13%；高阶版判定用 robot_version。');
  config.apps = [
    { id: 'claude', enabled: true, memory_paths: [claudeDir] },
    { id: 'codex', enabled: true, memory_paths: [codexFile] },
    { id: 'qoder', enabled: false, memory_paths: ['/nonexistent'] },
  ];

  const c = coverageCheck({ config });
  assert.equal(c.ok, true);
  assert.equal(c.total, 2);
  assert.equal(c.perApp.wiki, 2, 'wiki 基准全覆盖');
  assert.equal(c.perApp.claude, 1, 'claude 覆盖 1 题');
  assert.equal(c.perApp.codex, 2, 'codex 全覆盖（AGENTS.md 单文件路径）');
  assert.equal('qoder' in c.perApp, false, '禁用 App 不参与');
});

test('coverageCheck：无探针集时报明确错误', () => {
  freshHubRoot();
  const r = coverageCheck({ config: defaultConfig() });
  assert.equal(r.ok, false);
  assert.match(r.error, /hub eval generate/);
});

test('pipelineMetrics：写回成功率与 distill 对账分类统计', () => {
  freshHubRoot();
  appendWritebackLog([
    { time: 't', app: 'claude', hubId: 'h1', result: 'written', backupDir: null },
    { time: 't', app: 'claude', hubId: 'h2', result: 'skipped: 幂等', backupDir: null },
    { time: 't', app: 'qoder', hubId: 'h3', result: 'deferred: 外部修改', backupDir: null },
    { time: 't', app: 'qoder', hubId: 'h4', result: 'removed', backupDir: null },
  ]);
  fs.writeFileSync(
    path.join(storePaths.state, 'distill-state.json'),
    JSON.stringify({
      version: 1,
      processed: {
        a: { page: 'x', at: 't' },
        b: { page: '', at: 't', skipped: 'echo' },
        c: { page: '', at: 't', skipped: 'test-marker' },
      },
      quarantined: {},
      batchFailures: {},
      poisonedBatches: {},
    }),
  );
  writeWikiPage('some-topic-page', { title: '页', hubIds: ['a'], body: '内容' });

  const m = pipelineMetrics();
  assert.equal(m.writeback.written, 1);
  assert.equal(m.writeback.removed, 1);
  assert.equal(m.writeback.deferred, 1);
  assert.equal(m.writeback.successRate, +(2 / 3).toFixed(4), 'skipped 不参与成功率分母');
  assert.equal(m.wikiPages, 1);
  assert.equal(m.distill.processed, 3);
  assert.equal(m.distill.echo, 1);
  assert.equal(m.distill.testMarker, 1);
});
