# P2 包、数据与生命周期

> 设计依据：55 号 §4.1/§4.3（多文件包）、§8.5（context.update）、§9（生命周期 / 崩溃 / 诊断回流）、§10（数据平面 / query 分页）、§14 P2、§15 验收第 7、13、14、16、17 条。
> 验收：多文件微应用可加载（相对资源 / 子目录 / 资产配额）；关闭重开恢复进度；崩溃不拖垮宿主 + 作者收 ≤300 字诊断（同 code 当天不重复）；`context.update` 摘要可见可清除、自由文本被拒；`query` 游标翻页。

## 任务清单

### 1. 多文件包

- [ ] 迁移 `micro_app_files`（widget_id+version+path 主键，mime/bytes/content BLOB）；随版本修剪删除；配额 8MB / 64 文件 / 单文件 1MB。
- [ ] `widgets.ui.resource` / 协议源支持相对路径子资源（`..`、绝对、跨微应用拒绝；路径规范化防穿越）；create/update 接受 files 清单（craft P3 才用，P2 服务层 + 管理页可先验）。
- [ ] `bundle_sha256` 扩展为全文件摘要（P0 已按路径排序规范化，P2 补文件内容）。

### 2. collections 与 query 分页（55 §10）

- [ ] `kepcup.collections.*`（文档 + 主键 + 简单索引；底层 `widget_docs` 前缀键或新表——实现时按 55 §10「底层同表或新表」择优，5MB / 10 集合）；能力 `storage.collection` 生效。
- [ ] `query` 增 `cursor` / `maxBytes`（单次 ≤256KB，`{rows, truncated, nextCursor}`）；现有调用零变化（不传 = 旧行为）。

### 3. 生命周期（55 §9）

- [ ] 会话恢复：`app.pause`（窗口最小化 / 切走）→ 微应用写 `session:` 前缀 KV；重开读回（SDK 侧约定 + 模板示范）；`app.resume`。
- [ ] 崩溃恢复：iframe `error` / 心跳 3s 无响应 → 「微应用无响应」+ 重新打开入口（不自动重试）；诊断记 `run` phase。
- [ ] `context.update`（55 §8.5）：结构化摘要（headline ≤80 字 + data ≤1KB）→ 存对话 / 卡片状态，`<untrusted source="micro-app-context">` 注入下一轮；last-wins；用户手势或 pause/close 才接受；卡片 / 管理页显示 + 一键清除；撤销能力即清空；能力 `context.update` 生效。

### 4. 运行时诊断回流（55 §9.4）

- [ ] 迁移 `micro_app_diagnostics`（主键 widget+version+day+phase+code；只记 code/detail(≤200 字栈顶)/count/时间，不记 message）；按天修剪 30 天 + 版本修剪级联。
- [ ] 采集：崩溃 / 桥拒绝（`MICRO_APP_*`）/ 垫片 `window.onerror` / `unhandledrejection`（错误类型名 + 栈顶帧——单行注入保证行号即作者原文）/ `CAPABILITY_NOT_CONFIGURED`。
- [ ] 投递：同 `(version, code)` 首次 → 来源会话（`widgets.conversation_id`）一条 ≤300 字系统消息（每天 ≤1 条；来源会话 NULL / 已删 → 只按需读）；`micro_app_diagnostics_read` 工具（Bot 任务面只读，最近 24h 聚合，上限 + 截断标记）；不进运行对话。
- [ ] `micro_app_audit`（55 §12.3）：能力 / 结果 / 时长，不记内容。

### 5. 微应用管理页（55 §14 P2）

- [ ] Bot 详情「微应用」Tab（承接现有「组件」Tab 扩展或并排——按代码现状定）：列表 / 能力 / 网络档位（open 显示「未限制」）/ 用量（`micro_app_usage` 按 Bot 聚合）/ 运行问题（次数 + 已通知作者）/ 摘要（context.update）/ 删除 / 发到当前对话 / 版本回退（next_version 指回，被修剪拒绝并回执写明）。

### 6. 测试与收口

- [ ] core：files 配额与路径穿越拒绝；collections CRUD + 配额；query 游标；context.update 边界（自由文本 / 循环刷写 / last-wins / 清除）；诊断采集 / 修剪 / 每日一条 / 按需读；审计。
- [ ] renderer：恢复流、崩溃 UI、管理页数据面。
- [ ] 收口：定向 + 全量一次；子代理审查一轮。

## 实施记录（2026-11-04）

### 交付内容

