/**
 * test/test-scan-keys.js —— 扫描器与密钥模块自测（node:test）。
 *
 * 全部在临时目录演练：MEMORY_HUB_ROOT 隔离 config，伪造家目录结构验证探测。
 * 绝不触碰真实的 ~/.claude / ~/.codex / ~/.qoder / ~/.qoderwork / ~/.real。
 *
 * Keychain 交互说明：
 * syncKeys / listKeys / keychainSet 等真实 Keychain 读写不在单测中执行
 * （避免污染用户钥匙串 / 触发系统授权弹窗），此部分在真实环境验收阶段
 * 通过 `node src/cli.js keys list / --sync` 人工验证；
 * 本文件仅覆盖其纯函数部分（脱敏、rc 解析、dump 解析）与错误路径。
 *
 * 运行：npm test 或 node test/test-scan-keys.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoots = [];

/** 新建隔离的 MEMORY_HUB_ROOT 临时目录并切换过去。 */
function freshHubRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-scan-root-'));
  tmpRoots.push(dir);
  process.env.MEMORY_HUB_ROOT = dir;
  return dir;
}

/** 新建一个伪造的家目录。 */
function freshFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-fake-home-'));
  tmpRoots.push(dir);
  return dir;
}

/** 递归写文件（自动建目录）。 */
function writeAt(base, rel, content = '') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 构造任务要求的标准伪造家目录（claude/qoder/wukong 命中，codex 仅有 auth.json）。 */
function buildStandardFakeHome() {
  const home = freshFakeHome();
  writeAt(home, '.claude/projects/proj-alpha/memory/MEMORY.md', '# claude memory\n');
  writeAt(home, '.qoder/memories/abc123/projects/Users-test-Desktop/experience/note.md', 'x');
  writeAt(home, '.real/users/user-test/workspace/MEMORY.md', '# wukong memory\n');
  writeAt(home, '.codex/auth.json', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-1234567890-xyz' }));
  writeAt(home, '.zshrc', 'export IDEALAB_API_KEY="idealab-secret-abc123"\n');
  return home;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MEMORY_HUB_ROOT;
});

test('scan：claude/qoder/wukong 正确探测并回填 config', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig } = await import('../src/config.js');
  freshHubRoot();
  const home = buildStandardFakeHome();

  const rows = scanApps({ home });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  // claude：memory_paths 为 MEMORY.md 所在目录
  assert.equal(byId.claude.found, true);
  assert.deepEqual(byId.claude.memory_paths, [path.join(home, '.claude/projects/proj-alpha/memory')]);

  // qoder：memory 根目录（账号目录）+ project_slug 动态枚举
  assert.equal(byId.qoder.found, true);
  assert.deepEqual(byId.qoder.memory_paths, [path.join(home, '.qoder/memories/abc123')]);
  assert.equal(byId.qoder.project_slug, 'Users-test-Desktop');

  // wukong：枚举用户目录，取 workspace 目录
  assert.equal(byId.wukong.found, true);
  assert.deepEqual(byId.wukong.memory_paths, [path.join(home, '.real/users/user-test/workspace')]);

  // 回填 config 可重新读取
  const config = loadConfig();
  const claude = config.apps.find((a) => a.id === 'claude');
  assert.equal(claude.enabled, true);
  assert.deepEqual(claude.memory_paths, [path.join(home, '.claude/projects/proj-alpha/memory')]);
  const qoder = config.apps.find((a) => a.id === 'qoder');
  assert.equal(qoder.project_slug, 'Users-test-Desktop');
});

test('scan：缺失的 app（codex/qoderwork）被禁用且标注"未找到"，不崩溃', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig } = await import('../src/config.js');
  freshHubRoot();
  const home = buildStandardFakeHome(); // codex 无 AGENTS.md、qoderwork 整个缺席

  const rows = scanApps({ home });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.codex.found, false);
  assert.equal(byId.qoderwork.found, false);
  assert.equal(byId.qoderwork.notes, '未找到');

  const config = loadConfig();
  for (const id of ['codex', 'qoderwork']) {
    const app = config.apps.find((a) => a.id === id);
    assert.equal(app.enabled, false, `${id} 应被禁用`);
    assert.deepEqual(app.memory_paths, []);
  }
});

