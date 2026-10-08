# 28 外部智能体引擎（ACP）

许多用户已经订阅了 Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot、GLM Coding Plan 等，却拿不到通用的 `base_url` / `api_key`，无法使用基于 pi 的内置 loop。本文规定：**用户可在设置中像 ACP Registry 那样启用外部编码智能体（Agent），并为某个 Bot 指定由哪个 Agent 驱动其执行 loop**；外部 Agent 主要通过 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 驱动，内置 pi loop 保持默认与不变。

决策：D72。执行方案见 [todo/acp-external-agents.md](../../todo/acp-external-agents.md)。**状态（2026-10-08）**：P1–P6 已实现（实验开关下）；待办只剩需要真实账号的人工项——各 Agent 登录后的 P0 spike、原生优先遵守度真机运行（§9.2 末）与三平台人工验收（todo §9.1 末项）。

相关：D2（执行中注入）、D4（@ 连锁预算）、D21（pi 封装在 `AgentEngine` 之后）、D35/D36（访问范围）、D27（沙箱）、D29/D30（写入租约 / 检查点）、D41（无人值守）、D45（模型配置）、D48/D54（Bot 发消息 / 中间说明）、D56（Loop 续接）、D58（对话内设置引导）、D62/D68（检索与能力补位工具）、D65（MCP）、D66（SubAgent）、D67（durable）、D71（跨 Bot 委派）。

## 决策

- **D72 外部智能体引擎**：
  1. **智能体目录**：设置页新增「智能体」分区，以目录卡片列出 KepCup 已适配的 Agent（图标、简介、许可、版本、登录方式），用户逐个「启用」（按需安装 + 官方登录）。目录条目格式**兼容 ACP Registry**（`id` / `name` / `version` / `distribution: npx | binary | uvx` …），附 KepCup 扩展字段；本期只列已适配的 Agent，版本随应用发布锁定。
  2. **Bot 指定 Agent**：Bot 运行配置里的「主模型」选择器扩展为「模型 / 智能体」二选一：选内置模型 = 现有 pi loop；选已启用的 Agent = 由该 Agent 驱动（可再选该 Agent 提供的模型、推理强度、权限档位）。
  3. **能力注入可选**：KepCup 的宿主能力（记忆、Wiki、定时、浏览器、检索、图像 / 语音 / 视频生成、图片理解、语音转写、委派、技能、宿主操作、用户 MCP 等）按**能力包**组织，经**宿主 MCP 桥**注入外部 Agent。Bot 使用外部 Agent 时，用户逐包勾选注入哪些能力；默认值 = 「该 Agent 不具备的能力全部注入」（由 Agent 描述符声明其原生能力，未知按不具备处理）。对话核心能力（`send_message` / `skip_reply` / 消息与执行记录查询）必选。能力包分两类：**宿主语义类**（对话、记忆、Wiki、定时、协作、技能、宿主操作）以 KepCup 工具为准，Agent 不得用自带的近似手段替代；**补位类**（检索、浏览器、图像 / 语音 / 视频生成、图片理解、语音转写、用户 MCP）**原生优先**——注入的补位工具在工具描述与平台规则中都明确标为「仅当你没有等价的内置能力，或内置能力不可用 / 失败时才使用」（§4.2）。
  4. **可扩展的 Agent 供应商**：每个 Agent 是一个 **Provider**（目录条目 + 可选的行为覆盖模块），通用 ACP Provider 覆盖协议标准部分，各家只写差异（启动参数、指令注入方式、权限模式映射、原生能力、条款提示）；不支持 ACP 的 Agent 以**进程内协议垫片**（把其私有协议翻译为 ACP 语义）接入同一管道。新增 Agent = 加一个目录条目 + 一个 Provider 模块 + 在登记表里加一行，并通过统一的 Provider 契约测试。
  5. **本期 Agent**：Claude Agent、Codex、OpenCode、DeepSeek Harness、Cursor、Google Antigravity（ACP 均已具备，ACP Registry 均已收录）；Antigravity 因其条款禁止第三方软件使用 Google 个人账号登录，**只开放 API key / Vertex / Enterprise 登录方式**（个人订阅登录在 Provider 层过滤）；ZCode 无 ACP，原计划以进程内垫片接入；P0 只读评估曾认为可完整覆盖，P5 实现前复核推翻（订阅鉴权须由宿主读取 / 中转凭据）→ 按「不能完整覆盖即放弃」**已放弃**（`docs/dev/DEVIATIONS.md` DEV-008，§9.2）。
  6. **不变的原则**：换的是 loop，不换 Bot——对话、mailbox、执行记录、续接、中间说明、人设 / 记忆 / Wiki / Skills 注入、群聊、委派、审批与审计全部留在宿主；外部 Agent 自带的文件 / 命令工具在其**自身沙箱**内运行，权限请求进入 KepCup 的分级与审批卡；**KepCup 不接触、不存储、不中转**任何订阅凭据，登录走厂商官方流程，进程使用厂商**未修改**的官方二进制。功能以「实验」开关发布。**Claude Agent 在开发期间与其他 Agent 同等对待（默认可启用、全部功能走通）**，是否随发行版发布在发行前由产品确认后决定（目录条目带 `releaseGate`，未放行时发行构建不收录该条目，代码保留）（§9.3）。



## 1 可行性结论

