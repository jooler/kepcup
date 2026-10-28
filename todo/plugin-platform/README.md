# 插件平台迭代（Plugin Platform）· 总览

> 状态：**待实施**（2026-10-28）。
> 上一期任务书 [todo/plugin-system/](../plugin-system/README.md)（D104 P0a–P2 + 商店化）**已完成**，
> 其固定契约（表 `plugins`/`plugin_items`、`plugins.*` RPC、`PLUGIN_*` 错误码等）仍然有效，本迭代在其上叠加。
> 本目录是给**执行智能体**的任务书：**先读本文件与 [CURRENT-STATE.md](CURRENT-STATE.md)，再读你被分配的阶段文件。**
> 设计文稿 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) 仍是「第一期」的记录；
> 本迭代引入的新模型以本目录为准，**P5 阶段收口时再把设计文档改写成现状事实**。

## 0. 一句话目标

把插件系统从「四类贡献的分发包」升级为「应用一切能力的载体」：能力类型可扩展（通用挂载机制）、
插件可声明配置与账号实例（宿主自动构建配置 UI）、Bot / 项目组以**插件**为唯一注入单位
（用户不感知协议）、安装后引导用户把插件接入 Bot（带「不再提醒」）、并提供完整的插件开发文档。

## 1. 五个目标（验收以此对照）

1. **插件开发文档**：开发者 / 编程 Agent 仅凭文档即可产出能通过 `kepcup-app validate`、
   本地安装、被 Bot 使用的插件（P5 验收含盲测）。
2. **一切能力皆插件**：以邮件为样板——`mail-outlook` / `mail-gmail` / `mail-163` 等厂商插件与
   「通用邮件（自填 IMAP/SMTP）」插件并存，一个插件可添加多个账号（实例），都以插件卡片展示，
   类别 = 邮件；OAuth 连接、MCP、技能、邮件是**给开发者看的接口契约**，用户界面不出现协议词汇。
3. **通用挂载机制**：新增一类能力 = 注册一个能力类型适配器（+ 清单加一个可选字段），
   `format_version` 不变、无破坏性更新；机制（账本、实例、配置 schema、同意卡、注入、卡片）
   全部类型无关。
4. **注入模型重构**：Bot 详情与项目组设置改为「以插件为单位」的启用 + 配置 UI；用户只看到
   「启用了哪些插件」，看不到也无需理解 OAuth / MCP / IMAP 等实现方式。
5. **安装后接入引导**：插件安装成功后弹框告知「能力需在 Bot 详情或项目组设置中启用才生效」，
   附「以后不再提醒」勾选（localStorage 持久化），并提供「立即添加到 Bot」捷径。

**不向后兼容**：无真实用户，允许删表、改契约、移除死代码；不做迁移旧数据的兜底逻辑
（一次性惰性迁移除外，见各阶段）。

## 2. 目标模型

### 2.1 能力类型（Capability Kind）与适配器 —— 目标 3 的机制

core 新增**能力类型注册表**（`packages/core/src/plugins/kinds.ts`），把现有四个投影器收编为注册表条目。
每个能力类型一个适配器：

```ts
interface CapabilityKindAdapter {
  kind: PluginContributionKind;            // 'skill' | 'connector' | 'mcp' | 'mail' | …未来新增
  contributionSchema: ZodType;             // 清单 contributions[kind] 的条目 schema
  hasInstances: boolean;                   // 用户能否在插件卡上创建实例
  instanceFields(): PluginField[];         // 实例表单的内置字段（kind 默认 + 插件 instanceFields 追加）
  materializer?: InstanceMaterializer;     // 实例 → 领域存储的落地/更新/拆除
  consentItems(ctx): ConsentItem[];        // 同意卡（现有实现收编）
}
```

- `CAPABILITY_KINDS: readonly CapabilityKindAdapter[]` 是唯一登记处；投影顺序、账本 kind 校验、
  覆盖率测试、渲染端类别标签全部从注册表派生（现有 `PLUGIN_PROJECTORS` 覆盖率测试改造）。
