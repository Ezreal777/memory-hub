/**
 * compact.js —— wiki 全局归并引擎（hub compact）。
 *
 * 背景：distill 的 H3 相似页归并只做「词集相等/真子集」级别的 slug 匹配，
 * LLM 每批起名有随机性（ab-test-conclusions / ab-experiment-findings ……），
 * 同主题页面会随时间越攒越多。本模块补上第 4 层：跨页面的全局主题归并。
 *
 * 流程：
 * 1. 确定性聚类：按 slug 前 2 个实词的主题键分组（去虚词、剥 -N 后缀），
 *    只处理 ≥ minClusterSize 的簇（config.compact 可调）；
 * 2. LLM 归并：每簇分块（≤ maxPagesPerCall 页/次）请 LLM 重组为尽可能少的页面，
 *    输出 sourceSlugs 映射（哪些输入页归并进哪个输出页）；hubIds/sources 并集
 *    一律由代码计算，绝不信任 LLM 编造；
 * 3. 落盘：赢家页原子写入（备份先行），输家页物理删除（同一备份目录可整体回滚）；
 *    distill-state 中指向输家 slug 的 processed 映射改指赢家（tombstone 定位不失效）；
 * 4. 联动：赢家页登记 pending-writeback（App 侧重渲染），输家页主 hubId 登记
 *    removals（App 侧旧渲染文件由 writeback 侧 removeEntries 清理）；
 *    每轮成功后重建 master-index。
 *
 * 安全阀：
 * - 簇签名失败计数 ≥ MAX_CLUSTER_FAILURES 次即隔离（毒簇不再重放，防 token 空烧）；
 * - LLM 输出校验：sourceSlugs 必须是输入子集；未被任何输出页认领的输入页原样保留
 *   （宁可少合并也绝不丢内容）；输出页数 ≥ 输入页数视为无增益，记 noGain 跳过；
 * - 输入页 content 逐页截断 + 请求体预算约束；dry-run 只打印聚类计划不落盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { FILE_MODE, paths } from './util/paths.js';
import { atomicWrite, createBackupDir, backupTo } from './safe-write.js';
import { storePaths, ensureHubStore } from './hub-store.js';
import { sha256Of } from './adapters/base.js';
import { loadConfig } from './config.js';
import { appendLogEntry } from './util/log.js';
import { withLock } from './util/lock.js';
import { rebuildMasterIndex } from './index-builder.js';
import {
  loadDistillState,
  saveDistillState,
  buildRealClient,
  extractJson,
  maskSecrets,
  trimTrailingOrphanHeadings,
  appendPendingWriteback,
  pendingWritebackPath,
  CATEGORY_ENUM,
  DEFAULT_CATEGORY,
} from './distill.js';

/** compact 对账状态文件：hub/state/compact-state.json */
export function compactStatePath() {
  return path.join(storePaths.state, 'compact-state.json');
}

/** compact 日志文件路径 */
function compactLogPath() {
  return path.join(paths.logs, 'compact.log');
}

function logCompact(level, msg) {
  appendLogEntry(compactLogPath(), `${new Date().toISOString()}\t${level}\t${msg}`);
}

/** 单簇单次 LLM 调用最多送入的页面数（大簇分块，跨轮收敛） */
export const MAX_PAGES_PER_CALL = 8;

/** 送入 LLM 的单页正文截断字节数（防超长页撑爆请求体） */
export const MAX_PAGE_INPUT_BYTES = 12 * 1024;

/** 同一簇签名归并失败达到该次数即隔离（不再重放） */
export const MAX_CLUSTER_FAILURES = 3;

/** 缺省最小成簇页数（低于该值的主题不值得归并） */
export const DEFAULT_MIN_CLUSTER_SIZE = 3;

/** 缺省单轮最多处理的簇数（控制单轮耗时与 LLM 调用量，剩余下轮继续） */
export const DEFAULT_MAX_CLUSTERS_PER_RUN = 4;

/** 缺省自动归并间隔：24 小时（daemon 兜底扫描轮里检查到期后触发） */
export const DEFAULT_COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 读取 compact 状态。
 * - lastRunAt：上次成功轮的 ISO 时间（daemon 频控依据）；
 * - failures：簇签名 → { count, lastError, at }（达上限转 poisoned）；
 * - poisoned：失败 ≥3 次被隔离、不再重放的毒簇；
 * - noGain：LLM 判定无归并增益的簇签名（成员不变时不再重复调用）。
 * @returns {{ version: number, lastRunAt: string, failures: Object, poisoned: Object, noGain: Object }}
 */
