/**
 * index-builder.js —— master-index 主索引重建模块（H7 修复）。
 *
 * 背景：旧索引由 hub-store.generateMasterIndex 生成，存在三类问题——
 * 漏收页面（46 个）、头部计数过期、每行 hub-id 字段全空。
 * 本模块独立于 hub-store（cli.js 的 `hub index` 接线由后续集成任务处理），
 * 供 distill 每轮成功后自动调用：
 * - 全量扫描 wiki/（递归、跳过 README.md 占位与隐藏文件），绝不漏页；
 * - 头部计数用实际扫描值；
 * - 逐页解析 frontmatter，把 hub-id 回填到对应索引行（frontmatter 损坏时容错降级）。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { FILE_MODE } from './util/paths.js';
import { atomicWrite } from './safe-write.js';
import { storePaths, ensureHubStore } from './hub-store.js';
import { listCorePages } from './core-store.js';

/**
 * 递归收集 wiki/ 下的 .md 页面（跳过 README.md 占位与隐藏文件）。
 * @returns {string[]} 页面绝对路径（排序稳定）
 */
export function listWikiPages() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') {
        out.push(full);
      }
    }
  };
  walk(storePaths.wiki);
  return out.sort();
}

/**
 * 从页面正文提取一行摘要（首个非空、非标题行，截断至 80 字符）。
 * @param {string} content 页面正文（不含 frontmatter）
 * @returns {string}
 */
function pageSummary(content) {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('---')) continue;
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  }
  return '';
}

/**
 * 解析单个 wiki 页面的索引元数据（frontmatter 损坏时容错：hub-id 记空，正文原样取摘要）。
 * @param {string} file 页面绝对路径
 * @returns {{ rel: string, title: string, summary: string, hubIds: string[] }}
 */
export function readPageIndexMeta(file) {
  const rel = path.relative(storePaths.wiki, file);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  let fm = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    fm = parsed.data || {};
    body = String(parsed.content || '');
  } catch {
    // frontmatter 损坏：hub-id 留空，正文整体当 body 取摘要（索引绝不因单页损坏而缺行）
  }
  const rawIds = fm['hub-id'];
  const hubIds = Array.isArray(rawIds) ? rawIds.map(String) : rawIds ? [String(rawIds)] : [];
  const titleMatch = body.match(/^#\s+(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : String(fm.title || path.basename(file, '.md'));
  return { rel, title, summary: pageSummary(body), hubIds };
}

/**
 * 全量重建 _index/master-index.md：包含全部页面、头部计数用实际值、
 * 每行回填该页 frontmatter 的 hub-id（H7）。
 * 核心记忆（wiki/core/）独立成段置顶，与主题页分层展示。
 * 可独立调用（distill 每轮成功后自动执行；CLI `hub index` 的接线由集成任务处理）。
 * @returns {string} 生成的主索引文件路径
 */
export function rebuildMasterIndex() {
  ensureHubStore();
  // core 已提升为顶层目录（与 wiki 平级）：主题页与核心页分別枚举
  const topicPages = listWikiPages();
  const corePages = listCorePages();
  const pages = [...corePages, ...topicPages];
  const lines = ['# Master Index —— 中转站目录索引', ''];
  const pushPageLine = (p, relOverride) => {
    const meta = readPageIndexMeta(p);
    const rel = relOverride ?? meta.rel;
    const idPart = `hub-id: ${meta.hubIds.length > 0 ? meta.hubIds.join(', ') : '无'}`;
    lines.push(`- [${meta.title}](${rel})${meta.summary ? ` — ${meta.summary}` : ''}（${idPart}）`);
  };
  if (pages.length === 0) {
    lines.push(
      '> 当前 wiki/ 整理层尚无任何页面。',
      '> 待 distill（整理）任务将 sources/ 快照提炼为 wiki 页面后，本索引将自动列出一行一摘要。',
      '',
    );
  } else {
    if (corePages.length > 0) {
      lines.push(`## 核心记忆（长期，${corePages.length} 页）`, '');
      for (const p of corePages) pushPageLine(p, path.relative(storePaths.root, p));
      lines.push('');
    }
    lines.push(`## 主题页（${topicPages.length} 页）`, '');
    for (const p of topicPages) pushPageLine(p);
    lines.push('');
  }
  atomicWrite(storePaths.masterIndex, lines.join('\n'), { mode: FILE_MODE });
  return storePaths.masterIndex;
}
