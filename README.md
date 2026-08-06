# Memory Hub —— AI App 记忆中转站

把本机五个 AI App（Claude Code / Codex / Qoder / QoderWork / 悟空）的记忆
**只读摄取**进统一中转站（`~/.memory-hub/hub/`），经 LLM 整理为主题 wiki，
再**安全写回**各家记忆文件：备份 → 回环抑制 → 原子写 → 校验 → 失败回滚。

## 安装

要求：macOS（Keychain / launchd / FSEvents 依赖）、Node ≥ 24。

```bash
git clone <本仓库> && cd memory-hub
npm install
npm link          # 注册全局命令 hub（nvm 环境下落在 ~/.nvm 内，无需 sudo）
hub --version
```

> 开发模式也可不经 link 直接运行 `node src/cli.js <命令>`，行为与 `hub` 完全等价
>（`hub` 本身就是指向 `src/cli.js` 的全局软链）。注意：launchd 守护的 plist
> 固定使用 node 绝对路径 + `cli.js`，不依赖 `hub` shim，卸载/重装 link 不影响 daemon。

## 快速上手（五步）

```bash
hub init                 # 1. 建目录 + 默认配置 + 自动 scan 探测五个 App
hub keys --sync          # 2. 只读同步 LLM 密钥到 Keychain（distill 需要）
hub keys use idealab \
  --base-url https://idealab.alibaba-inc.com/api/openai/v1 \
  --model qwen3-max      # 3. 选定密钥并补齐 llm.baseUrl / llm.model
hub daemon install       # 4. 安装 launchd 后台守护（开机自启 + 崩溃自拉起）
hub status               # 5. 一屏汇总状态
```

之后 daemon 自动完成：监听摄取（增量）→ 每 5 分钟 distill → 每 10 分钟 writeback。
手动排障可用 `hub sync`（单次全链路）或 `hub distill` / `hub writeback`。

## 命令全表

| 命令 | 说明 |
| --- | --- |
| `hub init` | 首次引导：创建 `~/.memory-hub` 结构、生成默认配置、自动 scan |
| `hub config` | 查看（或惰性生成）当前配置 |
| `hub scan` | 探测五个 App 的记忆位置并写回 config.json（只读、幂等；保留 notes 中的 readOnly 标注） |
| `hub keys` | 列出 Keychain 条目（脱敏）；`--sync` 只读同步密钥来源；`keys list` 同上 |
| `hub keys use <name>` | 切换 `config.llm.keyRef`；可选 `--base-url <url>` / `--model <model>` 一并落盘 |
| `hub watch` | 前台监听增量摄取（Ctrl-C 退出） |
| `hub index` | 重建 `_index/master-index.md` |
| `hub distill` | LLM 整理 sources → wiki（`--dry-run` / `--max-pages <n>`） |
| `hub writeback` | wiki 条目并行写回各 App（`--app` / `--entry` / `--dry-run` / `--from-sources` / `--force-batch3`） |
| `hub backup` | 对全部已发现 app 的记忆文件做全量快照备份（backups/full/ 池） |
| `hub rollback` | 从备份目录原子恢复（二次确认；`--dir` / `--app` / `--yes`） |
| `hub sync` | 单次全链路：harvest → distill → writeback（排障/验证） |
| `hub status` | 一屏汇总：app 发现状态 / daemon / watcher / distill / writeback-log / backups |
| `hub daemon run` | daemon 主循环（launchd 调用，勿手动执行） |
| `hub daemon install/uninstall/start/stop/status` | launchd 守护管理（幂等、可逆） |

## config.json 字段参考（`~/.memory-hub/config.json`，权限 600）

| 字段 | 说明 |
| --- | --- |
| `apps[].id` | app 标识（claude / codex / qoder / qoderwork / wukong） |
| `apps[].enabled` | 是否启用（scan 未发现的自动置 false） |
| `apps[].memory_paths` | 该 app 的记忆位置（scan 自动探测；codex 手动追加的工作区 AGENTS.md 会被保留） |
| `apps[].project_slug` | 写回 qoder 时使用的 projects 子目录 |
| `apps[].readOnly` | `true` 时该 app 只读、永不写回（悟空等存在云端同步覆盖风险的 app 建议开启）；notes 文本含 `readOnly` 字样同样生效，且重扫不丢该标注 |
| `apps[].notes` | 探测备注（scan 写入） |
| `debounceMs` | watcher 事件去抖窗口（缺省 2000ms） |
| `pollIntervalMs` | 轮询对账间隔（缺省 60000ms，防 FSEvents 丢事件） |
| `writeback.batch3Enabled` | 高风险批次（qoderwork daily / wukong MEMORY.md）总开关，缺省 `false` |
| `llm.baseUrl` / `llm.model` | OpenAI 兼容 LLM 端点与模型（`hub keys use` 可一并配置） |
| `llm.keyRef` | Keychain 密钥引用名（密钥本体只在 Keychain，绝不落盘） |

数据根目录缺省 `~/.memory-hub`，可用环境变量 **`MEMORY_HUB_ROOT`** 覆盖
（测试与多实例隔离用；配置文件中不设对应字段）。

## 备份与回滚

- `hub backup`：全量快照进 **backups/full/**（保留最近 10 份），写回每批自动备份进
  **backups/writeback/**（保留最近 20 份）。两池分离，全量恢复点不会被写回备份挤出。
- `hub rollback`：缺省取 **full 池最新**备份；`--dir` 可传完整路径或时间戳名/前缀片段
  （两池都会搜）；依赖备份目录内 `manifest.json` 做路径映射，恢复走原子写，
  写回新增的文件会被删除做到零残留。恢复前有二次确认（`--yes` 跳过）。

## 密钥同步来源（`hub keys --sync`）

| 引用名 | 来源 | 说明 |
| --- | --- | --- |
| `codex-openai` | `~/.codex/auth.json` 的 `OPENAI_API_KEY` | Codex 登录态 |
| `idealab` | `~/.zshrc` / `~/.zprofile` 的 `export IDEALAB_API_KEY=...` | 本机 Claude Code 走该内网网关，已覆盖 "Claude Code" 侧需求 |
| `claude-anthropic` | shell rc 的 `export ANTHROPIC_API_KEY=...` | 存在才收录，面向直连 Anthropic 的部署 |

覆盖既有 Keychain 条目时会明确提示「已覆盖既有条目」，绝不静默覆盖。

## 日志与排障

- `~/.memory-hub/logs/daemon.log` / `watcher.log` / `distill.log`：超 5MB 自动滚动，保留最近 3 份；
- `launchd.out.log` / `launchd.err.log`：launchd 直接追加，daemon 启动时轮转；
- `hub daemon status` 显示 daemon.log 尾 10 行；config.json 损坏时 daemon 降级缺省配置运行并记 error，连续启动失败超 5 次会主动 bootout 自身终止重启风暴。

## 已知限制

- 仅支持 macOS（Keychain / launchd / FSEvents）；
- Node ≥ 24；
- qoderwork daily / wukong 写回属高风险批次，默认禁用（`writeback.batch3Enabled`）；
- distill 依赖 OpenAI 兼容 LLM，未配置时优雅降级（sources 保留、下轮重试）；
- macOS SwiftUI 菜单栏 GUI 版为后续阶段交付（当前仅 CLI + daemon）。
