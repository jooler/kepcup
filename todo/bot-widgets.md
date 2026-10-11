# Bot 自制交互组件（Bot Widgets）：实施方案

> 状态：**已定稿，实施中**（2026-10-11；用户拍板：Bot 写的单文件 HTML 组件直接在对话里加载供用户操作，持久化借 core 的 better-sqlite3 由宿主能力桥提供；复用 D73 P3 MCP Apps 管线 + 低信任层，不把 Node 交给生成代码）。
> 决策编号 **D81**；设计事实见 [docs/design/32-bot-widgets.md](../docs/design/32-bot-widgets.md)。
> 分支：`t/d73-connected-apps`（树上另有未提交的媒体路由修复，属其他任务，不碰）。
> **测试纪律**：开发中只跑定向测试（`node scripts/run-tests.mjs run <文件>`）；本方案改 `packages/shared` 契约与 main 迁移，收口全量跑一次。

## 1. 目标

- Bot（任务里）能用 `widget_create` / `widget_update` 交付单文件 HTML 交互组件，作为卡片消息出现在对话里。
- 用户点「加载」后在气泡内的沙箱 iframe 里操作；首次按版本确认、可查看源码；重启后旧卡可重开且仍是原版本。
- 组件的数据持久化由宿主能力桥提供（P1：每组件命名空间 KV；P2：预审命名只读查询），生成代码永远不接触 Node / 文件系统 / 网络。

## 2. 现状（2026-10-11 读取，以代码为准）

| 位置 | 现状 |
|---|---|
| `packages/shared/src/domain/types.ts:855-883` | `cardContentSchema` 是扁平 union 字段挂法（`appUi` 即 MCP Apps 卡描述符）；加 widget 卡照此挂 `cardWidget` |
| `packages/shared/src/domain/apps-ui.ts` | MCP Apps 契约与常量：`kepcup-app` 协议名、`buildAppCspHeader`（空域 = `connect-src 'none'`）、`apps.ui.*` RPC schema、平台方法 `apps.ui.resource` |
| `packages/core/src/apps/ui/service.ts` / `store.ts` | 卡片发射（`messages.append` + `publishMessage`）、内存资源登记（TTL 30min / 64 个）、host 派生 `app-{sha256-24}` |
| `apps/desktop/src/main/apps-ui.ts` + `main/index.ts:284-287` | 协议处理器通用 `(host, resourceId)` → `coreHost.callPlatform('apps.ui.resource')`；分流点即此处 |
| `apps/desktop/src/main/apps-ui-policy.ts` | `parseAppUiUrl` host 校验 `/^[a-z0-9-]{1,63}$/`——`widget-{hash24}` 可直接通过，协议与解析零改动 |
| `apps/desktop/src/renderer/.../MessageBubble.svelte:71-79,168-172` | 卡片调度层已有 `mcp_app` 分支 → `McpAppCard.svelte`（审查态、iframe、关闭清理照抄其骨架） |
| `packages/core/src/tools/index.ts:979-1046` | turn 只读面 / task 全量面；widget 工具只挂 task 面 |
| `packages/core/src/rpc/apps-ui-bindings.ts` + `start.ts:2255-2258` | `app`/`platform` 两类方法绑定与汇入 `services.appMethods` 的方式 |
| `packages/core/migrations/main/` | 已到 `0027_egress_approval.sql`；widget 表占 `0028` |
| i18n | 仅 `zh-CN.ts` 一个语言包 |

## 3. 设计

要点全部记录在 [docs/design/32-bot-widgets.md](../docs/design/32-bot-widgets.md)（数据模型、信任模型、渲染管线、能力桥、安全清单、分期、不做清单），此处不重复。实施期新增决定记 §7。

## 4. 实施顺序与清单

### P0 骨架
- [x] shared：`domain/widgets-ui.ts`（常量、`widgetCardSchema`、`widgets.ui.open/close/source` 与平台 `widgets.ui.resource` 的 in/out schema）+ `types.ts` 卡片字段 `widget` + `ids.ts` `wgt_` 前缀 + 包导出
- [x] core：迁移 `migrations/main/0028_widgets.sql`（widgets / widget_versions / widget_docs）
- [x] core：`widgets/service.ts`（create/update 落库发卡、source/open/close/resource、deleteForBot）+ `widgets/resource-store.ts`（host 派生 `widget-{hash24}`）+ 删除级联（会话删除走 conversations FK；Bot 删除经 lifecycle `widgets.prepareBotDeletion`）
- [x] core：`tools/widget-tools.ts`（`widget_create` / `widget_update`，TypeBox 参数）+ `tools/index.ts` task 面挂载 + orchestrator（deps/toolDeps/renderCard 固定文案）接线
- [x] core：`rpc/widgets-ui-bindings.ts`（app + platform）+ `bindings.ts` / `start.ts`（`createPlatformMethods`）注册
- [x] desktop main：`main/index.ts` `fetchResource` 按 `host.startsWith('widget-')` 分流 `widgets.ui.resource`
- [x] renderer：`features/widgets/BotWidgetCard.svelte`（审查态 / 源码查看 / sha256 确认记忆 / iframe 挂载与清理）+ `MessageBubble.svelte` 分支 + i18n（zh-CN）
- [x] system prompt：任务平台规则加 widget 一条（`system-prompt.ts`）
- [x] 文档回写：`docs/design/32`（已建）、`docs/design/README.md`（索引 + D81）、`docs/dev/03-data-model.md`（三表 + 级联表两行）、`docs/dev/04-agent-runtime.md`（工具目录）、`docs/dev/PROGRESS.md`（验收证据）

