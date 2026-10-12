# Bot 自制交互组件（Bot Widgets）：实施方案

> 状态：**P0–P2 已完成**（2026-10-11）；后续 P3（组件制作流程）/ P4（交付形态分层）见 [todo/bot-widgets-authoring.md](bot-widgets-authoring.md)（D87，2026-10-12 定稿）。原始拍板（2026-10-11；用户拍板：Bot 写的单文件 HTML 组件直接在对话里加载供用户操作，持久化借 core 的 better-sqlite3 由宿主能力桥提供；复用 D73 P3 MCP Apps 管线 + 低信任层，不把 Node 交给生成代码）。
> 决策编号 **D81**；设计事实见 [docs/design/32-bot-widgets.md](../docs/design/32-bot-widgets.md)。
> 分支：`t/d73-connected-apps`（已合入 main；树上当时另有未提交的媒体路由修复，属其他任务）。
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
- [x] `BotWidgetCard` 内 postMessage 宿主桥（关联 id、只信 `event.source`）
- [x] `widgets.ui.storage`（KV get/set/delete/list，配额 1MB / 1000 键，限速）+ widget 侧注入 `window.kepcup` 垫片（core 服务 HTML 时前置 `<script>`）
- [x] `widgets.ui.openLink`（复用 McpAppCard 确认条模式）
- [x] `kepcup.theme()` / `setHeight(px)`（设计 32 §6 表内免审项；高度夹取 [100, 800]，未上报缺省 380px）

### P2 结构化数据与资产
- [x] 命名只读查询模板：工具参数 `queries`、版本内登记（0029：`widget_queries` 表 + `widget_versions.queries_sha256`）、`widgets.ui.query`（`prepare` + `stmt.readonly` + 首关键词 SELECT/WITH 双门槛 + 行数上限 200 截断）
- [x] `scope='bot'` 组件管理入口（Bot 详情「组件」Tab：列表 / 删除 / 发到当前对话；跨对话引用 = `widget_publish` 工具 + `widget_update` 解禁到任意对话——形态经用户确认）

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

### 2026-10-11（同日，P1 能力桥）

- P1 全量实现（设计 32 §6 落地细节已回写，要点）：
  - **桥协议**：widget → 宿主 `{source:'kepcup-widget', id, type, payload}`（方法白名单 `storage.get/set/delete/list`、`openLink`、`theme.get`、`setHeight`；setHeight 是通知无回执），宿主 → widget `{source:'kepcup-host', id, ok, value?/error?}`。renderer 侧纯校验在 `widget-bridge-guard.ts`（来源标记 / 白名单 / 关联 id / 1MB 体积上限 / 高度夹取），`WidgetBridgeHost` 持唯一来源防线 `event.source === frameWindow`（opaque origin 下 `event.origin` 恒 "null" 不能当凭据），每个请求恰好回执一次。
  - **KV**：`widgets.ui.storage` 是 op 判别 union（get 带 `found`/`value`，set/delete 幂等，list 按键序）；service 以 resourceId 反查资源定 widgetId 命名空间，值存 `widget_docs.value_json`（JSON 文本）；限速加在 `WidgetResourceStore.tryAcquireCall`（复刻 `UiResourceStore` 的 1s 滚动窗口 + 在途上限，所有 op 都计）。数据在库里、资源在内存：资源过期重开卡片（新 resourceId）数据仍在，重启应用亦然。
  - **垫片**：静态 `<script>`（`sdk-injection.ts` 的 `WIDGET_SDK_SHIM`），promise 化 + 关联 id，不设超时（宿主对每个带 id 的请求保证恰好一条回执，iframe 销毁时挂起的 promise 随上下文消亡）；插入点 head 优先 → doctype 后 → 文档开头（quirks-mode 防线，见 design 32 §6）；`open()` 登记垫片版 HTML，`source()` 仍回原文，注入幂等（唯一指纹 `kepcup-widget-sdk-v1`）。
  - **外链**：renderer `normalizeAppLink`（复用 apps-ui 的 bridge-guard 纯函数）→ 卡内确认条（`pendingLink` 单例 + 5s 冷却，testid `bot-widget-link-*`）→ `widgets.ui.openLink` → core 再核 https/无凭据 → 主进程 `shell.openExternal`（`WidgetServiceDeps` 新增 `shell`）。
  - **theme / 高度**：theme 建桥时一次性读取（mode-watcher），不推送变更（组件需要可自行轮询）；`setHeight` 夹取 [100, 800]（`BOT_WIDGET_HEIGHT_MIN/MAX`），未上报缺省 380px（P0 行为兜底）。
  - **错误码**：新增 `WIDGET_RESOURCE_EXPIRED` / `WIDGET_RATE_LIMITED` / `WIDGET_STORAGE_QUOTA`（errors.ts + zh-CN `chats.errorCode.*`）；footer 能力文案从「不保存任何数据」改为「数据仅保存在本机（每组件独立）」；`widget_create`/`widget_update` 的 HTML 指南与任务平台规则同步写明 `window.kepcup` 能力与配额。
