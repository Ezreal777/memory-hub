/**
 * search.js —— hub search 关键词检索（grep 级，纯只读）。
 *
 * 对 wiki/ 目录做全文检索：标题（H1/frontmatter title）、tags、frontmatter、
 * 正文一律参与匹配；大小写不敏感；多关键词为 AND 关系（每个关键词都必须命中）。
 * 输出：命中页相对路径、标题、hub-id、首个命中行摘录（行号 + 内容截断）。
 * 结果按 wiki 文件名排序稳定输出，--limit 控制展示条数（缺省 20，总命中数照报）。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { storePaths } from './hub-store.js';
import { listWikiPages } from './index-builder.js';

/** 缺省最多展示的命中条数 */
export const DEFAULT_SEARCH_LIMIT = 20;

/** 命中行摘录最大长度（超出截断加省略号） */
const EXCERPT_MAX_CHARS = 120;

/**
 * 检索 wiki 页面。
 * @param {string[]|string} keywords 关键词（数组为 AND 关系；大小写不敏感）
 * @param {{ limit?: number }} [opts] limit 最多返回条数（缺省 20；总命中数不受影响）
 * @returns {{ keywords: string[], total: number, limit: number, results: {
 *   file: string, rel: string, title: string, hubIds: string[],
 *   lineNo: number, excerpt: string }[] }}
 */
export function searchWiki(keywords, opts = {}) {
  const kws = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k ?? '').trim())
    .filter(Boolean);
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_SEARCH_LIMIT;
  if (kws.length === 0) return { keywords: [], total: 0, limit, results: [] };
  const lowered = kws.map((k) => k.toLowerCase());

  let total = 0;
  const results = [];
  for (const file of listWikiPages()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // AND 匹配：全文（frontmatter + 正文）小写化后每个关键词都必须出现
    const hay = raw.toLowerCase();
    if (!lowered.every((k) => hay.includes(k))) continue;
    total += 1;
    if (results.length >= limit) continue; // 超出展示上限：只计数不收集

    // 页面元数据（frontmatter 损坏时容错降级：hub-id 记空、标题退化为文件名）
    let fm = {};
    let body = raw;
    try {
      const parsed = matter(raw);
      fm = parsed.data || {};
      body = String(parsed.content || '');
    } catch {
      // 容错降级
    }
    const rawIds = fm['hub-id'];
    const hubIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
    const titleMatch = body.match(/^#\s+(.*)$/m);
    const title = String(titleMatch ? titleMatch[1] : fm.title || path.basename(file, '.md')).trim();

    // 首个命中行摘录（任一关键词命中即取，1-based 行号）
    let lineNo = 0;
    let excerpt = '';
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase();
      if (lowered.some((k) => lower.includes(k))) {
        lineNo = i + 1;
        excerpt = lines[i].trim();
        break;
      }
    }
    if (excerpt.length > EXCERPT_MAX_CHARS) excerpt = `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…`;

    results.push({ file, rel: path.relative(storePaths.wiki, file), title, hubIds, lineNo, excerpt });
  }
  return { keywords: kws, total, limit, results };
}

/**
 * 把检索结果格式化为人类可读文本（CLI 输出用）。
 * @param {Object} res searchWiki 返回值
 * @returns {string}
 */
export function formatSearchResults(res) {
  if (!res || res.keywords.length === 0) return '请提供至少一个关键词（用法: hub search <关键词…>）';
  const truncated = res.total > res.results.length;
  const head = `关键词: ${res.keywords.join(' AND ')} —— 命中 ${res.total} 页${truncated ? `（仅显示前 ${res.results.length} 条，--limit 可调整）` : ''}`;
  if (res.total === 0) return `${head}\n（无命中；检索范围: ${storePaths.wiki}）`;
  const lines = [head];
  res.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.rel} · ${r.title}（hub-id: ${r.hubIds.length > 0 ? r.hubIds.join(', ') : '无'}）`);
    if (r.lineNo > 0) lines.push(`   L${r.lineNo}: ${r.excerpt}`);
  });
  return lines.join('\n');
}
