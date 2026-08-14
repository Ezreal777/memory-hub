/**
 * distill.js —— LLM 整理引擎（hub distill）。
 *
 * 职责：把 hub/sources/ 中尚未整理的原始快照，经 OpenAI 兼容 LLM 归并为
 * 主题 wiki 页（语义去重、冲突时时间戳新者胜且冲突页保留双方标注），
 * 落到 hub/wiki/<topic-slug>.md 并重建 _index/master-index.md（index-builder）。
 *
 * 安全与健壮性：
 * - AK 经 keys.resolveApiKey() 从 Keychain 解析，绝不落盘、绝不打印明文；
 * - 写入 wiki 前正则脱敏（sk- 开头密钥、AK 模式）；
 * - state/distill-state.json 记录已处理的 hubId，重跑只处理增量（写入走 withLock + 原子写）；
 * - H3：批内内容 hash 物理去重 + 源快照名归一化同名合并 + 落盘前按归一化 slug/标题
 *   相似度优先归并进既有页面，杜绝逐字重复页与同主题多 slug；
 * - H4：含测试标记（HUB-TEST/冒烟 等，TEST_MARKERS 可配置）的快照直接标 processed 跳过，
 *   阻断测试产物泄漏进 wiki 的自我繁殖回路；
 * - H5：快照 frontmatter 解析失败先净化重试（剥离 Markdown 加粗等语法），仍失败
 *   移入 sources/_quarantine/<app>/ 隔离并记入 distill-state，日志只记一次，不再重扫；
 * - M2：按批次签名维护失败计数，解析失败 ≥3 次的毒批次记入隔离清单告警一次，不再重放；
 * - M3：LLM 调用失败单批 continue 不再整轮 break；请求体超限（TooLarge）对半拆分重试；
 * - M5：批次打包在 64KB/40 条基础上增加 ≤4MB 请求体硬约束预切分；
 * - M1：单页超过 24KB 时下次更新触发 LLM 整页重写归并，而非无限追加「## 更新」区；
 * - 页面质量守卫：合并结果不允许以孤立标题结尾；<400B 薄页并入相关主题页；
 * - 每轮成功后写 state/pending-writeback.json（增量写回契约，消费方为 writeback 侧）；
 * - 支持 dryRun（只打印将产生的页面，不落盘不改状态）与 maxPages 限额；
 * - LLM 客户端可注入（opts.client），测试全程 mock 不打真实网络。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { FILE_MODE, paths } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import {
  storePaths,
  ensureHubStore,
  loadTombstones,
  removeTombstones,
  updateTombstones,
  listSnapshotMeta,
  ECHO_MARKER_RE,
} from './hub-store.js';
import { slugify, sha256Of } from './adapters/base.js';
import { loadConfig, DEFAULT_TEST_MARKERS } from './config.js';
import { resolveApiKey } from './keys.js';
import { createLlmClient, LLM_CONFIG_HINT } from './llmClient.js';
import { appendLogEntry } from './util/log.js';
import { withLock } from './util/lock.js';
import { rebuildMasterIndex } from './index-builder.js';

/** distill 对账状态文件：hub/state/distill-state.json */
export function distillStatePath() {
  return path.join(storePaths.state, 'distill-state.json');
}

/** distill 日志文件路径 */
function distillLogPath() {
  return path.join(paths.logs, 'distill.log');
}

// ---------------------------------------------------------------------------
// LLM 限流冷却（供 distill / compact / eval 共用）
// ---------------------------------------------------------------------------

/** 冷却状态文件：state/llm-cooldown.json {"until":"<ISO>","reason":"..."} */
export function llmCooldownPath() {
  return path.join(storePaths.state, 'llm-cooldown.json');
}

/** 小时级限流的缺省冷却时长（60 分钟） */
export const LLM_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * 查询限流冷却剩余毫秒（未在冷却中返回 0）。
 * 背景：idealab 免费 AK 的失败调用照样计入日额度（200 次/天），撞限流后
 * 继续发请求等于白烧额度（实测一上午烧光 200 次），故撞墙一次即整轮刹车。
 * @param {number} [nowMs]
 * @returns {{ remainMs: number, until: string, reason: string }}
 */
export function llmCooldownRemaining(nowMs = Date.now()) {
  try {
    const raw = JSON.parse(fs.readFileSync(llmCooldownPath(), 'utf8'));
    const until = Date.parse(raw.until || '');
    if (Number.isFinite(until) && until > nowMs) {
      return { remainMs: until - nowMs, until: raw.until, reason: String(raw.reason || '') };
    }
  } catch {
    // 无冷却记录
  }
  return { remainMs: 0, until: '', reason: '' };
}

/**
 * 启动限流冷却：按错误文案定时长——日额度耗尽（“今天/请明天再来”）冷却到
 * 本地次日凌晨；小时级限流冷却 60 分钟。幂等：已有更晚的冷却不回退。
 * @param {string} errMessage 限流错误文案
 * @param {number} [nowMs]
 * @returns {string} 生效的冷却截止 ISO 时间
 */
export function startLlmCooldown(errMessage, nowMs = Date.now()) {
  let untilMs;
  if (/今天|请明天再来/.test(String(errMessage || ''))) {
    const d = new Date(nowMs);
    d.setHours(24, 0, 0, 0); // 本地次日凌晨（日额度重置点）
    untilMs = d.getTime();
  } else {
    untilMs = nowMs + LLM_COOLDOWN_MS;
  }
  const existing = llmCooldownRemaining(nowMs);
  if (existing.remainMs > 0 && Date.parse(existing.until) >= untilMs) {
    return existing.until; // 已有更晚冷却，不回退
  }
  const until = new Date(untilMs).toISOString();
  withLock(llmCooldownPath(), () => {
    atomicWrite(
      llmCooldownPath(),
      `${JSON.stringify({ until, reason: String(errMessage || '').slice(0, 200) }, null, 2)}\n`,
      { mode: FILE_MODE },
    );
  });
  appendLogEntry(
    distillLogPath(),
    `${new Date(nowMs).toISOString()}\twarn\tLLM 限流，进入冷却至 ${until}（期间所有 LLM 环节零调用直接跳过，防白烧额度）`,
  );
  return until;
}

/**
 * 读取 distill 状态。除已处理 hubId 外，还包含：
 * - quarantined：frontmatter 不可解析被隔离的快照清单（H5）；
 * - batchFailures：批次签名 → 解析失败计数（M2）；
 * - poisonedBatches：失败 ≥3 次被隔离、不再重放的毒批次（M2）。
 * @returns {{ version: number, processed: Object, quarantined: Object,
 *   batchFailures: Object, poisonedBatches: Object }}
 */
