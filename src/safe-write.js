/**
 * safe-write.js —— Memory Hub 安全层。
 *
 * 本模块是后续所有「写回 App 记忆文件」的唯一写通道，原则：
 * 1. 写前必备份（备份落 ~/.memory-hub/backups/<ISO时间戳>/ 下）；
 * 2. 写入一律原子化（同目录临时文件 + rename）；
 * 3. 写后可校验（frontmatter / 标记 / SHA-256），校验失败自动回滚并抛错。
 *
 * 本任务阶段不触碰任何 App 的真实记忆文件，所有能力均面向「任意目标路径」，
 * 由调用方（未来的 writeback.js / adapters）决定写哪里。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { paths, ensureDir, ensureHubDirs, FILE_MODE } from './util/paths.js';

/** 备份保留份数：仅保留最近 N 个备份目录，更早的自动清理 */
export const MAX_BACKUPS = 20;

/** 备份目录内的清单文件名：记录每个备份条目对应的原路径与备份时是否已存在 */
export const MANIFEST_NAME = 'manifest.json';

/**
 * 读取备份目录内的 manifest（损坏/不存在时返回空对象）。
 * @param {string} dir 备份目录
 * @returns {Object.<string, Object>} 备份文件名 → { origin, existed, ... }
 */
export function readBackupManifest(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 合并写入一条 manifest 记录（保留既有字段，如 hub backup 写入的 app 归属）。
 * @param {string} dir 备份目录
 * @param {string} name 备份文件名
 * @param {Object} fields 本次要合并的字段
 */
function mergeManifestEntry(dir, name, fields) {
  const manifest = readBackupManifest(dir);
  manifest[name] = { ...manifest[name], ...fields };
  atomicWrite(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: FILE_MODE,
  });
}

/**
 * 生成备份目录名的时间戳（ISO，去掉冒号/点号以兼容文件系统排序）。
 * @returns {string} 形如 2026-08-05T12-30-45-678Z
 */
function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 列出所有备份目录（按目录名升序，ISO 时间戳可按字典序排序）。
 * @returns {string[]} 备份目录绝对路径数组（旧 → 新）
 */
export function listBackupDirs() {
  if (!fs.existsSync(paths.backups)) return [];
  return fs
    .readdirSync(paths.backups, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(paths.backups, name));
}

/**
 * 清理过期备份：仅保留最近 MAX_BACKUPS 个备份目录。
 * @returns {string[]} 被删除的目录路径
 */
export function pruneBackups() {
  const dirs = listBackupDirs();
  const removed = [];
  if (dirs.length > MAX_BACKUPS) {
    for (const dir of dirs.slice(0, dirs.length - MAX_BACKUPS)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return removed;
}

/**
 * 备份单个文件到「新建的」备份目录。
 * 目标文件不存在时不报错，返回 null（用于首次写入场景）。
 * @param {string} filePath 被备份文件的绝对路径
 * @returns {string|null} 备份后的文件路径；源文件不存在时返回 null
 */
export function backup(filePath) {
  if (!fs.existsSync(filePath)) return null;
  ensureHubDirs();
  // 同一毫秒内多次备份时避免目录名冲突
  let dir = path.join(paths.backups, backupTimestamp());
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(paths.backups, `${backupTimestamp()}-${n}`);
    n += 1;
  }
  return backupTo(filePath, dir);
}

/**
 * 备份单个文件到指定备份目录（目录不存在则惰性创建）。
 * 供 rollback 测试与「同批次多文件归入同一备份目录」场景复用。
 *
 * Bug#4 修复：无论目标是否存在都在 manifest 登记——目标不存在时记为
 * 「新增」（existed=false），rollback 时将其删除而非跳过，实现零残留。
 * N4 修复：extra 中的 app 归属与 hubId 标记一并记入 manifest，
 * 供 rollback 清单按 app 分组展示与按内容特征清理改名文件（N2）。
 * @param {string} filePath 被备份文件的绝对路径
 * @param {string} dir 备份目录绝对路径
 * @param {{ app?: string, hubId?: string }} [extra] 需额外记入 manifest 的字段（undefined 字段忽略）
 * @returns {string|null} 备份后的文件路径；源文件不存在时返回 null
 */
export function backupTo(filePath, dir, extra = {}) {
  ensureDir(dir);
  const name = path.basename(filePath);
  // 过滤 undefined 字段，避免污染 manifest
  const extraFields = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) extraFields[k] = v;
  }
  if (!fs.existsSync(filePath)) {
    // 写回新建的文件：manifest 记录为「新增」，rollback 时应删除
    mergeManifestEntry(dir, name, {
      origin: filePath,
      existed: false,
      at: new Date().toISOString(),
      ...extraFields,
    });
    return null;
  }
  const dest = path.join(dir, name);
  fs.copyFileSync(filePath, dest);
  fs.chmodSync(dest, FILE_MODE);
  mergeManifestEntry(dir, name, { origin: filePath, existed: true, ...extraFields });
  pruneBackups();
  return dest;
}

