/**
 * keys.js —— LLM API Key 管理（hub keys）。
 *
 * 原则：
 * - 密钥只进 macOS Keychain（service=memory-hub），config.json 仅存引用名 llm.keyRef；
 * - 任何输出（终端、日志、config）一律脱敏展示，严禁打印完整 AK；
 * - 同步来源全部【只读】：~/.codex/auth.json 与 ~/.zshrc / ~/.zprofile；
 * - Keychain 操作前先探测存在性，避免触发不必要的系统授权弹窗；写入用 -U 覆盖更新。
 *
 * Keychain 交互通过系统自带 `security` CLI 完成（仅 darwin 平台）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig, updateConfig } from './config.js';

/**
 * 系统 security 命令绝对路径（Bug#2 修复）。
 * macOS 26 下 spawn 在 launchd/受限 PATH 环境解析不到裸命令名，
 * 一律改用绝对路径调用；使用前先做存在性检查。
 */
export const SECURITY_BIN = '/usr/bin/security';

/** Keychain 服务名（所有条目统一挂在该 service 下） */
export const KEYCHAIN_SERVICE = 'memory-hub';

/** 约定的密钥引用名 */
export const KEY_NAMES = {
  codexOpenai: 'codex-openai', // 来源：~/.codex/auth.json 的 OPENAI_API_KEY
  idealab: 'idealab', // 来源：shell rc 中的 export IDEALAB_API_KEY=...
  claudeAnthropic: 'claude-anthropic', // M4：shell rc 中的 export ANTHROPIC_API_KEY=...（存在才收录）
};

/**
 * 密钥脱敏：只显示首尾各 1-3 字符，中间一律 ***。
 * 例：sk-abc...xyz → "sk-***xyz"（短密钥退化为各 1 字符）。
 * @param {string} secret 原始密钥
 * @returns {string} 脱敏后的展示串
 */
export function maskSecret(secret) {
  if (!secret) return '(空)';
  const s = String(secret);
  if (s.length <= 4) return `${s[0]}***`;
  if (s.length <= 8) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

/**
 * 解析 shell 配置文件（.zshrc / .zprofile）中的 `export NAME=...`。
 * 支持单/双引号包裹；未加引号时去除行尾注释；同名多次 export 取最后一次。
 * @param {string} filePath rc 文件绝对路径
 * @param {string} varName 环境变量名
 * @returns {string|null} 变量值；文件或变量不存在返回 null
 */
export function parseShellExport(filePath, varName) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const re = new RegExp(`^\\s*export\\s+${varName}=(.*)$`);
  let value = null;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1); // 去掉成对外层引号
    } else {
      v = v.split('#')[0].trim(); // 未加引号：去除行尾注释
    }
    if (v) value = v;
  }
  return value;
}

/**
 * 只读收集密钥来源（不触发任何 Keychain 操作）。
 * 1. Codex：~/.codex/auth.json → OPENAI_API_KEY（引用名 codex-openai）；
 * 2. 环境变量式：~/.zshrc、~/.zprofile → IDEALAB_API_KEY（引用名 idealab，取首个命中）；
 * 3. M4：shell rc → ANTHROPIC_API_KEY（引用名 claude-anthropic，存在才收录；
 *    本机 Claude Code 走 IDEALAB 环境变量已覆盖，此来源面向直连 Anthropic 的部署）。
 * @param {string} [home] 家目录（测试可注入伪造目录）
 * @returns {{ name: string, origin: string, value: string }[]}
 */
export function collectSecretSources(home = os.homedir()) {
  const sources = [];

  // 1) Codex auth.json（JSON 解析失败只跳过，不崩溃）
  const authPath = path.join(home, '.codex', 'auth.json');
  try {
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (auth && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
        sources.push({ name: KEY_NAMES.codexOpenai, origin: authPath, value: auth.OPENAI_API_KEY });
      }
    }
  } catch {
    // auth.json 损坏/不可读：跳过该来源
  }

  // 2) shell rc 中的 export IDEALAB_API_KEY
  for (const rc of ['.zshrc', '.zprofile']) {
    const rcPath = path.join(home, rc);
    const v = parseShellExport(rcPath, 'IDEALAB_API_KEY');
    if (v) {
      sources.push({ name: KEY_NAMES.idealab, origin: rcPath, value: v });
      break; // 只取首个命中的 rc 文件
    }
  }

  // 3) M4：shell rc 中的 export ANTHROPIC_API_KEY（存在才收录）
  for (const rc of ['.zshrc', '.zprofile']) {
    const rcPath = path.join(home, rc);
    const v = parseShellExport(rcPath, 'ANTHROPIC_API_KEY');
    if (v) {
      sources.push({ name: KEY_NAMES.claudeAnthropic, origin: rcPath, value: v });
      break;
    }
  }
  return sources;
}

