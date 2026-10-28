# P3 · 邮件插件化（实例型能力的首个落地）

> 状态：待实施。依赖：P1（与 P2 并行；其「插件停用 → 邮件工具不暴露」语义已由 P2 落地）。
> 分支：`feat/plugins-platform/p3-mail`。
> 必读：[README.md](README.md) §2.2–2.3；[CURRENT-STATE.md](CURRENT-STATE.md) §4（mail 域模型）；
> 源码 `packages/shared/src/domain/mail.ts`、`packages/core/src/plugins/projectors/mail.ts`、
> `packages/core/src/mail/`（账号生命周期）、`packages/core/src/rpc/mail-bindings.ts`、
> `apps/desktop/src/renderer/src/lib/features/mail/MailAccountAddForm.svelte`、`ExtensionMail.svelte`。

## 1. 目标

交付后：**邮箱账号是邮件插件的实例**——用户在邮件插件卡上「添加账号」，表单由插件声明的字段
自动构建（厂商插件预填 IMAP/SMTP 并锁定主机，通用插件全自填）；一个插件可添加多个账号；
`MAIL_PROVIDER_PRESETS` 六厂商硬编码与「添加邮箱」的预设下拉删除；官方市场发布通用与厂商邮件插件。
M2（邮件 OAuth）为本阶段内可顺延的独立里程碑。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| mail kind 接入 `CapabilityKindAdapter`（`hasInstances: true` + materializer） | 邮件收发 / 轮询 / 审批语义（一字不改） |
| `mail_accounts.instance_id`（0058）、账号 ↔ 实例生命周期打通 | 遗留无主账号的迁移（标「未关联插件」即可） |
| 删 `MAIL_PROVIDER_PRESETS`、`mail.providerTemplates.list`、预设下拉 | OAuth 邮件（M2 之外的远期） |
| 插件卡上的账号管理 UI（列表 / 添加 / 暂停 / 删除） | Bot 侧账号勾选 UI（P2 已并入插件区块，本阶段只对齐数据） |
| 官方插件 `mail-generic` / `mail-163` / `mail-126` / `mail-qq`（密码 / 授权码形态） | `mail-outlook` / `mail-gmail`（依赖 M2） |

## 3. 设计规范

1. **mail 贡献 schema 扩展**（shared，additive）：
   - `instanceFields?: PluginField[]`（≤16）：厂商附加字段（如 QQ 的「授权码」说明文案），
     追加在 kind 内置字段之后；
   - 内置实例字段由 kind 适配器定义（**不出现在清单里**）：`address`（string, required, email 格式）、
     `username`（string, 缺省取 address）、`password`（string, required, sensitive）；
   - 现 `imap/smtp/defaultMode/defaultPollSec/minPollSec/helpUrl` 字段语义变为**实例默认值与锁定项**：
     厂商插件（imap.host 非空）锁定 host/port/secure 不出表单；通用插件（host 为空串）将
     `imapHost/imapPort/imapSecure/smtpHost/smtpPort/smtpSecure` 追加为必填实例字段；
     `defaultPollSec/minPollSec` 全局 60 秒下限仍是硬限。
2. **materializer**：`create` → 复用 `mail.accounts.create` 内部路径（生成账号 id、密码入
   secrets `mail:{accountId}:password` 不变、`instance_id` 回填）；`update` → 端点 / 凭据字段更新；
   `remove` → `mail.accounts.delete` 既有级联。实例 `title` = 账号地址。
3. **删除面**：`MAIL_PROVIDER_PRESETS`、`MailProviderPreset`、`mailProviderTemplateSchema`、
   `mail.providerTemplates.list` RPC、`MailAccountAddForm` 的预设下拉、`projectors/mail.ts` 的
   模板冲突检查（改为实例不再有「模板」概念）。`MailProvider` 枚举**保留**（DB 列与 zod 不动，
   全部实例账号仍 `provider:'custom'`；枚举收缩登记为后续清理项）。
4. **UI 归属**：添加账号唯一入口 = 插件卡（扩展中心「已安装」→ 邮件插件 → 管理）；
   全局邮件视图（`features/mail`）保留**已建账号**的列表 / 暂停 / 删除 / 绑定查看，添加按钮改为
   「安装邮件插件或到邮件插件卡添加」（深链 `installed?filter=mail`）；无任何邮件插件时给出市场深链。
