/**
 * watcher.js —— 后台监听与增量摄取。
 *
 * 职责：
 * - chokidar 监听全部已启用适配器的 watchPaths（ignoreInitial，仅增量）；
 * - 三级过滤：debounce（config.debounceMs 默认 2s）→ mtime 快筛（与 hash-state 比对）
 *   → SHA-256 精判（变化才摄取）；
 * - 60s（config.pollIntervalMs）轮询对账兜底，防 FSEvents 丢事件；
 * - onIngest 回调：每次真实摄取（事件或对账）后通知调用方（daemon 据此做
 *   事件驱动的增量整理调度）；回调异常只记日志，绝不影响摄取主流程；
 * - 回环抑制：registerInflight / clearInflight —— 写回引擎自写触发的事件（路径+hash 匹配）直接丢弃；
 * - 摄取走 hub-store.ingest；日志落 ~/.memory-hub/logs/watcher.log（不含任何密钥）。
 *
 * 硬性约束：五个 App 目录只读（本模块只摄取，绝不写回）；忽略一切 sqlite / 索引文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { loadConfig } from './config.js';
import { paths, ensureDir } from './util/paths.js';
import { isIgnoredPath, readFileMeta } from './adapters/base.js';
import { createAdapters, findAdapterByPath } from './adapters/registry.js';
import { DELETED_INFLIGHT_SHA } from './adapters/write-utils.js';
import {
  loadHashState,
  recordFile,
  removeFileState,
  ingest,
  harvest,
  addTombstonesGuarded,
  findSnapshotHubIdsBySource,
} from './hub-store.js';
import { consumeInflight, loadInflightEntries, loadDirWindows } from './inflight.js';
import { appendLogEntry } from './util/log.js';

// 回环抑制 API 集中在 inflight.js（避免 watcher ↔ adapters 循环依赖）；
// 对外仍在 watcher.js 再导出，保持既有调用方（写回引擎/测试）兼容。
export { registerInflight, clearInflight } from './inflight.js';

/** watcher 日志文件路径 */
const LOG_PATH = () => path.join(paths.logs, 'watcher.log');

/**
 * 追加一条 watcher 日志（时间 / app / 文件 / 动作）。
 * 说明：日志为运维流水，使用普通 append 而非 safe-write 的备份式原子追加，
 * 避免高频追加产生海量备份；内容只含路径与动作，绝不出现密钥。
 * L1：统一走 appendLogEntry（超 5MB 自动滚动，保留最近 3 份）。
 * @param {string} app app id（或 watcher）
 * @param {string} file 相关文件路径
 * @param {string} action 动作描述
 */
export function logWatcher(app, file, action) {
  const ts = new Date().toISOString();
  appendLogEntry(LOG_PATH(), `${ts}\t${app}\t${action}\t${file}`);
}

/**
 * 后台监听器。对外提供 start / stop；start 返回自身便于链式持有。
 */
export class Watcher {
  /**
   * @param {Object} [config] 配置；缺省现读 loadConfig()
   * @param {{ onIngest?: (info: { app: string, file?: string, count: number, bytes: number }) => void }} [hooks]
   *   onIngest：每次真实摄取后回调（count 为快照条数，bytes 为正文体积估算）
   */
  constructor(config, hooks = {}) {
    this.config = config || loadConfig();
    this.onIngest = typeof hooks.onIngest === 'function' ? hooks.onIngest : null;
    this.adapters = createAdapters(this.config);
    this.debounceMs = this.config.debounceMs ?? 2000;
    this.pollIntervalMs = this.config.pollIntervalMs ?? 60000;
    this.pending = new Map(); // path → debounce 定时器
    this.chokidarWatcher = null;
    this.pollTimer = null;
    this.running = false;
    this._signalHandlers = [];
  }

  /** 汇总全部适配器的 watchPaths（去重） */
  allWatchPaths() {
    const set = new Set();
    for (const adapter of this.adapters) {
      for (const p of adapter.watchPaths()) set.add(path.resolve(p));
    }
    return [...set];
  }