test('scan：codex 保留 config 中已配置的工作区 AGENTS.md，无效路径被剔除', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig, updateApp } = await import('../src/config.js');
  freshHubRoot();
  const home = freshFakeHome();
  const globalAgents = writeAt(home, '.codex/AGENTS.md', '# global agents\n');
  const wsAgents = writeAt(home, 'tool/AGENTS.md', '# workspace agents\n');
  // 预先在 config 中配置工作区级 AGENTS.md（模拟用户手动配置）
  loadConfig();
  updateApp('codex', { memory_paths: [wsAgents, path.join(home, 'gone/AGENTS.md')] });

  const rows = scanApps({ home });
  const codex = rows.find((r) => r.id === 'codex');
  assert.equal(codex.found, true);
  assert.deepEqual(codex.memory_paths, [globalAgents, wsAgents], '全局 + 已配置工作区均保留，不存在的路径剔除');

  // 删除工作区文件后再扫描：自动剔除，不保留失效路径
  fs.rmSync(wsAgents);
  const rows2 = scanApps({ home });
  assert.deepEqual(rows2.find((r) => r.id === 'codex').memory_paths, [globalAgents]);
});

test('scan：重复扫描幂等（config 内容一致）', async () => {
  const { scanApps } = await import('../src/scan.js');
  const { loadConfig } = await import('../src/config.js');
  freshHubRoot();
  const home = buildStandardFakeHome();

  scanApps({ home });
  const first = JSON.stringify(loadConfig());
  scanApps({ home });
  const second = JSON.stringify(loadConfig());
  assert.equal(second, first, '重复扫描后 config 应完全一致');
});

test('maskSecret：脱敏只显示首尾各 1-3 字符', async () => {
  const { maskSecret } = await import('../src/keys.js');
  assert.equal(maskSecret('sk-abc123def456xyz'), 'sk-***xyz', '长密钥：首尾各 3');
  assert.equal(maskSecret('sk-a123z'), 's***z', '短密钥：首尾各 1');
  assert.equal(maskSecret('abcd'), 'a***', '极短密钥只留首字符');
  assert.equal(maskSecret(''), '(空)');
  // 脱敏结果绝不包含完整密钥
  const secret = 'sk-live-0123456789abcdef';
  const masked = maskSecret(secret);
  assert.ok(!masked.includes(secret));
  assert.match(masked, /\*\*\*/);
});

test('parseShellExport：引号/注释/多次 export 均正确解析', async () => {
  const { parseShellExport } = await import('../src/keys.js');
  const home = freshFakeHome();
  const rc = writeAt(home, '.zshrc', [
    '# 注释行',
    'export OTHER_KEY=ignore',
    'export IDEALAB_API_KEY=raw-value-123 # 行尾注释',
    "export IDEALAB_API_KEY='single-quoted-456'",
    'export IDEALAB_API_KEY="double-quoted-789"',
    '',
  ].join('\n'));

  // 多次 export 取最后一次
  assert.equal(parseShellExport(rc, 'IDEALAB_API_KEY'), 'double-quoted-789');
  assert.equal(parseShellExport(rc, 'OTHER_KEY'), 'ignore');
  assert.equal(parseShellExport(rc, 'NOT_EXIST'), null);
  assert.equal(parseShellExport(path.join(home, 'missing-file'), 'IDEALAB_API_KEY'), null);
});

test('collectSecretSources：只读发现 codex-openai 与 idealab 两个来源', async () => {
  const { collectSecretSources, KEY_NAMES } = await import('../src/keys.js');
  const home = buildStandardFakeHome();

  const sources = collectSecretSources(home);
  const byName = Object.fromEntries(sources.map((s) => [s.name, s]));
  assert.equal(byName[KEY_NAMES.codexOpenai].value, 'sk-test-1234567890-xyz');
  assert.equal(byName[KEY_NAMES.codexOpenai].origin, path.join(home, '.codex/auth.json'));
  assert.equal(byName[KEY_NAMES.idealab].value, 'idealab-secret-abc123');
  assert.equal(byName[KEY_NAMES.idealab].origin, path.join(home, '.zshrc'));

  // auth.json 损坏时不崩溃，仅 codex 来源缺席
  const home2 = freshFakeHome();
  writeAt(home2, '.codex/auth.json', '{broken json');
  writeAt(home2, '.zprofile', 'export IDEALAB_API_KEY=from-zprofile');
  const sources2 = collectSecretSources(home2);
  assert.equal(sources2.length, 1);
  assert.equal(sources2[0].name, KEY_NAMES.idealab);
  assert.equal(sources2[0].value, 'from-zprofile');
});

test('parseKeychainDump：只提取目标 service 的 account', async () => {
  const { parseKeychainDump } = await import('../src/keys.js');
  const dump = [
    'keychain: "/Users/test/Library/Keychains/login.keychain-db"',
    'version: 256',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="memory-hub"',
    '    "acct"<blob>="codex-openai"',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="other-service"',
    '    "acct"<blob>="unrelated"',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="memory-hub"',
    '    "acct"<blob>="idealab"',
  ].join('\n');

  assert.deepEqual(parseKeychainDump(dump, 'memory-hub'), ['codex-openai', 'idealab']);
  assert.deepEqual(parseKeychainDump(dump, 'no-such-service'), []);
});

