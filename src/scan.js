/**
 * scan.js —— 首启扫描器（hub scan）。
 *
 * 职责：按实测确认的路径模式探测本机五个 App 的记忆位置，并把结果写回
 * config.json 各 app 条目的 memory_paths / project_slug / notes。
 *
 * 硬性约束：
 * - 对五个 App 的目录【只读】，绝不写入；
 * - 绝不触碰任何 sqlite / 索引文件（如 ~/.codex/memories_1.sqlite）；
 * - 全部通过 glob 动态发现（fs.globSync），不硬编码用户目录细节，
 *   悟空账号目录、Qoder 项目 slug 均为枚举发现；
 * - 探测失败不崩溃：输出"未找到"并将该 app 的 enabled 置 false；
 * - 重复扫描幂等（同值覆盖、路径去重）。
 *
 * homeDir 可通过参数注入（测试用临时目录伪造家目录结构）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, updateApp } from './config.js';

/**
 * 安全 glob 封装：任何异常（模式非法/权限问题）均返回空数组，不崩溃。
 * @param {string} pattern glob 模式（绝对路径）
 * @returns {string[]} 命中的路径列表
 */
function globSafe(pattern) {
  try {
    return fs.globSync(pattern);
  } catch {
    return [];
  }
}

/**
 * 过滤出其中真实存在的目录。
 * @param {string[]} hits 路径列表
 * @returns {string[]} 目录路径列表
 */
