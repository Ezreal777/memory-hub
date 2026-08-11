/**
 * adapters/qoder.js —— Qoder 记忆适配器（只读侧 + 写回侧）。
 *
 * 实测格式（~/.qoder/memories/<账号>/projects/<项目slug>/<category>/*.md）：
 * - category 是目录枚举（project_introduction / user_info / ... 约 27 个），
 *   绝不硬编码枚举，一律动态发现（projects 下任意二级目录均视为 category）；
 * - 每条 md 必有 YAML frontmatter：title / usage_scenario[] / keywords[] / source + 正文；
 * - 无 frontmatter 的文件：Qoder 解析器会静默忽略，本适配器记录警告并跳过。
 *
 * watchPaths = config 中该 app 的 memory_paths（账号根目录，如 .../memories/<账号>）。
 *
 * 写回侧（batch:2，索引型：面板收录后近实时生效）：
 * - 写入目录 = memory_paths/projects/<project_slug>/<category>/（project_slug 取 config，
 *   category 读 wiki 页 frontmatter 的 category 字段，缺省 project_introduction）；
 * - 文件 = YAML frontmatter 四字段 title/usage_scenario[]/keywords[]/source:"memory-hub" + 正文，
 *   正文首行含 [hub-id] 标记；
 * - 写前自检：用 gray-matter 解析渲染结果，四字段缺一即抛错拒写；
 * - N2 更新语义：按 hubId 【跨 category 目录】定位既有文件 → 渲染内容比对 →
 *   不同则原位重写（wiki 页后续更新可传播）；Qoder 客户端会自行跨 category 整理
 *   文件，写回一律尊重其归类现状原位处理，绝不搬移（避免与客户端整理机制拉锯）；
 * - 写成功后提示用户在知识中心面板确认以提升成熟度。
 */

import path from 'node:path';
import fs from 'node:fs';
import matter from 'gray-matter';
import { BaseAdapter, makeEntry, isIgnoredPath, slugify, listDirFiles, readFileSafe } from './base.js';
import { statSafe, writeFilesSafely, removeFilesSafely } from './write-utils.js';

/** 写回 frontmatter 必备四字段（缺一拒写） */
export const REQUIRED_FIELDS = ['title', 'usage_scenario', 'keywords', 'source'];

/** 写回成功后的固定提示（外部写入默认低成熟度） */
export const QODER_WRITE_NOTE =
  '请在 Qoder 知识中心面板确认该条目以提升成熟度（外部写入默认低成熟度，可能被整理机制清理）';

export class QoderAdapter extends BaseAdapter {
  constructor(appConfig) {
    super(appConfig);
    /** 解析过程中产生的警告（如无 frontmatter 被跳过），供日志与测试检查 */
    this.warnings = [];
  }

  /** 账号根目录（chokidar 递归监听其下 projects 结构） */
  watchPaths() {
    return this.memoryPaths;
  }

  /** 动态发现 projects/<slug>/<category>/*.md 与 global/<category>/*.md（category 不枚举、动态发现） */
  discover() {
    const files = [];
    for (const root of this.memoryPaths) {
      let hits = [];
      try {
        hits = [
          ...fs.globSync(path.join(root, 'projects', '*', '*', '*.md')),
          // 全局记忆（user_info/user_behavior 等跨项目分类）少一层 slug
          ...fs.globSync(path.join(root, 'global', '*', '*.md')),
        ];
      } catch {
        hits = [];
      }
      for (const h of hits) {
        if (isIgnoredPath(h)) continue;
        try {
          if (fs.statSync(h).isFile()) files.push(h);
        } catch {
          // 文件恰好被删除：跳过
        }
      }
    }
    return files;
  }

  /** M1 摄取白名单：projects/<slug>/<category>/*.md 与 global/<category>/*.md（与 discover 同构，防任意用户文档被摄取） */
  isIngestible(filePath) {
    if (!this.owns(filePath)) return false;
    const resolved = path.resolve(filePath);
    return this.memoryPaths.some((root) => {
      const rel = path.relative(path.resolve(root), resolved);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      const parts = rel.split(path.sep);
      const isProject =
        parts.length === 4 &&
        parts[0] === 'projects' &&
        parts[1] !== '' &&
        parts[2] !== '' &&
        parts[3].endsWith('.md');
      const isGlobal =
        parts.length === 3 && parts[0] === 'global' && parts[1] !== '' && parts[2].endsWith('.md');
      return isProject || isGlobal;
    });
  }

