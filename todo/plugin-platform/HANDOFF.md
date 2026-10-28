# 插件平台迭代（D105）· 执行交接（2026-10-28）

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

### P2（分支 `feat/plugins-platform/p2-injection`，当前所在；实现+审查+修复已完成，收口差三件事）
- 提交链：`9eb1f921`（shared 契约 + 迁移 0057）→ `6932fc7c`（core 五处装配过滤 + RPC 绑定）
  → `f0d99a88`（渲染层 Bot「插件」区块 / 项目组分区 / 协议不可见）→ `40ca7def`（独立审查修复：
  卸载清洗引用面、`<available_apps>`/提案按启用集过滤、本机连接分组、设置卡手动 server、
  停用标记）→ `86c94b53`（DEV-069 修订 + DEV-070）。
- 独立审查已闭环（P0×1 / P1×5 全部处置）。语义规范逐条对照结论见审查报告要点
  （五点装配、degrade 红线、单源 `effective.ts` 均确认符合）。
- 已实现关键点：`packages/core/src/plugins/effective.ts`（唯一启用集计算）、
  skills/mcp/connections/mail/外部包五处可选参 `extraPluginIds`（缺省=旧行为逐字节不变）、
  orchestrator 每 run 一次读 `project_plugins`、`start_task` 校验带会话上下文、
  gateway/permission-bridge readableDirs 同源、卸载时 `attachReferenceCleanup`
  （bots.removePluginFromAll + projects.removePluginFromAll，防写路径卡死）。
- 渲染层：`BotPluginsSection.svelte`（apps/mcp/mail 三区块合并、本机连接独立组、
  bot-apps/bot-mcp 锚点别名保留）、`ProjectSettingsPlugins.svelte`、onboarding 推荐插件、
  `plugins.kind.mcp` 值改「工具」（DEV-070：直接改既有键值，未新增 `plugins.kind.tool` 键）。

## P2 收口状态（本交接前已全部完成）

- 遗留 e2e 断言修复：完成（提交 `0f06dd83`；三个 spec 按 197db376 卡片化模型对齐 + 新增
  `bot-plugins.spec.ts` 2 旅程全绿）。过程中修了两个**真实应用 bug**（`7e17917b`）：内置连接器
  条目缺归属插件 id（插件圈定管理网格为空）、管理视图守卫误关 0 账号首连面板。
- 全量 `pnpm test` 一次：**6901 通过 / 3 失败 / 37 跳过**，3 例均为改动直接波及（夹具缺 `owners`、
  迁移回绕缺 0057）并已逐文件修复复跑全绿（最后一次全量之后仅有这 3 个测试文件的定向复跑与
  文档改动，无源码变更）。
- P2 实施记录与验收证据已写入 [P2-injection.md](P2-injection.md) §6；验收七条全勾（邮箱一条
  按 §3.5 设计性顺延至 P3，已在记录中写明）。
- typecheck：core / shared / desktop（svelte-check 0 error）全过。

## 下一步（新会话从这里开始）

1. 从当前分支 `feat/plugins-platform/p2-injection` 拉 `feat/plugins-platform/p3-mail`，进入 P3。
2. P3 按阶段文件执行（要点见下节）；实现 → 独立审查 → 修正 → 提交循环不变。

## 后续阶段要点（详见各阶段文件）

- **P3 邮件插件化**（P3-mail.md）：mail kind 接入实例机制（`hasInstances` 已就位、
  materializer 未注册——按 DEV-065 需在 materializer 落地时实现启动对账：
  `mail_accounts.instance_id` ↔ 实例行双向一致）；迁移 0058；删 `MAIL_PROVIDER_PRESETS` /
  `mail.providerTemplates.list`（registry 的 `mailTemplates()` 一并删）；`PluginFieldForm.svelte`
  共享组件（P4 复用）；官方插件 mail-generic/163/126/qq 四目录（`instances: ['mail']` +
  `instanceFields`，内置字段由 kind 适配器给：address/username/password(sensitive)）。
  **M2 邮件 OAuth 可顺延**（外部依赖：微软/谷歌 OAuth 应用未就绪 → 整体顺延，M1 独立交付，
  实施记录写明去向与复启条件）。注意 secrets 键用 `pluginInstanceSecretName`
  （`packages/core/src/plugins/instances.ts`，DEV-063 的转义规则）。
- **P4 扩展中心收口**（P4-extension-center.md）：PluginFieldForm 复用、卡片 config/实例 UI、
  安装引导弹框（localStorage `kepcup.plugins.installHint.dismissed`）、两页签收敛 + 系统卡、
  死代码清理（ExtensionSkills/market.svelte.ts/skills.presets/install_skill/
  recommended_skills 段/presets.ts）、M2 custom-mcp 实例化可顺延入路标。
  P2 审查指出的 `undefined`/空集双口径与「插件已停用」标记完善可在 P4 收口。
- **P5 文档/市场/设计修正**（P5-docs-market.md）：开发文档重写（新增能力类型菜谱必须写全：
  注册表适配器、instances/count/capabilitySummary/mergeConsentItems 四个 per-kind 手工点、
  `directory`/`file` 字段值的路径校验责任、清单 `default` 不落库的消费方回退）——这些是
  P1/P2 审查登记的菜谱欠账；`app-validator` 扩展；官方批次；51 §15 现状大节 + 六设计补记
  （22/29/35/40/41/23）；**盲测验收必须真实执行**（未读仓库的子 Agent 仅凭
  docs/guides/write-a-plugin.md 产出插件 → validate 零 error → 本地安装 → Bot 启用 → 生效）。

## 测试与命令备忘

- 定向：`node scripts/run-tests.mjs run <文件或目录>`；改 shared 先
  `pnpm --filter @kepcup/shared run build`，改 core 后 `pnpm --filter @kepcup/core run build`
  再跑 desktop/e2e（e2e 跑的是 `packages/*/dist` 与 `apps/desktop/out` 产物）。
- e2e：`pnpm build` 后 `cd apps/desktop && node ../../node_modules/@playwright/test/cli.js test
  test/e2e/<spec>.ts`。
- 已知基线内失败（勿追）：`user-avatar` 同毫秒内容寻址碰撞（负载敏感，单跑过）；本机沙箱类
  （bubblewrap 等）在 Linux 容器环境；e2e 全量里 `browser`/`sandbox`/`wiki` 三条历史失败与 main 一致。
- 全量：`node scripts/run-tests.mjs run --maxWorkers=8`（~2.5 分钟）。P2 当前定向全绿基线：
  shared 39 文件 484 例、core 插件族全绿（含 plugins-injection 8 例）、renderer bot-panel/
  project/onboarding/plugins 全绿、svelte-check 0 error。
- 提交规范 Conventional Commits；不 push、不合 main；阶段收尾更新 PROGRESS.md（P5 一起做）。
- DEVIATIONS：P1 用掉 DEV-063…067，P2 用掉 DEV-068…070；下一编号 **DEV-071**。
- 迁移号：0057 已用，P3 从 **0058** 起（0058_mail_plugin_instances.sql，任务书已定 DDL）。

## 环境备注

- 平台 darwin/arm64，本地直接跑（非容器）。Playwright 用系统 Electron（无需 xvfb）。
- 后台并发子代理上限 4；本会话曾有一个 e2e 修复子代理因 off-peak 配额超时失败
  （其工作树修改留待上面第 1 条验证）。