- 验证：`widgets-service.test.ts` 扩到 20 例（KV 往返 / 命名空间隔离 / 重开数据仍在 / 单值与总配额与键数上限 / 限速窗口 / resourceId 过期 / openLink https-only / 垫片注入点与幂等 / doctype 不被顶走）；desktop `widget-bridge-guard.test.ts`（5 例：白名单 / 形状 / 体积 / 回执形状 / 高度夹取）全绿；`widget-tools` / `supervisor-turn` / `context-assembly` / `app-prompt-capabilities`（提示词文案变更波及面）回归绿；shared / core / desktop（svelte-check 0 错误）typecheck 干净；改动文件 eslint 干净。收口全量一次的甄别结论见 PROGRESS。

### 2026-10-11（同日，P1 独立审查修复轮）

- 两个独立审查（安全与正确性 / 工程质量）结论：无 P0；安全边界（`event.source` 唯一防线、免审批理由、垫片无拼注入面、原型链键无汇聚点、openLink 三道闸）逐项确认成立。按「长期收益最大化」修复全部 P1/P2 与可低风险落地的 P3：
  - **挂起缝隙**（P1）：桥拒收但 id 可解析的消息此前静默丢弃，垫片 promise 永久挂起（BigInt 值、>1MB 消息可达）——宿主现在回 `{ok:false, error:'不支持的消息格式', code:'INVALID_INPUT'}`，「每请求恰好一回执」成为可测试的完整契约（`widget-bridge-host.test.ts`）。
  - **错误回执带机器可读 code**：`WidgetBridgeReply` 增 `code?`（透传 AppError.code），垫片 reject 的 Error 带同名属性；key 超长在宿主前置拒（可行动中文，不再漏 zod 泛化英文）；`widget_create`/`widget_update` 指南写明四个 code 的语义。
  - **垫片可演进性**（P1）：高度常量从 shared 插值（不再双份）；幂等指纹改唯一标记 `kepcup-widget-sdk-v1`（原标记是协议字段值，Bot 照抄文档即可误触跳过注入）；新增 `sdk-injection.test.ts`（10 例）在 node 里真实执行垫片——promise 配对、code 透传、来源校验、requireKey、setHeight 夹取（含数字字符串宽松接取的行为钉子）、幂等早退。guard 白名单测试改为遍历 `WIDGET_BRIDGE_METHODS` 本体（协议单一事实源）。
  - **setHeight 节流**（P2）：复用 apps-ui 的 `createThrottle(100ms)`，rAF 连发不再逐帧重排版（假时钟测试覆盖折叠行为）。
  - **注入点已知失效模式钉住**：`<head>` 在注释/属性里时垫片被吞（自伤、无副作用）——行为用例钉住防意外变化，模块注释明示不做廉价探测。
  - **KV 写入重写**：`#docsUsage` 全量载入改为「存在性单查 + count/sum 聚合」两条 SQL；set 分支抽 `#storageSet`；`JSON.stringify ?? ''` 的语义错误改显式 INVALID_INPUT；新增库行 value_json 损坏 → get 按不存在且可覆盖修复的用例。
  - **纵深与健壮性**：`resource()` 补 host 派生二次校验（同 apps.ui.resource）；reload/stop 复位卡片高度；测试魔数 `now += 1100` 收敛为 `advance(RATE_TICK_MS)`。
  - **UI 去重**：外链确认条抽 `LinkConfirmBar.svelte`（安全 UI 单一实现，McpAppCard / BotWidgetCard 共用，文案经 props 传各自 i18n）。
  - **测试基建**：`WidgetBridgeHost` 监听目标可注入，新增协议级测试（来源防线 / 回执契约 / code 透传 / 节流 / destroy），无需 DOM。
  - **文档**：inflight 上限如实标注「预留」（当前全同步不生效）；todo「15s 超时」草稿措辞纠正；dev/03 `widget_docs` 补 P1 写入方与配额。

