# 38 对话内应用设置（Conversational Settings）

用户说一句「换个默认模型」「我想让你帮我生成图片」，Bot 先**查**应用能不能做、再**读**清楚要改什么、最后**改**——能直接改的立即生效并留回执，其余在对话里出一张预填好的设置卡，用户操作一次即可。本篇定义设置目录、`settings_search` / `settings_read` / `settings_change` 三个工具、宿主裁定修改档位、消息流里的设置卡与 Bot 续答。

**状态：P0 已实现（2026-10-13，分支 `t/settings`，待审查收口）；P1（组件化扩面）、P2（旧 7 个 kind 收拢）未开工。** 无 DB 迁移。执行方案与四项拍板见 [todo/conversational-app-setup.md](../../todo/conversational-app-setup.md)；偏差见 [DEVIATIONS](../dev/DEVIATIONS.md) DEV-026；实施记录见 [PROGRESS](../dev/PROGRESS.md)。

> 编号说明：本篇文件号 38 与决策号 D89 是写作时（main 上最大为 37 / D88）取的下一个空号；与并行分支合并时以最后一个空号为准，同步改本篇标题、README 索引与决策行。

相关：D58 对话内设置引导（[18](18-inline-setup.md)，失败续跑链与 7 个旧 kind）、D75 对话轮与任务分治（[02](02-execution.md)、[30](30-supervisor-and-tasks.md)，对话轮只读、异步托管动作由宿主确定性执行）、D80 定时提议卡（[todo/schedule-nudges.md](../../todo/schedule-nudges.md)，消息流里的提议卡先例）、D73 连接应用（[29](29-connected-apps.md)，污点）、D72 外部智能体能力包（[28](28-external-agents-acp.md)）、D88 盘点 → 提议（[37](37-bot-asset-handover.md)）。工具目录见 [dev/04](../dev/04-agent-runtime.md)。

## 决策

- **D89 对话内应用设置**：
  1. **一份设置目录是唯一事实来源**。`packages/shared/src/settings-catalog/` 纯数据登记 KepCup 自身的全部设置项（id、作用、范围、字段、最宽松档位、卡片组件、深链）；工具、卡片、提示词、覆盖率测试都读它，不做第二份清单。否决「每个设置项一个工具」（工具面随设置线性膨胀，且会与 `app_{slug}_{tool}` 碰撞）。
  2. **三个通用工具，渐进披露**：`settings_search`（概览 / 检索）→ `settings_read`（详情）→ `settings_change`（修改或出卡）。常驻提示词只有一条规则；工具描述只写用法、不写设置清单。
  3. **修改方式由宿主裁定，Bot 不能自选**。档位五级 `direct` / `confirm` / `form` / `user-only` / `link`，目录给出条目的最宽松档，宿主按触发源、不可信内容、群聊、跨 Bot、放宽权限、渲染层、缺密钥等条件**只收紧不放宽**；提示词不教模型风险分档。
  4. **direct 白名单只有两组**：默认主 / 轻量模型（限已配置 Key 的厂商）、本 Bot 的主 / 轻量模型（`DIRECT_ITEM_IDS`，测试强制）。direct 必出**回执卡**，24 小时内可一键撤销。
  5. **卡片是消息流里的 `system_event`（`setting_card`），不是审批**。同一对话可并存多张；同一项只留最新一张 pending；每 run ≤3 张；同一 Bot 对同一项 7 天内被拒 2 次后宿主拒绝再出。设置卡与 D58 输入坞上方的单张失败续跑卡并存、互不替代。
  6. **提议卡落定后唤醒 Bot 续答，每张一次**（有意不同于 D80 的「不唤醒」：设置卡只是用户原始需求的前置步骤）；撤销回执卡不唤醒。
  7. **两条触发链并存**：提议链（用户主动 / Bot 判断需要，不让 run 失败）与失败续跑链（任务缺设置，沿用 D58：失败 → 出卡 → `runs.retry`；新增通用 kind `{kind:'setting', itemId, prefill?, reason}`）。
  8. **密钥永不经模型**：`secret` / `oauth` / `account` 字段只能由用户在卡上填；`values` 带上即拒；读只回「已配置 / 未配置」。安全开关类（开启无人值守、沙箱、白名单、项目保护规则、放开网络）是 `user-only`：Bot 可以出卡，宿主**不采用** `values`。
  9. **条目级 CAS**：写入在 core 设置写锁内「读 → 只比对并改本条目字段 → 写回」，不发整对象；撤销与过期卡不会覆盖兄弟字段的并发修改。写成功广播 `settings.changed{itemIds}`。
  10. **ACP 外部智能体**：能力包 `settings` 默认只注入 `settings_search` / `settings_read`；`settings_change` 按 Bot 在能力包选项里单独开启（`settings:change`），开启后同样受全部裁定约束。

## 1 设置目录

### 1.1 形态

