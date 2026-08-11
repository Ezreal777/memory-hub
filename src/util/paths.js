/**
 * util/paths.js —— 数据根目录与各子路径的集中定义。
 *
 * 约定：
 * - 数据根目录为 ~/.memory-hub/（一律通过 os.homedir() 拼接，禁止硬编码用户路径）。
 * - 支持环境变量 MEMORY_HUB_ROOT 覆盖根目录（仅供测试/隔离场景使用）。
 * - 用户可视目录为 ~/Desktop/Memory Hub/（sources/wiki/_index + logs 镜像），
 *   可用 MEMORY_HUB_USER_ROOT 覆盖；设置了 MEMORY_HUB_ROOT 时自动落回其 hub 子目录，
 *   保证测试/隔离场景绝不写真实桌面。
 * - 所有目录惰性创建：首次访问时才 mkdir，目录权限 700。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 目录权限：仅属主可读写执行 */
export const DIR_MODE = 0o700;
/** 敏感文件（如 config.json）权限：仅属主可读写 */
export const FILE_MODE = 0o600;

/**
 * 获取数据根目录。每次调用动态求值，保证测试中切换 MEMORY_HUB_ROOT 即时生效。
 * @returns {string} 数据根目录绝对路径
 */
export function hubRoot() {
  return process.env.MEMORY_HUB_ROOT || path.join(os.homedir(), '.memory-hub');
}

/**
 * 获取用户可视根目录（用户可直接浏览/交互的文件都放这里）。
 * 优先级：MEMORY_HUB_USER_ROOT > MEMORY_HUB_ROOT/hub（隔离场景兜底）> ~/Desktop/Memory Hub。
 * @returns {string} 用户可视根目录绝对路径
 */
export function userRoot() {
  if (process.env.MEMORY_HUB_USER_ROOT) return process.env.MEMORY_HUB_USER_ROOT;
  if (process.env.MEMORY_HUB_ROOT) return path.join(process.env.MEMORY_HUB_ROOT, 'hub');
  return path.join(os.homedir(), 'Desktop', 'Memory Hub');
}

/**
 * 各子路径的惰性 getter 集合。
 * 注意：getter 只负责拼路径，不做创建；创建统一走 ensureDir/ensureHubDirs。
 */
export const paths = {
  /** 数据根目录 ~/.memory-hub */
  get root() {
    return hubRoot();
  },
  /** 配置文件 ~/.memory-hub/config.json */
  get config() {
    return path.join(hubRoot(), 'config.json');
  },
  /** 备份根目录 ~/.memory-hub/backups */
  get backups() {
    return path.join(hubRoot(), 'backups');
  },
  /** 日志目录 ~/.memory-hub/logs */
  get logs() {
    return path.join(hubRoot(), 'logs');
  },
  /** 中转站内容目录（用户可视）~/Desktop/Memory Hub */
  get hub() {
    return userRoot();
  },
  /** 桌面日志镜像目录 ~/Desktop/Memory Hub/logs（仅供查看，权威份在 paths.logs） */
  get userLogs() {
    return path.join(userRoot(), 'logs');
  },
  /** 状态目录（游标/指纹等） ~/.memory-hub/state */
  get state() {
    return path.join(hubRoot(), 'state');
  },
};

/**
 * 惰性创建单个目录（递归），并强制 700 权限。
 * @param {string} dirPath 目录绝对路径
 * @param {number} [mode=DIR_MODE] 目录权限
 * @returns {string} 传入的目录路径
 */
export function ensureDir(dirPath, mode = DIR_MODE) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  // mkdirSync 的 mode 受 umask 影响，chmod 兜底确保权限符合预期
  fs.chmodSync(dirPath, mode);
  return dirPath;
}

/**
 * 惰性创建数据根目录下的全部子目录（root/backups/logs/state）与用户可视目录（hub/userLogs）。
 * 幂等：已存在时仅校正权限。
 */
export function ensureHubDirs() {
  ensureDir(paths.root);
  ensureDir(paths.backups);
  ensureDir(paths.logs);
  ensureDir(paths.state);
  ensureDir(paths.hub);
  ensureDir(paths.userLogs);
}
