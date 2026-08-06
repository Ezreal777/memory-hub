/**
 * adapters/write-utils.js —— 写回侧统一安全写入助手。
 *
 * 五个适配器写回 App 目录时的唯一写通道封装，强制落实硬性约束：
 * 1. 写前必备份（同批次多文件归入同一个备份目录，便于整体回滚）；
 * 2. 写前 registerInflight（路径 + 内容 sha256），防止 watcher 把自写当成外部改动形成回环；
 * 3. 原子写入（同目录临时文件 + rename）；
 * 4. 写后逐文件 verify；任一失败则整体回滚（有备份恢复备份、首次新建则删除坏文件）并抛错。
 *
 * 绝不触碰任何 sqlite / 索引文件（由 base.isIgnoredPath 在调用侧拦截）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, ensureHubDirs } from '../util/paths.js';
import { backupTo, atomicWrite, verify, createBackupDir as createPooledBackupDir } from '../safe-write.js';
import { sha256Of } from './base.js';
// 从独立的 inflight.js 引入，避免 adapters → watcher → registry → adapters 循环依赖
import { registerInflight, clearInflight, registerDirWindow } from '../inflight.js';

/**
 * 安全 stat：文件不存在/不可读时返回 null（供适配器在读取时抓 preStat 守卫）。
 * @param {string} filePath 文件绝对路径
 * @returns {{ mtimeMs: number, size: number }|null}
 */
export function statSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * 写回延迟错误（H2b）：目标文件在读取后被外部修改（mtime/size 变化）时抛出。
 * 适配器捕获后记 deferred（本轮放弃、下轮重试），绝不硬写覆盖外部新增内容。
 */
export class WriteDeferredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteDeferredError';
    this.deferred = true;
  }
}

/**
 * 新建一个唯一备份目录（同一毫秒内多次调用自动加序号避免冲突）。
 * M2：写回批次备份归入 backups/writeback/ 分池；
 * L2：prune 统一在此执行（backupTo 纯新增文件分支不再遗漏清理）。
 * @returns {string} 备份目录绝对路径
 */
export function createBackupDir() {
  const dir = createPooledBackupDir('writeback');
  return dir;
}

/**
 * 安全写入一组文件（写回侧唯一推荐入口）。
 *
 * 流程：为每个已存在的目标文件做同目录备份 → 逐文件 registerInflight →
 * 逐文件原子写 → 逐文件 verify；任一步失败则整体回滚并清除全部 inflight 预期。
 *
 * @param {{ path: string, content: string, verifyOpts?: Object, mode?: number,
 *   app?: string, hubId?: string, preStat?: { mtimeMs: number, size: number } }[]} files
 *   目标文件清单：path 绝对路径；content 最终完整内容；verifyOpts 同 safe-write.verify；
 *   app/hubId 会记入 manifest（供 rollback 按 app 分组展示与按 hub-id 清理改名文件）；
 *   preStat（H2b）为适配器读取目标时的 stat 快照，缺省取备份阶段 stat
 * @param {{ dirWindows?: string[] }} [opts] dirWindows：需登记目录级宽限窗口的目录列表
 *   （N1：仅对已知存在客户端后处理行为的适配器如 qoder 启用，其余适配器不传）
 * @returns {{ backupDir: string }} 本批次备份目录（供 writeback-log 记录与 rollback 使用）
 * @throws {WriteDeferredError} 目标文件在读取后被外部修改（mtime/size 变化）；整体不写入
 * @throws {Error} 校验/写入失败时抛出，错误对象附带 backupDir 属性
 */
export function writeFilesSafely(files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('writeFilesSafely: files 不能为空');
  }
  const backupDir = createBackupDir();
  const backups = new Map(); // path → 备份文件路径（目标原本不存在则为 null）
  const guards = new Map(); // path → 读取时 stat 守卫 { mtimeMs, size }（新文件无守卫）

  // 阶段一：备份 + 注册回环抑制（写入前必须完成）
  for (const f of files) {
    ensureDir(path.dirname(f.path));
    backups.set(f.path, backupTo(f.path, backupDir, { app: f.app, hubId: f.hubId }));
    // H2b：确定守卫基准——适配器传入的读取时 stat 优先，否则用备份时刻 stat
    if (f.preStat) {
      guards.set(f.path, { mtimeMs: f.preStat.mtimeMs, size: f.preStat.size });
    } else {
      try {
        const st = fs.statSync(f.path);
        guards.set(f.path, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // 目标原本不存在：无守卫（新建文件不存在读-写间隙丢内容问题）
      }
    }
    registerInflight(f.path, sha256Of(f.content));
  }
  // N1：目录级宽限窗口 —— 窗口内目录下任何文件事件一律抑制（覆盖客户端改名/重写）
  for (const dir of opts.dirWindows || []) {
    registerDirWindow(dir);
  }

  // 阶段二：写前二次 stat 守卫 + 原子写 + 校验；失败整体回滚
  try {
    for (const f of files) {
      const guard = guards.get(f.path);
      if (guard) {
        let st;
        try {
          st = fs.statSync(f.path);
        } catch {
          throw new WriteDeferredError(
            `${f.path} 在读取后被外部删除，放弃本轮写回（下轮重试）`,
          );
        }
        if (st.mtimeMs !== guard.mtimeMs || st.size !== guard.size) {
          throw new WriteDeferredError(
            `${f.path} 在读取后被外部修改（mtime/size 变化），放弃本轮写回（下轮重试）`,
          );
        }
      }
      atomicWrite(f.path, f.content, { mode: f.mode });
    }
    for (const f of files) {
      if (!f.verifyOpts) continue;
      const result = verify(f.path, f.verifyOpts);
      if (!result.ok) {
        throw new Error(`${f.path} 校验失败: ${result.reasons.join('; ')}`);
      }
    }
  } catch (err) {
    // H2b：deferred（外部并发修改）不属于写坏，同样要清理本批已登记的 inflight 预期；
    // 回滚逻辑与硬失败一致（尚未写入时备份恢复是无操作）
    for (const f of files) {
      const backupPath = backups.get(f.path);
      if (backupPath) {
        atomicWrite(f.path, fs.readFileSync(backupPath, 'utf8'));
      } else if (fs.existsSync(f.path)) {
        fs.rmSync(f.path, { force: true }); // 首次新建的坏文件直接删除，不留残留
      }
      clearInflight(f.path);
    }
    if (err.deferred) throw err; // deferred 直接上抛，适配器记 deferred 下轮重试
    err.backupDir = backupDir;
    throw err;
  }
  return { backupDir };
}