export function loadCompactState() {
  try {
    const raw = JSON.parse(fs.readFileSync(compactStatePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        version: raw.version || 1,
        lastRunAt: raw.lastRunAt || '',
        failures: raw.failures || {},
        poisoned: raw.poisoned || {},
        noGain: raw.noGain || {},
      };
    }
  } catch {
    // 首次运行或文件损坏：空状态
  }
  return { version: 1, lastRunAt: '', failures: {}, poisoned: {}, noGain: {} };
}

/**
 * 保存 compact 状态（withLock 跨进程互斥 + 原子写，600 权限）。
 * @param {Object} state loadCompactState 结构
 */
export function saveCompactState(state) {
  withLock(compactStatePath(), () => {
    atomicWrite(compactStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
  });
}

// ---------------------------------------------------------------------------
// 确定性聚类：slug 主题键分组
// ---------------------------------------------------------------------------

/** 主题键分词时忽略的英文虚词（与 distill 的 SLUG_STOPWORDS 同口径） */
const TOPIC_STOPWORDS = new Set(['of', 'on', 'the', 'a', 'an', 'and', 'for', 'with', 'to', 'in', 'at', 'by', 'vs']);

/**
 * 从 slug 提取主题键：剥 `-N` 冲突后缀、去虚词后取前 2 个实词。
 * 实词不足 2 个时返回 null（单词主题太宽泛，不参与聚类，防误归并）。
 * @param {string} slug
 * @returns {string|null} 如 "ab-test"；不可聚类时 null
 */
export function topicKeyOf(slug) {
  const tokens = String(slug)
    .toLowerCase()
    .replace(/-\d+$/, '')
    .split('-')
    .filter((t) => t && !TOPIC_STOPWORDS.has(t));
  if (tokens.length < 2) return null;
  return `${tokens[0]}-${tokens[1]}`;
}

/**
 * 读取 wiki 顶层可归并页面的元数据（跳过 README/隐藏文件/子目录/已标 deleted/
 * frontmatter 损坏/无 hub-id 归属的页面——无归属页无法做幂等写回，不动为妙）。
 * @returns {{ slug: string, file: string, title: string, hubIds: string[],
 *   sources: string[], tags: string[], category: string, deletedHubIds: string[],
 *   body: string, bytes: number }[]}
 */
export function listCompactablePages() {
  let entries;
  try {
    entries = fs.readdirSync(storePaths.wiki, { withFileTypes: true });
  } catch {
    return [];
  }
  const pages = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'README.md' || e.name.startsWith('.')) continue;
    const file = path.join(storePaths.wiki, e.name);
    let parsed;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
      parsed = matter(raw);
    } catch {
      continue; // 单页损坏不参与归并
    }
    const fm = parsed.data || {};
    if (fm.deleted === true) continue;
    const rawIds = fm['hub-id'];
    const hubIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
    if (hubIds.length === 0) continue;
    const body = String(parsed.content || '').trim();
    const titleMatch = body.match(/^#\s+(.*)$/m);
    pages.push({
      slug: e.name.slice(0, -3),
      file,
      title: titleMatch ? titleMatch[1].trim() : e.name.slice(0, -3),
      hubIds,
      sources: (Array.isArray(fm.sources) ? fm.sources : []).map(String),
      tags: (Array.isArray(fm.tags) ? fm.tags : []).map(String),
      category: String(fm.category || ''),
      deletedHubIds: (Array.isArray(fm['deleted-hub-ids']) ? fm['deleted-hub-ids'] : []).map(String),
      body,
      bytes: Buffer.byteLength(raw, 'utf8'),
    });
  }
  return pages;
}

/**
 * 按主题键聚类，返回 ≥ minClusterSize 的簇（大簇优先，收益最大化）。
 * @param {Object[]} pages listCompactablePages 结果
 * @param {{ minClusterSize?: number, topicKey?: string }} [opts] topicKey 定向只处理指定主题
 * @returns {{ key: string, pages: Object[] }[]}
 */