每个条目（`SettingItem`）：`id`（`组.名字`，小写短横线）、`group`（20 组：models / search / connections / mcp / mail / agents / bot / skills / schedules / profile / browser / group / project / hardware / general / background / unattended / environment / developer / diagnostics）、`title` / `summary` / `enables` / `keywords`（供搜索与「检查能力」）、`scope`（global / bot / group / project）、`owner`（`core` 或 `renderer`——主题、语言、麦克风只存在渲染层 localStorage，core 读不到也写不了）、`fields`（`FieldSpec`：name / label / type `text|number|select|toggle|model|secret|oauth|account` / sensitive / options 来源 / 多选）、`write`（`maxMode`、`via`、`widensPermission`、`wideningMode`）、`card`（`CardKey | null`）、`deepLink`（surface + section + anchor）、`store`（值存在哪：`settings` 点路径 / `bot` / `service` RPC / `renderer` / `none`）、`readOnly`。

- `write.via` 指向专门工具的项（`app_request_connection` / `mail_request_setup` / `install_skill` / `request_access` / `schedule` / `watch_create` / `propose_profile_change`）：`settings_read` 告诉 Bot 改用哪个工具，`settings_change` 只回「请改用某工具」、**不代为调用**，各工具自己的门控与审批不被绕过。
- `write.maxMode` 记**目标**档位；条目没有内嵌组件（`card = null`）时宿主一律兜底成 `link`（见 §3 第 4 步）。`widensPermission` 的条目永不 direct；`wideningMode: 'user-only'` 的条目在**本次值是放宽方向**时升到 user-only（如 Bot 网络策略放开、MCP / 连接逐工具策略放开；放宽与否由适配器按旧值 → 新值判定，未知按放宽）。
- `DIRECT_ITEM_IDS = models.default-main / models.default-light / bot.model / bot.light-model`。

### 1.2 首批条目（共 58 条，含 7 条能力模型）

| 组 | 条目 id | 最宽松档 | 卡片键 |
|---|---|---|---|
| 模型 | `models.default-main` / `models.default-light` | direct | `default-models` |
| 模型 | `models.provider`（厂商 + Key） | form | `provider-setup` |
| 模型 | `capability.{embedding,rerank,multimodal,asr,tts,image,video}` | confirm（缺 Key / 新厂商 → form） | `capability-model` |
| 模型 | `models.embedding-local` / `models.widget-review` / `models.concurrency` | confirm | 无（link） |
| 联网 | `search.provider` | confirm（缺 Key → form） | `web-search` |
| 连接 | `connections.connect`（via `app_request_connection`） | — | `connect-app` |
| 连接 | `connections.tool-policy`（放宽 → user-only） / `connections.taint-guard`（user-only） | confirm / user-only | 无 |
| MCP / 邮件 | `mcp.servers`（放宽 → user-only，无卡）；`mail.account`（via `mail_request_setup`） | confirm / — | 无 / `mail-account` |
| 智能体 | `agents.external`（登录由用户做） / `agents.default` | form / confirm | `agent` / 无 |
| Bot | `bot.model` / `bot.light-model` | direct | `bot-model` |
| Bot | `bot.browser-profile` / `bot.mcp-servers` / `bot.apps` / `bot.skills` | confirm（widens） | 无 |
| Bot | `bot.network` / `bot.agent`（放宽 → user-only） | confirm | 无 |
| Bot | `bot.identity`（via `propose_profile_change`）/ `bot.file-access`（via `request_access`） | — | 无 |
| 技能 / 定时 | `skills.install`（via `install_skill`）/ `schedules.schedule`（via `schedule`）/ `schedules.watch`（via `watch_create`） | — | 无 |
| 画像 / 浏览器 | `profile.user-facts`（link，永久）/ `browser.shared-profiles`（confirm） | link / confirm | 无 |
| 群 / 项目 | `group.title` / `group.members`（confirm）；`project.protect-rules` / `project.ports`（user-only） | — | 无 |
| 硬件 | `hardware.microphone` / `hardware.camera`（renderer） | confirm | `sensor` |
| 通用 | `general.theme` / `general.language`（renderer）/ `general.launch-at-login` | confirm | 无 |
| 后台 | `background.tasks` / `background.budget` | confirm | 无 |
| 无人值守 | `unattended.enable`（user-only）/ `unattended.disable`（confirm） | — | 无 |
| 环境 | `environment.toolchains`；`.sandbox` / `.allowlist` 保持跳转卡 | user-only | `environment-toolchains` / 无 |
| 开发者 | `developer.mode` / `.custom-mcp` / `.oauth-clients` / `.mcpb` | link（永久） | 无 |
| 诊断 | `diagnostics.status` / `diagnostics.usage` | 只读 | 无 |

删除类动作（删 Bot / 会话 / 浏览器资料 / 邮箱 / MCP / 技能 / 工具链、断开连接、解散群、移除项目、撤销授权、删画像条目）**不是设置**，不入目录，在 `EXCLUDED_SETTING_LOCATIONS` 显式排除表里逐条写明理由；记忆 / 组件 / 知识库 / 「其它」页签是数据或产出物，同样排除。

### 1.3 覆盖率与完整性测试（让「全部能成卡」可验证）

