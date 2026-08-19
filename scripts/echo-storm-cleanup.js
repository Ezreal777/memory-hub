/**
 * scripts/echo-storm-cleanup.js —— 回声雪球一次性清理（echo-storm 2026-08-19）。
 *
 * 背景：codex.parse 曾按全文 H2 切节，把写回 AGENTS.md 的 wiki 条目全量重摄取，
 * 单日滚出 3.5 万份重复快照/464MB（防线修复见 test-echo-guard.js 第二代防线）。
 *
 * 动作：
 * 1. 隔离指定日期的 codex 洪水快照 → sources/_quarantine/echo-storm-<date>/
 * 2. 扫描剩余全部快照，初始化 state/source-fingerprints.json
 *    （与 hub-store.contentFingerprint 同口径）——避免 daemon 重启后首轮
 *    poll 对账把历史快照内容重摄取一遍。
 *
 * 用法：node scripts/echo-storm-cleanup.js [YYYYMMDD]（默认 20260819）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dateTag = process.argv[2] || '20260819';
const SRC = path.join(process.env.HOME, 'Desktop/Memory Hub/sources');
const QUARANTINE = path.join(SRC, '_quarantine', `echo-storm-${dateTag}`);
const STATE = path.join(process.env.HOME, '.memory-hub/state/source-fingerprints.json');

// 1. 隔离当日 codex 洪水快照
fs.mkdirSync(QUARANTINE, { recursive: true });
const codexDir = path.join(SRC, 'codex');
let moved = 0;
for (const f of fs.readdirSync(codexDir)) {
  if (f.startsWith(`${dateTag}-`)) {
    fs.renameSync(path.join(codexDir, f), path.join(QUARANTINE, f));
    moved += 1;
  }
}
console.log('隔离回声快照:', moved, '份 →', QUARANTINE);

// 2. 扫剩余快照建指纹表（口径：sha256(`${app}\n${title}\n${body.trim()}`)）
const fps = { version: 1, fps: {} };
let scanned = 0;
let bad = 0;
for (const app of fs.readdirSync(SRC)) {
  if (app === '_quarantine') continue;
  const dir = path.join(SRC, app);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const file = path.join(dir, f);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) {
      bad += 1;
      continue;
    }
    const fmText = m[1];
    const pick = (k) => {
      const mm = fmText.match(new RegExp(`^${k}: "(.*)"$`, 'm'));
      return mm ? mm[1] : '';
    };
    const app2 = pick('app') || app;
    const title = pick('title');
    if (!app2 || !title) {
      bad += 1;
      continue;
    }
    let body = text.slice(m[0].length);
    const titleLine = `# ${title}`;
    if (body.startsWith(titleLine)) body = body.slice(titleLine.length);
    const fp = crypto.createHash('sha256').update(`${app2}\n${title}\n${body.trim()}`).digest('hex');
    fps.fps[`${app2}:${fp}`] = pick('hubId') || f;
    scanned += 1;
  }
}
fs.writeFileSync(STATE, JSON.stringify(fps));
console.log('指纹登记:', scanned, '条（跳过', bad, '份无 frontmatter 快照）→', STATE);
