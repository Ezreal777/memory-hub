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
// H1：config.json 的读-改写（updateApp/updateConfig）一律套跨进程锁，并发写不再丢更新
import { withLock } from './util/lock.js';

/** 5 个受管 App 的固定 id */
export const APP_IDS = ['claude', 'codex', 'qoder', 'qoderwork', 'wukong'];

/**
 * 蒸馏「测试标记」的缺省清单：快照标题/正文命中任一标记即视为测试产物，蒸馏时跳过。
 * 定义在 config.js（而非 distill.js）以避免 config ← distill 循环依赖；
 * 用户可通过 config.distill.testMarkers 覆盖。
 */
export const DEFAULT_TEST_MARKERS = ['HUB-TEST', '冒烟测试', 'N4 冒烟', 'N4冒烟'];

/**
 * L1：已知死字段清单——历史版本遗留、代码中已无任何消费方的配置键。
 * 加载时剔除，下次保存自然落盘清洗；只删清单内的键，
 * 其余未知键一律保留（避免误删其他模块新增的配置块）。
 * - hubRoot：中转站路径一律由 MEMORY_HUB_ROOT 环境变量控制（见 README），该字段无人读取。
 */
export const DEAD_CONFIG_KEYS = ['hubRoot'];

/**
 * 生成默认配置对象。
 * memory_paths 留空数组，待后续 scan 模块回填；
 * writeback.batch3Enabled 为高风险批次，默认关闭。
 * L6：移除了无人消费的死配置 hubRoot（中转站路径一律由 MEMORY_HUB_ROOT 环境变量控制，见 README）；
 * 存量配置中的残留 hubRoot 由 mergeWithDefaults 按 DEAD_CONFIG_KEYS 清洗。
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
    writeback: { batch3Enabled: false },
    // 删除传播安全阀（详见 README「删除传播与风暴防护」）
    tombstone: {
      // 自动传播开关：false（保守默认）时 unlink 仍登记 tombstone 留证据链，
      // 但 distill 不做 wiki 删除、writeback 不做 removeEntries，需 hub tombstone apply 显式执行
      autoPropagate: false,
      // 风暴熔断阈值：单适配器在一个窗口内登记的 tombstone 数超过该值即熔断
      stormThreshold: 20,
      // 风暴熔断窗口时长（毫秒），默认 10 分钟
      stormWindowMs: 10 * 60 * 1000,
    },
    // 蒸馏层配置：testMarkers 命中即视为测试产物（跳过蒸馏）
    distill: { testMarkers: [...DEFAULT_TEST_MARKERS] },
    // daemon 事件驱动调度阈值（详见 daemon.js：达阈值提前整理，否则等 1 小时兜底扫描）
    daemon: {
      sweepIntervalMs: 60 * 60 * 1000, // 兜底全量扫描间隔（1 小时）
      triggerCount: 5, // 窗口内摄取快照条数阈值（达到即提前触发整理+写回）
      triggerBytes: 64 * 1024, // 窗口内摄取内容体积阈值（字节估算）
      quietMs: 2 * 60 * 1000, // 达阈值后的静默合并窗口（每次新变更重置）
      maxDelayMs: 10 * 60 * 1000, // 达阈值后的最长推迟（持续编辑也不无限期推迟）
    },
  };
}

/**
 * 将已加载的配置与默认值做浅层兜底合并，保证缺字段时不崩。
 * L1：同时剔除 DEAD_CONFIG_KEYS 中的已知死字段（其余未知键仍保留）。
 * @param {Object} raw 磁盘上读到的原始配置
 * @returns {Object} 补齐并清洗后的配置
 */
function mergeWithDefaults(raw) {
  const def = defaultConfig();
  const merged = { ...def, ...raw };
  merged.llm = { ...def.llm, ...(raw.llm || {}) };
  merged.writeback = { ...def.writeback, ...(raw.writeback || {}) };
  merged.tombstone = { ...def.tombstone, ...(raw.tombstone || {}) };
  merged.distill = { ...def.distill, ...(raw.distill || {}) };
  merged.daemon = { ...def.daemon, ...(raw.daemon || {}) };
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
  // 死字段清洗：只删已知死键，下次 saveConfig 时落盘生效
  for (const key of DEAD_CONFIG_KEYS) {
    delete merged[key];
  }
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
  // H1：整个「读-改-写」置于锁内，daemon/CLI/scan 并发不再互相覆盖
  return withLock(paths.config, () => {
    const config = loadConfig();
    const app = config.apps.find((a) => a.id === appId);
    if (!app) {
      throw new Error(`updateApp 失败：未知 app id "${appId}"`);
    }
    Object.assign(app, patch, { id: app.id }); // id 不允许被覆盖
    saveConfig(config);
    return config;
  });
}

/**
 * 更新顶层配置字段（如 debounceMs / llm / writeback），并立即落盘。
 * @param {Object} patch 需要合并的顶层字段
 * @returns {Object} 更新后的完整配置
 */
export function updateConfig(patch = {}) {
  // H1：整个「读-改-写」置于锁内
  return withLock(paths.config, () => {
    const config = loadConfig();
    const merged = { ...config, ...patch };
    if (patch.llm) merged.llm = { ...config.llm, ...patch.llm };
    if (patch.writeback) merged.writeback = { ...config.writeback, ...patch.writeback };
    if (patch.tombstone) merged.tombstone = { ...config.tombstone, ...patch.tombstone };
    if (patch.distill) merged.distill = { ...config.distill, ...patch.distill };
    if (patch.daemon) merged.daemon = { ...config.daemon, ...patch.daemon };
    saveConfig(merged);
    return merged;
  });
}