export function loadDistillState() {
  try {
    const raw = JSON.parse(fs.readFileSync(distillStatePath(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.processed) {
      return {
        version: raw.version || 1,
        processed: raw.processed,
        quarantined: raw.quarantined || {},
        batchFailures: raw.batchFailures || {},
        poisonedBatches: raw.poisonedBatches || {},
      };
    }
  } catch {
    // 首次运行或文件损坏：空状态
  }
  return { version: 1, processed: {}, quarantined: {}, batchFailures: {}, poisonedBatches: {} };
}

/**
 * 保存 distill 状态（M4：与 hash-state/inflight 同级保护——withLock 跨进程互斥 + tmp+rename 原子写，600 权限）。
 * @param {Object} state loadDistillState 结构
 */
export function saveDistillState(state) {
  withLock(distillStatePath(), () => {
    atomicWrite(distillStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
  });
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
 * 从 LLM 回复中稳健地抽取 JSON（容忍代码围栏、前后缀文字与尾部截断）。
 * @param {string} text LLM 原始回复
 * @returns {Object|Object[]} 解析结果
 * @throws {Error} 找不到/无法解析 JSON 时抛出
 */
export function extractJson(text) {
  let t = String(text ?? '').trim();
  if (!t) throw new Error('LLM 回复为空');
  // 先直接 parse：合法 JSON 的正文字符串里可能含 ``` 围栏字符，不能先做围栏抽取以免腰斩完整 JSON
  try {
    return JSON.parse(t);
  } catch {
    // 继续兜底抽取
  }
  // 围栏剥离仅限回复以 ``` 开头的形态（模型把 JSON 包在代码块里）
  if (t.startsWith('```')) {
    const fence = t.match(/^```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try {
      return JSON.parse(t);
    } catch {
      // 继续兜底抽取
    }
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
  try {
    return JSON.parse(candidate.slice(0, end + 1));
  } catch {
    // 最后兜底：输出被 max_tokens 截断时按括号栈修复，保留到最后一个完整对象
  }
  return repairTruncatedJson(candidate);
}

/**
 * 截断 JSON 修复：从末尾逐个 '}' 向前截断，扫描前缀的括号栈补全未闭合的 ]/}，
 * 能解析即返回（效果：丢弃被截断的末尾半个对象，保留之前的完整内容）。
 * 最多回退 50 次，避免在非 JSON 垃圾上花费 O(n²)。
 * @param {string} candidate 以 [ 或 { 开头的疑似 JSON 文本
 * @returns {Object|Object[]}
 * @throws {Error} 无法修复时抛出
 */
function repairTruncatedJson(candidate) {
  let cut = candidate.length;
  for (let i = 0; i < 50; i += 1) {
    const pos = candidate.lastIndexOf('}', cut - 1);
    if (pos <= 0) break;
    const prefix = candidate.slice(0, pos + 1);
    const closers = missingClosers(prefix);
    if (closers !== null) {
      try {
        return JSON.parse(prefix + closers);
      } catch {
        // 继续向前回退
      }
    }
    cut = pos;
  }
  throw new Error('LLM 回复中的 JSON 不完整且无法修复');
}

/**
 * 扫描 JSON 前缀，返回需要补的右括号序列（处理字符串/转义）；前缀止于字符串内部时返回 null。
 * @param {string} prefix JSON 前缀
 * @returns {string|null}
 */
function missingClosers(prefix) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of prefix) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) return null;
  return stack
    .reverse()
    .map((ch) => (ch === '{' ? '}' : ']'))
    .join('');
}

// ---------------------------------------------------------------------------
// 快照扫描、frontmatter 容错与隔离（H5）
// ---------------------------------------------------------------------------

/** 隔离区目录：sources/_quarantine/<app>/（保留相对路径），扫描一律跳过 */
export function quarantineDir() {
  return path.join(storePaths.sources, '_quarantine');
}

/**
 * 递归收集 sources/<app>/*.md 快照文件（跳过 _quarantine 隔离区与隐藏目录）。
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
    // H5：_quarantine 隔离区与隐藏目录不参与扫描
    if (a.name.startsWith('_') || a.name.startsWith('.')) continue;
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
 * H5：frontmatter 净化——对 scalar 值行剥离 `*`/`**`/`_`/`` ` `` 等 Markdown 语法并转
 * JSON 引号字符串（合法 YAML 标量），修复 wukong legacy 快照 `title: **xxx**`
 * 被 YAML 按 alias 解析报 "unidentified alias" 的问题。
 * @param {string} content 快照全文
 * @returns {string|null} 净化后的全文；无 frontmatter 块或无需净化时返回 null
 */
export function sanitizeFrontmatterMarkdown(content) {
  const m = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const block = m[1];
  const fixed = block
    .split(/\r?\n/)
    .map((line) => {
      const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!kv) return line;
      const [, key, rawVal] = kv;
      // 只处理以 Markdown 语法字符开头的裸标量（YAML 会误当锚点/别名/引用等）
      if (!/^[*_`]/.test(rawVal)) return line;
      const stripped = rawVal.replace(/^[*_`]+/, '').replace(/[*_`]+$/, '').trim();
      return `${key}: ${JSON.stringify(stripped)}`;
    })
    .join('\n');
  if (fixed === block) return null;
  return `${content.slice(0, m.index)}---\n${fixed}\n---${content.slice(m.index + m[0].length)}`;
}

/**
 * H5：把无法解析的快照移入 sources/_quarantine/<app>/（保留相对路径），
 * 记入 state.quarantined 并写一次 error 日志（文件移走后不再被重扫，绝不刷屏）。
 * @param {string} file 快照绝对路径
 * @param {Object} state distill 状态（quarantined 清单挂在这里）
 * @param {Error} err 解析错误
 * @returns {boolean} 是否隔离成功
 */
function quarantineSnapshot(file, state, err) {
  const rel = path.relative(storePaths.sources, file);
  const dest = path.join(quarantineDir(), rel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
  } catch (moveErr) {
    appendLogEntry(
      distillLogPath(),
      `${new Date().toISOString()}\twarn\t快照隔离失败（保留原位下轮重试）: ${rel} (${moveErr.message})`,
    );
    return false;
  }
  state.quarantined[rel] = { at: new Date().toISOString(), error: err.message };
  appendLogEntry(
    distillLogPath(),
    `${new Date().toISOString()}\terror\t快照 frontmatter 不可解析（净化重试仍失败），已隔离至 _quarantine: ${rel} (${err.message})`,
  );
  return true;
}

/**
 * 读取单个快照的元数据与正文（frontmatter 含 hubId/app/title/ingestedAt 等）。
 * H5：解析失败先做 Markdown 净化重试；仍失败且 ctx.quarantine 开启时物理隔离。
 * @param {string} file 快照路径
 * @param {{ state?: Object, quarantine?: boolean, quarantinedNow?: string[] }} [ctx]
 * @returns {Object|null} { file, hubId, app, title, ingestedAt, body }
 */
function readSnapshot(file, ctx = {}) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed = null;
  let parseErr = null;
  try {
    parsed = matter(content);
  } catch (err) {
    parseErr = err;
  }
  if (!parsed) {
    // 净化重试：剥离 scalar 值上的 Markdown 语法再解析（wukong legacy `title: **xxx**`）
    const sanitized = sanitizeFrontmatterMarkdown(content);
    if (sanitized !== null) {
      try {
        parsed = matter(sanitized);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed) {
    if (ctx.quarantine && ctx.state) {
      if (quarantineSnapshot(file, ctx.state, parseErr) && ctx.quarantinedNow) {
        ctx.quarantinedNow.push(file);
      }
    } else {
      appendLogEntry(
        distillLogPath(),
        `${new Date().toISOString()}\twarn\t快照 frontmatter 解析失败，跳过: ${file} (${parseErr.message})`,
      );
    }
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
    // 原 App frontmatter 的 JSON 字符串（摄取时存入），供回声兜底判定等使用
    rawFrontmatter: String(parsed.data?.frontmatter || ''),
    body: lines.join('\n').trim(),
  };
}

/**
 * 列出尚未整理过的原始快照（distill-state 未记录的 hubId）。
 * @param {{ processed: Object }} [state] 缺省现读
 * @param {{ quarantine?: boolean }} [opts] quarantine=true 时对不可解析快照做物理隔离
 *   （仅 distill 主流程开启；隔离发生时状态由本函数落盘）
 * @returns {Object[]} 快照元数据数组
 */
export function listUnprocessedSnapshots(state, opts = {}) {
  const st = state || loadDistillState();
  const ctx = { state: st, quarantine: Boolean(opts.quarantine), quarantinedNow: [] };
  const out = [];
  for (const file of listSnapshotFiles()) {
    const snap = readSnapshot(file, ctx);
    if (!snap) continue;
    if (st.processed[snap.hubId]) continue;
    out.push(snap);
  }
  if (ctx.quarantinedNow.length > 0) saveDistillState(st);
  return out;
}

// ---------------------------------------------------------------------------
// 测试标记过滤（H4）与批内去重归并（H3）
// ---------------------------------------------------------------------------

/**
 * 测试产物标记清单（缺省值）：正文或标题命中任一标记的快照不进入蒸馏，
 * 直接标 processed（阻断「测试快照 → wiki → 写回 → 再摄取」的自我繁殖污染回路）。
 * SHOULD-5：定义迁至 config.js（DEFAULT_TEST_MARKERS，避免循环依赖），
 * 运行时以 config.distill.testMarkers 为准；此处 re-export 保持既有导出兼容。
 */
export const TEST_MARKERS = DEFAULT_TEST_MARKERS;

/**
 * 回声兜底判定（与 hub-store.isEchoEntry 同口径，作用于已落盘快照）：
 * 采集层护栏上线前已漏进 sources 的 hub 自写渲染产物，蒸馏前识别并标
 * processed（skipped:'echo'），不烧 token 不进 wiki，阻断回声循环的存量尾巴。
 * @param {Object} snap readSnapshot 产物（含 body/rawFrontmatter）
 * @returns {boolean}
 */
export function hasEchoMarker(snap) {
  if (ECHO_MARKER_RE.test(String(snap?.body || ''))) return true;
  const rawFm = String(snap?.rawFrontmatter || '');
  if (/"chatId":\s*"hub-\d{14}-/.test(rawFm)) return true;
  if (/"source":\s*"memory-hub"/.test(rawFm)) return true;
  return false;
}

/**
 * 判断快照是否携带测试标记。
 * @param {{ title: string, body: string }} snap 快照
 * @param {string[]} [markers] 标记清单，缺省 TEST_MARKERS
 * @returns {boolean}
 */
export function hasTestMarker(snap, markers = TEST_MARKERS) {
  const hay = `${snap.title}\n${snap.body}`;
  return markers.some((m) => m && hay.includes(m));
}

/**
 * 源快照名归一化：剥离摄取时同名冲突追加的 `-N` 后缀（如 foo-1.md → foo）。
 * @param {string} file 快照路径
 * @returns {string}
 */
export function normalizeSnapshotName(file) {
  return path.basename(file, '.md').replace(/-\d+$/, '');
}

/**
 * H3：批内物理去重与同名合并。
 * - 内容 hash 完全一致的快照只保留一份（代表取 ingestedAt 最新者）；
 * - 同 app 下源快照名归一化后同名的快照合并为一个逻辑快照（不同正文拼接，内容不丢）；
 * - 重复者的 hubId 挂到代表快照名下，代表所在页落盘时一并标 processed。
 * @param {Object[]} snapshots listUnprocessedSnapshots 的结果
 * @returns {{ kept: Object[], members: Map<string, string[]> }}
 *   kept 为去重后的快照；members[repHubId] = 被合并进该代表的重复 hubId 列表
 */
export function dedupeSnapshots(snapshots) {
  const sorted = [...snapshots].sort((a, b) =>
    String(b.ingestedAt).localeCompare(String(a.ingestedAt)),
  );
  const byHash = new Map();
  const byName = new Map();
  const kept = [];
  const members = new Map();
  for (const s of sorted) {
    const hash = sha256Of(String(s.body || ''));
    const nameKey = `${s.app}\u0000${normalizeSnapshotName(s.file)}`;
    const rep = byHash.get(hash) || byName.get(nameKey);
    if (rep) {
      members.get(rep.hubId).push(s.hubId);
      // 同名但内容不同：正文并入代表快照（新在前），内容绝不丢
      if (!byHash.has(hash)) {
        rep.body = `${rep.body}\n\n---\n\n${s.body}`;
        byHash.set(hash, rep);
      }
      if (!byName.has(nameKey)) byName.set(nameKey, rep);
      continue;
    }
    byHash.set(hash, s);
    byName.set(nameKey, s);
    members.set(s.hubId, []);
    kept.push(s);
  }
  return { kept, members };
}

// ---------------------------------------------------------------------------
// 既有页面相似查找（H3：创建新页前优先归并进既有页）
// ---------------------------------------------------------------------------

/** slug 分词时忽略的英文虚词（避免 of/on 等差异把同主题拆成两页） */
const SLUG_STOPWORDS = new Set(['of', 'on', 'the', 'a', 'an', 'and', 'for', 'with', 'to', 'in', 'at', 'by', 'vs']);

/**
 * slug 分词：小写、剥离 `-N` 冲突后缀、去虚词。
 * @param {string} slug
 * @returns {Set<string>}
 */
function slugTokens(slug) {
  return new Set(
    String(slug)
      .toLowerCase()
      .replace(/-\d+$/, '')
      .split('-')
      .filter((t) => t && !SLUG_STOPWORDS.has(t)),
  );
}

/**
 * 判定两个 slug 是否指向同一主题：去虚词后词集相等，或一方（≥2 个实词）被另一方完全包含
 * （如 impact-on-conclusions ⊂ impact-of-analysis-scope-on-conclusions）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function slugsSimilar(a, b) {
  const ta = slugTokens(a);
  const tb = slugTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) {
    if (!big.has(t)) return false;
  }
  if (small.size === big.size) return true; // 词集相等
  return small.size >= 2; // 真子集需 ≥2 个实词，防单词误归并
}

/**
 * 在 wiki/ 中查找与给定 slug/标题相似的既有页面（H3：优先 update 既有页而非新建 slug）。
 * @param {string} slug 新页 slug
 * @param {string} [title] 新页标题（与既有页 H1 逐字相等也视为同页）
 * @returns {string|null} 命中的既有页 slug；无命中返回 null
 */
export function findSimilarPageSlug(slug, title) {
  let entries;
  try {
    entries = fs.readdirSync(storePaths.wiki, { withFileTypes: true });
  } catch {
    return null;
  }
  const wantTitle = String(title || '').trim();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'README.md' || e.name.startsWith('.')) continue;
    const existing = e.name.slice(0, -3);
    if (existing === slug) return existing;
    if (slugsSimilar(existing, slug)) return existing;
    if (wantTitle) {
      try {
        const raw = fs.readFileSync(path.join(storePaths.wiki, e.name), 'utf8');
        const m = raw.match(/^#\s+(.*)$/m);
        if (m && m[1].trim() === wantTitle) return existing;
      } catch {
        // 单页不可读不影响查找
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 批次切分（含 M5 字节预算）与批次签名（M2）
// ---------------------------------------------------------------------------

/** 单批次载荷体积上限（估算字节）：限制单次请求体积与模型耗时 */
export const MAX_BATCH_BYTES = 64 * 1024;

/** 单批次快照条数上限 */
export const MAX_BATCH_SNAPSHOTS = 40;

/** 单次 distill 运行缺省最多处理的批次数（控制单轮耗时与 LLM 调用量，剩余下轮继续） */
export const DEFAULT_MAX_BATCHES = 10;

/** M5：单次请求体硬上限（网关 6MB 拒绝线以下留足余量），预切分 + 发送前双重校验 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** M2：同一批次签名解析失败达到该次数即隔离（不再重放） */
export const MAX_BATCH_FAILURES = 3;

/**
 * 把待整理快照切成若干批次（按体积与条数双限额 + M5 请求体预算硬约束）。
 * 体积用截断后正文的 UTF-8 字节数 + 元数据开销估算。
 * @param {Object[]} snapshots listUnprocessedSnapshots 的结果
 * @param {{ maxBytes?: number, maxCount?: number, maxRequestBytes?: number }} [opts]
 * @returns {Object[][]} 批次数组（每批至少 1 条）
 */
export function chunkSnapshots(snapshots, opts = {}) {
  const maxBytes = Math.min(
    opts.maxBytes || MAX_BATCH_BYTES,
    opts.maxRequestBytes || MAX_REQUEST_BYTES,
  );
  const maxCount = opts.maxCount || MAX_BATCH_SNAPSHOTS;
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const s of snapshots) {
    const size =
      Buffer.byteLength(String(s.body || '').slice(0, 4000), 'utf8') +
      Buffer.byteLength(String(s.title || ''), 'utf8') +
      120;
    if (batch.length > 0 && (bytes + size > maxBytes || batch.length >= maxCount)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(s);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * M2：批次签名——由批内 hubId 排序拼接后取 SHA-256（与顺序无关、跨轮稳定）。
 * @param {Object[]} batch
 * @returns {string}
 */
export function batchSignature(batch) {
  return sha256Of(batch.map((s) => s.hubId).sort().join('\n'));
}

/** 批次对半拆分（TooLarge/预算超限时使用；单条批次无法再拆） */
function splitBatch(batch) {
  const mid = Math.ceil(batch.length / 2);
  return [batch.slice(0, mid), batch.slice(mid)];
}

/** 估算一次请求的报文体积（消息 JSON 的 UTF-8 字节数） */
function requestBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

// ---------------------------------------------------------------------------
// prompt、消息构建与输出规范化
// ---------------------------------------------------------------------------

/** wiki 页 category 取值枚举（qoder 分类依赖该字段） */
export const CATEGORY_ENUM = [
  'project_introduction',
  'project_tech_stack',
  'project_build_configuration',
  'project_environment_configuration',
  'development_code_specification',
  'development_practice_specification',
  'task_summary_experience',
  'common_pitfalls_experience',
  'user_info',
];

/** category 缺省值 */
export const DEFAULT_CATEGORY = 'project_introduction';

/** 内置整理 prompt（系统段）：归并主题、语义去重、冲突处理规则与输出 schema */
export const DISTILL_SYSTEM_PROMPT = [
  '你是记忆整理引擎。输入是多个 AI 应用（claude/codex/qoder/qoderwork/wukong）采集的原始记忆快照，',
  'JSON 数组，字段：hubId/app/title/ingestedAt/content。请把快照归并为若干主题 wiki 页：',
  '1. 语义相近的快照归入同一主题页，跨 app 语义去重；',
  '2. 内容冲突时以 ingestedAt 时间戳新者为准，但必须在冲突页正文中同时保留双方说法，',
  '   并用「⚠️ 冲突」标注来源 app 与时间；',
  '3. 每页给出 slug（一律英文小写 kebab-case，仅 a-z0-9-，禁止拼音与非 ASCII）、',
  '   title（统一用中文）、tags（字符串数组）、category、',
  '   hubIds（本页归并的全部快照 hubId，必须来自输入，不得编造）；',
  `4. category 从以下枚举中选一个（不确定时用 ${DEFAULT_CATEGORY}）：${CATEGORY_ENUM.join('、')}；`,
  '5. content 为 markdown 正文：提炼合并、保留关键事实与数字，不要编造，不要输出任何密钥；',
  '   内容太少（不足 400 字节）不要单独立页，并入语义最相近的主题页；',
  '   正文不得以没有内容的孤立标题结尾；',
  '6. 只输出 JSON，不要任何其他文字：',
  '{"pages":[{"slug":"...","title":"...","tags":["..."],"category":"...","hubIds":["..."],"content":"..."}]}',
].join('\n');

/** M1：超长页整页重写 prompt（追加合并改为归并重写时使用） */
export const REWRITE_SYSTEM_PROMPT = [
  '你是 wiki 页面重写引擎。输入 JSON：{title, existing, incoming}，existing 是既有页面正文',
  '（可能含多个「## 更新（时间）」历史追加区），incoming 是本次新增内容。',
  '请把两者整体归并重写为一页：语义去重、吸收全部「## 更新」历史区、按主题重新组织结构，',
  '保留关键事实与数字，不要编造，不要输出任何密钥；title 统一用中文；',
  '正文不得以没有内容的孤立标题结尾。',
  '只输出 JSON，不要任何其他文字：{"title":"...","content":"..."}（content 不含 # 一级标题行）。',
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
 * 规范化 LLM 返回的页面数组（过滤非法项、slug 安全化、category 校验回退）。
 * @param {Object|Object[]} json extractJson 的结果
 * @returns {{ slug: string, title: string, tags: string[], category: string,
 *   hubIds: string[], content: string }[]}
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
      // category 不在枚举内一律回退缺省值（qoder 分类依赖合法取值）
      category: CATEGORY_ENUM.includes(p.category) ? p.category : DEFAULT_CATEGORY,
      hubIds: Array.isArray(p.hubIds) ? p.hubIds.map(String) : [],
      content,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 页面质量守卫（孤立标题裁剪、薄页并入）
// ---------------------------------------------------------------------------

/** 独立薄页阈值：正文小于该字节数的新页并入相关主题页，不单独立页 */
export const MIN_PAGE_BYTES = 400;

/** M1：单页超过该字节数时，下次更新触发 LLM 整页重写归并而非追加「## 更新」区 */
export const MAX_PAGE_REWRITE_BYTES = 24 * 1024;

/**
 * 质量守卫：裁掉正文结尾的孤立标题（其后无任何内容的 `#`~`######` 行）。
 * @param {string} body 页面正文
 * @returns {string}
 */
export function trimTrailingOrphanHeadings(body) {
  const lines = String(body).replace(/\s+$/, '').split('\n');
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (last === '') {
      lines.pop();
      continue;
    }
    if (/^#{1,6}\s+\S/.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').replace(/\s+$/, '');
}

/**
 * 质量守卫：把批内 <MIN_PAGE_BYTES 的独立薄页并入同批体量最大的主题页
 * （hubIds/tags/sources 一并归并）。既有归属页可更新的薄页不动（走 update 流程）；
 * 批内没有可承接的非薄页时保持原样（宁可薄页也不丢内容）。
 * @param {Object[]} pages normalizePages 产物（已过滤、已挂 sources）
 * @returns {Object[]}
 */
export function consolidateThinPages(pages) {
  const sizeOf = (p) => Buffer.byteLength(String(p.content || ''), 'utf8');
  const hosts = pages.filter((p) => sizeOf(p) >= MIN_PAGE_BYTES);
  if (hosts.length === 0) return pages;
  const out = [];
  for (const p of pages) {
    if (sizeOf(p) >= MIN_PAGE_BYTES) {
      out.push(p);
      continue;
    }
    // 已有既有页可归属（同 slug 或相似页存在）→ 交给 update 流程并入既有主题页
    if (fs.existsSync(path.join(storePaths.wiki, `${p.slug}.md`)) || findSimilarPageSlug(p.slug, p.title)) {
      out.push(p);
      continue;
    }
    const host = hosts.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b));
    host.content = `${host.content}\n\n## ${p.title}\n\n${p.content}`;
    host.hubIds = [...new Set([...host.hubIds, ...p.hubIds])];
    host.tags = [...new Set([...host.tags, ...p.tags])];
    host.sources = [...new Set([...(host.sources || []), ...(p.sources || [])])];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 页面合并与重写
// ---------------------------------------------------------------------------

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
  // distill 归并产出量大、生成耗时长，超时放宽到 5 分钟（配合小批次使用）
  return createLlmClient({ baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey, timeoutMs: 300000 });
}

/** 容错解析旧页：frontmatter 损坏时整体当正文保留，内容绝不丢 */
function parsePageSafe(oldContent) {
  try {
    const parsed = matter(oldContent);
    return { fm: parsed.data || {}, body: String(parsed.content || '').trim() };
  } catch {
    return { fm: {}, body: String(oldContent).trim() };
  }
}

/** frontmatter 数组字段并集（去重） */
function unionArr(a, b) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
}

/**
 * H4：跨批次同 slug 撞名时合并旧页，绝不整文件覆盖丢内容。
 * 策略（实现成本合理且确定性可测）：
 * - frontmatter 的 hub-id / sources 取并集（去重），tags 并集，last-updated 取新，
 *   category 保留旧值（缺失时用新页值）；
 * - 旧正文原样保留，新内容追加为「## 更新（<时间>）」区。
 * @param {string} oldContent 旧页全文（frontmatter + 正文）
 * @param {Object} p 新页 { title, tags, category, hubIds, sources, content }
 * @param {string} now ISO 时间
 * @returns {{ fm: Object, body: string }}
 */
export function mergePageContent(oldContent, p, now) {
  const { fm: oldFm, body: oldBody } = parsePageSafe(oldContent);
  const fm = {
    'hub-id': unionArr(oldFm['hub-id'], p.hubIds),
    sources: unionArr(oldFm.sources, p.sources),
    'last-updated': now,
    tags: unionArr(oldFm.tags, p.tags),
    category: oldFm.category || p.category || DEFAULT_CATEGORY,
  };
  const body = oldBody
    ? `${oldBody}\n\n## 更新（${now}）\n\n${p.content}`
    : `# ${p.title}\n\n${p.content}`;
  return { fm, body };
}

/**
 * M1：超长页整页重写——请 LLM 把既有正文（含历史「## 更新」区）与新增内容归并重写为一页。
 * @param {Object} client LLM 客户端
 * @param {string} oldContent 旧页全文
 * @param {Object} p 新页 { title, tags, category, hubIds, sources, content }
 * @param {string} now ISO 时间
 * @returns {Promise<{ fm: Object, body: string }>}
 * @throws {Error} LLM 调用或输出解析失败（调用方回退追加合并）
 */
export async function rewritePageWithLlm(client, oldContent, p, now) {
  const { fm: oldFm, body: oldBody } = parsePageSafe(oldContent);
  const messages = [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        title: p.title,
        existing: maskSecrets(oldBody).slice(0, 40000),
        incoming: maskSecrets(p.content),
      }),
    },
  ];
  const text = await client.chat(messages, { maxTokens: 8192 });
  const json = extractJson(text);
  const title = maskSecrets(String(json?.title || p.title).trim()) || p.title;
  const content = maskSecrets(String(json?.content || '').trim());
  if (!content) throw new Error('整页重写输出为空');
  const fm = {
    'hub-id': unionArr(oldFm['hub-id'], p.hubIds),
    sources: unionArr(oldFm.sources, p.sources),
    'last-updated': now,
    tags: unionArr(oldFm.tags, p.tags),
    category: oldFm.category || p.category || DEFAULT_CATEGORY,
  };
  return { fm, body: `# ${title}\n\n${content}` };
}

// ---------------------------------------------------------------------------
// 增量写回契约（distill 侧）：state/pending-writeback.json
// ---------------------------------------------------------------------------

/** 增量写回待办文件：~/.memory-hub/state/pending-writeback.json（消费/清空由 writeback 侧负责） */
export function pendingWritebackPath() {
  return path.join(paths.state, 'pending-writeback.json');
}

/**
 * distill 每轮成功后登记本轮更新的页面（增量写回契约，逐字遵守）：
 * `{"updatedAt":"<ISO>","pages":[{"path":"<wiki相对路径>","hubIds":["hub-..."]}]}`。
 * pages[].path 语义（SHOULD-4 明确）：相对 wiki 根目录的路径（顶层页即文件名如
 * `foo.md`，子目录页如 `sub/foo.md`）；消费侧（writeback）对子目录页只认相对路径
 * 精确匹配，basename 匹配仅限顶层文件。
 * 若文件已存在且未被消费（非空），按 path 去重合并 hubIds 后原子写入（withLock + tmp+rename）。
 * @param {{ path: string, hubIds: string[] }[]} pages 本轮更新的页面清单
 * @param {string} [updatedAt] ISO 时间，缺省当前时间
 * @returns {Object} 落盘后的完整内容
 */
export function appendPendingWriteback(pages, updatedAt) {
  const file = pendingWritebackPath();
  return withLock(file, () => {
    const map = new Map();
    let removals = [];
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing && Array.isArray(existing.pages)) {
        for (const e of existing.pages) {
          if (e && e.path) map.set(String(e.path), new Set((e.hubIds || []).map(String)));
        }
      }
      // compact 登记的 App 侧待清理 hubId（removals）原样保留，不被本函数重写丢失
      if (existing && Array.isArray(existing.removals)) {
        removals = existing.removals.map(String);
      }
    } catch {
      // 不存在/已消费清空/损坏：从零开始
    }
    for (const pg of pages) {
      if (!pg || !pg.path) continue;
      const set = map.get(String(pg.path)) || new Set();
      for (const id of pg.hubIds || []) set.add(String(id));
      map.set(String(pg.path), set);
    }
    const out = {
      updatedAt: updatedAt || new Date().toISOString(),
      pages: [...map.entries()].map(([p, ids]) => ({ path: p, hubIds: [...ids] })),
      ...(removals.length > 0 ? { removals } : {}),
    };
    atomicWrite(file, `${JSON.stringify(out, null, 2)}\n`, { mode: FILE_MODE });
    return out;
  });
}

// ---------------------------------------------------------------------------
// 删除传播（tombstone）：wiki 侧标记与重放防护
// ---------------------------------------------------------------------------

/**
 * 从页正文中剔除指定 hubId 的条目块：
 * - 标题行尾带 `[hub-id]` 标记的块（至下一个同级或更高级标题前的全部内容）；
 * - 独立成行的 `[hub-id]` 标记行。
 * 注意：LLM 归并后的散文内容若未带 [hub-id] 标记则无法定位，只能靠页级
 * deleted 标记兜底（边界已在 README 说明）。
 * @param {string} body 页正文（不含 frontmatter）
 * @param {string[]} hubIds 待剔除的 hubId 列表
 * @returns {string} 剔除后的正文（连续空行压缩、首尾 trim）
 */
export function stripHubIdBlocks(body, hubIds) {
  const ids = new Set((hubIds || []).map(String));
  if (ids.size === 0) return String(body || '');
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  let skipLevel = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (skipLevel > 0) {
      // 块内：直到遇到同级或更高级标题才结束跳过（该行仍需常规判定）
      if (heading && heading[1].length <= skipLevel) {
        skipLevel = 0;
      } else {
        continue;
      }
    }
    if (heading) {
      const idMatch = heading[2].match(/\[([^[\]]+)\]\s*$/);
      if (idMatch && ids.has(idMatch[1])) {
        skipLevel = heading[1].length;
        continue;
      }
    }
    const bare = line.trim().match(/^\[([^[\]]+)\]$/);
    if (bare && ids.has(bare[1])) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 消费 tombstone 清单（distill 每轮开始时调用，dryRun 不调）：
 * ① 解除：同 hubId 有更新的摄取（ingestedAt > deletedAt，用户重建了记忆）→
 *    移除 tombstone，并清掉 processed 中 skipped:'tombstone' 的记录让快照重新可蒸馏；
 * ② wiki 标记：尚未 wikiApplied 的 tombstone → 页内该 hubId 条目块剔除；
 *    若整页 hub-id 全部 tombstone → frontmatter 标 `deleted: true` 原地保留
 *    （不移 _archive：index-builder 递归收录子目录，移动无法隐藏且引入路径风险）；
 *    部分剔除的页登记 pending-writeback（剩余条目需重新写回各 App）；
 * ③ 重放防护：本轮 apply 的 hubId 全部记入 state.processed（skipped:'tombstone'），
 *    旧快照不会被重新蒸馏复活；
 * ④ 处理过的 tombstone 打 wikiApplied 时间戳（幂等，下轮不重复改页）。
 * MUST-2 安全阀：
 * - autoPropagate 关闭（默认）且非 force 时，只做 ① 解除，②③④ 一律跳过
 *   （不动 wiki），日志提示待确认数，由 hub tombstone apply 显式执行；
 * - 自动传播开启但非 force 时，跳过 suspectedStorm（风暴熔断标记）条目。
 * @param {Object} state loadDistillState 结果（就地修改 processed）
 * @param {{ config?: Object, force?: boolean }} [opts] config 提供 tombstone.autoPropagate
 *   开关；force=true（hub tombstone apply）绕过开关与 suspectedStorm 过滤
 * @returns {{ lifted: string[], applied: string[], deletedPages: string[],
 *   updatedPages: string[], pendingConfirm: number, stormSkipped: number }}
 */
export function applyTombstones(state, opts = {}) {
  const now = new Date().toISOString();
  const summary = {
    lifted: [],
    applied: [],
    deletedPages: [],
    updatedPages: [],
    pendingConfirm: 0,
    stormSkipped: 0,
  };
  const allEntries = Object.entries(loadTombstones().tombstones || {});
  if (allEntries.length === 0) return summary;
  const entries = allEntries;

  // ① 解除：删除之后又有新摄取的同 hubId 快照 = 用户重建了记忆
  const snapIngested = new Map();
  for (const m of listSnapshotMeta()) {
    if (m.hubId) snapIngested.set(m.hubId, m.ingestedAt || '');
  }
  const lifted = [];
  for (const [id, t] of entries) {
    const ingestedAt = snapIngested.get(id);
    if (ingestedAt && (!t.deletedAt || ingestedAt > t.deletedAt)) lifted.push(id);
  }
  if (lifted.length > 0) {
    removeTombstones(lifted);
    for (const id of lifted) {
      if (state.processed[id]?.skipped === 'tombstone') delete state.processed[id];
    }
    summary.lifted = lifted;
  }

  // MUST-2 安全阀：自动传播关闭且非 force → 只做解除，不动 wiki（证据链保留）
  const liftedSet = new Set(lifted);
  const propagate = opts.force === true || opts.config?.tombstone?.autoPropagate === true;
  const awaiting = entries.filter(([id, t]) => !liftedSet.has(id) && !t.wikiApplied);
  if (!propagate) {
    summary.pendingConfirm = awaiting.length;
    if (awaiting.length > 0) {
      appendLogEntry(
        distillLogPath(),
        `${now}\tinfo\t有 ${awaiting.length} 条待确认的删除（tombstone.autoPropagate=false），运行 hub tombstone apply 显式执行 wiki 标记与写回清理`,
      );
    }
    if (lifted.length > 0) saveDistillState(state);
    return summary;
  }

  // ② wiki 标记：active 且尚未 wikiApplied 的 tombstone；非 force 时跳过疑似风暴条目
  const propagatable = opts.force === true
    ? awaiting
    : awaiting.filter(([, t]) => t.suspectedStorm !== true);
  summary.stormSkipped = awaiting.length - propagatable.length;
  if (summary.stormSkipped > 0) {
    appendLogEntry(
      distillLogPath(),
      `${now}\twarn\t跳过 ${summary.stormSkipped} 条疑似删除风暴（suspectedStorm）的 tombstone wiki 标记，需 hub tombstone apply 人工确认`,
    );
  }
  const pendingIds = propagatable.map(([id]) => id);
  if (pendingIds.length === 0) {
    if (lifted.length > 0) saveDistillState(state);
    return summary;
  }
  const pendingSet = new Set(pendingIds);
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(storePaths.wiki, { withFileTypes: true });
  } catch {
    dirEntries = [];
  }
  const pendingPages = [];
  for (const e of dirEntries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'README.md') continue;
    const pagePath = path.join(storePaths.wiki, e.name);
    let parsed;
    try {
      parsed = matter(fs.readFileSync(pagePath, 'utf8'));
    } catch {
      continue;
    }
    const fm = parsed.data || {};
    const rawIds = fm['hub-id'];
    const pageIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
    const hit = pageIds.filter((id) => pendingSet.has(id));
    if (hit.length === 0) continue;
    const remaining = pageIds.filter((id) => !pendingSet.has(id));
    const newBody = stripHubIdBlocks(parsed.content, hit);
    const newFm = { ...fm, 'last-updated': now };
    if (remaining.length === 0) {
      // 页级：全部 hubId 均 tombstone → 原地标记 deleted（writeback 侧跳过此页）
      newFm.deleted = true;
      newFm['deleted-at'] = now;
      summary.deletedPages.push(e.name);
    } else {
      newFm['hub-id'] = remaining;
      newFm['deleted-hub-ids'] = unionArr(fm['deleted-hub-ids'], hit);
      summary.updatedPages.push(e.name);
      // 部分剔除：剩余条目需重新写回（各 App 侧内容可能含已删条目的旧渲染）
      pendingPages.push({ path: e.name, hubIds: remaining });
    }
    // 对象传参：避免 gray-matter 把正文中的孤立 --- 误当 frontmatter 解析
    atomicWrite(pagePath, matter.stringify({ content: `${newBody}\n` }, newFm), { mode: FILE_MODE });
  }

  // ③ 重放防护：无论是否命中 wiki 页（可能删在蒸馏前），一律标 processed 防复活
  for (const id of pendingIds) {
    const prev = state.processed[id] || {};
    state.processed[id] = { ...prev, page: prev.page || '', at: now, skipped: 'tombstone' };
  }
  summary.applied = pendingIds;
  saveDistillState(state);
  // ④ 幂等打点：下轮不再重复改页
  updateTombstones(pendingIds, { wikiApplied: now });

  if (pendingPages.length > 0) {
    try {
      appendPendingWriteback(pendingPages);
    } catch (err) {
      appendLogEntry(
        distillLogPath(),
        `${now}\twarn\ttombstone 页登记 pending-writeback 失败（下轮全量兜底）: ${err.message}`,
      );
    }
  }
  if (summary.deletedPages.length > 0 || summary.updatedPages.length > 0) {
    try {
      rebuildMasterIndex();
    } catch {
      // 索引重建失败不阻断：下轮 distill 成功后会再建
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// distill 主流程
// ---------------------------------------------------------------------------

/**
 * 执行一次 distill 整理（分批处理，防单请求超网关 6MB/模型上下文限额）。
 * @param {{
 *   dryRun?: boolean,     // 只打印将产生的页面变更，不落盘、不改状态
 *   maxPages?: number,    // 本次最多产出页数（超出部分保留 sources 下次再整理）
 *   maxBatches?: number,  // 本次最多处理的批次数（缺省 DEFAULT_MAX_BATCHES，剩余下轮继续）
 *   client?: Object,      // 可注入的 LLM 客户端（{ chat(messages) }），测试 mock 用
 *   config?: Object,      // 配置；缺省 loadConfig()
 * }} [opts]
 * @returns {Promise<Object>} 结果摘要：
 *   { ok, pending?, pages?, written?, index?, processed?, dryRun?, error?, retained?, batches? }
 */
export async function distill(opts = {}) {
  ensureHubStore();
  const config = opts.config || loadConfig();
  const state = loadDistillState();
  // 删除传播：每轮开始先消费 tombstone 清单（wiki 标记 + 重放防护 + 重建解除；
  // MUST-2：autoPropagate 开关与 suspectedStorm 过滤由 applyTombstones 按 config 执行）
  let tombstoneInfo = null;
  if (!opts.dryRun) {
    try {
      tombstoneInfo = applyTombstones(state, { config });
    } catch (err) {
      appendLogEntry(
        distillLogPath(),
        `${new Date().toISOString()}\twarn\ttombstone 处理失败（不影响本轮蒸馏）: ${err.message}`,
      );
    }
  }
  // H5：主流程扫描开启隔离（dryRun 绝不动状态与文件）
  let snapshots = listUnprocessedSnapshots(state, { quarantine: !opts.dryRun });
  // 删除传播只读兜底：active tombstone 的快照一律不进入蒸馏（dryRun 也过滤）
  try {
    const activeTombIds = new Set(Object.keys(loadTombstones().tombstones || {}));
    if (activeTombIds.size > 0) snapshots = snapshots.filter((s) => !activeTombIds.has(s.hubId));
  } catch {
    // tombstone 清单不可读：不阻断蒸馏主流程
  }

  // H4：测试标记快照直接跳过（标 processed + 一次日志），不进入蒸馏；
  // SHOULD-5：标记清单读 config.distill.testMarkers（缺省即 DEFAULT_TEST_MARKERS）
  const testMarkers = Array.isArray(config.distill?.testMarkers) && config.distill.testMarkers.length > 0
    ? config.distill.testMarkers
    : TEST_MARKERS;
  const testSkipped = snapshots.filter((s) => hasTestMarker(s, testMarkers));
  snapshots = snapshots.filter((s) => !hasTestMarker(s, testMarkers));
  if (!opts.dryRun && testSkipped.length > 0) {
    const now = new Date().toISOString();
    for (const s of testSkipped) {
      state.processed[s.hubId] = { page: '', at: now, skipped: 'test-marker' };
      appendLogEntry(
        distillLogPath(),
        `${now}\tinfo\t测试标记快照跳过蒸馏（已标 processed）: ${path.relative(storePaths.sources, s.file)}`,
      );
    }
    saveDistillState(state);
  }

  // 回声兜底：hub 自写渲染产物（采集护栏上线前漏进的存量）直接标 processed 跳过，
  // 不烧 token 不进 wiki；汇总记一条日志（存量可达万条，不逐条刷日志）
  const echoSkipped = snapshots.filter((s) => hasEchoMarker(s));
  snapshots = snapshots.filter((s) => !hasEchoMarker(s));
  if (!opts.dryRun && echoSkipped.length > 0) {
    const now = new Date().toISOString();
    for (const s of echoSkipped) {
      state.processed[s.hubId] = { page: '', at: now, skipped: 'echo' };
    }
    saveDistillState(state);
    appendLogEntry(
      distillLogPath(),
      `${now}\tinfo\t回声快照跳过蒸馏 ${echoSkipped.length} 条（hub 自写写回产物，已标 processed skipped:echo）`,
    );
  }

  if (snapshots.length === 0) {
    return {
      ok: true,
      pending: 0,
      pages: [],
      message: '没有待整理的原始快照（sources 均已整理或为空）',
      testMarkerSkipped: testSkipped.length,
      ...(tombstoneInfo ? { tombstones: tombstoneInfo } : {}),
    };
  }

  // H3：批内物理去重与同名合并（重复者的 hubId 随代表所在页一并标 processed）
  const { kept, members } = dedupeSnapshots(snapshots);

  // 限流冷却检查：冷却期内零调用直接跳过（失败调用照样计额度，撞墙无意义）
  const cooldown = llmCooldownRemaining();
  if (cooldown.remainMs > 0) {
    return {
      ok: false,
      cooldown: true,
      error: `LLM 限流冷却中（至 ${cooldown.until}，剩余 ${Math.ceil(cooldown.remainMs / 60000)} 分钟），本轮零调用跳过`,
      retained: snapshots.length,
    };
  }

  // LLM 客户端：注入优先；否则按 config + Keychain 构建（失败即降级返回错误）
  let client;
  try {
    client = opts.client || buildRealClient(config);
  } catch (err) {
    return { ok: false, error: err.message, retained: snapshots.length };
  }

  const allBatches = chunkSnapshots(kept);
  const maxBatches = opts.maxBatches && opts.maxBatches > 0 ? opts.maxBatches : DEFAULT_MAX_BATCHES;
  const queue = allBatches.slice(0, maxBatches);
  const plannedBatches = queue.length;
  let pagesAllowance = opts.maxPages && opts.maxPages > 0 ? opts.maxPages : Infinity;

  const allPages = [];
  const written = [];
  const writtenPageIds = new Map(); // slug.md → Set<hubId>（增量写回契约用）
  let processed = 0;
  let skippedPoisoned = 0;
  const batchErrors = [];

  while (queue.length > 0) {
    if (pagesAllowance <= 0) break;
    // 限流冷却生效即刻刹车（含同轮内 rewritePageWithLlm 撞限流的情况）
    if (llmCooldownRemaining().remainMs > 0) break;
    const batch = queue.shift();
    const sig = batchSignature(batch);

    // M2：毒批次（隔离清单内）不再重放
    if (state.poisonedBatches[sig]) {
      skippedPoisoned += 1;
      continue;
    }

    // M5：发送前请求体预算硬校验，超限对半拆分（单条批次无法再拆，只能放行）
    const messages = buildMessages(batch);
    if (batch.length > 1 && requestBytes(messages) > MAX_REQUEST_BYTES) {
      queue.unshift(...splitBatch(batch));
      continue;
    }

    // M3：调用失败只跳过该批（continue），不中断整轮；TooLarge 对半拆分重试
    let llmText;
    try {
      // 显式给足输出配额：网关缺省 max_tokens 偏小，归并页 JSON 容易被截断
      llmText = await client.chat(messages, { maxTokens: 8192 });
    } catch (err) {
      if (err?.tooLarge && batch.length > 1) {
        appendLogEntry(
          distillLogPath(),
          `${new Date().toISOString()}\twarn\t请求体超网关上限，批次对半拆分重试（${batch.length} 条 → ${Math.ceil(batch.length / 2)}+${Math.floor(batch.length / 2)}）`,
        );
        queue.unshift(...splitBatch(batch));
        continue;
      }
      // 限流：整轮刹车进入冷却（剩余批次不再尝试——失败调用照样计额度）
      if (err?.rateLimited) {
        const until = startLlmCooldown(err.message);
        batchErrors.push(`LLM 限流，整轮刹车冷却至 ${until}（剩余 ${queue.length + 1} 批下轮继续）: ${err.message}`);
        break;
      }
      batchErrors.push(`LLM 调用失败（该批 ${batch.length} 条跳过，下轮重试）: ${err.message}`);
      continue;
    }

    // 解析失败只是单批输出不合规：记失败计数（M2），达 3 次隔离并告警一次，不再重放
    let pages;
    try {
      pages = normalizePages(extractJson(llmText));
    } catch (err) {
      batchErrors.push(`LLM 输出解析失败（该批 ${batch.length} 条跳过）: ${err.message}`);
      // 完整回复落盘到底层 logs（脱敏后），便于定位不合规输出的真实形态
      const dumpFile = path.join(paths.logs, `distill-failed-${Date.now()}.txt`);
      try {
        fs.writeFileSync(dumpFile, maskSecrets(String(llmText ?? '')));
      } catch {
        // 落盘失败不影响主流程
      }
      appendLogEntry(
        distillLogPath(),
        `${new Date().toISOString()}\twarn\t批次解析失败跳过（${batch.length} 条，首条 ${batch[0]?.hubId}）: ${err.message}\t完整回复: ${dumpFile}`,
      );
      if (!opts.dryRun) {
        const now = new Date().toISOString();
        const rec = state.batchFailures[sig] || { count: 0 };
        rec.count += 1;
        rec.lastError = err.message;
        rec.at = now;
        if (rec.count >= MAX_BATCH_FAILURES) {
          delete state.batchFailures[sig];
          state.poisonedBatches[sig] = {
            hubIds: batch.map((s) => s.hubId),
            failCount: rec.count,
            lastError: err.message,
            at: now,
          };
          appendLogEntry(
            distillLogPath(),
            `${now}\terror\t毒批次隔离告警：批次 ${sig.slice(0, 12)}（${batch.length} 条，首条 ${batch[0]?.hubId}）连续 ${rec.count} 次解析失败，已记入隔离清单不再重放`,
          );
        } else {
          state.batchFailures[sig] = rec;
        }
        saveDistillState(state);
      }
      continue;
    }
    // 本批解析成功：清除历史失败计数
    if (state.batchFailures[sig]) delete state.batchFailures[sig];

    // 只保留本批输入中真实存在的 hubId（防 LLM 编造）+ 全量脱敏
    const knownIds = new Set(batch.map((s) => s.hubId));
    const snapByHubId = new Map(batch.map((s) => [s.hubId, s]));
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

    // 质量守卫：批内 <400B 薄页并入同批最大主题页（无既有归属页时）
    pages = consolidateThinPages(pages);

    // maxPages 限额跨批次累计：超出的页面不产出，其快照保持未处理状态下次再整理
    if (Number.isFinite(pagesAllowance)) {
      pages = pages.slice(0, pagesAllowance);
    }
    pagesAllowance -= pages.length;
    allPages.push(...pages);

    if (opts.dryRun) continue;

    // 落盘 wiki 页面 + 逐批记录已处理 hubId（H4：同 slug 已存在时合并而非覆盖）
    const now = new Date().toISOString();
    for (const p of pages) {
      // H3：创建新页前先按归一化 slug/标题相似度查找既有页面，优先 update 既有页
      let slug = p.slug;
      let pagePath = path.join(storePaths.wiki, `${slug}.md`);
      if (!fs.existsSync(pagePath)) {
        const similar = findSimilarPageSlug(slug, p.title);
        if (similar) {
          slug = similar;
          pagePath = path.join(storePaths.wiki, `${slug}.md`);
        }
      }
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
        // M1：超长页触发 LLM 整页重写归并；失败回退为确定性的追加合并
        if (Buffer.byteLength(oldContent, 'utf8') > MAX_PAGE_REWRITE_BYTES) {
          try {
            ({ fm, body } = await rewritePageWithLlm(client, oldContent, p, now));
          } catch (err) {
            // 限流：触发冷却（下一批次开头刹车），本页回退确定性追加合并
            if (err?.rateLimited) startLlmCooldown(err.message);
            appendLogEntry(
              distillLogPath(),
              `${now}\twarn\t超长页整页重写失败，回退追加合并: ${slug}.md (${err.message})`,
            );
            ({ fm, body } = mergePageContent(oldContent, p, now));
          }
        } else {
          ({ fm, body } = mergePageContent(oldContent, p, now));
        }
      } else {
        fm = {
          'hub-id': p.hubIds,
          sources: p.sources,
          'last-updated': now,
          tags: p.tags,
          category: p.category || DEFAULT_CATEGORY,
        };
        body = `# ${p.title}\n\n${p.content}`;
      }
      // 质量守卫：不允许以孤立标题结尾
      body = trimTrailingOrphanHeadings(body);
      atomicWrite(pagePath, matter.stringify({ content: `${body}\n` }, fm), { mode: FILE_MODE });
      for (const id of p.hubIds) {
        state.processed[id] = { page: slug, at: now };
        // H3：内容 hash/同名合并的重复快照随代表一并标 processed
        for (const dup of members.get(id) || []) {
          state.processed[dup] = { page: slug, at: now, dedupOf: id };
        }
      }
      written.push(pagePath);
      const idSet = writtenPageIds.get(`${slug}.md`) || new Set();
      for (const id of p.hubIds) idSet.add(id);
      writtenPageIds.set(`${slug}.md`, idSet);
      processed += p.hubIds.length;
    }
    // 逐批落状态：后续批次失败不会丢已完成批次的对账记录
    if (pages.length > 0) saveDistillState(state);
  }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, pending: snapshots.length, pages: allPages, batches: plannedBatches, testMarkerSkipped: testSkipped.length };
  }

  // 全部批次都没产出且遇错 → 整体失败（sources 保留，下次重试）
  if (batchErrors.length > 0 && written.length === 0) {
    return { ok: false, error: batchErrors.join(' ; '), retained: snapshots.length };
  }

  // H7：每轮成功后全量重建主索引（含实际计数与 hub-id 回填）
  const index = written.length > 0 ? rebuildMasterIndex() : storePaths.masterIndex;

  // 增量写回契约（distill 侧）：登记本轮更新页面，消费由 writeback 侧负责
  if (written.length > 0) {
    try {
      appendPendingWriteback(
        [...writtenPageIds.entries()].map(([p, ids]) => ({ path: p, hubIds: [...ids] })),
      );
    } catch (err) {
      appendLogEntry(
        distillLogPath(),
        `${new Date().toISOString()}\twarn\tpending-writeback 登记失败（不影响本轮产出）: ${err.message}`,
      );
    }
  }

  return {
    ok: true,
    pending: snapshots.length,
    pages: allPages,
    written,
    index,
    processed,
    batches: plannedBatches,
    totalBatches: allBatches.length,
    testMarkerSkipped: testSkipped.length,
    ...(skippedPoisoned > 0 ? { skippedPoisoned } : {}),
    ...(tombstoneInfo ? { tombstones: tombstoneInfo } : {}),
    ...(batchErrors.length > 0 ? { error: batchErrors.join(' ; ') } : {}),
  };
}
