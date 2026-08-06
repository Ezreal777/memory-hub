/**
 * distill.js —— LLM 整理引擎（hub distill）。
 *
 * 职责：把 hub/sources/ 中尚未整理的原始快照，经 OpenAI 兼容 LLM 归并为
 * 主题 wiki 页（语义去重、冲突时时间戳新者胜且冲突页保留双方标注），
 * 落到 hub/wiki/<topic-slug>.md 并刷新 _index/master-index.md。
 *
 * 安全与健壮性：
 * - AK 经 keys.resolveApiKey() 从 Keychain 解析，绝不落盘、绝不打印明文；
 * - 写入 wiki 前正则脱敏（sk- 开头密钥、AK 模式）；
 * - state/distill-state.json 记录已处理的 hubId，重跑只处理增量；
 * - LLM 调用失败优雅降级：记录错误、保留 sources、状态不变（下次重试）；
 * - 支持 dryRun（只打印将产生的页面，不落盘不改状态）与 maxPages 限额；
 * - LLM 客户端可注入（opts.client），测试全程 mock 不打真实网络。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { FILE_MODE, paths } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import { storePaths, ensureHubStore, generateMasterIndex } from './hub-store.js';
import { slugify } from './adapters/base.js';
import { loadConfig } from './config.js';
import { resolveApiKey } from './keys.js';
import { createLlmClient, LLM_CONFIG_HINT } from './llmClient.js';
import { appendLogEntry } from './util/log.js';

/** distill 对账状态文件：hub/state/distill-state.json */
export function distillStatePath() {
  return path.join(storePaths.state, 'distill-state.json');
}

/**
 * 读取 distill 状态（已处理的 hubId → 归属页与时间）。
 * @returns {{ version: number, processed: Object.<string, { page: string, at: string }> }}
 */
export function loadDistillState() {
  try {
    const raw = JSON.parse(fs.readFileSync(distillStatePath(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.processed) {
      return { version: raw.version || 1, processed: raw.processed };
    }
  } catch {
    // 首次运行或文件损坏：空状态
  }
  return { version: 1, processed: {} };
}

/**
 * 保存 distill 状态（原子写，600 权限）。
 * @param {{ version: number, processed: Object }} state
 */
export function saveDistillState(state) {
  atomicWrite(distillStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
}

/**
 * 正则脱敏：sk- 开头密钥与常见 AK 模式一律打码（写 wiki 前强制执行）。
 * @param {string} text 原文
 * @returns {string} 脱敏后文本
 */
export function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***已脱敏***')
    .replace(/\bLTAI[A-Za-z0-9]{10,}\b/g, 'LTAI***已脱敏***')
    .replace(/\bAKID[A-Za-z0-9]{10,}\b/g, 'AKID***已脱敏***')
    .replace(
      /(access[_-]?key[_-]?(?:id|secret)\s*[:=]\s*)["']?[A-Za-z0-9/+=_-]{8,}["']?/gi,
      '$1***已脱敏***',
    );
}

/**
 * 从 LLM 回复中稳健地抽取 JSON（容忍代码围栏与前后缀文字）。
 * @param {string} text LLM 原始回复
 * @returns {Object|Object[]} 解析结果
 * @throws {Error} 找不到/无法解析 JSON 时抛出
 */
export function extractJson(text) {
  let t = String(text ?? '').trim();
  if (!t) throw new Error('LLM 回复为空');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // 继续兜底抽取
  }
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error('LLM 回复中未找到 JSON 结构');
  const candidate = t.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    // 去掉尾部多余文字再试
  }
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (end <= 0) throw new Error('LLM 回复中的 JSON 不完整');
  return JSON.parse(candidate.slice(0, end + 1));
}

/**
 * 递归收集 sources/<app>/*.md 快照文件。
 * @returns {string[]}
 */
function listSnapshotFiles() {
  const out = [];
  let apps;
  try {
    apps = fs.readdirSync(storePaths.sources, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const a of apps) {
    if (!a.isDirectory()) continue;
    const dir = path.join(storePaths.sources, a.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.md')) out.push(path.join(dir, f.name));
    }
  }
  return out.sort();
}

/**
 * 读取单个快照的元数据与正文（frontmatter 含 hubId/app/title/ingestedAt 等）。
 * @param {string} file 快照路径
 * @returns {Object|null} { file, hubId, app, title, ingestedAt, body }
 */
function readSnapshot(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = matter(content);
  } catch (err) {
    // H5：解析失败不再静默吞掉，记 warn（含文件路径）便于运维定位损坏快照
    appendLogEntry(
      path.join(paths.logs, 'distill.log'),
      `${new Date().toISOString()}\twarn\t快照 frontmatter 解析失败，跳过: ${file} (${err.message})`,
    );
    return null;
  }
  const hubId = parsed.data?.hubId;
  if (!hubId) return null;
  // 去掉首个 `# 标题` 行，避免与正文重复
  const lines = String(parsed.content || '').split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 !== -1) lines.splice(h1, 1);
  return {
    file,
    hubId: String(hubId),
    app: String(parsed.data?.app || ''),
    title: String(parsed.data?.title || ''),
    ingestedAt: String(parsed.data?.ingestedAt || ''),
    body: lines.join('\n').trim(),
  };
}

