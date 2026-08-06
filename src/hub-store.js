/**
 * hub-store.js —— Karpathy 三层中转站存储与摄取。
 *
 * 目录结构（一律位于 ~/.memory-hub/hub/ 下）：
 *   sources/<app>/<YYYYMMDD-HHmmss>-<slug>.md   原始快照层（不可变、只增），
 *                                                文件头带来源元数据块（app/源路径/摄取时间/sha256）
 *   wiki/                                        整理层占位（本任务仅建目录 + README，distill 任务写入）
 *   _index/master-index.md                       目录索引（generateMasterIndex 扫 wiki/ 生成）
 *   state/hash-state.json                        SHA-256 + mtimeMs 逐文件对账状态（借鉴 QoderWork 模式）
 *
 * 所有写磁盘一律走 safe-write 的原子写；五个 App 目录只读，本模块绝不写回。
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, FILE_MODE } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import { slugify, sha256Of } from './adapters/base.js';
import { consumeInflight } from './inflight.js';
// H1：hash-state.json 的读-改写一律套跨进程锁，并发摄取不再丢指纹
import { withLock } from './util/lock.js';

/**
 * 中转站内部各层路径（惰性 getter，随 MEMORY_HUB_ROOT 切换即时生效）。
 */
export const storePaths = {
  /** 中转站根 ~/.memory-hub/hub */
  get root() {
    return paths.hub;
  },
  /** 原始快照层 ~/.memory-hub/hub/sources */
  get sources() {
    return path.join(paths.hub, 'sources');
  },
  /** 整理层 ~/.memory-hub/hub/wiki */
  get wiki() {
    return path.join(paths.hub, 'wiki');
  },
  /** 索引目录 ~/.memory-hub/hub/_index */
  get index() {
    return path.join(paths.hub, '_index');
  },
  /** 主索引文件 ~/.memory-hub/hub/_index/master-index.md */
  get masterIndex() {
    return path.join(paths.hub, '_index', 'master-index.md');
  },
  /** 状态目录 ~/.memory-hub/hub/state */
  get state() {
    return path.join(paths.hub, 'state');
  },
  /** 对账状态文件 ~/.memory-hub/hub/state/hash-state.json */
  get hashState() {
    return path.join(paths.hub, 'state', 'hash-state.json');
  },
};

/** wiki 层占位说明（首次初始化时写入） */
const WIKI_README = [
  '# wiki —— 整理层',
  '',
  '此目录由 distill（整理）任务写入：把 sources/ 中的原始快照去重、归并、提炼为结构化 wiki 页面。',
  '当前任务（适配器 + 摄取）仅创建此占位目录，尚不产生内容。',
  '',
].join('\n');

/**
 * 惰性创建中转站全部子目录，并写入 wiki/README 占位（幂等）。
 */
export function ensureHubStore() {
  ensureDir(storePaths.root);
  ensureDir(storePaths.sources);
  ensureDir(storePaths.wiki);
  ensureDir(storePaths.index);
  ensureDir(storePaths.state);
  const readme = path.join(storePaths.wiki, 'README.md');
  if (!fs.existsSync(readme)) {
    atomicWrite(readme, WIKI_README, { mode: FILE_MODE });
  }
}

/**
 * 生成 hubId：hub-<YYYYMMDDHHmmss>-<6位随机字母数字>。
 * @returns {string} hubId
 */
export function genHubId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 6; i += 1) {
    rand += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `hub-${ts}-${rand}`;
}

/**
 * 生成快照文件名的时间戳：YYYYMMDD-HHmmss。
 * @returns {string}
 */
function snapshotTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// 对账状态（hash-state.json）
// ---------------------------------------------------------------------------

/**
 * 读取 hash-state.json；不存在或损坏时返回空状态。
 * @returns {{ version: number, files: Object.<string, Object> }}
 */
export function loadHashState() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePaths.hashState, 'utf8'));
    if (raw && typeof raw === 'object' && raw.files) {
      return { version: raw.version || 1, files: raw.files };
    }
  } catch {
    // 首次运行或文件损坏：返回空状态
  }
  return { version: 1, files: {} };
}

/**
 * 保存 hash-state.json（原子写，600 权限）。
 * @param {{ version: number, files: Object }} state
 */
