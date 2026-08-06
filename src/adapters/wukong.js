/**
 * adapters/wukong.js —— 悟空（.real）记忆适配器（只读侧）。
 *
 * 实测格式（~/.real/users/<账号>/workspace/）：
 * - MEMORY.md：条目为 `## YYYY-MM-DD HH:MM UTC` 时间戳标题（也兼容普通 `## 标题`）+ 段落；
 * - USER.md / SOUL.md：同样按 `## 段落` 分节；
 * - 排除 MEMORY.md.lock 与 .sync_node 等一切隐藏/锁文件。
 *
 * watchPaths = config 中该 app 的 memory_paths（workspace 目录）。
 *
 * 写回侧（batch:3，高风险批次，默认禁用，需 config.writeback.batch3Enabled=true）：
 * - 目标 MEMORY.md，追加 `## <YYYY-MM-DD HH:MM UTC>` 时间戳标题段落（含 [hub-id] 标记）；
 * - 写前检查：MEMORY.md.lock 文件大小>0 或 .sync_node 近 5 分钟内有文件活动 →
 *   延迟重试（最多 3 次，间隔 30s，仍不行则放弃并记录）；重试参数可经 write opts 注入（测试用）；
 * - config apps[].readOnly=true（或 notes 含 readOnly）时该 app 只读不写回；
 * - verify 后提示云端同步覆盖风险与重放方式。
 */

import path from 'node:path';
import fs from 'node:fs';
import { BaseAdapter, makeEntry, isIgnoredPath } from './base.js';
import { splitH2Sections } from './codex.js';
import { statSafe, writeFilesSafely } from './write-utils.js';

/** 需要摄取的顶层文件名 */
const TOP_FILES = ['MEMORY.md', 'USER.md', 'SOUL.md'];

/** 写回成功后的固定提示（云端同步覆盖风险） */
export const WUKONG_WRITE_NOTE =
  '悟空存在云端同步覆盖风险，条目被覆盖后可用 hub writeback --app wukong 重放';

/** 默认锁等待重试参数（生产值；测试可经 write opts 注入小值） */
export const WUKONG_RETRY_DEFAULTS = { maxRetries: 3, retryDelayMs: 30000 };

/** .sync_node 视为“有同步活动”的时间窗（5 分钟） */
const SYNC_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 当前 UTC 时间戳标题：`YYYY-MM-DD HH:MM UTC`。
 * @param {Date} [d]
 * @returns {string}
 */
