/**
 * adapters/codex.js —— Codex 记忆适配器（只读侧 + 写回侧）。
 *
 * 实测格式：AGENTS.md 为纯 markdown，按 `## 段落` 分节；
 * 每个 `## 标题` 及其后续内容（含其下 `###` 小节）构成一个条目；
 * 首个 `##` 之前的前言（通常含 `# 一级标题`）若非空，单独作为「前言」条目。
 *
 * watchPaths = config 中该 app 的 memory_paths（一个或多个 AGENTS.md 文件路径，工作区级）。
 *
 * 写回侧（batch:1，低风险直接加载型，新会话即生效）：
 * - 在文件末尾维护 `<!-- memory-hub:start -->` 与 `<!-- memory-hub:end -->` 标记区；
 * - 区内每条 `### <标题> [hub-id]` + 正文；区外内容永不触碰；
 * - 区内更新用「整区重写」（读旧区 → 按 hub-id 合并替换 → 原子写），区不存在则追加创建；
 * - 幂等：同 hub-id 重写不重复；合并后内容与原文完全一致时跳过写入。
 */

import fs from 'node:fs';
import { BaseAdapter, makeEntry } from './base.js';
import { writeFilesSafely } from './write-utils.js';

/** 标记区开始注释 */
export const HUB_MARK_START = '<!-- memory-hub:start -->';
/** 标记区结束注释 */
export const HUB_MARK_END = '<!-- memory-hub:end -->';

/** 区内条目块标题行：`### 标题 [hub-id]` */
const BLOCK_TITLE_RE = /^###\s+(.*)\s+\[([\w-]+)\]\s*$/;

/**
 * 把标记区正文切分为 { hubId, title, text } 块列表（保留原始文本）。
 * @param {string} regionBody 标记区内文本（不含首尾标记行）
 * @returns {{ hubId: string, title: string, text: string }[]}
 */
