/**
 * inflight.js —— 写回自写回环抑制状态（跨进程持久化版）。
 *
 * Bug#3 修复：原实现是进程内 Map，CLI 进程写回时 daemon 进程的 watcher 无法命中，
 * 导致写回事件被重复摄取进 sources。现改为共享文件 hub/state/inflight.json：
 *   - registerInflight：CLI/写回进程写入文件前原子登记「路径 + 预期 sha256 + 时间戳」；
 *   - consumeInflight：daemon/watcher 进程收到事件时读取文件判定（路径 + hash 命中即自写回环）；
 *   - 条目带 TTL（默认 10 分钟），读写时自动清理过期项，防止残留永久抑制；
 *   - 并发安全：写入走「同目录临时文件 + rename」原子替换。
 *
 * N1 修复（目录级宽限窗口）：Qoder 客户端会在 hub 写回后 ~1 秒将文件改名并重写
 * frontmatter（路径与 hash 双变），精确「路径+hash」匹配覆盖不了改名后的新路径。
 * 为此 inflight.json 增加 dirs 段：{ <目录>: { ts, ttlMs } }——窗口内该目录下
 * 任意文件事件（无论路径/hash）一律判定为自写回环予以抑制。仅对已知存在
 * 客户端后处理行为的适配器（qoder）启用，其余适配器保持精确匹配。
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, FILE_MODE } from './util/paths.js';
// H1：inflight.json 的读-改写一律套跨进程锁，daemon 与 CLI 并发不再互相吞条目
import { withLock } from './util/lock.js';

/** 条目存活时长：超过该时长未被消费的条目视为过期自动清理（默认 10 分钟） */
export const INFLIGHT_TTL_MS = 10 * 60 * 1000;

/** 目录级宽限窗口默认时长：覆盖客户端写回后的改名/重写行为（默认 120 秒） */
export const DIR_WINDOW_TTL_MS = 120 * 1000;

/**
 * 共享状态文件路径 ~/.memory-hub/hub/state/inflight.json（惰性求值，随 MEMORY_HUB_ROOT 切换）。
 * @returns {string}
 */
export function inflightStorePath() {
  return path.join(paths.hub, 'state', 'inflight.json');
}

/**
 * 读取共享状态文件原始结构 { entries, dirs }（各段均剔除过期项）。
 * 文件不存在/损坏时返回空结构。
 * @returns {{ entries: Object.<string, { sha256: string, ts: number }>, dirs: Object.<string, { ts: number, ttlMs?: number }> }}
 */
function loadRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(inflightStorePath(), 'utf8'));
    const now = Date.now();
    const entries = {};
    if (raw && typeof raw.entries === 'object' && raw.entries) {
      for (const [k, v] of Object.entries(raw.entries)) {
        if (v && typeof v.sha256 === 'string' && now - (v.ts || 0) <= INFLIGHT_TTL_MS) {
          entries[k] = v;
        }
      }
    }
    const dirs = {};
    if (raw && typeof raw.dirs === 'object' && raw.dirs) {
      for (const [k, v] of Object.entries(raw.dirs)) {
        const ttl = Number.isFinite(v?.ttlMs) ? v.ttlMs : DIR_WINDOW_TTL_MS;
        if (v && now - (v.ts || 0) <= ttl) {
          dirs[k] = v;
        }
      }
    }
    return { entries, dirs };
  } catch {
    return { entries: {}, dirs: {} };
  }
}

/**
 * 读取全部未过期精确条目：{ <resolvedPath>: { sha256, ts } }。
 * 文件不存在/损坏时返回空对象；读取即顺带剔除过期条目。
 * @returns {Object.<string, { sha256: string, ts: number }>}
 */
export function loadInflightEntries() {
  return loadRaw().entries;
}

/**
 * 读取全部未过期目录窗口条目：{ <resolvedDir>: { ts, ttlMs? } }。
 * @returns {Object.<string, { ts: number, ttlMs?: number }>}
 */
export function loadDirWindows() {
  return loadRaw().dirs;
}

/**
 * 原子保存完整状态（精确条目 + 目录窗口；同目录临时文件 + rename，避免读到半写状态）。
 * 兼容旧签名：只传 entries 时保留既有目录窗口。
 * @param {Object.<string, { sha256: string, ts: number }>} entries
 * @param {Object.<string, { ts: number, ttlMs?: number }>} [dirs]
 */
