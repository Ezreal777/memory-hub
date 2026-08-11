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
  readFileSafe,
} from './base.js';
import { writeFilesSafely, removeFilesSafely, statSafe } from './write-utils.js';

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

  /** M1 摄取白名单：仅 memory 目录下的直接 .md 文件（防任意用户文档被摄取） */
  isIngestible(filePath) {
    if (!this.owns(filePath)) return false;
    const resolved = path.resolve(filePath);
    return (
      path.basename(resolved).endsWith('.md') &&
      this.memoryPaths.some((dir) => path.dirname(resolved) === path.resolve(dir))
    );
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
      // 跳过标题与孤立分隔线（distill 归并残留的 --- 不能当摘要）
      .find((l) => l && !l.startsWith('#') && !/^-{3,}$/.test(l)) || '';
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
    // 对象传参：gray-matter 收到字符串时会先把它当文档解析，正文以孤立 --- 开头
    // （distill 归并残留）时后续行会被误当 YAML 解析报错，对象形式跳过该解析
    return matter.stringify({ content: `${String(entry.body || '').trim()}\n` }, fm);
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
   * 幂等：条目文件已存在且含该 hub-id 标记 → 跳过（支持被覆盖后重放不重复）；
   * H2c 自愈：即便条目文件已含 hubId，也校验 MEMORY.md 是否含对应索引行，
   * 缺则补写（索引行丢失后不再永久丢失，重放即可自愈）。
   * H2b：写入前抓 mtime/size 守卫，读-写间隙被外部修改则记 deferred 下轮重试。
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
        const entryStat = statSafe(entryPath); // H2b：读取时 stat 守卫基准

        // 幂等：条目文件已含 hub-id 标记且内容无变化 → 跳过（仍校验索引行，H2c 自愈）；
        // 内容有变化（wiki 页归并更新）→ 落入下方更新路径重写条目文件并同步索引行
        let isUpdate = false;
        if (entry.hubId && fs.existsSync(entryPath)) {
          const existing = fs.readFileSync(entryPath, 'utf8');
          if (existing.includes(entry.hubId)) {
            if (existing === this.render(entry)) {
              const indexStat = statSafe(indexPath);
              const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
              if (!indexContent.includes(`(${fileName})`)) {
                // 索引行缺失：补写一行（绝不重写索引既有行），恢复重放自愈能力
                const indexLine = this.renderIndexLine(entry, fileName);
                const newIndexContent =
                  (indexContent ? indexContent.replace(/\s*$/, '\n') : '') + `${indexLine}\n`;
                try {
                  const { backupDir } = writeFilesSafely([
                    {
                      path: indexPath,
                      content: newIndexContent,
                      verifyOpts: { expectMarker: indexLine },
                      app: this.id,
                      preStat: indexStat,
                    },
                  ]);
                  results.push({
                    hubId: entry.hubId,
                    status: 'written',
                    targets: [indexPath],
                    backupDir,
                    reason: '条目已存在，补写缺失的 MEMORY.md 索引行（自愈）',
                  });
                } catch (err) {
                  if (err.deferred) {
                    results.push({ hubId: entry.hubId, status: 'deferred', reason: err.message });
                  } else {
                    throw err;
                  }
                }
                continue;
              }
              results.push({ hubId: entry.hubId, status: 'skipped', targets: [entryPath], reason: '已含 hub-id 标记且内容无变化' });
              continue;
            }
            isUpdate = true;
          }
        }

        const entryContent = this.render(entry);
        const indexStat = statSafe(indexPath); // H2b：索引读前抓守卫（每条目重新抓，覆盖前一条目刚写入的情况）
        const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
        const indexLine = this.renderIndexLine(entry, fileName);
        let newIndexContent;
        if (isUpdate && existingIndex.includes(`](${fileName})`)) {
          // 更新路径：原位替换指向该文件的旧索引行（标题/摘要可能已变），不追加重复行
          newIndexContent = existingIndex
            .split(/\r?\n/)
            .map((l) => (l.includes(`](${fileName})`) ? indexLine : l))
            .join('\n');
          if (!newIndexContent.endsWith('\n')) newIndexContent += '\n';
        } else {
          newIndexContent =
            (existingIndex ? existingIndex.replace(/\s*$/, '\n') : '') + `${indexLine}\n`;
        }

        // 备份 → registerInflight → 原子写 → verify（失败自动整体回滚；外部并发修改记 deferred）
        try {
          const { backupDir } = writeFilesSafely([
            {
              path: entryPath,
              content: entryContent,
              verifyOpts: { expectFrontmatter: true, expectMarker: entry.hubId },
              app: this.id,
              hubId: entry.hubId,
              preStat: entryStat,
            },
            {
              path: indexPath,
              content: newIndexContent,
              verifyOpts: { expectMarker: indexLine },
              app: this.id,
              preStat: indexStat,
            },
          ]);
          results.push({
            hubId: entry.hubId,
            status: 'written',
            targets: [entryPath, indexPath],
            backupDir,
            ...(isUpdate ? { reason: '内容有更新，重写条目文件并同步索引行' } : {}),
          });
        } catch (err) {
          if (err.deferred) {
            results.push({ hubId: entry.hubId, status: 'deferred', reason: err.message });
          } else {
            throw err;
          }
        }
      }
    }
    return results;
  }

  /**
   * 删除传播（tombstone）：移除含指定 hubId 的条目文件，并清理 MEMORY.md 中
   * 指向该文件的索引行。条目文件删除走 removeFilesSafely（备份 + 删除哨兵
   * inflight 登记，unlink 事件不回流 watcher）；索引重写走 writeFilesSafely
   * （H2b 守卫，被外部并发修改则记 deferred，条目删除不回退——索引行下轮自愈）。
   * @param {string[]} hubIds 待移除的 hubId 列表
   * @returns {Promise<Object[]>} 逐条结果 { hubId, status, targets, backupDir }
   */
  async removeEntries(hubIds) {
    const results = [];
    const wanted = (hubIds || []).filter(Boolean);
    if (wanted.length === 0) return results;
    for (const dir of this.memoryPaths) {
      const indexPath = path.join(dir, 'MEMORY.md');
      for (const hubId of wanted) {
        const candidates = listDirFiles(dir, (name) => name.endsWith('.md') && name !== 'MEMORY.md');
        const hit = candidates.find((p) => readFileSafe(p).includes(hubId));
        if (!hit) continue;
        const fileName = path.basename(hit);
        const { backupDir } = removeFilesSafely([{ path: hit, app: this.id, hubId }]);
        results.push({ hubId, status: 'removed', targets: [hit], backupDir });
        if (fs.existsSync(indexPath)) {
          const indexStat = statSafe(indexPath);
          const indexContent = fs.readFileSync(indexPath, 'utf8');
          if (indexContent.includes(`](${fileName})`)) {
            const newIndexContent = indexContent
              .split(/\r?\n/)
              .filter((l) => !l.includes(`](${fileName})`))
              .join('\n');
            try {
              writeFilesSafely([
                { path: indexPath, content: newIndexContent, app: this.id, preStat: indexStat },
              ]);
            } catch (err) {
              if (!err.deferred) throw err;
              // 索引被外部并发修改：条目文件已删不回退，孤行索引下轮写回/自愈时清理
              results.push({ hubId, status: 'deferred', targets: [indexPath], reason: `索引行清理推迟：${err.message}` });
            }
          }
        }
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
