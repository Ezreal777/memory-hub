#!/usr/bin/env node
/**
 * qoder-retention-snapshot.js —— Qoder 侧 hub 写回记忆的留存快照。
 *
 * 每次运行向 state/qoder-retention.jsonl 追加一行快照：
 * - 各 slug 下 hub 写回文件（source: memory-hub）的存量与 hubId 集合；
 * - 与上一次快照 diff：removed（被清理）/ added（新写回）hubId 清单；
 * - core：wiki/core/ 核心层 hubId 集合（留存专项：重申覆盖率与复活次数）。
 * 数据用于评估：清理周期（半衰期）、清理偏好（category 分布）、写回净留存率、
 * 核心层重申成本（复活频率 = Qoder 整理机制与 reassert 的拉锯强度）。
 *
 * 用法：node scripts/qoder-retention-snapshot.js [--report]
 *   --report 只读模式：不追加快照，汇总 jsonl 输出留存曲线与半衰期估算。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.qoder/memories/019ea5c5/projects');
const SLUGS = ['Users-kuangju-Desktop', 'Qoder-Chats'];
const OUT = path.join(os.homedir(), '.memory-hub/state/qoder-retention.jsonl');
/** 核心层目录（wiki/core/，hubId 取自页 frontmatter） */
const CORE_DIR = path.join(os.homedir(), 'Desktop/Memory Hub/wiki/core');

const readSafe = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** 扫描一个 slug：返回 { count, byCategory, hubIds } */
function scanSlug(slug) {
  const base = path.join(ROOT, slug);
  const byCategory = {};
  const hubIds = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      const c = readSafe(p);
      if (!c || !/source:\s*['"]?memory-hub/.test(c)) continue;
      const m = c.match(/\[(hub-\d{14}-[a-z0-9]+)\]/);
      const cat = path.relative(base, p).split(path.sep)[0];
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      hubIds.push(m ? m[1] : `nomark:${path.relative(base, p)}`);
    }
  };
  walk(base);
  return { count: hubIds.length, byCategory, hubIds };
}

/** 扫描 wiki/core/ 收集核心层 hubId（frontmatter hub-id 行，逐页取全部） */
function scanCoreHubIds() {
  const ids = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.md') || e.name === 'README.md') continue;
      const c = readSafe(p);
      if (!c) continue;
      // 只取 frontmatter 的 hub-id 键（避免把 supersedes/正文引用的旧 hubId 误计入 core 集合）
      const fmMatch = c.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) continue;
      const sec = fmMatch[1].match(/^hub-id:(.*(?:\r?\n[ \t]+-[^\n]*)*)/m);
      if (!sec) continue;
      for (const m of sec[0].matchAll(/(hub-\d{14}-[a-z0-9]+)/g)) ids.push(m[1]);
    }
  };
  walk(CORE_DIR);
  return [...new Set(ids)];
}

function loadHistory() {
  const raw = readSafe(OUT);
  if (!raw) return [];
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function report(history) {
  if (history.length === 0) {
    console.log('暂无快照数据，先运行一次不带 --report 的快照。');
    return;
  }
  console.log('时间\t\t\tDesktop\tChats\t合计\t较上次');
  let prev = null;
  for (const h of history) {
    const d = h.slugs['Users-kuangju-Desktop']?.count ?? 0;
    const c = h.slugs['Qoder-Chats']?.count ?? 0;
    const delta = prev === null ? '-' : d + c - prev;
    console.log(`${h.time}\t${d}\t${c}\t${d + c}\t${delta}`);
    prev = d + c;
  }
  // 半衰期估算：用首末两点做指数衰减拟合 N(t)=N0*exp(-λt)
  if (history.length >= 2) {
    const first = history[0];
    const last = history[history.length - 1];
    const n0 =
      (first.slugs['Users-kuangju-Desktop']?.count ?? 0) + (first.slugs['Qoder-Chats']?.count ?? 0);
    const n1 =
      (last.slugs['Users-kuangju-Desktop']?.count ?? 0) + (last.slugs['Qoder-Chats']?.count ?? 0);
    const hours = (new Date(last.time) - new Date(first.time)) / 3.6e6;
    if (n1 < n0 && n1 > 0 && hours > 0) {
      const lambda = Math.log(n0 / n1) / hours;
      console.log(
        `\n指数衰减估算：λ=${lambda.toFixed(4)}/h，半衰期≈${(Math.log(2) / lambda / 24).toFixed(1)} 天（基于 ${hours.toFixed(1)}h 窗口，${n0}→${n1}）`,
      );
    } else {
      console.log('\n窗口内无净衰减，暂不估算半衰期。');
    }
    // 最近一次 diff 的 category 汇总
    const lastDiff = history[history.length - 1].diff;
    if (lastDiff && lastDiff.removed.length > 0) {
      console.log(`最近一次快照被清理 ${lastDiff.removed.length} 条 / 新增 ${lastDiff.added.length} 条`);
    }
    // 核心层专项：重申覆盖率（预期 ~100%）与复活次数（每次 added ∩ coreIds）
    const lastCore = history[history.length - 1].core;
    if (lastCore && lastCore.hubIds.length > 0) {
      const coreSet = new Set(lastCore.hubIds);
      const present = new Set(
        Object.values(history[history.length - 1].slugs).flatMap((s) => s.hubIds),
      );
      const covered = lastCore.hubIds.filter((id) => present.has(id)).length;
      let revivals = 0;
      for (const h of history) {
        for (const id of h.diff?.added || []) if (coreSet.has(id)) revivals += 1;
      }
      console.log(
        `核心层：${lastCore.hubIds.length} 条，Qoder 侧重申覆盖 ${covered}/${lastCore.hubIds.length}，累计复活 ${revivals} 次` +
          (revivals > 10 ? '（复活频繁：建议在 Qoder 面板手动确认提升成熟度）' : ''),
      );
    }
  }
}

const isReport = process.argv.includes('--report');
const history = loadHistory();
if (isReport) {
  report(history);
  process.exit(0);
}

const snapshot = {
  time: new Date().toISOString(),
  slugs: Object.fromEntries(SLUGS.map((s) => [s, scanSlug(s)])),
  core: { hubIds: scanCoreHubIds() },
};
const prevIds = new Set(
  history.length > 0 ? Object.values(history[history.length - 1].slugs).flatMap((s) => s.hubIds) : [],
);
const curIds = new Set(Object.values(snapshot.slugs).flatMap((s) => s.hubIds));
snapshot.diff = {
  removed: [...prevIds].filter((id) => !curIds.has(id)),
  added: [...curIds].filter((id) => !prevIds.has(id)),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.appendFileSync(OUT, `${JSON.stringify(snapshot)}\n`);
const total = Object.values(snapshot.slugs).reduce((a, s) => a + s.count, 0);
console.log(
  `快照已记录：合计 ${total} 条（${SLUGS.map((s) => `${s}=${snapshot.slugs[s].count}`).join(', ')}）` +
    (history.length > 0 ? `，较上次 清理${snapshot.diff.removed.length}/新增${snapshot.diff.added.length}` : ''),
);