function onlyDirs(hits) {
  return hits.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * claude：探测 ~/.claude/projects/<项目>/memory/MEMORY.md。
 * 命中后取 MEMORY.md 所在目录（即 .../memory）作为 memory_paths，
 * 所在项目 slug（projects 下一级目录名）记入 notes。
 * @param {string} home 家目录
 * @returns {Object} 探测结果
 */
function probeClaude(home) {
  const hits = globSafe(path.join(home, '.claude', 'projects', '*', 'memory', 'MEMORY.md'));
  if (hits.length === 0) {
    return { found: false, memory_paths: [], project_slug: '', notes: '未找到' };
  }
  const memoryPaths = hits.map((h) => path.dirname(h)); // MEMORY.md 所在目录
  // 项目 slug = projects 的下一级目录名（MEMORY.md 往上第 2 层）
  const slugs = hits.map((h) => path.basename(path.dirname(path.dirname(h))));
  return {
    found: true,
    memory_paths: memoryPaths,
    project_slug: slugs[0] || '',
    notes: `projects: ${slugs.join(', ')}`,
  };
}

/**
 * codex：优先探测全局 ~/.codex/AGENTS.md；
 * 工作区级 AGENTS.md 不自动全盘搜索（避免扫 Desktop），
 * 但 config 中已配置的路径若仍然存在则保留（幂等、不丢用户手动配置）。
 * @param {string} home 家目录
 * @param {Object} existing config 中该 app 的现有条目
 * @returns {Object} 探测结果
 */
function probeCodex(home, existing) {
  const foundPaths = [];
  const globalAgents = path.join(home, '.codex', 'AGENTS.md');
  if (fs.existsSync(globalAgents)) {
    foundPaths.push(globalAgents);
  }
  // 保留 config 中已有的工作区级 AGENTS.md（需仍然存在于磁盘）
  for (const p of existing.memory_paths || []) {
    if (p === globalAgents) continue;
    if (fs.existsSync(p) && !foundPaths.includes(p)) {
      foundPaths.push(p);
    }
  }
  if (foundPaths.length === 0) {
    return { found: false, memory_paths: [], project_slug: '', notes: '未找到' };
  }
  return {
    found: true,
    memory_paths: foundPaths,
    project_slug: '',
    notes: foundPaths.includes(globalAgents) ? '全局 AGENTS.md' : '仅工作区级 AGENTS.md',
  };
}

/**
 * qoder：枚举 ~/.qoder/memories/<账号>/projects/<slug>/。
 * 账号目录与项目 slug 全部动态枚举发现；
 * memory 根目录（账号目录）记入 memory_paths，首个 slug 记入 project_slug，
 * 全部 slug 清单记入 notes。
 * @param {string} home 家目录
 * @returns {Object} 探测结果
 */
function probeQoder(home) {
  const projDirs = onlyDirs(
    globSafe(path.join(home, '.qoder', 'memories', '*', 'projects', '*')),
  );
  if (projDirs.length === 0) {
    return { found: false, memory_paths: [], project_slug: '', notes: '未找到' };
  }
  // memory 根目录 = projects 的上一级（账号目录），去重
  const roots = [...new Set(projDirs.map((d) => path.dirname(path.dirname(d))))];
  const slugs = projDirs.map((d) => path.basename(d));
  return {
    found: true,
    memory_paths: roots,
    project_slug: slugs[0],
    notes: `projects: ${slugs.join(', ')}`,
  };
}

/**
 * qoderwork：~/.qoderwork/awareness/main/（MEMORY.md 存在即确认）。
 * @param {string} home 家目录
 * @returns {Object} 探测结果
 */
function probeQoderwork(home) {
  const dir = path.join(home, '.qoderwork', 'awareness', 'main');
  if (fs.existsSync(path.join(dir, 'MEMORY.md'))) {
    return { found: true, memory_paths: [dir], project_slug: '', notes: 'awareness/main' };
  }
  return { found: false, memory_paths: [], project_slug: '', notes: '未找到' };
}

/**
 * wukong：枚举 ~/.real/users/<账号>/workspace/MEMORY.md（账号目录动态发现）。
 * memory_paths 取 MEMORY.md 所在的 workspace 目录。
 * @param {string} home 家目录
 * @returns {Object} 探测结果
 */
function probeWukong(home) {
  const hits = globSafe(path.join(home, '.real', 'users', '*', 'workspace', 'MEMORY.md'));
  if (hits.length === 0) {
    return { found: false, memory_paths: [], project_slug: '', notes: '未找到' };
  }
  return {
    found: true,
    memory_paths: hits.map((h) => path.dirname(h)),
    project_slug: '',
    // 账号目录 = users 的下一级（MEMORY.md 往上第 2 层）
    notes: `users: ${hits.map((h) => path.basename(path.dirname(path.dirname(h)))).join(', ')}`,
  };
}

/** 各 app 对应的探测器（codex 额外接收现有条目用于保留已配置路径） */
const PROBES = {
  claude: probeClaude,
  codex: probeCodex,
  qoder: probeQoder,
  qoderwork: probeQoderwork,
  wukong: probeWukong,
};

/**
 * 执行扫描：逐个探测 → 写回 config.json → 返回汇总表数据。
 * 幂等：重复执行结果一致；任何单个 app 探测异常不影响其余 app。
 * @param {{ home?: string }} [opts] home 缺省为 os.homedir()
 * @returns {{ id: string, found: boolean, memory_paths: string[], project_slug: string, notes: string }[]}
 */
export function scanApps(opts = {}) {
  const home = opts.home || os.homedir();
  const config = loadConfig();
  const rows = [];

  for (const app of config.apps) {
    const probe = PROBES[app.id];
    let result;
    try {
      result = probe ? probe(home, app) : { found: false, memory_paths: [], project_slug: '', notes: '未知 app' };
    } catch (err) {
      // 单个 app 探测失败不崩溃，降级为"未找到"
      result = { found: false, memory_paths: [], project_slug: '', notes: `探测异常: ${err.message}` };
    }

    // L7：写回 notes 时保留既有 readOnly 标注（否则重扫会把只读标记冲掉）
    let notes = result.found ? result.notes : '未找到';
    if (/read[-_ ]?only/i.test(String(app.notes || '')) && !/read[-_ ]?only/i.test(notes)) {
      notes = `${notes} | readOnly`;
    }

    updateApp(app.id, {
      enabled: result.found, // 未找到 → 禁用；找到 → 重新启用
      memory_paths: result.memory_paths,
      project_slug: result.project_slug,
      notes,
    });

    rows.push({ id: app.id, ...result });
  }
  return rows;
}

/**
 * 将扫描结果格式化为人类可读的汇总表。
 * @param {{ id: string, found: boolean, memory_paths: string[], notes: string }[]} rows
 * @returns {string} 表格文本
 */
export function formatScanSummary(rows) {
  const lines = [];
  lines.push('App        状态        路径');
  lines.push('-'.repeat(72));
  for (const row of rows) {
    const status = row.found ? '✅ 已发现' : '❌ 未找到';
    const pathsText = row.memory_paths.length > 0 ? row.memory_paths.join(' ; ') : '-';
    lines.push(`${row.id.padEnd(10)} ${status.padEnd(10)} ${pathsText}`);
  }
  lines.push('-'.repeat(72));
  const foundCount = rows.filter((r) => r.found).length;
  lines.push(`共发现 ${foundCount}/${rows.length} 个 App 的记忆位置，已写回 config.json`);
  return lines.join('\n');
}
