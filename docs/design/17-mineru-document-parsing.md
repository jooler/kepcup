# 17 文档解析（MinerU）

Bot 需要读到 PDF（及扫描件、Office 文档、EPUB、网页存档等）的**原文**——包括 OCR、表格、公式的保真还原——并能把它沉淀进自己的 Wiki。对话中读原文的能力通过**预置公共技能接入官方 MinerU Agent Skill** 实现：MinerU 是 OpenDataLab 开源的一站式文档解析工具（AGPL-3.0），其仓库内自带官方 Agent Skill（`skills/mineru/SKILL.md`），随 MinerU 本体一起演进。

> **与 D85 的关系**：Wiki 入库的 PDF/Office 派生由宿主管线调用 MinerU（见 [36-wiki-multimodal-ingest.md](36-wiki-multimodal-ingest.md)）。本文的预置技能只用于**对话中读原文**，不再是入库路径。二者共享环境管理器 catalog 中的同一 MinerU 安装（D85 起由宿主安装，技能复用），见下文「与 Wiki 的分工」「环境与已知风险」。

## 方案选择

2026-10 调研对比了官方 Skill 与若干第三方封装（打包虚拟环境的 Converter Skill、双通道路由的 mineru-local、其他宿主的脚本封装、MCP Server 形态），结论是只有官方方案同时满足三个条件：

1. **解析质量**——VLM 档位对公式、表格、扫描件 OCR 的还原远超 pdfplumber 类纯文本提取；
2. **产物形态**——直接产出 Markdown，对话阅读与 Wiki 派生（D85）都无需中间转换；
3. **跟随官方更新**——Skill 本体是官方仓库内的单文件，随 MinerU 版本演进。

第三方方案被排除的原因：打包 venv（约 3.4GB）超出技能库单文件 50MB 上限且已过时；双通道路由的语义官方 Skill 已内置（本地优先 + 显式上云授权）；MCP 形态进不了本宿主运行时（技能扫描把 `mcp__` 判为不兼容，Bot 无 MCP 客户端）；其他宿主的脚本封装绑定了别家的执行环境。

**引入方式为逐字 vendored**（不改写、不翻译、不删节）：本宿主的静态扫描（宿主专有能力词、frontmatter 声明）对官方原文全部通过，逐字引入让"跟随官方更新"成为纯机械操作（同步脚本 + 递增版本号）；任何改写都会让每次同步变成人工比对。代价是技能正文为英文——市场的中文名、一句话介绍与试用语由 `catalog.json` 承担，不影响发现与触发。

## 交付形态

```text
apps/desktop/resources/preset-skills/
  mineru/SKILL.md        -- 官方原文逐字拷贝（锁定上游 commit，见 NOTICE.md）
  catalog.json           -- 增加条目（id=mineru，vendored=true 标记）
  NOTICE.md              -- 记录上游来源、commit 锚点、许可证（AGPL-3.0）
scripts/
  sync-mineru-skill.mjs  -- 从上游拉取最新 SKILL.md（--check 模式只比对）
```

- **安装语义不变**：市场「添加」→ 公共技能（`public_skills`），一次安装全体 Bot 可用；应用升级时按内容哈希对比给出「更新」。
- **描述长度例外**：官方 description 约 600+ 字符，超出随包原创技能 300 字符的提示词预算约定。vendored 条目放宽到 `SKILL_DESCRIPTION_MAX_CHARS`（1024）——官方文本是经过上游调优的触发描述，不擅自删节；`<skills>` 段的展示截断由既有机制兜底。
- **许可**：上游 AGPL-3.0 允许在保留许可与出处的前提下原样再分发；本项目（GPL-3.0）将其作为**独立第三方作品**对待，不主张、不改变其许可，NOTICE.md 逐条记录。运行时复制进用户技能库的是同一文件与同一许可。

## 运行形态

Skill 安装后，Bot 在响应 loop 中按官方手册使用 `mineru` CLI，两种模式对应两类需求：