- **新增能力类型（短信 / 电话 / 传感器…）的固定菜谱**（写进开发文档）：
  ① shared 清单 `contributions` 加一个可选字段（additive，`format_version` 不变）；
  ② core 实现 `CapabilityKindAdapter` 并注册；③ 如需实例，实现 materializer（可落领域表或通用 `plugin_instances`）；
  ④ 渲染端加该 kind 的卡片管理视图适配；⑤ 迁移如需扩展 `plugin_instances.kind` 的 CHECK 则新增迁移。
  任何一步都不触碰其他类型与既有插件。
- **格式可加性契约**：`format_version` 只在破坏性变更时 +1；新增 kind / 新增字段一律走「可选字段」；
  旧应用遇到 unknown 字段 / unknown kind → 报新错误码 `PLUGIN_UPGRADE_REQUIRED`（提示升级 KepCup），
  不静默忽略。

### 2.2 贡献（contribution）与实例（instance）

- **贡献**：包内声明、安装即落地的能力（现状四类，语义不变）。
- **实例**：用户在插件卡上「添加」出来的能力单元（邮箱账号、未来的电话线路 / 传感器设备）。
  实例的配置由**插件声明的字段 schema** 驱动、宿主自动构建表单；值存新表 `plugin_instances`
  （非敏感 JSON），敏感值入 secrets（键 `{pluginId}:{instanceId}:{fieldKey}`）。
- 现状的对应关系（理解用，不改语义）：连接器的「实例」= 连接账号（已有，一张连接器卡管多个账号）；
  MCP 的「实例」= 自定义 server（P4-M2 收编）；邮件的「实例」= 邮箱账号（P3 落地）。
- 纯实例插件（无任何贡献）用清单新字段 `instances: ['mail'|'mcp'|…]` 声明自己提供哪类可实例化能力；
  「至少一类贡献」的校验改为「贡献或 instances 至少其一」。
- 卸载插件 = 级联删除其全部实例（先经 materializer 拆领域数据，再删行），同意卡/卸载确认明示。

### 2.3 插件配置（声明式字段 schema）—— 目标 2/3 的配置 UI

- 清单新增可选 `config: { fields: PluginField[] }`（≤32）：插件级全局配置。渲染端在插件卡
  「设置」里**自动构建表单**；非敏感值存 `plugins.config_json`，敏感值入 secrets。
- `PluginField` = 现 `mcpbUserConfigFieldSchema` 泛化（`shared/src/domain/plugins.ts` 定义唯一
  `pluginFieldSchema`，`mcpb.ts` re-export 别名保持 MCPB 解析不动）；MCPB `user_config`、插件 `config`、
  实例字段三者共用同一套字段 schema 与同一套渲染表单。
- 「插件装了能干什么」的一句话能力概述由 core 从贡献推导（`plugins.inspect` / 市场条目输出
  `capabilitySummary`），市场卡、已装卡、同意卡三处复用——用户只需读这一句。

### 2.4 注入模型：插件 = 唯一注入单位 —— 目标 4/5

- **Bot 级启用**：`profile.runtime` 新增 `plugin_ids: string[]`（沿用 `mcp_server_ids` 的
  Profile-JSON 先例， tolerate 未知值）。**缺失 = 未启用任何插件（显式添加制）**，这是目标 5 的语义基础。
- **项目组级启用**：新表 `project_plugins(conversation_id, plugin_id)`；语义 = **项目会话内的叠加授权**：
  会话为项目会话时，成员 Bot 的有效启用集 = `bot.plugin_ids ∪ project_plugins(该会话)`；
  仅在该项目的会话/任务内生效，不修改成员 Bot 的个人配置。
- **有效启用集（会话内）**：`effective(bot, conversation) = bot.plugin_ids ∪ (project ? project_plugins : ∅)`。
  各能力消费点按它过滤：
  | 能力 | 现状 | 改造后 |
  |---|---|---|
  | 技能 | 公共技能对所有 Bot 注入，无开关 | `plugin://` 来源的公共技能仅当其插件 ∈ 启用集才进 `<skills>` / 沙箱目录；Bot 私有技能与非插件公共技能（理论残留）不受影响 |
  | MCP | 应用级 enabled ∩ `mcp_server_ids` | 插件贡献 server：由插件启用集接管（不再要求逐个勾选）；自定义 server：`mcp_server_ids` 保留为实例细选，且其所属插件（P4-M2 后为 `custom-mcp`）未启用时整体隐藏 |
  | 连接 | `app_connection_ids`（实例细选） | 细选保留；其贡献插件未启用时隐藏，`<available_apps>` 与 Bot 提案同样按启用集过滤 |
  | 邮件 | `mail_account_bots` 绑定即生效 | 账号仍按 `mail_account_bots` 绑定（实例级），但账号所属插件未启用时不暴露（工具 + `<mail_accounts>` 段同步） |
  | 外部智能体能力包 | 前缀动态包 mcp/apps | 白名单按有效启用集计算 |
