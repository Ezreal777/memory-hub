/**
 * config.js —— Memory Hub 配置层。
 *
 * 配置文件：~/.memory-hub/config.json
 * - 首次 loadConfig() 时惰性生成，默认包含 5 个 App 条目（enabled 默认 true）；
 * - 保存走 safe-write 的原子写，并强制 600 权限；
 * - llm.keyRef 仅存 Keychain 引用名，绝不落明文密钥。
 */

import fs from 'node:fs';
import { paths, ensureHubDirs, FILE_MODE } from './util/paths.js';
import { atomicWrite } from './safe-write.js';

/** 5 个受管 App 的固定 id */
export const APP_IDS = ['claude', 'codex', 'qoder', 'qoderwork', 'wukong'];

/**
 * 生成默认配置对象。
 * memory_paths 留空数组，待后续 scan 模块回填；
 * writeback.batch3Enabled 为高风险批次，默认关闭。
 * @returns {Object} 默认配置
 */
export function defaultConfig() {
  return {
    apps: APP_IDS.map((id) => ({
      id,
      enabled: true,
      memory_paths: [],
      project_slug: '',
      notes: '',
    })),
    llm: { baseUrl: '', model: '', keyRef: '' },
    debounceMs: 2000,
    pollIntervalMs: 60000,
    hubRoot: '~/.memory-hub/hub',
    writeback: { batch3Enabled: false },
  };
}

/**
 * 将已加载的配置与默认值做浅层兜底合并，保证缺字段时不崩。
 * @param {Object} raw 磁盘上读到的原始配置
 * @returns {Object} 补齐后的配置
 */
function mergeWithDefaults(raw) {
  const def = defaultConfig();
  const merged = { ...def, ...raw };
  merged.llm = { ...def.llm, ...(raw.llm || {}) };
  merged.writeback = { ...def.writeback, ...(raw.writeback || {}) };
  // apps 逐条补齐字段，保证每个条目结构完整
  const apps = Array.isArray(raw.apps) && raw.apps.length > 0 ? raw.apps : def.apps;
  merged.apps = apps.map((app) => {
    const base = def.apps.find((d) => d.id === app.id) || {
      id: app.id,
      enabled: true,
      memory_paths: [],
      project_slug: '',
      notes: '',
    };
    return { ...base, ...app };
  });
  return merged;
}

/**
 * 保存配置：惰性创建目录 → 原子写 → 强制 600 权限。
 * @param {Object} config 完整配置对象
 * @returns {string} 配置文件路径
 */
export function saveConfig(config) {
  ensureHubDirs();
  atomicWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE });
  return paths.config;
}

/**
 * 加载配置；首次使用时生成默认配置并落盘（600 权限）。
 * @returns {Object} 配置对象
 */
export function loadConfig() {
  if (!fs.existsSync(paths.config)) {
    const def = defaultConfig();
    saveConfig(def);
    return def;
  }
  const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  return mergeWithDefaults(raw);
}

/**
 * 更新单个 App 条目（字段级合并），并立即落盘。
 * @param {string} appId App id（claude|codex|qoder|qoderwork|wukong）
 * @param {Object} patch 需要合并的字段，如 { enabled: false, memory_paths: [...] }
 * @returns {Object} 更新后的完整配置
 * @throws {Error} appId 不存在时抛出
 */
export function updateApp(appId, patch) {
  const config = loadConfig();
  const app = config.apps.find((a) => a.id === appId);
  if (!app) {
    throw new Error(`updateApp 失败：未知 app id "${appId}"`);
  }
  Object.assign(app, patch, { id: app.id }); // id 不允许被覆盖
  saveConfig(config);
  return config;
}

/**
 * 更新顶层配置字段（如 debounceMs / llm / writeback），并立即落盘。
 * @param {Object} patch 需要合并的顶层字段
 * @returns {Object} 更新后的完整配置
 */
export function updateConfig(patch = {}) {
  const config = loadConfig();
  const merged = { ...config, ...patch };
  if (patch.llm) merged.llm = { ...config.llm, ...patch.llm };
  if (patch.writeback) merged.writeback = { ...config.writeback, ...patch.writeback };
  saveConfig(merged);
  return merged;
}