/** 断言当前平台为 macOS（security CLI 仅 darwin 可用），否则抛出明确错误。 */
function assertDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('keys 模块依赖 macOS Keychain（security CLI），当前平台不支持');
  }
}

/** 断言 security 命令存在于绝对路径（Bug#2），不存在时给出清晰错误。 */
function assertSecurityBin() {
  if (!fs.existsSync(SECURITY_BIN)) {
    throw new Error(
      `系统命令不存在: ${SECURITY_BIN}（keys 功能依赖 macOS 系统 Keychain，请确认系统完整性）`,
    );
  }
}

/**
 * 调用系统 security 命令（绝对路径 + 参数数组传递，不经 shell，避免注入与历史记录泄漏）。
 * 失败时错误信息只含子命令名与退出码，不携带原始 stderr（防止敏感信息随错误外泄）。
 * @param {string[]} args security 子命令参数（严禁包含任何密钥明文）
 * @returns {string} 标准输出
 */
function runSecurity(args) {
  assertSecurityBin();
  try {
    // M8：timeout 10s + SIGKILL 兜底（Keychain 弹窗/挂死时绝不永久阻塞 daemon）；
    // stdio 必须显式指定：缺省会 inherit 父进程 stderr，launchd 常驻进程的继承 fd
    // 在 macOS 26 下会失效导致 spawnSync EBADF（表现为 daemon 侧“条目不存在”）
    return execFileSync(SECURITY_BIN, args, {
      encoding: 'utf8',
      timeout: 10000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const timedOut = err?.killed || err?.signal === 'SIGKILL';
    // err.status 为空表示 spawn 本身失败（非命令退出），透传 errno code 便于定位 launchd 环境问题
    const detail = timedOut
      ? '超时 10s 被强杀'
      : err.status != null
        ? `退出码 ${err.status}`
        : `spawn 失败 code=${err.code ?? '?'} errno=${err.errno ?? '?'} msg=${String(err.message || '').slice(0, 120)}`;
    throw new Error(`security ${args[0]} 执行失败（${detail}），请检查 Keychain 访问权限`);
  }
}

/** 最近一次 keychainExists 探测失败的底层错误（诊断用，区分真不存在 vs 调用失败） */
let lastProbeError = null;

/**
 * 探测 Keychain 中指定引用名是否存在（仅查元数据、不取值，避免触发授权弹窗）。
 * @param {string} name 密钥引用名
 * @returns {boolean} 是否存在
 */
export function keychainExists(name) {
  try {
    runSecurity(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]);
    lastProbeError = null;
    return true;
  } catch (err) {
    lastProbeError = err.message;
    return false;
  }
}

/**
 * 写入/覆盖 Keychain 条目（-U 覆盖更新，-T security 允许自身后续读取）。
 *
 * Bug#1 修复（防泄漏）：密钥只通过子进程 stdin 传入 security，
 * 绝不进入命令行参数 / 环境变量 / 日志 / 错误消息（进程参数可被 ps 等工具观测）；
 * 失败时错误信息只含条目名与脱敏值（maskSecret），不携带 stderr 原文。
 *
 * @param {string} name 密钥引用名
 * @param {string} secret 密钥明文（仅存在于本次进程内存与 stdin 管道）
 * @param {{ spawnImpl?: Function }} [opts] 可注入 spawnSync 替身（测试用）
 */
export function keychainSet(name, secret, opts = {}) {
  assertDarwin();
  assertSecurityBin();
  // L4：写入前检测同名条目，覆盖时向调用方交代（绝不静默覆盖）
  let preExisting = false;
  try {
    preExisting = keychainExists(name);
  } catch {
    // 探测失败不阻塞写入
  }
  const spawnImpl = opts.spawnImpl || spawnSync;
  // shell 脚本从 stdin 读入一行密码后 exec security：
  // 密钥不进 argv、不进环境变量、不出现在命令字符串中；
  // -T 必须用绝对路径（exec 后裸名 security 无法解析为可信应用路径）
  const script =
    `read -r __mh_pw && exec "${SECURITY_BIN}" add-generic-password -U -T "${SECURITY_BIN}" ` +
    `-s ${KEYCHAIN_SERVICE} -a "$1" -w "$__mh_pw"`;
  let res;
  try {
    res = spawnImpl('/bin/sh', ['-c', script, '_', name], {
      input: `${secret}\n`,
      encoding: 'utf8',
      timeout: 10000, // M8：超时兜底，防 Keychain 弹窗挂死
      killSignal: 'SIGKILL',
    });
  } catch {
    throw new Error(`Keychain 条目 "${name}"（值 ${maskSecret(secret)}）写入失败：子进程调用异常`);
  }
  if (!res || res.error || res.status !== 0) {
    // 只输出脱敏信息；stderr 仅在确认不含密钥时附首行作排查线索
    const stderr = String(res?.stderr || '').trim();
    const detail = stderr && !stderr.includes(secret) ? `（${stderr.split(/\r?\n/)[0]}）` : '';
    throw new Error(
      `Keychain 条目 "${name}"（值 ${maskSecret(secret)}）写入失败：security 退出码 ${res?.status ?? '异常'}${detail}`,
    );
  }
  return { overwritten: preExisting };
}

/**
 * 读取 Keychain 中的密钥明文（仅供 resolveApiKey 内部使用，严禁打印）。
 * @param {string} name 密钥引用名
 * @returns {string} 密钥明文
 */
function keychainGet(name) {
  return runSecurity(['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', name]).trim();
}

/**
 * 解析 `security dump-keychain` 输出，提取指定 service 下的全部 account 名。
 * dump-keychain（不带 -d）不显示密钥内容，安全。
 * @param {string} dumpText dump-keychain 的完整输出
 * @param {string} service 服务名
 * @returns {string[]} account 名列表（去重、按出现顺序）
 */
export function parseKeychainDump(dumpText, service) {
  const accounts = [];
  let svcHit = false;
  let pendingAcct = null;
  const flush = () => {
    if (svcHit && pendingAcct && !accounts.includes(pendingAcct)) {
      accounts.push(pendingAcct);
    }
    svcHit = false;
    pendingAcct = null;
  };
  for (const line of dumpText.split(/\r?\n/)) {
    // 条目边界：新条目以 class: 开头
    if (/^class:/.test(line)) flush();
    // service 属性（0x00000007 = svce）
    const svcMatch = line.match(/0x00000007\s+<blob>="?([^"\n]*)"?\s*$/);
    if (svcMatch && svcMatch[1] === service) svcHit = true;
    // account 属性
    const acctMatch = line.match(/"acct"<blob>="?([^"\n]*)"?\s*$/);
    if (acctMatch) pendingAcct = acctMatch[1];
  }
  flush(); // 文件末尾最后一个条目
  return accounts;
}

