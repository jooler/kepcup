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

## 实施记录

（阶段收口时填写。）
