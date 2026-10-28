# P2 · 注入模型：Bot / 项目组以插件为单位

> 状态：待实施。依赖：P1。分支：`feat/plugins-platform/p2-injection`。
> 必读：[README.md](README.md) §2.4；[CURRENT-STATE.md](CURRENT-STATE.md) §2；
> 源码 `packages/core/src/skills/registry.ts`（`listForBot`）、`packages/core/src/mcp/service.ts`（`serversForBot`）、
> `packages/core/src/apps/exposure.ts`、`packages/core/src/dispatch/orchestrator.ts`（`#capabilityCatalog`、
> 提示词组装）、`packages/core/src/tools/mail-tools.ts`（`mailBoundFor`）、
> `apps/desktop/src/renderer/src/lib/features/bot-panel/BotProfileForm.svelte`、
> `apps/desktop/src/renderer/src/lib/features/right-panel/BotMenu.svelte`、
> `apps/desktop/src/renderer/src/lib/features/project/ProjectSettingsPage.svelte`。

## 1. 目标

交付后：Bot 详情有一个「插件」区块（已装插件列表 + 启用开关 + 展开细选），项目组设置有「插件」分区；
运行时全部能力注入点按「有效启用集」过滤——**未启用的插件，其一切能力（技能 / MCP 工具 / 连接工具 /
邮箱工具）对该 Bot 不可见**；安装插件不再默认影响任何 Bot（显式添加制）。
渲染端类别标签完成「协议不可见」改造（`mcp` 显示「工具」）。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| `profile.runtime.plugin_ids`、`project_plugins` 表、`effective` 启用集 | 卡片配置 / 实例 UI（P4） |
| skills / mcp / connections / mail / 外部智能体能力包五处装配过滤 | 工具实现与审批 / 风险语义（一字不改） |
| `plugins.setBotPlugins`、`projects.plugins.set` RPC | 安装引导弹框（P4） |
| BotProfileForm「插件」区块重构（apps/mcp/mail 三区块收编） | InkCop 区块（保留独立，仅移位） |
| 项目组设置「插件」分区 | 项目级实例授权（明确不做：实例细选永远在 Bot 级） |

## 3. 语义规范（本阶段的设计核心，实现必须逐条对照）

1. **启用集**：`effective(botId, conversationId) = profile.runtime.plugin_ids ∪ (conversation 为项目会话 ? project_plugins(conversationId) : ∅)`。
   `plugin_ids` 缺失 / 空 = 未启用任何插件。插件已卸载的 id 无效（读时容忍、写时校验存在）。
2. **skills**：`listForBot(botId, extraPluginIds?)` 增加第二参（项目会话传入项目授权集）。
   公共技能行按 `skill_library.source_url` 判属主插件（`parsePluginSkillSource`）：属主 ∈ 启用集才入选；
   无 `plugin://` 标记的公共技能视为系统技能恒入选。`<skills>` 段、沙箱 `readableDirs`、
   技能活动列表同源过滤。Bot 私有技能不受任何影响。
3. **mcp**：`serversForBot(botId, extraPluginIds?)`：
   `server.source.kind === 'plugin'` → 只看其 `pluginId` ∈ 启用集（**不再要求**出现在 `mcp_server_ids`；
   `mcp_server_ids` 中插件 server 的历史勾选项读时忽略）；
   其他 server（手动 / mcpb 独立安装）→ 维持 `mcp_server_ids` 子集勾选不变（P4-M2 才实例化收编）。
4. **connections**：`app_connection_ids` 细选保留；其连接器贡献插件 ∉ 启用集 → 该连接不进能力目录、
   工具不挂载、`<available_apps>` 不列该插件目录条目、Bot 提案（`app_propose_local_connector` 之外的
   目录推荐）不推荐。已连接但插件被停用的账号在 UI 标「插件已停用」。
5. **mail**：`mailBoundFor(botId)` → `mailBoundFor(botId, extraPluginIds?)`：绑定存在 **且**
   账号所属插件 ∈ 启用集（P3 前 `instance_id` 为空的账号视为「系统账号」恒放行）。工具注册与
   `<mail_accounts>` 段同源。
6. **外部智能体能力包**：`HOST_CAPABILITIES` 动态包 `mcp` / `apps` 的前缀白名单按启用集
   （`serversForBot` / `forBot` 结果）计算，规则不变、来源变化。
7. **项目组授权**：只对「项目会话内的对话轮与任务」生效；桌面全局动作（如用户在扩展中心的操作）
   不受影响。`project_plugins` 写 RPC 校验 conversation 为 `type:'project'`。
8. **degrade 原则**：任何过滤实现不得改变工具的审批 / 风险 / 锁定 / 污点行为；本阶段全部改动是
   「哪些工具进得了装配」的**可见性**过滤。

## 4. 步骤

### 步骤 1：shared 契约

1. `types.ts` 的 `botRuntimeSchema` 加 `plugin_ids: z.array(z.string()).max(200).optional()`
   （tolerate 未知值，沿 `mcp_server_ids` 先例）。