/**
 * 列出 Keychain 中 memory-hub 的全部条目（脱敏展示）。
 * @returns {{ name: string, masked: string }[]}
 */
export function listKeys() {
  assertDarwin();
  let accounts = [];
  try {
    accounts = parseKeychainDump(runSecurity(['dump-keychain']), KEYCHAIN_SERVICE);
  } catch {
    return [];
  }
  return accounts.map((name) => {
    let masked = '(读取失败)';
    try {
      masked = maskSecret(keychainGet(name));
    } catch {
      // 读取被拒（如授权弹窗取消）：仅展示条目名
    }
    return { name, masked };
  });
}

/**
 * hub keys --sync：只读同步全部密钥来源到 Keychain。
 * 来源：codex-openai（~/.codex/auth.json）、idealab（shell rc IDEALAB_API_KEY）、
 * claude-anthropic（shell rc ANTHROPIC_API_KEY，M4，存在才收录）。
 * @param {{ home?: string }} [opts] home 缺省为 os.homedir()
 * @returns {{ name: string, origin: string, masked: string, overwritten: boolean }[]} 本次同步的条目
 */
export function syncKeys(opts = {}) {
  assertDarwin();
  const home = opts.home || os.homedir();
  const sources = collectSecretSources(home);
  const results = [];
  for (const src of sources) {
    const r = keychainSet(src.name, src.value);
    results.push({
      name: src.name,
      origin: src.origin,
      masked: maskSecret(src.value),
      overwritten: Boolean(r?.overwritten),
    });
  }
  return results;
}

