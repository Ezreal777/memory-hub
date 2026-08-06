/**
 * adapters/base.js —— 适配器统一基础接口。
 *
 * 五个 App（claude / codex / qoder / qoderwork / wukong）的记忆格式各不相同，
 * 本模块定义统一的「只读摄取 + 写回」抽象，供 registry / hub-store / watcher 复用。
 *
 * 统一数据结构 Entry：
 *   {
 *     hubId?:       string,   // 摄取后由 hub-store 分配（形如 hub-<时间戳>-<6位随机>），读侧为空
 *     app:          string,   // 来源 App id（claude|codex|qoder|qoderwork|wukong）
 *     file:         string,   // 源记忆文件绝对路径（只读）
 *     title:        string,   // 条目标题
 *     body:         string,   // 条目正文（不含 frontmatter / 索引符号）
 *     frontmatter?: Object,   // 原始 frontmatter 数据（claude / qoder 有；其余可选）
 *     mtime:        number,   // 源文件 mtime（毫秒时间戳）
 *     sha256:       string    // 源文件内容 SHA-256（hex，小写）
 *   }
 *
 * 统一接口（子类按需覆盖）：
 *   - watchPaths()        → string[] 需要监听的路径（目录或文件）
 *   - discover()          → string[] 实际候选记忆文件清单（已过滤忽略项）
 *   - read(filePath)      → { path, content, mtimeMs, sha256 } 读取单文件
 *   - parse(raw)          → Entry[]  把单个文件解析为若干条目
 *   - render(entry)       → string   把条目渲染回目标格式（五个适配器已实现，写回任务交付）
 *   - write(entries)      → 写回 App 记忆（已实现：备份→inflight→原子写→verify→失败回滚）
 *   - verify(entries)     → 写回后校验（已实现）
 *
 * 硬性约束：
 *   - 绝不读取/监听任何 sqlite 与索引文件（isIgnoredPath 统一拦截）；
 *   - 写回只允许写各 App 的 markdown 记忆文件，索引/状态文件永不触碰。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 需要一律忽略的路径模式（sqlite / 各类索引 / 状态 / 隐藏备份）。
 * 命中任一片段即视为忽略，绝不读取、绝不监听。
 * @type {RegExp}
 */
export const IGNORED_PATTERN =
  /(\.index\.sqlite|\.hash-state\.json|\.memory_meta\.json|memories_1\.sqlite|\.sqlite|\.sqlite-|\.memory_evicted\.log|\.reflection-bak|\.lock$|\.sync_node|\.rewind_shell)/;

/**
 * 判断某路径是否属于忽略范围（sqlite / 索引 / 状态 / 锁文件等）。
 * @param {string} filePath 任意路径
 * @returns {boolean} true 表示必须忽略
 */
export function isIgnoredPath(filePath) {
  const base = path.basename(filePath);
  if (IGNORED_PATTERN.test(filePath)) return true;
  // 一切 . 开头的隐藏文件/目录一律忽略（如 .MEMORY.md.reflection-bak、.hash-state.json）
  if (base.startsWith('.')) return true;
  return false;
}

/**
 * 计算字符串/Buffer 内容的 SHA-256（hex 小写）。
 * @param {string|Buffer} content 文件内容
 * @returns {string} 十六进制摘要
 */
export function sha256Of(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 读取单个记忆文件的完整元信息（内容 + mtime + sha256）。
 * 文件不存在或不可读时返回 null（不抛错，交给调用方跳过）。
 * @param {string} filePath 文件绝对路径
 * @returns {{ path: string, content: string, mtimeMs: number, sha256: string }|null}
 */
export function readFileMeta(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      path: filePath,
      content,
      mtimeMs: stat.mtimeMs,
      sha256: sha256Of(content),
    };
  } catch {
    return null;
  }
}

/**
 * 把任意字符串转为文件系统安全的 slug（用于快照文件名）。
 * 规则：保留字母数字中文，其余替换为 -，压缩连续 -，限长 60。
 * @param {string} name 原始名（通常是源文件名或条目标题）
 * @returns {string} slug
 */