- **Butler 不隐式启用**任何插件；Bot 创建向导 / 插件安装引导提供快速启用入口。
- **UI 重构**（P2）：Bot 详情的「连接应用 / MCP 服务器 / 邮箱 / InkCop」四个区块 →
  「**插件**」一个区块（已装插件列表 + 启用开关，展开做实例细选与高级微调，复用现有控件）；
  InkCop 是宿主能力不是插件，保留独立开关（置于插件区块之下的「系统能力」组）。
  项目组设置新增「**插件**」分区（列表 + 开关，语义文案「项目内所有成员可用」）。
- **协议不可见**：渲染端类别标签为 技能 / 连接 / 工具 / 邮件（`mcp` kind 的显示名从「MCP」改为「工具」，
  kind id 不变）；「OAuth / MCP / IMAP」等词只出现在同意面板与开发者文档。

### 2.5 安装后引导 —— 目标 5

`plugins.install` 成功后（扩展中心市场安装 / 本地安装两条路径）：弹框
「**{插件名} 已安装** —— 插件的能力不会自动生效：需要在 **Bot 详情**或**项目组设置**里启用它，对应 Bot 才能使用。」
+ 勾选「以后不再提醒」（localStorage `kepcup.plugins.installHint.dismissed`，不入设置目录，
先例 `kepcup.apps.acpNoticeAck`）+ 按钮「立即添加到 Bot…」（勾选 Bot 后写 `plugin_ids`）/「完成」。

## 3. 分期总览

| 阶段 | 文件 | 交付 | 依赖 | 分支 |
|---|---|---|---|---|
| P1 | [P1-capability-kinds.md](P1-capability-kinds.md) | 能力类型注册表、`pluginFieldSchema`、插件 `config`、`plugin_instances` + 实例 RPC、`PLUGIN_UPGRADE_REQUIRED`、inspect/同意卡扩展 | 无（基于已完成的第一期） | `feat/plugins-platform/p1-capability-kinds` |
| P2 | [P2-injection.md](P2-injection.md) | 注入模型：`plugin_ids`、`project_plugins`、装配层过滤、Bot「插件」区块、项目组「插件」分区 | P1 | `feat/plugins-platform/p2-injection` |
| P3 | [P3-mail.md](P3-mail.md) | 邮件插件化（实例型能力首个落地）：`mail_accounts.instance_id`、删 `MAIL_PROVIDER_PRESETS`、官方邮件插件、M2 邮件 OAuth（可顺延） | P1（与 P2 并行） | `feat/plugins-platform/p3-mail` |
| P4 | [P4-extension-center.md](P4-extension-center.md) | 扩展中心收口：卡片配置/实例 UI、安装引导弹框、MCP 按插件圈定、（M2）custom-mcp 实例化、系统卡收编、死代码清理、e2e | P2、P3 | `feat/plugins-platform/p4-extension-center` |
| P5 | [P5-docs-market.md](P5-docs-market.md) | 插件开发文档（盲测验收）、官方批次更新、`app-validator` 扩展、**设计文稿修正为现状事实** | P4 | `feat/plugins-platform/p5-docs-market` |

```text
P1 基座 ──┬─→ P2 注入模型 ──┐
          └─→ P3 邮件插件化 ┴─→ P4 扩展中心收口 ──→ P5 文档 / 市场 / 设计修正
```

**后续路标（不在本期，P5 写进设计文档）**：custom-connector 实例化、短信 / 电话 / 传感器能力类型、
插件依赖与合集、多市场并列、developer-portal 提交审核（P3 原方案不变）。

