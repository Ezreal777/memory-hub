/**
 * adapters/claude.js —— Claude Code 记忆适配器（只读侧 + 写回侧）。
 *
 * 实测格式（~/.claude/projects/<项目>/memory/）：
 * 1. MEMORY.md 索引文件：每行形如 `- [标题](文件名.md) — 摘要`；
 * 2. 同目录独立条目 <name>.md：YAML frontmatter（name/description/metadata{node_type,type,...}）+ 正文。
 *
 * watchPaths = config 中该 app 的 memory_paths（即 .../memory 目录）。
 * parse 输出条目时保留 frontmatter 原始数据（frontmatter 字段）。
 *
 * 写回侧（batch:1，低风险直接加载型，新会话即生效）：
 * - write(entry) 双文件写入：新建条目文件 <slug>.md（frontmatter 含 hubId）
 *   + 向 MEMORY.md 末尾【只追加】一行索引（绝不重写索引既有行）；
 * - 幂等：写前读目标文件，条目文件已含该 hub-id 标记则整体跳过；
 * - 写入走 write-utils：备份 → registerInflight → 原子写 → verify → 失败整体回滚。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  BaseAdapter,
  makeEntry,
  listDirFiles,
  slugify,
} from './base.js';
import { writeFilesSafely } from './write-utils.js';

/** 索引行匹配：`- [标题](目标.md) — 摘要`（分隔符兼容 — / – / -） */
const INDEX_LINE_RE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*[—–-]?\s*(.*)$/;

/**
 * 安全解析 frontmatter：解析失败返回 { data: null, body: 原内容 }。
 * @param {string} content 文件内容
 * @returns {{ data: Object|null, body: string }}
 */
function parseFrontmatter(content) {
  try {
    const parsed = matter(content);
    // gray-matter 对无 frontmatter 的内容返回 data={}；用 orig 判断是否真有 frontmatter
    const hasFm = parsed.matter !== undefined || /^---\r?\n/.test(content);
    return { data: hasFm ? parsed.data : null, body: parsed.content };
  } catch {
    return { data: null, body: content };
  }
}

export class ClaudeAdapter extends BaseAdapter {
  watchPaths() {
    return this.memoryPaths;
  }

  /** 每个 memory 目录下的直接 .md 文件（MEMORY.md + 各独立条目） */
  discover() {
    const files = [];
    for (const dir of this.memoryPaths) {
      files.push(...listDirFiles(dir, (name) => name.endsWith('.md')));
    }
    return files;
  }

  parse(raw) {
    const base = path.basename(raw.path);
    if (base === 'MEMORY.md') {
      return this.parseIndex(raw);
    }
    return this.parseEntryFile(raw);
  }

  /** 解析 MEMORY.md 索引：每行一个条目（标题=链接文本，正文=摘要） */
  parseIndex(raw) {
    const entries = [];
    for (const line of raw.content.split(/\r?\n/)) {
      const m = line.match(INDEX_LINE_RE);
      if (!m) continue;
      const [, title, target, summary] = m;
      entries.push(
        makeEntry({
          app: this.id,
          file: raw.path,
          title: title.trim(),
          body: summary.trim(),
          frontmatter: { kind: 'index', target: target.trim() },
          mtime: raw.mtimeMs,
          sha256: raw.sha256,
        }),
      );
    }
    return entries;
  }

  /** 解析独立条目文件：YAML frontmatter + 正文 */
  parseEntryFile(raw) {
    const { data, body } = parseFrontmatter(raw.content);
    const title =
      (data && (data.name || data.description)) || path.basename(raw.path, '.md');
    return [
      makeEntry({
        app: this.id,
        file: raw.path,
        title: String(title).trim(),
        body: body.trim(),
        frontmatter: data || undefined,
        mtime: raw.mtimeMs,
        sha256: raw.sha256,
      }),
    ];
  }

  // =========================================================================
  // 写回侧（batch:1 —— 低风险批次：直接加载型，写入后新会话即生效）
  // =========================================================================

  /**
   * 取正文首个非空行作为一句话摘要（截断 80 字符）。
   * @param {string} body 正文
   * @returns {string}
   */
  summaryOf(body) {
    const line = String(body || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) || '';
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }

