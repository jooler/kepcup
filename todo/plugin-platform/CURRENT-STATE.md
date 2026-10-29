# 现状基线（执行智能体必读）

> 本文是 2026-10-28 的代码现状事实快照，供本迭代各阶段任务书引用。行号会漂移，以文件为准；
> 与本文冲突的代码现实，按 README §5 的偏差流程处理。

## 1. 插件系统现状（D104 第一期已完成）

- **清单**：`packages/shared/src/domain/plugin-manifest.ts`。`format_version=1`，`strictObject`，
  贡献恰好四类：`skills / connectors / mcp（mcpb|http） / mail`，上限 50/20/10/10，至少一类贡献。
  **没有任何配置声明字段**（无 `config`、无 `instances`），unknown 字段直接被 zod 拒绝。
- **core**：`packages/core/src/plugins/`——`registry.ts`（install/update/setEnabled/uninstall/inspect/list、
  账本回滚、互斥、崩溃恢复）、`store.ts`（`plugins` + `plugin_items` 账本）、`package.ts`（zip/目录 → staging 快照）、
  `marketplace-sync.ts` + `marketplace-service.ts`（签名索引、R2 下载、撤销、自建端点封顶 community）、
  `guards.ts`（`PLUGIN_MANAGED`：插件 MCP server 的受保护字段与删除只能走插件整体管理）、
  `permissions.ts`（贡献 → 权限 token，更新差异）、`install-requests.ts`（`plugin_search` / `plugin_request_install`，
  只允许官方 verified，限频 每 run 5 / 每对话每小时 20）。
- **投影器**：`projectors/{skills,connectors,mcp,mail}.ts`，固定顺序 skill→mcp→connector→mail，卸载反向。
  skills 走 `SkillsService.installPublic`（`source_url = plugin://{pluginId}/{skillName}`）；
  connectors 经 `ConnectorCatalog.attachPlugins`（目录只剩 `plugin | local` 两来源，签名目录通道已删）；
  mcp 经 `McpbInstaller`（source `{kind:'plugin'}`）或登记 streamable-http；mail 只记账本行，
  模板以运行时 overlay 供 `mail.providerTemplates.list`（不落库，账号仍是 `provider:'custom'`）。
- **商店化**：应用不带内置插件（`builtin.ts` 恒空，机制仅为 dev/test 保留）；官方市场已上线
  18 个 verified 插件（9 技能 + 9 连接器，仓库根 `plugins/`），索引 `dl.kepcup.com/plugins/v1/`，
  包体 R2 `pkg.kepcup.com`，信任根 `PLUGIN_INDEX_PUBLIC_KEYS`（keyId `kepcup-plugins-2026-1`）。
- **RPC**（`plugins-bindings.ts` + shared `methods.ts`）：`plugins.list / inspect / install / update /
  setEnabled / uninstall / marketplace.list / marketplace.refresh`，另有 `mail.providerTemplates.list`。
- **渲染层**：`features/plugins/`（store、安装对话框、同意面板 `PluginConsentPanel`、来源徽标）+
  `features/extension-center/`（3 页签 `market / installed / localCollab`；已安装 = 插件卡片网格，
  旧四分组是筛选条件；MCP 管理委托 `settings/McpSection.svelte`，邮箱管理用 `ExtensionMail.svelte`，
  连接管理用 `ExtensionConnections` + apps 组件，本工作区已加 `pluginId` 圈定）。
- **Bot 工具**：`plugin_search`（只读检索）、`plugin_request_install`（产出 `confirm-plugin-install`
  SetupRequirement → 对话内确认卡 `ConfirmPluginInstallBody.svelte` 复用同意面板 → `runs.retry`）。

## 2. 能力注入现状（本迭代要重构的主体）

**Bot 级**（全部存在 `bots.profile_json` → `profile.runtime`，schema `shared/src/domain/types.ts:52-146`）：

| 字段 | 语义 | UI 位置（`features/bot-panel/BotProfileForm.svelte`） |
|---|---|---|
| `mcp_server_ids: string[]` | 全局 `settings.mcpServers` 的子集勾选 | 「MCP 服务器」区块（:983-1019） |
| `app_connection_ids: string[]` | 连接账号绑定（同一 Connector 至多一个，`domain/bots.ts:128-158` 校验） | 「连接应用」区块（:1020-1132） |
| `inkcop_agent_keys: string[]` | 本机协作智能体勾选 | 「InkCop」区块（:1133-1194） |
| `agent.{id,model,effort,permission,capabilities}` | 外部智能体任务引擎 + 能力包 | 「模型」区块（:743-981） |