/**
 * 获取最近一次备份目录。
 * @returns {string|null} 最新备份目录路径；无备份时返回 null
 */
export function latestBackupDir() {
  const dirs = listBackupDirs();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

/**
 * 原子写入：同目录写临时文件后 rename 替换，避免半写状态。
 * @param {string} filePath 目标文件绝对路径
 * @param {string} content 文件内容
 * @param {{ mode?: number }} [opts] mode 缺省时沿用原文件权限，新文件用 600
 */
export function atomicWrite(filePath, content, opts = {}) {
  ensureDir(path.dirname(filePath));
  let mode = opts.mode;
  if (mode === undefined) {
    mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : FILE_MODE;
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode); // 兜底 umask 影响
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // 失败时清理临时文件，不留垃圾
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * 末尾追加（先备份再写）：读取原内容后用 atomicWrite 整体替换，
 * 既保证「追加」语义，又保证过程原子、可回滚。
 * @param {string} filePath 目标文件绝对路径
 * @param {string} content 需要追加的内容
 * @returns {string|null} 追加前的备份路径（新文件则为 null）
 */
export function atomicAppend(filePath, content) {
  const backupPath = backup(filePath);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  atomicWrite(filePath, existing + content);
  return backupPath;
}

/**
 * 计算文件 SHA-256（hex）。
 * @param {string} filePath 文件绝对路径
 * @returns {string} 小写十六进制摘要
 */
export function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 写入后校验。
 * @param {string} filePath 目标文件绝对路径
 * @param {{
 *   expectFrontmatter?: boolean | string[],  // true=可解析即可；数组=指定字段必须齐全
 *   expectMarker?: string | string[],        // 文件内容必须包含的标记
 *   expectSha256?: string                    // 预期 SHA-256（大小写不敏感）
 * }} [opts] 校验项，未传视为不校验
 * @returns {{ ok: boolean, reasons: string[] }} 校验结果与失败原因
 */
export function verify(filePath, opts = {}) {
  const reasons = [];
  if (!fs.existsSync(filePath)) {
    return { ok: false, reasons: ['文件不存在'] };
  }
  const content = fs.readFileSync(filePath, 'utf8');

  if (opts.expectFrontmatter) {
    try {
      const parsed = matter(content);
      const fields = Array.isArray(opts.expectFrontmatter) ? opts.expectFrontmatter : [];
      for (const field of fields) {
        if (parsed.data[field] === undefined) {
          reasons.push(`frontmatter 缺少字段: ${field}`);
        }
      }
      if (!Array.isArray(opts.expectFrontmatter) && Object.keys(parsed.data).length === 0) {
        reasons.push('frontmatter 为空或不可解析');
      }
    } catch (err) {
      reasons.push(`frontmatter 解析失败: ${err.message}`);
    }
  }

  if (opts.expectMarker !== undefined) {
    const markers = Array.isArray(opts.expectMarker) ? opts.expectMarker : [opts.expectMarker];
    for (const marker of markers) {
      if (!content.includes(marker)) {
        reasons.push(`内容缺少标记: ${marker}`);
      }
    }
  }

  if (opts.expectSha256 !== undefined) {
    const actual = sha256(filePath);
    if (actual !== String(opts.expectSha256).toLowerCase()) {
      reasons.push(`SHA-256 不一致: 期望 ${opts.expectSha256}, 实际 ${actual}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * 从备份目录恢复全部文件到原路径（同样走原子写）。
 * 原路径映射由调用方传入（未来由 writeback.js 依据 config 驱动）。
 *
 * Bug#4 修复：manifest 中标记为「新增」（existed=false）的文件，
 * rollback 时删除目标文件而非跳过，实现真正零残留。
 * N2 修复：新增文件若原路径已不存在（如被 Qoder 客户端改名），则在同目录
 * 按内容特征（manifest 记录的 hubId 标记）扫描并删除匹配文件；找不到时
 * 返回 { missing: true } 条目由调用方明确提示，不静默。
 * @param {string} [backupDir] 备份目录；缺省取最近一次备份目录
 * @param {Object.<string, string> | (name: string) => string} [pathMap]
 *   备份内文件名 → 原路径 的映射对象，或接收文件名返回原路径的函数
 * @returns {{ from: string|null, to: string, removed?: boolean, renamed?: boolean, missing?: boolean }[]}
 *   已恢复/已删除的文件清单（missing 条目表示新增文件未找到，需人工确认）
 */
export function rollback(backupDir, pathMap) {
  const dir = backupDir || latestBackupDir();
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('rollback 失败：找不到可用的备份目录');
  }
  if (!pathMap) {
    throw new Error('rollback 失败：必须提供 pathMap（文件名 → 原路径映射）');
  }
  const resolveTarget = (name) =>
    typeof pathMap === 'function' ? pathMap(name) : pathMap[name];

  const restored = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === MANIFEST_NAME) continue;
    const target = resolveTarget(entry.name);
    if (!target) continue; // 映射中未声明的文件跳过，不误伤
    const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    atomicWrite(target, content);
    restored.push({ from: path.join(dir, entry.name), to: target });
  }

  // 新增文件（备份时不存在）：rollback 时删除，零残留
  const manifest = readBackupManifest(dir);
  for (const [name, info] of Object.entries(manifest)) {
    if (!info || info.existed !== false) continue;
    const target = resolveTarget(name) || info.origin;
    if (!target) continue;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      restored.push({ from: null, to: target, removed: true });
      continue;
    }
    // N2：原路径已不存在（可能被客户端改名）→ 同目录按 hub-id 标记扫描并删除
    if (info.hubId) {
      const scanDir = path.dirname(target);
      let candidates = [];
      try {
        candidates = fs
          .readdirSync(scanDir)
          .filter((n) => n.endsWith('.md'))
          .map((n) => path.join(scanDir, n));
      } catch {
        candidates = [];
      }
      const matched = candidates.filter((p) => {
        try {
          return fs.readFileSync(p, 'utf8').includes(info.hubId);
        } catch {
          return false;
        }
      });
      if (matched.length > 0) {
        for (const m of matched) {
          fs.rmSync(m, { force: true });
          restored.push({ from: null, to: m, removed: true, renamed: true });
        }
        continue;
      }
    }
    // 未找到：不静默，由调用方输出明确提示
    restored.push({ from: null, to: target, missing: true });
  }
  return restored;
}

/**
 * 组合封装：backup → atomicWrite → verify，校验失败自动从备份恢复并抛错。
 * 这是对外推荐的安全写入入口。
 * @param {string} filePath 目标文件绝对路径
 * @param {string} content 新内容
 * @param {{ verifyOpts?: Parameters<typeof verify>[1], mode?: number }} [opts]
 * @returns {{ backupPath: string|null }} 本次备份路径（新文件为 null）
 * @throws {Error} verify 失败时抛出，附带全部失败原因
 */
export function safeWrite(filePath, content, opts = {}) {
  const backupPath = backup(filePath);
  atomicWrite(filePath, content, { mode: opts.mode });

  if (opts.verifyOpts) {
    const result = verify(filePath, opts.verifyOpts);
    if (!result.ok) {
      // 自动回滚：有备份则恢复备份内容；首次写入则删除坏文件
      if (backupPath) {
        atomicWrite(filePath, fs.readFileSync(backupPath, 'utf8'));
      } else if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
      throw new Error(`safeWrite 校验失败并已回滚: ${result.reasons.join('; ')}`);
    }
  }
  return { backupPath };
}
