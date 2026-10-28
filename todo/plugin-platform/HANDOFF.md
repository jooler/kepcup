# 插件平台迭代（D105）· 执行交接（2026-10-28，P3 收口后）

> 给下一个会话的执行智能体：本文是中断现场的完整交接。总任务书仍是本目录 [README.md](README.md)，
> 按阶段循环协议执行（实现 → 独立审查 → 修正 → 提交 → 下一阶段）。已定决策不要重新讨论。

## 已完成

### P1（分支 `feat/plugins-platform/p1-capability-kinds`，已收口）
- 提交链：`1800db3a`（任务书基线）→ `5d310883`（settings 覆盖率动态锚点通配修复，基线遗留）
  → `4c88cb09`（shared 契约）→ `8585e853`（迁移 0056 + 实例服务 + config/inspect 扩展）
  → `e002dd34`（CAPABILITY_KINDS 注册表纯重构）→ `8edd8e5b`/`85db3ea1`/`274f8c9e`（测试）
  → `13959b67`（独立审查修复）。
- 独立审查已闭环（P0×2 / P1×7 / P2×10 全部处置）；实施记录与验收证据在
  [P1-capability-kinds.md](P1-capability-kinds.md) §6；DEV-063…067 已登记。
- 关键实现：`packages/shared/src/domain/plugin-manifest.ts`（`pluginFieldSchema`、`config`、
  `instances`、`capabilitySummary`）、`packages/core/src/plugins/{kinds,instances}.ts`、
  迁移 `0056_plugin_instances.sql`、6 个 `plugins.config.* / plugins.instances.*` RPC、
  `PLUGIN_UPGRADE_REQUIRED`。

### P2（分支 `feat/plugins-platform/p2-injection`，已收口）
- 提交链：`9eb1f921`（shared 契约 + 迁移 0057）→ `6932fc7c`（core 五处装配过滤 + RPC 绑定）
  → `f0d99a88`（渲染层 Bot「插件」区块 / 项目组分区 / 协议不可见）→ `40ca7def`（独立审查修复）
  → `86c94b53`（DEV-069 修订 + DEV-070）→ `7e17917b`/`0f06dd83`（真实 bug 修复 + e2e）
  → `cbd77a4a`（实施记录 + 交接）。
- 独立审查已闭环（P0×1 / P1×5 全部处置）。实施记录与验收证据在 [P2-injection.md](P2-injection.md) §6。

### P3（分支 `feat/plugins-platform/p3-mail`，当前所在；实现 + 独立审查 + 修复 + 收口全部完成）
- 提交链：`ef282952`（shared 契约 + 迁移 0058 + mail materializer + 删预设/模板机制 +
  官方插件四目录 + app-validator）→ `e6f3f817`（渲染端：PluginFieldForm 共享组件、
  实例表单、ExtensionMail 按插件分组、i18n、mail-plugins e2e）→ `18de5c9a`/`5e4d674b`/
  `59357b60`（全量波及修复 + 实施记录 + DEV-071…073）→ `4fd6ce10`（独立审查修复：
  P0×1 + P2×8）。
- 独立审查已闭环：fresh-context 只读子代理审 `cbd77a4a..HEAD` 全 diff，
  **P0×1 / P1×0 / P2×8 全部处置**（`4fd6ce10`）。P0-1 = createForInstance 失败回滚
  不清 `instance_id` → FK 死锁，修法是 0058 外键改 `ON DELETE SET NULL`（未发布直接改
  DDL）+ 回滚显式置空 + 回绕测试摘表顺序调整 + 2 条新测试。
- 实施记录与验收证据在 [P3-mail.md](P3-mail.md) §6；验收五条四勾一顺延（M2 邮件 OAuth
  按任务书顺延：微软/谷歌 OAuth 应用未就绪，复启条件已写明）。DEV-071…074 已登记。
- 关键实现：mail 贡献 = 实例供给规范（`instances:['mail']` 强制伴随、≤1、host 成对
  锁定或留空、`instanceFields` ≤16）；`packages/core/src/plugins/materializers/mail.ts`
  （实例 = 邮箱账号，密码单一来源 = 实例 secret，DEV-072）；`MailService` 实例路径
  （`createForInstance` / `updateInstanceAccount` / `instanceOwner` 端口）；删
  `MAIL_PROVIDER_PRESETS` / `mail.providerTemplates.list` / `mail.accounts.test/create`
  （DEV-073 收敛）；渲染端 `PluginFieldForm.svelte`（P4 复用）；官方插件
  `plugins/mail-{generic,163,126,qq}`（贡献 id `netease163`/`netease126`，DEV-071）。

