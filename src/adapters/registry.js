/**
 * adapters/registry.js —— 适配器注册中心。
 *
 * 按 config.apps 动态实例化「已启用（enabled=true 且 memory_paths 非空）」的适配器，
 * 提供统一遍历入口，供 hub-store（摄取）与 watcher（监听）复用。
 */

import { loadConfig } from '../config.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { QoderAdapter } from './qoder.js';
import { QoderworkAdapter } from './qoderwork.js';
import { WukongAdapter } from './wukong.js';

/** app id → 适配器类的映射 */
const ADAPTER_CLASSES = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  qoder: QoderAdapter,
  qoderwork: QoderworkAdapter,
  wukong: WukongAdapter,
};

/**
 * 写回风险批次标注（与各适配器文件内 batch 注释一致）：
 * - batch:1 —— 低风险直接加载型（claude / codex），新会话即生效；
 * - batch:2 —— 中风险索引型（qoder），面板收录后近实时生效；
 * - batch:3 —— 高风险（qoderwork / wukong），默认禁用，
 *   需 config.writeback.batch3Enabled=true 或 --force-batch3 才允许写。
 */
export const ADAPTER_BATCHES = {
  claude: 1, // batch:1
  codex: 1, // batch:1
  qoder: 2, // batch:2
  qoderwork: 3, // batch:3
  wukong: 3, // batch:3
};

/**
 * 依据 config 实例化全部已启用的适配器。
 * 判定「已启用」：enabled === true 且 memory_paths 至少有一项。
 * @param {Object} [config] 配置对象；缺省现读 loadConfig()
 * @returns {Object[]} 适配器实例数组（按 config.apps 顺序）
 */
export function createAdapters(config) {
  const cfg = config || loadConfig();
  const adapters = [];
  for (const app of cfg.apps || []) {
    const Cls = ADAPTER_CLASSES[app.id];
    if (!Cls) continue;
    if (app.enabled !== true) continue;
    if (!Array.isArray(app.memory_paths) || app.memory_paths.length === 0) continue;
    adapters.push(new Cls(app));
  }
  return adapters;
}

/**
 * 依据路径找到管辖它的适配器（用于 chokidar 事件路由）。
 * @param {Object[]} adapters 适配器数组
 * @param {string} filePath 事件文件路径
 * @returns {Object|null} 命中的适配器；无则 null
 */
export function findAdapterByPath(adapters, filePath) {
  for (const adapter of adapters) {
    if (adapter.owns(filePath)) return adapter;
  }
  return null;
}