  /**
   * 渲染单个条目文件内容（YAML frontmatter + 正文）。
   * frontmatter：name（标题）/description（一句话摘要）/metadata{node_type,type,hubId}。
   * @param {Object} entry Entry（需含 hubId/title/body）
   * @returns {string} 完整文件文本
   */
  render(entry) {
    const fm = {
      name: entry.title,
      description: this.summaryOf(entry.body),
      metadata: {
        node_type: 'memory',
        type: 'hub-sync',
        hubId: entry.hubId,
      },
    };
    return matter.stringify(`${String(entry.body || '').trim()}\n`, fm);
  }

  /**
   * 渲染 MEMORY.md 索引行：`- [标题](文件名.md) — 摘要`。
   * @param {Object} entry Entry
   * @param {string} fileName 条目文件名（含 .md）
   * @returns {string}
   */
  renderIndexLine(entry, fileName) {
    return `- [${entry.title}](${fileName}) — ${this.summaryOf(entry.body)}`;
  }

  /**
   * 写回一组条目到 config memory_paths 的每个 memory 目录（双文件写入）。
   * 幂等：条目文件已存在且含该 hub-id 标记 → 跳过（支持被覆盖后重放不重复）。
   * @param {Object[]} entries Entry[]
   * @returns {Promise<Object[]>} 逐条结果 { hubId, status, targets, backupDir }
   */
  async write(entries) {
    const results = [];
    for (const dir of this.memoryPaths) {
      const indexPath = path.join(dir, 'MEMORY.md');
      for (const entry of entries) {
        const slug = slugify(entry.title || entry.hubId || 'hub-entry');
        // 目标文件名冲突防护：同名且不含本 hubId 标记（他人文件）则加序号
        let fileName = `${slug}.md`;
        let n = 2;
        while (
          fs.existsSync(path.join(dir, fileName)) &&
          !fs.readFileSync(path.join(dir, fileName), 'utf8').includes(entry.hubId)
        ) {
          fileName = `${slug}-${n}.md`;
          n += 1;
        }
        const entryPath = path.join(dir, fileName);

        // 幂等：条目文件已含 hub-id 标记 → 整体跳过
        if (entry.hubId && fs.existsSync(entryPath)) {
          const existing = fs.readFileSync(entryPath, 'utf8');
          if (existing.includes(entry.hubId)) {
            results.push({ hubId: entry.hubId, status: 'skipped', targets: [entryPath], reason: '已含 hub-id 标记' });
            continue;
          }
        }

        const entryContent = this.render(entry);
        const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
        const indexLine = this.renderIndexLine(entry, fileName);
        const newIndexContent =
          (existingIndex ? existingIndex.replace(/\s*$/, '\n') : '') + `${indexLine}\n`;

        // 备份 → registerInflight → 原子写 → verify（失败自动整体回滚）
        const { backupDir } = writeFilesSafely([
          {
            path: entryPath,
            content: entryContent,
            verifyOpts: { expectFrontmatter: true, expectMarker: entry.hubId },
            app: this.id,
            hubId: entry.hubId,
          },
          {
            path: indexPath,
            content: newIndexContent,
            verifyOpts: { expectMarker: indexLine },
            app: this.id,
          },
        ]);
        results.push({ hubId: entry.hubId, status: 'written', targets: [entryPath, indexPath], backupDir });
      }
    }
    return results;
  }

  /**
   * 写回后校验：条目文件 frontmatter 可解析 + MEMORY.md 索引行存在。
   * @param {Object[]} entries Entry[]
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  verify(entries) {
    const reasons = [];
    for (const dir of this.memoryPaths) {
      const indexPath = path.join(dir, 'MEMORY.md');
      const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
      for (const entry of entries) {
        // 找到含该 hubId 的条目文件
        const candidates = listDirFiles(dir, (name) => name.endsWith('.md') && name !== 'MEMORY.md');
        const hit = candidates.find((p) => fs.readFileSync(p, 'utf8').includes(entry.hubId));
        if (!hit) {
          reasons.push(`[${dir}] 未找到含 ${entry.hubId} 的条目文件`);
          continue;
        }
        const parsed = matter(fs.readFileSync(hit, 'utf8'));
        if (!parsed.data || !parsed.data.name) {
          reasons.push(`${hit} frontmatter 缺少 name 字段`);
        }
        const fileName = path.basename(hit);
        if (!indexContent.includes(`(${fileName})`)) {
          reasons.push(`MEMORY.md 缺少指向 ${fileName} 的索引行`);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }
}