/**
 * 列出尚未整理过的原始快照（distill-state 未记录的 hubId）。
 * @param {{ processed: Object }} [state] 缺省现读
 * @returns {Object[]} 快照元数据数组
 */
export function listUnprocessedSnapshots(state) {
  const st = state || loadDistillState();
  const out = [];
  for (const file of listSnapshotFiles()) {
    const snap = readSnapshot(file);
    if (!snap) continue;
    if (st.processed[snap.hubId]) continue;
    out.push(snap);
  }
  return out;
}

/** 内置整理 prompt（系统段）：归并主题、语义去重、冲突处理规则与输出 schema */
export const DISTILL_SYSTEM_PROMPT = [
  '你是记忆整理引擎。输入是多个 AI 应用（claude/codex/qoder/qoderwork/wukong）采集的原始记忆快照，',
  'JSON 数组，字段：hubId/app/title/ingestedAt/content。请把快照归并为若干主题 wiki 页：',
  '1. 语义相近的快照归入同一主题页，跨 app 语义去重；',
  '2. 内容冲突时以 ingestedAt 时间戳新者为准，但必须在冲突页正文中同时保留双方说法，',
  '   并用「⚠️ 冲突」标注来源 app 与时间；',
  '3. 每页给出 slug（小写英文短横线风格，文件系统安全）、title、tags（字符串数组）、',
  '   hubIds（本页归并的全部快照 hubId，必须来自输入，不得编造）；',
  '4. content 为 markdown 正文：提炼合并、保留关键事实与数字，不要编造，不要输出任何密钥；',
  '5. 只输出 JSON，不要任何其他文字：',
  '{"pages":[{"slug":"...","title":"...","tags":["..."],"hubIds":["..."],"content":"..."}]}',
].join('\n');

/**
 * 构建发给 LLM 的消息（快照正文截断防超长；内容先做脱敏）。
 * @param {Object[]} snapshots listUnprocessedSnapshots 的结果
 * @returns {{ role: string, content: string }[]}
 */
export function buildMessages(snapshots) {
  const payload = snapshots.map((s) => ({
    hubId: s.hubId,
    app: s.app,
    title: s.title,
    ingestedAt: s.ingestedAt,
    content: maskSecrets(s.body).slice(0, 4000),
  }));
  return [
    { role: 'system', content: DISTILL_SYSTEM_PROMPT },
    { role: 'user', content: `共 ${payload.length} 条原始快照：\n${JSON.stringify(payload)}` },
  ];
}

/**
 * 规范化 LLM 返回的页面数组（过滤非法项、slug 安全化）。
 * @param {Object|Object[]} json extractJson 的结果
 * @returns {{ slug: string, title: string, tags: string[], hubIds: string[], content: string }[]}
 */
export function normalizePages(json) {
  const rawPages = Array.isArray(json) ? json : json?.pages;
  if (!Array.isArray(rawPages)) throw new Error('LLM 输出缺少 pages 数组');
  const out = [];
  for (const p of rawPages) {
    if (!p || typeof p !== 'object') continue;
    const content = String(p.content ?? '').trim();
    const title = String(p.title ?? '').trim();
    if (!content && !title) continue;
    // H4：slug 与 README 占位/隐藏名冲突时自动加后缀，
    // 防覆盖 README.md 占位文件且永不被主索引收录。
    let slug = slugify(p.slug || title || 'topic');
    if (slug.toLowerCase() === 'readme' || slug.startsWith('.')) slug = `${slug}-page`;
    out.push({
      slug,
      title: title || slug,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      hubIds: Array.isArray(p.hubIds) ? p.hubIds.map(String) : [],
      content,
    });
  }
  return out;
}

/**
 * 构建真实 LLM 客户端（校验 config.llm + Keychain 取 AK）。
 * @param {Object} config 配置对象
 * @returns {Object} createLlmClient 产物
 * @throws {Error} 配置缺失时抛出清晰指引
 */
export function buildRealClient(config) {
  if (!config.llm?.baseUrl || !config.llm?.model) {
    throw new Error(`llm.baseUrl / llm.model 未配置。${LLM_CONFIG_HINT}`);
  }
  const apiKey = resolveApiKey(); // 未配置 keyRef / Keychain 缺失时抛明确错误
  return createLlmClient({ baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey });
}

/**
 * H4：跨批次同 slug 撞名时合并旧页，绝不整文件覆盖丢内容。
 * 策略（实现成本合理且确定性可测）：
 * - frontmatter 的 hub-id / sources 取并集（去重），tags 并集，last-updated 取新；
 * - 旧正文原样保留，新内容追加为「## 更新（<时间>）」区。
 * @param {string} oldContent 旧页全文（frontmatter + 正文）
 * @param {Object} p 新页 { title, tags, hubIds, sources, content }
 * @param {string} now ISO 时间
 * @returns {{ fm: Object, body: string }}
 */