- **迁移 `0069_micro_app_p2.sql`**：`micro_app_files` / `micro_app_collections` / `micro_app_context` / `micro_app_diagnostics` / `micro_app_audit`（全部 FK 级联 + 前缀；诊断按天 + 版本；public-skills 回放夹具同步摘表）。
- **多文件包**：`WidgetService.create/update` 增 `files`（路径安全 / 单文件 1MB / 包 8MB / 64 文件 / 与入口不冲突）；`micro_app_files` 随版本修剪；`widgets.ui.resource` 按 `path` 取包内文件（二进制 contentBase64 + MIME）；主进程协议解析扩 `/{resourceId}/{path}`（段白名单 + `..` 拒绝）与二进制响应分支；`appsUiResourceInputSchema` += path、output += contentBase64/mimeType（html default ''，MCP 应用路径零变化）。
- **collections**（55 §10）：`MicroAppStore`（widget_id 命名空间、5MB / 10 集合配额、where 过滤 eq/ne/gt/gte/lt/lte/exists、limit ≤200）；桥方法 `collections.*` → RPC `microApps.collections.*`；垫片 `kepcup.collections` 面。
- **context.update**（55 §8.5）：结构化摘要（headline ≤80 / data ≤1KB，strict schema 拒自由文本字段）；last-wins 存 `micro_app_context`；`buildConversationContext` 注入 `<untrusted source="micro-app-context">`（标注作者内容非指令）；**gesture 时机在桥宿主核用户激活**（防循环刷写；pause/close 由宿主发起）；卡片（preflight.contextHeadline）与管理页可见可清除；`microApps.clearContext`。
- **query 分页**（55 §10）：`cursor`（`off:{n}`）+ `maxBytes`（1024B–256KB）；分页时内部放宽到 1000 行再按字节切片；不传 = 存量行为零变化（无 nextCursor）。
- **诊断回流**（55 §9.4）：垫片挂 `error`/`unhandledrejection` → `app.reportError`（code=异常类型名、detail=栈顶帧，**不收 message**）；桥宿主能力拒绝 / MICRO_APP_* 错误回调 `onDiagnostic`；渲染端限流（同 code:detail 一分钟一条）→ `microApps.diagnostics.record`（upsert 计数）；同 (widget, version, code) 当天首次 → 来源会话一条 ≤300 字系统消息（`pushDiagnosticMessage`）；Bot 任务面工具 **`micro_app_diagnostics_read`**（24h 聚合，≤50 条 + 截断标记）；管理页「运行问题」；`pruneDiagnostics`（30 天，启动 + 记录时顺带）。
- **生命周期**（55 §9.1/§9.2）：心跳（10s ping → 两拍无 ack 判 `MICRO_APP_UNRESPONSIVE` →「微应用无响应」+ 重新打开，不自动重试）；`visibilitychange` → `app.pause` / `app.resume` 事件（会话恢复 = SDK 约定：微应用在 pause 写 `session:` 前缀 storage，重开读回——P3 模板示范）。
- **管理入口**（55 §14）：`microApps.list`（清单 / 双指针 / 今日用量 / 24h 诊断 / 摘要）、`microApps.rollback`（被修剪版本拒绝）、`microApps.clearContext`；渲染端 BotWidgetDetail 增微应用管理段（网络档位 / 用量 / 运行问题 / 摘要清除 / 两步回退）。
- **能力面**：`MICRO_APP_RUNTIME_PHASE` → P2；`storage.collection` / `context.update` 进已实现集合；spec 增 `collections.*` / `context.*` / `app.reportError` 桥方法。

### 测试证据

`packages/core/test/integration/micro-app-p2.test.ts` 7/7（文件落库 + path 子资源字节一致 + 穿越/未登记拒绝、不安全路径交付拒绝、collections CRUD/query/配额外能力拒绝、context last-wins + 注入断言 + 自由文本字段拒 + 清除、诊断计数聚合 + 系统消息 1 条 + 异 code 再推 + 表无 message 列、管理列表/回退/被修剪拒绝、query 分页两页不重叠 + 不传零变化）。定向回归 77 文件 972 通过 / 1 跳过；typecheck 0 错误。

### 偏差与遗留

1. `micro_app_audit` 表已建、`context.update` 已写审计行；ai/media 路径的审计在 P2 收口时未全量接线（记 P3 审查跟进项）。
2. 会话恢复的持久化是 SDK 约定 + P3 模板示范（平台不代存 DOM，55 §9.2）。
3. 崩溃检测用心跳（10s 粒度），不是 3s 精确判据——iframe error 事件在 Chromium 不可靠，取舍记录在案。