export function parseRegionBlocks(regionBody) {
  const lines = regionBody.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(BLOCK_TITLE_RE);
    if (m) {
      if (current) blocks.push(current);
      current = { title: m[1].trim(), hubId: m[2], text: [line] };
    } else if (current) {
      current.text.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks.map((b) => ({ ...b, text: b.text.join('\n').trim() }));
}

/**
 * 从全文中抽取标记区：返回区前/区内/区后三段；无标记区时 region 为 null。
 * @param {string} content AGENTS.md 全文
 * @returns {{ before: string, region: string|null, after: string }}
 */
export function splitHubRegion(content) {
  const startIdx = content.indexOf(HUB_MARK_START);
  const endIdx = content.indexOf(HUB_MARK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { before: content, region: null, after: '' };
  }
  const before = content.slice(0, startIdx);
  const regionStart = startIdx + HUB_MARK_START.length;
  const region = content.slice(regionStart, endIdx);
  const after = content.slice(endIdx + HUB_MARK_END.length);
  return { before, region, after };
}

/**
 * 按 `## ` 二级标题把 markdown 切分为若干节。
 * @param {string} content markdown 全文
 * @returns {{ title: string, body: string, preamble: boolean }[]} 每节含标题与正文
 */
export function splitH2Sections(content) {
  const lines = content.split(/\r?\n/);
  const sections = [];
  let current = null;
  let preambleLines = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);
  const result = [];
  const preamble = preambleLines.join('\n').trim();
  if (preamble) {
    // 前言条目标题：取其 `# 一级标题`（若有），否则固定「前言」
    const h1 = preamble.match(/^#\s+(.*)$/m);
    result.push({ title: h1 ? h1[1].trim() : '前言', body: preamble, preamble: true });
  }
  for (const s of sections) {
    result.push({ title: s.title, body: s.body.join('\n').trim(), preamble: false });
  }
  return result;
}

export class CodexAdapter extends BaseAdapter {
  /** memory_paths 本身即 AGENTS.md 文件路径（工作区级，可能多个） */
  watchPaths() {
    return this.memoryPaths;
  }

  /** 仅保留当前仍存在于磁盘的 AGENTS.md */
  discover() {
    return this.memoryPaths.filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  }

  parse(raw) {
    const sections = splitH2Sections(raw.content);
    return sections.map((sec) =>
      makeEntry({
        app: this.id,
        file: raw.path,
        title: sec.title,
        body: sec.body,
        frontmatter: sec.preamble ? { kind: 'preamble' } : { kind: 'section' },
        mtime: raw.mtimeMs,
        sha256: raw.sha256,
      }),
    );
  }

  // =========================================================================
  // 写回侧（batch:1 —— 低风险批次：直接加载型，写入后新会话即生效）
  // =========================================================================

  /**
   * 渲染单条区内块：`### 标题 [hub-id]` + 正文。
   * @param {Object} entry Entry（需含 hubId/title/body）
   * @returns {string}
   */
  render(entry) {
    return `### ${entry.title} [${entry.hubId}]\n\n${String(entry.body || '').trim()}`;
  }

  /**
   * 构建合并后的完整文件内容（区外原封不动，区内按 hub-id 合并重写）。
   * @param {string} original 原文件内容（可为空串）
   * @param {Object[]} entries 本次待写入条目
   * @returns {string} 新全文
   */
  buildMergedContent(original, entries) {
    const { before, region, after } = splitHubRegion(original);
    // 旧区已有块（按 hub-id 索引）+ 本次条目覆盖/新增
    const blockMap = new Map();
    if (region !== null) {
      for (const b of parseRegionBlocks(region)) {
        blockMap.set(b.hubId, b.text);
      }
    }
    for (const entry of entries) {
      blockMap.set(entry.hubId, this.render(entry));
    }
    const regionBody = [...blockMap.values()].join('\n\n');
    const regionText = `${HUB_MARK_START}\n${regionBody}\n${HUB_MARK_END}`;
    if (region === null) {
      // 区不存在 → 文末追加创建（Bug#6 修复：区外内容逐字节原样保留，
      // 不多补空行；仅当原文末尾无换行时补一个换行分隔）
      const sep = original && !original.endsWith('\n') ? '\n' : '';
      return `${original}${sep}${regionText}\n`;
    }
    return `${before}${regionText}${after}`;
  }

  /**
   * 写回一组条目到 config 中每个 AGENTS.md（标记区整区重写）。
   * 幂等：合并后内容与原文完全一致 → 跳过（重放不产生任何写入）。
   * @param {Object[]} entries Entry[]
   * @returns {Promise<Object[]>} 逐目标结果
   */
  async write(entries) {
    const results = [];
    for (const agentsPath of this.memoryPaths) {
      const original = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
      const merged = this.buildMergedContent(original, entries);
      if (merged === original) {
        results.push({
          hubId: entries.map((e) => e.hubId).join(','),
          status: 'skipped',
          targets: [agentsPath],
          reason: '标记区内容无变化',
        });
        continue;
      }
      const { backupDir } = writeFilesSafely([
        {
          path: agentsPath,
          content: merged,
          verifyOpts: {
            expectMarker: [HUB_MARK_START, HUB_MARK_END, ...entries.map((e) => `[${e.hubId}]`)],
          },
          app: this.id,
        },
      ]);
      for (const entry of entries) {
        results.push({ hubId: entry.hubId, status: 'written', targets: [agentsPath], backupDir });
      }
    }
    return results;
  }

  /**
   * 写回后校验：标记成对存在 + 每个条目的 hub-id 均在区内。
   * @param {Object[]} entries Entry[]
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  verify(entries) {
    const reasons = [];
    for (const agentsPath of this.memoryPaths) {
      if (!fs.existsSync(agentsPath)) {
        reasons.push(`${agentsPath} 不存在`);
        continue;
      }
      const content = fs.readFileSync(agentsPath, 'utf8');
      const { region } = splitHubRegion(content);
      if (region === null) {
        reasons.push(`${agentsPath} 缺少 memory-hub 标记区`);
        continue;
      }
      for (const entry of entries) {
        if (!region.includes(`[${entry.hubId}]`)) {
          reasons.push(`${agentsPath} 标记区内缺少 ${entry.hubId}`);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }
}