  /**
   * 启动监听 + 轮询 + （可选）信号优雅退出。
   * @param {{ signals?: boolean }} [opts] signals 缺省 true：注册 SIGINT/SIGTERM
   * @returns {Watcher} this
   */
  start(opts = {}) {
    if (this.running) return this;
    this.running = true;
    const targets = this.allWatchPaths();
    logWatcher('watcher', targets.join(','), `start 监听 ${targets.length} 个路径`);

    this.chokidarWatcher = chokidar.watch(targets, {
      ignoreInitial: true, // 仅增量，不在启动时全量摄取
      persistent: true,
      ignorePermissionErrors: true,
      // 一切 sqlite / 索引 / 隐藏文件在 chokidar 层即拦截
      ignored: (p) => isIgnoredPath(p),
    });

    const onEvent = (event) => (filePath) => this.schedule(filePath, event);
    this.chokidarWatcher.on('add', onEvent('add'));
    this.chokidarWatcher.on('change', onEvent('change'));
    this.chokidarWatcher.on('unlink', (filePath) => this.handleUnlink(filePath));
    this.chokidarWatcher.on('error', (err) => {
      logWatcher('watcher', '', `error ${err.message}`);
    });

    // ready 信号：供调用方（测试 / daemon）等待监听就绪后再动作
    this._readyPromise = new Promise((resolve) => {
      if (targets.length === 0) {
        // 0 路径时 chokidar 不触发 ready（如 config 损坏降级无 memory_paths），
        // 立即 resolve 避免 whenReady 永久挂起
        logWatcher('watcher', '', '无监听路径，watcher 直接就绪');
        resolve();
        return;
      }
      this.chokidarWatcher.once('ready', () => resolve());
    });

    // 轮询对账兜底（防 FSEvents 丢事件）
    this.pollTimer = setInterval(() => this.reconcile(), this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();

    if (opts.signals !== false) {
      this.registerSignals();
    }
    return this;
  }

  /** 等待 chokidar 完成初始扫描（监听就绪）。 */
  whenReady() {
    return this._readyPromise || Promise.resolve();
  }

  /** 通知调用方发生了真实摄取（回调异常只记日志，不影响主流程） */
  notifyIngest(info) {
    if (!this.onIngest) return;
    try {
      this.onIngest(info);
    } catch (err) {
      logWatcher('watcher', info.file || '', `onIngest 回调异常 ${err.message}`);
    }
  }

  /** 轮询兜底：对每个适配器执行一次 harvest 对账摄取 */
  reconcile() {
    for (const adapter of this.adapters) {
      try {
        const result = harvest(adapter);
        if (result.ingested > 0 || result.removed > 0) {
          logWatcher(
            adapter.id,
            '',
            `poll 对账摄取 ${result.ingested} 条（文件 ${result.files}，移除 ${result.removed}）`,
          );
        }
        if (result.ingested > 0) {
          this.notifyIngest({ app: adapter.id, count: result.ingested, bytes: result.bytes || 0 });
        }
      } catch (err) {
        logWatcher(adapter.id, '', `poll 对账异常 ${err.message}`);
      }
    }
  }

  /** 事件去抖：同一路径 debounceMs 内的多次事件合并为一次处理 */
  schedule(filePath, event) {
    const key = path.resolve(filePath);
    if (this.pending.has(key)) {
      clearTimeout(this.pending.get(key));
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.processFile(key, event);
    }, this.debounceMs);
    this.pending.set(key, timer);
  }