export function clusterPages(pages, opts = {}) {
  const minSize = opts.minClusterSize || DEFAULT_MIN_CLUSTER_SIZE;
  const groups = new Map();
  for (const p of pages) {
    const key = topicKeyOf(p.slug);
    if (!key) continue;
    if (opts.topicKey && key !== opts.topicKey) continue;
    const arr = groups.get(key) || [];
    arr.push(p);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .filter(([, arr]) => arr.length >= minSize)
    .map(([key, arr]) => ({ key, pages: arr.sort((a, b) => b.hubIds.length - a.hubIds.length || a.slug.localeCompare(b.slug)) }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

/**
 * 簇分块签名——由块内 slug 排序拼接取 SHA-256（成员不变则跨轮稳定，
 * 供失败隔离与 noGain 去重；成员变化后签名自动失效重新可归并）。
 * @param {Object[]} chunk 页面数组
 * @returns {string}
 */
export function clusterSignature(chunk) {
  return sha256Of(chunk.map((p) => p.slug).sort().join('\n'));
}

// ---------------------------------------------------------------------------
// LLM 归并
// ---------------------------------------------------------------------------

/** 归并 prompt（系统段）：重组页面簇、输出 sourceSlugs 映射 */
export const COMPACT_SYSTEM_PROMPT = [
  '你是 wiki 主题归并引擎。输入是同一主题下的多个 wiki 页面，JSON 数组，',
  '字段：slug/title/content。这些页面是长期积累的近似重复页，请把它们重组归并为',
  '尽可能少的页面（理想 1 页；确属不同子主题时可以多页，但必须显著少于输入页数）：',
  '1. 语义去重：重复结论只保留一份；冲突时保留双方说法并标注差异；',
  '2. 保留全部关键事实、数字、结论与踩坑记录，不要编造，不要输出任何密钥；',
  '3. 每个输出页给出 slug（英文小写 kebab-case，仅 a-z0-9-，优先复用输入中最贴切的 slug）、',
  '   title（统一用中文）、tags（字符串数组）、category、content（markdown 正文，不含一级标题）、',
  '   sourceSlugs（归并进本页的全部输入页 slug，必须来自输入，不得编造、不得遗漏）；',
  `4. category 从以下枚举中选一个（不确定时用 ${DEFAULT_CATEGORY}）：${CATEGORY_ENUM.join('、')}；`,
  '5. 每个输入页的 slug 必须且只能出现在一个输出页的 sourceSlugs 中；',
  '6. 只输出 JSON：{"pages":[{"slug":"...","title":"...","tags":[],"category":"...","content":"...","sourceSlugs":["..."]}]}，不要输出其他文字。',
].join('\n');

/**
 * 构建单簇归并请求消息（逐页截断至 MAX_PAGE_INPUT_BYTES）。
 * @param {Object[]} chunk 页面数组
 * @returns {Object[]} chat messages
 */
export function buildCompactMessages(chunk) {
  const items = chunk.map((p) => ({
    slug: p.slug,
    title: p.title,
    content: maskSecrets(p.body).slice(0, MAX_PAGE_INPUT_BYTES),
  }));
  return [
    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(items) },
  ];
}

/**
 * 校验并规范化 LLM 归并输出。
 * - sourceSlugs 只保留输入中真实存在的（防编造）；跨页重复认领时只认首个；
 * - 无有效 sourceSlugs / 无 content 的输出页丢弃；
 * - 输出页数 ≥ 有效认领的输入页数 → 无增益（返回 null 由调用方记 noGain）。
 * @param {Object} json extractJson 产物
 * @param {Object[]} chunk 输入页面数组
 * @returns {{ pages: Object[], claimed: Set<string> }|null} null 表示无增益
 * @throws {Error} 输出结构不合规
 */
export function normalizeCompactOutput(json, chunk) {
  if (!json || !Array.isArray(json.pages)) throw new Error('输出缺少 pages 数组');
  const known = new Set(chunk.map((p) => p.slug));
  const claimed = new Set();
  const pages = [];
  for (const p of json.pages) {
    const sourceSlugs = (Array.isArray(p.sourceSlugs) ? p.sourceSlugs : [])
      .map(String)
      .filter((s) => known.has(s) && !claimed.has(s));
    const content = maskSecrets(String(p.content || '').trim());
    if (sourceSlugs.length === 0 || !content) continue;
    for (const s of sourceSlugs) claimed.add(s);
    const slugRaw = String(p.slug || '').toLowerCase().trim();
    pages.push({
      slug: /^[a-z0-9-]+$/.test(slugRaw) ? slugRaw : sourceSlugs[0],
      title: maskSecrets(String(p.title || '').trim()) || sourceSlugs[0],
      tags: (Array.isArray(p.tags) ? p.tags : []).map((t) => maskSecrets(String(t))),
      category: CATEGORY_ENUM.includes(p.category) ? p.category : '',
      content,
      sourceSlugs,
    });
  }
  if (pages.length === 0) throw new Error('输出没有任何有效归并页');
  // 无增益判定：输出页数没有少于被认领的输入页数（如 8 页归并出 8 页）
  if (pages.length >= claimed.size) return null;
  return { pages, claimed };
}

/** frontmatter 数组字段并集（去重、保序） */
function unionArr(...lists) {
  return [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])))];
}

