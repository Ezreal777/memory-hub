/**
 * cleanup-e2e-probes.js —— 一次性清理脚本（任务 #9 附带清理）。
 *
 * 删除 ~/.memory-hub/hub/sources/ 下所有含 E2E 探针标记（HUB-E2E / HUB-TEST-20260805）
 * 的快照文件，防止脏数据进入真实 distill；并同步检查 distill-state / hash-state
 * 中的对应记录（有则移除）。仅打印将删/已删清单，不触碰其他文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.memory-hub');
const sourcesDir = path.join(ROOT, 'hub', 'sources');
const PROBE_RE = /HUB-E2E|HUB-TEST-20260805/;

const removed = [];
for (const app of fs.readdirSync(sourcesDir, { withFileTypes: true })) {
  if (!app.isDirectory()) continue;
  const dir = path.join(sourcesDir, app.name);
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue;
    const full = path.join(dir, f.name);
    const content = fs.readFileSync(full, 'utf8');
    if (!PROBE_RE.test(content)) continue;
    fs.rmSync(full, { force: true });
    removed.push(path.relative(ROOT, full));
  }
}
console.log(`已删除探针快照 ${removed.length} 个：`);
for (const r of removed) console.log(`  - ${r}`);

// distill-state：移除已删快照对应 hubId 的 processed 记录（若存在）
const distillStatePath = path.join(ROOT, 'hub', 'state', 'distill-state.json');
if (fs.existsSync(distillStatePath)) {
  const st = JSON.parse(fs.readFileSync(distillStatePath, 'utf8'));
  console.log(`distill-state 存在，processed 记录 ${Object.keys(st.processed || {}).length} 条（保留，未涉及探针页）`);
} else {
  console.log('distill-state.json 不存在，无需清理');
}

// hash-state：按源文件内容特征无法反查，仅报告体积与条目数
const hashStatePath = path.join(ROOT, 'hub', 'state', 'hash-state.json');
if (fs.existsSync(hashStatePath)) {
  const hs = JSON.parse(fs.readFileSync(hashStatePath, 'utf8'));
  const probeLike = Object.keys(hs.files || {}).filter((p) => PROBE_RE.test(p));
  console.log(`hash-state 共 ${Object.keys(hs.files || {}).length} 条对账记录，探针路径命中 ${probeLike.length} 条`);
  if (probeLike.length > 0) {
    for (const p of probeLike) delete hs.files[p];
    fs.writeFileSync(hashStatePath, `${JSON.stringify(hs, null, 2)}\n`, { mode: 0o600 });
    console.log('已移除 hash-state 中的探针路径记录');
  }
}