| 模式 | 命令形态 | 用途 |
|---|---|---|
| 对话中读原文 | `mineru parse x.pdf --json` + `next_request` 分页续读 | 长文档按页/块读取，`doc:{id}/tier:{tier}/page:N/block:N` 稳定定位符可被 Bot 引用 |
| 全量导出 | `mineru parse x.pdf --pages all --output x.md` | 用户明确要一份完整 Markdown 文件时使用（官方规则：`--pages all` 仅在用户要全文档或文档明确较小时使用）。**不用于 Wiki 入库**——入库由宿主派生（见下文） |

质量档位四档（flash / basic / standard / advanced），macOS Apple Silicon 官方推荐 `standard`（PyTorch + llama.cpp，模型约 2GB，建议 16GB 内存）；`basic` 走 ONNX 纯 CPU（约 0.8GB）是低配兜底。对话路径按官方手册选择档位；Wiki 宿主派生在 P0 只用不依赖常驻服务的一次性 CLI 档位，`standard` 及以上待下文 spike 1 结论后在 D85 P1 接入。

**隐私规则与宿主审批模型同构**：默认本地解析；`--remote` 上传云端必须用户显式同意，本地失败不允许静默回退远端；安装、升级、模型下载均要求 Agent 先征求用户同意——与 [13-permissions.md](13-permissions.md) 的逐条确认、D13 的环境安装确认一致，无需额外机制。

## 与 Wiki 的分工（D85）

| 用户意图 | 路径 | Bot 做什么 |
|---|---|---|
| 「这份 PDF 第 3 章讲了什么」「帮我看下这个表」 | 对话中读原文（本技能） | 用 `mineru parse --json` 分页读，答复中可引用页/块定位符 |
| 「学一下」「记住这份资料」「整理进知识库」 | Wiki 入库（宿主派生，36） | **只调用** `wiki_enqueue`（附件 id 或文件路径），**不要**自己先用 MinerU 导出 Markdown |
| 两者都要 | 先入库，再按需对话读原文 | 两条路径共用同一安装，互不依赖 |

入库后：原件进仓外 `wiki-store/`，MinerU 产出的 `full.md` 进 `raw/_derived/{assetId}/`，资产清单在 `raw/_assets/`，维护 loop 再写 `pages/`。页面引用资产，MinerU 页/块定位符可写入脚注（见 36 §3.2）。旧流程「Bot 先导出 x.md 再 `wiki_enqueue(file)`」已废弃：它会与宿主派生重复解析、重复计费，且导出的 md 与原件之间没有血缘。

## 环境与已知风险

`mineru` CLI 由**环境管理器**按 catalog 条目安装（`uv tool install "mineru>=4.0,<5"`，走 D13 安装审批，安装卡说明模型下载体积；Windows 装入 WSL2 发行版），安装位置在应用工具链目录，并暴露在 Bot 执行环境的 PATH 上——官方 Skill 探测到已安装就不会再自行安装。早期由 Bot 按 Skill 自行 `uv tool install` 的用户，宿主定位时同时检查 `uv tool dir`，找到即复用。模型首次使用时下载。三项运行时行为需要实机验证（spike 清单）：

1. **常驻服务**：`standard` 以上档位依赖 `mineru server start` 后台服务，沙箱逐命令 exec 能否跨命令保活 daemon 待验证；备选是把 parse server 提升为宿主级托管（类似 core-host 形态）。结论同时决定 D85 P1 的宿主派生档位。
2. **沙箱写路径**：uv 写 `~/.local/share/uv`、模型写 `~/.mineru`，均在 workspace 之外；catalog 安装把两者重定向到工具链目录，沙箱只需只读暴露。
3. **长任务**：全量解析大文档耗时显著。对话路径注意命令超时与分页续读的取舍；入库路径在独立 derive 通道里跑，可断点续跑（36 §3.3）。

## 跟随官方更新

- 锚点：NOTICE.md 记录引入时的上游 commit（当前 `bea1f6f`，2026-09-23）。
- 同步：`node scripts/sync-mineru-skill.mjs`（默认 master；`--check` 只比对，可挂 CI）；同步后**必须递增** `catalog.json` 中该条目的 version，市场才能给出「更新」。
- 版本约束由官方文本自身承载（`mineru>=4.0,<5`），catalog 条目使用同一约束。CLI 小版本升级可由 Skill 内置的审批式升级流程或环境管理器完成，两者作用于同一安装；宿主派生前校验版本落在约束内，不需要随应用发版。
