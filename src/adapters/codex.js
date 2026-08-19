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
 * - 幂等：同 hub-id 重写不重复；合并后内容与原文完全一致时跳过写入；
 * - H1 多标记区自愈：历史坏文件可能含多个标记区（旧版只认首区，其余永久残留并
 *   积累重复块）——写路径发现 >1 个区时先提取全部区内块、按 hub-id 去重（保留最后
 *   出现的版本）、在首区位置重建单一区、移除其余区；verify 断言标记区计数必须为 1
 *   且无孤儿标记；
 * - Task#9 收敛增强（清理实战反馈：孤儿 end 多于 start、区外散落写回块）：repair 时
 *   一并清除全部无法配对的孤儿 start/end 标记行（连同紧邻空行规整，计 orphanMarkers），
 *   区外符合 `### 标题 [hub-…]` 特征的遗留块按保守边界（标题行到下一个标题/标记/文件尾）
 *   归并进重建的单一区参与 hub-id 去重（区内版本优先）；无法安全判定边界（如代码围栏
 *   未闭合）的只列入 strayBlocks 清单不动原文；非 hub- 前缀 id 的用户伪块与代码围栏内
 *   的内容永不触碰；clean 判定收紧为「区数≤1 且无孤儿标记 且无可归并区外块」；
 *   独立导出 repairFile() 供 CLI `hub writeback --repair` 接线（本模块不主动触碰真实文件）。
 */

import fs from 'node:fs';
import { BaseAdapter, makeEntry } from './base.js';
import { writeFilesSafely, statSafe } from './write-utils.js';

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
 * 找出全文中【全部】成对标记区（H1：不再只认首个）。
 * 孤立的 start（其后再无 end）不构成区，视为区外内容忽略。
 * @param {string} content AGENTS.md 全文
 * @returns {{ start: number, end: number, body: string }[]}
 *   start/end 为含首尾标记行的全文偏移（end 为区尾标记之后的偏移），body 为区内文本
 */
export function findHubRegions(content) {
  const regions = [];
  let idx = 0;
  for (;;) {
    const start = content.indexOf(HUB_MARK_START, idx);
    if (start === -1) break;
    const bodyStart = start + HUB_MARK_START.length;
    const end = content.indexOf(HUB_MARK_END, bodyStart);
    if (end === -1) break;
    regions.push({ start, end: end + HUB_MARK_END.length, body: content.slice(bodyStart, end) });
    idx = end + HUB_MARK_END.length;
  }
  return regions;
}

/**
 * 从全文中抽取标记区：返回区前/区内/区后三段；无标记区时 region 为 null。
 * H1：多区时 before/region/after 仍按首区切分，并附 count 供调用方判定是否需自愈。
 * @param {string} content AGENTS.md 全文
 * @returns {{ before: string, region: string|null, after: string, count: number }}
 */
export function splitHubRegion(content) {
  const regions = findHubRegions(content);
  if (regions.length === 0) {
    return { before: content, region: null, after: '', count: 0 };
  }
  const first = regions[0];
  return {
    before: content.slice(0, first.start),
    region: first.body,
    after: content.slice(first.end),
    count: regions.length,
  };
}