export function mergePageContent(oldContent, p, now) {
  let oldFm = {};
  let oldBody = oldContent;
  try {
    const parsed = matter(oldContent);
    oldFm = parsed.data || {};
    oldBody = String(parsed.content || '').trim();
  } catch {
    // 旧页不可解析：整体当正文保留，内容绝不丢
    oldBody = String(oldContent).trim();
  }
  const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const fm = {
    'hub-id': union(oldFm['hub-id'], p.hubIds),
    sources: union(oldFm.sources, p.sources),
    'last-updated': now,
    tags: union(oldFm.tags, p.tags),
  };
  const body = oldBody
    ? `${oldBody}\n\n## 更新（${now}）\n\n${p.content}`
    : `# ${p.title}\n\n${p.content}`;
  return { fm, body };
}

/**
 * 执行一次 distill 整理。
 * @param {{
 *   dryRun?: boolean,     // 只打印将产生的页面变更，不落盘、不改状态
 *   maxPages?: number,    // 本次最多产出页数（超出部分保留 sources 下次再整理）
 *   client?: Object,      // 可注入的 LLM 客户端（{ chat(messages) }），测试 mock 用
 *   config?: Object,      // 配置；缺省 loadConfig()
 * }} [opts]
 * @returns {Promise<Object>} 结果摘要：
 *   { ok, pending?, pages?, written?, index?, processed?, dryRun?, error?, retained? }
 */
export async function distill(opts = {}) {
  ensureHubStore();
  const config = opts.config || loadConfig();
  const state = loadDistillState();
  const snapshots = listUnprocessedSnapshots(state);
  if (snapshots.length === 0) {
    return { ok: true, pending: 0, pages: [], message: '没有待整理的原始快照（sources 均已整理或为空）' };
  }

  // LLM 客户端：注入优先；否则按 config + Keychain 构建（失败即降级返回错误）
  let client;
  try {
    client = opts.client || buildRealClient(config);
  } catch (err) {
    return { ok: false, error: err.message, retained: snapshots.length };
  }

  // 调用 LLM（失败优雅降级：记录错误、保留 sources、状态不变，下次重试）
  let llmText;
  try {
    llmText = await client.chat(buildMessages(snapshots));
  } catch (err) {
    return { ok: false, error: `LLM 调用失败: ${err.message}`, retained: snapshots.length };
  }

  let pages;
  try {
    pages = normalizePages(extractJson(llmText));
  } catch (err) {
    return { ok: false, error: `LLM 输出解析失败: ${err.message}`, retained: snapshots.length };
  }

  // 只保留本次输入中真实存在的 hubId（防 LLM 编造）+ 全量脱敏
  const knownIds = new Set(snapshots.map((s) => s.hubId));
  const snapByHubId = new Map(snapshots.map((s) => [s.hubId, s]));
  for (const p of pages) {
    p.hubIds = p.hubIds.filter((id) => knownIds.has(id));
    p.title = maskSecrets(p.title);
    p.content = maskSecrets(p.content);
    p.tags = p.tags.map((t) => maskSecrets(t));
    // sources[] = 归并快照的原始来源文件（去重）
    p.sources = [...new Set(p.hubIds.map((id) => snapByHubId.get(id)?.file).filter(Boolean))];
  }
  // 无有效归属 hubId 的页面拒绝落盘（无法做幂等对账）
  pages = pages.filter((p) => p.hubIds.length > 0 && p.content);

  // maxPages 限额：超出的页面不产出，其快照保持未处理状态下次再整理
  if (opts.maxPages && opts.maxPages > 0) {
    pages = pages.slice(0, opts.maxPages);
  }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, pending: snapshots.length, pages };
  }

  // 落盘 wiki 页面 + 记录已处理 hubId（H4：同 slug 已存在时合并而非覆盖）
  const written = [];
  const now = new Date().toISOString();
  for (const p of pages) {
    const pagePath = path.join(storePaths.wiki, `${p.slug}.md`);
    let fm;
    let body;
    let oldContent = null;
    if (fs.existsSync(pagePath)) {
      try {
        oldContent = fs.readFileSync(pagePath, 'utf8');
      } catch {
        oldContent = null;
      }
    }
    if (oldContent !== null) {
      ({ fm, body } = mergePageContent(oldContent, p, now));
    } else {
      fm = {
        'hub-id': p.hubIds,
        sources: p.sources,
        'last-updated': now,
        tags: p.tags,
      };
      body = `# ${p.title}\n\n${p.content}`;
    }
    atomicWrite(pagePath, matter.stringify(`${body}\n`, fm), { mode: FILE_MODE });
    for (const id of p.hubIds) {
      state.processed[id] = { page: p.slug, at: now };
    }
    written.push(pagePath);
  }
  if (written.length > 0) saveDistillState(state);
  const index = generateMasterIndex();

  return {
    ok: true,
    pending: snapshots.length,
    pages,
    written,
    index,
    processed: pages.reduce((n, p) => n + p.hubIds.length, 0),
  };
}