5. **官方插件内容**（仓库根 `plugins/` 新增四个目录，`instances: ['mail']` + `instanceFields`）：
   `app.kepcup/mail-generic`（全自填，帮助文案覆盖「如何获取 IMAP/SMTP 授权码」）、
   `mail-163` / `mail-126` / `mail-qq`（锁定主机 + 授权码说明 + minPollSec 沿现预设值）。
   打包签名发布沿 `plugins/README.md` 流程。
6. **M2（可顺延）邮件 OAuth**：mail 贡献新增 `oauth?: { provider, scopes[], ... }` 子 schema
   （字段在实施时对照 D73 授权引擎落 DEV 登记）；IMAP/SMTP 客户端支持 XOAUTH2 SASL；令牌 /
   刷新入 secrets；实例创建内嵌 OAuth 授权流（复用连接授权的浏览器流程）；`mail-outlook` /
   `mail-gmail` 插件随之发布。**外部依赖**：微软 / 谷歌 OAuth 应用注册与审核未就绪则整体顺延，
   M1 独立可交付。

## 4. 步骤

1. shared：mail 贡献 schema 扩展 + `mailAccountSchema` 加 `instanceId: z.string().nullable()`；
   `mail.accounts.*` 输出透出 `instanceId` / 插件名（联查）。
2. core：0058 迁移；mail kind 适配器升级（`hasInstances`、内置字段、materializer 注册）；
   `PluginRegistry.list` 的 `instanceCounts.mail` 按 `mail_accounts.instance_id` 统计；
   审计沿用 `plugin_instance_*`。
3. core 清理：删 `MAIL_PROVIDER_PRESETS` / `providerTemplates` / 投影器模板冲突检查；
   `mail.accounts.create` 校验改由实例层负责（直接 RPC 调用保留兼容行为或收敛，实施记录写明取舍）。
4. 渲染端：`MailAccountAddForm` 重写为「实例字段表单」（`PluginConsentPanel` 的字段渲染逻辑抽成
   共享组件 `PluginFieldForm.svelte`——config / 实例 / （P4）卡片设置三处复用）；
   `ExtensionMail.svelte` 改为按插件分组的账号聚合视图（每行显示所属插件，管理动作保留）；
   邮件全局视图的添加入口替换。
5. 官方插件四个目录 + README 批次更新 + 打包签名发布（沿 `plugins/README.md`）。
6. e2e：`mail-plugins.spec.ts`（安装 mail-163 → 插件卡添加账号 → 全局邮件视图出现 →
   Bot 启用插件与账号 → 会话内邮件工具可用 → 删除实例级联删账号）。

## 5. 验收

- [ ] 安装 `mail-163` 插件 → 卡片「管理」→ 添加账号：表单只有 地址 / 授权码 /（用户名），
      主机不可见不可改；创建成功后全局邮件视图出现该账号、正常收发。
- [ ] 安装 `mail-generic` → 添加账号可自填 IMAP/SMTP；错误主机被现有连通性测试拒绝。
- [ ] 同一插件添加第二个账号成功；删除插件 → 两个账号、绑定、secrets 全部级联清除。
- [ ] 「添加邮箱」的旧预设下拉与 `MAIL_PROVIDER_PRESETS` 在代码与 UI 中不复存在；
      遗留账号（无 instance_id）仍显示、可暂停 / 删除，标「未关联插件」。
- [ ] M2 若实施：outlook 插件 OAuth 授权 → 账号创建 → XOAUTH2 收发成功；令牌只入 secrets。

## 6. 实施记录

**按提交**（基线 `cbd77a4a` = P2 收口 → P3 分支 `feat/plugins-platform/p3-mail`）：

1. `feat(plugins): mail kind 实例化`——shared 契约 + 迁移 0058 + core 实例化与清理 +
   app-validator 通用形态 + 官方插件四目录 + testkit 导出假邮件服务器。
2. `feat(plugins): 渲染端邮件插件化`——PluginFieldForm 共享组件、MailAccountAddForm
   实例表单、ExtensionMail 按插件分组聚合、i18n 两语对齐、mail-plugins.spec.ts e2e。
3. 审查修复提交（见下）。

**shared**（`packages/shared/src/domain/{plugin-manifest,mail,plugins,types}.ts`、
`settings-catalog/{types,items}.ts`、`rpc/methods.ts`）：