- **测试一（UI → 条目）**：设置弹框每个分区与 `data-settings-anchor`、扩展中心每个页签、Bot 面板每个 Tab、群设置与项目设置对话框（P0 给后三者补了锚点），都必须对应至少一个条目或在排除表里写明理由；新增设置分区不登记就过不了。扫描 Svelte 源码在 `settings-ui-scan.ts`，判定是纯函数 `settingsCoverageProblems`。`PENDING_DESKTOP_ANCHORS`（计划中尚未加的锚点）当前为空，且测试强制其中的锚点必须仍不存在。
- **测试二（条目 → 组件 / 锚点）**：每个 `card !== null` 的条目在渲染层 `SETTING_CARD_COMPONENTS` 映射里必须有组件（`cardComponentProblems`），每个条目的 `deepLink` 必须指向真实存在的分区与锚点（顺手修掉 `models-default` 这类死锚点）。
- **测试三（direct 白名单）**：`maxMode = 'direct'` 的条目必须在 `DIRECT_ITEM_IDS` 里，且白名单条目都是 core 拥有、带内嵌卡、不含敏感字段的模型选择器；敏感类型字段必须 `sensitive`，含敏感字段的条目不得 direct；渲染层条目最多 confirm 且没有 core store；user-only 安全开关（无人值守开启、沙箱、白名单、项目保护规则、放宽网络）档位被钉死。

### 1.4 core 适配器

`packages/core/src/settings/adapters.ts`：每个条目一个适配器 `{read, options?, normalize?, write?, needsSensitiveInput?, valuesWiden?}`，做法同 D88 资产适配器。

- **读**返回脱敏快照 `{status: configured|unconfigured|partial|unknown|readonly, values, secrets, summary}`；永不返回密钥、本机路径、日志、画像原文，用户自填名称一律过 `sanitizeDisplayText`；渲染层条目回「状态未知（只在本机界面可见）」。
- **写**调用设置页用的同一批服务，只改本条目字段（`capabilityModels` / `webSearch` / `agents` / `backgroundTasks` / `apps` 等整对象一律在**最新**设置上按字段合并，不发整对象）。目前有写实现的条目：默认主 / 轻量 / 组件审查模型、厂商 Key、能力模型 ×7、联网检索、污点防护开关、外部智能体启停、默认智能体、Bot 主 / 轻量模型、开机启动、后台任务、后台预算、关闭无人值守；其余 core 条目是只读概要，只能出卡 / 跳转。
- **值格式**（`values` 的键 = 字段名）：对话模型字段为 `{model: "厂商/模型id"}`（`''` = 跟随默认，仅限 Bot 模型与组件审查模型；写入前补全 / 校验厂商前缀并核对该厂商下确有此模型）；能力模型 `{provider, model: "厂商/模型id"}`（厂商须支持该能力）；联网 `{provider}`；开关类 `{enabled: boolean}`；预算 `{tokens: 非负整数, 0 = 不限}`；后台任务 `{agentEnabled, agent}`；外部智能体 `{agent, enabled}`；Bot 网络策略等只读概要条目的快照为 `{policy, allowlist}`（暂无写入实现）。
- **needsSensitiveInput**：缺 Key、要新增厂商、外部智能体需登录 → 至少 form（例如种子 mock 厂商无 Key 时，换模型从 direct 收紧为 form）。
- **选项**：已配置厂商下的对话模型、能力的可选厂商 / 模型（已有 Key 的排前）、检索供应商、智能体目录等，≤30 个。

### 1.5 写锁、条目级 CAS 与 `settings.changed`

- `SettingsWriteLock`（`settings/write-lock.ts`）是进程内 promise 链互斥。设置页原有的 `settings.update` RPC 在读旧值与写回之间有 await，所以**两条写路径（设置页保存、目录适配器写入 / 撤销）都在这把锁里串行**，否则适配器 CAS 可能读到旧值又被 RPC 拿旧快照写回的顶层键覆盖。锁不可重入。
- 写入：锁内读当前值 → `expected` 非 null 时逐键比对**本条目的非敏感字段**，不一致返回 `conflict`（带当前值），一致才与当前值合并写入 → 再读 → 成功后发 `settings.changed`。
- `settings.changed{itemIds}`（非空）由：`settings.items.apply`、Bot direct 修改与撤销、**设置页原有保存路径**（`settings.update` 按前后差异 `changedSettingsPaths` → `itemIdsForSettingsPaths`；`bots.update` 按 runtime 差异 → `itemIdsForBotPaths`；`providers.setKey` / `websearch.setKey` / `embedding.configure` / `mcp.*` / `agents.*` / 服务类 RPC 按 `itemIdsForMethod` 包装补发）发出。桌面端 `settingsStore` 订阅后重新拉快照，打开着的设置弹框随之刷新，link 卡据此自标 applied。

## 2 三个工具（对话轮与任务都注册）

对话轮只读、写操作由宿主确定性执行（D75），三者是**异步托管动作**，与 `schedule` / `offer_schedule` 同类，不走审批。工具本身很薄，目录读取、裁定、CAS 写入、出卡都在 `SettingsCatalogHost`（`settings/host.ts`），orchestrator 按 run 绑定上下文后以门面传入。`classify`：`settings_search` / `settings_read` 无副作用，`settings_change` 记 `local`。