test('resolveApiKey：未配置 keyRef 时抛出明确错误（不触发 Keychain 弹窗）', async () => {
  const { resolveApiKey } = await import('../src/keys.js');
  freshHubRoot(); // 全新 config，llm.keyRef 为空
  const { loadConfig } = await import('../src/config.js');
  loadConfig();
  assert.throws(() => resolveApiKey(), /未配置 llm\.keyRef/);
});

test('useKey：Keychain 条目不存在时抛出明确错误（仅探测存在性，无弹窗）', async () => {
  const { useKey } = await import('../src/keys.js');
  freshHubRoot();
  // 注：此处仅调用 find-generic-password 元数据探测，条目必不存在、不会触发授权弹窗；
  // 真实 Keychain 的写入/读取路径（syncKeys/listKeys）按文件头说明留待真实环境验收。
  assert.throws(() => useKey('no-such-key-ref'), /Keychain 中不存在条目/);
});

// ---------------------------------------------------------------------------
// Bug#2 / Bug#1：security 绝对路径 + 密钥不进命令行参数 + 错误信息脱敏
// ---------------------------------------------------------------------------

test('Bug#2：security 调用统一用绝对路径 /usr/bin/security 且本机存在', async () => {
  const { SECURITY_BIN } = await import('../src/keys.js');
  assert.equal(SECURITY_BIN, '/usr/bin/security');
  assert.ok(fs.existsSync(SECURITY_BIN), '本机应存在 /usr/bin/security（测试环境即 macOS）');
});

test('Bug#1：keychainSet 密钥只走 stdin，不进命令行参数；失败时错误信息脱敏', async () => {
  const { keychainSet, maskSecret } = await import('../src/keys.js');
  const secret = 'sk-live-SECRET-0123456789-abcdef';
  const invocations = [];

  // 1) 成功路径：记录 spawn 调用，验证密钥绝不进入 argv / 命令字符串，只在 stdin
  const okSpawn = (file, args, options) => {
    invocations.push({ file, args, options });
    return { status: 0 };
  };
  keychainSet('test-key', secret, { spawnImpl: okSpawn });
  assert.equal(invocations.length, 1);
  const { args, options } = invocations[0];
  assert.ok(!args.some((a) => String(a).includes(secret)), '密钥不出现在子进程参数中');
  assert.ok(args.some((a) => String(a).includes('-w "$__mh_pw"')), '密码用 shell 变量从 stdin 读取，而非内联密钥值');
  assert.equal(options.input, `${secret}\n`, '密钥仅通过 stdin 传入');

  // 2) 失败路径（非零退出码）：错误消息不含完整密钥，仅脱敏展示
  const failSpawn = () => ({ status: 1, stderr: 'security: SecKeychainItemModifyContent: unknown error' });
  assert.throws(
    () => keychainSet('test-key', secret, { spawnImpl: failSpawn }),
    (err) => {
      assert.ok(!err.message.includes(secret), '错误信息不含完整密钥');
      assert.ok(err.message.includes(maskSecret(secret)), '错误信息只含脱敏值');
      assert.match(err.message, /退出码 1/);
      return true;
    },
  );

  // 3) 失败路径（spawn 抛异常）：同样不含密钥
  const throwSpawn = () => {
    throw new Error('spawn /bin/sh ENOENT');
  };
  assert.throws(
    () => keychainSet('test-key', secret, { spawnImpl: throwSpawn }),
    (err) => {
      assert.ok(!err.message.includes(secret));
      return true;
    },
  );

  // 4) 故意触发失败：stderr 若含密钥则绝不附进错误消息（双重防护）
  const leakySpawn = () => ({ status: 1, stderr: `security: password ${secret} rejected` });
  assert.throws(
    () => keychainSet('test-key', secret, { spawnImpl: leakySpawn }),
    (err) => {
      assert.ok(!err.message.includes(secret), '含密钥的 stderr 不被携带');
      assert.ok(err.message.includes(maskSecret(secret)));
      return true;
    },
  );

  // 5) 正常 stderr（不含密钥）附首行作排查线索
  const hintSpawn = () => ({ status: 2, stderr: 'security: SecKeychainSearchCopyNext: not found\nsecond line' });
  assert.throws(
    () => keychainSet('test-key', secret, { spawnImpl: hintSpawn }),
    (err) => {
      assert.match(err.message, /SecKeychainSearchCopyNext/);
      assert.ok(!err.message.includes('second line'), '只附首行');
      return true;
    },
  );
});