  parse(raw) {
    const content = raw.content;
    // 无 frontmatter（不以 --- 开头，或 gray-matter 解析不出任何字段）→ 警告并跳过
    if (!/^---\r?\n/.test(content)) {
      this.warnSkip(raw.path, '缺少 YAML frontmatter（纯文本会被 Qoder 解析器静默忽略）');
      return [];
    }
    let parsed;
    try {
      parsed = matter(content);
    } catch (err) {
      this.warnSkip(raw.path, `frontmatter 解析失败: ${err.message}`);
      return [];
    }
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      this.warnSkip(raw.path, 'frontmatter 为空');
      return [];
    }
    const data = parsed.data;
    const title =
      data.title || path.basename(raw.path, '.md');
    return [
      makeEntry({
        app: this.id,
        file: raw.path,
        title: String(title).trim(),
        body: parsed.content.trim(),
        frontmatter: data,
        mtime: raw.mtimeMs,
        sha256: raw.sha256,
      }),
    ];
  }

  /** 记录一条跳过警告（去重，避免重复文件反复刷屏） */
  warnSkip(filePath, reason) {
    const msg = `[qoder] 跳过 ${filePath}: ${reason}`;
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  // =========================================================================
  // 写回侧（batch:2 —— 中风险批次：索引型，面板收录后近实时生效）
  // =========================================================================

  /**
   * 由 entry 元数据映射 category，缺省 project_introduction。
   * distill 侧产出的 wiki 页 frontmatter category 字段枚举：project_introduction /
   * project_tech_stack / project_build_configuration / project_environment_configuration /
   * development_code_specification / development_practice_specification /
   * task_summary_experience / common_pitfalls_experience / user_info。
   * L3：校验合法字符集（防 `../` 路径穿越），非法回退 project_introduction。
   * @param {Object} entry Entry
   * @returns {string}
   */
  categoryOf(entry) {
    const c = entry.frontmatter?.category || entry.category;
    const trimmed = typeof c === 'string' ? c.trim() : '';
    if (trimmed && /^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
    return 'project_introduction';
  }

  /**
   * 渲染单条目标文件内容：四字段 frontmatter + 正文（首行 [hub-id] 标记）。
   * @param {Object} entry Entry（需含 hubId/title/body）
   * @returns {string}
   */
  render(entry) {
    const fmSrc = entry.frontmatter || {};
    const toArray = (v, fallback) =>
      Array.isArray(v) && v.length > 0 ? v.map(String) : fallback;
    const titleWords = String(entry.title || '').split(/[\s,，、/-]+/).filter(Boolean).slice(0, 5);
    const fm = {
      title: entry.title,
      usage_scenario: toArray(fmSrc.usage_scenario, ['跨 App 记忆同步召回']),
      keywords: toArray(fmSrc.keywords, titleWords.length > 0 ? titleWords : ['memory-hub']),
      source: 'memory-hub',
    };
    const body = `[${entry.hubId}]\n${String(entry.body || '').trim()}`;
    // 对象传参：避免 gray-matter 把正文中的孤立 --- 误当 frontmatter 解析（同 claude 适配器）
    return matter.stringify({ content: `${body}\n` }, fm);
  }

  /**
   * 写前自检：用 gray-matter 解析渲染结果，四字段缺一（或数组字段非数组）即抛错拒写。
   * @param {string} content render 产出的完整文件内容
   * @throws {Error} 字段缺失时抛出
   */
  selfCheck(content) {
    let parsed;
    try {
      parsed = matter(content);
    } catch (err) {
      throw new Error(`[qoder] 写前自检失败：frontmatter 不可解析: ${err.message}`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (parsed.data[field] === undefined || parsed.data[field] === null || parsed.data[field] === '') {
        throw new Error(`[qoder] 写前自检失败：frontmatter 缺少字段 ${field}，拒绝写入`);
      }
    }
    if (!Array.isArray(parsed.data.usage_scenario) || !Array.isArray(parsed.data.keywords)) {
      throw new Error('[qoder] 写前自检失败：usage_scenario/keywords 必须为字符串数组，拒绝写入');
    }
  }

  /**
   * M6：按 hubId 在 projects/<slug>/ 下【跨全部 category 目录】定位既有文件。
   * 旧逻辑只看目标 category 目录，导致 category 变化时产生重复文件。
   * @param {string} root 账号根目录
   * @param {string} projectSlug projects 子目录
   * @param {string} hubId 条目 hub-id
   * @returns {string|null} 命中文件绝对路径；未找到返回 null
   */
  findByHubId(root, projectSlug, hubId) {
    const projDir = path.join(root, 'projects', projectSlug);
    let dirs;
    try {
      dirs = fs.readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return null;
    }
    for (const d of dirs) {
      const dir = path.join(projDir, d.name);
      const hit = listDirFiles(dir, (name) => name.endsWith('.md')).find((p) =>
        readFileSafe(p).includes(hubId),
      );
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 写回一组条目到 memory_paths/projects/<project_slug>/<category>/。
   * N2 更新语义：按 hubId 跨 category 目录定位既有文件 →
   * - 内容一致 → skipped（幂等）；
   * - 内容不同 → 原位重写（wiki 页更新传播）；文件当前位于哪个 category 均
   *   原位处理，绝不搬移（Qoder 客户端会自行跨 category 整理文件，搬移会与其拉锯）；
   * - 全局未找到 → 按 wiki category 新建。
   * @param {Object[]} entries Entry[]
   * @returns {Promise<Object[]>} 逐条结果（含 note 提示）
   */
  async write(entries) {
    const projectSlug = this.app.project_slug || 'memory-hub';
    const results = [];
    for (const root of this.memoryPaths) {
      for (const entry of entries) {
        const category = this.categoryOf(entry);
        const dir = path.join(root, 'projects', projectSlug, category);
        const content = this.render(entry);
        this.selfCheck(content); // 四字段缺一即抛错拒写（不产生任何磁盘写入）

        // N2：跨 category 目录全局定位既有文件（Qoder 客户端会异步改名/挪目录/删文件，
        // 扫描读取必须容忍瞬时消失的文件）
        const existingPath = entry.hubId ? this.findByHubId(root, projectSlug, entry.hubId) : null;

        if (existingPath) {
          // 文件已存在（无论 Qoder 把它归到哪个 category）：一律原位处理，绝不搬移
          if (readFileSafe(existingPath) === content) {
            results.push({ hubId: entry.hubId, status: 'skipped', targets: [existingPath], reason: '已含 hub-id 标记且内容无变化' });
            continue;
          }
          // 内容有更新：原位重写（保留既有文件名与所在目录，wiki 页后续更新不再永久丢失）
          const preStat = statSafe(existingPath);
          try {
            const { backupDir } = writeFilesSafely(
              [
                {
                  path: existingPath,
                  content,
                  preStat,
                  verifyOpts: { expectFrontmatter: REQUIRED_FIELDS, expectMarker: `[${entry.hubId}]` },
                  app: this.id,
                  hubId: entry.hubId,
                },
              ],
              { dirWindows: [path.dirname(existingPath)] },
            );
            results.push({ hubId: entry.hubId, status: 'written', targets: [existingPath], backupDir, reason: '内容有更新，原位重写', note: QODER_WRITE_NOTE });
          } catch (err) {
            if (err.deferred) {
              results.push({ hubId: entry.hubId, status: 'deferred', targets: [existingPath], reason: `目标文件读写间隙被外部修改（${err.message}），放弃本轮稍后重试` });
              continue;
            }
            throw err;
          }
          continue;
        }

        // 新建：目标文件名撞名防护（同名但不含本 hubId 的他人文件 → 加序号）
        const slug = slugify(entry.title || entry.hubId);
        let fileName = `${slug}.md`;
        let n = 2;
        while (
          fs.existsSync(path.join(dir, fileName)) &&
          !readFileSafe(path.join(dir, fileName)).includes(entry.hubId)
        ) {
          fileName = `${slug}-${n}.md`;
          n += 1;
        }
        const target = path.join(dir, fileName);
        // H2b：撞名时目标文件可能已存在，写前二次比对 mtime/size 防并发覆盖
        const preStat = statSafe(target);
        // N1：Qoder 客户端会在写回后 ~1 秒改名并重写 frontmatter（路径/hash 双变），
        // 除精确 inflight 登记外额外登记目录级宽限窗口（120s），窗口内该目录事件一律抑制
        let backupDir;
        try {
          ({ backupDir } = writeFilesSafely(
            [
              {
                path: target,
                content,
                preStat,
                verifyOpts: { expectFrontmatter: REQUIRED_FIELDS, expectMarker: `[${entry.hubId}]` },
                app: this.id,
                hubId: entry.hubId,
              },
            ],
            { dirWindows: [dir] },
          ));
        } catch (err) {
          if (err.deferred) {
            results.push({ hubId: entry.hubId, status: 'deferred', targets: [target], reason: `目标文件读写间隙被外部修改（${err.message}），放弃本轮稍后重试` });
            continue;
          }
          throw err;
        }
        results.push({ hubId: entry.hubId, status: 'written', targets: [target], backupDir, note: QODER_WRITE_NOTE });
      }
    }
    return results;
  }

  /**
   * 删除传播（tombstone）：按 hubId 跨 category 定位并移除对应文件。
   * 走 removeFilesSafely（备份 + 删除哨兵 inflight 登记），并登记目录级宽限
   * 窗口（N1：Qoder 客户端会在文件变化后异步整理目录，窗口内事件一律抑制）。
   * @param {string[]} hubIds 待移除的 hubId 列表
   * @returns {Promise<Object[]>} 逐条结果 { hubId, status, targets, backupDir }
   */
  async removeEntries(hubIds) {
    const projectSlug = this.app.project_slug || 'memory-hub';
    const results = [];
    const wanted = (hubIds || []).filter(Boolean);
    if (wanted.length === 0) return results;
    for (const root of this.memoryPaths) {
      for (const hubId of wanted) {
        const hit = this.findByHubId(root, projectSlug, hubId);
        if (!hit) continue;
        const { backupDir } = removeFilesSafely(
          [{ path: hit, app: this.id, hubId }],
          { dirWindows: [path.dirname(hit)] },
        );
        results.push({ hubId, status: 'removed', targets: [hit], backupDir });
      }
    }
    return results;
  }

  /**
   * 写回后校验：按 hubId 跨全部 category 目录定位（与 write/findByHubId 同构。
   * N2：Qoder 客户端会自行跨 category 挪动文件，绝不能只查预期 category 单目录，
   * 否则文件刚被客户端归类整理就误判失败、连累整批回滚），命中后四字段齐全即通过。
   * 额外返回 failedIds（未通过校验的 hubId 列表），供写回引擎按条目粒度回滚：
   * Qoder 整理机制可能清理个别刚写入的文件，不应连累同批其他成功条目。
   * @param {Object[]} entries Entry[]
   * @returns {{ ok: boolean, reasons: string[], failedIds: string[] }}
   */
  verify(entries) {
    const projectSlug = this.app.project_slug || 'memory-hub';
    const reasons = [];
    const failedIds = new Set();
    for (const root of this.memoryPaths) {
      for (const entry of entries) {
        const hit = this.findByHubId(root, projectSlug, entry.hubId);
        if (!hit) {
          reasons.push(`[${path.join(root, 'projects', projectSlug)}] 跨全部 category 未找到含 ${entry.hubId} 的文件`);
          failedIds.add(entry.hubId);
          continue;
        }
        try {
          this.selfCheck(fs.readFileSync(hit, 'utf8'));
        } catch (err) {
          reasons.push(err.message);
          failedIds.add(entry.hubId);
        }
      }
    }
    return { ok: reasons.length === 0, reasons, failedIds: [...failedIds] };
  }
}