| 工具 | 输入 | 返回（上限） |
|---|---|---|
| `settings_search` | `query?`（关键词或需求描述，如「生成图片」） | 无 query：每组一行就绪概况（配好 / 部分 / 未配 / 未知）；有 query：≤10 条 `id｜标题｜作用｜当前状态｜本次可用的修改方式`。≤2KB |
| `settings_read` | `id`、`bot_id?` | 字段（敏感字段只说已配置 / 未配置）、当前值（脱敏）、可选值（≤30）、**本次上下文里实际可用的档位与原因**（如「群聊中只能出卡」）；`via` 项直接说改用哪个工具；未知 id 给最接近的 3 个候选。≤4KB，字段与值放进 `<untrusted>` |
| `settings_change` | `id`、`values?`（只含非敏感字段）、`reason`（≤200 字，显示在卡上）、`required?`（仅任务）、`bot_id?` | 结果档位与人话（「已改为 X，用户可在回执卡上撤销」/「已出设置卡，处理后你会收到通知」/「这一项由用户亲手设置，已出空白卡」） |

- 三个描述加起来约 600 字，只写用法。`bot_id` 只对 Bot 范围条目有意义：默认自己，管家可填别的 Bot。
- `settings_change` 直接拒绝：`values` 含敏感字段或目录没有的字段（报可用字段）；`via` 专门工具的项（`redirect`）；`reason` 为空；改别的 Bot 而自己不是管家；loop 不是 turn / task。
- **已经是想要的值**不出卡（返回「无需修改」）；任务里 `required:true` 且条目已配好，返回「可以继续」。
- 常驻提示词（`settings/prompt.ts` 的 `SETTINGS_RULE`，只此一条，追加到 `TURN_PLATFORM_RULES` / `PLATFORM_RULES`）：用户需求要调整设置才能实现、或不确定应用现在能不能做时，先 search、再 read、最后 change 或请用户在卡片里完成；不要让用户自己去设置页找，也不要让用户把密钥贴进聊天。输入标志 `hasSettingsTools` 与工具是否注册同源（orchestrator 按 `settingsCatalog` 是否装配），为假整条不出现。

## 3 宿主裁定修改档位（`effectiveMode`，确定性，只收紧）

纯函数在 `shared/settings-catalog/mode.ts`，上下文 `SettingModeContext` 由 core 计算传入。依次：

0. **终止规则**：条目只读 → `link`；`via` 专门工具 → `redirect`；loop 不是 turn / task（后台 loop）→ `refused`；改别人 Bot 的配置而自己不是管家 → `refused`。
1. **起点** = `maxMode`；`direct` 但不在 `DIRECT_ITEM_IDS` → 降为 `confirm`。
2. **下限（逐条取最严）**：
   - **触发源**：只有 `triggerReason ∈ {direct, mention, reply}` 且**触发批的发送者是用户本人**才允许 direct，其余至少 confirm。用户本人 = 批里每条消息都是 `senderType = user` 的普通文本、不带 `origin`（组件回传 `widget`、跨 Bot 代发 `delegation` 都不算），合并批各部分的触发原因也都在白名单内；任务的触发是 `task`，不在白名单；scheduled / event / watch / mail / chain / broadcast / background / 其他 Bot 的 mention / reply 都被排除。
   - **不可信内容**：本 run 读过不可信内容 → 至少 confirm。判定是**可信白名单**（`settings/context.ts` 的 `TRUSTED_TOOLS`：发消息、出卡 / 提议、设置、定时、记忆写入、任务与委派的管理动作、宿主侧的写与申请等只回执不回外部内容的工具）——**不在白名单里的工具一律按不可信**，含 `mcp_*` / `app_*` 动态工具与以后新增的工具；显式登记为不可信的有网页、邮件、浏览器、附件、`read` / `grep` / `ls` / `find` 与命令输出、历史消息、记忆、知识库、任务 / 子代理结果（`list_tasks`、`get_run`、`delegate_task` …）。每个内置工具都必须在两个集合之一显式登记（单测对照效果分类的全部工具名），新工具不登记过不了测试。`tool_call` 一发生就置位（同步并行的调用，模型决定它们时还没看到返回内容）。另外两种情况本 run **一开始就算不可信**：触发批带附件（图片进视觉通道、附件正文随时可读）；本 run 由**外部智能体（ACP）**执行（它的原生工具——抓网页、读文件、命令、自带 MCP——不经宿主分类，会话还跨 run 保留，所以整个 run 最多 confirm）。与 D73 污点（按（Bot, 对话）计，目前只有 `app_*` 读取置位）取**并集**——污点单独防不住网页、邮件里的注入。
   - **群聊** → 至少 confirm（群聊里只能出卡）。
   - **别的 Bot 的配置**（只有管家能走到这一步）→ 至少 confirm，不允许直改。
   - **`widensPermission`** → 至少 confirm（永不 direct）。
   - **`owner = renderer`** → 至少 confirm（core 写不了，由渲染层的卡写）。
   - **缺密钥 / 要登录**（适配器 `needsSensitiveInput`）→ 至少 form。
   - **放宽方向**（条目带 `wideningMode` 且 `valuesWiden !== false`）→ `user-only`。