export function saveHashState(state) {
  ensureDir(storePaths.state);
  atomicWrite(storePaths.hashState, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
}

/**
 * 记录单个文件的对账指纹（sha256 + mtimeMs + 所属 app + 摄取时间）。
 * @param {string} filePath 源文件绝对路径
 * @param {string} sha256 内容摘要
 * @param {number} mtimeMs mtime（毫秒）
 * @param {string} [app] 所属 app id
 */
export function recordFile(filePath, sha256, mtimeMs, app) {
  withLock(storePaths.hashState, () => {
    const state = loadHashState();
    state.files[filePath] = {
      sha256,
      mtimeMs,
      app: app || state.files[filePath]?.app,
      lastSeen: new Date().toISOString(),
    };
    saveHashState(state);
  });
}

/**
 * 从对账状态中移除文件（用于源文件已被删除的场景）。
 * @param {string} filePath 源文件绝对路径
 */
export function removeFileState(filePath) {
  withLock(storePaths.hashState, () => {
    const state = loadHashState();
    if (Object.prototype.hasOwnProperty.call(state.files, filePath)) {
      delete state.files[filePath];
      saveHashState(state);
    }
  });
}

/**
 * 对比某适配器的当前候选文件与对账状态，得出增/改/删清单。
 * - added：新发现（状态里没有）；
 * - modified：状态里有但 sha256 变化；
 * - removed：状态里属于该 app、但已不在候选清单中。
 * @param {Object} adapter 适配器实例（需提供 discover() 与 id）
 * @returns {{ added: string[], modified: string[], removed: string[] }}
 */
export function getChangedFiles(adapter) {
  const state = loadHashState();
  const discovered = adapter.discover();
  const discoveredSet = new Set(discovered);

  const added = [];
  const modified = [];
  for (const p of discovered) {
    const rec = state.files[p];
    if (!rec) {
      added.push(p);
      continue;
    }
    // mtime 未变则跳过 sha 判断（快筛）；变了再比 sha 精判
    const meta = readFileStatSafe(p);
    if (meta && meta.mtimeMs === rec.mtimeMs && rec.sha256) {
      continue; // mtime 相同视为未变
    }
    const sha = meta ? sha256Of(fs.readFileSync(p)) : null;
    if (sha !== null && sha !== rec.sha256) {
      modified.push(p);
    }
  }

  const removed = [];
  for (const [p, rec] of Object.entries(state.files)) {
    if (rec.app === adapter.id && !discoveredSet.has(p)) {
      removed.push(p);
    }
  }
  return { added, modified, removed };
}

/** 安全 stat，失败返回 null */
function readFileStatSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 摄取（sources 层快照）
// ---------------------------------------------------------------------------

/**
 * 把单个 Entry 摄取到 sources 层：写不可变快照 + 记录对账状态，返回 hubId。
 * @param {Object} adapter 适配器实例（用于取 id 与 source 归属）
 * @param {Object} entry Entry（需含 app/file/title/body/sha256/mtime）
 * @param {{ recordState?: boolean }} [opts] recordState 默认 true；
 *   harvest 批量摄取时可置 false，由调用方在文件级统一 recordFile 一次以减少 IO
 * @returns {{ hubId: string, snapshotPath: string }}
 */
export function ingest(adapter, entry, opts = {}) {
  ensureHubStore();
  const hubId = genHubId();
  const appId = adapter.id;
  const dir = path.join(storePaths.sources, appId);
  ensureDir(dir);

  const slug = slugify(entry.title || path.basename(entry.file || 'entry'));
  const snapshotPath = path.join(dir, `${snapshotTimestamp()}-${slug}.md`);
  const content = renderSnapshot(hubId, appId, entry);

  // sources 层只增不改：若同名快照已存在则追加序号，绝不覆盖
  let target = snapshotPath;
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${snapshotTimestamp()}-${slug}-${n}.md`);
    n += 1;
  }
  atomicWrite(target, content, { mode: FILE_MODE });

  if (opts.recordState !== false) {
    recordFile(entry.file, entry.sha256, entry.mtime, appId);
  }
  return { hubId, snapshotPath: target };
}

/**
 * 渲染单个快照内容：来源元数据块（YAML frontmatter）+ 正文。
 * @param {string} hubId 分配的 hubId
 * @param {string} appId app id
 * @param {Object} entry Entry
 * @returns {string} 快照文本
 */
function renderSnapshot(hubId, appId, entry) {
  const meta = {
    hubId,
    app: appId,
    source: entry.file,
    title: entry.title,
    ingestedAt: new Date().toISOString(),
    sha256: entry.sha256,
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`${k}: ${yamlScalar(v)}`);
  }
  if (entry.frontmatter && Object.keys(entry.frontmatter).length > 0) {
    lines.push(`frontmatter: ${yamlScalar(JSON.stringify(entry.frontmatter))}`);
  }
  lines.push('---', '');
  if (entry.title) lines.push(`# ${entry.title}`, '');
  lines.push(entry.body ?? '', '');
  return lines.join('\n');
}

/**
 * YAML 标量安全序列化（H5 修复）：一律 JSON.stringify 输出。
 * 旧实现只对部分特殊字符加引号，`*`/`- `/`|`/`>`/`@`/`&` 开头的标题会产出
 * 不可解析的 frontmatter（如 `title: *重要事项` 被 YAML 当锚点/别名）；
 * JSON 双引号字符串是合法 YAML 标量，对任意输入都保证可解析。
 */
function yamlScalar(v) {
  return JSON.stringify(String(v ?? ''));
}

/**
 * 对单个适配器做全量/增量摄取对账（供首启全量摄取与轮询兜底复用）。
 * 流程：getChangedFiles → 逐个 read + parse → 逐条 ingest → 文件级 recordFile →
 * removed 文件清理状态。
 * @param {Object} adapter 适配器实例
 * @returns {{ ingested: number, files: number, removed: number }}
 */
export function harvest(adapter) {
  ensureHubStore();
  const { added, modified, removed } = getChangedFiles(adapter);
  const targets = [...added, ...modified];
  let ingested = 0;
  for (const filePath of targets) {
    const raw = adapter.read(filePath);
    if (!raw) continue;
    // 跨进程回环抑制（Bug#3）：其他进程（CLI 写回）刚写入的内容，
    // 命中 inflight.json 登记（路径 + hash）则只记对账指纹、不摄取，避免自写内容重复进 sources。
    // M3：仅精确命中（exact）才同步记指纹；dirWindow 命中只丢弃事件不写指纹，
    // 否则窗口期内的真实外部修改会被永久漏摄取（窗口过期后轮询对账兜底）。
    const suppress = consumeInflight(filePath, raw.sha256);
    if (suppress) {
      if (suppress.match === 'exact') {
        recordFile(filePath, raw.sha256, raw.mtimeMs, adapter.id);
      }
      continue;
    }
    const entries = adapter.parse(raw);
    for (const entry of entries) {
      ingest(adapter, entry, { recordState: false });
      ingested += 1;
    }
    // 无论是否产出条目，都在文件级记录一次指纹（0 条目的跳过文件也记，避免反复重判）
    recordFile(filePath, raw.sha256, raw.mtimeMs, adapter.id);
  }
  for (const p of removed) {
    removeFileState(p);
  }
  return { ingested, files: targets.length, removed: removed.length };
}

// ---------------------------------------------------------------------------
// 目录索引（_index/master-index.md）
// ---------------------------------------------------------------------------

/**
 * 递归收集 wiki/ 下的 .md 页面（跳过 README.md 占位与隐藏文件）。
 * @returns {string[]} 页面绝对路径
 */
function listWikiPages() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') {
        out.push(full);
      }
    }
  };
  walk(storePaths.wiki);
  return out.sort();
}

