# Memory Hub —— AI App 记忆中转站

把本机五个 AI App（Claude Code / Codex / Qoder / QoderWork / 悟空）的记忆
**只读摄取**进统一中转站，经 LLM 整理为主题 wiki，
再**安全写回**各家记忆文件：备份 → 回环抑制 → 原子写 → 校验 → 失败回滚。

目录布局（用户可视内容在桌面，内部数据在底层）：

| 位置 | 内容 |
| --- | --- |
| `~/Desktop/Memory Hub/` | 用户可视：`sources/`（原始快照）、`wiki/`（整理层）、`_index/`（索引）、`logs/`（日志镜像，仅供查看） |
| `~/.memory-hub/` | 底层：`config.json`、`backups/`、`logs/`（权威份）、`state/`（对账指纹/写回日志/回环抑制等内部状态） |

桌面目录误删不丢关键数据：日志权威份与全部内部状态都在底层，
快照也可由各 App 源文件重新摄取（对账指纹在底层，不会重复摄取已有内容）。

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

之后 daemon 自动完成：监听摄取（增量）→ 事件驱动整理写回 —— 窗口内变更达阈值
（缺省 5 条或 64KB）时静默合并（2 分钟，最长推迟 10 分钟）后立即 distill 并链式
writeback；零星变更由每小时一次的兜底扫描收口；daemon 启动后自动对账追赶停机
期间的欠账。手动排障可用 `hub sync`（单次全链路）或 `hub distill` / `hub writeback`。

## 命令全表

| 命令 | 说明 |
| --- | --- |
| `hub init` | 首次引导：创建 `~/.memory-hub` 结构、生成默认配置、自动 scan |
| `hub config` | 查看（或惰性生成）当前配置 |
| `hub scan` | 探测五个 App 的记忆位置并写回 config.json（只读、幂等；保留 notes 中的 readOnly 标注与手动禁用状态） |
| `hub keys` | 列出 Keychain 条目（脱敏）；`--sync` 只读同步密钥来源；`keys list` 同上 |
| `hub keys use <name>` | 切换 `config.llm.keyRef`；可选 `--base-url <url>` / `--model <model>` 一并落盘 |
| `hub watch` | 前台监听增量摄取（Ctrl-C 退出） |
| `hub index` | 全量重建 `_index/master-index.md`（收录全部页面、头部计数用实际值、逐行回填页面 frontmatter 的 hub-id） |
| `hub distill` | LLM 整理 sources → wiki（`--dry-run` / `--max-pages <n>`）；批内内容去重 / 测试标记快照过滤 / 相似主题优先并入既有页，每轮成功后自动重建主索引并登记 `state/pending-writeback.json` 增量写回清单 |
| `hub compact` | wiki 全局归并：同主题近似页簇用 LLM 归并为少数页（`--dry-run` 只出聚类计划 / `--topic <key>` 定向试点 / `--max-clusters <n>`）；输家页备份后删除，赢家页登记增量写回、输家页主 hubId 登记 removals 由写回侧清理 App 侧旧渲染；到期后 daemon 兜底轮自动执行（见 config.compact） |
| `hub writeback` | wiki 条目并行写回各 App（`--app` / `--entry` / `--dry-run` / `--from-sources` / `--force-batch3`）；默认增量：消费 `state/pending-writeback.json` 只写回其中列出的页面，全部成功后原子清空，清单缺失/为空时降级全量并记日志；增量轮次无条件重申 core 条目（被清即复活）；`--core-only` 只刷核心层；`--full` 强制全量广播；`--repair` 修复 codex AGENTS.md 多标记区（见下） |
| `hub doctor` | 健康度体检（纯只读，✅/⚠️/❌ 分级；`--json` 结构化输出；有 ❌ 时退出码非零） |
| `hub search <关键词…>` | wiki 全文检索（grep 级；多关键词 AND，大小写不敏感；`--limit <n>` 缺省 20） |
| `hub promote scan/list/apply/reject` | 晋升管道：四信号打分（跨源/存活/探针/拍板）产提名 → 人工 `apply` 确认后写入 wiki/core/ 长期核心层；`reject` 记负样本 30 天抑制；daemon 每周自动扫描提名（只提名不自动写） |
| `hub promote add/demote` | 手动晋升指定主题页（`--to user-profile` 并入用户画像页）/ 核心页降回 wiki 顶层 |
| `hub core` | 核心层状态：容量水位（上限 50）、每页 category/来源/最近写回记录 |
| `hub eval generate/coverage/report` | 记忆效果评测：LLM 从 wiki 抽样生成事实探针题 / 各 App 记忆语料可达性检测 / 三层评测总报告 |
| `hub tombstone list` | 列出全部删除登记（三态：待 wiki 标记 / 待写回清理 / 已闭环，含 suspectedStorm 风暴标记） |
| `hub tombstone apply` | 显式执行删除传播（含 suspectedStorm 条目；`--dry-run` 只预览影响面，执行前打印影响面并需 `--yes` 确认） |
| `hub tombstone drop <hubId>` | 撤销误登记的 tombstone（`--all-storm` 批量撤销全部风暴标记条目） |
| `hub backup` | 对全部已发现 app 的记忆文件做全量快照备份（backups/full/ 池） |
| `hub rollback` | 从备份目录原子恢复（二次确认；`--dir` / `--app` / `--yes`） |
| `hub sync` | 单次全链路：harvest → distill → writeback（排障/验证） |
| `hub status` | 一屏汇总：app 发现状态 / daemon / watcher / distill（含隔离快照与毒批计数）/ writeback-log / backups / 权威日志路径提示 |
| `hub daemon run` | daemon 主循环（launchd 调用，勿手动执行） |
| `hub daemon install/uninstall/start/stop/status` | launchd 守护管理（幂等、可逆） |

