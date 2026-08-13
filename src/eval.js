/**
 * eval.js —— 记忆效果评测引擎（hub eval）。
 *
 * 回答「这套记忆系统有没有用」的三层问题中的前两层：
 * ① 管道有效性（pipelineMetrics）：写回成功率 / wiki 规模 / distill 对账——
 *    从既有日志与状态文件汇总，零成本；
 * ② 记忆可达性（coverageCheck）：从 wiki 抽样生成「只有记忆里才有」的事实
 *    探针题（generateProbes，LLM 出题 + 关键词判据），再确定性检查每个
 *    App 的记忆文件语料里是否包含答案判据——证明「记忆到达且可被检索」；
 * ③ 真实命中率（第三层）需人工盲测：各 App 新会话问探针题，有/无记忆对照。
 *    hub eval report 输出盲测清单供人工执行。
 *
 * 探针集落 state/eval-probes.json：
 * {"version":1,"generatedAt":"<ISO>","probes":[{id,question,answer,keywords[],sourcePage}]}
 * keywords 为判据关键词（答案中的判别性字符串，出现即视为语料覆盖该事实）。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { FILE_MODE, paths } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import { storePaths, ensureHubStore } from './hub-store.js';
import { loadConfig } from './config.js';
import { withLock } from './util/lock.js';
import { listCompactablePages } from './compact.js';
import { buildRealClient, extractJson, maskSecrets } from './distill.js';
import { loadWritebackLog } from './writeback.js';

/** 探针集文件：state/eval-probes.json */
export function evalProbesPath() {
  return path.join(paths.state, 'eval-probes.json');
}

/** 缺省探针题数 */
export const DEFAULT_PROBE_COUNT = 20;

/** 单页送入 LLM 出题的正文截断字节数 */
export const MAX_PROBE_PAGE_BYTES = 3 * 1024;

/** 出题 prompt：每页产一道「只有该页才有答案」的事实题 + 判据关键词 */
export const PROBE_SYSTEM_PROMPT = [
  '你是记忆评测出题引擎。输入是若干 wiki 页面（JSON 数组，字段 slug/title/content），',
  '请为每个页面出一道「事实探针题」，用于测试 AI 助手是否真的读到了这份记忆：',
  '1. 问题必须针对页面中具体、可验证的事实（数字、结论、字段名、口径定义），',
  '   不问泛泛的"是什么/怎么样"；答案必须能在页面原文中找到；',
  '2. answer 给出简短标准答案（一句话）；',
  '3. keywords 给 2-4 个判别性字符串（答案中最独特的数字/术语/字段名，',
  '   出现在文本中即可判定该事实存在；避免"的/数据/分析"这类泛词）；',
  '4. 只输出 JSON：{"probes":[{"slug":"...","question":"...","answer":"...","keywords":["..."]}]}，',
  '   slug 必须来自输入，不要输出其他文字。',
].join('\n');

/**
 * 读取探针集；不存在/损坏返回 null。
 * @returns {{ version: number, generatedAt: string, probes: Object[] }|null}
 */
export function loadProbes() {
  try {
    const raw = JSON.parse(fs.readFileSync(evalProbesPath(), 'utf8'));
    if (raw && Array.isArray(raw.probes)) return raw;
  } catch {
    // 不存在/损坏
  }
  return null;
}

/**
 * 抽样 wiki 页面供出题：按主题键去重（同主题只取信息量最大的一页），
 * 优先 hubIds 多、体量大的页面（事实密度高），保证覆盖面广而不集中。
 * @param {Object[]} pages listCompactablePages 结果
 * @param {number} count 抽样页数
 * @returns {Object[]}
 */
export function samplePagesForProbes(pages, count) {
  const byTopic = new Map();
  for (const p of pages) {
    // 主题键粗分组：slug 前 2 段（与 compact 同思路，此处直接切前 2 段即可）
    const key = p.slug.split('-').slice(0, 2).join('-');
    const cur = byTopic.get(key);
    if (!cur || p.hubIds.length > cur.hubIds.length || (p.hubIds.length === cur.hubIds.length && p.bytes > cur.bytes)) {
      byTopic.set(key, p);
    }
  }
  return [...byTopic.values()]
    .sort((a, b) => b.hubIds.length - a.hubIds.length || b.bytes - a.bytes)
    .slice(0, count);
}

/**
 * 规范化 LLM 出题输出：slug 必须来自输入；question/answer/keywords 缺一丢弃；
 * keywords 过滤过短（<2 字符）泛词。
 * @param {Object} json extractJson 产物
 * @param {Object[]} sampled 抽样页面
 * @returns {Object[]} probes
 */