## 4. 固定契约（名字不得改动；新增名按相邻风格，登记进实施记录）

### 4.1 shared（`packages/shared/src/domain/plugins.ts` 为主）

| 项 | 内容 |
|---|---|
| `pluginFieldSchema` | 字段 schema 唯一定义（形状 = 现 `mcpbUserConfigFieldSchema`，`mcpb.ts` 改为 re-export `mcpbUserConfigFieldSchema` 别名） |
| 清单新增 | `config?: { fields: PluginField[] }`（≤32，strict）；`instances?: PluginInstanceKind[]`（`'mail' \| 'mcp'`，≤4）；「至少一类贡献」改为「贡献或 instances 至少其一」 |
| mail 贡献新增（P3） | `instanceFields?: PluginField[]`（≤16，追加在 kind 内置字段之后）；`oauth?` 子对象 **P3-M2 才定义**，本迭代先不进 schema |
| `PluginSummary` 新增 | `configFields: PluginField[]`（安全投影：只出 key/title/type/required，不出值与 default 文案）、`instanceCounts: { mail: number; mcp: number }`、`providesInstances: PluginInstanceKind[]` |
| inspect 输出新增 | `configFields`（同上安全投影）、`capabilitySummary: string`（贡献推导的一句话概述） |
| 市场条目输出新增 | `capabilitySummary: string` |
| 新错误码 | `PLUGIN_UPGRADE_REQUIRED`（清单含 unknown 字段 / unknown kind；`chats.errorCode.*` 两语文案） |
| 新 RPC（P1） | `plugins.config.get { id }` / `plugins.config.set { id, values }`；`plugins.instances.list { pluginId }` / `create { pluginId, values }` / `update { id, values }` / `delete { id }`（values = `Record<fieldKey, value>`，敏感值入 secrets） |
| 新 RPC（P2） | `plugins.setBotPlugins { botId, pluginIds }`；`projects.plugins.set { conversationId, pluginIds }`、项目详情输出加 `plugins: string[]` |
| 事件 | 沿用 `plugins.changed`；实例 / 配置变更后也发（`ids` 含受影响插件） |

### 4.2 core 迁移（开工时 `ls packages/core/migrations/main | tail -3` 核对，被占用则顺延并登记）

| 迁移 | 阶段 | 内容 |
|---|---|---|
| `0056_plugin_instances.sql` | P1 | 表 `plugin_instances(id TEXT PK, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('mail','mcp')), title TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`；`ALTER TABLE plugins ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'` |
| `0057_project_plugins.sql` | P2 | 表 `project_plugins(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, plugin_id TEXT NOT NULL, PRIMARY KEY (conversation_id, plugin_id))` |
| `0058_mail_plugin_instances.sql` | P3 | `ALTER TABLE mail_accounts ADD COLUMN instance_id TEXT REFERENCES plugin_instances(id)` |

- `plugin_instances.kind` 未来扩 kind = 新迁移放宽 CHECK（SQLite 需重建表），写进菜谱文档。
- Bot 启用集存 `profile_json.runtime.plugin_ids`（无迁移）；无 instance_id 的遗留邮件账号照常工作，
  列表标「未关联插件」，不迁移（无用户）。
- custom-mcp 实例化（P4-M2，可顺延）：`settings.mcpServers` 手动条目回写
  `source { kind:'instance', pluginId:'app.kepcup/custom-mcp', instanceId }`，启动时惰性迁移一次；
  `mcpServerSourceSchema` 加 `instance` 分支。

### 4.3 core 模块（`packages/core/src/plugins/`）

| 项 | 内容 |
|---|---|
| `kinds.ts`（P1 新增） | `CapabilityKindAdapter`、`CAPABILITY_KINDS` 注册表；`projectors/index.ts` 的顺序 / 覆盖率测试改由注册表派生（纯重构独立提交） |
| `instances.ts`（P1 新增） | `PluginInstanceService`：通用 CRUD + materializer 注册（`registerMaterializer(kind, impl)`）；实例变更走 `PluginRegistry` 同一把互斥锁 |
| 配置存取 | `plugins.config_json` 读写进 `PluginRegistry`（互斥内）；敏感字段写 secrets `{pluginId}:{instanceId|'config'}:{fieldKey}` |
| 卸载级联 | uninstall / 更新替换时先经 materializer 拆实例（幂等），再删行（FK CASCADE） |

