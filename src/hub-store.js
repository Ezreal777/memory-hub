/**
 * hub-store.js —— Karpathy 三层中转站存储与摄取。
 *
 * 目录结构（用户可视内容位于 paths.hub，缺省 ~/Desktop/Memory Hub/）：
 *   sources/<app>/<YYYYMMDD-HHmmss>-<slug>.md   原始快照层（不可变、只增），
 *                                                文件头带来源元数据块（app/源路径/摄取时间/sha256）
 *   wiki/                                        整理层占位（本任务仅建目录 + README，distill 任务写入）
 *   _index/master-index.md                       目录索引（generateMasterIndex 扫 wiki/ 生成）
 *
 * 内部状态（不可视，位于底层 ~/.memory-hub/state/，避免桌面误删后重复摄取）：
 *   state/hash-state.json                        SHA-256 + mtimeMs + size 逐文件对账状态（借鉴 QoderWork 模式）
 *
 * 所有写磁盘一律走 safe-write 的原子写；五个 App 目录只读，本模块绝不写回。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import matter from 'gray-matter';
import { paths, ensureDir, hubRoot, FILE_MODE } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import { slugify, sha256Of } from './adapters/base.js';
import { consumeInflight } from './inflight.js';
// H1：hash-state.json 的读-改写一律套跨进程锁，并发摄取不再丢指纹
import { withLock } from './util/lock.js';

/**
 * 中转站内部各层路径（惰性 getter，随 MEMORY_HUB_ROOT 切换即时生效）。
 */
export const storePaths = {
  /** 中转站用户可视根 ~/Desktop/Memory Hub */
  get root() {
    return paths.hub;
  },
  /** 原始快照层 ~/Desktop/Memory Hub/sources */
  get sources() {
    return path.join(paths.hub, 'sources');
  },
  /** 整理层 ~/Desktop/Memory Hub/wiki */
  get wiki() {
    return path.join(paths.hub, 'wiki');
  },
  /** 索引目录 ~/Desktop/Memory Hub/_index */
  get index() {
    return path.join(paths.hub, '_index');
  },
  /** 主索引文件 ~/Desktop/Memory Hub/_index/master-index.md */
  get masterIndex() {
    return path.join(paths.hub, '_index', 'master-index.md');
  },
  /** 内部状态目录（底层，不随用户可视目录迁移） ~/.memory-hub/state */
  get state() {
    return paths.state;
  },
  /** 对账状态文件 ~/.memory-hub/state/hash-state.json */
  get hashState() {
    return path.join(paths.state, 'hash-state.json');
  },
  /** 删除传播清单 ~/.memory-hub/state/tombstones.json */
  get tombstones() {
    return path.join(paths.state, 'tombstones.json');
  },
  /** 摄取内容指纹表 ~/.memory-hub/state/source-fingerprints.json（同 app 同内容只进一次 sources） */
  get sourceFingerprints() {
    return path.join(paths.state, 'source-fingerprints.json');
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
 * 递归合并搬移：把 from 下的条目逐个挪到 to。
 * - 目标不存在 → 直接 rename；
 * - 目标已存在且两边都是目录 → 继续下钻合并；
 * - 目标已存在且两边都是文件：内容一致则删源去重，不一致则源留原地供人工处理。
 * 幂等可重入，能从任意中断/部分迁移状态恢复。
 * @param {string} from 源目录
 * @param {string} to 目标目录
 */
function mergeMoveDir(from, to) {
  let entries;
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return;
  }
  ensureDir(to);
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (!fs.existsSync(dst)) {
      try {
        fs.renameSync(src, dst);
        continue;
      } catch {
        // 跨卷等罕见失败：留在原地，下轮重试
        continue;
      }
    }
    try {
      const dstStat = fs.statSync(dst);
      if (e.isDirectory() && dstStat.isDirectory()) {
        mergeMoveDir(src, dst);
      } else if (e.isFile() && dstStat.isFile() && fs.readFileSync(src).equals(fs.readFileSync(dst))) {
        fs.rmSync(src); // 内容完全一致，删源去重
      }
      // 内容不一致的同名文件：保留双方，源供人工处理
    } catch {
      // 单条失败不阻断其余迁移
    }
  }
  try {
    fs.rmdirSync(from);
  } catch {
    // 非空则保留
  }
}