/** 任意级别标题行（区外遗留块的保守边界判定用） */
const HEADING_LINE_RE = /^#{1,6}\s/;
/** 代码围栏开合行（围栏内的伪块/标记属用户内容，永不触碰） */
const FENCE_RE = /^(```|~~~)/;

/** 统计子串出现次数。 */
function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/** 剔除块文本中残留的标记（整行标记删行，行内嵌标记剥子串），返回 trim 后文本。 */
function stripMarkerText(text) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === HUB_MARK_START || t === HUB_MARK_END) return null;
      return line.replaceAll(HUB_MARK_START, '').replaceAll(HUB_MARK_END, '');
    })
    .filter((line) => line !== null)
    .join('\n')
    .trim();
}

/**
 * 紧邻空行规整：删行后若删除点之前已是空行（或段首），吞掉后续连续空行，
 * 避免修复结果留下连续空行。返回调整后的行游标。
 */
function skipFollowingBlanks(lines, i, out) {
  if (out.length > 0 && out[out.length - 1].trim() !== '') return i;
  let j = i;
  while (j + 1 < lines.length && lines[j + 1].trim() === '') j += 1;
  return j;
}

/**
 * 从区外文本中收集一个疑似遗留写回块：保守边界 = 标题行到下一个标题行/标记行/段尾。
 * 块内代码围栏保持配对跟踪（围栏内的标题/标记不作边界）；扫描到段尾时围栏仍未闭合
 * 则判定「无法安全确定边界」（safe=false），调用方只列清单不动原文。
 * @param {string[]} lines 段内行数组
 * @param {number} start 标题行下标
 * @returns {{ endIndex: number, text: string, safe: boolean, reason?: string }}
 */
function collectStrayBlock(lines, start) {
  const body = [lines[start]];
  let fenceOpen = false;
  let j = start + 1;
  for (; j < lines.length; j += 1) {
    const t = lines[j].trim();
    if (FENCE_RE.test(t)) {
      fenceOpen = !fenceOpen;
      body.push(lines[j]);
      continue;
    }
    if (
      !fenceOpen &&
      (HEADING_LINE_RE.test(lines[j]) || lines[j].includes(HUB_MARK_START) || lines[j].includes(HUB_MARK_END))
    ) {
      break;
    }
    body.push(lines[j]);
  }
  if (fenceOpen) {
    return { endIndex: j, text: '', safe: false, reason: '代码围栏未闭合，无法安全判定块边界' };
  }
  return { endIndex: j, text: body.join('\n').trim(), safe: true };
}

/**
 * 清理一段区外文本：移除孤儿 start/end 标记行（连同紧邻空行规整）、提取可安全归并的
 * 区外 hub 块。保守原则：代码围栏内的内容一律不触碰（用户示例保护）；标题行 id 非
 * `hub-` 前缀的用户伪块不触碰；无法安全判定边界的块只列入 stray 清单原文保留。
 * @param {string} segment 区外文本段
 * @returns {{ text: string, orphanMarkers: number,
 *   merged: { hubId: string, title: string, text: string }[],
 *   stray: { hubId: string, title: string, reason: string }[] }}
 */
function cleanOutsideSegment(segment) {
  const lines = segment.split('\n');
  const out = [];
  let orphanMarkers = 0;
  const merged = [];
  const stray = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (FENCE_RE.test(t)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (t === HUB_MARK_START || t === HUB_MARK_END) {
      // 孤儿标记整行移除
      orphanMarkers += 1;
      i = skipFollowingBlanks(lines, i, out);
      continue;
    }
    if (line.includes(HUB_MARK_START) || line.includes(HUB_MARK_END)) {
      // 行内嵌标记（罕见）：只剥标记子串，行内其余文本保留
      orphanMarkers += countOccurrences(line, HUB_MARK_START) + countOccurrences(line, HUB_MARK_END);
      const rest = line.replaceAll(HUB_MARK_START, '').replaceAll(HUB_MARK_END, '');
      if (rest.trim()) {
        out.push(rest);
      } else {
        i = skipFollowingBlanks(lines, i, out);
      }
      continue;
    }
    const m = line.match(BLOCK_TITLE_RE);
    if (m && m[2].startsWith('hub-')) {
      const blk = collectStrayBlock(lines, i);
      if (blk.safe) {
        merged.push({ hubId: m[2], title: m[1].trim(), text: stripMarkerText(blk.text) });
        i = skipFollowingBlanks(lines, blk.endIndex - 1, out);
      } else {
        stray.push({ hubId: m[2], title: m[1].trim(), reason: blk.reason });
        out.push(line); // 不动原文：标题行原样保留，后续行走常规扫描
      }
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), orphanMarkers, merged, stray };
}

/**
 * 自愈（纯函数）：把损坏的 AGENTS.md 修复为单一标记区（H1 + Task#9 收敛增强）。
 * 提取全部区内块 → 按 hub-id 去重（顺序按首次出现，内容保留最后出现的版本）→
 * 清除区外全部孤儿 start/end 标记 → 区外遗留 hub 块保守归并（区内版本优先，只补缺）→
 * 在首个区位置重建单一区（无成对区但有块时在文末新建）→ 移除其余区；其余区外内容原样保留。
 * clean 判定：区数 ≤ 1 且孤儿标记 == 0 且无可归并区外块 → 原样返回（changed=false）；
 * 无法安全归并的区外块只列入 strayBlocks 清单，不动原文、不阻塞 clean（保证幂等收敛）。
 * @param {string} content AGENTS.md 全文
 * @returns {{ content: string, changed: boolean, regionCount: number,
 *   totalBlocks: number, uniqueBlocks: number, duplicateBlocks: number,
 *   orphanMarkers: number, strayBlocks: { hubId: string, title: string, reason: string }[] }}
 *   regionCount 为修复前成对区数；totalBlocks 含区外归并块
 */
export function repairAgentsContent(content) {
  const regions = findHubRegions(content);

  // 1. 区内块汇总：Map 保序（key 首次 set 定顺序，重复 set 覆盖 → 保留最后版本）；
  //    区内残留的孤儿标记（如嵌套 start）一并计数并随重建剔除
  const blockMap = new Map();
  let totalBlocks = 0;
  let orphanMarkers = 0;
  for (const r of regions) {
    orphanMarkers += countOccurrences(r.body, HUB_MARK_START) + countOccurrences(r.body, HUB_MARK_END);
    for (const b of parseRegionBlocks(r.body)) {
      totalBlocks += 1;
      blockMap.set(b.hubId, stripMarkerText(b.text));
    }
  }

  // 2. 区外文本切段清理：孤儿标记移除 + 区外遗留 hub 块识别
  const segments = [];
  let cursor = 0;
  for (const r of regions) {
    segments.push(content.slice(cursor, r.start));
    cursor = r.end;
  }
  segments.push(content.slice(cursor));
  const strayBlocks = [];
  const mergedStray = [];
  const cleaned = segments.map((seg) => {
    const c = cleanOutsideSegment(seg);
    orphanMarkers += c.orphanMarkers;
    strayBlocks.push(...c.stray);
    mergedStray.push(...c.merged);
    return c.text;
  });

  // 3. 区外块归并去重：区内版本优先（遗留块视为历史残渣），仅补区内缺失的 hub-id
  for (const b of mergedStray) {
    totalBlocks += 1;
    if (!blockMap.has(b.hubId)) blockMap.set(b.hubId, b.text);
  }

  // 4. clean 判定（收紧）：区数 ≤ 1 且无孤儿标记 且无可归并区外块 → 原样返回
  if (regions.length <= 1 && orphanMarkers === 0 && mergedStray.length === 0) {
    return {
      content,
      changed: false,
      regionCount: regions.length,
      totalBlocks,
      uniqueBlocks: blockMap.size,
      duplicateBlocks: totalBlocks - blockMap.size,
      orphanMarkers: 0,
      strayBlocks,
    };
  }

  // 5. 重建：单一区落在首区位置（无成对区但有块时在文末新建），其余区整体移除
  const regionText = `${HUB_MARK_START}\n${[...blockMap.values()].join('\n\n')}\n${HUB_MARK_END}`;
  let out;
  if (regions.length === 0) {
    out = cleaned[0];
    if (blockMap.size > 0) {
      const sep = out && !out.endsWith('\n') ? '\n' : '';
      out = `${out}${sep}${regionText}\n`;
    }
  } else {
    out = cleaned[0] + regionText + cleaned.slice(1).join('');
  }
  return {
    content: out,
    changed: out !== content,
    regionCount: regions.length,
    totalBlocks,
    uniqueBlocks: blockMap.size,
    duplicateBlocks: totalBlocks - blockMap.size,
    orphanMarkers,
    strayBlocks,
  };
}

/**
 * 自愈（落盘版）：修复单个 AGENTS.md 的多标记区/孤儿标记/区外遗留块问题。
 * 供 CLI `hub writeback --repair` 接线；走 writeFilesSafely（备份→原子写→校验→失败回滚）。
 * @param {string} filePath AGENTS.md 绝对路径
 * @returns {{ path: string, status: 'missing'|'clean'|'repaired', backupDir?: string,
 *   regionCount?: number, totalBlocks?: number, uniqueBlocks?: number, duplicateBlocks?: number,
 *   orphanMarkers?: number, strayBlocks?: { hubId: string, title: string, reason: string }[] }}
 *   orphanMarkers 为本次清除的孤儿标记数；strayBlocks 为无法安全归并、原文保留的区外块清单
 */
export function repairFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, status: 'missing' };
  }
  const preStat = statSafe(filePath);
  const original = fs.readFileSync(filePath, 'utf8');
  const r = repairAgentsContent(original);
  if (!r.changed) {
    return {
      path: filePath,
      status: 'clean',
      regionCount: r.regionCount,
      orphanMarkers: 0,
      strayBlocks: r.strayBlocks,
    };
  }
  // 修复结果可能不再含标记区（如全文只有孤儿标记且无任何块），expectMarker 按结果动态给定
  const expectMarker = findHubRegions(r.content).length > 0 ? [HUB_MARK_START, HUB_MARK_END] : [];
  const { backupDir } = writeFilesSafely([
    {
      path: filePath,
      content: r.content,
      verifyOpts: { expectMarker },
      app: 'codex',
      preStat,
    },
  ]);
  return {
    path: filePath,
    status: 'repaired',
    backupDir,
    regionCount: r.regionCount,
    totalBlocks: r.totalBlocks,
    uniqueBlocks: r.uniqueBlocks,
    duplicateBlocks: r.duplicateBlocks,
    orphanMarkers: r.orphanMarkers,
    strayBlocks: r.strayBlocks,
  };
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

/** 自尾部保留最多 n 个（n≤0 空集）。注：不可用 slice(-n)——n=0 时 slice(-0)=全量 */
const capTail = (arr, n) => (n <= 0 ? [] : arr.length > n ? arr.slice(-n) : arr);

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
    // 回声断根（echo-storm 2026-08-19）：只摄取标记区外的用户/CLI 原生内容。
    // 区内是 hub 写回的条目——wiki 页正文自带 H2 结构，曾按全文切节导致
    // 写回 → 全量重摄取 → 蒸馏 → 再写回的指数雪球（单文件滚到 11MB/1.3 万 H2）。
    // 无标记区的纯用户文件行为不变（before=全文）。
    const { before, after } = splitHubRegion(raw.content);
    const sections = splitH2Sections(`${before}\n${after}`);
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
   * 标记区条目上限（echo-storm 2026-08-19）：AGENTS.md 是 Codex CLI 每次会话
   * 加载的配置文件，全量写回会把它滚成巨无霸（实测 11MB/1.2 万块）。
   * config.apps[].maxRegionEntries 可覆盖，默认 120。
   */
  get maxRegionEntries() {
    const n = Number(this.app.maxRegionEntries);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
  }

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
    // H1/Task#9 自愈：写路径发现多标记区/孤儿标记/区外遗留块时，先收敛为单一区再做
    // 常规「整区重写」，历史坏文件随下一次写回自动痊愈
    const healed = repairAgentsContent(original).content;
    const { before, region, after } = splitHubRegion(healed);
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
    // 条目硬上限（echo-storm 2026-08-19）：合并后按三档优先裁到 maxEntries——
    // core 条目（每轮重申，永不淘汰）＞本轮写入 ＞旧块（各档内保最新、淘汰最旧）。
    // 写回引擎每轮传全量 wiki 条目，仅裁旧块挡不住全量轮，必须对终态硬限。
    const maxEntries = this.maxRegionEntries;
    const coreIds = new Set(entries.filter((e) => e.tier === 'core').map((e) => e.hubId));
    const keepIds = new Set(entries.map((e) => e.hubId));
    const freshCore = [];
    const freshNorm = [];
    const staleAll = [];
    for (const [hubId, text] of blockMap) {
      if (coreIds.has(hubId)) freshCore.push(text);
      else if (keepIds.has(hubId)) freshNorm.push(text);
      else staleAll.push(text);
    }
    const cap = capTail;
    const keptCore = cap(freshCore, maxEntries);
    const keptFresh = cap(freshNorm, Math.max(0, maxEntries - keptCore.length));
    const keptOld = cap(staleAll, Math.max(0, maxEntries - keptCore.length - keptFresh.length));
    const truncated = blockMap.size - keptCore.length - keptFresh.length - keptOld.length;
    const regionBody = [...keptOld, ...keptCore, ...keptFresh].join('\n\n');
    const truncNote =
      truncated > 0
        ? `\n\n<!-- memory-hub: 标记区已达 ${maxEntries} 条上限，本轮淘汰 ${truncated} 条最旧记忆，完整内容见 Memory Hub wiki/ -->`
        : '';
    const regionText = `${HUB_MARK_START}\n${regionBody}${truncNote}\n${HUB_MARK_END}`;
    if (region === null) {
      // 区不存在 → 文末追加创建（Bug#6 修复：区外内容逐字节原样保留，
      // 不多补空行；仅当原文末尾无换行时补一个换行分隔）
      const sep = healed && !healed.endsWith('\n') ? '\n' : '';
      return `${healed}${sep}${regionText}\n`;
    }
    return `${before}${regionText}${after}`;
  }

  /**
   * 写回一组条目到 config 中每个 AGENTS.md（标记区整区重写）。
   * 幂等：合并后内容与原文完全一致 → 跳过（重放不产生任何写入）。
   * H2b：读取时抓 mtime/size 守卫，写前二次 stat 不一致则记 deferred（下轮重试）。
   * @param {Object[]} entries Entry[]
   * @returns {Promise<Object[]>} 逐目标结果
   */
  async write(entries) {
    // 条目硬上限（echo-storm 2026-08-19）：先限量再写——本轮实际写入集 =
    // core 全保（≤max）+ 普通条目自新向旧补足剩余配额；被限掉的条目记
    // skipped（写后校验只认实际写入集，两者永远一致）。
    // AGENTS.md 是 Codex CLI 每次会话加载的配置文件，全量写回曾把它滚成
    // 11MB/1.2 万块，进而引发回声雪球。
    const maxEntries = this.maxRegionEntries;
    let toWrite = entries;
    if (entries.length > maxEntries) {
      const core = entries.filter((e) => e.tier === 'core');
      const norm = entries.filter((e) => e.tier !== 'core');
      const keptCore = capTail(core, maxEntries);
      const quota = Math.max(0, maxEntries - keptCore.length);
      const keptNorm = quota === 0 ? [] : norm.slice(-quota);
      // quota>0 时 slice(-quota) 安全；quota=0 归空集
      toWrite = [...keptCore, ...keptNorm];
    }
    const results = [];
    const keptIds = new Set(toWrite.map((e) => e.hubId));
    for (const e of entries) {
      if (!keptIds.has(e.hubId)) {
        results.push({
          hubId: e.hubId,
          status: 'skipped',
          targets: this.memoryPaths,
          reason: `标记区容量上限 ${maxEntries} 条（完整内容见 Memory Hub wiki/）`,
        });
      }
    }
    for (const agentsPath of this.memoryPaths) {
      const preStat = statSafe(agentsPath); // H2b：读取时 stat 守卫基准
      const original = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
      const merged = this.buildMergedContent(original, toWrite);
      if (merged === original) {
        results.push({
          hubId: toWrite.map((e) => e.hubId).join(','),
          status: 'skipped',
          targets: [agentsPath],
          reason: '标记区内容无变化',
        });
        continue;
      }
      try {
        const { backupDir } = writeFilesSafely([
          {
            path: agentsPath,
            content: merged,
            verifyOpts: {
              expectMarker: [HUB_MARK_START, HUB_MARK_END, ...toWrite.map((e) => `[${e.hubId}]`)],
            },
            app: this.id,
            preStat,
          },
        ]);
        for (const entry of toWrite) {
          results.push({ hubId: entry.hubId, status: 'written', targets: [agentsPath], backupDir });
        }
      } catch (err) {
        if (err.deferred) {
          // H2b：读-写间隙被 App/用户追加过内容 → 放弃本轮，下轮基于新内容重合并
          for (const entry of toWrite) {
            results.push({ hubId: entry.hubId, status: 'deferred', targets: [agentsPath], reason: err.message });
          }
        } else {
          throw err;
        }
      }
    }
    return results;
  }

  /**
   * 删除传播：从每个 AGENTS.md 标记区内移除指定 hubId 的条目块（区外内容永不触碰）。
   * 先自愈多区再整区重写，走 writeFilesSafely（备份→inflight→原子写→校验→失败回滚）；
   * 无命中块的文件不产生任何写入（幂等，重放安全）。
   * @param {string[]} hubIds 待移除的 hub-id 列表
   * @returns {Promise<Object[]>} 逐命中结果 { hubId, status: 'removed'|'deferred', targets, backupDir? }
   */
  async removeEntries(hubIds) {
    const wanted = new Set(hubIds || []);
    const results = [];
    if (wanted.size === 0) return results;
    for (const agentsPath of this.memoryPaths) {
      if (!fs.existsSync(agentsPath)) continue;
      const preStat = statSafe(agentsPath); // H2b：读取时 stat 守卫基准
      const original = fs.readFileSync(agentsPath, 'utf8');
      const healed = repairAgentsContent(original).content; // H1/Task#9：先收敛为单一区
      const { before, region, after } = splitHubRegion(healed);
      if (region === null) continue;
      const blocks = parseRegionBlocks(region);
      const hit = blocks.filter((b) => wanted.has(b.hubId));
      if (hit.length === 0) continue;
      const keep = blocks.filter((b) => !wanted.has(b.hubId));
      const regionText = `${HUB_MARK_START}\n${keep.map((b) => b.text).join('\n\n')}\n${HUB_MARK_END}`;
      const merged = `${before}${regionText}${after}`;
      try {
        const { backupDir } = writeFilesSafely([
          {
            path: agentsPath,
            content: merged,
            verifyOpts: { expectMarker: [HUB_MARK_START, HUB_MARK_END] },
            app: this.id,
            preStat,
          },
        ]);
        for (const b of hit) {
          results.push({ hubId: b.hubId, status: 'removed', targets: [agentsPath], backupDir });
        }
      } catch (err) {
        if (err.deferred) {
          // 读-写间隙被外部修改 → 本轮放弃，下轮基于新内容重新移除
          for (const b of hit) {
            results.push({ hubId: b.hubId, status: 'deferred', targets: [agentsPath], reason: err.message });
          }
        } else {
          throw err;
        }
      }
    }
    return results;
  }

  /**
   * 写回后校验：标记区计数必须为 1（H1）+ 无孤儿标记（Task#9）+ 每个条目的 hub-id 均在区内。
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
      const regions = findHubRegions(content);
      // 孤儿标记断言：与 repairAgentsContent 同一套判定（成对区之外的任何标记即孤儿，
      // 代码围栏内的用户示例除外），保证 verify 与 repair 的收敛口径一致
      const heal = repairAgentsContent(content);
      if (heal.orphanMarkers > 0) {
        reasons.push(
          `${agentsPath} 存在 ${heal.orphanMarkers} 个孤儿 memory-hub 标记（需 repairFile 自愈）`,
        );
      }
      if (regions.length === 0) {
        reasons.push(`${agentsPath} 缺少 memory-hub 标记区`);
        continue;
      }
      if (regions.length !== 1) {
        reasons.push(
          `${agentsPath} 存在 ${regions.length} 个 memory-hub 标记区（应为 1，需 repairFile 自愈）`,
        );
      }
      const regionBody = regions.map((r) => r.body).join('\n');
      for (const entry of entries) {
        if (!regionBody.includes(`[${entry.hubId}]`)) {
          reasons.push(`${agentsPath} 标记区内缺少 ${entry.hubId}`);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }
}
