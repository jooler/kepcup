# 插件平台迭代（D105）· 执行交接（2026-10-29，P4 收口后）

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

### P2（分支 `feat/plugins-platform/p2-injection`，已收口）
- 提交链：`9eb1f921`（shared 契约 + 迁移 0057）→ `6932fc7c`（core 五处装配过滤 + RPC 绑定）
  → `f0d99a88`（渲染层 Bot「插件」区块 / 项目组分区 / 协议不可见）→ `40ca7def`（独立审查修复）
  → `86c94b53`（DEV-069 修订 + DEV-070）→ `7e17917b`/`0f06dd83`（真实 bug 修复 + e2e）
  → `cbd77a4a`（实施记录 + 交接）。
- 独立审查已闭环（P0×1 / P1×5 全部处置）。实施记录与验收证据在 [P2-injection.md](P2-injection.md) §6。

### P3（分支 `feat/plugins-platform/p3-mail`，已收口）
- 提交链：`ef282952`（shared 契约 + 迁移 0058 + mail materializer + 删预设/模板机制 +
  官方插件四目录 + app-validator）→ `e6f3f817`（渲染端：PluginFieldForm 共享组件、
  实例表单、ExtensionMail 按插件分组、i18n、mail-plugins e2e）→ `18de5c9a`/`5e4d674b`/
  `59357b60`（全量波及修复 + 实施记录 + DEV-071…073）→ `4fd6ce10`（独立审查修复：
  P0×1 + P2×8）→ `0b7f8598`（HANDOFF 指向 P4）。
- 独立审查已闭环：**P0×1 / P1×0 / P2×8 全部处置**。实施记录与验收证据在
  [P3-mail.md](P3-mail.md) §6。DEV-071…074 已登记。M2 邮件 OAuth 按任务书顺延。

### P4（分支 `feat/plugins-platform/p4-extension-center`，当前所在；实现 + 独立审查 + 修复 + 收口全部完成）
- 提交链：`bd20840e`（市场条目 capabilitySummary）→ `d0f6d949`（插件卡「设置」config 表单 +
  PluginFieldForm 路径选择器/敏感占位 + instanceCounts 筛选）→ `9c946634`（MCP 按插件圈定）
  → `40fbecc4`（安装成功接入引导弹框）→ `fcaa8d08`（P2 遗留收口：extraPluginIds 必传统一 +
  邮件启用集过滤落地 + 「插件已停用」标记覆盖邮件）→ `5bb40ca2`（两页签收敛 + 系统卡）
  → `54b73db6`（死代码清理：ExtensionSkills/skillMarket/skills.presets/install_skill/
  recommended_skills）→ `c064eea4`（e2e 对齐 + plugins-manage 三旅程 + DEV-075）
  → `410a81fc`（独立审查修复）→ 实施记录收尾（本文所在的 docs 提交）。
- 独立审查已闭环：fresh-context 只读子代理审 `0b7f8598..HEAD` 全 diff，
  **P0×0 / P1×1 / P2×6 全部处置**（P1-1 config 陈旧键死锁：getConfig 按当前清单投影 + 回归测试）。
- 实施记录与验收证据在 [P4-extension-center.md](P4-extension-center.md) §6；验收六条五勾一顺延
  （M2 custom-mcp 实例化按任务书顺延）。DEV-075 已登记（全局手动 MCP 管理保留入口）。
- 关键实现：卡片「设置」（config 自动表单）；`ExtensionMcp`/`McpSection` 的 `pluginId` 圈定；
  `PluginInstallHintDialog`（localStorage `kepcup.plugins.installHint.dismissed` + 立即添加到 Bot）；
  两页签 `['market','installed']` + 系统卡（本机应用协作 / 本机自建连接）+ localCollab 深链；
  `visibleMailAccounts` 三处同源过滤（工具注册 / `<mail_accounts>` / 工具内清单）；
  死代码清零（isBuiltinSkillSource 迁 `projectors/skills.ts`，0054 语义不变）；
  市场条目 `capabilitySummary`（索引签名写入 + categories 回退）。

## 下一步（新会话从这里开始）

