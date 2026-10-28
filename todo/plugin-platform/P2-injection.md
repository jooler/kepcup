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

- [x] 新建 Bot 默认看不到任何插件能力；在「插件」区块启用「Notion 连接」插件后，
      该 Bot 能查到并调用 `app_notion_*` 工具；停用后工具与 `<capabilities>` 行同步消失。
      — 证据：`plugins-injection.test.ts`（连接器过滤 / 能力目录同源 / 缺省一致）；
      `<available_apps>` 与连接提案同样按启用集过滤（独立审查后收回本阶段，见 DEV-069 修订），
      `availableFor` 门控有用例；e2e `bot-plugins.spec.ts` 旅程 1 覆盖启停门控。
- [x] 安装技能插件后，未启用的 Bot 的 `<skills>` 段不含它，启用的 Bot 包含；沙箱目录同步。
      — 证据：`plugins-injection.test.ts` 用例 1（promptSection / readableDirs 同源断言）+ e2e 旅程 1。
- [x] 项目组 A 启用插件 X（成员 Bot 未启用）：项目会话任务内成员可用 X，私聊会话不可用。
      — 证据：`plugins-injection.test.ts` 项目叠加用例（run 级 system prompt 断言、成员 profile 不变）
      + e2e 旅程 2。
- [x] 邮箱：账号绑定 Bot 但插件停用 → 邮件工具不注册；启用后恢复。
      — 证据：按 §3.5 设计性顺延至 P3（P3 前 `mail_accounts.instance_id` 不存在，账号视为系统账号
      恒放行；`mailBoundFor` 参数已就位并有 no-op 用例）。P3 落地 instance_id 后该验收自然生效。
- [x] 外部智能体能力包勾选跟随启用集（启停插件后 agent capabilities 前缀过滤变化）。
      — 证据：能力包源头（`#capabilityCatalog` / `serversForBot`）已按启用集过滤（审查确认结构符合）；
      前缀过滤机制本身不变（D91 既有测试 `capability-mounting-*` 全绿）。
- [x] e2e：新增 `bot-plugins.spec.ts`（启用 / 停用 / 项目组叠加三条旅程）；既有
      `plugins.spec.ts`、`skills.spec.ts` 按新语义修绿（语义变化处不得删断言，改为新预期）。
      — 证据：`bot-plugins.spec.ts` 2 旅程全过；`plugins`/`plugins-market`/`extension-center`
      按 197db376 卡片化重构后的 UI 模型对齐（⋮ 菜单 + plugins-content-* 管理视图），全绿；
      `skills.spec.ts` 断言走右栏技能面板（`listForBot` UI 路径，不受注入门控影响），无需改。
- [x] 全量 `pnpm test` 一次，失败不超基线。
      — 证据：`node scripts/run-tests.mjs run --maxWorkers=8` = **6901 通过 / 3 失败 / 37 跳过**；
      3 例失败均为本次改动的直接波及并已逐文件修复复跑全绿（builtin/connector-catalog 夹具缺
      `owners` 字段、public-skills-migration 回绕缺 0057）；无基线外失败。

## 6. 实施记录

**按提交**（基线 `13959b67` → 分支 `feat/plugins-platform/p2-injection`）：

1. `9eb1f921` feat(plugins): shared 契约（`botRuntimeSchema.plugin_ids`、`conversationSchema.plugins`、
   `plugins.setBotPlugins` / `projects.plugins.set` RPC 双登记、设置目录排除表登记
   `bot-plugins` / `project-plugins` 锚点、`PROJECT_DETAIL_SECTIONS` + `plugins`）+ 迁移 0057。
2. `6932fc7c` feat(plugins): core 注入模型——`effective.ts` 单源启用集；五处装配过滤
   （skills 四方法 / mcp `serversForBot` 两处 / connections `forBot` / mail `mailBoundFor` /
   orchestrator 能力目录 + start_task 校验 + gateway/permission-bridge readableDirs）；
   `projects.setPlugins` / `bots.setPluginIds` / RPC 绑定；缺省路径行为零变化（回归红线有断言）。