### 4.4 renderer

| 项 | 内容 |
|---|---|
| i18n 前缀 | `plugins.config.*`、`plugins.instances.*`、`plugins.installHint.*`、`plugins.kind.tool`（`mcp` 显示名改「工具」）、`projectSettings.plugins.*`、`botPanel.sections.plugins` |
| testid | `plugins-config-{pluginId}`、`plugins-instance-*`、`plugins-install-hint`、`bot-plugins-*`、`project-plugins-*`；沿用 `plugins-*` 总前缀 |
| localStorage | `kepcup.plugins.installHint.dismissed = '1'` |
| 类别筛选 | 「已安装」筛选与市场分类的 `mcp` 标签显示「工具」；`instanceCounts` 参与筛选计数（纯实例插件可被筛出） |

## 5. 给执行智能体的规则（必读，违反会返工）

1. **阅读顺序**：本文件 → [CURRENT-STATE.md](CURRENT-STATE.md) → 你的阶段文件 → 阶段文件「必读」列出的源码 →
   [AGENTS.md](../../AGENTS.md)、[docs/dev/01-conventions.md](../../docs/dev/01-conventions.md)、[docs/dev/05-testing.md](../../docs/dev/05-testing.md)。
2. **阶段文件与本文冲突 → 以阶段文件为准**（更具体），并在 [DEVIATIONS](../../docs/dev/DEVIATIONS.md) 登记
   （编号从 **DEV-063** 起，`rg -n "^### DEV-" docs/dev/DEVIATIONS.md | tail -1` 核对）。代码现实与本文冲突 →
   停止相关部分、登记、继续不受影响的部分，不要自行换方案。
3. **测试**：迭代中只跑相关测试 `node scripts/run-tests.mjs run <文件或目录>`；改 shared 先
   `pnpm --filter @kepcup/shared run build`，改 core 后 desktop 先 `pnpm --filter @kepcup/core run build`；
   全量 `pnpm test` 每阶段收口**跑一次**，失败集合不得超出 PROGRESS.md 基线；不为过测试放宽断言。
4. **提交**：Conventional Commits（`feat(plugins): …` / `refactor(plugins): …` …），每提交可构建；
   纯重构（如 P1 的注册表收编）独立提交、不夹带行为改动。一个阶段一个分支，不 push、不合入 main。
5. **全局「不要做」**（沿用上一期 §1.7 并追加）：
   - 不对插件包内容做 `import()` / `require()` / `vm` / `eval` / `Worker` 加载；不信任清单自述（strict schema）。
   - 不引入向后兼容分支 / `@deprecated` 导出；不做数据迁移兜底（明确列出的惰性迁移除外）。
   - 不在日志 / 审计 / RPC 错误细节泄露实例配置的敏感值与 secrets。
   - 不改各贡献类别的审批 / 风险 / 锁定 / 污点语义（注入模型只做**过滤**，不触碰工具实现）。
   - 不新增 npm 依赖（沿用第一期规则，复用仓库既有能力）；确需新增，先在 DEVIATIONS 登记理由后再动。
   - 渲染层不硬编码中文；i18n 两语言键与顺序一致（`locales.test.ts` 强制）。
   - 用户可见文案不出现协议词汇（OAuth / MCP / IMAP / stdio…），协议细节只进同意面板与开发文档。
6. **设置**：本迭代不新增设置目录条目（「不再提醒」是设备级 UI 偏好，走 localStorage，有先例）。

## 6. 完成定义（每阶段）

1. 阶段文件「验收」逐条通过，实施记录写明证据（命令与结果）。
2. 本阶段新增 / 修改测试全绿；相关包 `typecheck` 通过；`pnpm lint` 不新增本阶段文件报错。
3. 实施记录在阶段文件末尾：做了什么、偏差（DEV 编号）、遗留问题。
4. 全部阶段收口后（P5）：设计文稿修正完成（51 重写现状 + 受影响设计补记）、PROGRESS.md 加行、
   开发文档通过盲测验收。