2. RPC：`plugins.setBotPlugins { botId, pluginIds }`（校验 bot 存在、插件 id 均已安装；
   写 `profile_json.runtime.plugin_ids`，经 `domain/bots.ts` 现有写路径与三方合并语义）；
   `projects.plugins.set { conversationId, pluginIds }`；项目详情输出加 `plugins: string[]`。
3. 迁移 `0057_project_plugins.sql`（README §4.2 DDL）。

### 步骤 2：core 装配过滤

1. 新增纯函数模块 `packages/core/src/plugins/effective.ts`：
   `effectivePluginIds(botProfile, projectPlugins) : Set<string>`（唯一实现，五处消费）。
2. `projects` 领域：`project_plugins` 读写 + `projects.plugins.set` 校验（type=project、插件已安装）。
3. 按语义规范改五处装配：skills `listForBot` / `activeSkills` / `readableDirs`；
   mcp `serversForBot`；`apps/exposure.ts forBot`；mail `mailBoundFor`；orchestrator
   `#capabilityCatalog` 与外部智能体能力包计算。**会话上下文传递**：orchestrator 在 run 组装处已知
   conversation，项目会话时读 `project_plugins` 传入 `extraPluginIds`（一次读取，不进缓存）。
4. `plugins.setBotPlugins` 与项目授权变更 → 广播既有 `bots.changed` / 项目事件（沿用各自治宜）+
   `plugins.changed`（让扩展中心与右栏刷新）。
5. 测试：五个装配点各一条「未启用 → 不可见 / 启用 → 可见」集成测试 + 项目叠加用例 +
   停用插件后恢复用例；工具审批行为不变的对照用例。

### 步骤 3：Bot 详情「插件」区块

1. `bot-config-sections.ts`：`apps | mcp | mail` 三项合并为 `plugins`；深链锚点
   `bot-apps / bot-mcp` 保留别名重定向到 `bot-plugins`（设置卡深链不断）。
2. 新组件 `features/bot-panel/BotPluginsSection.svelte`：
   - 数据：`plugins.list` + `bots.get`（profile）+ 各实例来源（连接账号 / mcp servers / 邮箱账号）；
   - 列表行：插件名 + 类别徽标（技能/连接/工具/邮件）+ 启用开关（`plugins.setBotPlugins`）；
   - 展开细选（仅启用时可见）：连接账号勾选（现 `bot-apps` 控件）、MCP server 勾选
     （现 `bot-mcp-servers` 控件，仅手动 server）、邮箱账号勾选（现 `BotMailBindings` 控件）；
   - 「插件商店」入口：`shell.openExtensionCenter('market')`；
   - InkCop 与智能体引擎保持原区块，不动。
3. `BotMenu.svelte` 菜单项合并（应用 / MCP / 邮箱 → 插件）。
4. Butler 与新建 Bot：创建向导（`onboarding/OnboardingWizard`）末步加「推荐插件」多选
   （已安装插件列表，默认全不选；无已装插件时显示安装引导链接）。

### 步骤 4：项目组「插件」分区

1. `PROJECT_DETAIL_SECTIONS` 加 `plugins`（coverage.ts 同步），`ProjectSettingsPlugins.svelte`：
   插件列表 + 开关（`projects.plugins.set`）+ 文案「项目内所有成员 Bot 在本项目的会话与任务中可用；
   不改变成员 Bot 的个人配置」。
2. 设置卡深链锚点 `project-plugins` 登记（`data-settings-anchor` 体系核对）。

### 步骤 5：协议不可见（渲染端）

1. i18n：`plugins.kind.mcp` 显示名改「工具」（两语言）；全渲染层 grep 面向用户的「MCP」「OAuth」
   字样：扩展中心 / Bot 面板内的改为「工具 / 账号授权」类说法；`McpSection`、同意面板、
   设置页插件分区**保留**协议词（分别是管理深处与知情同意场景）。
2. `PluginSourceBadge` 文案核对（「来自插件 X」不变）。

## 5. 验收

- [ ] 新建 Bot 默认看不到任何插件能力；在「插件」区块启用「Notion 连接」插件后，
      该 Bot 能查到并调用 `app_notion_*` 工具；停用后工具与 `<capabilities>` 行同步消失。
- [ ] 安装技能插件后，未启用的 Bot 的 `<skills>` 段不含它，启用的 Bot 包含；沙箱目录同步。
- [ ] 项目组 A 启用插件 X（成员 Bot 未启用）：项目会话任务内成员可用 X，私聊会话不可用。
- [ ] 邮箱：账号绑定 Bot 但插件停用 → 邮件工具不注册；启用后恢复。
- [ ] 外部智能体能力包勾选跟随启用集（启停插件后 agent capabilities 前缀过滤变化）。
- [ ] e2e：新增 `bot-plugins.spec.ts`（启用 / 停用 / 项目组叠加三条旅程）；既有
      `plugins.spec.ts`、`skills.spec.ts` 按新语义修绿（语义变化处不得删断言，改为新预期）。
- [ ] 全量 `pnpm test` 一次，失败不超基线。

## 6. 实施记录

（执行后填写。）