> **D75 修订**：拆分为「对话轮 + 任务」后，**对话轮固定走内置引擎，外部 Agent 只作任务引擎**（`runtime.agent` 的语义从「Bot 的引擎」变为「Bot 的**任务**引擎」）。下表随之变化：
> - `delegate_task`（D66）不提供 → **该让渡消失**：并行由宿主任务层提供，不依赖 Agent 自身能力；
> - 每次请求前刷新系统提示词「降级」→ **仅任务内降级**，对话轮（人设 / 画像 / 记忆 / Wiki 目录 / Skills）逐轮刷新；
> - 人设 / 记忆 / 对话上下文 / 群聊 / 委派 / 审批「保留」→ 不再依赖提示词注入的保真度，它们本就运行在内置的对话轮里；
> - `features.parallelSessions`（**D72 已实现**，2026-10-08）：指同一 Agent 进程里**多个会话**能否同时有 prompt 在途（AgentHost 让同一 Agent 的会话共用一个进程）；「每会话同一时刻一个 prompt」是所有 ACP Agent 的通用行为，与此无关。按锁定版本源码实证：Claude / Codex / OpenCode / DeepSeek Harness / Cursor 为 true，Antigravity 与通用 ACP 为 false（见 §9.2）；false 的 Agent 并发恒为 1（用户覆盖也钳到 1）、不跑后台任务——D75 的任务并发同样以此为上限；
> - steering 不支持时 `inject_task` 返回 `queued`（沿用 pending steer）；取消不杀进程，重启优先走会话复用（冷启动有实测代价）；
> - 无内置模型的用户：对话轮经 `complete()` 跑，或退化为「永远一个任务、新指令排队」——**明确是降级**。
>
> 见 [30 §8](30-supervisor-and-tasks.md#8-外部智能体引擎d72-的化简与约束)。

**可行，但它是「换引擎」，不是「换模型」**。内置 loop 的模型是一个无状态 API；外部 Agent 是一个有自己工具、自己沙箱、自己会话历史、自己系统提示词的完整 agent。


| 能力                                                      | 外部 Agent 下        | 方式                                                                                                                              |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 人设、用户画像、记忆、Wiki 目录、Skills 列表、project / workspace / 授权信息 | 保留                | 会话级提示词 + 每个 run 的 prompt 动态段（§5）                                                                                                |
| 对话上下文、触发段、续接（D56）                                       | 保留                | 首条 prompt；会话复用时只发增量（§7）                                                                                                         |
| 执行中注入新消息（D2）                                            | 视 Agent 而定        | ACP `_session/steering` 扩展（Claude / Codex 支持，须带 `idleBehavior:'promptRequired'`）；不支持的 Agent 回落为 run 结束后再投递（现有 pending steer 机制） |
| 中间说明投送（D54）、最终回复自动发送（D48）                               | 保留                | `agent_message_chunk` 按工具调用边界切分                                                                                                 |
| 宿主能力（记忆、Wiki、定时、浏览器、媒体生成、委派…）                           | 保留，**按 Bot 可选注入** | 宿主 MCP 桥 + 能力包（§4）                                                                                                              |
| 群聊、@ 连锁（D4）、管家与委派（D70/D71）                              | 保留                | 引擎无关；连锁预算按轮数折算                                                                                                                  |
| 写入租约（D29）、检查点与回退（D30）                                   | 保留，粒度变粗           | run 开工前显式取租约、**整个 run 持有**；检查点为租约起止的前后快照                                                                                        |
| 文件 / 命令工具                                               | **让渡**            | 用 Agent 自带工具；KepCup 沙箱、网关路径检查、project `protectRules`、Bot `network_policy` 都不覆盖（§6）                                              |
| project 以外路径的读取保密（D36）                                  | **让渡**            | Agent 沙箱一般允许全盘只读；只对应用数据目录显式拒读                                                                                                   |
| 每次请求前刷新系统提示词                                            | **降级**            | 只能每个 run 刷新一次                                                                                                                   |
| 费用核算与预算                                                 | **降级**            | 订阅制无单价；只记 token（若上报）与轮数 / 时长上限                                                                                                  |
| `delegate_task`（D66）、durable 恢复（D67）                    | 不提供               | Agent 自带子代理；ACP run 一律 ephemeral（D49）                                                                                           |
| 无 API key 用户的后台 loop                                    | 保留但更慢             | `complete()` 经一次性精简会话实现；续接 L2 仲裁关闭，其余降频 / 可关（§8）                                                                                |


不采用的替代方案：

- **每家直接嵌入私有 SDK**（Claude Agent SDK、`codex app-server`…）：每家一套集成、条款风险相同；ACP 一套客户端覆盖 ACP Registry 中 40+ 个 Agent，仅对不支持 ACP 的少数 Agent 写垫片。
- **提取订阅 token 喂给 pi**：违反 Anthropic 与 Google 条款，**禁止**。
- **OpenAI「Sign in with ChatGPT」token sharing**（2026-09 发布）：若获批，ChatGPT 用户可**不换引擎**继续用内置 loop，能力零让渡；独立调研项（todo §10）。
- 另：GLM Coding Plan、DeepSeek 等本质是 **API key**，用户也可以直接在内置引擎中以自定义 OpenAI 兼容接口使用（是否符合各自套餐条款需逐家确认）；外部 Agent 是其补充而非唯一路径。



## 2 智能体目录（Agent Catalog）



### 2.1 目录条目

与 ACP Registry 条目同构，另加 KepCup 扩展字段：

```ts
interface AgentCatalogEntry {
  // —— 与 ACP Registry 同名同义 ——
  id: string; name: string; version: string; description: string;
  repository?: string; website?: string; authors: string[];
  license: string; icon: string;                         // 图标随应用打包，不在运行时拉 CDN
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<Platform, { archive: string; cmd: string; args?: string[]; sha256: string }>;
    uvx?: { package: string; args?: string[] };          // 本期不支持
    system?: { cmd: string; args?: string[]; detect: string[] }; // KepCup 扩展：复用用户已装的官方 CLI
  };
  // —— KepCup 扩展 ——
  provider: string;                // Provider 模块 id（'generic-acp' | 'claude' | 'codex' | 'opencode' | 'dsh' | 'cursor' | 'antigravity' …）
  transport: 'acp' | 'shim';       // shim = 进程内协议垫片
  tier: 'supported' | 'preview';   // 预览档默认权限更严、UI 标注
  nativeCapabilities: Partial<Record<CapabilityId, string[]>>;  // 自带能力 → 原生工具名（用于默认值与 §4.2 原生优先提示）
  auth: { kinds: Array<'subscription' | 'api-key' | 'gateway'>; note: string };
  terms?: { noticeKey: string };   // 条款提示文案 key（可随版本下线某个 Agent）
  releaseGate?: string;            // 发行门禁：未放行时发行构建不收录该条目（开发构建照常可用）
}
```

- **来源**：本期为随应用打包、精确锁版本的**策展目录**（`shared/src/domain/agent-catalog.ts`）；目录数据可从 ACP Registry 导入后人工补扩展字段（附脚本）。日后可加「社区 Agent」：运行时同步 ACP Registry，以通用 Provider 接入、默认 `ask` 档、标注未适配。
- **安装**：经环境管理器（D13，审批卡显示体积、来源、许可与条款提示）装到应用私有 `toolchains/agents/{id}@{version}/`：
  - `npx`：用环境管理器按需安装的 Node 运行时 + npm 安装锁定版本（Electron 不带 npm；JS 入口可用 `ELECTRON_RUN_AS_NODE=1` 运行）；
  - `binary`：下载对应平台归档、**校验 sha256**、解压；
  - `system`：探测到用户已装官方 CLI 时可选用（复用其登录），版本不在兼容范围时提示；
  - `uvx`：本期不支持。
- 升级随应用发布（目录版本 bump + 契约测试）；不做应用内自动跟随上游最新版。



### 2.2 设置页「智能体」

- 目录卡片：图标、名称、简介、许可、`supported` / `preview` 标签、登录方式说明、条款提示。
- 状态机：`available`（未启用）→ `installing` → `needs_auth` → `ready`；另有 `update_available`（应用升级后目录版本变化）、`incompatible`、`error`。
- 操作：启用（安装 + 登录）、停用（保留安装，Bot 不可选）、登录 / 退出、测试连接（建会话发一句 ping）、卸载；高级：「使用系统已安装的 CLI」「加载我的个人配置」（默认关）、并发上限。
- 停用或卸载一个仍被 Bot 使用的 Agent：弹框列出受影响 Bot，确认后这些 Bot 发消息时走对话内设置卡（§9.1）。



## 3 Bot 指定 Agent

- 运行配置的「主模型」选择器改为分组下拉「模型 / 智能体」：模型组 = 现有内置模型；智能体组 = 已启用（`ready` 或 `needs_auth`）的 Agent。选模型 → `runtime.agent.id = ''`（内置引擎，其余行为不变）；选 Agent → 展开 Agent 专属设置：
  - **模型 / 推理强度**：来自该 Agent 会话返回的 config options（类别 `model` / `thought_level`），缓存后供下拉；留空 = Agent 默认。
  - **权限档位**：`read_only` / `workspace`（默认）/ `ask`；Agent 不具备 OS 沙箱时 `workspace` 档的命令也逐条确认（§6）。
  - **注入能力**：能力包勾选清单（§4），显示预计注入的工具数。
- 「轻量模型」保留，语义为「该 Bot 后台任务用的内置模型」；没有内置模型时隐藏（后台任务走 §8）。
- 首次把 Bot 切到外部 Agent：弹框说明 §1 的让渡项（同 D41 的告知方式）；Bot 详情显示 Agent 徽标与「隔离由 Agent 自身沙箱提供」。
- 数据：`botRuntimeSchema` 增嵌套对象 `agent: { id, model, effort, permission, capabilities }`（Profile JSON，无迁移）；`capabilities` 为 `null` 表示跟随默认值。



## 4 能力注入（能力包）



### 4.1 能力包登记表

能力包在 `shared` 中集中登记（`HOST_CAPABILITIES`），core 的桥与 desktop 的勾选 UI 共用同一份事实：


| 能力包 id                | 类别   | 工具                                                                                                                   | 默认       | 与 Agent 原生能力的重叠键   | 前置配置                           |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | ------------------------------ |
| `core`（必选）            | 宿主语义 | `send_message`、`skip_reply`、`search_messages`、`get_messages_around`、`get_attachment`、`list_my_runs`、`get_run`        | 必选       | —                  | —                              |
| `memory`              | 宿主语义 | `remember`、`recall_memory`、`get_user_profile`、`list_commitments`、`memory_feedback`、`forget`、`propose_profile_change` | 注入       | —                  | —                              |
| `wiki`                | 宿主语义 | `wiki_search`、`wiki_read`、`wiki_enqueue`                                                                             | 注入       | —                  | —                              |
| `schedule`            | 宿主语义 | `schedule`、`list_schedules`、`cancel_schedule`                                                                        | 注入       | —                  | —                              |
| `collaboration`       | 宿主语义 | `list_bots`、`delegate_to_bot`、`cancel_delegation`（管家另含其专属工具，管家必选）                                                    | 注入       | —                  | —                              |
| `browser`             | 补位   | `browser_*`                                                                                                          | 注入       | `browser`          | —                              |
| `web`                 | 补位   | `web_search`、`web_fetch`                                                                                             | 原生无则注入   | `web`              | 检索供应商（D62，未配置走 SETUP_REQUIRED） |
| `image_generation`    | 补位   | `generate_image`                                                                                                     | 原生无则注入   | `image_generation` | 能力模型 image                     |
| `image_understanding` | 补位   | `understand_image`                                                                                                   | 原生无则注入   | `vision`           | 能力模型 multimodal                |
| `speech`              | 补位   | `generate_speech`                                                                                                    | 注入       | `tts`              | 能力模型 tts                       |
| `transcription`       | 补位   | `transcribe_audio`                                                                                                   | 注入       | `asr`              | 能力模型 asr                       |
| `video`               | 补位   | `generate_video`                                                                                                     | 注入       | `video`            | 能力模型 video                     |
| `skills`              | 宿主语义 | `install_skill`、`create_skill`                                                                                       | 注入       | —                  | —                              |
| `host_ops`            | 宿主语义 | `request_environment`、`git_remote`                                                                                   | 注入       | —                  | —                              |
| `mcp`                 | 补位   | 该 Bot 勾选的用户 MCP server 工具（D65，`mcp_server_ids`）                                                                      | 随 Bot 勾选 | —                  | —                              |


- 外部 Agent 下**永不注入**：`read/write/edit/grep/find/ls/bash`、`request_access`、`request_unsandboxed`、`acquire_project_write`、`delegate_task`（与原生能力或宿主机制冲突）。
- 默认值计算：`core` 必选；其余 = 默认注入的包 − Agent 描述符 `nativeCapabilities` 覆盖的包。用户可任意增减（`core` 除外）；为已有原生能力的 Agent 勾选补位包时按 §4.2 原生优先注入（UI 提示「该 Agent 自带此能力，注入后仅作兜底」）。
- 前置配置缺失的包仍可勾选，UI 标「未配置」；调用时走既有 `SETUP_REQUIRED` → 对话内设置卡（D58/D68）。
- 内置引擎不受影响（仍拿到全部工具）。



### 4.2 原生优先与宿主优先（工具选择策略）

注入的工具与 Agent 自带工具可能重叠（如 Claude / Codex 自带联网搜索与看图，Codex 自带图像生成）。外部 Agent 必须明白该用哪一个，策略按能力包类别区分：


| 类别    | 策略                                               | 落地方式                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 补位类   | **原生优先**：有等价的自带能力就用自带的；注入工具只在自带能力不存在、不可用或调用失败时使用 | ① 桥下发的工具描述统一加前缀「[补充能力] 若你自带同类能力，优先使用自带能力；仅当其不存在、不可用或失败时调用本工具」；② ACP 版平台规则增 `<tool_policy>` 段，逐项列出本 run 注入的补位工具；Provider 声明了对应原生工具名时点名（如「联网搜索用你的 WebSearch / WebFetch，不要用 `mcp__kepcup__web_search`，除非它们不可用或失败」），未知时用通用表述 |
| 宿主语义类 | **宿主优先**：涉及 KepCup 自身语义的事只能用注入工具，不用自带的近似手段       | `<tool_policy>` 段写明：记住用户信息用 `remember`，不写入 CLAUDE.md / AGENTS.md 或其他文件；提醒 / 定时用 `schedule`，不用 cron 或自带定时；给用户发消息与附件用 `send_message`；找其他 Bot 用 `list_bots` / `delegate_to_bot`；安装宿主环境用 `request_environment`               |


- Provider 描述符的 `nativeCapabilities` 为「能力 → 原生工具名」映射（如 Claude `web → [WebSearch, WebFetch]`、`vision → [Read]`；Codex `web → [web_search]`、`image_generation → [image_gen]`，以 P0 实测为准），同时用于默认值计算与 `<tool_policy>` 点名。
- 策略只影响提示与描述，不在桥内硬拦截补位工具（Agent 自带能力是否真的可用，宿主无法可靠判断）；`run_steps` 中桥调用带 `capability` 与 `nativeOverlap` 标记，P0 / P6 统计各 Agent 的遵守情况，必要时调整措辞。



### 4.3 注入与提示词联动

- 注入的工具集合决定 ACP 版 `<platform_rules>` 与 `<tool_policy>` 中出现哪些规则（如未注入 `memory`，则不出现「用户要求记住时调用 remember」；未注入 `collaboration` 则不提委派）。
- **上下文段与工具解耦**：`<relevant_memories>`、`<user_profile>`、`<wiki_topics>`、`<skills>` 等只读上下文照常注入（即使未注入对应工具），后台反思 / 画像整理照常写入。用户若不希望 Bot 看到某类上下文，用既有的 Bot 级开关，而不是能力包。
- 生成类工具的产物落 workspace `.generated/`，Agent 可用其原生工具读取，或经 `send_message(attachment_paths)` 发出。



### 4.4 宿主 MCP 桥

- core 在 `127.0.0.1` 随机端口起 Streamable HTTP MCP server；`session/new.mcpServers` 传 `{ type:'http', name:'kepcup', url, headers:[Authorization: Bearer <session token>] }`。token 按**会话**签发，桥按 token 查会话的**当前 run**，无进行中 run 时拒绝；会话删除或指纹变化时吊销。不支持 http MCP 的 Agent 用 stdio→http 转发小脚本（Electron 自带 Node 运行）。
- 校验 `Host` 为 `127.0.0.1:{port}`、拒绝非本机 `Origin`（防 DNS rebinding）。
- 调用经 `ToolGateway`（审批、审计、`<untrusted>`、`secrets.redact`）；输出截断与图片判定从 pi 的工具包装层抽为共用函数。
- 桥自己向 run 发 `tool_call` / `tool_result`（保留 `errorCode`，使 `SETUP_REQUIRED` 中断照常生效），忽略 ACP 侧对 `kepcup` 工具的镜像更新。
- `skip_reply` 置终止标志，工具返回后发 `session/cancel`，按「不发送最终文本」的 completed 结算。



## 5 上下文注入

外部 Agent 自带系统提示词，KepCup 不替换（替换会削弱其工具熟练度）。注入分两层：


| 层         | 注入方式（由 Provider 声明）                                                                          | 内容                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 会话级（相对静态） | `meta-append`（Claude：`_meta.systemPrompt.append`）或 `prompt-prefix`（会话首个 prompt 前置段，复用会话时不重发） | ACP 版 `<platform_rules>` 与 `<tool_policy>`（随注入能力变化，§4.2）、`<identity>`、`<persona>`、`<conversation_info>`                            |
| run 级（动态） | 每个 run 的 prompt 首个 text 块                                                                    | `<user_profile>`、`<my_state>`、`<relevant_memories>`、`<project>`、`<workspace>`、`<access>`、`<wiki_topics>`、`<skills>`、对话上下文段、续接段、触发段 |


- 进程级配置（Codex `CODEX_CONFIG`、OpenCode `OPENCODE_CONFIG_CONTENT`）一个进程所有会话共用，**不能**承载 Bot 人设；只放全局覆盖项（审批 / 沙箱 / 关闭外部指令文件回退）。
- **不加载 Agent 侧配置**（默认）：Claude `settingSources: []`（`project` 来源会加载仓库 `.claude/settings.json` 的 hooks——沙箱外执行——与 allow 规则——绕过权限桥）；OpenCode 关闭 CLAUDE.md 回退（`OPENCODE_DISABLE_CLAUDE_CODE`*）。无法关闭的（Codex 加载 project `.codex/config.toml` 与 `AGENTS.md`，OpenCode 加载 `AGENTS.md` 与全局配置）由 Provider 声明，project 含此类文件时首次运行前弹框确认，且 `<project>` 段不重复注入 Agent 自己会读的文件。
- 图片附件（D61）在 `promptCapabilities.image` 为真时作为 ACP `image` 块，否则降级为文本行。



## 6 原生工具的隔离与权限

外部 Agent 的文件 / 命令工具在**其进程内直接操作真实文件系统**（已核对：claude-agent-acp、codex-acp 都不调用 ACP 客户端的 `fs/`* / `terminal/*`）。D35 / D27、project `protectRules`、Bot `network_policy` 对这些工具不成立。补偿措施（Provider 负责把档位映射到各家的模式 / 配置）：


| 措施               | 规定                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工作目录             | `cwd` = 对话绑定的 project，未绑定则 workspace（位于 `~/.kepcup` 内）；不传 `additionalDirectories`                                                                                              |
| Agent 自身沙箱       | 有 OS 沙箱的 Agent 必须开启（Claude 原生沙箱 + `denyRead`/`denyWrite` 覆盖 `~/.kepcup` 其余部分；Codex `workspace-write`）；**永不**使用 bypass / auto / dontAsk / full-access 一类模式（Provider 层过滤，UI 不出现） |
| 无 OS 沙箱的 Agent   | （如 OpenCode、DeepSeek Harness、Cursor、Antigravity）`workspace` 档下工作目录内编辑可放行，但**每条命令都弹卡**（等同 D39 逐条确认），经其权限配置（如 `OPENCODE_PERMISSION`）强制命令走询问                                         |
| 权限档位             | `read_only` · `workspace`（默认）· `ask`；`preview` 档 Agent 默认 `ask`；收到 `current_mode_update` 偏离档位时改回并审计                                                                            |
| PermissionBridge | `mcp__kepcup__*` 直接放行（桥内另走网关审批）；路径优先级「cwd 与技能目录 → 应用数据目录其余部分（拒绝）→ 网关 `checkPath`」；工作目录内按档位；越界读写弹 `agent_tool` 卡（复用 D37：仅这一次 / 本对话内）；命令命中白名单（D40）放行，否则弹卡且只有「仅这一次」；看不懂的请求弹卡      |
| 选项映射             | 只按 Provider 声明的 **optionId 白名单**选 `allow_once` / `reject_once`；不选 `allow_always`、不选任何会切换模式的选项                                                                                  |
| 无人值守（D41）        | `agent_tool` 自动批准并审计，但并入数据目录底线：命令或路径触及应用数据目录（workspace / 技能目录除外）时拒绝                                                                                                            |
| 写入租约 / 检查点       | project 绑定且档位可写时，run 开工前显式取租约（现有租约是首次写工具调用时懒取），整 run 持有，前后快照照常                                                                                                                 |
| Windows          | 无沙箱的 Agent 强制 `ask`；日后可选在 KepCup 的 WSL 发行版中运行 Agent                                                                                                                            |
| 读取让渡（披露）    | Agent 沙箱的**读**多半不受限：Codex 的 read-only / workspace-write 沙箱可不经请求读取整台电脑（含应用数据目录里其他 Bot 的 workspace、技能、日志）；Claude 原生沙箱的 `denyRead` 只约束 Bash，Read 工具越界靠权限请求。联网读取（WebFetch / WebSearch，`kind: fetch`）在只读 / 工作区档自动放行（外泄通道）。两者在 Bot 首次切换弹框与 Bot 详情中明示；「加载我的个人配置」开启后个人配置中的放行规则与钩子绕过权限桥，设置页醒目警告 |
| Agent 侧配置       | project 内 Agent 自读且无法关闭的配置（`agentSideConfigFiles`）首次运行前确认，按内容哈希记住到对话（内容变化重新确认，无人值守的自动批准不算记住）；Agent 对这些文件与仓库 `.git/` 的写入一律弹卡 |
| 命令               | 只读白名单只对 Provider 确认「在其自身沙箱内运行」的命令生效（Codex 只为越出沙箱的命令发请求 → 恒弹卡）；命令工作目录位于数据目录（workspace / 技能目录除外）直接拒绝 |


新审批类型 `agent_tool`（工具标题、类别、路径、命令原文、Agent 标识），需重建 `approvals` 表 CHECK。

## 7 会话、事件与执行记录

- **会话复用**（P5 已实现）：每个（Bot, 对话, Agent）至多一个会话，记录在 `agent_sessions`；上一 run 结束不超过 `CONTINUATION_WINDOW_MS`（30 分钟）且会话指纹（会话级提示词、cwd、权限档位、模型 / effort、注入能力与工具集合、桥 server 名）不变时复用：会话留在 Agent 进程里，下一个 run 依次尝试同进程直接复用 → `session/resume` → `session/load`（重放静音）→ 新建；复用 / 恢复时只发增量消息 + 触发段 + run 级动态段，新建则完整上下文 + D56 回放。桥 server 名由会话行 id 派生（换会话即换名），桥 token 随会话（建立 / 恢复时签发、复用时沿用、每个 run 重新绑定，会话被替换 / 删除 / 中毒 / 进程退出时吊销）。只有档位已设定、prompt 已发出且未中毒的会话才保留；复用前重设期望模式（会话设置调用有超时上限，期间会话已归本 run、并发的删除在释放时执行，复核被拒而期间已被删除则不再新建）；`session/new` / `resume` / `load` 同样有上限（`AGENT_SESSION_OPEN_TIMEOUT_MS`，120 s：恢复不应答 → 会话中毒，新建不应答 → 晚到的会话被关闭），run 外偏离期望模式的变化即弃用该会话（重复期望模式的通知不算）；增量只含会话没见过的消息（按 `baseCutoff` + 单独展示过的消息记账，应用重启后不复用）。KepCup 的消息与 `run_steps` 始终是事实来源。
- **run 之外的输出**：`session/load` / `session/resume` 的重放静音；无进行中 run 时收到的更新丢弃并记日志，桥同时拒绝工具调用；Claude 以进程级 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` / `CLAUDE_CODE_DISABLE_CRON` 关闭会在 run 外自主触发 turn 的后台任务与定时任务。
- **事件映射**：文本块累积，遇顶层 `tool_call` 以 `stopReason=toolUse` 发 `assistant`（带 `parentToolUseId` 的子代理内部调用与文本不切分、不落步骤，只进状态行；状态行文案取 `tool_call.title`）；原生 `tool_call` / `tool_call_update` → `tool_call` / `tool_result`；`agent_thought_chunk` 不落库；`plan` → `progress`；`stopReason`：`end_turn`→completed、`cancelled`→cancelled（`skip_reply` 例外）、`refusal`/`max_tokens`/`max_turn_requests`→failed。
- **steering**：prompt 进行中且 Provider 声明支持时发 `_session/steering`（固定 `idleBehavior:'promptRequired'`），应答 `injected` 才算送达；被拒、出错或 Agent 无视 `promptRequired` 自开新 turn（codex-acp 2.1.1，宿主立即取消该 turn）都经 `onSteerRejected` 交还 pending steer，在 run 结束后续投；不支持时直接回落。prompt 发出前 / 后台工具 follow-up 之前到达的消息并入下一个 prompt。每会话同一时刻只允许一个 prompt 的 Agent（如 DeepSeek Harness）只能回落。
- **长耗时宿主工具**：桥调用超过 `AGENT_BRIDGE_TOOL_DETACH_MS`（45 s，低于 Codex 不可调的约 60 s MCP 超时）先应答「已转入后台」并继续执行；prompt 结束后 run 等待其完成，再以 follow-up prompt 把结果送回同一会话、同一 run（等待用户审批的工具因此不会被超时取消）。等待与 follow-up 都受 run 自身的时间上限约束（自 run 开始算；follow-up 只得到剩余时间，有下限）：到期中止仍在后台的调用，只发一次报告超时的 follow-up 即结算。
- **跨会话并发**（2026-10-08）：同一 Agent 的所有会话共用一个进程，同一时刻有几个会话在跑 prompt 由 `features.parallelSessions` 决定——声明 true（经锁定版本源码核对：会话表、逐会话的取消 / 轮次状态、没有进程级「当前 prompt」，§9.2）的 Agent 按 `agent:{id}` 并发上限（缺省 `AGENT_DEFAULT_CONCURRENCY`）并行；false 的 Agent 并发恒为 1，用户在设置里调高也被钳到 1（fail-safe，设置页显示生效值）。调度器、后台路由与设置视图共用 `providers/index.ts` 的 `agentConcurrency()`。
- **执行记录**：`runs.engine`（`builtin` | `agent:{id}`）、`runs.agent_session_id`。
- **中断 / 删除**：进程退出或崩溃 → 活跃 run 失败（应用退出时按 D49 标中断）；该会话不再留在（已不存在的）进程里、桥 token 吊销，但会话行保留，下次 run 经 `session/resume` / `session/load` 恢复（Provider / Agent 不支持则新建）——崩溃本身不算「中毒」；只有 run 在崩溃前已因自身原因中毒（超时、取消后不应答、会话设置调用不应答、模式纠偏失败）才删行；对话 / Bot 删除或移出群时 `session/delete`（Agent 支持且会话仍开在活进程里时，尽力而为）并删行；删除发生在会话建立 / 恢复期间（级联时会话尚不存在）时，会话建好后 orchestrator 拒绝记录并丢弃它——不发 prompt、释放时 `session/delete`；复核期间的进程崩溃同样不算中毒；Agent 自己的磁盘历史不归 KepCup 管理，删除提示中说明。



## 8 模型、用量与后台 loop

- **并发**：调度器 provider 键 `agent:{id}`，并发沿用 `settings.providerConcurrency`，缺省 `AGENT_DEFAULT_CONCURRENCY`（2）——仅限 `features.parallelSessions` 的 Agent，其余恒为 1（§7「跨会话并发」）。
- **用量**：`usage_ledger` 沿用现有列（`provider='agent:{id}'`、费用为空）；token 取 `PromptResponse.usage`（ACP 不稳定字段；口径由 Provider 声明——Claude / Codex 实为本 turn，其余按会话累计做差），缺失时每个模型轮记一条零 token 行（只记轮数）；连锁预算对零 token 行按 `AGENT_TURN_BUDGET_TOKENS` 折算；用量页单列「订阅 / 外部 Agent」。
- **后台 loop**（P6 已实现，P6 审查修复后）：有内置模型则照旧；只有外部 Agent 时由 `agent/llm-router.ts` 改走外部 Agent。`complete()` 用一次性精简会话（Claude 替换式系统提示词字符串、`tools: []`、`settingSources: []`；以新建的空私有临时目录作 cwd、结束即删；不挂宿主桥、不复用任何会话、结束即 `session/close`），只输出 JSON（Schema 写进系统提示词），复用 `structured.ts` 文本 JSON 回退 + zod，**只在输出无法解析时**重试 1 次（重试提示「只输出 JSON」；调用失败 / 超时 / 取消不重试）；Wiki 维护 / 技能生成这类带工具的 loop 以同样的后台精简会话 `startRun`（时限 `AGENT_BACKGROUND_RUN_TIMEOUT_MS`，10 分钟），工具只经宿主桥注入，原生工具的权限请求不弹卡、一律拒绝。
  - **后台会话没有原生工具**：只有 Provider 声明 `backgroundNoNativeTools`（经核对能为该会话完全关闭原生工具）的 Agent 可用于后台——本期只有 Claude（`tools: []`，会话级）与 testkit 假 Agent；引擎对其他 Agent 拒绝开后台会话（第二道防线）。私有临时 cwd 只说明工作目录不是用户 workspace，**不等于**读不到用户文件：能否读取取决于工具——后台会话没有原生工具，只能经宿主桥工具（受网关 / 数据目录规则约束）访问。OpenCode 1.18.35 理论上可用 `"*":"deny"` + 只放行 `{server}_*` 关掉全部原生工具（`Permission.disabled` 对末条命中为 `"*"`/deny 的工具直接下架，离线核对内嵌源码），但其权限配置是进程级（`OPENCODE_CONFIG_CONTENT`），需要单独的后台进程，本期不做（届时后台会话同样先过 Provider 的 `checkConfig`——引擎在每次建 / 恢复 / 复用会话前都调用，后台会话走同一路径）；Codex / Cursor / DeepSeek Harness / Antigravity 未核实能否关闭，均不可用于后台。
  - **合格条件**（`agentBackgroundBlocker`，设置页逐个列出原因）：上一条；未开启「加载我的个人配置」（OpenCode / Cursor 按进程加载个人配置，Claude 虽是会话级也一并排除，从严）；能同进程并行会话（`features.parallelSessions`，否则「该智能体未验证可并行会话」）；并发上限 ≥ 2。
  - **不跨厂商**：「自动」**只用该 Bot 自己的 Agent**，不可用即跳过，永不换用别家；无所属 Bot 的任务（画像整理——跨 Bot 的全局画像；群聊摘要）只在设置里**明确指定**后台 Agent 时运行；明确指定的 Agent 处理所有 Bot 的后台任务，不可用时跳过、不换用别家。设置页说明会发给所选厂商的内容（Bot 记忆、全局画像、对话内容与摘要、Wiki 资料）并消耗订阅额度。
  - **调度**：调度器对 `agent:*` 键上的后台任务（priority 2）至多用 并发-1 个名额（总在用数 < 并发-1 才启动），为对话 / 定时响应（priority 0/1）留一个；并发为 1 时不预留（路由器本就不把后台任务派给并发 1 的 Agent）。`JobsRunner` 的调度键只在路由到 Agent 时用 `agent:{id}`，内置路由保持 P6 前的键（全局轻量 / 主模型的厂商）；直聊摘要按其 Bot 取路由。
  - **群聊判断**：默认不经 Agent（`backgroundTasks.groupMentionOnly` 默认开 = 仅 @ / 回复响应）；用户关掉后才跑：时限 `AGENT_TRIAGE_TIMEOUT_MS`（60 s，超时 `no_action`）、同一 Bot 在同一群每 `AGENT_TRIAGE_MIN_INTERVAL_MS`（2 分钟）至多判断一次（期间仅 @ / 回复）、计入该 Bot 的每日后台预算（用完即不跑；内置模型的群聊判断仍不计）。
  - 续接 L2 仲裁关闭；反思 / 摘要每 `AGENT_BACKGROUND_EVERY_N_RUNS`（5）次触发一跑（按 Bot / 对话计数，进程内，归零即删计数）；技能生成默认关。设置页「后台任务」：自动 / 指定 Agent / 关闭；哪些用途仍走内置模型按全局主 / 轻量模型逐用途提示。
  - **用量与预算**：用量照常记 `agent:{id}`（未报 token 记零行）；连锁预算与每日后台预算都把零 token 行按 `AGENT_TURN_BUDGET_TOKENS` 折算（`complete()` 每次调用一行——多轮也只按一轮计；后台 run 每个模型轮一行）。Agent 路由的直聊摘要与记忆整理行记在所属 Bot 名下（计入其每日预算，`JobsRunner` 也按它推迟）；画像整理、群聊摘要无所属 Bot，不计入任何 Bot 的预算。内置路由的归属不变。
  - **核心关闭**：后台会话（`complete()`、后台 run）在 `AgentHost.dispose()` 时以失败结算（`AGENT_UNAVAILABLE`）并删除临时目录，调用方不会永远等待；对话 run 照旧不结算（重启恢复标中断）。
  - **待用户确认的默认**（P6 审查修复，协调会话按保守原则决定）：只有 Claude 可用于后台；开启「加载我的个人配置」即不可用于后台；「自动」只用 Bot 自己的 Agent，画像整理 / 群聊摘要需明确指定；群聊判断默认不经 Agent；并发须 ≥ 2；上述时限与节流值。



## 9 认证、分发与条款



### 9.1 认证与对话内设置

- KepCup 以 `clientCapabilities.auth.terminal = true`（及 `_meta['terminal-auth']`）声明支持 terminal 认证：以子进程运行 Agent 给出的官方登录命令（如 `claude auth login`、`opencode auth login`），浏览器完成厂商自己的授权；`agent` 类认证（Codex `chat-gpt`）由 Agent 自行处理；API key 类（Codex `api-key`、DeepSeek `DEEPSEEK_API_KEY`）的 key 存 KepCup secrets（键 `agent:{id}:api-key`），以环境变量注入（D25）。
- UI 不出现自制账号表单，不读取任何 token 文件。
- 未启用 / 未安装 / 未登录 / 版本不兼容 → 结构化 setup 失败 `{kind:'agent', agentId, reason}`，对话内呈现 Agent 设置卡（D58 范式），完成后自动续跑。



### 9.2 本期 Agent 适配矩阵（2026-10-07 调研）


| Agent              | 接入                                                                                                      | 分发（目录）                                                                      | 登录 / 计费                                                                                                                                     | 指令注入                                                                                          | Agent 自身沙箱                                                            | steering       | 并行会话（同进程） | 备注                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Agent       | ACP 适配器 `@agentclientprotocol/claude-agent-acp@0.86.0`                                                  | npx                                                                         | Claude Pro/Max 订阅、Console（terminal 登录）                                                                                                      | `meta-append`                                                                                 | 有（原生 sandbox）                                                         | 有              | 有（源码核对：`sessions` 表，每会话各自 `query()` 子进程与 `turnQueue`，取消只动本会话；待真机确认） | 开发期按启用，发行看 `releaseGate`；SDK 为商业许可，不打包；未登录在 `session/prompt` 才报 `-32000`                                                                                                                                                             |
| Codex              | ACP 适配器 `@agentclientprotocol/codex-acp@2.1.1`（内含 `@openai/codex`）                                      | npx                                                                         | ChatGPT 订阅、API key（均为 agent 类认证，无 terminal）                                                                                                 | `prompt-prefix`                                                                               | 有（`workspace-write`）                                                  | 有              | 有（源码核对：会话 / 在途 prompt / 待启动 turn 均按 sessionId 分表，每 prompt 自己的 AbortController，事件按会话串行分发；待真机确认） | 首推；MCP 仅 http；未登录在 `session/new` 即报 `-32000`                                                                                                                                                                                         |
| OpenCode           | 原生 `opencode acp`（v1.18.35）| binary（GitHub release；6 平台 sha256 已复核锁定）| `opencode auth login`：GitHub Copilot、ChatGPT、Z.AI Coding Plan、各家 API key 等；**未登录也可用**自带匿名免费模型（`opencode/*-free`，目录 `anonymous`） | `prompt-prefix`；进程级 `OPENCODE_CONFIG_CONTENT` + `OPENCODE_PERMISSION` 只放全局项（`edit`/`bash` 一律 ask、数据目录 `external_directory` deny、`autoupdate:false`、`share:'disabled'`），`OPENCODE_DISABLE_CLAUDE_CODE=1` 关闭 CLAUDE.md 回退；OpenCode 各配置层按 mergeDeep 合并（已有键保位、新键追加）+ `findLast` 求值，宿主的层无法保证最后生效 → 进程启动前与每次建 / 恢复会话前扫描 `~/.opencode`（及「加载我的个人配置」时的全局配置目录）里用户可写的权限层（JSON 层与 agent / mode markdown 的 frontmatter——按 gray-matter 规则切出、只接受 YAML、以 YAML 解析器解析后只看 `permission` / `tools`），任何对非只读权限给出 `ask` / `deny` 以外的动作、`{file:}` / `{env:}` 替换、自定义工具代码、无法解析的文件或扫描不完整（目录过深 / 文件过多）都拒绝运行（fail closed，`AGENT_CONFIG_UNSAFE` → 对话内设置卡列出要改的文件与键〔家目录下显示为 `~/…`〕，无需重装；探测 / 登录 / 退出的控制进程不扫）；JSON / JSONC 层按 OpenCode 所用 jsonc-parser 3.3.1 的词法解析（`//` 注释止于 `\n` 或 `\r`），`__proto__` 键拒绝；`OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` / `OPENCODE_TEST_HOME` / `OPENCODE_TEST_MANAGED_CONFIG_DIR` / `XDG_CONFIG_HOME` 不接受目录 / 启动目标里的值。**残留（有意不拒绝）**：用户层的 `mcp.<x>`（`type:"local"` + `command`）、`formatter.<x>.command`、`lsp.<x>.command` 由 OpenCode 直接拉起用户配置的命令、不经宿主裁决（用户真实的 MCP / LSP 配置常见，只有用户自己能写这些文件） | **无** → 命令逐条确认 | 不支持（未声明） | 有（内嵌源码核对：ACP 会话表 + 按会话等待 idle；服务器 `SessionRunState` 每会话一个 runner，`SessionBusyError` 只针对同一会话；待真机确认） | **P5 已实现**（`providers/opencode.ts`，契约 fake 剧本通过；真机待登录实测）。档位 read_only → `plan`、其余 → `build`（config option）；权限选项 `once`/`reject`；MCP 工具名 `{server}_{tool}`，ACP 镜像无结构化名（桥步骤会重复一条，待实测）。**禁止**经 OpenCode 使用 Claude 订阅（Anthropic 明令禁止，OpenCode 自 1.3.0 起不再内置）；terminal 认证只在 `_meta['terminal-auth']`（command 为裸名，宿主改写为已安装路径） |
| DeepSeek Harness   | 原生 `dsh --profile acp`（`@deepseek-ai/dsh` 0.2.0-rc.2，官方定位 automation-only，preview）| npx（精确版本 + 随应用锁文件）| DeepSeek API key（`DEEPSEEK_API_KEY`，存 secrets 注入；无订阅制） | `prompt-prefix` | 待配 key 实测（无 modes，只靠宿主权限桥裁决 allow-once / reject-once 请求） | 无（每会话单 prompt） | 有（源码核对：每个 ACP 会话一个独立 harness Agent，在途 prompt 状态属于会话；待真机确认） | **P5 已实现**（`providers/dsh.ts`，契约通过；真机待配 key 实测）。`preview` 档；不支持 `session/load` / modes / 图片，有 resume；无登录流程，未配 key 时 prompt 报 `-32603`「no API key …」→ 判为 auth_required；**很重**：npx 冷启动约 77s、约 760MB（安装后预热待安装器 postInstall 钩子）；原生依赖在 `npm ci --ignore-scripts` 下的可用性待实测 |
| Cursor             | 原生 `cursor-agent acp`（2026.10.01）| binary（downloads.cursor.com；Registry 无 sha256 → 导入脚本计算，6 平台已锁定）| `cursor_login`（ACP authenticate，Agent 自行开浏览器；Cursor 套餐额度：Cursor Models / Other Models 两个池）；或 `CURSOR_API_KEY` | `prompt-prefix`（无 ACP 提示词字段；会读 `.cursor/`、`AGENTS.md`、`CLAUDE.md`） | 有（Linux Landlock + seccomp，需内核 ≥ 6.2；macOS Seatbelt）——ACP 模式下是否生效未核实，按无处理（命令逐条确认） | 不支持 | 有（随包 JS 核对：会话表 + 每会话 AgentSession / agentStore / 执行资源，Agent 类无「当前 prompt」；闭源，待真机确认） | **P5 已实现**（`providers/cursor.ts`，契约通过；真机待登录实测）。档位 read_only → `ask`、其余 → `agent`（`agent` 对 Cursor 豁免全局禁止表）；阻塞式扩展请求：`cursor/ask_question` 应答 `skipped`（用户不在线，请自行决定）、`cursor/create_plan` 应答 `rejected`（不替用户声明已审阅）；`loadSession` 有、无 `resume`；MCP 权限请求无结构化名（桥工具审批可能逐条弹卡，待实测）；官方文档明确鼓励自建 ACP 客户端 |
| Google Antigravity | 原生 `agy_acp_server`（1.3.0）| binary（dl.google.com；无 sha256 → 导入脚本计算，6 平台已锁定；Linux 包解压约 1 GB）| **仅** `gemini-api-key`（`GEMINI_API_KEY`）、`agent-platform`（Vertex）；`oauth-personal`（个人 Google 账号 / AI Pro·Ultra 订阅）与 `oauth-business`（受限与否待合规确认）**均过滤**，UI 与 authenticate 都无法触发 | `prompt-prefix`（读 `AGENTS.md`、`GEMINI.md`、`.agents/`、`.gemini/`） | 个人 / key 方式**无**（仅 Enterprise 管理开关启用 exebox）→ 命令逐条确认 | 不支持 | **未验证 → 并发恒为 1**（原生二进制，无可读源码） | **P5 已实现**（`providers/antigravity.ts`，契约通过；真机待配 key 实测）。私有 `GEMINI_HOME`（`{数据目录}/agents/antigravity-acp/gemini-home`：防止按用户 `~/.gemini` 的 `auth.type` 推断出个人账号，并隔离全局 MCP 配置 / hooks / 信任表）；不设 `AGY_ACP_DISABLE_WORKSPACE_TRUST`（未知信任的工作区 hooks 被抑制）；**档位一律 `default`**，`auto_edit`（非 Enterprise 下不分工作区内外自动批准编辑）与 `yolo` 禁止；条款第 6 条：第三方软件经 Antigravity OAuth 访问属违规，可封 Antigravity 与 Gemini CLI 账号；客户端名称如实为 KepCup（进入 User-Agent）；`preview` 档 + `releaseGate`；Windows 支持待实测 |
| ZCode（智谱）          | **放弃**（2026-10-08，`docs/dev/DEVIATIONS.md` DEV-008）：无 ACP，私有 `app-server --stdio`（ZCode Protocol） | — | app-server 模式的订阅登录由宿主经 `interaction/requestProviderRuntimeHeaders` 提供鉴权头（不读 `zcode login` 的凭据）→ 接入必须读取 / 中转用户凭据，违反 §9.1 | — | 无 OS 沙箱；`edit` 模式不分工作区内外自动批准写入，用户级 allowedTools / 项目规则无法关闭 | — | — | 目录不收录；通用的 `connect` / `transport:'shim'` 接线保留（有测试），供日后确有协议垫片的 Agent 使用 |

**并行会话（2026-10-08）**：「并行会话」列只凭适配器**锁定版本**的源码 / 随包 JS 判断（逐家文件与行号见各 Provider `features` 旁的注释与 `todo/acp-external-agents.md` §8.5），全部**待真机确认**（两个对话同时用同一 Agent 跑 prompt）；未验证的 Agent 声明 false（并发恒为 1，§7）。

**原生优先遵守度（P6，§4.2）**：真机回归脚本 `packages/core/scripts/agent-spike/adherence.mjs`（spike 的 `adherence` step）以产品实际下发的措辞（`fixtures/native-first-wording.json`，由 core 单测按产品代码生成、措辞变动即失败；契约测试保证每个 Provider 经引擎 + 宿主桥送达的就是它）对每个 Agent 跑 web / vision 两个用例（各 10 次，目标原生 ≥ 0.9）。**结果：待真实账号运行**（需各 Agent 登录，开发会话不代为登录）；运行后把 `adherence-summary.md` 的表贴在这里，未达标的 Agent 在其 Provider 中加强点名措辞，或把该补位包默认值改为不注入。




### 9.3 条款风险


| 厂商                               | 现状                                                                                                                                                 | 处理                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic                        | Agent SDK 文档：未经批准，第三方不得提供 claude.ai 登录或订阅额度；法务页：不得收集 / 中转凭据，但不阻止终端用户在未修改的 Claude Code 中登录自己的订阅（含平台托管）；2026 年内政策多次变动                                | 只拉起官方二进制、只走官方登录、不碰凭据；品牌用「Claude Agent」；**开发期间按启用处理、全部功能走通**；发行前由产品确认是否随发行版发布（`releaseGate`），必要时联系 Anthropic                        |
| OpenAI                           | codex-acp 由 OpenAI 共同维护，支持 ChatGPT 登录                                                                                                              | 首推                                                                                                                                 |
| OpenCode                         | 自身 MIT；其登录的各家订阅受各家条款约束（Claude 订阅被禁）                                                                                                                | 条款提示中明确「不要在 OpenCode 中登录 Claude 订阅」                                                                                                |
| 智谱 / DeepSeek                    | Coding Plan、API key 的第三方工具使用范围以各自条款为准                                                                                                              | P0 合规清单逐项确认                                                                                                                        |
| Cursor                           | 文档原文「ACP is intended for building custom clients and integrations」；ToS 未禁止第三方客户端（只禁逆向、转售、抓取）                                                       | 正常接入；条款提示说明计入 Cursor 套餐额度                                                                                                          |
| Google（Antigravity / Gemini CLI） | Antigravity 条款第 6 条与 FAQ：第三方软件经 Antigravity OAuth 访问属违规，可封 Antigravity 与 Gemini CLI 账号，并建议改用 Gemini Enterprise 或 AI Studio API key；Gemini CLI 条款同类 | Antigravity 只开放 Gemini API key / Vertex 登录（Provider 白名单过滤 `oauth-personal` 与 `oauth-business`〔后者是否受限待确认，保守过滤〕，UI 与 authenticate 都无法触发；私有 `GEMINI_HOME` 防止沿用用户在别处选过的个人账号）；`releaseGate`；Gemini CLI 本期不做 |


目录条目带条款提示，可随应用更新调整或下线某个 Agent，不影响内置引擎。

## 10 可扩展性：Provider 架构

```text
shared/src/domain/agent-catalog.ts      目录条目（数据，含 ACP Registry 同构字段 + 扩展字段）
shared/src/domain/host-capabilities.ts  能力包登记表
core/src/agent/external/
  ├─ engine.ts            ExternalAgentEngine（AgentEngine 实现，协议无关的 run 编排、事件映射、steer/abort）
  ├─ host.ts              进程管理（每个 Agent 一个进程，多会话，空闲退出）
  ├─ acp/client.ts        ACP 连接（ClientSideConnection + 宿主 Client 实现：permission / fs 拒绝 / terminal 拒绝）
  ├─ mcp-bridge.ts        宿主 MCP 桥
  ├─ permission-bridge.ts 权限分级
  ├─ installer.ts         npx / binary / system 三种分发的安装与校验
  └─ providers/
       ├─ index.ts        PROVIDERS 登记表
       ├─ generic-acp.ts  通用实现（只用 ACP 标准 + 已核对扩展）
       └─ claude.ts  codex.ts  opencode.ts  dsh.ts  cursor.ts  antigravity.ts
          （shim 型 Provider 以 `connect(proc, client)` 返回进程内 ACP Agent；ZCode 已放弃，见 §9.2）
```

```ts
interface AgentProvider {
  id: string;
  launch(ctx: LaunchContext): { command: string; args: string[]; env: Record<string, string> };   // 进程级配置在此
  instructionMode: 'meta-append' | 'prompt-prefix';
  sessionNew(ctx: SessionContext): { _meta?: object; extraMcpServers?: McpServer[] };           // 会话级选项
  applyPermissionTier(tier: PermissionTier, ctx): Promise<void>;   // 禁止 bypass / yolo / full-access 一类模式   // set_mode / set_config_option / 进程配置
  permissionOptions: { allowOnce: string[]; rejectOnce: string[] }; // optionId 白名单
  toolName(server: string, tool: string): string;                  // 平台规则里引用工具的写法
  features: { steering: boolean; loadSession: boolean; resume: boolean; osSandbox: boolean; httpMcp: boolean; parallelSessions: boolean }; // parallelSessions：同进程多会话可同时有 prompt 在途（只凭锁定版本源码实证声明，§9.2）
  agentSideConfigFiles: string[];                                  // 无法关闭、需确认的 project 内配置文件
  forbiddenModes?: string[]; safeModes?: string[];                 // 叠加 / 豁免全局禁止模式表（Antigravity 禁 auto_edit；Cursor 的 agent 与 Codex 同名不同义）
  authMethods?(advertised: AuthMethod[]): AuthMethod[];            // 过滤 / 排序登录方式（如 Antigravity 去掉 oauth-personal）
  classifyError?(err: unknown, phase: 'initialize' | 'session' | 'prompt'): 'auth_required' | 'not_installed' | 'incompatible' | 'other'; // 各家未登录的错误形态不同（todo 附录 A.4）
  extRequests?: Record<string, (params, ctx) => Promise<unknown>>; // 厂商扩展请求（如 cursor/ask_question、cursor/create_plan）
  connect?(proc, client): AcpAgentLike;                            // 仅 shim 型 Provider 提供（client = 垫片发 session/update / 权限请求的一侧）
}
```

- 认证状态另从 `_auth/status_update` 扩展通知获取（Claude / Codex 支持），与 `classifyError` 共同驱动 §2.2 的状态机；terminal 认证命令（`_meta['terminal-auth']`）一律改写为目录安装的可执行文件路径再运行。
- ACP SDK 的 `ClientSideConnection` 对 Client 未实现的方法会静默回 `null`，宿主必须显式抛 `methodNotFound`。
- 宿主 ACP 客户端对**任何未处理的 Agent→客户端请求**（未知扩展方法、未声明能力的 `fs/`* / `terminal/*`）立即返回「不支持」错误，不能悬挂——部分 Agent（如 Cursor 的扩展请求、权限请求）在客户端不应答时会卡住整个工具调用。
- 新增 Agent 的步骤：① 在目录加条目（可由 Registry 条目导入）；② 若与通用实现无差异则 `provider:'generic-acp'`，否则新建 Provider 模块只覆盖差异；③ 在 `PROVIDERS` 登记；④ 跑 **Provider 契约测试**（testkit 的 fake agent 驱动的一组用例 + 对真实 Agent 的 spike 脚本：启动、认证探测、会话、prompt、权限请求、cancel、MCP 往返、能力探测），全部通过才能进目录。
- 业务代码只依赖 `AgentEngine` 与 `AgentProvider` 接口，ACP SDK 只在 `external/acp/` 下引用（D21 精神延伸）。



## 11 开放决策（推荐默认）


| #   | 议题                           | 推荐默认                                                        |
| --- | ---------------------------- | ----------------------------------------------------------- |
| 0   | Claude Agent 的发行范围           | **已决定**：开发期按启用处理；发行前再定（`releaseGate`）                       |
| 1   | 会话复用                         | 30 分钟窗口内复用；P1 先每 run 新会话                                    |
| 1a  | Antigravity 的登录方式            | 只开放 API key / Vertex / Enterprise；个人 Google 账号登录不开放（条款明确禁止） |
| 2   | 能力包默认值                       | 「Agent 原生没有的全部注入」；未知原生能力视为没有                                |
| 3   | 是否加载用户个人 Agent 配置            | 默认否，提供开关                                                    |
| 4   | 无 OS 沙箱的 Agent               | `workspace` 档命令逐条确认；Windows 上一律 `ask`                       |
| 5   | 后台 loop 走外部 Agent            | 仅当无内置模型时；L2 仲裁关、反思 / 摘要降频、技能生成默认关                           |
| 6   | 管家可否用外部 Agent                | 可以；onboarding 只有订阅的新用户默认如此                                  |
| 7   | 社区 Agent（运行时同步 ACP Registry） | 本期不做；架构上已支持（通用 Provider）                                    |
| 8   | ZCode                        | **已决定**：放弃（P5 复核：订阅鉴权须由宿主读取 / 中转凭据，见 §9.2、DEV-008） |
| 9   | 整 run 持有写入租约                 | 接受；Bot 详情提示                                                 |




## 12 非目标（本期）

- 提取或复用订阅 token；代用户登录；修改厂商二进制。
- 让 Agent 原生文件 / 命令工具经 KepCup 沙箱执行；把 `network_policy` / `protectRules` 映射到 Agent 沙箱。
- 运行时同步 ACP Registry、`uvx` 分发、Gemini CLI 及其他未适配 Agent；Antigravity 的个人 Google 账号（订阅）登录。
- 流式逐字输出、思考过程展示、Agent plan / diff 面板。
- 外部 Agent 下的 durable（D67）与 `delegate_task`（D66）。
- ACP 不稳定特性（fork、`providers/*`、acp 传输 MCP、v2 草案；`PromptResponse.usage` 只读例外）。
- KepCup 作为 ACP Agent 对外提供（反方向）。



## 13 验收锚点（设计级）

1. 设置页「智能体」列出本期 Agent 卡片；启用一个 Agent 完成安装（npx 与 binary 两种，binary 校验 sha256）+ 官方登录后状态为 `ready`；停用后 Bot 下拉不再出现它。
2. Bot 运行配置可在内置模型与已启用 Agent 间切换；切到 Agent 后可选模型、权限档位与能力包；切回内置模型后行为与改动前一致（内置引擎全部测试不变）。
3. 能力包：取消勾选 `image_generation` 后该 Bot 的 Agent 看不到 `generate_image`、平台规则不再提及；勾选 `memory` 时 `remember` 往返成功；默认勾选与 Agent 原生能力声明一致。
4. 只有 Codex（或 OpenCode + Copilot / ChatGPT）订阅、无 API key 的新用户：完成引导后能与 Bot 单聊，Bot 记得用户画像、能发附件、能 `remember`；后台摘要 / 反思不报错。
5. 绑定 project 的对话中外部 Agent 改文件：开工前取得租约、结束后有检查点 diff 可回退；越界写弹 `agent_tool` 卡，拒绝后 Agent 收到拒绝；无 OS 沙箱的 Agent 每条命令弹卡。
6. 执行中追加消息：支持 steering 的 Agent 当前 run 内生效；不支持的在 run 结束后续投；不产生脱离 run 的 Agent 输出。
7. 未启用 / 未登录时发消息：对话内出现 Agent 设置卡，完成后原 run 自动续跑。
8. 群聊中多种 Agent 与内置 Bot 混合：@、顺序响应、`skip_reply`、跨 Bot 委派正确。
9. KepCup 数据目录与日志中不存在任何订阅凭据；Agent 对应用数据目录（其 workspace 与技能目录除外）的读写请求一律被拒绝（含无人值守）；Claude 不加载仓库内 `.claude/` 配置。
10. 原生优先：为自带联网搜索的 Agent 勾选 `web` 包后，工具描述带「[补充能力]」前缀、`<tool_policy>` 点名其原生工具；默认情况下该包不勾选。宿主优先：要求「记住」时调用 `remember` 而不是写文件。
11. 新增一个仅用通用 Provider 的测试 Agent（testkit fake agent 作为目录条目）不改 core 其他代码即可被启用、被 Bot 选用并通过契约测试。