### 2026-10-11（同日，P2 结构化数据与资产）

- P2 全量实现（设计 32 §3/§4/§6/§7 已回写，要点）：
  - **查询模板**：迁移 `0029_widget_queries.sql`（`widget_queries` 表，主键 (widget_id, version, name)）+ `widget_versions.queries_sha256` 列（该版本模板清单按名字序 JSON 的 sha256，无模板空串）。工具参数 `queries`（create/update 都收，每版本**全量快照**：不传 = 该版本没有查询），交付侧校验：形状 / 名字唯一（`[A-Za-z0-9_-]{1,64}`）/ ≤20 条 / SQL ≤64KB / **prepare + 只读门槛**——`stmt.readonly` 且首关键词必须 SELECT/WITH（`sqlite3_stmt_readonly` 对 `pragma foreign_keys=off`、`attach` 等也返回 true，连接级副作用必须挡在门外；prepare 编译顺带暴露语法错与表不存在，Bot 交付时即得可行动报错）。
  - **运行时 `widgets.ui.query`**：resourceId 反查资源拿 widgetId + **卡片钉住的 version**（旧卡永远用旧模板），取该版本模板执行；运行时对库行再跑同一只读门槛（防外力改动）。参数只允许 JSON 标量（boolean 归一 1/0，对象/数组/undefined 拒绝），better-sqlite3 缺名参数报错人话化（`缺少参数「x」`）。行数上限 200（`BOT_WIDGET_QUERY_ROWS_MAX`）迭代即断并标 `truncated`；**超时无法真中断**（better-sqlite3 同步执行、core 单线程），扫描耗时以人工预审为主要边界——design 32 §6 与 service 注释均已写明。行值归一 JSON 安全（BLOB → base64 字符串）。错误码登记三件套：`WIDGET_QUERY_UNKNOWN`（该版本没登记此名）/ `WIDGET_QUERY_FAILED`（参数不符 / 编译失败 / 执行出错）。
  - **确认指纹覆盖查询**：卡片描述符新增 `queriesSha256` / `queriesCount`（zod default 兼容旧卡），open/source 的完整性校验扩到 `queries_sha256`；渲染端确认记忆键改为 `sha256|queriesSha256`——HTML 不变、仅查询变化的新版本同样要求重新确认（P1 时代的旧确认失配、多确认一次，安全方向）。
  - **管理入口**（形态经用户确认：Bot 详情右栏新「组件」Tab + `widget_publish` 工具）：RPC `widgets.list`（该 Bot 全部组件 + 最新版本信息，按更新时间倒序）/ `widgets.delete`（botId 校验后清四表 + `store.removeForWidget` 摘除在途资源，已挂 iframe 下一次桥调用即 `WIDGET_RESOURCE_EXPIRED`，历史卡片按版本已不存在优雅报错）/ `widgets.publish`（Bot 级组件最新版发卡到指定对话）。`RightPanel` 新 Tab 渲染 `WidgetsTab.svelte`（跨对话资产在上带「发到当前对话」，会话级分组在下，删除两步确认同 SchedulesPanel 先例）。
  - **跨对话引用**：`widget_update` 解禁——Bot 级组件（conversation_id 为 NULL）可在任意对话更新，新卡发到当前对话（`WidgetUpdateInput.conversationId`）；会话级组件仍固定发回归属对话。新工具 `widget_publish{widget_id}`：只认 `scope='bot'` 且属于本 Bot，不落新版本、钉最新版发卡，受每 run 8 张上限约束。`WIDGET_HTML_GUIDE` / system prompt 规则 / dev 04 工具目录同步更新。
  - **inflight 措辞按实际修正**：query 落地后所有能力桥调用（storage / query）依然在 core 单线程同步执行（acquire→release 无 await），`BOT_WIDGET_CALLS_INFLIGHT_MAX` 是纵深防线、未触达——resource-store 注释与 design 32 §6 不再说「为 P2 预留」。