3. **user-only 不采用 `values`**：工具返回「此项由用户亲手设置，已出空白卡」，卡上只显示 `reason` 与组件初始状态；风险确认之类步骤全留在组件里。direct / confirm / form 采用 `values`（预填），link / redirect / refused 不涉及值。
4. **无内嵌组件兜底**：收紧后不是 direct / link 而条目 `card = null` → `link`（跳转卡）。所以第一天就覆盖全部条目，每把一个组件嵌入化只需加 `CardKey` 并填 `card`。
5. `decision.rules` 记各自就足以收紧的规则代号（`trigger` / `untrusted` / `group` / `other-bot` / `widens` / `renderer` / `sensitive-input` / `widening-values` / `not-whitelisted` / `no-card` ……），`reason` 是给 Bot 和卡片看的人话，多条以「；」连接，随 `settings_read` 返回，也写入卡片的 `modeReason`。
6. **无人值守**：设置卡不是审批，不进 approvals 表，本来就不会被自动批准，只能由用户点击结算；无人值守期间的 run 由定时 / 事件等唤醒，第 2 步已把它们收紧到 confirm，不会发生 direct。

## 4 设置卡

### 4.1 消息形态

`system_event`，`event = 'setting_card'`，`content.setting`（`SettingCardContent`）：`botId`、`runId`、`itemId`、`mode`（direct / confirm / form / user-only / link）、`target{botId?, conversationId?, projectId?}`、`proposed`（user-only / link 卡恒 null）、`before`（出卡时的当前值快照，也是 `settings.items.apply` 的 `expected`；渲染层条目 null）、`beforeText` / `proposedText`（core 生成的人话）、`reason`（清洗后）、`modeReason`、`state`、`applied`（实际应用后的值；direct 回执卡 = 新值，供撤销）、`undoUntil`、`decidedAt`。状态写回方式同 `schedule_offer`（按消息 id 改 `content_json.setting` 并发 `message.updated`）；不建新表。

`state`：`pending` 待处理；`applied` 已应用（direct 回执卡的初始态）；`dismissed` 「不用了」；`superseded` 同一对话同一项出了新卡；`expired` 过期；`reverted` 回执卡被撤销。

### 4.2 卡片形态与渲染层

桌面 `features/settings-card/`：`SettingCard`（宿主，渲染在 `MessageBubble` 里；`setting_card_resolved` 内部事件在消息流里不显示）→ `SettingCardEmbed`（按 `CardKey` 分发到设置页组件）。

| 形态 | 呈现 |
|---|---|
| 回执卡（direct） | 「旧值 → 新值」+「撤销」，24 小时内有效；过期 / 已撤销后文案落定 |
| confirm | 「当前 → 建议」对比行（只列非敏感、且 Bot 提到的字段）+「应用 / 不用了」；用户可先改值再应用 |
| form | 内嵌组件待填（密钥 / 登录由用户自己做），Bot 只预填非敏感字段 |
| user-only | 空白组件 + `reason`，不预填 |
| link | 「在设置中打开」深链；用户保存后卡片收到 `settings.changed` 自标 applied；也可点「我已设置好」 |

- 内嵌组件映射（`SETTING_CARD_COMPONENTS`，9 个 `CardKey`）：`default-models` → 新建 `DefaultModelsCard`；`provider-setup` → `ProviderSetupForm`；`capability-model` → `CapabilityModelSection`；`web-search` → `WebSearchSection`；`connect-app` → `ConnectAppPanel`；`mail-account` → `MailAccountAddForm`；`agent` → `AgentCard`；`bot-model` → 新建 `BotModelCard`（自带 `bots.update`）；`sensor` → `SensorCard{kind}`。现有组件统一补 `embedded` / `prefill` / `onSaved`，设置页行为不变。
- `cardEmbeddable` 判断当前上下文能否内嵌，不能就退回跳转卡：能力 / 传感器条目 id 要能对上；`bot-model` / `mail-account` 要有作用 Bot；`connect-app` 要预填 `app`；`agent` 要预填 `agent` 或有默认智能体且目录里有它。
- **自带 CAS 保存**的卡（`default-models`、`bot-model`）组件自己的「应用」就是宿主的应用（带 `expected` 与 `messageId`），宿主不再给第二个按钮（`SELF_APPLYING_CARD_KEYS`）；其余 confirm 卡由宿主经 `settings.items.apply` 写入。
- **渲染层条目**（麦克风 / 摄像头）core 写不了：confirm 卡「应用」时在本机写（`applyRendererValues`），再 `settings.cards.complete` 让 core 标 applied（无法核对，按用户所说）。
- **深链**（`deep-link.ts` + `open-deep-link.ts`）：settings → `shell.openSettings(section, anchor)`；extension-center → 扩展中心页签；bot-panel → `shell.openBotPanel(tab, anchor)`（窄屏 / 放不下并排右栏时是覆盖层）；group-dialog / project-dialog → 对应对话框。分区不认识时退回分区首页，不抛错。P0 给 `BotProfileForm`、`GroupSettingsDialog`、`ProjectSettingsDialog` 补了 `data-settings-anchor`，`RightPanel` 切页签后滚到锚点。