## config.json 字段参考（`~/.memory-hub/config.json`，权限 600）

| 字段 | 说明 |
| --- | --- |
| `apps[].id` | app 标识（claude / codex / qoder / qoderwork / wukong） |
| `apps[].enabled` | 是否启用（scan 未发现的自动置 false；手动置 false 的 app 重扫不会被复活，notes 会标注「检测到但保持禁用」） |
| `apps[].memory_paths` | 该 app 的记忆位置（scan 自动探测；codex 手动追加的工作区 AGENTS.md 会被保留） |
| `apps[].project_slug` | 写回 qoder 时使用的 projects 子目录（多项目时取目录 mtime 最新者，全部候选见 notes） |
| `apps[].readOnly` | `true` 时该 app 只读、永不写回（悟空等存在云端同步覆盖风险的 app 建议开启）；notes 文本含 `readOnly` 字样同样生效，且重扫不丢该标注 |
| `apps[].notes` | 探测备注（scan 写入） |
| `debounceMs` | watcher 事件去抖窗口（缺省 2000ms） |
| `pollIntervalMs` | 轮询对账间隔（缺省 60000ms，防 FSEvents 丢事件） |
| `daemon.sweepIntervalMs` | 兜底全量扫描间隔（缺省 1 小时；收口低于阈值的零星变更 + 写回幂等校验） |
| `daemon.triggerCount` / `daemon.triggerBytes` | 事件触发阈值：窗口内摄取快照条数（缺省 5）/ 正文体积（缺省 64KB），任一达到即提前整理 |
| `daemon.quietMs` | 达阈值后的静默合并窗口（缺省 2 分钟，每次新变更重置，编辑风暴合并为一次 LLM 调用） |
| `daemon.maxDelayMs` | 达阈值后的最长推迟（缺省 10 分钟，持续编辑也不无限期推迟） |
| `writeback.batch3Enabled` | 高风险批次（qoderwork daily / wukong MEMORY.md）总开关，缺省 `false` |
| `tombstone.autoPropagate` | 删除传播自动执行开关，缺省 `false`（保守）：关闭时 unlink 仍登记 tombstone 留证据链，但不自动删 wiki/各 App 内容，需 `hub tombstone apply` 显式执行 |
| `tombstone.stormThreshold` | 删除风暴熔断阈值（缺省 20）：单个适配器一个窗口内登记数超过即熔断 |
| `tombstone.stormWindowMs` | 风暴熔断窗口时长（缺省 600000 = 10 分钟） |
| `distill.testMarkers` | 蒸馏「测试标记」清单（缺省 `HUB-TEST` / `冒烟测试` / `N4 冒烟` / `N4冒烟`）：快照标题/正文命中任一标记即视为测试产物跳过蒸馏 |
| `compact.enabled` | wiki 全局归并自动化开关（缺省 `true`）：到期后由 daemon 兜底/追赶轮自动执行；`false` 时仅 `hub compact` 手动触发 |
| `compact.intervalMs` | 自动归并最小间隔（缺省 24 小时） |
| `compact.minClusterSize` | 主题簇 ≥ 该页数才归并（缺省 3） |
| `compact.maxClustersPerRun` / `compact.maxPagesPerCall` | 单轮最多处理簇数（缺省 4）/ 单次 LLM 调用最多送入页数（缺省 8，大簇分块跨轮收敛） |
| `llm.baseUrl` / `llm.model` | OpenAI 兼容 LLM 端点与模型（`hub keys use` 可一并配置）；批量蒸馏建议非推理模型（推理链占输出配额易致空回复） |
| `llm.keyRef` | Keychain 密钥引用名（密钥本体只在 Keychain，绝不落盘） |
| `llm.hourlyCallCap` / `llm.dailyCallCap` | LLM 调用预算刹车（缺省 0 = 不启用）：hub 自身每小时/每日调用上限（含失败调用，网关同样计数），给同一 AK 的交互使用留余量。超额自动暂停（小时预算 → 暂停 1 小时；日预算 → 暂停到本地次日凌晨）。台账在 `state/llm-usage.json`，仅真实网关调用记账。示例：免费档 10 次/时 + 200 次/天 可配 `8` / `150` |
| `core.enabled` / `core.reassertEveryRound` | 长期核心层（wiki/core/）总开关与每轮重申开关（缺省均 `true`：增量写回无条件重申 core 条目，App 侧被清后自动复活） |
| `core.maxEntries` / `core.survivalDays` / `core.minScore` / `core.scanIntervalMs` | 核心层容量上限（缺省 50）/ 晋升存活信号天数（缺省 15）/ 提名最低信号分（缺省 3）/ daemon 自动扫描提名间隔（缺省 7 天；只产提名，`hub promote apply` 确认后才写 core） |