  /**
   * 源文件删除：清理对账状态（sources 层快照保留，不可变）+ 删除传播登记。
   * 回环抑制：写回引擎自删（DELETED_INFLIGHT_SHA 哨兵）与 qoder 目录宽限窗口内的
   * 删除（客户端改名/清理）一律抑制，绝不误判为用户删除；
   * 去抖：编辑器「删 + 重建」原子保存会先 unlink 再 add——复用 pending Map，
   * 后续同 key 的 add/change schedule 会清掉本定时器，自动取消删除判定。
   */
  handleUnlink(filePath) {
    const adapter = findAdapterByPath(this.adapters, filePath);
    if (!adapter) return;
    const resolved = path.resolve(filePath);
    removeFileState(resolved);
    // 写回删除自回环：命中删除哨兵 → 消费条目并丢弃（绝不登记 tombstone）；
    // 先无副作用探测再消费，避免误消费其它 pending 写入的 inflight 条目
    const inflightEntry = loadInflightEntries()[resolved];
    if (inflightEntry && inflightEntry.sha256 === DELETED_INFLIGHT_SHA) {
      consumeInflight(resolved, DELETED_INFLIGHT_SHA);
      logWatcher(adapter.id, filePath, 'unlink 命中写回删除哨兵，丢弃（自删回环）');
      return;
    }
    // 目录级宽限窗口（qoder 客户端改名/重写）内的删除事件同样抑制
    for (const dir of Object.keys(loadDirWindows())) {
      if (resolved === dir || resolved.startsWith(`${dir}${path.sep}`)) {
        logWatcher(adapter.id, filePath, `unlink 命中目录宽限窗口（${dir}），丢弃`);
        return;
      }
    }
    logWatcher(adapter.id, filePath, 'unlink 源文件删除，已清理对账状态，待去抖确认删除传播');
    if (this.pending.has(resolved)) {
      clearTimeout(this.pending.get(resolved));
    }
    const timer = setTimeout(() => {
      this.pending.delete(resolved);
      this.recordUnlinkTombstones(resolved, adapter);
    }, this.debounceMs);
    this.pending.set(resolved, timer);
  }

  /**
   * 去抖到期后的删除传播落地：二次确认文件仍不存在 → 按源路径反查快照 hubId →
   * 登记 tombstone 清单（后续由 distill 消费打 wiki 标记、writeback 移除 App 侧条目）。
   * MUST-2 风暴熔断：走 addTombstonesGuarded——单适配器窗口内登记超阈值
   * （config.tombstone.stormThreshold）即熔断，后续 unlink 只记日志不登记，
   * 已登记的打 suspectedStorm 标记（自动传播跳过，需人工确认）。
   * 边界：聚合文件（如 codex AGENTS.md）内单条目删除不触发 unlink，本期不检测。
   * 异常只记日志，绝不影响 watcher 主流程。
   * @param {string} filePath 已 resolve 的源文件路径
   * @param {Object} adapter 所属适配器
   */
  recordUnlinkTombstones(filePath, adapter) {
    try {
      if (fs.existsSync(filePath)) return; // 去抖期内已重建（编辑器原子保存）：非真实删除
      const hubIds = findSnapshotHubIdsBySource(filePath);
      if (hubIds.length === 0) {
        logWatcher(adapter.id, filePath, 'unlink 未找到对应快照 hubId，跳过 tombstone 登记');
        return;
      }
      const tombCfg = this.config.tombstone || {};
      const { added, suppressed, tripped } = addTombstonesGuarded(
        hubIds.map((hubId) => ({ hubId, app: adapter.id, source: filePath })),
        { stormThreshold: tombCfg.stormThreshold, stormWindowMs: tombCfg.stormWindowMs },
      );
      if (tripped.length > 0) {
        logWatcher(
          adapter.id,
          filePath,
          `unlink 触发删除风暴熔断（窗口内登记超阈值），窗口内条目已打 suspectedStorm 标记，需 hub tombstone 人工确认`,
        );
      }
      if (suppressed.length > 0) {
        logWatcher(
          adapter.id,
          filePath,
          `unlink 风暴熔断中，本次 ${suppressed.length} 条仅记日志不登记 tombstone：${suppressed.join(',')}`,
        );
      }
      logWatcher(
        adapter.id,
        filePath,
        `unlink 已登记 tombstone ${added.length}/${hubIds.length} 条（删除传播）`,
      );
    } catch (err) {
      logWatcher(adapter.id, filePath, `unlink tombstone 登记异常 ${err.message}`);
    }
  }