export function saveInflightEntries(entries, dirs) {
  const target = inflightStorePath();
  ensureDir(path.dirname(target));
  const dirWindows = dirs === undefined ? loadRaw().dirs : dirs;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, entries, dirs: dirWindows }, null, 2)}\n`,
      { mode: FILE_MODE },
    );
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * 注册一次「自写」预期：写回引擎写入文件前调用，声明该路径即将产生的内容 sha256。
 * 随后任意进程（daemon watcher / 轮询对账）收到该路径事件时，若实际 sha256 命中即丢弃。
 * @param {string} filePath 即将写入的文件绝对路径
 * @param {string} expectedSha256 写入内容的 SHA-256
 */
export function registerInflight(filePath, expectedSha256) {
  const key = path.resolve(filePath);
  withLock(inflightStorePath(), () => {
    const entries = loadInflightEntries();
    entries[key] = { sha256: expectedSha256, ts: Date.now() };
    saveInflightEntries(entries);
  });
}

/**
 * 清除某路径的自写预期（写回失败回滚后调用，避免残留）。
 * @param {string} filePath 文件绝对路径
 */
export function clearInflight(filePath) {
  const key = path.resolve(filePath);
  withLock(inflightStorePath(), () => {
    const { entries, dirs } = loadRaw();
    if (!Object.prototype.hasOwnProperty.call(entries, key)) return;
    delete entries[key];
    saveInflightEntries(entries, dirs);
  });
}

/**
 * 登记「目录级宽限窗口」（N1）：窗口内该目录下任何文件的新增/变更事件
 * （无论路径是否为登记路径、hash 是否匹配）一律判定为自写回环予以抑制，
 * 用于覆盖客户端在写回后对文件的改名/重写行为。窗口不随消费移除，到期自动失效。
 * @param {string} dir 目录绝对路径
 * @param {number} [ttlMs] 窗口时长；缺省 DIR_WINDOW_TTL_MS（120 秒）
 */
export function registerDirWindow(dir, ttlMs = DIR_WINDOW_TTL_MS) {
  const key = path.resolve(dir);
  withLock(inflightStorePath(), () => {
    const { entries, dirs } = loadRaw();
    dirs[key] = { ts: Date.now(), ttlMs };
    saveInflightEntries(entries, dirs);
  });
}

/**
 * 消费一次 inflight 命中判定（跨进程读取共享文件）。
 * 判定顺序：精确条目（路径 + hash）→ 目录级宽限窗口（仅窗口期，不校验 hash）。
 *
 * 返回值兼容说明：历史版本返回 boolean，现返回判定详情对象——对象恒为 truthy，
 * 既有 `if (consumeInflight(...))` 与 `assert.equal(consumeInflight(...), true)`
 * （宽松相等）均保持通过；未命中返回 null（falsy）。
 * @param {string} filePath 事件路径
 * @param {string} sha256 事件文件当前 sha256
 * @returns {{ match: 'exact' | 'dirWindow', dir?: string } | null}
 *   命中返回判定详情（应丢弃该事件）；未命中返回 null
 */
export function consumeInflight(filePath, sha256) {
  const key = path.resolve(filePath);
  return withLock(inflightStorePath(), () => {
    const { entries, dirs } = loadRaw();
    if (Object.prototype.hasOwnProperty.call(entries, key)) {
      const expected = entries[key].sha256;
      // 命中登记 → 消费并移除该条目；hash 匹配才算自写回环，不匹配视为外部改动正常处理
      delete entries[key];
      saveInflightEntries(entries, dirs);
      if (expected === sha256) return { match: 'exact' };
    }
    // 目录级宽限窗口：窗口内该目录下任何文件事件一律抑制（覆盖客户端改名/重写）。
    // 注意（M3）：dirWindow 命中只丢弃事件，调用方绝不因此记录对账指纹，
    // 否则窗口期内的真实外部修改会被永久漏摄取（窗口过期后由轮询对账兜底）。
    for (const [dir] of Object.entries(dirs)) {
      if (key === dir || key.startsWith(`${dir}${path.sep}`)) {
        return { match: 'dirWindow', dir };
      }
    }
    return null;
  });
}