/**
 * 从页面内容提取一行摘要（首个非空、非标题行，截断至 80 字符）。
 * @param {string} content 页面内容
 * @returns {string}
 */
function pageSummary(content) {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('---')) continue;
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  }
  return '';
}

/**
 * 扫 wiki/ 生成主索引 _index/master-index.md（一行一摘要）。
 * wiki 无页面时输出空索引说明。
 * @returns {string} 生成的主索引文件路径
 */
export function generateMasterIndex() {
  ensureHubStore();
  const pages = listWikiPages();
  const lines = ['# Master Index —— 中转站目录索引', ''];
  if (pages.length === 0) {
    lines.push(
      '> 当前 wiki/ 整理层尚无任何页面。',
      '> 待 distill（整理）任务将 sources/ 快照提炼为 wiki 页面后，本索引将自动列出一行一摘要。',
      '',
    );
  } else {
    lines.push(`共 ${pages.length} 个页面：`, '');
    for (const p of pages) {
      const rel = path.relative(storePaths.wiki, p);
      let content = '';
      try {
        content = fs.readFileSync(p, 'utf8');
      } catch {
        content = '';
      }
      const titleMatch = content.match(/^#\s+(.*)$/m);
      const title = titleMatch ? titleMatch[1].trim() : path.basename(p, '.md');
      const summary = pageSummary(content);
      lines.push(`- [${title}](${rel})${summary ? ` — ${summary}` : ''}`);
    }
    lines.push('');
  }
  atomicWrite(storePaths.masterIndex, lines.join('\n'), { mode: FILE_MODE });
  return storePaths.masterIndex;
}