// ---------------------------------------------------------------------------
// 落盘应用：赢家页写入 + 输家页删除 + 状态/契约联动
// ---------------------------------------------------------------------------

/**
 * 把一个归并块的 LLM 输出应用到磁盘（备份先行，同一备份目录可整体回滚）。
 * @param {Object[]} outPages normalizeCompactOutput 的 pages
 * @param {Object[]} chunk 输入页面数组
 * @param {Object} distillState loadDistillState 结果（就地改 processed 映射）
 * @param {string} now ISO 时间
 * @returns {{ written: string[], removed: string[], removalHubIds: string[],
 *   pendingPages: { path: string, hubIds: string[] }[], backupDir: string }}
 */
export function applyCompactOutput(outPages, chunk, distillState, now) {
  const bySlug = new Map(chunk.map((p) => [p.slug, p]));
  const backupDir = createBackupDir('writeback');
  const written = [];
  const removed = [];
  const removalHubIds = [];
  const pendingPages = [];

  // 先统一备份本块全部受影响页面（赢家覆写 + 输家删除均可回滚）
  const affectedSlugs = new Set(outPages.flatMap((p) => p.sourceSlugs));
  for (const slug of affectedSlugs) {
    backupTo(bySlug.get(slug).file, backupDir);
  }

  for (const out of outPages) {
    const inputs = out.sourceSlugs.map((s) => bySlug.get(s));
    // 目标 slug：LLM 给的 slug 若与簇外既有页撞名，退回输入中 hubIds 最多的页的 slug
    let targetSlug = out.slug;
    const targetInInputs = out.sourceSlugs.includes(targetSlug);
    if (!targetInInputs && fs.existsSync(path.join(storePaths.wiki, `${targetSlug}.md`))) {
      targetSlug = inputs[0].slug;
    }
    const targetPath = path.join(storePaths.wiki, `${targetSlug}.md`);

    const hubIds = unionArr(...inputs.map((p) => p.hubIds));
    const fm = {
      'hub-id': hubIds,
      sources: unionArr(...inputs.map((p) => p.sources)),
      'last-updated': now,
      tags: unionArr(out.tags, ...inputs.map((p) => p.tags)),
      category: out.category || inputs[0].category || DEFAULT_CATEGORY,
    };
    const deletedIds = unionArr(...inputs.map((p) => p.deletedHubIds));
    if (deletedIds.length > 0) fm['deleted-hub-ids'] = deletedIds;

    const body = trimTrailingOrphanHeadings(`# ${out.title}\n\n${out.content}`);
    // 对象传参：避免 gray-matter 把正文中的孤立 --- 误当 frontmatter 解析
    atomicWrite(targetPath, matter.stringify({ content: `${body}\n` }, fm), { mode: FILE_MODE });
    written.push(targetPath);
    pendingPages.push({ path: `${targetSlug}.md`, hubIds });

    // 输家页物理删除；其主 hubId（App 侧旧渲染文件的定位键）登记 removals
    for (const p of inputs) {
      if (p.slug === targetSlug) continue;
      fs.rmSync(p.file, { force: true });
      removed.push(p.file);
      removalHubIds.push(p.hubIds[0]);
    }
    // distill-state 重定向：指向本块任一输入 slug 的 processed 记录改指赢家 slug
    const loserSlugs = new Set(out.sourceSlugs.filter((s) => s !== targetSlug));
    for (const [id, rec] of Object.entries(distillState.processed)) {
      if (rec && loserSlugs.has(rec.page)) {
        distillState.processed[id] = { ...rec, page: targetSlug, at: now };
      }
    }
  }
  return { written, removed, removalHubIds, pendingPages, backupDir };
}