1. 从当前分支 `feat/plugins-platform/p4-extension-center` 拉 `feat/plugins-platform/p5-docs-market`，进入 P5。
2. P5 按阶段文件执行（要点见下节）；实现 → 独立审查 → 修正 → 提交循环不变。
3. P5 收口时：PROGRESS.md 加行（本迭代整体收尾）、设计文稿修正（51 重写现状 + 六设计补记）、
   盲测验收必须真实执行。

## 后续阶段要点（详见阶段文件）

- **P5 文档/市场/设计修正**（P5-docs-market.md）：开发文档重写（新增能力类型菜谱必须写全：
  注册表适配器、instances/count/capabilitySummary/mergeConsentItems 四个 per-kind 手工点、
  `directory`/`file` 字段值的路径校验责任、清单 `default` 不落库的消费方回退
  **（P4 审查确认：config_json 无值，消费方须回退清单 default）**、
  邮件式「贡献 = 供给规范」模式与 `ON DELETE SET NULL` 外键纪律）；`app-validator` 扩展；
  官方批次；51 §15 现状大节 + 六设计补记（22/29/35/40/41/23，**22 的 P4 补记已写**）；
  **盲测验收必须真实执行**（未读仓库的子 Agent 仅凭 docs/guides/write-a-plugin.md
  产出插件 → validate 零 error → 本地安装 → Bot 启用 → 生效）。
- **P5 顺带决策（P4 遗留，见 P4 §6）**：①`plugins.setBotPlugins` 整集替换下渲染端两处
  合并写的读-改-写竞态——是否登记合并语义 RPC 契约；②`capabilitySummary` 硬编码中文的
  多语言方案（索引侧 vs 渲染端重建）。
- **M2（custom-mcp 实例化）已整体顺延**：P4 §4 全节为路标；custom-mcp 落地时手动 MCP 管理
  从 `manual-mcp-section`（DEV-075）迁入插件卡。

## 测试与命令备忘

- 定向：`node scripts/run-tests.mjs run <文件或目录>`；改 shared 先
  `pnpm --filter @kepcup/shared run build`，改 core 后 `pnpm --filter @kepcup/core run build`
  再跑 desktop/e2e（e2e 跑的是 `packages/*/dist` 与 `apps/desktop/out` 产物）。
- e2e：`pnpm build` 后 `cd apps/desktop && node ../../node_modules/@playwright/test/cli.js test
  test/e2e/<spec>.ts`。邮件类用 `KEPCUP_MAIL_ALLOW_PRIVATE=1` 走本机环回 FakeImap/FakeSmtp
  （`packages/testkit/src/fake-mail-server.ts`）。P4 新增 `plugins-manage.spec.ts`。
- 已知基线内失败（勿追）：`user-avatar` 同毫秒内容寻址碰撞（负载敏感，单跑过）；
  `permission-bridge` 一例 5 秒超时（负载敏感，单跑过；P3/P4 全量各命中过 1–2 例）；
  `apps/server/auth` 首启建号时序（负载敏感，单跑过——P4 全量命中 1 例，补入本清单）；
  本机沙箱类（bubblewrap 等）在 Linux 容器环境；e2e 全量里 `browser`/`sandbox`/`wiki`
  三条历史失败与 main 一致。
- 全量：`node scripts/run-tests.mjs run --maxWorkers=8`（~7 分钟）。**P4 收口全量证据**：
  6884 通过 / 3 失败 / 37 跳过（6924 例）——3 例失败均为负载敏感偶发并单跑复核全过
  （permission-bridge ×2、auth ×1），详见 [P4-extension-center.md](P4-extension-center.md) §6。
- typecheck：shared / core / desktop（svelte-check 0 error）全过（P4 审查修复后复核）。
- 提交规范 Conventional Commits；不 push、不合 main；阶段收尾更新 PROGRESS.md（P5 一起做）。
- DEVIATIONS：P1 用掉 DEV-063…067，P2 用掉 DEV-068…070，P3 用掉 DEV-071…074，
  P4 用掉 **DEV-075**；下一编号 **DEV-076**。
- 迁移号：0058 已用，P5 若需迁移从 **0059** 起。

## 环境备注

- 平台 darwin/arm64，本地直接跑（非容器）。Playwright 用系统 Electron（无需 xvfb）。
- 后台并发子代理上限 4。
