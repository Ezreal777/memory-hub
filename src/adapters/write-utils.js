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
import { backupTo, atomicWrite, verify } from '../safe-write.js';
import { sha256Of } from './base.js';
// 从独立的 inflight.js 引入，避免 adapters → watcher → registry → adapters 循环依赖
import { registerInflight, clearInflight, registerDirWindow } from '../inflight.js';

/**
 * 生成备份目录名的时间戳（ISO，去掉冒号/点号以兼容文件系统排序）。
 * @returns {string} 形如 2026-08-05T12-30-45-678Z
 */
function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 新建一个唯一备份目录（同一毫秒内多次调用自动加序号避免冲突）。
 * @returns {string} 备份目录绝对路径
 */
export function createBackupDir() {
  ensureHubDirs();
  const ts = backupTimestamp();
  let dir = path.join(paths.backups, ts);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(paths.backups, `${ts}-${n}`);
    n += 1;
  }
  ensureDir(dir);
  return dir;
}

/**
 * 安全写入一组文件（写回侧唯一推荐入口）。
 *
 * 流程：为每个已存在的目标文件做同目录备份 → 逐文件 registerInflight →
 * 逐文件原子写 → 逐文件 verify；任一步失败则整体回滚并清除全部 inflight 预期。
 *
 * @param {{ path: string, content: string, verifyOpts?: Object, mode?: number,
 *   app?: string, hubId?: string }[]} files
 *   目标文件清单：path 绝对路径；content 最终完整内容；verifyOpts 同 safe-write.verify；
 *   app/hubId 会记入 manifest（供 rollback 按 app 分组展示与按 hub-id 清理改名文件）
 * @param {{ dirWindows?: string[] }} [opts] dirWindows：需登记目录级宽限窗口的目录列表
 *   （N1：仅对已知存在客户端后处理行为的适配器如 qoder 启用，其余适配器不传）
 * @returns {{ backupDir: string }} 本批次备份目录（供 writeback-log 记录与 rollback 使用）
 * @throws {Error} 校验/写入失败时抛出，错误对象附带 backupDir 属性
 */
export function writeFilesSafely(files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('writeFilesSafely: files 不能为空');
  }
  const backupDir = createBackupDir();
  const backups = new Map(); // path → 备份文件路径（目标原本不存在则为 null）

  // 阶段一：备份 + 注册回环抑制（写入前必须完成）
  for (const f of files) {
    ensureDir(path.dirname(f.path));
    backups.set(f.path, backupTo(f.path, backupDir, { app: f.app, hubId: f.hubId }));
    registerInflight(f.path, sha256Of(f.content));
  }
  // N1：目录级宽限窗口 —— 窗口内目录下任何文件事件一律抑制（覆盖客户端改名/重写）
  for (const dir of opts.dirWindows || []) {
    registerDirWindow(dir);
  }

  // 阶段二：原子写 + 校验；失败整体回滚
  try {
    for (const f of files) {
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
    for (const f of files) {
      const backupPath = backups.get(f.path);
      if (backupPath) {
        atomicWrite(f.path, fs.readFileSync(backupPath, 'utf8'));
      } else if (fs.existsSync(f.path)) {
        fs.rmSync(f.path, { force: true }); // 首次新建的坏文件直接删除，不留残留
      }
      clearInflight(f.path);
    }
    err.backupDir = backupDir;
    throw err;
  }
  return { backupDir };
}