/**
 * hub keys use <name>：切换 config.llm.keyRef 指向（先探测 Keychain 存在性）。
 * M5：可选 --base-url / --model 一并落盘 config.llm（补齐 init 引导承诺的配置入口）。
 * @param {string} name 密钥引用名
 * @param {{ baseUrl?: string, model?: string }} [opts] 可选 LLM 端点配置
 * @returns {Object} 更新后的配置
 */
export function useKey(name, opts = {}) {
  assertDarwin();
  if (!keychainExists(name)) {
    throw new Error(
      `Keychain 中不存在条目 "${name}"（service=${KEYCHAIN_SERVICE}），请先运行 hub keys --sync`,
    );
  }
  const llm = { keyRef: name };
  if (opts.baseUrl) llm.baseUrl = String(opts.baseUrl);
  if (opts.model) llm.model = String(opts.model);
  return updateConfig({ llm });
}

/**
 * daemon 内存预热缓存：{ name, secret }。
 * macOS 26 下 watcher（chokidar 4 kqueue 模式）持有万级常开 fd 后，
 * posix_spawn 必现 EBADF，daemon 常驻期间无法再调 security 读 Keychain；
 * 因此在 watcher 启动前预热一次，后续 resolveApiKey 直接走内存（不落盘、不进环境变量）。
 */
let primedKey = null;

/**
 * 预热 API Key 到进程内存（仅供 daemon 启动早期、watcher 拉起之前调用）。
 * @param {string} [name] 密钥引用名；缺省取 config.llm.keyRef
 * @returns {boolean} 是否预热成功（未配置 keyRef 时返回 false 不报错）
 * @throws {Error} Keychain 读取失败时抛出（调用方决定降级策略）
 */
export function primeApiKeyCache(name) {
  const keyRef = name || loadConfig().llm.keyRef;
  if (!keyRef) return false;
  const secret = resolveApiKey(keyRef);
  primedKey = { name: keyRef, secret };
  return true;
}

/**
 * 供后续 distill 调用：解析出真正可用的 API Key 明文。
 * 读取顺序：显式传入 name → config.llm.keyRef → 内存预热缓存 → Keychain。
 * @param {string} [name] 密钥引用名；缺省取 config.llm.keyRef
 * @returns {string} API Key 明文
 * @throws {Error} 未配置 keyRef 或 Keychain 读取失败时抛出明确错误
 */
export function resolveApiKey(name) {
  assertDarwin();
  const keyRef = name || loadConfig().llm.keyRef;
  if (!keyRef) {
    throw new Error('resolveApiKey 失败：未配置 llm.keyRef，请先运行 hub keys --sync 并用 hub keys use <name> 选择');
  }
  // 预热缓存命中：不再 spawn security（daemon 常驻期间 spawn 不可用，见 primedKey 注释）
  if (primedKey && primedKey.name === keyRef) return primedKey.secret;
  if (!keychainExists(keyRef)) {
    // 透传底层探测错误：launchd 上下文下“调用失败”会被误报为“不存在”，需区分定位
    const probe = lastProbeError ? `；探测底层错误: ${lastProbeError}` : '';
    // daemon 常驻期间切换了 keyRef：预热缓存失配且 spawn 不可用，正确出路是重启而非 keys --sync
    const staleHint = primedKey && primedKey.name !== keyRef
      ? `；daemon 预热缓存为 "${primedKey.name}"，切换 keyRef 后需 hub daemon stop → start 重启生效`
      : '';
    throw new Error(`resolveApiKey 失败：Keychain 中不存在条目 "${keyRef}"（service=${KEYCHAIN_SERVICE}），请先运行 hub keys --sync${probe}${staleHint}`);
  }
  try {
    const secret = keychainGet(keyRef);
    if (!secret) throw new Error('empty');
    return secret;
  } catch (err) {
    throw new Error(`resolveApiKey 失败：读取 Keychain 条目 "${keyRef}" 出错: ${err.message}`);
  }
}
