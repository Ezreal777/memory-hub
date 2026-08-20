/**
 * scripts/echo-dedupe-snapshots.js —— 历史回声快照按指纹去重（echo-storm 收尾）。
 *
 * 背景：echo-storm 雪球期间（08-06 ~ 08-19），codex 每轮 poll 全量重摄取把同一
 * 内容反复落盘（82948 份快照仅 7050 个唯一内容）。这些重复份留在 sources 里会
 * 被 distill 逐批重新蒸馏——烧 LLM 预算 + 产出重复 wiki 页（实测每天 +55 页）。
 *
 * 动作：按 hub-store.contentFingerprint 同口径（sha256(app \n title \n body)）
 * 分组，每组只保留文件名时间戳最新的一份，其余移入
 * sources/_quarantine/echo-dedupe-<app>-<date>/（不删除，可回滚）。
 * 保留的唯一份继续走正常蒸馏；隔离后 distill 扫描不到，积压自动收缩。
 *
 * 用法：node scripts/echo-dedupe-snapshots.js [app]（默认 codex）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const app = process.argv[2] || 'codex';
const DATE_TAG = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const SRC = path.join(process.env.HOME, 'Desktop/Memory Hub/sources', app);
const QUAR = path.join(process.env.HOME, 'Desktop/Memory Hub/sources/_quarantine', `echo-dedupe-${app}-${DATE_TAG}`);

fs.mkdirSync(QUAR, { recursive: true });

const groups = new Map(); // fp → filenames[]
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith('.md')) continue;
  const file = path.join(SRC, f);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) continue;
  const fmText = m[1];
  const pick = (k) => {
    const mm = fmText.match(new RegExp(`^${k}: "(.*)"$`, 'm'));
    return mm ? mm[1] : '';
  };
  const title = pick('title');
  if (!title) continue;
  let body = text.slice(m[0].length);
  const titleLine = `# ${title}`;
  if (body.startsWith(titleLine)) body = body.slice(titleLine.length);
  const fp = crypto.createHash('sha256').update(`${app}\n${title}\n${body.trim()}`).digest('hex');
  if (!groups.has(fp)) groups.set(fp, []);
  groups.get(fp).push(f);
}

let kept = 0;
let moved = 0;
for (const files of groups.values()) {
  files.sort(); // 文件名时间戳前缀字典序 = 时间序
  kept += 1;
  for (const f of files.slice(0, -1)) {
    // 保留最新一份（末位），其余隔离
    fs.renameSync(path.join(SRC, f), path.join(QUAR, f));
    moved += 1;
  }
}
console.log(`${app}: 唯一内容 ${kept} 份保留，重复 ${moved} 份已隔离 → ${QUAR}`);
console.log(`sources/${app} 现存: ${fs.readdirSync(SRC).length} 份`);