export function normalizeProbes(json, sampled) {
  if (!json || !Array.isArray(json.probes)) throw new Error('输出缺少 probes 数组');
  const known = new Map(sampled.map((p) => [p.slug, p]));
  const out = [];
  for (const p of json.probes) {
    const slug = String(p.slug || '');
    if (!known.has(slug)) continue;
    const question = maskSecrets(String(p.question || '').trim());
    const answer = maskSecrets(String(p.answer || '').trim());
    const keywords = (Array.isArray(p.keywords) ? p.keywords : [])
      .map((k) => maskSecrets(String(k).trim()))
      .filter((k) => k.length >= 2);
    if (!question || !answer || keywords.length === 0) continue;
    out.push({
      id: `probe-${out.length + 1}`,
      question,
      answer,
      keywords,
      sourcePage: `${slug}.md`,
    });
  }
  return out;
}

/**
 * 生成探针集并落盘（LLM 出题，批量一次调用；已有探针集会被整体覆盖）。
 * @param {{ config?: Object, client?: Object, count?: number }} [opts]
 * @returns {Promise<{ ok: boolean, probes?: Object[], error?: string, llmCalls?: number }>}
 */
export async function generateProbes(opts = {}) {
  ensureHubStore();
  const config = opts.config || loadConfig();
  const count = opts.count && opts.count > 0 ? opts.count : DEFAULT_PROBE_COUNT;
  const pages = listCompactablePages();
  if (pages.length === 0) {
    return { ok: false, error: 'wiki 中没有可出题的页面（先运行 hub distill）' };
  }
  let client;
  try {
    client = opts.client || buildRealClient(config);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const sampled = samplePagesForProbes(pages, count);
  const items = sampled.map((p) => ({
    slug: p.slug,
    title: p.title,
    content: maskSecrets(p.body).slice(0, MAX_PROBE_PAGE_BYTES),
  }));
  let llmText;
  try {
    llmText = await client.chat(
      [
        { role: 'system', content: PROBE_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(items) },
      ],
      { maxTokens: 8192 },
    );
  } catch (err) {
    return { ok: false, error: `LLM 出题失败: ${err.message}`, llmCalls: 1 };
  }
  let probes;
  try {
    probes = normalizeProbes(extractJson(llmText), sampled);
  } catch (err) {
    return { ok: false, error: `出题输出解析失败: ${err.message}`, llmCalls: 1 };
  }
  if (probes.length === 0) {
    return { ok: false, error: '未产出任何有效探针题', llmCalls: 1 };
  }
  const state = { version: 1, generatedAt: new Date().toISOString(), probes };
  withLock(evalProbesPath(), () => {
    atomicWrite(evalProbesPath(), `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
  });
  return { ok: true, probes, sampledPages: sampled.length, llmCalls: 1 };
}

// ---------------------------------------------------------------------------
// 覆盖度检测：探针判据关键词在各 App 记忆语料中的到达率
// ---------------------------------------------------------------------------

/** 递归收集目录下全部 .md 文件路径（跳过隐藏文件/目录与 README.md 占位） */
function listMdFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 拼接一个 App 的记忆语料全文（memory_paths 下全部 md，含 AGENTS.md 单文件路径）。
 * @param {Object} appCfg config.apps[] 条目
 * @returns {string}
 */
export function appCorpus(appCfg) {
  const chunks = [];
  for (const p of appCfg.memory_paths || []) {
    try {
      const st = fs.statSync(p);
      const files = st.isDirectory() ? listMdFiles(p) : [p];
      for (const f of files) {
        try {
          chunks.push(fs.readFileSync(f, 'utf8'));
        } catch {
          // 单文件不可读跳过
        }
      }
    } catch {
      // 路径不存在跳过
    }
  }
  return chunks.join('\n');
}

/**
 * 覆盖度检测：每道探针题的判据关键词（任一命中即覆盖）在各 App 语料中的到达率。
 * wiki 自身也算一列（sanity 基准，应为 100%）。
 * @param {{ config?: Object, probes?: Object[] }} [opts]
 * @returns {{ ok: boolean, results?: Object[], perApp?: Object, error?: string }}
 *   results[i] = { id, question, sourcePage, hits: { wiki: bool, claude: bool, ... } }
 */
export function coverageCheck(opts = {}) {
  ensureHubStore();
  const config = opts.config || loadConfig();
  const probes = opts.probes || loadProbes()?.probes;
  if (!probes || probes.length === 0) {
    return { ok: false, error: '探针集不存在或为空，先运行 hub eval generate' };
  }
  // 语料：wiki + 各启用且有记忆路径的 App（readOnly 的也测——只进不出仍可能天然覆盖）
  const corpora = new Map();
  corpora.set(
    'wiki',
    listMdFiles(storePaths.wiki).map((f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    }).join('\n'),
  );
  for (const app of config.apps || []) {
    if (!app.enabled || !(app.memory_paths || []).length) continue;
    corpora.set(app.id, appCorpus(app));
  }

  const results = [];
  const perApp = {};
  for (const name of corpora.keys()) perApp[name] = 0;
  for (const probe of probes) {
    const hits = {};
    for (const [name, corpus] of corpora.entries()) {
      const lower = corpus.toLowerCase();
      hits[name] = (probe.keywords || []).some((k) => lower.includes(String(k).toLowerCase()));
      if (hits[name]) perApp[name] += 1;
    }
    results.push({ id: probe.id, question: probe.question, sourcePage: probe.sourcePage, hits });
  }
  return { ok: true, results, perApp, total: probes.length };
}

// ---------------------------------------------------------------------------
// 管道有效性指标（第一层，零成本汇总）
// ---------------------------------------------------------------------------

/**
 * 汇总管道有效性指标：写回成功率（最近 N 条记录）、wiki 规模、
 * distill 对账（processed/echo/quarantine）。
 * @param {{ recent?: number }} [opts] recent 缺省统计最近 2000 条写回记录
 * @returns {Object}
 */
export function pipelineMetrics(opts = {}) {
  ensureHubStore();
  const recent = opts.recent || 2000;
  const log = loadWritebackLog().slice(-recent);
  const counts = { written: 0, skipped: 0, deferred: 0, failed: 0, removed: 0, other: 0 };
  for (const r of log) {
    const s = String(r.result || '').split(':')[0].trim();
    if (s in counts) counts[s] += 1;
    else counts.other += 1;
  }
  const effective = counts.written + counts.removed;
  const attempted = effective + counts.deferred + counts.failed;
  const wikiPages = listMdFiles(storePaths.wiki).length;
  let distillState = { processed: 0, echo: 0, testMarker: 0, tombstone: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storePaths.state, 'distill-state.json'), 'utf8'));
    const entries = Object.values(raw.processed || {});
    distillState.processed = entries.length;
    distillState.echo = entries.filter((e) => e.skipped === 'echo').length;
    distillState.testMarker = entries.filter((e) => e.skipped === 'test-marker').length;
    distillState.tombstone = entries.filter((e) => e.skipped === 'tombstone').length;
  } catch {
    // 状态不可读：留零值
  }
  return {
    writeback: {
      records: log.length,
      ...counts,
      successRate: attempted > 0 ? +(effective / attempted).toFixed(4) : null,
    },
    wikiPages,
    distill: distillState,
  };
}

/**
 * 输出人类可读的评测报告（覆盖度 + 管道指标 + 盲测清单）。
 * @param {{ coverage?: Object, metrics?: Object, probes?: Object[] }} data
 * @returns {string}
 */
export function formatEvalReport(data) {
  const lines = [];
  if (data.metrics) {
    const m = data.metrics;
    lines.push('📊 管道有效性（第一层）');
    lines.push(
      `  写回成功率: ${m.writeback.successRate === null ? '无记录' : `${(m.writeback.successRate * 100).toFixed(1)}%`}` +
        `（written ${m.writeback.written} / removed ${m.writeback.removed} / deferred ${m.writeback.deferred} / failed ${m.writeback.failed}，最近 ${m.writeback.records} 条）`,
    );
    lines.push(`  wiki 页面数: ${m.wikiPages}`);
    lines.push(`  distill 对账: processed ${m.distill.processed}（echo 跳过 ${m.distill.echo} / 测试标记 ${m.distill.testMarker} / tombstone ${m.distill.tombstone}）`);
  }
  if (data.coverage?.ok) {
    const c = data.coverage;
    lines.push('');
    lines.push(`🎯 记忆可达性（第二层，${c.total} 道探针题的判据关键词到达率）`);
    for (const [name, hit] of Object.entries(c.perApp)) {
      const pct = ((hit / c.total) * 100).toFixed(0);
      lines.push(`  ${name.padEnd(10)} ${hit}/${c.total}（${pct}%）${name === 'wiki' ? ' ← 基准' : ''}`);
    }
    const missed = c.results.filter((r) => Object.entries(r.hits).some(([n, h]) => n !== 'wiki' && !h));
    if (missed.length > 0) {
      lines.push(`  未全端覆盖的探针: ${missed.length} 道（hub eval report --json 查看明细）`);
    }
  }
  if (data.probes && data.probes.length > 0) {
    lines.push('');
    lines.push('📝 第三层盲测清单（各 App 新会话逐题问，有/无记忆各一遍，记录能否答对）');
    for (const p of data.probes) {
      lines.push(`  ${p.id}. ${p.question}`);
      lines.push(`      标准答案: ${p.answer}（出处 ${p.sourcePage}）`);
    }
  }
  return lines.join('\n');
}
