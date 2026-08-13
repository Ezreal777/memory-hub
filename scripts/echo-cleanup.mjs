/**
 * echo-cleanup.mjs —— 回声循环存量清理（一次性运维脚本）。
 *
 * 背景：回声护栏（hub-store.isEchoEntry / distill.hasEchoMarker）上线前，
 * hub 自写写回产物已被重新采集进 sources 并部分蒸馏进 wiki。本脚本做存量清理：
 * ① sources：回声快照移入 sources/_quarantine/<app>/（保留审计，扫描一律跳过），
 *    收集回声 hubId 集合；
 * ② wiki：hub-id 全部为回声的页面 → 备份后删除，主 hubId 登记 removals
 *    （App 侧旧渲染由写回侧清理）；部分回声的页面 → 只从 frontmatter 剔除回声 id
 *    （正文重复内容留给 compact 语义去重）；
 * ③ 重建 master-index。
 *
 * 用法（daemon 停止后执行）：
 *   node scripts/echo-cleanup.mjs          # dry-run 只统计不动盘
 *   node scripts/echo-cleanup.mjs --apply  # 实际执行
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { storePaths } from '../src/hub-store.js';
import { createBackupDir, backupTo } from '../src/safe-write.js';
import { appendPendingRemovals } from '../src/compact.js';
import { rebuildMasterIndex } from '../src/index-builder.js';

const APPLY = process.argv.includes('--apply');
const APPS = ['claude', 'codex', 'qoder', 'qoderwork', 'wukong'];

// 与 hub-store.isEchoEntry / distill.hasEchoMarker 同口径的三类指纹
const BODY_MARKER = /\[hub-\d{14}-[a-z0-9]{6}\]/;
const FM_CHATID = /"chatId":\s*"hub-\d{14}-/;
const FM_SOURCE = /"source":\s*"memory-hub"/;

function isEchoSnapshot(raw) {
  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    return { echo: false };
  }
  const body = String(parsed.content || '');
  const rawFm = String(parsed.data?.frontmatter || '');
  const echo = BODY_MARKER.test(body) || FM_CHATID.test(rawFm) || FM_SOURCE.test(rawFm);
  return { echo, hubId: String(parsed.data?.hubId || '') };
}

// ① sources 扫描/搬移（重跑安全：_quarantine 内已隔离的回声快照也计入 hubId 集合，
// 确保上次中断后 wiki 清理阶段仍能拿到完整回声 id）
const echoIds = new Set();
let movedCount = 0;
for (const app of APPS) {
  const qdirPrev = path.join(storePaths.sources, '_quarantine', app);
  let prevFiles = [];
  try {
    prevFiles = fs.readdirSync(qdirPrev).filter((f) => f.endsWith('.md'));
  } catch {
    prevFiles = [];
  }
  for (const name of prevFiles) {
    try {
      const { echo, hubId } = isEchoSnapshot(fs.readFileSync(path.join(qdirPrev, name), 'utf8'));
      if (echo && hubId) echoIds.add(hubId);
    } catch {
      // 单文件不可读不影响
    }
  }
  const dir = path.join(storePaths.sources, app);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    continue;
  }
  let appMoved = 0;
  for (const name of files) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { echo, hubId } = isEchoSnapshot(raw);
    if (!echo) continue;
    if (hubId) echoIds.add(hubId);
    if (APPLY) {
      const qdir = path.join(storePaths.sources, '_quarantine', app);
      fs.mkdirSync(qdir, { recursive: true, mode: 0o700 });
      fs.renameSync(file, path.join(qdir, name));
    }
    appMoved += 1;
  }
  movedCount += appMoved;
  console.log(`[sources/${app}] 回声快照 ${appMoved} 条${APPLY ? ' 已移入 _quarantine' : ''}`);
}
console.log(`—— sources 合计：${movedCount} 条回声快照，回声 hubId ${echoIds.size} 个`);

// ② wiki 清理
let fullEcho = 0;
let partialEcho = 0;
const removalIds = [];
const backupDir = APPLY ? createBackupDir('writeback') : '(dry-run)';
const wikiFiles = fs.readdirSync(storePaths.wiki).filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('.'));
for (const name of wikiFiles) {
  const file = path.join(storePaths.wiki, name);
  let parsed;
  try {
    parsed = matter(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const fm = parsed.data || {};
  const rawIds = fm['hub-id'];
  const ids = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(String);
  if (ids.length === 0) continue;
  const echoHit = ids.filter((id) => echoIds.has(id));
  if (echoHit.length === 0) continue;
  if (echoHit.length === ids.length) {
    // 全回声页：纯重复内容，备份后删除，主 hubId 登记 App 侧清理
    fullEcho += 1;
    removalIds.push(ids[0]);
    if (APPLY) {
      backupTo(file, backupDir);
      fs.rmSync(file, { force: true });
    }
  } else {
    // 部分回声：只剔除回声 id（正文重复内容留给 compact 语义去重）
    partialEcho += 1;
    if (APPLY) {
      const newFm = { ...fm, 'hub-id': ids.filter((id) => !echoIds.has(id)) };
      // 对象传参：避免 gray-matter 把正文中的孤立 --- 误当 frontmatter 解析
      fs.writeFileSync(file, matter.stringify({ content: `${String(parsed.content || '').trim()}\n` }, newFm), { mode: 0o600 });
    }
  }
}
console.log(`—— wiki：全回声页 ${fullEcho} 个${APPLY ? `（已备份删除，备份 ${backupDir}）` : ''}，部分回声页 ${partialEcho} 个（剔除回声 id）`);

if (APPLY) {
  if (removalIds.length > 0) {
    appendPendingRemovals(removalIds);
    console.log(`已登记 ${removalIds.length} 个 removals（App 侧旧渲染下轮写回清理）`);
  }
  rebuildMasterIndex();
  console.log('master-index 已重建');
} else {
  console.log('\n[dry-run] 未动盘。确认无误后加 --apply 执行。');
}
