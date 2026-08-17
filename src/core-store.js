/**
 * core-store.js —— 用户维度长期核心记忆层（wiki/core/）。
 *
 * 与 wiki 主题层的关系：
 * - wiki/ 顶层 = 主题维度整理页（distill 产出、compact 归并、短期同步各 App）；
 * - wiki/core/ = user 维度长期核心（仅 promote 管道写入，App 侧被清即由 writeback 重申复活）。
 *
 * 目录结构：
 *   wiki/core/user-profile.md      固定单页：身份、工作范围、沟通/交付偏好
 *   wiki/core/facts/<slug>.md      持久事实页（拍板口径、硬约束），每页一个原子事实
 *
 * core 页 frontmatter 契约（在 wiki 页契约上扩展）：
 *   hub-id: [hub-…]        复用 hubId 机制（genHubId 新发号，绝不与来源主题页共用——
 *                          共用会导致同一 hubId 两份渲染在 App 侧互相拉锯）
 *   tier: core             核心层标记（主题页无此字段，天然区分）
 *   category: user_info    写回 Qoder 时的目标 category（逐页指定）
 *   promoted-from: [...]   晋升来源（wiki 相对路径）追溯
 *   promoted-at / last-updated
 *   supersedes: [hub-…]    覆盖语义：本页取代的旧结论
 *
 * 隔离保证（依赖既有行为，由 test-promote.js 锁定）：
 * - compact.listCompactablePages 只扫 wiki 顶层文件，core/ 子目录不参与归并；
 * - distill 产出只写 wiki 顶层，永不写 core/。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { storePaths, genHubId } from './hub-store.js';
import { atomicWrite } from './safe-write.js';
import { ensureDir, FILE_MODE } from './util/paths.js';
import { slugify } from './adapters/base.js';

/** core 层路径（惰性 getter，随 MEMORY_HUB_ROOT 切换即时生效） */
export const corePaths = {
  /** 核心层根 wiki/core */
  get root() {
    return path.join(storePaths.wiki, 'core');
  },
  /** 持久事实页目录 wiki/core/facts */
  get facts() {
    return path.join(storePaths.wiki, 'core', 'facts');
  },
  /** 用户画像固定单页 wiki/core/user-profile.md */
  get userProfile() {
    return path.join(storePaths.wiki, 'core', 'user-profile.md');
  },
};

/** Qoder category 白名单校验（与 qoder.categoryOf 的合法字符集一致） */
const CATEGORY_RE = /^[A-Za-z0-9_-]+$/;

/** 缺省 category（core 页未指定时兜底；user-profile 固定 user_info） */
export const DEFAULT_CORE_CATEGORY = 'project_introduction';

/** 惰性创建 core 层目录结构 */
export function ensureCoreStore() {
  ensureDir(corePaths.facts);
}

/**
 * 判断一个绝对路径是否位于 core 层内。
 * @param {string} file 绝对路径
 * @returns {boolean}
 */
export function isCorePage(file) {
  const rel = path.relative(corePaths.root, path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 递归列出 core 层全部页面（跳过 README 与隐藏文件）。
 * @returns {string[]} 绝对路径，字典序
 */
export function listCorePages() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') out.push(full);
    }
  };
  walk(corePaths.root);
  return out.sort();
}

/** core 层当前页数（容量水位判断用） */
export function countCorePages() {
  return listCorePages().length;
}

/**
 * 读取并解析单个 core 页。
 * @param {string} file 绝对路径
 * @returns {{ file: string, slug: string, title: string, hubIds: string[], category: string,
 *   promotedFrom: string[], supersedes: string[], promotedAt: string, lastUpdated: string,
 *   body: string }|null} frontmatter 损坏或非 core 契约（缺 tier/hub-id）时返回 null
 */