### 4.3 RPC 与事件

| 名称 | 作用 |
|---|---|
| `settings.items.apply{itemId, values, expected, target?, messageId?}` | 卡片 / 设置页按条目保存（条目级 CAS）。`values` 来自用户亲手填写，**可含敏感字段**，按适配器分发到 secrets，永不回显。返回 `applied{before, values}` 或 `conflict{current}`；带 `messageId` 时成功后卡片标 applied 并唤醒 Bot |
| `settings.cards.dismiss{messageId}` | 「不用了」：标 dismissed，唤醒 Bot 一次；已落定的卡原样返回状态 |
| `settings.cards.complete{messageId}` | 「我已设置好」（link 卡 / 渲染层条目 / 内嵌组件自己保存后）：core 能用适配器核对的核对一次——与建议值一致、**或已配置好、或本条目字段与出卡时不同**（用户在卡上改成了别的值 / 填了与预填不同的值）都算完成，卡上记**实际值**并唤醒一次；`verified: false` 保持 pending 并提示，`null` 无法核对按用户所说标 applied |
| `settings.cards.undo{messageId}` | 回执卡撤销：用卡上的旧值经同一套 CAS 写回，当前值已不是回执上的新值 → `conflict` 不覆盖；成功标 `reverted`，不唤醒 |
| 事件 `settings.changed{itemIds}` | 见 §1.5 |

### 4.4 生命周期与防刷屏

- **顶替**：同一对话里同一项（同一作用对象）出新卡时，旧的 pending 卡标 `superseded`；direct 回执也会顶替同一项的旧 pending 卡。
- **过期**：pending 卡 7 天无人处理标 `expired`（`SETTING_CARD_PENDING_TTL_MS`，P0 与拒绝窗口取同值）；惰性判定——出新卡时顺手清、用户对旧卡操作时先判。回执卡不过期（有自己的 24 小时撤销窗口）。
- **每 run 上限 3 张**（`SETTING_CARDS_PER_RUN_MAX`，按 `messages.run_id` 计，含回执卡）：超过返回 `LIMIT_REACHED`，让 Bot 在回复里说明还需要改什么。工具会并行执行（pi 并行跑同一步的工具调用），所以名额在第一个 `await` 之前**同步占位**（已落库的卡 + 进行中的占位），出卡或失败后释放。
- **拒绝退避**：同一 Bot 在同一对话里对同一项 7 天内被拒（`dismissed`）≥2 次（`SETTING_CARD_DECLINE_MAX` / `_WINDOW_MS`）后，宿主拒绝再出卡，提示「不要再提这一项」。参照 D80 改写：D80 按 Bot 和对话计次，这里**按条目**计。
- **回执卡**：direct 执行后必出，`undoUntil = now + 24h`（`SETTING_RECEIPT_UNDO_WINDOW_MS`）；只有 `mode = direct`、`state = applied`、窗口内、有旧值才可撤销；撤销写回 `reverted`，并在 Bot 的上下文回放里留一行「用户撤销了 X，已恢复为 …」。
- **CAS 冲突**：confirm 卡应用时若当前值在出卡之后变过，返回 `conflict`，卡片提示「设置已在别处修改」，刷新对比后再让用户确认。按键寻址的条目（`agents.external` 按智能体）只读、只比对本次涉及的那个键，兄弟键（别的智能体）的并发修改不算冲突；不带键时值覆盖全部已启用的智能体。
- **应用与「不用了」的竞争（pending → applying 占位）**：`settings.items.apply` 带卡片时，在写锁里**写之前**再确认卡片仍是 pending（已被「不用了」/ 顶替 / 过期就报错、不写），写完在**同一个同步关键区**里把卡标 applied；之后到的「不用了」只会看到 applied。带卡片时作用对象以卡为准，调用方给的 `target` 只能与卡一致。
- **写锁**：锁里只放「读最新 → 比对 → 合并 → 写回」的同步关键区；`settings.update` 的 MCP 断连 / 清理 / 撤销授权等网络副作用在锁外。等锁有上限（10 秒，超时 `TIMEOUT`），卡住的写路径不会拖住所有设置写入。设置页按整对象保存（表单快照整体提交）时过期表单覆盖别处修改是既有问题，对话里的直改只靠回执卡撤销时的冲突报告兜底。
- **审计**：每次改动都在消息流里留下回执卡或设置卡（谁、哪个对话、旧值 → 新值）。P0 不新建表；将来要跨对话查再考虑 `setting_changes` 表。

### 4.5 Bot 上下文回放

`settings/render.ts` 把 `setting_card`（含回执卡）与 `setting_card_resolved` 按结构化内容渲染成一行系统消息（「你直接修改了「X」：旧 → 新（回执卡，用户可撤销）」「你出的设置卡「X」（确认卡）：等用户处理，建议改为 …；理由 …」……）。卡上的值与 Bot 自己的 `reason` 来自模型输出或用户自填名称，一律放进 `<untrusted>`（`neutralizeUntrusted`）。

## 5 Bot 续答与两条链

