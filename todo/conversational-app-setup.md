# 对话中指挥一切：应用设置按需披露、Bot 直改或对话内出卡

> 状态：**P0 已实现并通过独立审查与收口测试，待合并；P1/P2 未开工**（2026-10-14）。分支 `t/settings`（worktree `/home/jyy/wt/kepcup-settings`，未推送、未合并 main；方案本身 `572e856`）：shared 契约 `e74defd` → desktop `c7fddad` → core `37aa4cd` → 测试 `9e5aae0` / `79f3d9e` / `32b88d1` → 独立审查 12 项修复 `c10a7a6`。收口：单元 / 集成全量 33 例失败与 main 逐项一致，e2e 95 例中 9 例失败与 main 完全相同，分支独有失败为 0（见 PROGRESS）。方案经重写、复审，§十 的四项决策已由用户拍板（全部采纳建议）。实现后的设计篇是 [docs/design/38-conversational-settings.md](../docs/design/38-conversational-settings.md)（决策 D89）；与本文的偏差见 [docs/dev/DEVIATIONS.md](../docs/dev/DEVIATIONS.md) DEV-026，实施记录见 [docs/dev/PROGRESS.md](../docs/dev/PROGRESS.md)。**下文 §一～§十是原方案原文，以设计篇 38 为准；§八 的 P0 条目已逐项标注完成情况。**
>
> 需求来源：[jooler/kepcup#3](https://github.com/jooler/kepcup/issues/3)「在对话中指挥一切」（提出人 jooler，2026-10-13）。
>
> 上游：
> - D58 对话内设置（[docs/design/18-inline-setup.md](../docs/design/18-inline-setup.md)）
> - D75 对话轮与任务分治（[docs/design/02-execution.md](../docs/design/02-execution.md)）
> - D80 定时提议卡（[schedule-nudges.md](schedule-nudges.md)）
> - D87 `present` / `ask_user`（[docs/design/32-bot-widgets.md](../docs/design/32-bot-widgets.md) §12）
> - D88 盘点 → 提议（[docs/design/37-bot-asset-handover.md](../docs/design/37-bot-asset-handover.md)）
> - 连接应用 / 扩展中心（[docs/design/29-connected-apps.md](../docs/design/29-connected-apps.md) §16）
> - 工具目录（[docs/dev/04-agent-runtime.md](../docs/dev/04-agent-runtime.md)）
>
> **修订说明（2026-10-13 重写）**：前一版把「应用」理解成连接应用（Notion / Linear），只设计了一个只读工具和一个 `app-setup` 失败 kind，与 issue 原意不符。本版保留已拍板的「方案 A：按需读取，不按设置项生成工具」，但做了以下调整：
>
> - 范围扩到 KepCup 自身的全部设置（设置弹框、扩展中心 / 连接中心、Bot 配置）；
> - 补上 Bot 直接修改的路径；
> - 把「设置能力都要能抽成卡片」作为一条硬约束；
> - 把渐进式披露落成具体的提示词与工具形态。
>
> 前一版的改动清单与待确认项作废。

## 一、目标（按 issue 原意）

issue 原文的要点：设置页与连接中心操作多，学习成本高；用户在对话中产生具体需求时，Bot 先检查应用能力，再决定执行哪些操作，把操作以卡片形式呈现在对话里，用户只承担一次填写；应用的所有配置都要以工具形式暴露给模型，Bot 在合适时机按需读取，不能把所有能力说明都塞进提示词。

由此得出五条目标，后文的设计逐条对应：

1. **两条落地路径**：用户的需求要改设置才能实现时，Bot 二选一：
   - **直接改**：低风险、可撤销的项，由宿主执行并留下回执卡，可一键撤销；
   - **出设置卡**：需要用户确认、填写或授权的项，在对话里出预填好的卡片，用户操作一次即可。
2. **所有设置能力都能成卡**：设置弹框、扩展中心（Skills / 连接 / MCP / 邮件）、Bot 配置面板、群设置、项目设置提供的每一项设置，都要能在对话里以卡片形式出现。卡片和设置页是**同一个组件、同一批保存服务**（D58 原则），不做简化版平行表单。
   - 「成卡」分两级：
     - **内嵌卡**：设置组件直接嵌在对话里；
     - **跳转卡**：卡片带深链，直达设置页对应位置。
   - 能内嵌的尽量内嵌，暂时做不了的先给跳转卡。复杂的开发者配置（自定义 MCP、OAuth 客户端）和只读的诊断永久只给跳转卡。
   - 删除类破坏性动作不算「设置」，不成卡（§九）。
3. **按需触发**：卡片只在 Bot 判断需要时出现，不做启动时的集中教育，也不常驻。
4. **提示词只留一句话**：常驻提示词只有一条简短规则，告诉 Bot 有这套能力、何时去查。
5. **渐进式披露**：先概览、再搜索、再读详情、最后执行，逐层展开。每一层只返回下一步需要的信息。

## 二、现状（代码锚点）

| 部分 | 位置 | 现状与可复用点 |
| ---- | ---- | ---- |
| 设置数据 | `packages/shared/src/domain/types.ts` 的 `settingsSchema`；RPC 合约在 `packages/shared/src/rpc/methods.ts`，`settings.update` 的输入是严格白名单 | 有三个现成的缺口：<br>• `settings.update` 不带版本或期望值；`capabilityModels`、`webSearch`、`agents`、`mcpServers` 都是整对象覆盖<br>• `rpc/events.ts` **没有 `settings.changed` 事件**，现有的只有 `bot.updated`、`unattended.changed`、`skills.changed`、`mail.account_updated`<br>• 主题、语言、麦克风等存在渲染层 localStorage，core 看不到<br><br>全局设置大多走 `settings.update`，但有不少例外：<br>• 无人值守走 `unattended.enable/disable`<br>• 浏览器资料走 `browserProfiles.*`<br>• 向量走 `embedding.configure`<br>• 预算走 `budget.update`<br>• 密钥走 `providers.setKey`、`websearch.setKey`、`mcp.setSecret`，不进 settings<br>• Bot 配置走 `bots.update`<br>• 项目配置走 `projects.update`<br>• 群配置走 `groups.*` |
| 设置界面 | `features/settings/`（14 个分区，深链 `shell.openSettings(section, anchor)`，锚点 `data-settings-anchor`）；`features/extension-center/`（skills / connections / mcp / mail）；`features/right-panel/`（Bot 详情各 Tab）；`GroupSettingsDialog`、`ProjectSettingsDialog` | 设置散在约 25 个组件里。**已被 D58 卡片嵌用过**的组件如下，但 props 并不统一，而且**都不支持 `prefill`**：<br>• `ProviderSetupForm{onSaved}`（无 `embedded`）<br>• `ModelSelectField`：只是可绑定的下拉框，自己不保存<br>• `CapabilityModelSection{embedded,onSaved}`<br>• `WebSearchSection{embedded,onSaved}`<br>• `AgentCard{embedded,onTested}`（无 `onSaved`）<br>• `MailAccountAddForm{onSaved}`（无 `embedded`）<br>• `ConnectAppPanel{onDone}`<br>• `SensorCard{kind}`<br>• `SchedulesPanel`、`WatchesPanel`<br><br>**组件已存在、但没有任何嵌入用的 props**：General / Appearance、Embedding、BrowserProfiles、Unattended、Environment / Sandbox / Allowlist、Usage、BackgroundTasks、Developer / MCP、群 / 项目设置对话框。<br>`BotProfileForm` 没有自己的保存，由调用方保存 |
| 对话内设置卡 | `features/chats/SetupRequiredCard.svelte`（渲染在输入坞上方，同一时间只有一张）；`stores/chat.svelte.ts` 的 `pendingSetup` / `continueAfterSetup` / `dismissSetupCard` | 两个来源：发送门禁（`pendingSetup`）和失败续跑（「失败 → 出卡 → `runs.retry`」），都用于「缺配置、等用户补上」。kind 共 7 种：`main-model`、`capability-model`、`web-search`、`agent`、`connect-app`、`confirm-local-connector`、`mail-account`。每加一种设置都要改 shared 契约，并在卡片里加一个分支 |
| 失败续跑链 | `dispatch/orchestrator.ts` 中 `setupHit` → `tool_result` 看到 `SETUP_REQUIRED` → 延后一拍 abort → settle `failed` + `run.setup` | 适合「任务做到一半发现缺配置」，不适合「用户直接要求改设置」：后者没有失败的事可以重试 |
| 消息流内的提议卡先例 | D80 `offer_schedule`（`system_event: schedule_offer`，用户点「设置」后宿主确定性执行，不唤醒 Bot，7 天内被拒 2 次后宿主拒绝再提议）<br>`propose_profile_change`（对话轮内不阻塞，审查 M4）<br>D88 `propose_handover`<br>`ask_user` 表单（任务阶段，阻塞等待） | 「Bot 提议 → 卡片 → 用户一次确认 → 宿主执行」已经跑通多次。审批相关在 `permissions/approvals.ts`：<br>• `submitNonBlocking`：不阻塞<br>• `request`：阻塞<br>• `NEVER_AUTO_DECIDED`：无人值守也不自动批 |
| 渐进式披露先例 | 技能：提示词只列名字和一句描述，正文用 `read` 读 SKILL.md<br>`app_search_tools` / `app_call_tool`<br>`app_local_connector_guide` → `app_propose_local_connector`（先读手册，再走卡片执行）<br>`inspect_bot_assets` → `propose_handover`（「key 只能用这里返回的」） | 「盘点 / 搜索 → 读详情 → 提议」有现成的写法和工具描述措辞，可以照搬 |
| 提示词装配 | `agent/context/system-prompt.ts`：`TURN_PLATFORM_RULES` / `PLATFORM_RULES` 是编号规则，`section()` 遇空体就省略；条件规则按提示词的输入门控：`APP_REQUEST_CONNECTION_RULE` 看 `connectedApps` / `availableApps` 是否非空，`mailRequestSetupRule(isButler)` 看 `hasMail`；ACP 侧 `AGENT_PLATFORM_RULES` 按规则所需的 `tools` 门控 | 新规则需要新增一个输入标志（如 `hasSettingsTools`），与工具是否注册保持一致 |
| 触发源与污点 | `triggerReasonSchema`：`direct`、`mention`、`broadcast`、`reply`、`chain`、`scheduled`、`event`、`background`、`delegation`、`task`、`watch`、`mail`<br>D73 污点：按（Bot, 对话）计，目前只有 `app_*` 读取会置污点（`apps/taint.ts`） | `mention`、`reply`、`chain` 在群聊里可能来自其他 Bot；`web_fetch`、`mail_read`、浏览器快照、MCP 读取都不会置污点，所以污点不能单独作为注入防线 |
| 工具注册 | `tools/index.ts` 的 `buildResponseTools`：按 facade 是否存在注册，再按 `loopType` 分出 turn / task 两个面 | 对话轮只读，但允许异步托管动作（`schedule` / `offer_schedule` / `watch_create` / `remember`），由宿主确定性执行 |
| 修改配置的现有工具 | 目前没有任何 Bot 工具写 `settings` 或厂商配置；只有桌面端的设置卡会写 | Bot 侧的「改设置」能力是全新的面 |
| 密钥 | `SecretsService` 只经 `getValue` 取值，没有任何 RPC 返回密钥，`redact()` 用于脱敏；提示词已有「不要让用户贴令牌 / 密钥」 | 密钥只在卡片表单里填，永不进模型上下文。这条在新设计里写成硬约束 |

## 三、方案总览

**沿用已拍板的方案 A，否决方案 B（每个设置项一个工具）**：

- 方案 B 的工具面会随设置项线性膨胀，与 `app_search_tools` 那种超阈值不内联的做法背道而驰；
- 设置项名称还会与 `app_{slug}_{tool}` 碰撞。

方案 A 在本版落成「一份设置目录 + 三个通用工具 + 一个通用卡片宿主」：

```
用户需求 ──► Bot（提示词里只有一句规则）
              │
              ├─ settings_search(query?)        概览 / 按需求搜索 → 设置项 id、当前状态、能做什么
              ├─ settings_read(id)              某一项的字段、当前值（脱敏）、可选值、修改方式
              └─ settings_change(id, values?, reason)
                    │  修改方式由宿主按目录 + 上下文裁定，Bot 不能自选
                    ├─ direct  → 宿主立即执行 → 回执卡（显示旧值→新值，可「撤销」）
                    ├─ confirm → 预填卡（显示旧值→新值，「应用 / 不用了」）
                    ├─ form      → 待填卡（密钥 / OAuth / 账号由用户自己填，Bot 只能预填非敏感字段）
                    ├─ user-only → 安全开关卡（Bot 可以出卡但不能预填，必须由用户亲手操作）
                    └─ link      → 跳转卡（该项暂未组件化，「在设置中打开」深链到对应锚点）
```

几条关键判断：

- **设置目录是唯一事实来源**：每个设置项的 id、作用、范围、读取方式、写入方式、风险档、卡片组件、深链锚点都写在一份纯数据目录里。工具、卡片、提示词、覆盖率测试都从这里读，不做第二份清单。前一版提议「挂在连接目录条目上」是错的：连接目录只描述第三方连接器，不描述 KepCup 自身的设置。
- **修改方式由宿主裁定**：Bot 只表达「想把 X 改成 Y」，风险分档由目录和上下文（是谁触发的、本 run 是否读过网页或邮件等不可信内容、是不是群聊）决定。这样提示词不需要教模型风险分档。
- **卡片 = 设置页组件**：卡片宿主按目录里的 `card` 键找对应组件渲染。还没组件化的项先用 `link` 档兜底，**第一天就能覆盖全部设置项**；之后逐项把 `link` 升级为内嵌组件。这就是「所有设置能力都能抽离为卡片」的落地路径。
- **两条触发链并存，不互相替代**：
  - **提议链（新）**：用户主动要求、或 Bot 判断需要改设置。卡片是消息流里的一张卡，不会让 run 失败。
  - **失败续跑链（D58 原有）**：任务执行中撞上缺配置（例如 `generate_image` 未配置能力）。仍然是失败 → 出卡 → `runs.retry`。新增的设置项改用通用 kind `{kind:'setting', itemId, …}`（§六），以后加设置项不再改契约；原有的 7 个 kind 到 P2 再收拢。

## 四、设置目录（Settings Catalog）

### 4.1 形态与位置

- 位置：`packages/shared/src/settings-catalog/`，纯数据、可单测，写法同 `HOST_CAPABILITIES`。条目带 zod 字段 schema，不引 UI 依赖。
- 条目结构（示意）：

```ts
interface SettingItem {
  id: string;                 // 稳定 id，如 'models.default-main' / 'bot.model' / 'search.provider'
  group: SettingGroup;        // models | search | connections | mail | agents | bot | browser | hardware | general | unattended | environment | developer …
  title: string; summary: string;     // 一句人话：它决定什么
  enables: string[];          // 它让 Bot 能做什么（供搜索与「检查能力」：'生成图片'、'联网检索'、'读写 Notion' …）
  keywords: string[];
  scope: 'global' | 'bot' | 'group' | 'project';
  owner: 'core' | 'renderer'; // renderer：主题、语言、麦克风等只存在渲染层 localStorage 的项，core 读不到也写不了 → settings_read 报「状态未知（只在本机界面可见）」，只能出卡
  fields: FieldSpec[];        // name / label / type（text|number|select|toggle|model|secret|oauth|account）/ options 来源 / 是否敏感
  write: {
    maxMode: 'direct' | 'confirm' | 'form' | 'user-only' | 'link';   // 这一项最宽松能到哪一档（宿主还会再收紧，§5.3）；'direct' 只允许出现在白名单 DIRECT_ITEM_IDS 里的条目上（§5.3）
    via: 'catalog' | { tool: string };  // 已有专门工具的项指向该工具（schedule / watch_create / install_skill / request_access / app_request_connection / mail_request_setup / propose_profile_change）；对这类项 settings_change 只回「请改用某工具」，不代为调用，避免绕过各工具自己的门控
  };
  card: CardKey | null;       // 渲染层组件键；null = 暂无内嵌组件，只能出 link
  deepLink: { surface: 'settings' | 'extension-center' | 'bot-panel'; section: string; anchor?: string };
}
```

- core 侧每个条目配一个**适配器**（读 / 写 / 撤销），做法同 D88 的资产适配器：
  - **读**：返回脱敏后的当前状态，包括「已配置 / 未配置 / 部分可用」、选中的模型、开关值。永不返回密钥，用户自填的名称一律过 `sanitizeDisplayText`。
  - **写**：调用设置页用的同一批 core 服务方法，并做**条目粒度的 CAS**。
    - `settings.update` 现在不带期望值，而且 `capabilityModels`、`webSearch`、`agents`、`mcpServers` 是整对象覆盖。
    - 所以适配器要在 core 的设置写锁内「读 → 只比对并改本条目的字段 → 写回」，不发整对象，避免撤销或过期卡覆盖兄弟字段的并发修改。
    - 渲染层卡片保存也走这个适配器：新增 RPC `settings.items.apply{itemId, values, expected}`。设置页原有保存路径不变，两者落到同一个 core 服务。
  - **广播**：写成功后发 `settings.changed{itemIds}` 事件（新增）。渲染层的 `settingsStore` 和打开着的设置弹框据此刷新；设置页原有的保存路径也补发这个事件。
  - **撤销**：用回执卡里保存的旧值，经同一套 CAS 写回。
- 渲染层维护 `CardKey → Svelte 组件` 映射，由通用卡片宿主 `SettingCard` 分发。

### 4.2 覆盖范围与首批分档（P0 实现前逐项复核）

| 组 | 设置项（示例） | 范围 | 最宽松档 | 卡片组件 |
| ---- | ---- | ---- | ---- | ---- |
| 模型 | 默认主 / 轻量模型（在已配置厂商内选） | 全局 | direct | 新建 `DefaultModelsCard`（包住 `ModelSelectField` 并自带保存） |
| 模型 | 厂商 Key | 全局 | form | `ProviderSetupForm` |
| 模型 | 能力模型 ×7（向量 / 重排 / 多模态 / ASR / TTS / 图像 / 视频） | 全局 | confirm（换模型）/ form（缺 Key） | `CapabilityModelSection` |
| 模型 | 本地向量（下载） | 全局 | confirm | `EmbeddingSection`（待加嵌入 props） |
| 联网 | 检索供应商 + Key | 全局 | confirm / form | `WebSearchSection` |
| 连接 | 连接应用、重连、授权给本 Bot | 全局 / Bot | form（OAuth） | `ConnectAppPanel`（经 `app_request_connection`） |
| 连接 | 某连接的逐工具策略（收紧） | 全局 | confirm | `AppConnectionDetail` 片段（待加嵌入 props） |
| 邮件 | 添加邮箱并绑定本 Bot | 全局 / Bot | 经 `mail_request_setup` | 已有（`MailAccountAddForm`） |
| 外部智能体 | 启用、登录、选默认 | 全局 | form | `AgentCard`（补 `onSaved`） |
| Bot | 本 Bot 的模型 / 轻量模型 | Bot | direct | `BotProfileForm` 的模型片段（卡片自带 `bots.update`） |
| Bot | 本 Bot 的浏览器资料、网络策略 | Bot | confirm（放宽网络为 user-only） | `BotProfileForm` 片段 |
| Bot | 本 Bot 挂载的 MCP / 连接 / 技能启停 | Bot | confirm（放宽权限永不直改） | `BotProfileForm` 片段 / `SkillsTab` |
| Bot | 身份、人设、职责、边界 | Bot | 经 `propose_profile_change` | 已有 |
| 技能 | 安装预置技能 | Bot | 经 `install_skill` | 已有 |
| 定时 / 监看 | 新建、取消 | 对话 | 经 `schedule` / `offer_schedule` / `watch_*` | 已有 |
| 用户画像 | 关于用户的事实 | 全局 | link（改写走设置页「用户画像」） | link |
| 群 | 群名、成员增减 | 群 | confirm | `GroupSettingsDialog` 片段（待加嵌入 props） |
| 项目 | 保护规则（denyRead / denyWrite）、放行端口 | 项目 | **user-only** | `ProjectSettingsDialog` 片段 |
| 硬件 | 麦克风 / 摄像头开关与设备 | 渲染层 | confirm | `SensorCard{kind}` |
| 通用 | 主题、语言（渲染层）、开机启动（全局） | 渲染层 / 全局 | confirm | `AppearanceSection` / `GeneralSection`（待加嵌入 props） |
| 后台 | 后台任务智能体、预算 | 全局 | confirm | `BackgroundTasksSection` / 用量预算（待加嵌入 props） |
| 无人值守 | 开启（时段 + 风险确认）/ 关闭 | 全局 | **user-only**（开启）/ confirm（关闭） | `UnattendedSection`（待加嵌入 props） |
| 环境 | 工具链、沙箱、访问白名单 | 全局 | **user-only** | 先出跳转卡，组件嵌入化后改出 user-only 卡 |
| 开发者 | 自定义 MCP、OAuth 客户端、`.mcpb` 安装 | 全局 | **link**（永久） | 只出跳转卡 |
| 诊断 / 用量 | 只读 | 全局 | 只读（概要），不可写 | 只出跳转卡 |

**明确不纳入**的是删除类动作：删 Bot、删会话、删浏览器资料、断开连接、通讯录里的删除。它们是破坏性操作，不是「设置」，沿用原有入口和二次确认，目录里不出现，在排除表里写明理由。

### 4.3 覆盖率约束（让「全部能成卡」可验证）

- 测试一：以下设置界面上的每个位置，都必须对应至少一个目录条目，或者在显式排除表里写明理由：
  - 每个 `data-settings-anchor`；
  - 扩展中心的每个页签；
  - Bot 面板的每个 Tab；
  - 群设置、项目设置对话框（给它们补上锚点）。

  新增设置分区时，不登记就过不了测试。
- 测试二：每个 `card !== null` 的条目，在渲染层映射里必须有对应组件。每个条目的 `deepLink` 都必须指向真实存在的锚点（顺手修掉只在测试里出现的 `models-default` 这类死锚点）。
- 测试三：`maxMode = 'direct'` 的条目必须在 `DIRECT_ITEM_IDS` 白名单里（§5.3），防止有人加条目时顺手放宽。

## 五、Bot 侧：提示词与渐进式披露

### 5.1 常驻提示词（只此一条，工具注入时才出现）

追加到 `TURN_PLATFORM_RULES` 与 `PLATFORM_RULES`。新增提示词输入 `hasSettingsTools`，与这三个工具是否注册同源；为假时整条规则不出现，ACP 侧按 `AGENT_PLATFORM_RULES` 的 `tools` 门控：

> 用户的需求要调整 KepCup 的设置（模型、联网、连接、邮箱、外部智能体、你自己的配置等）才能实现，或你不确定应用当前能不能做时：先用 settings_search 查，再用 settings_read 看清楚，最后用 settings_change 修改或请用户在卡片里完成；不要让用户自己去设置页找，也不要让用户把密钥、密码贴进聊天。

**不在提示词里列设置项**。`<connected_apps>`、`<available_apps>`、`<mail_accounts>` 等现有段落保持不变，因为它们是能力清单，不是设置说明。

### 5.2 三个工具（对话轮与任务都注册）

| 工具 | 层次 | 输入 | 返回（上限） |
| ---- | ---- | ---- | ---- |
| `settings_search` | 概览 / 检索 | `query?`；也可以按需求描述来搜，如「生成图片」「读我的邮件」 | 无 query：各组的就绪概况，每组一行，例如「模型：主模型已配；图像能力未配」。<br>有 query：≤10 个条目，每条含 `id`、标题、一句作用、当前状态、可用的最宽松档。<br>≤2KB |
| `settings_read` | 详情 | `id`（目录 id 固定且不涉密，不要求先 search；未知 id 返回最接近的几个候选） | 字段说明、当前值（脱敏）、可选值（例如已配置厂商下的可选模型，≤30 个）、本次上下文里实际可用的档位，以及原因（例如「群聊中只能出卡」）。<br>`via` 指向专门工具的项，直接告诉 Bot 改用哪个工具。<br>≤4KB |
| `settings_change` | 执行 | `id`、`values?`（只含非敏感字段）、`reason`（一句话，显示在卡片上）、`required?`（仅任务：没有这项设置任务就做不下去） | 结果档位与人话结果，例如：「已改为 X，用户可在回执卡上撤销」「已出设置卡，等用户完成；完成后你会收到通知」。<br>以下两种情况直接拒绝并说明原因：<br>• `values` 里出现敏感字段<br>• 条目是 `via` 专门工具的项（回「请改用某工具」） |

- 这三个工具都属于异步托管动作，符合 D75「对话轮只读、写操作由宿主确定性执行」的口径，与 `schedule` / `offer_schedule` 同类。
- **工具描述只写用法，不写设置清单**。三个描述加起来控制在约 600 字以内。
- 现有专门工具（`app_request_connection`、`mail_request_setup`、`install_skill`、`request_access`、`schedule`、`watch_create`、`propose_profile_change`）不动，它们的规则也不动。目录条目通过 `via` 指向它们：`settings_read` 告诉 Bot 改用哪个工具，`settings_change` 只重定向、不代为调用。这样各工具自己的门控（例如 `request_access` 只在任务里注册）和审批不会被绕过。连接 / 邮箱的规则是否合并进新的那条规则，放到 P2 再评估（§八）。

### 5.3 宿主裁定修改档位（确定性，Bot 无法绕过）

**direct 白名单（已定）**：只有下面两组条目允许 direct，由 shared 常量 `DIRECT_ITEM_IDS` 固定，目录测试强制检查（§4.3 测试三）：

- 默认主 / 轻量模型：只能在已配置 Key 的厂商里选；要新增厂商时走 form；
- 本 Bot 的模型 / 轻量模型。

其余条目一律出卡。外观、语言、麦克风这类渲染层的项，core 写不了，按下面第 6 条最多 confirm。

最终档位 = 条目的 `maxMode`，再按下列条件逐级收紧（只会变严，不会变宽）：

1. **触发源白名单**：只有下列两种情况才允许 direct，其余一律至少 confirm：
   - `triggerReason = 'direct'`；
   - `triggerReason` 为 `mention` / `reply`，且触发消息的发送者是用户本人。

   被排除的包括 `scheduled`、`event`、`watch`、`mail`、`delegation`、`task`、`chain`、`broadcast`、`background`、其他 Bot 发出的 `mention` / `reply`，以及组件回传的消息（`origin: 'widget'`）。
2. **本 run 读过不可信内容** → 至少 confirm。不可信内容包括 `web_fetch`、`mail_read` / `mail_search`、浏览器快照、MCP / 连接应用的读取、附件正文。
   - 宿主按 run 记一个「已接触不可信内容」标志，与 D73 污点（按（Bot, 对话）计）取并集。
   - 污点目前只由 `app_*` 读取设置，单靠它防不住网页、邮件里的注入。
3. **群聊**（已定）→ 至少 confirm：群聊里只能出卡，不能直接改。
4. **改的是别的 Bot 的配置**：普通 Bot 拒绝；管家允许出卡（confirm），不允许直改。与 D88 口径一致。
5. **放宽权限或安全边界**（新增连接授权、MCP、网络放开、关闭污点防护、开启无人值守等） → 永不 direct。
   - 涉及安全开关的项为 **user-only（已定）**，包括开启无人值守、沙箱、访问白名单、项目保护规则、放开 Bot 网络策略。
   - Bot 可以主动出这类卡，但宿主**不采用 `values`**：工具返回会说明「此项由用户亲手设置，已出空白卡」，卡上只显示 Bot 的 `reason` 和组件的初始状态。风险确认之类的步骤全部保留在组件里。
   - 组件尚未嵌入化的 user-only 项，先出跳转卡。
6. **owner 为 renderer** → 最多 confirm，因为 core 写不了，只能交给渲染层的卡来写。
7. **ACP 外部智能体**（已定）：新增能力包 `settings`，默认只注入 `settings_search` / `settings_read`；`settings_change` 默认不注入，按 Bot 在能力包选项里单独开启。开启后同样受本节全部规则约束。
8. **无人值守**：设置卡是 `system_event`，不是审批，本来就不会被自动批准；它只能由用户点击结算，过期标 `expired`。无人值守期间的 run 由定时、事件等唤醒，第 1 条已经把它们收紧到 confirm，所以无人值守下不会发生 direct 修改。

direct 档执行后必出**回执卡**，内容是「旧值 → 新值」，带「撤销」按钮，24 小时内有效。撤销走与修改相同的条目级 CAS：如果当前值已经不是新值，就提示冲突并且不覆盖。撤销成功后卡片状态写 `reverted`，并在 Bot 的上下文回放里留一行「用户撤销了 X」，但不唤醒 Bot：撤销本身已经表明用户的意愿，不需要 Bot 再回应。

## 六、对话内卡片

### 6.1 卡片宿主与消息形态

- 新的消息形态：`system_event`，事件名 `setting_card`；内容是 `{itemId, mode, proposed, before, reason, state}`。`state` 取 `pending | applied | dismissed | superseded | expired | reverted`，写回方式同 `schedule_offer`。卡片留在消息流里：历史可追溯，同一对话可以并存多张卡。这一点不同于 D58 那张只在输入坞上方出现的单张卡；D58 那张是「失败等待」用的，单张合理。
- 设置卡**不是审批**，不进 approvals 表，也不受无人值守自动决定的影响。D58 的失败续跑卡沿用原样。
- `SettingCard` 按 `card` 键分发到设置页组件，组件统一需要的 props（现有组件都不齐，要逐个补，见 §八 P0）：
  - `embedded`：紧凑形态，隐藏分区标题；
  - `prefill`：Bot 给的非敏感预填值；
  - `onSaved`：保存后回调。
- 没有内嵌组件的项（link 档）卡片只显示「在设置中打开」。它通过 `shell.openSettings(section, anchor)` / `openExtensionCenter(tab)` 深链跳转；窄屏走 D82 的路由。用户在设置页保存后，卡片监听新增的 `settings.changed{itemIds}` 事件，把自己标成 `applied`。渲染层的项（core 看不到）和只读项，改由用户在卡上点「我已设置好」，宿主能核对的就用适配器核对一次。
- confirm 卡展示「当前 → 建议」的对比，用户可以在卡上改值后再「应用」，即同一个组件的可编辑形态。保存走 `settings.items.apply` 的条目级 CAS：如果当前值在出卡之后变过，卡片提示「设置已在别处修改」，刷新对比后再让用户确认。
- 防刷屏：
  - 每个 run 最多 3 张设置卡；
  - 同一对话里同一项只保留最新一张 pending 卡，旧卡标 `superseded`；
  - 同一 Bot 在同一对话里对同一项 7 天内被拒 2 次后，宿主拒绝再出卡。这条参照 D80 改写：D80 是按 Bot 和对话计次，不区分提议内容；这里改成按条目计次。

### 6.2 卡片完成后 Bot 怎么继续

- **提议链**（对话轮发出的卡；**已定：唤醒**）：用户「应用」或「不用了」之后，宿主写一条一次性内部事件 `setting_card_resolved`，唤醒该 Bot 的对话轮。这一点有意不同于 D80 定时提议卡的「不唤醒」：定时卡点了就算办完，设置卡只是用户原始需求的前置步骤。事件内容是「用户已应用：X（旧→新）」或「用户没有修改 X」。Bot 据此继续处理用户原来的请求，或者给出替代方案。每张卡只通知一次。做法同 D58 的 `task_setup_dismissed`。
- **失败续跑链**（任务内撞上缺配置）：维持 D58 不变，即失败 → 卡片 → `continueAfterSetup` → `runs.retry`。同时在 `setupRequirementSchema` 里新增通用 kind `{kind:'setting', itemId, prefill?, reason}`，`SetupRequiredCard` 遇到这个 kind 时复用 `SettingCard` 的分发逻辑。
  - 任务里调 `settings_change` 得到 confirm / form 档时：
    - 带 `required: true`：返回 `SETUP_REQUIRED`，走失败续跑链；
    - 否则：发一张不阻塞的卡，任务继续往下跑。

    工具描述只写这一句判断。
  - 已有的 7 个 kind 先不迁移，等它们各自的卡片换成 `SettingCard` 分发之后再逐个收拢（P2）。

## 七、安全与边界（硬约束）

- **密钥永不经模型**：
  - 目录里 `type: secret | oauth | account` 的字段只能由用户在卡片里填；
  - `settings_change` 的 `values` 带上这类字段就拒绝；
  - `settings_read` 只返回「已配置 / 未配置」。
- **读也要脱敏**：不返回本机路径、日志、用户画像原文。诊断只返回概要，例如「沙箱不可用：缺 bubblewrap」。
- **注入防护靠宿主裁定，不靠提示词**（§5.3 的 1、2、5、8 条）。
- **审计**：每次改动都在消息流里留下回执卡或设置卡，包含谁、在哪个对话、旧值到新值。P0 不新建表；如果之后需要跨对话查「谁改过什么」，再考虑加 `setting_changes` 表。
- **不做「先检查再执行」的硬门禁**：Bot 在执行前先检查能力仍然是提示词纪律。缺配置时的确定性兜底，仍由各工具入口自己检查（媒体网关、联网检索、连接、邮件），走失败续跑链。

## 八、拆分步骤

- **P0：骨架 + D58 已嵌用过的组件**（✅ 已实现，待审查收口；下面逐项标 ✅ / ⏳）
  - shared：
    - ✅ 设置目录：§4.2 全部条目一次登记齐。P0 只把 D58 用过的组件升级为内嵌卡，其余先登记为 link 档；（实际 58 条、9 个卡片键）
    - ✅ `setting_card` 事件 schema（另有 `setting_card_resolved`）；
    - ✅ `setupRequirementSchema` 增加 `kind:'setting'`；
    - ✅ 事件 `settings.changed{itemIds}`；
    - ✅ RPC `settings.items.apply{itemId, values, expected}`（另有 `settings.cards.dismiss/complete/undo`，`apply` 增 `target?` / `messageId?`）。
  - core：
    - ✅ 目录适配器（读 / 写 / 撤销）：在设置写锁内做条目级 CAS，写成功后发 `settings.changed`；设置页原有的保存路径也补发这个事件；
    - ✅ `settings_search` / `settings_read` / `settings_change`（`settings_read` / `settings_change` 增 `bot_id`）；
    - ✅ 档位裁定（§5.3），包括按 run 记录的「已接触不可信内容」标志；
    - ✅ 卡片状态写回；
    - ✅ `setting_card_resolved` 唤醒对话轮；
    - ✅ 提示词规则 + 输入标志 `hasSettingsTools`；
    - ✅ ACP 能力包 `settings`（`settings:change` 选项）。
  - desktop：
    - ✅ `SettingCard` 宿主与组件映射；
    - ✅ 组件 props 补齐，统一为 `embedded` / `prefill` / `onSaved`：
      - `ProviderSetupForm`：补 `embedded`、`prefill`；
      - `CapabilityModelSection`、`WebSearchSection`：补 `prefill`；
      - `AgentCard`：补 `onSaved`、`prefill`；
      - `ConnectAppPanel`：`onDone` 适配成 `onSaved`；
      - `SensorCard`：补 `embedded`、`onSaved`；
      - 新建 `DefaultModelsCard`（包住 `ModelSelectField` 并自带保存）和 Bot 模型片段卡（自带 `bots.update`）；
    - ✅ `settingsStore` 订阅 `settings.changed`；
    - ✅ 回执卡 + 撤销；
    - ✅ link 卡 + 设置变化回写 `applied`。
  - 测试：
    - ✅ 覆盖率测试（§4.3）；
    - ✅ 档位裁定单测，矩阵为触发源（含其他 Bot 的 mention / reply）× 不可信内容 / 污点 × 群聊 × 跨 Bot × 放宽权限；
    - ✅ 条目级 CAS 单测：撤销不覆盖兄弟字段的并发修改；
    - ✅ 集成测试（八个场景全部覆盖，`packages/core/test/integration/settings-cards.test.ts`）：
      - 「换个默认模型」走 direct，生成回执卡，撤销能复原；
      - 「我想让你帮我生成图片」：search 发现图像能力未配 → form 卡 → 用户应用 → 对话轮被唤醒后接着生成；
      - 邮件唤醒的轮次请求改设置，被收紧到 confirm；用户触发的轮次先 `web_fetch` 后改设置，同样被收紧到 confirm；
      - 群聊里请求修改白名单项，被收紧到 confirm；
      - 请求「开启无人值守」时出 user-only 空白卡，Bot 给的 `values` 不被采用；
      - ACP 智能体默认没有 `settings_change`；
    - ✅ e2e 一条，覆盖卡片 → 应用 → Bot 续答（`apps/desktop/test/e2e/setting-card.spec.ts`，另含 direct 回执撤销）。
- **P1：组件化扩面**（⏳ 未开工；完整的条目级清单见设计篇 38 §10），按用户价值排序，每做完一个就把对应条目从 link 升级为内嵌卡片：
  - `BotProfileForm` 其余片段（浏览器资料 / 网络 / MCP / 连接 / 技能，卡片自带 `bots.update`）
  - `EmbeddingSection`
  - `UnattendedSection`
  - 渲染层的 `AppearanceSection` / `GeneralSection`
  - `BackgroundTasksSection` 与用量预算
  - 群设置、项目设置片段
  - `AppConnectionDetail` 的工具策略片段
  - 这些组件都已存在，做法同 D58：只加 `embedded` / `prefill` / `onSaved` props，设置页的行为不变。
- **P2：收拢**（⏳ 未开工）
  - D58 的 7 个旧 kind 改由 `SettingCard` 分发；
  - 评估把 `APP_REQUEST_CONNECTION_RULE` / `MAIL_REQUEST_SETUP_RULE` 并入新规则，以减少常驻提示词；
  - 评估设置页各分区直接由「目录卡片」组成，让卡片成为设置的唯一渲染单元。
- **文档**（✅ 已写回）：
  - 新设计篇 `docs/design/38-conversational-settings.md`（决策 D89；编号在合并时以最后一个空号为准）；
  - 回写 design/18（通用 `setting` kind）、design/02 与 design/30（工具面）、`docs/dev/04-agent-runtime.md`（工具目录）、`docs/dev/03-data-model.md`（`setting_card` / `setting_card_resolved` 内容形状）、design README 索引与决策行、PROGRESS 与 DEVIATIONS（DEV-026）。

## 九、非目标

- 不做「每个设置项一个工具」（方案 B），提示词里也不列设置清单。
- 不把删除类、破坏性操作纳入目录。
- 不让模型接触任何密钥、令牌或密码，也不提供「把 Key 告诉我，我帮你填」这类路径。
- 不改扩展中心 X5 的逐家适配。连接目录仍是第三方连接器的事实来源，设置目录只引用它，不复制。
- 不改 D58 已验收的行为（发送门禁、7 个 kind 的卡片），P2 之前只做增量。

## 十、已定决策（2026-10-13，用户全部采纳建议）

| # | 决策 | 落在 |
| ---- | ---- | ---- |
| 1 | direct 白名单只有两组：默认主 / 轻量模型（限已配置厂商）、本 Bot 的模型 / 轻量模型；其余一律出卡，渲染层的项最多 confirm | §4.1 `maxMode` 注释、§4.3 测试三、§5.3 白名单 |
| 2 | 设置卡应用或拒绝后唤醒 Bot 续答，每张卡一次；撤销回执卡不唤醒 | §6.2、§5.3 回执卡、§八 P0 |
| 3 | 群聊里只能出卡；ACP 外部智能体默认只读，按 Bot 单独开启 `settings_change` | §5.3 第 3、7 条 |
| 4 | user-only 项（开启无人值守、沙箱、白名单、项目保护规则、放开网络）：Bot 可主动出卡，但不预填，由用户亲手操作 | §三 示意图、§5.3 第 5 条、§4.2 |