export function readCorePage(file) {
  let parsed;
  try {
    parsed = matter(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const fm = parsed.data || {};
  if (fm.tier !== 'core') return null;
  const rawIds = fm['hub-id'];
  const hubIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
  if (hubIds.length === 0) return null;
  const body = String(parsed.content || '').trim();
  const titleMatch = body.match(/^#\s+(.*)$/m);
  const asArr = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  return {
    file,
    slug: path.basename(file, '.md'),
    title: String(titleMatch ? titleMatch[1] : fm.title || path.basename(file, '.md')).trim(),
    hubIds,
    category: CATEGORY_RE.test(String(fm.category || '')) ? String(fm.category) : DEFAULT_CORE_CATEGORY,
    promotedFrom: asArr(fm['promoted-from']),
    supersedes: asArr(fm.supersedes),
    promotedAt: String(fm['promoted-at'] || ''),
    lastUpdated: String(fm['last-updated'] || ''),
    body,
  };
}

/**
 * 写入（新建或原位更新）一个 core 页：契约校验 → frontmatter 组装 → 原子写。
 * - 新建：未传 file 时按 slugify(title) 落到 facts/ 下（撞名加序号），hubIds 新发号；
 * - 更新：传 file（或 slug 命中既有页）时保留原 hub-id 与 promoted-at，仅刷 last-updated。
 * @param {{
 *   file?: string,            // 目标绝对路径（缺省按 title 派生到 facts/）
 *   title: string,            // 页标题（正文首行渲染为 `# title`）
 *   body: string,             // 正文（不含 H1 标题行；空正文拒写）
 *   category?: string,        // Qoder 写回 category（非法值回落 DEFAULT_CORE_CATEGORY）
 *   promotedFrom?: string[],  // 晋升来源（wiki 相对路径）
 *   supersedes?: string[],    // 被取代的旧结论 hubId
 *   now?: string,             // 注入时间（测试用），缺省当前 ISO
 * }} input
 * @returns {{ file: string, hubIds: string[], created: boolean }}
 * @throws {Error} title/body 为空时拒写
 */
export function writeCorePage(input) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (!title) throw new Error('writeCorePage：title 不能为空');
  if (!body) throw new Error('writeCorePage：body 不能为空');
  ensureCoreStore();
  const now = input.now || new Date().toISOString();
  const category = CATEGORY_RE.test(String(input.category || '')) ? String(input.category) : DEFAULT_CORE_CATEGORY;

  // 目标路径：显式 file 优先；否则按 title 派生到 facts/（撞名且非同 title 页则加序号）
  let target = input.file ? path.resolve(input.file) : null;
  if (!target) {
    const slug = slugify(title) || `core-${Date.now()}`;
    target = path.join(corePaths.facts, `${slug}.md`);
    let n = 2;
    while (fs.existsSync(target) && readCorePage(target)?.title !== title) {
      target = path.join(corePaths.facts, `${slug}-${n}.md`);
      n += 1;
    }
  }
  if (!isCorePage(target)) throw new Error(`writeCorePage：目标必须位于 core 层内（${target}）`);

  const existing = fs.existsSync(target) ? readCorePage(target) : null;
  const hubIds = existing?.hubIds?.length ? existing.hubIds : [genHubId()];
  const promotedFrom = [
    ...new Set([...(existing?.promotedFrom || []), ...(input.promotedFrom || []).map(String)]),
  ];
  const supersedes = [...new Set([...(existing?.supersedes || []), ...(input.supersedes || []).map(String)])];

  const fm = {
    'hub-id': hubIds,
    tier: 'core',
    category,
    ...(promotedFrom.length > 0 ? { 'promoted-from': promotedFrom } : {}),
    'promoted-at': existing?.promotedAt || now,
    'last-updated': now,
    ...(supersedes.length > 0 ? { supersedes } : {}),
  };
  // 正文首行为 `# title`（与 wiki 页一致，writeback 的 wikiToEntries 从 H1 提取标题）
  const content = matter.stringify({ content: `# ${title}\n\n${body}\n` }, fm);
  atomicWrite(target, content, { mode: FILE_MODE });
  return { file: target, hubIds, created: !existing };
}