### 5.1 唤醒语义（提议链）

用户**应用**（`settings.items.apply` 带 `messageId` / `settings.cards.complete` 通过）或**不用了**（`settings.cards.dismiss`）后，宿主写一条一次性内部事件 `setting_card_resolved`（`internal: true`，带结构化 `settingResolved{cardMessageId, itemId, outcome: applied|dismissed, before, after}`），经 `orchestrator.deliverEventToBot` 唤醒出卡 Bot 的对话轮；文本形如「设置卡结果（宿主系统注入，不是用户消息）：用户已应用「X」。接着处理用户原来的请求；不要再为这一项出卡」/「用户没有修改「X」……按用户原来的请求给替代做法或询问下一步」。做法同 D58 `task_setup_dismissed`。

- **每张卡只通知一次**：只在 `pending → applied / dismissed` 时唤醒；`superseded` / `expired` / `reverted` 与 direct 回执的**撤销不唤醒**（撤销本身已是用户意愿）。唤醒失败只记日志，不影响卡片状态。
- 写入期间卡片可能已被别处结掉（顶替 / 过期）：只结仍在 pending 的。

### 5.2 失败续跑链（任务）

任务里 `settings_change` 得到非 direct 档：

- 带 `required: true` 且宿主有 `onSetupRequired`：写 `setupHit.requirement = {kind:'setting', itemId, prefill?, reason}` 并返回 `SETUP_REQUIRED`，走 D58 原链——orchestrator 延后一拍 abort、settle `failed` + `run.setup`，输入坞上方的 `SetupRequiredCard` 遇到 `kind: 'setting'` 复用 `SettingSetupBody` → `SettingCardEmbed` 的同一套分发，预填取 `requirement.prefill`（仅在 `acceptValues` 时带）；完成后 `chat.continueAfterSetup` → `runs.retry`。这种情形**不在消息流里出卡**、不占每 run 3 张的名额（一次只会让本任务失败一次），但**同样受按条目的 7 天拒绝退避约束**：用户已拒绝两次的项，宿主既不出卡也不为它暂停任务，返回 `LIMIT_REACHED`，Bot 在结果里如实说明做不了的部分。
- 不带 `required`：发一张**不阻塞**的消息流卡，任务继续往下跑。

`setupRequirementSchema` 的通用 kind 让以后加设置项不再改契约；原有 7 个 kind（`main-model` / `capability-model` / `web-search` / `agent` / `connect-app` / `confirm-local-connector` / `mail-account`）不迁移（P2）。

## 6 安全与边界

- **密钥永不经模型**：`values` 带敏感字段直接拒；`settings_read` 只回已配置 / 未配置；提示词有「不要让用户贴令牌 / 密钥」；用户在卡里填的 Key 只经 `settings.items.apply` 到 secrets，永不回显、不进快照、不进 `before` / `applied`。
- **读也要脱敏**：不返回本机路径、日志、画像原文；诊断只给概要；用户自填的名称（厂商名、智能体名、群名）过 `sanitizeDisplayText`；工具返回里的字段值放 `<untrusted>`。
- **注入防护靠宿主裁定，不靠提示词**（§3 的触发源、不可信内容、user-only、无人值守几条）。
- **渲染层拥有的项**（主题、语言、麦克风、摄像头）core 读不到也写不了：`settings_read` 报「状态未知」，最多 confirm，由渲染层的卡在本机写。
- **不做「先检查再执行」的硬门禁**：执行前先检查能力是提示词纪律；缺配置时的确定性兜底仍由各工具入口自己检查（媒体网关、联网检索、连接、邮件），走失败续跑链。
- 设置卡不是审批：不进 approvals 表，不受无人值守自动决定影响，不继承任何审批绕过。

## 7 ACP 外部智能体能力包 `settings`

ACP 执行的 run 一律按读过不可信内容处理（§3），所以即使开启了 `settings:change`，外部智能体也最多出确认卡，不会直改。`<tool_policy>` 的设置行按实际注入的工具分「查看」「修改」两行。

`HOST_CAPABILITIES` 新增包 `settings`（category host，默认 inject，`tools = settings_search / settings_read / settings_change`）。包新增「包内选项」概念 `optIns`：`settings:change` 管 `settings_change`。选项 id 存在 Bot 的 `runtime.agent.capabilities` 里（`包id:名字`，`resolveCapabilities` 只认包 id，不受影响）；默认关闭；`resolveCapabilityOptIns` 解出该 Bot 开启的选项，`isHostToolInjected(tool, capabilities, optIns)` 判断是否注入（所属包选中且——若受选项控制——选项已开启）。orchestrator 把 `optIns` 传给 ACP 能力装配。

- 提示词 `AGENT_PLATFORM_RULES`：注入了 `settings_change` 时用 `SETTINGS_RULE`；只注入只读两个时用 `SETTINGS_READ_ONLY_RULE`（「你在这里不能修改设置，需要改的在结果里写明是哪一项（id）与原因，由对话中的你处理」），靠新增的 `unlessTools` 互斥；另有一条「查看（与修改）设置用 … 工具，不要去改 KepCup 的配置文件」。
- 桌面 `agent-capabilities.ts` / `BotProfileForm`：能力包下多一个「允许修改设置」开关（i18n `agents.capabilities.settings.change.*`）。开启后同样受 §3 全部规则约束。

