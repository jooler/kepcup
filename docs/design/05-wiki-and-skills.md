# 05 Wiki 与 Skills

## Wiki：Bot 的大脑

每个 Bot 挂载一个自己维护的 LLM Wiki，采用 Karpathy 提出的 LLM Wiki 模式。

```text
wiki/                  -- git 管理（内嵌 git 库），每次维护提交一次，可回滚
  SCHEMA.md            -- 维护规范：页面类型、命名、链接、引用格式
  index.md             -- 目录，每页一行摘要
  log.md               -- 只追加的变更日志
  raw/                 -- 原始资料，只增不改
  pages/               -- LLM 维护的知识页面（实体、概念、主题……）
```

`raw/` 的来源：用户给的文档、抓取的网页、有价值的执行产出。复杂文档（PDF、扫描件、Office 等）经预置的 MinerU 文档解析技能导出为 Markdown 后入库，原始文件与转换产物并存（见 [17-mineru-document-parsing.md](17-mineru-document-parsing.md)）。

### 读写规则

- **单一写入者**：响应 loop 对 Wiki 只读，通过 `wiki_search`、`wiki_read` 查询；需要入库时调用 `wiki_enqueue(source, note)` 排队，由独立的 Wiki 维护 loop 串行执行。
- Wiki 中不得出现用户的个人信息（那是记忆的职责），体检时检查这一条。
- Bot 之间的 Wiki **完全隔离**，分享知识通过消息附件。

### 维护操作

- **入库（ingest）**：读取一份原始资料，更新或新建多个页面，同时更新 `index.md` 和 `log.md`。
- **体检（lint）**：定期检查矛盾、过时内容、孤立页面、缺失的引用、个人信息。
- **删除**：整页不再需要时，维护 loop 用 `delete` 工具删除页面（限 `pages/` 下的文件）并同步更新 `index.md`；用户也可以在界面上删除页面。所有删除都是追加式的 git 新提交，历史不改写，随时可回滚恢复。

### 触发来源

- 用户要求，例如“学一下这份文档”
- Bot 在工作中认为某样东西值得沉淀
- 反思 loop 提出建议
- 定时体检

入库、体检、整理都是 Bot 自己的知识库事务（见 [01-conversation.md](01-conversation.md) 消息原则）：完成与进展不进入对话，不向用户播报（“你给的文档我读完了”这类汇报已废弃）；入库成功后 Bot 直接通过检索引用新内容。终态失败（重试耗尽）以内部事件触发 Bot，由 Bot 用自己的话向用户交代一句。

## Skills：Bot 的工具

### 格式

采用 Agent Skills 标准，与 Claude Code、Codex 的技能生态一致，可直接导入：

```text
{skill}/
  SKILL.md        -- frontmatter 含 name、description，正文为使用说明
  scripts/
  references/
  assets/
```

### 来源与作用域

- **公共**：扩展中心的 Skills 分组（原「技能市场」，随应用分发的预置目录）安装，落入 `public_skills`——**一次安装，所有 Bot 都能发现并调用**；启停与卸载是全局的，从任意 Bot 的技能面板操作。预置目录内允许出现 **vendored 条目**（逐字引入的上游官方技能，如 MinerU，见 [17-mineru-document-parsing.md](17-mineru-document-parsing.md)）：不改写、用同步脚本跟随上游，NOTICE.md 记录来源与许可。未安装的预置技能对模型可见（`<recommended_skills>` 段），模型可经 `install_skill` 请求用户授权安装——文件识别技能路由见 [22-file-skill-routing.md](22-file-skill-routing.md)。
- **私有**：从 git 仓库导入，锁定到具体 commit 或内容哈希，按 Bot 独立安装（需审批确认）；统一存放在用户级只读技能库中，Bot 的 `bot_skills` 行只记录引用和版本。
- **自建**：由 Bot 的技能生成 loop 产出，属于该 Bot。

**遮蔽规则**：某 Bot 拥有同名私有技能时，公共版本对该 Bot 隐藏（列表、提示词、可读目录均不见），其他 Bot 不受影响——Bot 自己的技能优先。

### 自建流程

- 触发条件：反思 loop 发现同一类任务成功完成 2～3 次，或用户说“以后都这样做”。
- 流程：草稿 → 沙箱试跑 → 通过后**自动启用**，并在对话中告知用户（例如“我整理了一个新技能：xxx”）。
- 用户可以随时停用。

### 修改规则

- 导入的技能不原地修改。Bot 想改进时，先复制一份成为自建技能再改。
- 自建技能用 git 管理版本。

### 加载方式

渐进式加载（该 Bot 的私有技能 + 未被遮蔽的公共技能）：

1. 平时只注入技能的名字和描述
2. 需要时调用 `load_skill(name)` 读取全文
3. 脚本只在沙箱中执行

### 兼容性

- 外部技能默认宿主环境提供 Bash、Read、Write、Edit、Grep 等基础工具。运行时需在沙箱中提供**同名、同语义**的工具，导入的技能才能直接运行。
- 依赖宿主专有能力（特定 MCP 服务器、Claude 专有的子代理工具等）的技能，在安装时通过静态扫描标记为“不兼容”或“部分兼容”。

### 依赖与环境

- 安装技能时解析其依赖（运行时、依赖包、命令行工具、所需沙箱级别）。
- 缺少的宿主层环境通过环境管理器申请安装，需用户确认，见 [07-local-runtime.md](07-local-runtime.md#两层配置职责)。
- 当前机器无法满足依赖时，技能标记为不可用并说明原因。

### 安全

- 导入需要用户确认。
- 技能需声明所需权限（网络、凭据）。
- 安装前扫描脚本。