- `pluginMailContributionSchema` 升级为**实例供给规范**：`instances: ['mail']` 强制伴随
  （manifest superRefine）、至多 1 个、imap/smtp host **成对**锁定或成对留空（空 =
  通用插件，端点变实例字段）、`instanceFields` ≤16 且不得遮内置键（`address / username /
  password / imapHost / …`，`PLUGIN_MAIL_BUILTIN_INSTANCE_FIELD_KEYS`）；`defaultPollSec`
  不变（轮询下限的夹取边界改由 core 从贡献读）。
- 删除面：`MAIL_PROVIDER_PRESETS` / `MailProviderPreset` / `mailProviderTemplateSchema` /
  `mail.accounts.test` / `mail.accounts.create` / `mail.providerTemplates.list`
  （RPC 双登记同步删除）；`clampMailPollInterval(seconds, bounds)` 新签名；
  `mailAccountSchema` + `instanceId / pluginId / pluginName`；
  `PluginSummary` + `instanceFields`（安全投影，无 default）；`mail-account` SetupRequirement
  去掉 `provider` 预填；settings-catalog `mail.account` 条目 `fields: []`（卡片改插件选择）。
- `pluginCapabilitySummary` 不再把 mail 贡献渲染成「N 个邮件模板」（贡献即实例供给，
  「可添加多个邮箱账号」尾句已覆盖）。

**core**：

- 迁移 `0058_mail_plugin_instances.sql`（README §4.2 DDL 原样：`mail_accounts.instance_id`
  外键指向 `plugin_instances`）。
- `kinds.ts`：适配器 `instanceFields(manifest)` 升级为清单感知——mail 内置字段
  （address / username / password(sensitive)）+ 通用贡献追加 6 个端点字段 + 清单
  `instanceFields` 追加；**这是实例字段唯一来源**（实例值校验与 summary 投影同源）。
- `instances.ts`：`registerMaterializer` 的 `InstanceMaterializerContext` 增加
  `manifest / readStoredSecret`；create 改为**先落实例 secret 再 materializer**
  （mail 落地要读密码），失败补偿清 行+secrets；`ownerOf` / `listKind`；
  secrets 依赖加 `getValue`。
- `materializers/mail.ts`（新）：create 复用 `MailService.createForInstance`（测连 →
  落库带 instance_id → 会话启动），厂商锁端点恒取贡献、通用取实例字段；update 走
  `MailService.updateInstanceAccount`（地址不可改、授权码缺省读存量 secret 重测）；
  remove = `deleteByInstance`（幂等）；`reconcileMailInstanceRows` 启动对账
  （DEV-065 的 P3 责任：孤儿实例行清理）。
- `mail/service.ts`：`createForInstance`（同地址全局去重）、`updateInstanceAccount`、
  `accountByInstance / deleteByInstance`、`instanceOwner` 端口（密码 secret 名 /
  轮询边界 / 归属展示，mail 不 import 插件模块）；全局 `update` 拒绝实例账号改端点
  /登录名；`delete` 软删同时置空 `instance_id`（外键防卡死）；会话 hub 密码按账号解析。
- `plugins/registry.ts`：删 `mailTemplates()`；`summary` 透出 `instanceFields`，
  `instanceCounts.mail` 改按 `mail_accounts` 活跃账号统计（`mailInstanceCount` 注入，
  软删 / 无主不计）；`displayNameOf` 供归属展示。
- `start.ts`：实例归属端口接线 + materializer 注册 + 启动对账。

**渲染端**：`PluginFieldForm.svelte`（字段表单唯一实现，consent 面板复用）；
`MailAccountAddForm` 重写为实例表单（`plugins.instances.create`，对话内卡传
`bindBotId` 创建后绑定）；`ExtensionMail` 按插件分组聚合 + 无主账号标「未关联插件」
+ 添加入口（单插件直进表单、多插件选择、无插件市场深链）；实例账号删除走
`plugins.instances.delete`；i18n 删 provider / template / outlookUnavailable 等键、
增 `mail.noPlugin / openMarket / pickPlugin / instanceCount / group.legacy / ownerOf /
instanceFormNote`（两语键序由 locales.test 保证）；`mail-template.ts` 死代码删除。

**官方插件**：`plugins/mail-{generic,163,126,qq}`（`instances: ['mail']` + 一份贡献；
generic host 留空、163/126/qq 锁定端点，minPollSec 沿旧预设 180/180/120）。
app-validator 的 `plugin.mail-host` 规则放行空 host（通用形态）。四个插件
`validate` 与 `pack` 全 PASS。

