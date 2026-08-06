/**
 * adapters/qoderwork.js —— QoderWork（awareness）记忆适配器（只读侧）。
 *
 * 实测格式（~/.qoderwork/awareness/main/）：
 * - MEMORY.md / USER.md：条目间以独占一行的 `§` 分隔；每条目可选
 *   `<!-- importance: N -->` 注释 + `## 标题` + 正文（部分旧条目为无标题纯段落）。
 * - SOUL.md：协作风格文档，按 `## 段落` 分节。
 * - memory/*.md daily 文件：以 `<!-- memory-chat:<id> --> ... <!-- /memory-chat:<id> -->`
 *   包裹的会话块，块内可含 `## Session: 标题`。
 * - 一律排除所有 . 开头文件与 sqlite / 索引 / 状态文件。
 *
 * watchPaths = config 中该 app 的 memory_paths（awareness/main 目录）。
 *
 * 写回侧（batch:3，高风险批次，默认禁用，需 config.writeback.batch3Enabled=true）：
 * - 【只追加】当天 memory/YYYY-MM-DD.md（不存在则创建），内容用
 *   `<!-- memory-chat:<hubId> -->` 与 `<!-- /memory-chat:<hubId> -->` 包裹，模拟原生 daily 格式；
 * - 绝不写 MEMORY.md / USER.md / SOUL.md 与任何索引文件；
 * - verify 后提示：需新会话对账或手动重建搜索索引才可被检索。
 */

import path from 'node:path';
import fs from 'node:fs';
import { BaseAdapter, makeEntry, listDirFiles, isIgnoredPath } from './base.js';
import { statSafe, writeFilesSafely } from './write-utils.js';

/** 写回成功后的固定提示（索引型，需对账/重建索引） */
export const QODERWORK_WRITE_NOTE =
  '写入 daily memory 后需 QoderWork 新会话或手动重建搜索索引才可被检索';

/**
 * 当天日期串 YYYY-MM-DD（本地时区）。
 * @param {Date} [d]
 * @returns {string}
 */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** importance 注释：`<!-- importance: normal -->` */
const IMPORTANCE_RE = /<!--\s*importance:\s*([A-Za-z0-9_-]+)\s*-->/;
/** memory-chat 会话块（成对注释包裹，id 用反向引用配对） */
const CHAT_BLOCK_RE = /<!--\s*memory-chat:([\w-]+)\s*-->([\s\S]*?)<!--\s*\/memory-chat:\1\s*-->/g;

/** 顶层固定文件名（非 daily） */
const TOP_FILES = ['MEMORY.md', 'USER.md', 'SOUL.md'];

export class QoderworkAdapter extends BaseAdapter {
  watchPaths() {
    return this.memoryPaths;
  }

  /** MEMORY/USER/SOUL.md + memory/*.md（排除一切 . 开头与索引文件） */
  discover() {
    const files = [];
    for (const dir of this.memoryPaths) {
      for (const name of TOP_FILES) {
        const p = path.join(dir, name);
        if (!isIgnoredPath(p) && fs.existsSync(p)) files.push(p);
      }
      const dailyDir = path.join(dir, 'memory');
      files.push(...listDirFiles(dailyDir, (name) => name.endsWith('.md')));
    }
    return files;
  }

  /** M1 摄取白名单：顶层三个固定 md + memory/*.md（防任意用户文档被摄取） */
  isIngestible(filePath) {
    if (!this.owns(filePath)) return false;
    const resolved = path.resolve(filePath);
    return this.memoryPaths.some((dir) => {
      const root = path.resolve(dir);
      const parent = path.dirname(resolved);
      const name = path.basename(resolved);
      if (parent === root) return TOP_FILES.includes(name);
      if (parent === path.join(root, 'memory')) return name.endsWith('.md');
      return false;
    });
  }

  parse(raw) {
    const base = path.basename(raw.path);
    if (base === 'MEMORY.md' || base === 'USER.md') {
      return this.parseAwarenessBlocks(raw);
    }
    if (base === 'SOUL.md') {
      return this.parseSections(raw);
    }
    // memory/ 下的 daily 会话文件
    return this.parseDailyChat(raw);
  }

  /** MEMORY.md / USER.md：按独占行的 § 分块，逐块抽取 importance / 标题 / 正文 */
  parseAwarenessBlocks(raw) {
    const blocks = raw.content.split(/^\s*§\s*$/m);
    const entries = [];
    for (const block of blocks) {
      let text = block.trim();
      if (!text) continue;
      let importance;
      const im = text.match(IMPORTANCE_RE);
      if (im) {
        importance = im[1];
        text = text.replace(IMPORTANCE_RE, '').trim();
      }
      // 抽取首个 `## 标题`（若有）
      const lines = text.split(/\r?\n/);
      let title = '';
      let bodyStart = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const m = lines[i].match(/^##\s+(.*)$/);
        if (m) {
          title = m[1].trim();
          bodyStart = i + 1;
          break;
        }
        if (lines[i].trim() !== '') break; // 首个非空行不是 ##，则无标题
      }
      const body = title ? lines.slice(bodyStart).join('\n').trim() : text;
      if (!title) {
        // 无标题纯段落：取首个非空行截断作为标题
        const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
        title = firstLine.trim().slice(0, 40) || '(无标题)';
      }
      entries.push(
        makeEntry({
          app: this.id,
          file: raw.path,
          title,
          body,
          frontmatter: { importance, kind: path.basename(raw.path) },
          mtime: raw.mtimeMs,
          sha256: raw.sha256,
        }),
      );
    }
    return entries;
  }

