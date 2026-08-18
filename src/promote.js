/**
 * promote.js —— 晋升管道：wiki 主题页 → wiki/core/ 用户维度长期核心。
 *
 * 流程（Phase 2 全自动提名，确认环节保留人工）：
 *   scan：四信号打分（跨源复现/存活验证/探针命中/拍板语义）→（可选）LLM 精炼提名稿
 *         → state/promote-nominations.json
 *   list：展示待确认提名
 *   apply：确认后写入 core 页（新建/并入既有页/并入 user-profile），登记 promoted-from
 *   reject：拒绝并记负样本（30 天内不再提名同一来源页）
 *   add：Phase 1 手动晋升（无 LLM，确定性搬运）
 *   demote：core 页移回 wiki 顶层（tier 移除），hubId 登记 pending removals 走既有清理链路
 *
 * 信号数据源（全部已存在）：
 * - 跨源复现：wiki 页 frontmatter sources[] 的 App 前缀；
 * - 存活验证：state/qoder-retention.jsonl（scripts/qoder-retention-snapshot.js 产出）；
 * - 利用率：state/eval-probes.json 的 probes[].sourcePage；
 * - 拍板语义：正文关键词（已拍板/用户确认/明确要求/最终口径）。
 *
 * LLM 调用复用 distill 的冷却刹车：冷却期内 scan 降级为纯启发式提名（零调用）。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { storePaths } from './hub-store.js';
import {
  corePaths,
  listCorePages,
  readCorePage,
  writeCorePage,
  countCorePages,
  isCorePage,
  DEFAULT_CORE_CATEGORY,
} from './core-store.js';
import { loadConfig } from './config.js';
import { llmCooldownRemaining, buildRealClient } from './distill.js';
import { pendingWritebackPath, loadPendingWriteback, loadWritebackLog } from './writeback.js';
import { atomicWrite } from './safe-write.js';
import { rebuildMasterIndex } from './index-builder.js';
import { ensureDir, FILE_MODE } from './util/paths.js';
import { withLock } from './util/lock.js';

/** 拒绝负样本抑制窗口：30 天内不再提名同一来源页 */
export const REJECT_SUPPRESS_MS = 30 * 24 * 60 * 60 * 1000;

/** 拍板语义关键词（信号 4 的确定性判定） */
export const DECISION_RE = /已拍板|用户确认|用户已确认|明确要求|最终口径|已确认采用/;

/** 提名清单路径 state/promote-nominations.json */
export function nominationsPath() {
  return path.join(storePaths.state, 'promote-nominations.json');
}

/** 晋升管道状态路径 state/promote-state.json */
export function promoteStatePath() {
  return path.join(storePaths.state, 'promote-state.json');
}

/** 留存快照 JSONL 路径（qoder-retention-snapshot.js 产出） */
export function retentionPath() {
  return path.join(storePaths.state, 'qoder-retention.jsonl');
}

/** 读取晋升状态；缺失/损坏返回空结构 */
export function loadPromoteState() {
  try {
    const raw = JSON.parse(fs.readFileSync(promoteStatePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        lastScanAt: raw.lastScanAt || '',
        rejected: raw.rejected && typeof raw.rejected === 'object' ? raw.rejected : {},
        applied: raw.applied && typeof raw.applied === 'object' ? raw.applied : {},
      };
    }
  } catch {
    // 首次运行或损坏
  }
  return { lastScanAt: '', rejected: {}, applied: {} };
}