export function utcStamp(d = new Date()) {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * 检查悟空 workspace 是否处于同步忙碌状态（只读检查，绝不触碰锁文件本身）。
 * @param {string} dir workspace 目录
 * @returns {string|null} 忙碌原因（'lock'/'sync_node'）；空闲返回 null
 */
export function syncBusyReason(dir) {
  // 1) MEMORY.md.lock 文件大小 > 0 → 有进程持锁
  const lockPath = path.join(dir, 'MEMORY.md.lock');
  try {
    if (fs.statSync(lockPath).size > 0) return 'lock';
  } catch {
    // 锁文件不存在：视为空闲
  }
  // 2) .sync_node 目录近 5 分钟内有文件活动（递归检查）
  const syncNode = path.join(dir, '.sync_node');
  try {
    if (fs.statSync(syncNode).isDirectory()) {
      const now = Date.now();
      const stack = [syncNode];
      while (stack.length > 0) {
        const d = stack.pop();
        let items;
        try {
          items = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const it of items) {
          const full = path.join(d, it.name);
          try {
            const st = fs.statSync(full);
            if (now - st.mtimeMs < SYNC_ACTIVE_WINDOW_MS) return 'sync_node';
          } catch {
            // 条目恰好被删：跳过
          }
          if (it.isDirectory()) stack.push(full);
        }
      }
    }
  } catch {
    // .sync_node 不存在：视为空闲
  }
  return null;
}

export class WukongAdapter extends BaseAdapter {
  watchPaths() {
    return this.memoryPaths;
  }

  /** 每个 workspace 下的 MEMORY/USER/SOUL.md（排除 .lock / .sync_node / 隐藏项） */
  discover() {
    const files = [];
    for (const dir of this.memoryPaths) {
      for (const name of TOP_FILES) {
        const p = path.join(dir, name);
        if (isIgnoredPath(p)) continue;
        try {
          if (fs.statSync(p).isFile()) files.push(p);
        } catch {
          // 文件不存在：跳过
        }
      }
    }
    return files;
  }

  /** M1 摄取白名单：仅 workspace 顶层的 MEMORY.md / USER.md / SOUL.md（防任意非隐藏文件被摄取） */
  isIngestible(filePath) {
    if (!this.owns(filePath)) return false;
    const resolved = path.resolve(filePath);
    return this.memoryPaths.some(
      (dir) => path.dirname(resolved) === path.resolve(dir) && TOP_FILES.includes(path.basename(resolved)),
    );
  }

  parse(raw) {
    const sections = splitH2Sections(raw.content);
    return sections.map((sec) =>
      makeEntry({
        app: this.id,
        file: raw.path,
        title: sec.title,
        body: sec.body,
        frontmatter: sec.preamble
          ? { kind: 'preamble' }
          : { kind: 'section', source: path.basename(raw.path) },
        mtime: raw.mtimeMs,
        sha256: raw.sha256,
      }),
    );
  }

  // =========================================================================
  // 写回侧（batch:3 —— 高风险批次：默认禁用，需 writeback.batch3Enabled=true）
  // =========================================================================

  /** 是否被配置为只读（apps[].readOnly=true 或 notes 含 readOnly） */
  get readOnly() {
    return this.app.readOnly === true || /read[-_ ]?only/i.test(String(this.app.notes || ''));
  }

  /**
   * 渲染单条时间戳段落：`## <YYYY-MM-DD HH:MM UTC>` 标题 + 含 [hub-id] 的正文。
   * @param {Object} entry Entry（需含 hubId/title/body）
   * @param {string} stamp 时间戳标题（缺省现取 UTC）
   * @returns {string}
   */
  render(entry, stamp = utcStamp()) {
    return `## ${stamp}\n[${entry.hubId}] ${entry.title}\n${String(entry.body || '').trim()}`;
  }

  /**
   * 写回一组条目到每个 workspace 的 MEMORY.md（追加时间戳段落）。
   * 写前检查锁/同步活动，忙碌时延迟重试（默认最多 3 次、间隔 30s），仍不行则放弃并记录。
   * 幂等：MEMORY.md 已含 `[hub-id]` 标记的条目跳过。
   * @param {Object[]} entries Entry[]
   * @param {{ maxRetries?: number, retryDelayMs?: number }} [opts] 重试参数（测试可注入小值）
   * @returns {Promise<Object[]>} 逐条结果（written/skipped/deferred，含 note 提示）
   */
  async write(entries, opts = {}) {
    if (this.readOnly) {
      return entries.map((entry) => ({
        hubId: entry.hubId,
        status: 'skipped',
        reason: '已配置为只读（readOnly），不写回悟空',
      }));
    }
    const maxRetries = opts.maxRetries ?? WUKONG_RETRY_DEFAULTS.maxRetries;
    const retryDelayMs = opts.retryDelayMs ?? WUKONG_RETRY_DEFAULTS.retryDelayMs;
    const results = [];

    for (const dir of this.memoryPaths) {
      const memPath = path.join(dir, 'MEMORY.md');

      // 写前检查：锁文件/同步活动 → 延迟重试
      let busy = syncBusyReason(dir);
      let attempts = 0;
      while (busy !== null && attempts < maxRetries) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        busy = syncBusyReason(dir);
      }
      if (busy !== null) {
        // 重试耗尽仍忙碌：放弃并记录（不抛错，不阻塞其他条目/app）
        for (const entry of entries) {
          results.push({
            hubId: entry.hubId,
            status: 'deferred',
            reason: `悟空同步忙碌（${busy}），重试 ${attempts} 次后放弃，可稍后重放`,
          });
        }
        continue;
      }

      // H2b：读取前抓取 mtime/size 快照，写前二次比对，防云端同步/用户并发写入被覆盖
      const preStat = statSafe(memPath);
      const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : '';
      const pending = [];
      const sections = [];
      for (const entry of entries) {
        // 幂等：已含该 hub-id 标记 → 跳过
        if (entry.hubId && existing.includes(`[${entry.hubId}]`)) {
          results.push({ hubId: entry.hubId, status: 'skipped', targets: [memPath], reason: '已含 hub-id 标记' });
          continue;
        }
        pending.push(entry);
        sections.push(this.render(entry));
      }
      if (pending.length === 0) continue;

      const head = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
      const newContent = `${head}\n${sections.join('\n\n')}\n`;

      try {
        const { backupDir } = writeFilesSafely([
          {
            path: memPath,
            content: newContent,
            preStat,
            verifyOpts: { expectMarker: pending.map((e) => `[${e.hubId}]`) },
            app: this.id,
          },
        ]);
        for (const entry of pending) {
          results.push({ hubId: entry.hubId, status: 'written', targets: [memPath], backupDir, note: WUKONG_WRITE_NOTE });
        }
      } catch (err) {
        if (err.deferred) {
          for (const entry of pending) {
            results.push({ hubId: entry.hubId, status: 'deferred', targets: [memPath], reason: `目标文件读写间隙被外部修改（${err.message}），放弃本轮稍后重试` });
          }
          continue;
        }
        throw err;
      }
    }
    return results;
  }

  /**
   * 写回后校验：每个 workspace 的 MEMORY.md 均含各条目 [hub-id] 标记。
   * @param {Object[]} entries Entry[]
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  verify(entries) {
    const reasons = [];
    for (const dir of this.memoryPaths) {
      const memPath = path.join(dir, 'MEMORY.md');
      if (!fs.existsSync(memPath)) {
        reasons.push(`${memPath} 不存在`);
        continue;
      }
      const content = fs.readFileSync(memPath, 'utf8');
      for (const entry of entries) {
        if (!content.includes(`[${entry.hubId}]`)) {
          reasons.push(`${memPath} 缺少 [${entry.hubId}] 段落`);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }
}