## 下一步（新会话从这里开始）

1. 从当前分支 `feat/plugins-platform/p3-mail` 拉 `feat/plugins-platform/p4-extension-center`，进入 P4。
2. P4 按阶段文件执行（要点见下节）；实现 → 独立审查 → 修正 → 提交循环不变。

## 后续阶段要点（详见各阶段文件）

- **P4 扩展中心收口**（P4-extension-center.md）：PluginFieldForm 复用（**已就位**：
  `apps/desktop/src/renderer/src/lib/features/plugins/PluginFieldForm.svelte`，consent
  面板已接入；卡片 config/实例 UI 直接复用）、安装引导弹框（localStorage
  `kepcup.plugins.installHint.dismissed`）、两页签收敛 + 系统卡、死代码清理
  （ExtensionSkills/market.svelte.ts/skills.presets/install_skill/recommended_skills
  段/presets.ts）、M2 custom-mcp 实例化可顺延入路标。
  P2 审查指出的 `undefined`/空集双口径与「插件已停用」标记完善在 P4 收口。
  市场条目 `capabilitySummary` 输出（README §4.1 未落地项）也在此收口。
- **P5 文档/市场/设计修正**（P5-docs-market.md）：开发文档重写（新增能力类型菜谱必须写全：
  注册表适配器、instances/count/capabilitySummary/mergeConsentItems 四个 per-kind 手工点、
  `directory`/`file` 字段值的路径校验责任、清单 `default` 不落库的消费方回退、
  **邮件式「贡献 = 供给规范」模式与 `ON DELETE SET NULL` 外键纪律（P3 新增）**）；
  `app-validator` 扩展；官方批次；51 §15 现状大节 + 六设计补记（22/29/35/40/41/23）；
  **盲测验收必须真实执行**（未读仓库的子 Agent 仅凭 docs/guides/write-a-plugin.md
  产出插件 → validate 零 error → 本地安装 → Bot 启用 → 生效）。

## 测试与命令备忘

- 定向：`node scripts/run-tests.mjs run <文件或目录>`；改 shared 先
  `pnpm --filter @kepcup/shared run build`，改 core 后 `pnpm --filter @kepcup/core run build`
  再跑 desktop/e2e（e2e 跑的是 `packages/*/dist` 与 `apps/desktop/out` 产物）。
- e2e：`pnpm build` 后 `cd apps/desktop && node ../../node_modules/@playwright/test/cli.js test
  test/e2e/<spec>.ts`。测试kit 已导出 `FakeImapServer` / `FakeSmtpServer`
  （`packages/testkit/src/fake-mail-server.ts`），e2e 用 `KEPCUP_MAIL_ALLOW_PRIVATE=1`
  走本机环回假服务器。
- 已知基线内失败（勿追）：`user-avatar` 同毫秒内容寻址碰撞（负载敏感，单跑过）；
  `permission-bridge` 一例 5 秒超时（负载敏感，单跑过，P3 两次全量各命中一次）；
  本机沙箱类（bubblewrap 等）在 Linux 容器环境；e2e 全量里 `browser`/`sandbox`/`wiki`
  三条历史失败与 main 一致。
- 全量：`node scripts/run-tests.mjs run --maxWorkers=8`（~5 分钟）。P3 收口全量证据见
  [P3-mail.md](P3-mail.md) §6（首跑 6940 例中 4 例改动波及已修 + 1 例 permission-bridge
  偶发；修复后定向复跑全绿；P3 审查修复后最终全量结果见下方「最终全量」行）。
- typecheck：shared / core / desktop（svelte-check 0 error）全过（P3 审查修复后复核）。
- 提交规范 Conventional Commits；不 push、不合 main；阶段收尾更新 PROGRESS.md（P5 一起做）。
- DEVIATIONS：P1 用掉 DEV-063…067，P2 用掉 DEV-068…070，P3 用掉 DEV-071…074；
  下一编号 **DEV-075**。
- 迁移号：0058 已用，P4 若需迁移从 **0059** 起。

## 最终全量（P3 收口）

审查修复后最终全量 `node scripts/run-tests.mjs run --maxWorkers=8` 一次：
**6905 通过 / 0 失败 / 37 跳过（6942 例）——全绿**。typecheck shared / core / desktop
（svelte-check 0 error）全过；e2e mail-plugins 1 例 + bot-plugins / plugins 11 例全绿。

## 环境备注

- 平台 darwin/arm64，本地直接跑（非容器）。Playwright 用系统 Electron（无需 xvfb）。
- 后台并发子代理上限 4。