**DEV 登记**：DEV-071（贡献 id `netease163`/`netease126`，key 正则不收下划线）、
DEV-072（实例密码单一来源 = 实例 secret，偏离任务书 `mail:{id}:password` 旧键写法）、
DEV-073（`mail.accounts.test/create` 收敛删除的取舍）。

**M2（邮件 OAuth）顺延**：外部依赖未就绪——微软（Entra ID）与谷歌的 OAuth 应用注册、
审核与品牌验证在本迭代窗口内没有完成路径；`oauth` 子 schema 按任务书（README §4.1）
本就不进 P3。复启条件：OAuth 应用就绪 + XOAUTH2 SASL 语义定稿（对照 D73 授权引擎）。
`mail-outlook` / `mail-gmail` 插件随 M2 发布。实施记录在此写明去向。

**验收对照**（P3-mail.md §5）：

- [x] 安装 `mail-163` → 卡片「管理」→ 添加账号：表单只有 地址 / 授权码（/ 用户名），
      主机不可见不可改——e2e `mail-plugins.spec.ts`（厂商形态锁端点断言）+
      `plugins.test.ts`「邮件插件化」用例（端点恒取贡献）。创建成功后全局邮件视图出现
      该账号：e2e 分组断言；正常收发：`mail.test.ts`（IDLE / 轮询 / 发信审批链路全绿，
      建号路径与实例共用 `createForInstance`）。
- [x] 安装 `mail-generic` → 自填 IMAP/SMTP：`capability-mounting-p2.test.ts` 用通用
      插件建号（自填端点连假服务器）；错误主机被既有连通性测试拒绝（`hosts.ts`
      出口校验与 `#wrap` 不变，`mail-security.test.ts` 全绿）。
- [x] 同一插件添加第二个账号成功；删除插件 → 账号、绑定、secrets 全部级联清除：
      e2e 双账号 + 卸载级联；secret 清理走 P1 前缀扫描（`plugins-instances.test.ts`）。
- [x] 旧预设下拉与 `MAIL_PROVIDER_PRESETS` 不复存在（全仓 rg 无源码引用，仅注释提及）；
      遗留无主账号仍显示 / 可暂停 / 删除，标「未关联插件」（`ExtensionMail` legacy 分组；
      `mail-service-fixes.test.ts` 建号即无主路径回归）。
- [ ] M2 若实施：顺延（见上）。

**测试证据**：shared 39 文件 485 例全绿；core 全目录（unit + integration，4645 例）
除 `permission-bridge` 一例负载敏感偶发（单跑全绿，基线已记录的同类）外全绿；
渲染层插件 / 邮件 / Bot 面板 / 会话 / 设置卡 / 扩展中心等 42 文件 305 例全绿；
locales 键序测试通过；settings 目录四文件 90 例全绿（AGENTS 约定定向）；
typecheck：shared / core / desktop（svelte-check 0 error）全过；
e2e：mail-plugins 1 例 + bot-plugins / extension-center / plugins 13 例全绿。
全量 `node scripts/run-tests.mjs run --maxWorkers=8` 一次：**6902 通过 / 1 失败 / 37 跳过**
（6940 例）——失败为 shared `connected-apps.test.ts` 的 mail-account 契约用例（改动直接
波及：provider 预填字段已删），已按剥离语义修复并单跑全绿；另有首跑的 app-validator
夹具 3 例（同因：夹具缺 `instances: ['mail']`）也在全量后修复。修复后未再跑第二次全量
（按「不做连续多轮全量」；失败文件已逐一单跑取证）。`permission-bridge` 一例 5 秒超时
为本轮全量的负载偶发，单跑全绿（基线已记录的同类）。

**遗留问题**：① `instanceCounts` 的 mcp 仍按实例行数（P4-M2 custom-mcp 落地时对齐
「活跃口径」）；② 市场条目的 `capabilitySummary` 输出（README §4.1 未落地项）仍待 P4；
③ ExtensionMail 的遗留账号分组在归属插件被卸载后按 id 显示（`plugins.nameOf` 回退），
P4 卡片收口时再核对文案；④ e2e 未覆盖「遗留无主账号」UI 旅程（黑盒无播种缝，
服务层回归在 `mail-service-fixes.test.ts`）。