/**
 * 登记 App 侧待清理的 hubId 到 pending-writeback.json 的 removals 数组
 * （与 pages 共用一把锁与同一次原子写；消费/清空由 writeback 侧负责）。
 * @param {string[]} hubIds 输家页主 hubId 列表
 * @returns {Object|null} 落盘后的完整内容；入参为空时 null
 */
export function appendPendingRemovals(hubIds) {
  const ids = (hubIds || []).filter(Boolean);
  if (ids.length === 0) return null;
  const file = pendingWritebackPath();
  return withLock(file, () => {
    let existing = { updatedAt: '', pages: [], removals: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        existing = { pages: [], removals: [], ...raw };
      }
    } catch {
      // 不存在/损坏：从零开始
    }
    const out = {
      updatedAt: new Date().toISOString(),
      pages: Array.isArray(existing.pages) ? existing.pages : [],
      removals: [...new Set([...(Array.isArray(existing.removals) ? existing.removals : []), ...ids])],
    };
    atomicWrite(file, `${JSON.stringify(out, null, 2)}\n`, { mode: FILE_MODE });
    return out;
  });
}

// ---------------------------------------------------------------------------
// 主编排
// ---------------------------------------------------------------------------

/**
 * 执行一轮全局归并。
 * @param {{
 *   dryRun?: boolean,        // 只打印聚类计划与将发生的归并，不调 LLM、不落盘
 *   topicKey?: string,       // 定向只处理指定主题键（如 "ab-test"，试点用）
 *   maxClusters?: number,    // 本轮最多处理的簇数（缺省 config.compact.maxClustersPerRun）
 *   config?: Object,         // 配置；缺省 loadConfig()
 *   client?: Object,         // LLM 客户端注入（测试 mock 用）
 * }} [opts]
 * @returns {Promise<Object>} { ok, clusters, merged, removedPages, errors?, ... }
 */