/**
 * 旧版目录布局一次性迁移（幂等）：旧版内容全部位于 ~/.memory-hub/hub/，
 * 现迁为“用户可视内容在桌面 + 内部状态在底层 state/”：
 *   1. 旧 hub/state/* → ~/.memory-hub/state/（目标已存在的文件不覆盖）；
 *   2. 旧 hub/{sources,wiki,_index} → 桌面新位置（递归合并，可从部分迁移状态恢复）；
 *   3. 旧目录清空后移除，有残留则保留供人工处理。
 * 隔离场景（MEMORY_HUB_ROOT 下新旧路径重合）直接跳过。
 */
function migrateLegacyHubDir() {
  const legacy = path.join(hubRoot(), 'hub');
  const target = storePaths.root;
  if (legacy === target || !fs.existsSync(legacy)) return;

  const legacyState = path.join(legacy, 'state');
  if (fs.existsSync(legacyState)) {
    ensureDir(paths.state);
    for (const name of fs.readdirSync(legacyState)) {
      const from = path.join(legacyState, name);
      const to = path.join(paths.state, name);
      if (!fs.existsSync(to)) {
        try {
          fs.renameSync(from, to);
        } catch {
          // 迁移失败不阻断主流程，下轮重试
        }
      }
    }
    try {
      fs.rmdirSync(legacyState);
    } catch {
      // 非空则保留
    }
  }

  ensureDir(target);
  for (const name of ['sources', 'wiki', '_index']) {
    const from = path.join(legacy, name);
    if (fs.existsSync(from)) {
      mergeMoveDir(from, path.join(target, name));
    }
  }
  try {
    fs.rmdirSync(legacy);
  } catch {
    // 非空说明有未迁移残留，保留供人工处理
  }
}

/**
 * 惰性创建中转站全部子目录，并写入 wiki/README 占位（幂等）。
 * 先执行旧版布局迁移，再建目录，避免新建空目录挡住迁移。
 */
