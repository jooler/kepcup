# 05 Wiki 与 Skills

## Wiki：Bot 的大脑

每个 Bot 挂载一个自己维护的 LLM Wiki，采用 Karpathy 提出的 LLM Wiki 模式。

```text
wiki/                  -- git 管理（内嵌 git 库，只存文本），每次维护提交一次，可回滚
  SCHEMA.md            -- 维护规范：页面类型、命名、链接、引用格式
  index.md             -- 目录，每页一行摘要
  log.md               -- 只追加的变更日志
  raw/                 -- 原始资料：文本类原件，只增不改（仅「删除资料」可移除）
    _assets/           -- 资产清单（每份资料一条，含 sha256 与来源，指向原件）
    _derived/          -- 派生文本（全文 / 描述 / 转写），对维护 loop 只读
  pages/               -- LLM 维护的知识页面（实体、概念、主题……）
wiki-store/            -- 仓外内容存储（不进 git）：二进制原件、关键帧、派生实时状态
```

`raw/` 的来源：用户给的文档、抓取的网页、有价值的执行产出。复杂文档与媒体经**宿主派生管线**入库：文本类原件进 `raw/`，二进制原件与关键帧存仓外 `wiki-store/`（git 只留 `raw/_assets/` 清单），可读文本进 `raw/_derived/`（PDF/Office→MinerU Markdown，图片→多模态描述，音视频→分段转写+关键帧描述），派生在独立 `wiki_derive` 通道完成后再由维护 loop 写 `pages/`（见 [36-wiki-multimodal-ingest.md](36-wiki-multimodal-ingest.md)，D85）。对话中分页读 PDF 仍可用预置 MinerU 技能（见 [17-mineru-document-parsing.md](17-mineru-document-parsing.md)）。

### 读写规则

- **单一写入者**：响应 loop 对 Wiki 只读，通过 `wiki_search`、`wiki_read` 查询；需要入库时调用 `wiki_enqueue(source, note)` 排队，由独立的 Wiki 维护 loop 串行执行。
- Wiki 中不得出现用户的个人信息（那是记忆的职责），体检时检查这一条。
- Bot 之间的 Wiki **完全隔离**（D9）。唯一的跨 Bot 写入是用户确认过的资产移交（D88 P2，[37](37-bot-asset-handover.md) §3.2）：按页 / 目录把页面连同引用的原件**复制**进接手方的 Wiki（接手方的维护锁内落盘、同路径不覆盖、一次提交、之后排一次体检），来源不变。项目内的共享知识不走 Bot wiki，走下一节的**项目 wiki**——它是项目内唯一被许可的共享通道。

### 项目 wiki（D92 T1b）

项目组有一个项目所有的共享知识库，复用上面的引擎（git 布局、维护 loop、体检）；所有者是项目（`WikiOwner = bot | project`），随项目删除而删除，成员变动不影响它。

| 项 | 规则 |
|---|---|
| 存储与索引 | `projects/{id}/wiki/`（git）、`projects/{id}/wiki-store/`；FTS 是**项目级** `projects/{id}/wiki.db`（加密 sqlite，仅 `wiki_fts`），不进任何成员的 `memory.db` |
| 来源台账 | `raw/_assets/{assetId}.json` 对齐 D85 结构并增 `createdBy: { kind: 'user' \| 'bot', id }`；本期落地的是文本子集（`sources[].type` 含 `text`，`storage:'git'`），二进制 / 派生仍按 [36](36-wiki-multimodal-ingest.md) 未实施；Bot 个人 wiki 暂不启用台账。来源资产 id = `ast_` + 内容 sha256 前 24 位十六进制 |
| 单写入队列 | 每个项目 wiki 一个串行维护队列（互斥键 `project:{id}`）；多个成员同时 `wiki_enqueue` 只是入队 |
| 执行者付费 | 成员入库的维护 loop 以**该成员**身份运行（模型、用量与后台预算记其名下）；用户添加的来源与定期体检以**负责人**身份运行 |
| 删除来源 | 成员只能删自己创建的来源（`wiki_remove_source`，经 job 异步执行）；用户与负责人管理全部。Bot 被删后其来源保留（创建者显示为 id） |
| 工具 `scope` | 项目对话里 `wiki_search { scope: 'mine' \| 'project' \| 'all' }`（默认 `all`，结果带 `[project]` / `[mine]` 前缀且项目在前）、`wiki_read { scope }`（默认 `mine`）、`wiki_enqueue { scope }`（**默认 `mine`**——发布到共享空间必须有意为之）；`wiki_remove_source { source_id }` 仅项目对话注册 |
| 可信度 | 用户创建的来源可信；Bot 创建的来源及其参与的页面，其他 Bot 读取时整段包进 `<untrusted source="project_wiki">` 并标注提交者；页面全部出处为用户才原样返回 |
| 提示词 | 项目对话注入项目 wiki 主题段 `<project_wiki_topics>`（取自项目 `index.md`，**不设预算**）；Bot 个人主题段仍受 `WIKI_TOPICS_TOKEN_BUDGET` 约束 |
| 移交（D88） | 项目 wiki **不在**移交范围；Bot wiki 的移交不变 |

### 维护操作

- **入库（ingest）**：读取一份原始资料，更新或新建多个页面，同时更新 `index.md` 和 `log.md`。
- **体检（lint）**：定期检查矛盾、过时内容、孤立页面、缺失的引用、个人信息。
- **删除**：整页不再需要时，维护 loop 用 `delete` 工具删除页面（限 `pages/` 下的文件）并同步更新 `index.md`；用户也可以在界面上删除页面。页面删除都是追加式的 git 新提交，历史不改写，随时可回滚恢复。
- **删除资料**（用户操作，`wiki.deleteAsset`，D85）：移除一份原始资料及其派生文本与清单，并登记体检清理悬空引用。**例外**：仓外的二进制原件与关键帧被物理删除，回滚无法恢复——这正是「删除即真删除」的目的；派生文本与页面一样仍留在 git 历史中（见 36 §6）。

### 触发来源

- 用户要求，例如“学一下这份文档”
- Bot 在工作中认为某样东西值得沉淀
- 反思 loop 提出建议
- 定时体检

入库、体检、整理都是 Bot 自己的知识库事务（见 [01-conversation.md](01-conversation.md) 消息原则）：完成与进展不进入对话，不向用户播报（“你给的文档我读完了”这类汇报已废弃）；入库成功后 Bot 直接通过检索引用新内容。终态失败（重试耗尽）以内部事件触发 Bot，由 Bot 用自己的话向用户交代一句。唯一的另一例外是**派生阻塞**（缺 ffmpeg / MinerU 或未配置所需能力模型，D85）：同一份资料同一原因只触发一次内部事件，由 Bot 在对话里发起安装卡或设置卡；条件满足后自动续跑，不再播报。

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
