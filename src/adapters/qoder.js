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
 *   category 由 entry 元数据映射，缺省 project_introduction）；
 * - 文件 = YAML frontmatter 四字段 title/usage_scenario[]/keywords[]/source:"memory-hub" + 正文，
 *   正文首行含 [hub-id] 标记；
 * - 写前自检：用 gray-matter 解析渲染结果，四字段缺一即抛错拒写；
 * - 写成功后提示用户在知识中心面板确认以提升成熟度。
 */

import path from 'node:path';
import fs from 'node:fs';
import matter from 'gray-matter';
import { BaseAdapter, makeEntry, isIgnoredPath, slugify, listDirFiles } from './base.js';
import { statSafe, writeFilesSafely } from './write-utils.js';

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

  /** 动态发现 projects/<slug>/<category>/*.md（category 不枚举、动态发现） */
  discover() {
    const files = [];
    for (const root of this.memoryPaths) {
      let hits = [];
      try {
        hits = fs.globSync(path.join(root, 'projects', '*', '*', '*.md'));
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

  /** M1 摄取白名单：仅 projects/<slug>/<category>/*.md（与 discover 同构，防任意用户文档被摄取） */
  isIngestible(filePath) {
    if (!this.owns(filePath)) return false;
    const resolved = path.resolve(filePath);
    return this.memoryPaths.some((root) => {
      const rel = path.relative(path.resolve(root), resolved);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      const parts = rel.split(path.sep);
      return (
        parts.length === 4 &&
        parts[0] === 'projects' &&
        parts[1] !== '' &&
        parts[2] !== '' &&
        parts[3].endsWith('.md')
      );
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
    return matter.stringify(`${body}\n`, fm);
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
   * 写回一组条目到 memory_paths/projects/<project_slug>/<category>/。
   * 幂等：目标 category 目录下已有文件含该 hub-id 标记 → 跳过。
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

        // 幂等：category 目录下任一文件已含该 hub-id 标记 → 跳过
        if (entry.hubId) {
          const existing = listDirFiles(dir, (name) => name.endsWith('.md'));
          const hit = existing.find((p) => fs.readFileSync(p, 'utf8').includes(entry.hubId));
          if (hit) {
            results.push({ hubId: entry.hubId, status: 'skipped', targets: [hit], reason: '已含 hub-id 标记' });
            continue;
          }
        }

        const content = this.render(entry);
        this.selfCheck(content); // 四字段缺一即抛错拒写（不产生任何磁盘写入）

        const fileName = `${slugify(entry.title || entry.hubId)}.md`;
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
   * 写回后校验：解析目标文件，四字段齐全且正文含 [hub-id] 标记。
   * @param {Object[]} entries Entry[]
   * @returns {{ ok: boolean, reasons: string[] }}
   */
  verify(entries) {
    const projectSlug = this.app.project_slug || 'memory-hub';
    const reasons = [];
    for (const root of this.memoryPaths) {
      for (const entry of entries) {
        const dir = path.join(root, 'projects', projectSlug, this.categoryOf(entry));
        const files = listDirFiles(dir, (name) => name.endsWith('.md'));
        const hit = files.find((p) => fs.readFileSync(p, 'utf8').includes(entry.hubId));
        if (!hit) {
          reasons.push(`[${dir}] 未找到含 ${entry.hubId} 的文件`);
          continue;
        }
        try {
          this.selfCheck(fs.readFileSync(hit, 'utf8'));
        } catch (err) {
          reasons.push(err.message);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }
}