  /**
   * 三级过滤的核心：对单个变化文件做 mtime 快筛 → sha 精判 → 摄取。
   * @param {string} filePath 文件绝对路径
   * @param {string} event chokidar 事件类型（add/change）
   */
  processFile(filePath, event) {
    const adapter = findAdapterByPath(this.adapters, filePath);
    if (!adapter) return;

    // M1 摄取白名单：监听目录下的非记忆文件（如用户文档）直接丢弃，
    // 防误摄取 → 发 LLM → 回灌五家；与各自 discover 口径保持一致。
    if (!adapter.isIngestible(filePath)) {
      logWatcher(adapter.id, filePath, 'skip 非白名单文件，丢弃');
      return;
    }

    const meta = readFileMeta(filePath);
    if (!meta) {
      // 读取失败（可能恰好被删）：清理状态
      removeFileState(filePath);
      return;
    }

    // 回环抑制：命中自写（精确路径+hash，或 qoder 目录级宽限窗口）直接丢弃。
    // M3：仅精确命中才同步记对账指纹；dirWindow 命中只丢弃事件不写指纹，
    // 否则窗口期内的真实外部修改会被永久漏摄取（窗口过期后轮询对账兜底）。
    const suppress = consumeInflight(filePath, meta.sha256);
    if (suppress) {
      if (suppress.match === 'exact') {
        recordFile(filePath, meta.sha256, meta.mtimeMs, adapter.id);
      }
      logWatcher(
        adapter.id,
        filePath,
        suppress.match === 'dirWindow'
          ? `suppress 命中目录宽限窗口（${suppress.dir}），丢弃`
          : 'suppress 命中自写回环，丢弃',
      );
      return;
    }

    const state = loadHashState();
    const rec = state.files[filePath];

    // 二级：mtime 快筛 —— 与 hash-state 比对，未变则直接跳过
    if (rec && rec.mtimeMs === meta.mtimeMs) {
      return;
    }
    // 三级：SHA-256 精判 —— 内容未变则仅跳过摄取（mtime 可能因 touch 变化）
    if (rec && rec.sha256 === meta.sha256) {
      recordFile(filePath, meta.sha256, meta.mtimeMs, adapter.id);
      return;
    }

    // 判定为新增或内容变化 → 解析并摄取
    const entries = adapter.parse(meta);
    for (const entry of entries) {
      ingest(adapter, entry, { recordState: false });
    }
    recordFile(filePath, meta.sha256, meta.mtimeMs, adapter.id);
    logWatcher(
      adapter.id,
      filePath,
      `${event} 摄取 ${entries.length} 条快照`,
    );
    if (entries.length > 0) {
      const bytes = entries.reduce((n, e) => n + String(e.body || '').length, 0);
      this.notifyIngest({ app: adapter.id, file: filePath, count: entries.length, bytes });
    }
  }

  /** 注册 SIGINT/SIGTERM 优雅退出（关闭 watcher + 清理定时器） */
  registerSignals() {
    const shutdown = (sig) => {
      logWatcher('watcher', '', `收到 ${sig}，优雅退出`);
      this.stop().finally(() => process.exit(0));
    };
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const handler = () => shutdown(sig);
      process.on(sig, handler);
      this._signalHandlers.push([sig, handler]);
    }
  }

  /**
   * 停止监听：关闭 chokidar、清空 debounce 定时器与轮询、摘除信号处理器。
   * @returns {Promise<void>}
   */
  async stop() {
    this.running = false;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [sig, handler] of this._signalHandlers) {
      process.off(sig, handler);
    }
    this._signalHandlers = [];
    if (this.chokidarWatcher) {
      await this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }
    logWatcher('watcher', '', 'stop 已停止');
  }
}

/**
 * 便捷工厂：创建并启动一个 watcher。
 * @param {Object} [config] 配置
 * @param {{ signals?: boolean }} [opts] 透传 start
 * @returns {Watcher}
 */
export function startWatcher(config, opts = {}) {
  return new Watcher(config).start(opts);
}