/** 保存晋升状态（withLock + 原子写） */
function savePromoteState(state) {
  withLock(promoteStatePath(), () => {
    ensureDir(storePaths.state);
    atomicWrite(promoteStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
  });
}

/**
 * promote scan 是否到期（daemon 兜底扫描轮消费，模式同 compactDue）。
 * @param {Object} config
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function promoteScanDue(config, nowMs = Date.now()) {
  const ccfg = config.core || {};
  if (ccfg.enabled === false) return false;
  const intervalMs = Number.isFinite(ccfg.scanIntervalMs) ? ccfg.scanIntervalMs : 7 * 24 * 60 * 60 * 1000;
  const last = Date.parse(loadPromoteState().lastScanAt || '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}

// ---------------------------------------------------------------------------
// 信号数据装载
// ---------------------------------------------------------------------------

/**
 * 解析留存快照 JSONL → 每个 hubId 的首见时间与被清次数。
 * @param {string} [file] 注入路径（测试用）
 * @returns {{ firstSeen: Map<string,string>, removedCount: Map<string,number>, snapshots: number }}
 */
export function loadRetentionSignals(file = retentionPath()) {
  const firstSeen = new Map();
  const removedCount = new Map();
  let snapshots = 0;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { firstSeen, removedCount, snapshots };
  }
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    let snap;
    try {
      snap = JSON.parse(line);
    } catch {
      continue;
    }
    snapshots += 1;
    for (const s of Object.values(snap.slugs || {})) {
      for (const id of s.hubIds || []) {
        if (!firstSeen.has(id)) firstSeen.set(id, snap.time);
      }
    }
    for (const id of snap.diff?.removed || []) {
      removedCount.set(id, (removedCount.get(id) || 0) + 1);
    }
  }
  return { firstSeen, removedCount, snapshots };
}

/**
 * 读取 eval 探针命中的来源页集合（sourcePage 文件名）。
 * @param {string} [file] 注入路径（测试用）
 * @returns {Set<string>}
 */