export function ensureHubStore() {
  migrateLegacyHubDir();
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
 * L2：随机段改用 node:crypto 的强随机（randomInt 无偏差采样）——
 * hubId 是跨文件去重与写回幂等的主键，Math.random 存在理论碰撞面；格式不变。
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
    rand += alphabet[randomInt(alphabet.length)];
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
 * 记录单个文件的对账指纹（sha256 + mtimeMs + size + 所属 app + 摄取时间）。
 * L3：size 在函数内 stat 获取（保持签名不变），供 getChangedFiles 做 mtime+size 双字段快筛。
 * @param {string} filePath 源文件绝对路径
 * @param {string} sha256 内容摘要
 * @param {number} mtimeMs mtime（毫秒）
 * @param {string} [app] 所属 app id
 */
export function recordFile(filePath, sha256, mtimeMs, app) {
  const size = readFileStatSafe(filePath)?.size;
  withLock(storePaths.hashState, () => {
    const state = loadHashState();
    state.files[filePath] = {
      sha256,
      mtimeMs,
      ...(Number.isFinite(size) ? { size } : {}),
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
 * - modified：状态里有但 sha256 变化（快筛为 mtime+size 双字段，任一变化才进 sha 精判）；
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
  // L3：旧版 hash-state 无 size 字段的记录，sha 重算一致后回填 size（只重算一次，后续走快筛）
  const backfill = [];
  for (const p of discovered) {
    const rec = state.files[p];
    if (!rec) {
      added.push(p);
      continue;
    }
    // 快筛（L3 增强）：mtime + size 双字段均未变才跳过 sha 精判——
    // 仅比 mtime 会漏掉保留 mtime 的写入（rsync/备份还原等）；任一变化即进 sha 比对
    const meta = readFileStatSafe(p);
    const sizeKnown = Number.isFinite(rec.size);
    if (meta && rec.sha256 && meta.mtimeMs === rec.mtimeMs && sizeKnown && meta.size === rec.size) {
      continue; // mtime + size 均相同视为未变
    }
    const sha = meta ? sha256Of(fs.readFileSync(p)) : null;
    if (sha !== null && sha !== rec.sha256) {
      modified.push(p);
    } else if (sha !== null && !sizeKnown) {
      backfill.push({ p, size: meta.size }); // 旧 state 兼容：内容未变，补记 size
    }
  }

  const removed = [];
  for (const [p, rec] of Object.entries(state.files)) {
    if (rec.app === adapter.id && !discoveredSet.has(p)) {
      removed.push(p);
    }
  }

  // 批量回填 size（一次锁内完成）；只补字段不改 sha/mtime，对既有语义无影响
  if (backfill.length > 0) {
    withLock(storePaths.hashState, () => {
      const st = loadHashState();
      for (const { p, size } of backfill) {
        if (st.files[p]) st.files[p].size = size;
      }
      saveHashState(st);
    });
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

  // 回声保底：同 app 同内容指纹已登记 → 不再落盘（调用方按 deduped 计数）
  const fps = loadFingerprints();
  const fpKey = `${appId}:${contentFingerprint(appId, entry)}`;
  if (fps.fps[fpKey]) {
    return { hubId: fps.fps[fpKey], snapshotPath: null, deduped: true };
  }

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
  fps.fps[fpKey] = hubId;
  saveFingerprints(fps);

  // 删除传播：同源路径重新出现内容 = 用户重建了记忆 → 解除该源文件的 tombstone
  if (fs.existsSync(tombstonesPath())) {
    liftTombstonesForSource(entry.file);
  }

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

// ---------------------------------------------------------------------------
// 回声护栏（echo guard）：防 hub 自己写回的渲染产物被重新摄取
// ---------------------------------------------------------------------------

/** hub 写回渲染标记：正文中的 [hub-YYYYMMDDHHMMSS-xxxxxx]（genHubId 格式） */
export const ECHO_MARKER_RE = /\[hub-\d{14}-[a-z0-9]{6}\]/;

/** 巨文件摄取上限：超过此尺寸的源文件拒摄取（防同步读取+切节把事件循环拖死） */
export const MAX_INGEST_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 摄取内容指纹（echo-storm 2026-08-19 保底防线）：sha256(app \n title \n body)。
 * 同一 app 下同标题同正文的条目无论被 parse 多少次，sources 层只落一份快照——
 * 防止任何全量重摄取（写回回声/配置失误）把只增不改的快照层撑爆
 * （回声雪球单日灌入 3.5 万份重复快照/464MB）。
 */
function contentFingerprint(appId, entry) {
  return sha256Of(`${appId}\n${String(entry.title || '')}\n${String(entry.body || '').trim()}`);
}

function loadFingerprints() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePaths.sourceFingerprints, 'utf8'));
    if (raw && typeof raw === 'object' && raw.fps && typeof raw.fps === 'object') return raw;
  } catch {
    // 损坏/缺失视为空表，首次摄取时重建
  }
  return { version: 1, fps: {} };
}

function saveFingerprints(state) {
  atomicWrite(storePaths.sourceFingerprints, JSON.stringify(state), { mode: FILE_MODE });
}

/**
 * 判定一条解析出的记忆条目是否为 hub 自己写回的渲染产物（回声）。
 * 背景：inflight 回环抑制只认「路径+hash」，App 客户端重组目录（qoder 跨
 * category 挪文件）或向同一文件追加内容（qoderwork daily/codex AGENTS.md）后
 * 路径或 hash 变化即绕过，自产内容会被当新记忆重新摄取，形成
 * 「写回→采集→蒸馏→再写回」的回声循环（实测单日膨胀 1.3 万条快照）。
 * 三类内容级指纹（命中任一即回声）：
 * - 正文含 [hub-…] 渲染标记（qoder/claude/codex 写回体首行/块标记）；
 * - frontmatter.chatId 为 hub- 前缀（qoderwork daily 块的 memory-chat id）；
 * - frontmatter.source === 'memory-hub'（qoder 写回 frontmatter 固定字段）。
 * @param {Object} entry 适配器 parse 产出的 Entry
 * @returns {boolean}
 */
export function isEchoEntry(entry) {
  if (ECHO_MARKER_RE.test(String(entry?.body || ''))) return true;
  const fm = entry?.frontmatter || {};
  if (/^hub-\d{14}-/.test(String(fm.chatId || ''))) return true;
  if (String(fm.source || '') === 'memory-hub') return true;
  return false;
}

/**
 * 对单个适配器做全量/增量摄取对账（供首启全量摄取与轮询兜底复用）。
 * 流程：getChangedFiles → 逐个 read + parse → 回声过滤 → 逐条 ingest → 文件级 recordFile →
 * removed 文件清理状态。
 * @param {Object} adapter 适配器实例
 * @returns {{ ingested: number, files: number, removed: number, bytes: number, echoSkipped: number }}
 *   bytes 为本轮摄取正文体积估算（供 daemon 事件阈值计量）；echoSkipped 为回声跳过数
 */
export function harvest(adapter) {
  ensureHubStore();
  const { added, modified, removed } = getChangedFiles(adapter);
  const targets = [...added, ...modified];
  let ingested = 0;
  let bytes = 0;
  let echoSkipped = 0;
  let deduped = 0;
  let bigSkipped = 0;
  for (const filePath of targets) {
    // 巨文件防护（echo-storm 2026-08-19）：先 stat 后读——超限不读全文不切节，
    // 记 size 指纹防重判（文件缩回正常后 mtime/size 变化自然重新摄取）
    let raw = null;
    try {
      const st = fs.statSync(filePath);
      if (st.size > MAX_INGEST_FILE_BYTES) {
        recordFile(filePath, `bigskip:${st.size}:${st.mtimeMs}`, st.mtimeMs, adapter.id);
        bigSkipped += 1;
        continue;
      }
    } catch {
      // stat 失败（并发删除等）交给 read 兜底
    }
    raw = adapter.read(filePath);
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
      // 回声护栏：hub 自己写回的渲染产物被 App 重组/追加后绕过 inflight，
      // 按内容指纹拦截，绝不重新摄取（防写回→采集→蒸馏的回声循环）
      if (isEchoEntry(entry)) {
        echoSkipped += 1;
        continue;
      }
      const r = ingest(adapter, entry, { recordState: false });
      if (r && r.deduped) {
        deduped += 1;
      } else {
        ingested += 1;
        bytes += String(entry.body || '').length;
      }
    }
    // 无论是否产出条目，都在文件级记录一次指纹（0 条目的跳过文件也记，避免反复重判）
    recordFile(filePath, raw.sha256, raw.mtimeMs, adapter.id);
  }
  for (const p of removed) {
    removeFileState(p);
  }
  return { ingested, files: targets.length, removed: removed.length, bytes, echoSkipped, deduped, bigSkipped };
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

// ---------------------------------------------------------------------------
// 删除传播（tombstone）：源文件被删 → 登记 hubId → distill/writeback 消费
// ---------------------------------------------------------------------------

/** tombstone 清单文件路径 ~/.memory-hub/state/tombstones.json */
export function tombstonesPath() {
  return storePaths.tombstones;
}

/**
 * 读取 tombstone 清单；不存在或损坏时返回空结构。
 * 数据结构：{ version, tombstones: { "<hubId>": { app, source, deletedAt,
 *   wikiApplied?, appsCleaned?, suspectedStorm? } }, storms: { "<app>": { windowStart,
 *   count, tripped, windowIds } } }：
 * - deletedAt：watcher 确认源文件删除的时间；
 * - wikiApplied：distill 已完成 wiki 侧标记（条目块移除/页级 deleted）的时间；
 * - appsCleaned：writeback 已完成全部启用 App 侧条目移除的时间；
 * - suspectedStorm：风暴熔断标记（MUST-2），自动传播跳过此类条目，需人工确认；
 * - storms：每个适配器的熔断窗口状态（仅 addTombstonesGuarded 维护）。
 * @returns {{ version: number, tombstones: Object.<string, Object>, storms: Object.<string, Object> }}
 */
export function loadTombstones() {
  try {
    const raw = JSON.parse(fs.readFileSync(tombstonesPath(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.tombstones && typeof raw.tombstones === 'object') {
      return {
        version: raw.version || 1,
        tombstones: raw.tombstones,
        storms: raw.storms && typeof raw.storms === 'object' ? raw.storms : {},
      };
    }
  } catch {
    // 首次运行或损坏：空清单
  }
  return { version: 1, tombstones: {}, storms: {} };
}

/** 保存 tombstone 清单（原子写，600 权限；调用方需自行持锁） */
function saveTombstones(state) {
  ensureDir(storePaths.state);
  atomicWrite(tombstonesPath(), `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
}

/**
 * 登记一组 tombstone（withLock + 原子写）。已存在的 hubId 不覆盖（首次删除时间为准）。
 * @param {{ hubId: string, app?: string, source?: string }[]} items
 * @returns {string[]} 本次新登记的 hubId
 */
export function addTombstones(items) {
  const added = [];
  withLock(tombstonesPath(), () => {
    const state = loadTombstones();
    const now = new Date().toISOString();
    for (const it of items || []) {
      if (!it || !it.hubId || state.tombstones[it.hubId]) continue;
      state.tombstones[it.hubId] = {
        app: it.app || '',
        source: it.source || '',
        deletedAt: now,
      };
      added.push(it.hubId);
    }
    if (added.length > 0) saveTombstones(state);
  });
  return added;
}

/** 风暴熔断缺省阈值（与 config.tombstone.stormThreshold 默认值一致） */
export const DEFAULT_STORM_THRESHOLD = 20;

/** 风暴熔断缺省窗口时长（10 分钟，与 config.tombstone.stormWindowMs 默认值一致） */
export const DEFAULT_STORM_WINDOW_MS = 10 * 60 * 1000;

/**
 * 带风暴熔断的 tombstone 登记（MUST-2，watcher unlink 路径专用）。
 * 单个适配器在一个熔断窗口（stormWindowMs）内新登记数超过 stormThreshold 时熔断：
 * - 本窗口内已登记的条目打上 suspectedStorm: true（自动传播跳过，需人工确认）；
 * - 窗口内后续登记请求一律拒绝（suppressed，调用方只记日志）；
 * - 窗口过期后自动复位重新计数。
 * 已存在的 hubId 不覆盖也不计入风暴计数。
 * @param {{ hubId: string, app?: string, source?: string }[]} items
 * @param {{ stormThreshold?: number, stormWindowMs?: number, now?: number }} [opts]
 * @returns {{ added: string[], suppressed: string[], tripped: string[] }}
 *   added 本次新登记；suppressed 被熔断拒绝；tripped 本次新触发熔断的 app 列表
 */
export function addTombstonesGuarded(items, opts = {}) {
  const threshold = Number.isFinite(opts.stormThreshold) ? opts.stormThreshold : DEFAULT_STORM_THRESHOLD;
  const windowMs = Number.isFinite(opts.stormWindowMs) ? opts.stormWindowMs : DEFAULT_STORM_WINDOW_MS;
  const added = [];
  const suppressed = [];
  const tripped = [];
  withLock(tombstonesPath(), () => {
    const state = loadTombstones();
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const nowIso = new Date(now).toISOString();
    let changed = false;
    for (const it of items || []) {
      if (!it || !it.hubId) continue;
      const app = it.app || '';
      // 窗口状态：不存在或已过期则复位
      let storm = state.storms[app];
      if (!storm || now - Date.parse(storm.windowStart) > windowMs) {
        storm = { windowStart: nowIso, count: 0, tripped: false, windowIds: [] };
        state.storms[app] = storm;
        changed = true;
      }
      // 已熔断：本窗口后续 unlink 只记日志不登记（调用方负责打日志）
      if (storm.tripped) {
        suppressed.push(it.hubId);
        continue;
      }
      if (state.tombstones[it.hubId]) continue; // 已存在：不覆盖首删时间，不计风暴
      state.tombstones[it.hubId] = { app, source: it.source || '', deletedAt: nowIso };
      storm.count += 1;
      storm.windowIds.push(it.hubId);
      added.push(it.hubId);
      changed = true;
      // 超阈值：熔断——窗口内已登记的全部打 suspectedStorm 标记
      if (storm.count > threshold) {
        storm.tripped = true;
        tripped.push(app);
        for (const id of storm.windowIds) {
          if (state.tombstones[id]) state.tombstones[id].suspectedStorm = true;
        }
      }
    }
    if (changed) saveTombstones(state);
  });
  return { added, suppressed, tripped };
}

/**
 * 移除（解除）一组 tombstone。
 * @param {string[]} hubIds
 * @returns {string[]} 实际被移除的 hubId
 */
export function removeTombstones(hubIds) {
  const removed = [];
  withLock(tombstonesPath(), () => {
    const state = loadTombstones();
    for (const id of hubIds || []) {
      if (Object.prototype.hasOwnProperty.call(state.tombstones, id)) {
        delete state.tombstones[id];
        removed.push(id);
      }
    }
    if (removed.length > 0) saveTombstones(state);
  });
  return removed;
}

/**
 * 合并更新一组 tombstone 的字段（如 wikiApplied / appsCleaned 打点）。
 * @param {string[]} hubIds
 * @param {Object} patch 需合并的字段
 */
export function updateTombstones(hubIds, patch) {
  withLock(tombstonesPath(), () => {
    const state = loadTombstones();
    let changed = false;
    for (const id of hubIds || []) {
      if (state.tombstones[id]) {
        state.tombstones[id] = { ...state.tombstones[id], ...patch };
        changed = true;
      }
    }
    if (changed) saveTombstones(state);
  });
}

/**
 * 扫描 sources/<app>/*.md 快照层（一层，跳过 _quarantine 等隐藏/下划线目录），
 * 返回每个快照的关键元数据（frontmatter 解析失败的单文件跳过）。
 * @returns {{ file: string, hubId: string, app: string, source: string, ingestedAt: string }[]}
 */
export function listSnapshotMeta() {
  const out = [];
  let apps;
  try {
    apps = fs.readdirSync(storePaths.sources, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const a of apps) {
    if (!a.isDirectory() || a.name.startsWith('_') || a.name.startsWith('.')) continue;
    const dir = path.join(storePaths.sources, a.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue;
      const file = path.join(dir, f.name);
      try {
        const parsed = matter(fs.readFileSync(file, 'utf8'));
        const hubId = parsed.data?.hubId;
        if (!hubId) continue;
        out.push({
          file,
          hubId: String(hubId),
          app: String(parsed.data?.app || a.name),
          source: String(parsed.data?.source || ''),
          ingestedAt: String(parsed.data?.ingestedAt || ''),
        });
      } catch {
        // 单文件 frontmatter 损坏：跳过（隔离由 distill 侧 H5 机制负责）
      }
    }
  }
  return out;
}

/**
 * 按源文件绝对路径反查全部快照 hubId（供 watcher unlink 时定位被删记忆）。
 * @param {string} sourceFile 源文件路径
 * @returns {string[]} 对应快照的 hubId 列表（去重）
 */
export function findSnapshotHubIdsBySource(sourceFile) {
  const resolved = path.resolve(sourceFile);
  const ids = new Set();
  for (const meta of listSnapshotMeta()) {
    if (meta.source && path.resolve(meta.source) === resolved) ids.add(meta.hubId);
  }
  return [...ids];
}

/**
 * 解除指向某源文件的全部 tombstone（同源路径重新摄取 = 用户重建了记忆）。
 * @param {string} sourceFile 源文件路径
 * @returns {string[]} 被解除的 hubId
 */
export function liftTombstonesForSource(sourceFile) {
  const resolved = path.resolve(sourceFile);
  const { tombstones } = loadTombstones();
  const ids = Object.entries(tombstones)
    .filter(([, t]) => t.source && path.resolve(t.source) === resolved)
    .map(([id]) => id);
  return ids.length > 0 ? removeTombstones(ids) : [];
}