- 验证：`widgets-service.test.ts` 扩到 33 例（模板登记与摘要 / 交付只读门槛全矩阵含 PRAGMA/ATTACH/WITH-INSERT/多语句 / 版本钉住换模板 / 参数归一与缺参 / 行数截断 / 限速与过期 / 摘要不一致 WIDGET_INVALID / list/delete/publish）；`sdk-injection.test.ts` 12 例（query 请求形状与 params 缺省 / code 透传 / 前置校验不发消息）；desktop `widget-bridge-host.test.ts` 12 例（query dispatch / 名字与 params 前置拒 / 错误码透传）；`widget-tools.test.ts` 9 例（queries 透传与归一 / publish 工具）；`create-core.test.ts`（user_version=29 + `widget_queries`）与 `public-skills-migration`（回拨摘除 `widget_queries`）复绿；`supervisor-turn` / `context-assembly` / `app-prompt-capabilities`（提示词波及面）回归绿；shared / core / desktop（svelte-check 0 错误）typecheck 干净；改动文件 eslint 干净。收口全量一次的甄别结论见 PROGRESS。

### 2026-10-11（同日，P2 独立审查修复轮）

- 双审查（安全与正确性 50+ 真实探针 / 工程质量）结论：无 P0，只读门槛与信任模型零绕过。修复清单（证据与探针见 PROGRESS 同名段）：
  - query 回执补**字节上限**（`BOT_WIDGET_QUERY_RESULT_MAX_BYTES` = 1MB，对齐桥入站上限；行数约束不了行宽，溢出行不返回）；
  - `deleteForBot` 补摘在途资源（否则存活 iframe 30 分钟内打到已消失的库行、KV 写收裸 SQLite 英文错误）；
  - bigint 参数超 ±2^53 拒绝（better-sqlite3 按 double 绑定会静默失真），指南注明结果侧大整数列降精度；
  - `:__proto__` 命名参数交付时即拒（对象键赋值是原型操作，运行时必败但人审会放行）；
  - `#pinnedVersion` 对 `widget_queries` 现行内容**复算摘要**（堵「只改模板内容、版本行摘要不动」的审查对象偷换）；
  - `WidgetWriteResult` 补 `title`，修 publish 发卡失败分支的占位文案错乱；`widgets.publish`/`widgets.delete` 的 UI 路径不再假报成功（检查 ok 与 cardMessageId，发卡失败 toast.warning）；审查态提示按是否声明查询分支（消除安全文案自相矛盾）；
  - `listForBot` sizeBytes 改字节口径（`length(cast(v.html as blob))`）；WidgetsTab 复用 `formatBytes`。
  - 裁决不加：`widgets.changed` 事件、publish RPC 配额、`#gateReadonlyQuery`/query() 双查收敛（错误语义不同）。工作区另有并行会话的 34-supplier.md（D83），提交时拆分。
- 验证：`widgets-service.test.ts` 37 例、`widget-tools.test.ts` 9 例全绿；三包 typecheck 干净（svelte-check 仅既有 warning）；改动文件 eslint 干净；收口全量一次（甄别见 PROGRESS）。