- **技能没有任何 Bot 级开关**：`skills/registry.ts` 的 `listForBot` = Bot 私有行 + 未被私有遮蔽的
  全部公共技能；装了即注入。`<skills>` 段、沙箱 `readableDirs` 均由此派生。
- **邮箱绑定是独立表**：`mail_account_bots(account_id, bot_id, alerts_paused, alert_times_json)`
  （`0031_mail.sql:35-42`）；run 开头 `mailBoundFor(botId)` 判定，有绑定才注册 5 个邮件读写工具 +
  `<mail_accounts>` 提示段（`tools/mail-tools.ts:61-85`、`mail/service.ts:461-474`）。
- UI 上四个能力区块彼此独立（apps / mcp / mail / inkcop），用户必须分别理解「连接应用」「MCP 服务器」
  「邮箱账号」三种协议词汇。

**运行时装配（D91 能力目录）**：

- `orchestrator.ts#capabilityCatalog`（:2564-2573）只读上述两个 profile 字段 →
  `capabilities/catalog.ts` 生成 `app:{slug}` / `mcp:{serverId}` 能力行 → `<capabilities>` 段（`capabilities/prompt.ts:53-79`）。
- 对话轮不逐个挂工具，只挂 `capability_search` / `capability_call` 懒解析两件套；任务轮按
  `start_task` 声明的 `taskCapabilities ∩ ready` 挂载（:3814-3840）。
- 外部智能体的能力包（`shared/src/domain/host-capabilities.ts` 的动态包 `mcp` / `apps`）按工具名
  前缀过滤，与 profile 字段联动（`orchestrator.ts:2602-2617`）。

**项目组**：项目组 = `type:'project'` 的 conversation（`0040_project_conversations.sql`），设置页
（`features/project/ProjectSettings*`）只有 概览 / 成员 / 授权 / 定时 / 危险区 五个分区，
**没有任何能力配置**。注入项目上下文的只有 goal、成员名片、项目 wiki。

## 3. 死代码与断链（本迭代要清理）

- `features/extension-center/ExtensionSkills.svelte`：无任何页签引用（旧预置技能目录入口）。
- `features/extension-center/market.svelte.ts`（`skillMarket` 单例）：只被死组件和
  `ExtensionCenterBody.svelte` 的 reset effect 引用；`skillMarket.*` i18n 15 键悬空。
- `skills.presets.*` RPC + `install_skill` 工具 + `<recommended_skills>` 段：机制在、内容恒空
  （预置目录已随商店化清空）；`presets.ts` 的注释仍写「当前 9 条」。
- e2e：`extension-center.spec.ts` 头注释仍写「六个分组」；`skill-market.spec.ts` 测的是断链旧入口；
  工作区新 testid（`plugins-manage-*` / `plugins-content-*`）无 spec 覆盖。
- `release-server/stage/package/plugins/com.kepcup/`：打包残渣（未跟踪）。

## 4. 关键事实速查

- 迁移 head：`0055_plugin_update_journal.sql`（本迭代从 **0056** 起）。
- `DEVIATIONS.md` 当前最大编号 **DEV-062**（本迭代从 **DEV-063** 起）。
- settings 是单行 JSON（`settings` 表 key='app'）；设置目录条目在 `packages/shared/src/settings-catalog/items.ts`
  （扁平单文件，无 items/ 目录），插件相关条目：`plugins.updates`、`plugins.marketplace`（group `plugins`）。
- `mcpbUserConfigFieldSchema`（`shared/src/domain/mcpb.ts:16-28`）：
  `{ key, type: string|number|boolean|directory|file, title, description, required, sensitive, multiple, default?, min?, max? }`
  ——本迭代把它泛化为插件通用字段 schema。
- `MAIL_PROVIDER_PRESETS`（`shared/src/domain/mail.ts:91-153`）六厂商硬编码；`MailProvider` 枚举
  `qq|netease_163|netease_126|gmail|outlook|custom`；outlook 预设 `available:false`（OAuth 不可 P0 保存）。
- localStorage UI 偏好先例：`kepcup.apps.acpNoticeAck`、`kepcup.agentSwitchAcknowledged`、
  `kepcup.sensors.v1` 等（「不再提醒」类确认已有先例，不入设置目录）。
- `app-validator` CLI（`packages/app-validator`）：`validate <目录|.kepcup|server.json|URL>`、
  `init plugin <dir>`、`pack <dir> --out x.kepcup`。
- 渲染层「不再提醒」先例键名风格：`kepcup.<域>.<语义>`。