  /** SOUL.md：按 `## ` 二级标题分节 */
  parseSections(raw) {
    const lines = raw.content.split(/\r?\n/);
    const entries = [];
    let current = null;
    for (const line of lines) {
      const m = line.match(/^##\s+(.*)$/);
      if (m) {
        if (current) entries.push(current);
        current = { title: m[1].trim(), body: [] };
      } else if (current) {
        current.body.push(line);
      }
    }
    if (current) entries.push(current);
    return entries.map((sec) =>
      makeEntry({
        app: this.id,
        file: raw.path,
        title: sec.title,
        body: sec.body.join('\n').trim(),
        frontmatter: { kind: 'soul' },
        mtime: raw.mtimeMs,
        sha256: raw.sha256,
      }),
    );
  }

  /** memory/*.md daily：抽取 memory-chat 会话块 */
  parseDailyChat(raw) {
    const entries = [];
    CHAT_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = CHAT_BLOCK_RE.exec(raw.content)) !== null) {
      const [, chatId, inner] = m;
      const text = inner.trim();
      // 标题：优先 `## Session: X` / `## X`，否则用 chatId
      const titleMatch = text.match(/^##\s+(?:Session:\s*)?(.*)$/m);
      const title = titleMatch ? titleMatch[1].trim() : `chat:${chatId}`;
      entries.push(
        makeEntry({
          app: this.id,
          file: raw.path,
          title,
          body: text,
          frontmatter: { kind: 'memory-chat', chatId },
          mtime: raw.mtimeMs,
          sha256: raw.sha256,
        }),
      );
    }
    return entries;
  }

  // =========================================================================
  // 写回侧（batch:3 —— 高风险批次：默认禁用，需 writeback.batch3Enabled=true）
  // =========================================================================

  /**
   * 渲染单条 daily 会话块（模拟原生格式：成对 memory-chat 注释包裹）。
   * @param {Object} entry Entry（hubId 用作 chat id，保证幂等标记唯一）
   * @returns {string}
   */
  render(entry) {
    const inner = `## Session: ${entry.title}\n${String(entry.body || '').trim()}`;
    return `<!-- memory-chat:${entry.hubId} -->\n${inner}\n<!-- /memory-chat:${entry.hubId} -->`;
  }

  /**
   * 写回一组条目：【只追加】当天 memory/YYYY-MM-DD.md（不存在则创建）。
   * 绝不写 MEMORY.md/USER.md/SOUL.md 与任何索引文件。
   * 幂等：当天 daily 文件已含 `memory-chat:<hubId>` 标记 → 跳过。
   * @param {Object[]} entries Entry[]
   * @returns {Promise<Object[]>} 逐条结果（含 note 提示）
   */
  async write(entries) {
    const results = [];
    const dateStr = todayStr();
    for (const dir of this.memoryPaths) {
      const dailyPath = path.join(dir, 'memory', `${dateStr}.md`);
      for (const entry of entries) {
        // H2b：读取前抓取 mtime/size 快照，写前二次比对，防 App/用户并发追加被覆盖
        const preStat = statSafe(dailyPath);
        const existing = fs.existsSync(dailyPath) ? fs.readFileSync(dailyPath, 'utf8') : '';

        // 幂等：已含该 hub-id 的 memory-chat 块 → 跳过
        if (existing.includes(`memory-chat:${entry.hubId}`)) {
          results.push({ hubId: entry.hubId, status: 'skipped', targets: [dailyPath], reason: '已含 hub-id 标记' });
          continue;
        }

        const block = this.render(entry);
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        const newContent = existing + sep + (existing || sep ? '\n' : '') + `${block}\n`;

        let backupDir;
        try {
          ({ backupDir } = writeFilesSafely([
            {
              path: dailyPath,
              content: newContent,
              preStat,
              verifyOpts: {
                expectMarker: [`memory-chat:${entry.hubId}`, `/memory-chat:${entry.hubId}`],
              },
              app: this.id,
              hubId: entry.hubId,
            },
          ]));
        } catch (err) {
          if (err.deferred) {
            results.push({ hubId: entry.hubId, status: 'deferred', targets: [dailyPath], reason: `目标文件读写间隙被外部修改（${err.message}），放弃本轮稍后重试` });
            continue;
          }
          throw err;
        }
        results.push({ hubId: entry.hubId, status: 'written', targets: [dailyPath], backupDir, note: QODERWORK_WRITE_NOTE });
      }
    }
    return results;
  }

  /**
   * 写回后校验：当天 daily 文件中成对 memory-chat 标记均存在。
   * @param {Object[]} entries Entry[]
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  verify(entries) {
    const reasons = [];
    const dateStr = todayStr();
    for (const dir of this.memoryPaths) {
      const dailyPath = path.join(dir, 'memory', `${dateStr}.md`);
      if (!fs.existsSync(dailyPath)) {
        reasons.push(`${dailyPath} 不存在`);
        continue;
      }
      const content = fs.readFileSync(dailyPath, 'utf8');
      for (const entry of entries) {
        if (!content.includes(`memory-chat:${entry.hubId}`)) {
          reasons.push(`${dailyPath} 缺少 memory-chat:${entry.hubId} 块`);
        }
        if (!content.includes(`/memory-chat:${entry.hubId}`)) {
          reasons.push(`${dailyPath} 缺少闭合标记 /memory-chat:${entry.hubId}`);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }
}