## 8 测试锚点

- **shared**（`settings-catalog.test.ts` / `settings-mode.test.ts` / `settings-contracts.test.ts` / `settings-ui-scan.ts`）：目录完整性、direct 白名单双向、敏感字段、搜索与概览、UI 覆盖率（测试一 / 二）、`effectiveMode` 在 direct 白名单条目上的全矩阵与对每个目录条目的不变量（只收紧不放宽）、`setting_card` / `setting_card_resolved` / `kind:'setting'` / RPC / 工具结果形状、能力包 `settings` 与选项。
- **core 单测**（`settings-catalog-host.test.ts`、`settings-prompt-acp.test.ts`）：上下文辅助（`triggerFromUser`、不可信读取工具）、`settings_search` / `settings_read` 脱敏与字节上限、`settings_change` 与卡片（条目级 CAS、撤销不覆盖兄弟字段、顶替 / 过期 / 每 run 上限 / 拒绝退避、唤醒一次）、提示词门控、ACP 包默认不含 `settings_change`。
- **core 集成**（`settings-cards.test.ts`，对应方案 §八 P0 的八个场景）：「换个默认模型」走 direct → 回执 → 撤销复原；「帮我生成图片」search → form 卡 → 用户应用 → 对话轮被唤醒后接着做；邮件唤醒的轮次请求改设置被收紧到 confirm；用户触发的轮次先 `web_fetch` 再改被收紧到 confirm；群聊里白名单项被收紧到 confirm；「开启无人值守」出空白 user-only 卡且 `values` 不被采用；设置页原有保存路径补发 `settings.changed`；任务 + `required` → 失败带 `kind:'setting'` 的 setup，应用后重试续跑。
- **desktop**：`setting-card-model.test.ts`（形态、对比行、预填过滤、撤销窗口、link 自标 applied）、`card-components.test.ts`（映射与 `cardEmbeddable`）、`deep-link.test.ts`、`anchor-scroll.test.ts`、`settings-changed.svelte.test.ts`、`shell.svelte.test.ts`、`agent-capabilities.test.ts`。
- **e2e**（`setting-card.spec.ts`）：单聊 direct 回执卡撤销；群聊 confirm 卡应用后唤醒 Bot 续答。

## 9 非目标

- 不做「每个设置项一个工具」，提示词里也不列设置清单。
- 删除类、破坏性操作不入目录。
- 不让模型接触任何密钥、令牌或密码，也不提供「把 Key 告诉我，我帮你填」这类路径。
- 不改扩展中心 X5 的逐家适配；连接目录仍是第三方连接器的事实来源，设置目录只引用不复制。
- 不改 D58 已验收的行为（发送门禁、7 个 kind 的卡片），P2 之前只做增量。
- 设置卡不做审批、不新建审计表（P0）。

## 10 后续

**P1 组件化扩面**（每做完一个就把条目从 link 升级为内嵌卡，只加 `embedded` / `prefill` / `onSaved` props、设置页行为不变；尚是跳转卡的 core 条目，按用户价值排序）：

- Bot 配置其余片段：`bot.browser-profile` / `bot.network` / `bot.mcp-servers` / `bot.apps` / `bot.skills` / `bot.agent`（卡片自带 `bots.update`；这六项现在适配器也只有只读概要，需要补写入）；
- `models.embedding-local`（`EmbeddingSection`）、`models.widget-review`、`models.concurrency`；
- `unattended.enable` / `unattended.disable`（`UnattendedSection`；开启的风险确认步骤留在组件里）；
- 渲染层 `general.theme` / `general.language`（`AppearanceSection`）与 `general.launch-at-login`（`GeneralSection`）；
- `background.tasks` / `background.budget`（`BackgroundTasksSection`、用量预算）；
- `group.title` / `group.members`、`project.protect-rules` / `project.ports`（群 / 项目设置对话框片段）；
- `connections.tool-policy`（`AppConnectionDetail` 工具策略片段）、`connections.taint-guard`、`mcp.servers`、`agents.default`、`browser.shared-profiles`；
- `environment.toolchains`（`EnvironmentSection`，user-only 空白卡 `environment-toolchains`）；`.sandbox` / `.allowlist` 保持跳转卡，组件嵌入化后再出 user-only 空白卡。

永久只出跳转卡 / 只读：`profile.user-facts`、`developer.*`、`diagnostics.*`。`via` 专门工具的项（`connections.connect`、`mail.account`、`bot.identity`、`bot.file-access`、`skills.install`、`schedules.*`）由各自工具负责，`settings_change` 只重定向。

**P2 收拢**：D58 的 7 个旧 kind 改由 `SettingCard` 分发；评估把 `APP_REQUEST_CONNECTION_RULE` / `MAIL_REQUEST_SETUP_RULE` 并入新规则以减少常驻提示词；评估设置页各分区直接由「目录卡片」组成，让卡片成为设置的唯一渲染单元。