数据根目录缺省 `~/.memory-hub`，可用环境变量 **`MEMORY_HUB_ROOT`** 覆盖；
用户可视目录缺省 `~/Desktop/Memory Hub`，可用 **`MEMORY_HUB_USER_ROOT`** 覆盖
（设置了 `MEMORY_HUB_ROOT` 时自动落回其 `hub/` 子目录，测试/多实例隔离绝不写真实桌面；配置文件中不设对应字段，
旧版遗留的 `hubRoot` 死字段会在加载时剔除、下次保存时自动清洗）。

## 备份与回滚

- 写回每个 App 写后都会调用适配器 verify() 做产线校验，失败则按本批备份自动回滚
  并标记 failed（具体原因落 `logs/writeback.log`）；codex 适配器额外断言标记区计数
  必须为 1 且无孤儿标记，写路径遇历史坏文件（多标记区/孤儿标记/区外遗留块）会自动收敛自愈。
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

## 健康度体检与检索（hub doctor / hub search）

`hub doctor` 对中转站做一次性体检，**纯只读、绝不修改任何数据**，报告按 ✅/⚠️/❌ 分级，
存在 ❌ 项时以非零码退出（便于脚本告警）；`--json` 输出结构化报告。九项检查：

| 检查项 | 内容与分级 |
| --- | --- |
| 索引完整率 | wiki 实际页数 vs master-index 收录数（缺页 ❌，列缺失示例 ≤10）、陈旧行与 hub-id 回填率（⚠️） |
| 重复标题 | 按各页 H1/frontmatter title 统计重复组数（⚠️） |
| 隔离与失败 | distill-state 的 quarantined 隔离快照数 / poisonedBatches 毒批数 / 未达隔离阈值的失败批次数（⚠️） |
| distill 积压 | 未整理快照估算（只读扫描；>50 ⚠️，>500 ❌） |
| 写回健康 | writeback-log 最近 50 条 failed 计数（⚠️）、pending-writeback.json 滞留超 24h（❌，链路卡死）、logs/writeback.log 最近失败记录（⚠️） |
| 备份池 | full/writeback 池内数量 vs 上限、池外遗留目录数与总体积（⚠️；只报告绝不代删） |
| 锁状态 | state/*.lock 逐把检查：持有者 pid 存活、心跳 mtime 新鲜度（陈旧锁 ⚠️，withLock 会自动清理） |
| 测试污染 | wiki 中含测试标记（config.distill.testMarkers，缺省 HUB-TEST/冒烟测试 等）的页面清单（❌，会经写回扩散到各 App） |
| 删除传播 | tombstone 三态统计：待确认删除数（autoPropagate 关闭时提示 hub tombstone apply）、suspectedStorm 风暴标记数（⚠️）、登记超 7 天未闭环数（⚠️） |

```bash
hub doctor          # 人类可读报告（✅/⚠️/❌ 逐项 + 结论行）
hub doctor --json   # 结构化报告（checks[]/counts/ok），供脚本消费
```

`hub search <关键词…>` 对 wiki/ 做 grep 级全文检索：标题/tags/frontmatter/正文均参与匹配，
大小写不敏感，多关键词为 AND 关系；输出命中页相对路径、标题、hub-id、首个命中行摘录（行号）；
`--limit <n>` 控制展示条数（缺省 20，总命中数照报）。

```bash
hub search 商品对比 CVR --limit 10
# 关键词: 商品对比 AND CVR —— 命中 3 页
# 1. product-compare-cvr.md · 商品对比CVR口径（hub-id: hub-20260801-abcd）
#    L12: CVR 新口径按判卡内拆分…
```

## 写回模式：增量 / 全量 / 修复（hub writeback）

- **默认增量**：消费 `state/pending-writeback.json`（distill 每轮成功后登记），只写回其中
  列出的页面；全部启用 app 写回成功后原子清空；清单缺失/为空时降级全量并记日志；
- **`hub writeback --full`**：强制全量广播（忽略增量清单，不清空 pending），适用于怀疑
  各 App 内容与 wiki 不一致时的一次性对齐；
- **`hub writeback --repair [--app codex]`**：修复 codex AGENTS.md 历史损坏文件
  （目标缺省从 config 读 codex 的 memory_paths，目前仅支持 codex）：提取全部区内块、
  按 hub-id 去重（保留最后出现的版本）、在首区位置重建单一区，区外内容原样保留；
  同时清除全部无法配对的孤儿 start/end 标记（返回值 orphanMarkers 计数），区外遗留的
  `### 标题 [hub-…]` 写回块按保守边界归并进单一区参与去重（非 hub- 前缀的用户块与
  代码围栏内容永不触碰；无法安全判定边界的只列入返回值 strayBlocks 清单不动原文）；
  clean 判定为「区数≤1 且无孤儿标记且无可归并区外块」，同一损坏输入修一次即收敛（幂等）；
  走备份→原子写→校验→失败回滚，逐文件输出三态（missing/clean/repaired）与去重统计。

```bash
hub writeback --repair
# codex AGENTS.md 标记区修复（--repair）:
#   🔧 /path/ws/AGENTS.md —— repaired：2 个标记区合并为 1 个，块 3 → 2（去重 1）
#      备份: ~/.memory-hub/backups/writeback/2026-08-07T…（可 hub rollback --dir 恢复）
```

## 删除传播（tombstone，防已删记忆复活）

用户在某 App 里删掉的记忆，不会被下一轮写回“复活”回来；同时为防 git checkout /
`reset --hard` / rsync `--delete` / 同步工具重建等场景的 unlink 风暴被误识为批量删除，
传播链路带两道安全阀（开关 + 风暴熔断）：

- **删除检测**（watcher）：监听到源记忆文件被删（unlink）后去抖确认（编辑器“删+重建”
  原子保存不误判），按源路径反查对应快照 hubId，登记到 `state/tombstones.json`
  （记 hubId/源 app/源路径/删除时间；写回引擎自己删文件走删除哨兵抑制，不会回流误判）；
- **wiki 侧标记**（distill 每轮开始时消费）：页内对应 `[hub-id]` 条目块剔除；整页 hubId
  全部被删时 frontmatter 标 `deleted: true` 原地保留（不移动、可人工回看）；被删 hubId
  同时记入 distill-state（`skipped: tombstone`），旧快照不会重新蒸馏复活；
- **写回侧移除**（writeback）：渲染时过滤 tombstoned hubId（即使 wiki 尚未标记也先拦截），
  并对已写到各 App 的对应条目做一次移除（codex 区内块删除 / claude 条目文件+索引行 /
  qoder 对应文件），全部走备份→删除→失败回滚管线，完成后打 `appsCleaned` 点不再重复；
- **解除（用户重建记忆）**：同源路径重新出现内容被摄取，或同 hubId 出现更新的快照，
  tombstone 自动解除，内容重新进入正常蒸馏/写回流程（解除不受传播开关影响，始终执行）。

### 传播开关与风暴防护（MUST-2 安全阀）

- **`tombstone.autoPropagate`（缺省 `false`，保守）**：关闭时 watcher 仍登记 tombstone
  （证据链完整），但 distill 不做 wiki 删除、writeback 不做各 App 条目移除，仅在日志与
  `hub doctor` 中提示“有 N 条待确认的删除”；确认后用 `hub tombstone apply` 显式执行
  （`--dry-run` 先预览将影响的 wiki 页与各 App 目标，执行需 `--yes` 确认）；开启后才全自动传播；
- **风暴熔断**：单个适配器在一个窗口（`tombstone.stormWindowMs`，缺省 10 分钟）内登记数
  超过阈值（`tombstone.stormThreshold`，缺省 20）即熔断：本窗口后续 unlink 只记日志不登记，
  窗口内已登记条目打 `suspectedStorm: true` 标记；自动传播（若开启）跳过带此标记的条目，
  需 `hub tombstone apply` 人工确认，或 `hub tombstone drop --all-storm` 批量撤销误登记；
- **可观测**：`hub tombstone list` 展示三态清单（待 wiki 标记/待写回清理/已闭环）与风暴标记；
  `hub doctor` 的「删除传播」检查项报告待确认数、suspectedStorm 数与登记超 7 天未闭环数。

边界：聚合文件（如 codex AGENTS.md）内单条目删除不产生 unlink 事件，当前不检测（仅整文件
删除触发）；wiki 页中被 LLM 归并进无 `[hub-id]` 标记的散文段落无法定位剔除，只能靠页级
`deleted` 标记兜底。

## Qoder 留存快照脚本（scripts/qoder-retention-snapshot.js）

评估 Qoder 整理机制对 hub 写回记忆的清理周期（半衰期）与核心层重申效果：

```bash
node scripts/qoder-retention-snapshot.js            # 追加一次快照（state/qoder-retention.jsonl）
node scripts/qoder-retention-snapshot.js --report   # 只读汇总：留存曲线 / 半衰期估算 / 核心层复活统计
```

机器相关路径全部自动探测，无需硬编码：

| 配置 | 缺省行为 | 覆盖方式 |
| --- | --- | --- |
| Qoder profile 目录 | 自动探测 `~/.qoder/memories/<id>/projects`（多个 profile 时取最近活跃者） | 环境变量 `QODER_PROFILE_DIR=/path/to/.qoder/memories/<id>` |
| 项目 slug 清单 | 自动枚举 projects/ 下全部子目录 | 环境变量 `QODER_PROJECT_SLUGS=SlugA,SlugB`（逗号分隔，固定口径时建议显式限定） |
| 快照台账 / 核心层目录 | `state/qoder-retention.jsonl` 与 `wiki/core/` | 随 `MEMORY_HUB_ROOT` / `MEMORY_HUB_USER_ROOT` 环境变量生效 |

`--report` 只读模式不要求本机存在 Qoder 目录，可在任意机器上汇总 jsonl。
搭配定时任务（如每日一次快照）可积累衰减曲线；核心层条目预期重申覆盖 100%，
复活频繁（>10 次）提示应在 Qoder 面板手动确认提升记忆成熟度。

## 日志与排障

- `~/.memory-hub/logs/daemon.log` / `watcher.log` / `distill.log` / `writeback.log`：底层权威份，超 5MB 自动滚动，保留最近 3 份；
  同名镜像同步写入 `~/Desktop/Memory Hub/logs/` 供直接查看，桌面份误删不影响权威份；
  其中 `writeback.log` 专记写回诊断：失败具体原因（异常消息/备份目录/堆栈首行）、
  增量降级全量、pending 保留重试等决策，供用户自助排障；
- 写回记录 `state/writeback-log.json`：JSONL 格式纯追加，保留最近 2000 条（超体积上限才重写裁剪，旧版 JSON 数组格式首次追加时自动迁移）；
- distill 健壮性：LLM 调用对 429/5xx/超时做指数退避重试（2 次），请求体超网关上限（TooLarge）时批次自动对半拆分重试，打包时按 ≤4MB 请求体预算预切分；
  单批失败只跳过该批（下轮重试），不终止整轮；LLM 输出解析失败累计 3 次的批次记入 `state/distill-state.json` 的 `poisonedBatches` 隔离清单并告警一次，不再重放；
- frontmatter 损坏的快照先做净化重试（剥离 `**` 等 Markdown 语法），仍不可解析则移入 `sources/_quarantine/<app>/`（保留相对路径）并记入 distill-state 的 `quarantined` 清单，日志只记一次，后续扫描跳过隔离区；
- wiki 页面质量：每页 frontmatter 带 `category` 分类（枚举校验，缺省 `project_introduction`），slug 统一英文 kebab-case、标题中文；<400B 薄页并入同批主题页，合并结果不以孤立标题结尾，单页超 24KB 时下次更新触发 LLM 整页重写归并而非追加「## 更新」；
- 主索引 `_index/master-index.md` 每轮 distill 成功后全量重建：包含全部页面、头部计数用实际值、每行回填页面 frontmatter 的 hub-id；
- `launchd.out.log` / `launchd.err.log`：launchd 直接追加，daemon 启动时轮转；
- `hub daemon status` 显示 daemon.log 尾 10 行；config.json 损坏时 daemon 降级缺省配置运行并记 error，连续启动失败超 5 次会主动 bootout 自身终止重启风暴。

## 已知限制

- 仅支持 macOS（Keychain / launchd / FSEvents）；
- Node ≥ 24；
- qoderwork daily / wukong 写回属高风险批次，默认禁用（`writeback.batch3Enabled`）；
- distill 依赖 OpenAI 兼容 LLM，未配置时优雅降级（sources 保留、下轮重试）；
- macOS SwiftUI 菜单栏 GUI 版为后续阶段交付（当前仅 CLI + daemon）。