export function slugify(name) {
  const cleaned = String(name)
    .replace(/\.md$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'untitled';
}

/**
 * 构造一个标准 Entry 对象（统一字段，避免各适配器遗漏）。
 * @param {Object} fields 字段集合（app/file 必填，其余可缺省）
 * @returns {Object} Entry
 */
export function makeEntry(fields) {
  return {
    hubId: fields.hubId,
    app: fields.app,
    file: fields.file,
    title: fields.title ?? '',
    body: fields.body ?? '',
    frontmatter: fields.frontmatter,
    mtime: fields.mtime ?? 0,
    sha256: fields.sha256 ?? '',
  };
}

/**
 * 统一的「尚未实现」占位错误（仅供基类默认方法抛出）。
 * @param {string} id 适配器 id
 * @param {string} method 方法名
 * @returns {Error}
 */
export function notImplemented(id, method) {
  return new Error(`[${id}] adapter.${method}() 尚未实现（由写回引擎任务交付）`);
}

/**
 * 适配器基类：承载 config 中单个 app 条目，定义统一接口。
 * 子类必须覆盖 watchPaths / discover / parse / render / write / verify；
 * read 提供默认实现。基类 render/write/verify 默认抛 not-implemented 占位。
 */
export class BaseAdapter {
  /**
   * @param {Object} appConfig config.apps 中的单个条目 { id, enabled, memory_paths, ... }
   */
  constructor(appConfig) {
    this.app = appConfig;
  }

  /** App id（claude|codex|qoder|qoderwork|wukong） */
  get id() {
    return this.app.id;
  }

  /** config 中该 app 的 memory_paths（目录或文件） */
  get memoryPaths() {
    return Array.isArray(this.app.memory_paths) ? this.app.memory_paths : [];
  }

  /**
   * 需要 chokidar 监听的路径列表（目录或具体文件）。
   * @returns {string[]}
   */
  watchPaths() {
    throw notImplemented(this.id, 'watchPaths');
  }

  /**
   * 动态发现全部候选记忆文件（已剔除忽略项）。供全量摄取与轮询对账使用。
   * @returns {string[]} 文件绝对路径数组
   */
  discover() {
    throw notImplemented(this.id, 'discover');
  }

  /**
   * 判断某路径是否归本适配器管辖且未被忽略（用于事件路由）。
   * 默认实现：路径位于任一 watchPath 之下（或等于文件型 watchPath）且非忽略项。
   * @param {string} filePath 事件路径
   * @returns {boolean}
   */
  owns(filePath) {
    if (isIgnoredPath(filePath)) return false;
    const resolved = path.resolve(filePath);
    return this.watchPaths().some((wp) => {
      const w = path.resolve(wp);
      return resolved === w || resolved.startsWith(w + path.sep);
    });
  }

  /**
   * 判断某路径是否属于本适配器可摄取的记忆文件（M1 摄取白名单）。
   * 默认与 owns 一致；各子类按各自实测格式覆盖收紧
   * （防监听整目录时把任意用户文档摄取 → 发 LLM → 回灌五家）。
   * @param {string} filePath 事件路径
   * @returns {boolean}
   */
  isIngestible(filePath) {
    return this.owns(filePath);
  }

  /**
   * 读取单文件元信息（默认实现，直接复用 readFileMeta）。
   * @param {string} filePath 文件绝对路径
   * @returns {{ path: string, content: string, mtimeMs: number, sha256: string }|null}
   */
  read(filePath) {
    return readFileMeta(filePath);
  }

  /**
   * 把单个已读文件解析为若干 Entry。
   * @param {{ path: string, content: string, mtimeMs: number, sha256: string }} raw
   * @returns {Object[]} Entry[]
   */
  parse(raw) {
    throw notImplemented(this.id, 'parse');
  }

  /**
   * 将 Entry 渲染回目标 App 的文件格式文本（写回侧，五个子类均已实现）。
   * @param {Object} entry Entry
   * @returns {string}
   */
  render(entry) {
    throw notImplemented(this.id, 'render');
  }

  /**
   * 将一组 Entry 写回 App 记忆文件（写回侧，五个子类均已实现）。
   * @param {Object[]} entries Entry[]
   * @param {Object} [opts] 适配器级选项（如 wukong 重试参数）
   * @returns {Promise<Object[]>} 逐条结果
   */
  write(entries, opts) {
    throw notImplemented(this.id, 'write');
  }

  /**
   * 写回后校验（写回侧，五个子类均已实现）。
   * @param {Object[]} entries Entry[]
   */
  verify(entries) {
    throw notImplemented(this.id, 'verify');
  }
}

/**
 * 通用工具：安全列出目录下的直接文件（不递归），自动剔除忽略项。
 * @param {string} dir 目录绝对路径
 * @param {(name: string) => boolean} [filter] 额外文件名过滤器
 * @returns {string[]} 文件绝对路径数组
 */
export function listDirFiles(dir, filter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    if (isIgnoredPath(full)) continue;
    if (filter && !filter(e.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * 通用工具：递归收集目录下全部 .md 文件（剔除忽略项）。
 * @param {string} dir 目录绝对路径
 * @returns {string[]} .md 文件绝对路径数组
 */
export function collectMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isIgnoredPath(full)) continue;
    if (e.isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}