export function loadProbePages(file = path.join(storePaths.state, 'eval-probes.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set((raw.probes || []).map((p) => String(p.sourcePage || '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** 从 sources[] 快照路径提取 App 名集合（…/sources/<app>/<file>） */
function appsOfSources(sources) {
  const apps = new Set();
  for (const s of sources || []) {
    const m = String(s).match(/[/\\]sources[/\\]([^/\\]+)[/\\]/);
    if (m) apps.add(m[1]);
  }
  return apps;
}

// ---------------------------------------------------------------------------
// 打分（纯函数，测试可注入全部信号数据）
// ---------------------------------------------------------------------------

/**
 * 对单个 wiki 主题页计算晋升四信号与总分（每信号 1 分）。
 * @param {{ file: string, title: string, hubIds: string[], sources: string[], body: string }} meta
 * @param {{ retention: { firstSeen: Map, removedCount: Map }, probePages: Set<string> }} signals
 * @param {{ survivalDays?: number, now?: number }} [opts]
 * @returns {{ score: number, signals: { crossSource: boolean, survival: boolean, probe: boolean, decision: boolean } }}
 */
export function scorePage(meta, signals, opts = {}) {
  const survivalDays = Number.isFinite(opts.survivalDays) ? opts.survivalDays : 15;
  const now = opts.now ?? Date.now();
  const crossSource = appsOfSources(meta.sources).size >= 2;
  // 存活验证：页面全部 hubId 从未被清理，且最早首见时间距今 ≥ survivalDays；
  // 留存数据未覆盖任何 hubId 时视为未验证（false），不给分
  const seenTimes = meta.hubIds
    .map((id) => signals.retention.firstSeen.get(id))
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  const everRemoved = meta.hubIds.some((id) => (signals.retention.removedCount.get(id) || 0) > 0);
  const survival =
    seenTimes.length > 0 && !everRemoved && now - Math.min(...seenTimes) >= survivalDays * 24 * 60 * 60 * 1000;
  const probe = signals.probePages.has(path.basename(meta.file));
  const decision = DECISION_RE.test(meta.body) || DECISION_RE.test(meta.title);
  const detail = { crossSource, survival, probe, decision };
  return { score: Object.values(detail).filter(Boolean).length, signals: detail };
}

/**
 * 列出可参与晋升的 wiki 主题页（与 compact 同范围：wiki 顶层；core/ 子目录排除）。
 * @returns {{ file: string, rel: string, title: string, hubIds: string[], sources: string[],
 *   tags: string[], body: string }[]}
 */
export function listPromotablePages() {
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
    try {
      parsed = matter(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const fm = parsed.data || {};
    if (fm.deleted === true || fm.tier === 'core') continue;
    const rawIds = fm['hub-id'];
    const hubIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
    if (hubIds.length === 0) continue;
    const body = String(parsed.content || '').trim();
    const titleMatch = body.match(/^#\s+(.*)$/m);
    pages.push({
      file,
      rel: e.name,
      title: String(titleMatch ? titleMatch[1] : fm.title || path.basename(e.name, '.md')).trim(),
      hubIds,
      sources: Array.isArray(fm.sources) ? fm.sources.map(String) : [],
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      body,
    });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// 提名（scan / list / reject）
// ---------------------------------------------------------------------------

/** 启发式提名动作：画像类并入 user-profile，标题与既有 core 页相同则并入，否则新建 */
function heuristicDraft(meta, corePages) {
  if (/用户(画像|偏好|身份|信息)|沟通风格|交付偏好/.test(meta.title)) {
    return { action: 'profile', targetCorePage: corePaths.userProfile, category: 'user_info' };
  }
  const hit = corePages.find((c) => c.title === meta.title);
  if (hit) return { action: 'merge', targetCorePage: hit.file, category: hit.category };
  return { action: 'new', targetCorePage: '', category: DEFAULT_CORE_CATEGORY };
}

/** 容错解析 LLM 输出的 JSON（剥 code fence；失败返回 null） */
function parseLlmJson(text) {
  const t = String(text || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    return JSON.parse(m ? m[1] : t);
  } catch {
    return null;
  }
}

const SCAN_PROMPT = [
  '你是长期记忆晋升引擎的终审官。输入 JSON：coreTitles 是既有核心记忆标题清单，',
  'candidates 是一组候选 wiki 主题页（含 title/body 摘录/signals，已通过客观信号初筛）。',
  '核心层是「任何新会话都会加载的用户维度长期记忆」（容量稀缺，错晋会污染每次会话）。',
  '逐个候选终审并产出：',
  '- verdict：promote（长期有效且可反复复用：已拍板口径/用户偏好/稳定规范/长期坑）；',
  '  reject（不配进核心层：一次性任务产物、时效性数据/分析结果、过程叙述、与 coreTitles 明显重复）；',
  '  defer（证据不足，下轮再审）；',
  '- confidence：0-1，对 verdict 的把握（拿不准就给低分，宁缓勿错）；',
  '- reason：≤40 字的判定理由；',
  '- draftTitle：≤20 字的稳定事实标题（去掉日期/一次性任务措辞）；',
  '- draftBody：≤200 字的持久化表述，只保留长期有效的结论/口径/偏好，剔除过程叙述；',
  '- category：从 user_info/development_code_specification/development_practice_specification/',
  '  project_introduction/project_environment_configuration/common_pitfalls_experience 中选最贴切的一个；',
  '- action：new（独立事实页）/ profile（属于用户画像：身份、偏好、工作方式）。',
  '严格输出 JSON 数组：[{"sourcePage":"<原 rel>","verdict":"promote|reject|defer","confidence":0.0,"reason":"…",',
  '"action":"new|profile","category":"…","draftTitle":"…","draftBody":"…"}]，不要输出其他内容。',
].join('\n');

/**
 * 晋升扫描：打分 → 过滤（负样本/已晋升/低分）→（可选）LLM 精炼 → 写提名清单。
 * @param {{ config?: Object, client?: Object, maxCandidates?: number, now?: number,
 *   retention?: Object, probePages?: Set<string> }} [opts] client/retention/probePages 可注入（测试用）
 * @returns {Promise<{ ok: boolean, scanned: number, nominated: number, llm: string, file?: string, error?: string }>}
 */
export async function promoteScan(opts = {}) {
  const config = opts.config || loadConfig();
  const ccfg = config.core || {};
  if (ccfg.enabled === false) return { ok: false, scanned: 0, nominated: 0, llm: 'off', error: 'core.enabled=false' };
  const minScore = Number.isFinite(ccfg.minScore) ? ccfg.minScore : 3;
  const maxCandidates = opts.maxCandidates ?? 20;
  const now = opts.now ?? Date.now();

  const state = loadPromoteState();
  const retention = opts.retention || loadRetentionSignals();
  const probePages = opts.probePages || loadProbePages();
  const corePages = listCorePages().map(readCorePage).filter(Boolean);

  const pages = listPromotablePages();
  const candidates = [];
  for (const meta of pages) {
    const rejectedAt = Date.parse(state.rejected[meta.rel] || '');
    if (Number.isFinite(rejectedAt) && now - rejectedAt < REJECT_SUPPRESS_MS) continue;
    if (state.applied[meta.rel]) continue;
    const { score, signals } = scorePage(meta, { retention, probePages }, { survivalDays: ccfg.survivalDays, now });
    if (score < minScore) continue;
    candidates.push({ meta, score, signals });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, maxCandidates);

  // LLM 精炼（冷却期/不可用时降级启发式，零调用）
  let llmMode = 'skipped';
  let drafts = new Map();
  if (top.length > 0) {
    let client = opts.client;
    if (!client && llmCooldownRemaining(now).remainMs === 0) {
      try {
        client = buildRealClient(config);
      } catch {
        client = null; // 配置/Keychain 缺失：降级启发式
      }
    }
    if (client) {
      try {
        const payload = {
          coreTitles: corePages.map((p) => p.title),
          candidates: top.map((c) => ({
            sourcePage: c.meta.rel,
            title: c.meta.title,
            signals: c.signals,
            body: c.meta.body.slice(0, 1500),
          })),
        };
        const text = await client.chat(
          [
            { role: 'system', content: SCAN_PROMPT },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          { maxTokens: 16384 },
        );
        const arr = parseLlmJson(text);
        if (Array.isArray(arr)) {
          drafts = new Map(arr.filter((d) => d && d.sourcePage).map((d) => [String(d.sourcePage), d]));
          llmMode = 'refined';
        } else {
          llmMode = 'parse-failed';
        }
      } catch (err) {
        llmMode = `failed: ${err.message?.slice(0, 120)}`;
      }
    }
  }

  const nominations = top.map((c, i) => {
    const h = heuristicDraft(c.meta, corePages);
    const d = drafts.get(c.meta.rel);
    return {
      id: i + 1,
      sourcePage: c.meta.rel,
      title: c.meta.title,
      score: c.score,
      signals: c.signals,
      // LLM 终审三元组：启发式降级时统一 defer/0（无终审 = 无自动晋升资格）
      verdict: ['promote', 'reject', 'defer'].includes(d?.verdict) ? d.verdict : 'defer',
      confidence: Math.max(0, Math.min(1, Number(d?.confidence) || 0)),
      reason: String(d?.reason || '').slice(0, 80),
      action: d?.action === 'profile' || d?.action === 'new' ? d.action : h.action,
      targetCorePage: h.action === 'merge' || h.action === 'profile' ? h.targetCorePage : '',
      category: String(d?.category || h.category),
      draftTitle: String(d?.draftTitle || c.meta.title),
      draftBody: String(d?.draftBody || ''),
    };
  });

  ensureDir(storePaths.state);
  atomicWrite(
    nominationsPath(),
    `${JSON.stringify({ generatedAt: new Date(now).toISOString(), llm: llmMode, nominations }, null, 2)}\n`,
    { mode: FILE_MODE },
  );
  state.lastScanAt = new Date(now).toISOString();
  savePromoteState(state);
  return { ok: true, scanned: pages.length, nominated: nominations.length, llm: llmMode, file: nominationsPath() };
}

/** 读取提名清单；缺失/损坏返回空结构 */
export function loadNominations() {
  try {
    const raw = JSON.parse(fs.readFileSync(nominationsPath(), 'utf8'));
    if (raw && Array.isArray(raw.nominations)) return raw;
  } catch {
    // 无清单
  }
  return { generatedAt: '', llm: '', nominations: [] };
}

/**
 * 拒绝提名：登记负样本并从清单移除。
 * @param {{ ids: number[], now?: string }} opts
 * @returns {{ rejected: string[] }}
 */
export function promoteReject(opts) {
  const noms = loadNominations();
  const idSet = new Set(opts.ids || []);
  const state = loadPromoteState();
  const rejected = [];
  const kept = [];
  for (const n of noms.nominations) {
    if (idSet.has(n.id)) {
      state.rejected[n.sourcePage] = opts.now || new Date().toISOString();
      rejected.push(n.sourcePage);
    } else {
      kept.push(n);
    }
  }
  if (rejected.length > 0) {
    savePromoteState(state);
    atomicWrite(nominationsPath(), `${JSON.stringify({ ...noms, nominations: kept }, null, 2)}\n`, {
      mode: FILE_MODE,
    });
  }
  return { rejected };
}

// ---------------------------------------------------------------------------
// 晋升执行（apply / add）与降级（demote）
// ---------------------------------------------------------------------------

/** 去掉正文首个 H1（core 页写入时统一由 writeCorePage 渲染标题） */
function stripFirstH1(body) {
  const lines = String(body || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (idx !== -1) lines.splice(idx, 1);
  return lines.join('\n').trim();
}

/** 确定性并入：目标页尾追加「更新」小节（LLM 不可用时的兜底合并策略） */
function mergeBody(existingBody, addition, sourceRel, now) {
  const day = String(now).slice(0, 10);
  return `${stripFirstH1(existingBody)}\n\n## 更新（${day}，晋升自 ${sourceRel}）\n\n${addition}`.trim();
}

/**
 * 执行一条提名：容量校验 → 按 action 写 core 页 → 登记 applied。
 * @param {Object} nomination 提名对象（loadNominations 产出）
 * @param {{ maxEntries: number, now?: string }} opts
 * @returns {{ ok: boolean, file?: string, hubIds?: string[], error?: string }}
 */
export function applyNomination(nomination, opts) {
  const now = opts.now || new Date().toISOString();
  const srcFile = path.join(storePaths.wiki, nomination.sourcePage);
  let srcBody = nomination.draftBody?.trim();
  if (!srcBody) {
    try {
      srcBody = stripFirstH1(matter(fs.readFileSync(srcFile, 'utf8')).content);
    } catch {
      return { ok: false, error: `来源页不可读：${nomination.sourcePage}` };
    }
  }
  const title = nomination.draftTitle || nomination.title;

  if (nomination.action === 'profile') {
    const existing = fs.existsSync(corePaths.userProfile) ? readCorePage(corePaths.userProfile) : null;
    const body = existing ? mergeBody(existing.body, srcBody, nomination.sourcePage, now) : srcBody;
    const r = writeCorePage({
      file: corePaths.userProfile,
      title: existing?.title || '用户画像与工作偏好',
      body,
      category: 'user_info',
      promotedFrom: [nomination.sourcePage],
      now,
    });
    return { ok: true, file: r.file, hubIds: r.hubIds };
  }

  if (nomination.action === 'merge' && nomination.targetCorePage) {
    const existing = readCorePage(nomination.targetCorePage);
    if (!existing) return { ok: false, error: `并入目标不存在或非 core 页：${nomination.targetCorePage}` };
    const r = writeCorePage({
      file: existing.file,
      title: existing.title,
      body: mergeBody(existing.body, srcBody, nomination.sourcePage, now),
      category: existing.category,
      promotedFrom: [nomination.sourcePage],
      now,
    });
    return { ok: true, file: r.file, hubIds: r.hubIds };
  }

  // 新建独立事实页：容量硬约束（产品约束：防长期层膨胀成第二个 wiki）
  if (countCorePages() >= opts.maxEntries) {
    return {
      ok: false,
      error: `core 层已达容量上限（${opts.maxEntries}），先 hub promote demote 或并入既有页`,
    };
  }
  const r = writeCorePage({
    title,
    body: srcBody,
    category: nomination.category,
    promotedFrom: [nomination.sourcePage],
    now,
  });
  return { ok: true, file: r.file, hubIds: r.hubIds };
}

/**
 * 批量执行提名（hub promote apply）。
 * @param {{ ids?: number[], all?: boolean, config?: Object, now?: string }} opts
 * @returns {{ results: { id: number, sourcePage: string, ok: boolean, file?: string, error?: string }[] }}
 */
export function promoteApply(opts = {}) {
  const config = opts.config || loadConfig();
  const maxEntries = Number.isFinite(config.core?.maxEntries) ? config.core.maxEntries : 50;
  const noms = loadNominations();
  const idSet = opts.all ? null : new Set(opts.ids || []);
  const state = loadPromoteState();
  const results = [];
  const kept = [];
  for (const n of noms.nominations) {
    if (idSet && !idSet.has(n.id)) {
      kept.push(n);
      continue;
    }
    const r = applyNomination(n, { maxEntries, now: opts.now });
    results.push({ id: n.id, sourcePage: n.sourcePage, ok: r.ok, file: r.file, error: r.error });
    if (r.ok) {
      state.applied[n.sourcePage] = { corePage: path.relative(storePaths.wiki, r.file), appliedAt: opts.now || new Date().toISOString() };
    } else {
      kept.push(n); // 失败（如容量满）保留提名，处理后可重试
    }
  }
  if (results.some((r) => r.ok)) savePromoteState(state);
  atomicWrite(nominationsPath(), `${JSON.stringify({ ...noms, nominations: kept }, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  return { results };
}

/**
 * LLM 终审自动晋升（科学晋升机制的执行端，取代人工 apply 把关）。
 *
 * 双重门槛 = 客观信号初筛（scorePage ≥ minScore，scan 已完成）
 *          × LLM 语义终审（verdict=promote 且 confidence ≥ autoConfidence）。
 * 护栏：
 * - no LLM, no auto：提名清单非 LLM 精炼产出（冷却/解析失败/启发式降级）时绝不自动写 core；
 * - 每轮最多 maxAutoPromotePerScan 条（按 信号分×置信度 取最优，防一次灌爆稀缺容量）；
 * - verdict=reject 记 30 天负样本；defer/低置信度留清单下轮再审；
 * - 容量上限由 applyNomination 硬约束；自动晋升可随时 hub promote demote 撤销。
 * @param {{ config?: Object, now?: string }} [opts]
 * @returns {{ applied: { id: number, sourcePage: string, title: string, file?: string }[],
 *   rejected: string[], deferred: number, skipped?: string,
 *   failed: { sourcePage: string, error?: string }[] }}
 */
export function promoteAutoApply(opts = {}) {
  const config = opts.config || loadConfig();
  const ccfg = config.core || {};
  if (ccfg.enabled === false || ccfg.autoPromote === false) {
    return { applied: [], rejected: [], deferred: 0, failed: [], skipped: 'off' };
  }
  const noms = loadNominations();
  if (noms.llm !== 'refined') {
    // 无 LLM 终审产出：只留提名，不自动拍板
    return { applied: [], rejected: [], deferred: noms.nominations.length, failed: [], skipped: 'llm-unavailable' };
  }
  const minConf = Number.isFinite(ccfg.autoConfidence) ? ccfg.autoConfidence : 0.7;
  const maxPerScan = Number.isFinite(ccfg.maxAutoPromotePerScan) ? ccfg.maxAutoPromotePerScan : 3;

  // 1) reject → 负样本（30 天抑制）并移出清单
  const rejectIds = noms.nominations.filter((n) => n.verdict === 'reject').map((n) => n.id);
  const { rejected } = rejectIds.length > 0 ? promoteReject({ ids: rejectIds, now: opts.now }) : { rejected: [] };

  // 2) promote 且达置信门槛 → 按 分数×置信度 取前 N 条执行
  const fresh = loadNominations();
  const eligible = fresh.nominations
    .filter((n) => n.verdict === 'promote' && Number(n.confidence) >= minConf)
    .sort((a, b) => b.score * Number(b.confidence) - a.score * Number(a.confidence))
    .slice(0, maxPerScan);
  const byId = new Map(eligible.map((n) => [n.id, n]));
  const { results } = eligible.length > 0
    ? promoteApply({ ids: eligible.map((n) => n.id), config, now: opts.now })
    : { results: [] };
  const applied = results
    .filter((r) => r.ok)
    .map((r) => ({ id: r.id, sourcePage: r.sourcePage, title: byId.get(r.id)?.draftTitle || byId.get(r.id)?.title || r.sourcePage, file: r.file }));
  const failed = results.filter((r) => !r.ok).map((r) => ({ sourcePage: r.sourcePage, error: r.error }));
  if (applied.length > 0) rebuildMasterIndex();
  return { applied, rejected, deferred: loadNominations().nominations.length, failed };
}

/**
 * Phase 1 手动晋升：hub promote add <wiki页> [--to <core页>] [--category <c>]。
 * 无 LLM 的确定性搬运：--to 命中既有 core 页则并入，否则新建独立事实页。
 * @param {{ source: string, to?: string, category?: string, config?: Object, now?: string }} opts
 * @returns {{ ok: boolean, file?: string, hubIds?: string[], error?: string }}
 */
export function promoteAdd(opts) {
  const config = opts.config || loadConfig();
  const maxEntries = Number.isFinite(config.core?.maxEntries) ? config.core.maxEntries : 50;
  const srcAbs = path.isAbsolute(opts.source) ? opts.source : path.join(storePaths.wiki, opts.source);
  const sourceRel = path.relative(storePaths.wiki, srcAbs);
  if (sourceRel.startsWith('..') || isCorePage(srcAbs)) {
    return { ok: false, error: '来源必须是 wiki 主题页（core 页不能再次晋升）' };
  }
  let parsed;
  try {
    parsed = matter(fs.readFileSync(srcAbs, 'utf8'));
  } catch (err) {
    return { ok: false, error: `来源页不可读：${err.message}` };
  }
  const body = stripFirstH1(parsed.content);
  const titleMatch = String(parsed.content || '').match(/^#\s+(.*)$/m);
  const title = String(titleMatch ? titleMatch[1] : parsed.data?.title || path.basename(srcAbs, '.md')).trim();
  const nomination = {
    sourcePage: sourceRel,
    title,
    action: opts.to ? 'merge' : 'new',
    targetCorePage: opts.to
      ? path.isAbsolute(opts.to)
        ? opts.to
        : path.join(corePaths.root, opts.to.endsWith('.md') ? opts.to : `${opts.to}.md`)
      : '',
    category: opts.category || DEFAULT_CORE_CATEGORY,
    draftTitle: title,
    draftBody: body,
  };
  // --to user-profile 语义糖：并入用户画像固定单页
  // --to user / user-profile 语义糖：并入用户画像固定页（core/user.md）
  if (opts.to && ['user', 'user-profile'].includes(path.basename(nomination.targetCorePage, '.md'))) {
    nomination.action = 'profile';
  }
  const r = applyNomination(nomination, { maxEntries, now: opts.now });
  if (r.ok) {
    const state = loadPromoteState();
    state.applied[sourceRel] = {
      corePage: path.relative(storePaths.wiki, r.file),
      appliedAt: opts.now || new Date().toISOString(),
    };
    savePromoteState(state);
  }
  return r;
}

/**
 * 向 pending-writeback.json 登记 App 侧待清理 hubId（契约字段 removals，
 * 与 distill.appendPendingWriteback 同锁互斥；pages 原样保留）。
 * @param {string[]} hubIds
 */
export function registerPendingRemovals(hubIds) {
  if (!Array.isArray(hubIds) || hubIds.length === 0) return;
  const file = pendingWritebackPath();
  withLock(file, () => {
    const existing = loadPendingWriteback() || { pages: [], removals: [] };
    const removals = [...new Set([...(existing.removals || []), ...hubIds.map(String)])];
    atomicWrite(
      file,
      `${JSON.stringify({ updatedAt: new Date().toISOString(), pages: existing.pages || [], removals }, null, 2)}\n`,
      { mode: FILE_MODE },
    );
  });
}

/**
 * 降级：core 页移回 wiki 顶层（tier、promoted-from、supersedes 字段移除，hub-id 保留），
 * 原 hubId 登记 pending removals——App 侧按 core category 渲染的旧文件先清理，
 * 页面此后作为普通主题页随下轮全量写回重建。
 * @param {{ page: string, now?: string }} opts page 为 core 页 slug 或路径
 * @returns {{ ok: boolean, file?: string, error?: string }}
 */
export function promoteDemote(opts) {
  let target = opts.page;
  if (!path.isAbsolute(target)) {
    const bySlug = listCorePages().find((f) => path.basename(f, '.md') === target.replace(/\.md$/, ''));
    target = bySlug || path.join(corePaths.root, target.endsWith('.md') ? target : `${target}.md`);
  }
  const page = readCorePage(target);
  if (!page) return { ok: false, error: `不是有效的 core 页：${opts.page}` };

  let dest = path.join(storePaths.wiki, `${page.slug}.md`);
  let n = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(storePaths.wiki, `${page.slug}-${n}.md`);
    n += 1;
  }
  const fm = {
    'hub-id': page.hubIds,
    'last-updated': opts.now || new Date().toISOString(),
  };
  atomicWrite(dest, matter.stringify({ content: `# ${page.title}\n\n${stripFirstH1(page.body)}\n` }, fm), {
    mode: FILE_MODE,
  });
  fs.rmSync(page.file);
  registerPendingRemovals(page.hubIds);
  return { ok: true, file: dest };
}

/**
 * 核心层状态一览（hub core status）：容量水位 + 每页最近一次写回结果。
 * @param {{ config?: Object }} [opts]
 * @returns {{ capacity: { used: number, max: number }, pages: Object[] }}
 */
export function coreStatus(opts = {}) {
  const config = opts.config || loadConfig();
  const maxEntries = Number.isFinite(config.core?.maxEntries) ? config.core.maxEntries : 50;
  const log = loadWritebackLog();
  const lastByHubId = new Map();
  for (const rec of log) {
    if (rec.hubId && rec.hubId !== '*') lastByHubId.set(rec.hubId, rec);
  }
  const pages = listCorePages()
    .map(readCorePage)
    .filter(Boolean)
    .map((p) => {
      const recent = p.hubIds.map((id) => lastByHubId.get(id)).filter(Boolean);
      return {
        slug: p.slug,
        title: p.title,
        category: p.category,
        hubIds: p.hubIds,
        promotedFrom: p.promotedFrom,
        lastUpdated: p.lastUpdated,
        lastWriteback: recent.length > 0 ? recent.map((r) => `${r.app}:${r.result}`).join(' | ') : '（尚无写回记录）',
      };
    });
  return { capacity: { used: pages.length, max: maxEntries }, pages };
}