### P1 能力桥
- [ ] `BotWidgetCard` 内 postMessage 宿主桥（关联 id、只信 `event.source`）
- [ ] `widgets.ui.storage`（KV get/set/delete/list，配额 1MB / 1000 键，限速）+ widget 侧注入 `window.kepcup` 垫片（core 服务 HTML 时前置 `<script>`）
- [ ] `widgets.ui.openLink`（复用 McpAppCard 确认条模式）

### P2 结构化数据与资产
- [ ] 命名只读查询模板：工具参数 `queries`、版本内登记、`widgets.ui.query`（`prepare` + `stmt.readonly` 校验 + 行数上限）
- [ ] `scope='bot'` 组件管理入口（列表 / 删除 / 跨对话引用）

## 5. 测试

- core 单元：`widgets-service.test.ts`（create/update 落库与发卡、版本只增、上限、open/resource 的 host 校验与 TTL、会话删除级联）、`widget-tools.test.ts`（参数校验、体积上限、每 run 卡数、返回文案）
- 迁移测试：0028 建表与 FK 级联（对齐既有迁移测试写法）
- shared：schema 往返（卡片 content 解析）
- renderer：`BotWidgetCard` 组件测试（审查态 → 确认 → iframe、源码查看、错误态），对齐 `McpAppCard` 既有测试（如有）
- 手工验收脚本：让 Bot 写一个计算器组件 → 对话内加载操作 → 重启重开 → `widget_update` 出新卡、旧卡仍旧版

## 6. 本期不做

见设计 32 §10（无网络 / 无 fs / 无 core 内执行生成 JS / 无 raw SQL 透传 / 无组件市场 / 无人值守不自动加载）。

## 7. 实施记录

### 2026-10-11（分支 `t/d73-connected-apps`）

- 方案定稿，设计 32 与本执行文档落笔。P0 全量实现完成。
- 实现期决定（均已回写设计 32 / dev 03）：
  - **Bot 删除不走 FK**：`lifecycle.deleteBot` 对 bots 行是改占位（`markDeleted`），`widgets.bot_id` 的 `ON DELETE CASCADE` 实际不会触发——Bot 级联改为 lifecycle 新增 `widgets.prepareBotDeletion` → `WidgetService.deleteForBot` 显式清三表；会话删除（conversations 行物理删除）保持 FK 级联。迁移里的 FK 保留作兜底。
  - 卡片消息经 `MessagesService.append` 新参 `cardWidget` 落 `content.widget`（与 `appUi` 同构）；`renderCard` 对 `bot_widget` 只回一行固定文案，HTML 不进上下文。
  - 协议复用零改动兑现：widget host = `widget-{sha256(widgetId).slice(0,24)}`，直接通过既有 `parseAppUiUrl` 校验；主进程只在 `fetchResource` 里按 host 前缀分流到平台方法 `widgets.ui.resource`（与 `apps.ui.resource` 同形，复用其 schema）。
  - widget 响应头 CSP = `buildAppCspHeader` 空域输出（`connect-src 'none'`，禁网），比 MCP Apps 更严；无逐应用 CSP 声明。
  - `widget_create` 的 `description` / `widget_update` 的 `changeNote` 允许为空（初版误用了非空校验，测试暴露后改 `#redactText`）。
  - P0 无能力桥：iframe 固定高 380px（内部滚动），组件内没有 `window.kepcup`；审查态 localStorage 键 `kepcup.botWidget.consents.v1`（sha256 → true，容量 200 有界）。
- 验证：core 定向测试 `widgets-service.test.ts`（8）+ `widget-tools.test.ts`（3）、`create-core.test.ts`（迁移 user_version=28 + 三表，9）、`supervisor-turn.test.ts`（21）、`context-assembly` / `app-prompt-capabilities` / `memory-retrieval`（37）、`schedule.test.ts` 删除级联抽查（2）全绿；shared / core / desktop（含 svelte-check）typecheck 干净；改动文件 eslint 干净。**收口全量一次**（3697 例）：5 处失败逐一甄别——
  - `public-skills-migration`（1）：该测试的「回拨重放」模式需手动摘除每个新迁移的对象，补 drop widget 三表后复绿（2/2）。**本功能引入，已修**。
  - `tasks-review-fixes-f` L-1（1）：并行会话新增的 `task_setup_dismissed` 对话轮规则文本含「任务卡」，抢了测试里 `.find((line) => line.includes('任务卡'))` 的命中——谓词加「忽略以上规则」特征锁定卡片行后复绿（6/6）。**并行改动引入，已做最小修复**（本功能的规则文本无「任务卡」，无关）。
  - `sign-connector-index`（1）：脚本入口守卫 `process.argv[1]` 与 `import.meta.url` 直接比较，macOS 临时目录在符号链接下（/var → /private/var）realpath 不一致，复制到 tmpdir 的脚本静默不执行——HEAD 基线同样失败，**环境性既有问题**；顺手在脚本里做了 realpath 比较（3 行），复绿（12/12）。
  - `external-agent-p3` lease（1）：与并行会话当时提交到一半的工作区状态相关，其提交完成后复绿（13/13）。**与本功能无关**。
  - `environment.test` checksum（1）：HEAD 基线（干净 worktree）同样失败、`-t` 单测过滤下通过（用例间时序敏感），**本机既有 flake**，不属本功能，未修（留观察）。
- 分支树上并行会话的媒体路由修复已由其自行提交（4469019 等）；`shared` / `core` 的 dist 重建已执行（含两批改动），**重启应用**后同时生效。