3. `f0d99a88` feat(plugins): 渲染层——Bot「插件」区块（三区块合并 + 展开细选 + 本机连接组）、
   项目组「插件」分区、onboarding 推荐插件、`plugins.kind.mcp` 值改「工具」、BotMenu 合并。
4. `40ca7def` fix(plugins): 独立审查修复——卸载清洗引用面（`attachReferenceCleanup` →
   `bots.removePluginFromAll` + `projects.removePluginFromAll`，消除整集写死锁）、
   `<available_apps>` / 连接提案按启用集过滤（DEV-069 修订：收回本阶段）、本机连接独立分组 +
   orphan 判定修正 + 「插件已停用」标记、设置卡只列手动工具服务、事件并集语义、
   审批对照与 availableFor 用例。
5. `86c94b53` docs(dev): DEV-069 修订 + DEV-070（kind 标签直接改既有键值）。
6. `7e17917b` fix(plugins): 内置连接器条目携带归属插件 id（`connectorSource().owners` →
   `ConnectorCatalogOptions.sourceOwners`）——内置插件此前对插件圈定的连接管理网格不可见；
   管理视图守卫修复（0 账号首连面板不再被「失效视图」守卫立刻关闭）+ openManage 的目录属主回退。
7. `0f06dd83` test(e2e): 新增 `bot-plugins.spec.ts`；`plugins` / `plugins-market` /
   `extension-center` 按 197db376 卡片化重构后的 UI 模型对齐（基线遗留红灯，与本阶段语义无关）；
   settings.update 夹具改合并写入（整表替换会误删插件受管 server，`PLUGIN_MANAGED` 正确拒绝）。
8. 全量夹具对齐提交（本次）：builtin/connector-catalog 夹具 + public-skills-migration 回绕 0057。

**独立审查**：fresh-context 只读子智能体审 `13959b67..HEAD`，P0×1 / P1×5 / P2×5 全部处置
（P0-1 卸载卡死、P1-1 available_apps 收回、P1-2 本机连接分组、P1-3 设置卡、P1-4 用例补齐、
P1-5 e2e 入库；P2 项：kind 键 DEV-070、双口径与停用标记留 P4 收口、bots.update 整表路径仅记录）。

**迁移实际编号**：0057。**DEV 编号**：DEV-068…070（下一编号 DEV-071）。

**自由度判断点**：① 项目授权事件取新旧并集（与 setBotPlugins 一致，被移除 id 的视图也要刷新）；
② 技能过滤豁免保留命名空间（DEV-068）；③ `undefined`=旧行为 / 空集=全滤的双口径（P4 收口统一）；
④ 内置条目属主经 `sourceOwners` 透传（不改变其 origin/tier 语义）。

**遗留问题（转 P4/P5）**：① `undefined`/空集双口径统一为必传集合；② 「插件已停用」标记仅在
有已选账号时出现（§3.4 字面全覆盖待实例化后复核）；③ `bots.update` 整表路径不校验 plugin_ids
（读时容忍，仅记录）；④ MCP 词汇在 `contacts.mcpServers` 等设置卡键残留（渲染层已换键，shared
条目文案待 P4 随目录重构清理）。

**测试证据汇总**：core——`plugin-effective` 4 例、`plugins-injection` 8 例、`projects-service`
20 例、既有 skills/mcp/exposure/capability/gateway/projects 定向全绿；渲染层——bot-panel /
project / onboarding / plugins / settings-card 定向全绿、svelte-check 0 error；e2e——
`bot-plugins` 2 + `plugins` 9 + `plugins-market` 6 + `extension-center` 2 + `skills` /
`bot-profile-autosave` / `bot-setup` 等受影响规格全绿；全量一次 6901/3（3 例已归因修复）。
