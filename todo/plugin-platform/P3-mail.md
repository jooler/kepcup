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

（执行后填写；M2 若顺延，写明外部依赖状态与复启条件。）