export async function compact(opts = {}) {
  ensureHubStore();
  const config = opts.config || loadConfig();
  const ccfg = config.compact || {};
  const minClusterSize = ccfg.minClusterSize || DEFAULT_MIN_CLUSTER_SIZE;
  const maxClusters = opts.maxClusters && opts.maxClusters > 0
    ? opts.maxClusters
    : ccfg.maxClustersPerRun || DEFAULT_MAX_CLUSTERS_PER_RUN;
  const maxPagesPerCall = ccfg.maxPagesPerCall || MAX_PAGES_PER_CALL;

  const allPages = listCompactablePages();
  const clusters = clusterPages(allPages, { minClusterSize, topicKey: opts.topicKey });

  if (clusters.length === 0) {
    return {
      ok: true,
      clusters: 0,
      merged: [],
      removedPages: [],
      message: opts.topicKey
        ? `主题 "${opts.topicKey}" 没有 ≥${minClusterSize} 页的簇`
        : `没有 ≥${minClusterSize} 页的近似主题簇，wiki 无需归并`,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      clusters: clusters.length,
      merged: [],
      removedPages: [],
      plan: clusters.map((c) => ({ key: c.key, count: c.pages.length, slugs: c.pages.map((p) => p.slug) })),
    };
  }

  const state = loadCompactState();
  let client;
  try {
    client = opts.client || buildRealClient(config);
  } catch (err) {
    return { ok: false, error: err.message, clusters: clusters.length };
  }

  const distillState = loadDistillState();
  const merged = [];
  const removedPages = [];
  const allRemovalHubIds = [];
  const allPendingPages = [];
  const errors = [];
  let llmCalls = 0;
  let clustersDone = 0;

  for (const cluster of clusters) {
    if (clustersDone >= maxClusters) break;
    let didWork = false;
    // 大簇分块：每块 ≤ maxPagesPerCall 页；本轮每簇只推进这些块，跨轮收敛
    for (let i = 0; i < cluster.pages.length; i += maxPagesPerCall) {
      const chunk = cluster.pages.slice(i, i + maxPagesPerCall);
      if (chunk.length < 2) continue; // 单页块无归并意义
      const sig = clusterSignature(chunk);
      if (state.poisoned[sig] || state.noGain[sig]) continue;

      let llmText;
      try {
        llmCalls += 1;
        llmText = await client.chat(buildCompactMessages(chunk), { maxTokens: 8192 });
      } catch (err) {
        errors.push(`[${cluster.key}] LLM 调用失败（该块 ${chunk.length} 页跳过，下轮重试）: ${err.message}`);
        continue;
      }

      let out;
      try {
        out = normalizeCompactOutput(extractJson(llmText), chunk);
      } catch (err) {
        errors.push(`[${cluster.key}] 输出解析失败（该块 ${chunk.length} 页跳过）: ${err.message}`);
        const rec = state.failures[sig] || { count: 0 };
        rec.count += 1;
        rec.lastError = err.message;
        rec.at = new Date().toISOString();
        if (rec.count >= MAX_CLUSTER_FAILURES) {
          delete state.failures[sig];
          state.poisoned[sig] = { slugs: chunk.map((p) => p.slug), failCount: rec.count, lastError: err.message, at: rec.at };
          logCompact('error', `毒簇隔离：${cluster.key} 块 ${sig.slice(0, 12)}（${chunk.length} 页）连续 ${rec.count} 次解析失败，不再重放`);
        } else {
          state.failures[sig] = rec;
        }
        saveCompactState(state);
        continue;
      }
      if (state.failures[sig]) delete state.failures[sig];

      if (out === null) {
        // 无增益：成员不变时不再重复调用（成员变化后签名失效自动重新可归并）
        state.noGain[sig] = { slugs: chunk.map((p) => p.slug), at: new Date().toISOString() };
        saveCompactState(state);
        logCompact('info', `[${cluster.key}] LLM 判定无归并增益（${chunk.length} 页保持原样）`);
        continue;
      }

      const now = new Date().toISOString();
      const applied = applyCompactOutput(out.pages, chunk, distillState, now);
      saveDistillState(distillState);
      merged.push(...applied.written);
      removedPages.push(...applied.removed);
      allRemovalHubIds.push(...applied.removalHubIds);
      allPendingPages.push(...applied.pendingPages);
      didWork = true;
      logCompact(
        'info',
        `[${cluster.key}] ${chunk.length} 页 → ${out.pages.length} 页（删除 ${applied.removed.length} 页，备份 ${applied.backupDir}）`,
      );
    }
    if (didWork) clustersDone += 1;
  }

  // 联动：赢家页登记增量写回，输家页主 hubId 登记 App 侧清理；重建主索引
  if (allPendingPages.length > 0) {
    try {
      appendPendingWriteback(allPendingPages);
      appendPendingRemovals(allRemovalHubIds);
    } catch (err) {
      errors.push(`pending-writeback 登记失败（App 侧同步推迟到下次全量写回）: ${err.message}`);
    }
  }
  const index = merged.length > 0 ? rebuildMasterIndex() : storePaths.masterIndex;

  state.lastRunAt = new Date().toISOString();
  saveCompactState(state);

  if (errors.length > 0 && merged.length === 0) {
    return { ok: false, error: errors.join(' ; '), clusters: clusters.length, llmCalls };
  }
  return {
    ok: true,
    clusters: clusters.length,
    clustersDone,
    llmCalls,
    merged,
    removedPages,
    index,
    ...(errors.length > 0 ? { error: errors.join(' ; ') } : {}),
  };
}

/**
 * daemon 频控判定：compact 是否到期该跑（enabled 且距上次成功 ≥ intervalMs）。
 * @param {Object} config 配置对象
 * @param {number} [nowMs] 当前毫秒时间戳（测试可注入）
 * @returns {boolean}
 */
export function compactDue(config, nowMs = Date.now()) {
  const ccfg = config.compact || {};
  if (ccfg.enabled === false) return false;
  const intervalMs = Number.isFinite(ccfg.intervalMs) ? ccfg.intervalMs : DEFAULT_COMPACT_INTERVAL_MS;
  const last = Date.parse(loadCompactState().lastRunAt || '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}
