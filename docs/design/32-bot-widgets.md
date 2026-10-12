# 32. Bot 自制交互组件（Bot Widgets）

Bot 在任务里自己写一个**单文件 HTML 交互组件**（下称 widget），作为卡片消息落在对话里，用户点「加载」即可在气泡内操作（计算器、追踪器、小仪表盘、小游戏……）。组件的持久化不靠生成代码自己拿运行时，而是由宿主提供的能力桥完成——能力最终落在 core 进程的 better-sqlite3 上。生成代码**永远拿不到** Node、文件系统、网络与宿主页面。

决策编号 **D81**。执行文档见 [todo/bot-widgets.md](../../todo/bot-widgets.md)。

## 1. 调研事实（同类产品的共识做法，2026-10-11）

| 产品 | 做法 |
|---|---|
| Claude Artifacts / ChatGPT Canvas | Bot 生成的单文件 HTML/React 渲染在 `<iframe sandbox="allow-scripts">`（不透明 origin）；与宿主只走 postMessage；**不给任何后端能力** |
| OpenAI Apps SDK（ChatGPT 内应用） | 开发者预制 widget + MCP 工具；iframe 内注入 `window.openai` 桥：`callTool()` 绕过模型直调 MCP server，`setWidgetState()` 让状态跟随会话；「沙箱 UI + 窄桥调受控后端」 |
| MCP Apps（开放标准） | 服务器经 `ui://` 资源下发 HTML，客户端沙箱 iframe 加载，`_meta.ui.visibility` 声明界面可调用的工具，调用走与模型相同的审批路径 |
| LobeChat 插件 / 各家代码解释器 | iframe 沙箱 + postMessage；或服务端沙箱执行只回传结果 |

结论：**生成代码一律跑在 `sandbox="allow-scripts"` 的不透明 origin iframe 里，能力全部经窄桥由宿主代为执行**。没有任何产品把宿主运行时（Node / 文件系统 / 数据库连接）直接交给生成代码。

## 2. 信任模型

KepCup 现有三类第三方/生成内容，信任级从高到低：

| 来源 | 载体 | 约束（既有） |
|---|---|---|
| 目录签名连接（D73） | 远程 server 的 `ui://` HTML | `uiAllowed` 白名单、逐应用 CSP（可声明网络域）、工具调用走网关审批 |
| MCPB 本地包（D73） | zip 解包的 server 代码 | sha256 校验、zip-slip 加固、安装审批 |
| **Bot 生成的 widget（本期）** | LLM 输出的 HTML 字符串 | **最低信任**：不透明 origin iframe、**默认禁网**（无 CSP 连接域）、**按版本人工确认**、HTML 不进模型上下文、每 run 发卡上限 |

因此 widget 复用 MCP Apps 的机械管线（协议、iframe、资源登记、CSP 构造、卡片调度），但**不复用其信任策略**（不伪装成本地 MCP server：那会被 `uiAllowed` 拒绝，且缺版本化与按版本审查）。

明确否决的替代方案：

- `<webview>`/BrowserWindow + `nodeIntegration` 跑生成代码：对话内任意提示词注入即成对整机的 RCE；违背「renderer 零 Node、core 唯一持库」的架构（07）。
- core 进程内以 `node:vm` / isolated-vm 执行 Bot 写的 JS：`node:vm` 不是安全边界；core 只跑可信代码是不变量。
- 运行时透传 raw SQL 到 better-sqlite3：注入面不可控；结构化查询改为「创建时人工预审的命名只读查询模板」（§6）。

## 3. 数据模型（main.db `0028_widgets.sql` + `0029_widget_queries.sql` + `0032_widget_limits.sql`）

```sql
-- widgets：组件本体（元数据 + 最新版本号）
CREATE TABLE widgets (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,  -- scope='bot' 时为 NULL
  scope            TEXT NOT NULL DEFAULT 'conversation' CHECK (scope IN ('conversation','bot')),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  latest_version   INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- widget_versions：每个版本一份完整 HTML，只增不改（旧消息卡片钉住旧版本）；
-- queries_sha256（0029）是该版本查询模板的摘要（无模板为空串），审查指纹的一部分。
CREATE TABLE widget_versions (
  widget_id    TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  html         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  queries_sha256 TEXT NOT NULL DEFAULT '',   -- 0029：查询模板摘要（按名字序 JSON 的 sha256）
  size_bytes   INTEGER NOT NULL DEFAULT 0,  -- 0032：HTML 的 UTF-8 字节数（存量回填；列表与配额只读这一列）
  queries_reviewed_at INTEGER,              -- 0032：含模板的版本被用户展开审查 SQL 的时间（open 的预审强制）
  created_by_run TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (widget_id, version)
);

-- widget_queries（0029）：命名只读查询模板，随版本登记（版本 = HTML + 查询的完整快照）
CREATE TABLE widget_queries (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  sql        TEXT NOT NULL,
  PRIMARY KEY (widget_id, version, name)
);

-- widget_docs：每个组件命名空间的 KV 文档存储（能力桥 P1 落地，表先行）
CREATE TABLE widget_docs (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (widget_id, key)
);
```

- 卡片消息**只存描述符**（widgetId、version、title 等），不存 HTML——与 `appUi` 卡「不含 HTML、不含令牌」同约定；旧卡永远指向其产出时的版本。
- **存量上限（0032 起）**：每 Bot 至多 `BOT_WIDGET_PER_BOT_MAX`（100）个组件、全部版本 HTML 合计至多 `BOT_WIDGET_BOT_BYTES_QUOTA`（64MB），超限 `widget_create` / `widget_update` 得 `WIDGET_LIMIT`（给 Bot 的说明指向 widget_update 与管理 Tab 的删除）；每个组件只保留最近 `BOT_WIDGET_VERSIONS_KEPT`（20）个版本，`widget_update` 落新版本时同事务修剪更早的版本行与其查询模板（`widget_queries` 没有指向版本行的外键，两表一起删），钉着被修剪版本的旧卡加载时得「这个版本的组件已不存在」。每 run 8 张卡只防刷屏，挡不住循环 run 往库里无限写 2MB HTML，存量上限补的是这一侧。
- 删除级联：**会话删除** → `scope='conversation'` 的组件随 `conversations` 行 FK 级联清除；**Bot 删除** → bots 行改占位、FK 不触发，由 `lifecycle.deleteBot` 经 `WidgetService.deleteForBot` 显式清除该 Bot 全部四表（登记 `docs/dev/03-data-model.md` 级联表）。`scope='bot'` 的组件跨对话存活，直到 Bot 删除或用户在管理界面删除（P2）。

## 4. Bot 侧工具（task 面）

| 工具 | 参数 | 行为 |
|---|---|---|
| `widget_create` | `title`(1–120)、`description`(给用户的一句话)、`html`(单文件 HTML，≤2MB)、`queries`?(P2：命名只读查询模板清单，随版本全量快照)、`scope`?(`'conversation'`缺省/`'bot'`) | 建组件 + v1，落库，发卡片消息；返回 widgetId/version 与提示（不要再用文字复述代码） |
| `widget_update` | `widgetId`、`html`、`queries`?(同 create 全量快照)、`changeNote` | 追加新版本并发**新卡**（版本只增不改，旧卡仍开旧版）；每 run 发卡上限同 MCP Apps（8 张）。P2 起 Bot 级组件可在**任何对话**更新，新卡发给当前对话 |
| `widget_publish`（P2） | `widgetId` | 把 Bot 级组件（`scope='bot'`）的**最新版本**发卡到当前对话（跨对话引用）；不落新版本，走既有审查态流程，受每 run 卡数上限约束。会话级组件不外发 |

- 两个工具都是**任务面**工具（对话轮只读纪律不动）；副作用记 `local`（不写 tool_effects 台账）。
- HTML 校验：UTF-8 体积 ≤ `BOT_WIDGET_HTML_MAX_BYTES`（2MB，同 `MCP_APP_HTML_MAX_BYTES`）；标题/描述脱敏沿用 `secrets.redact`。
- system prompt 任务平台规则新增一条：什么时候适合给用户做交互组件（用户要「能点的」「做个小工具」）、单文件自包含、不写网络请求与本地存储 API（用宿主桥）、改组件用 `widget_update`。

## 5. 渲染管线（复用 D73 P3 的机械部分）

数据流（与 MCP Apps 完全同构，差异只在来源与信任策略）：

```
widget_create/update ──► core: 校验 → widgets/widget_versions 落库 → 发 cardType:'bot_widget' 卡片
用户点「加载」 ──► widgets.ui.open {messageId} ──► core: 读该版本 HTML → WidgetResourceStore 登记
                 ◄── {resourceId, url: kepcup-app://widget-{hash24}/{resourceId}, …}
iframe(sandbox="allow-scripts") ──► 主进程协议处理器（既有） ──► widgets.ui.resource（平台方法，按 host 前缀分流）
                 ◄── {html, csp}（响应头 CSP 固定为 buildAppCspHeader({connectDomains:[],resourceDomains:[]})）
```

- **协议与 URL 解析零改动**：widget 的 host 形如 `widget-{sha256(widgetId).slice(0,24)}`，通过既有 `parseAppUiUrl` 的 host 校验；renderer CSP `frame-src kepcup-app:` 已覆盖，**渲染端与主进程的 CSP/导航拦截/权限拒绝全部原样生效**。
- 主进程唯一改动：`main/index.ts` 的 `fetchResource` 按 `host.startsWith('widget-')` 分流到平台方法 `widgets.ui.resource`。
- widget 响应头 CSP：`buildAppCspHeader` 空域输出 = `default-src 'none'; sandbox allow-scripts; script/style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame/object/base/form 全禁`——比 MCP 应用更严（不可声明任何网络域）。
- **审查态**（renderer）：卡片初始不挂 iframe，显示标题、版本、能力声明（"本组件禁网"、"不保存任何数据"，P1 起按能力桥实际开放更新）与「查看源码」「加载运行」；按「版本 HTML 的 sha256 + 查询模板摘要」（P2 起，内容寻址）首次确认后记入 localStorage，之后自动加载——HTML 不变、仅查询变化的新版本同样视为新代码重新确认；**带查询模板的版本必须先展开源码（SQL 全文）才能加载**：渲染端在展开前禁用「加载运行」，core 的 `widgets.ui.source` 记下 `queries_reviewed_at`、`widgets.ui.open` 对未审查的含模板版本拒绝（`WIDGET_REVIEW_REQUIRED`，渲染端回到审查态并展开源码）——预审是强制的，而不只是建议；`widget_update` 产生的新版本视为新代码重新确认。open 失败不记忆确认（避免下次自动重试失败请求）。审查态「查看源码」展示 HTML 原文**与查询模板 SQL 全文**（人工预审的落点），声明了查询的版本在审查态有一行醒目提示。
- 组件关闭 / 过期沿用 `UiResourceStore` 的 TTL（30 分钟滑动）+ 上限（64）模型，重新打开即重新登记（HTML 在库里，不丢失）。淘汰按**最久未用**（每次取用挪到队尾），不是插入序——正在交互的卡不会因为新开第 65 张而失效。TTL 只用于回收渲染端没来得及 close 的孤儿条目：挂着不动的卡过期或被淘汰后，`BotWidgetCard` 的资源租约（`features/widgets/resource-lease.ts`）在桥调用得 `WIDGET_RESOURCE_EXPIRED` 时自动重新 `widgets.ui.open` 换新 resourceId 并重放这次调用（iframe 不重载、组件内状态不丢），重开也失败（组件已删除 / 版本已修剪）才转错误态。
- **资源存活 = 版本行仍在库里**：会话删除的 FK 级联、Bot 删除、管理入口删除、版本修剪都不经过内存资源；core 的每个桥入口（storage / query / openLink / resource）先核对钉住的版本行仍存在，不在即摘除并按 `WIDGET_RESOURCE_EXPIRED` 拒绝，而不是让写入打到已消失的行上收裸 `FOREIGN KEY constraint failed`。
- widget 内没有 preload：core 在 `widgets.ui.open` 登记资源时把 **SDK 垫片**（内联 `<script>`）前置进 HTML（仅内存资源；`widget_versions` 里的原文不动，审查态「查看源码」看到的仍是 Bot 写的原文），能力桥由卡片组件内的 postMessage 宿主桥提供（`WidgetBridgeHost`，只信 `event.source === iframe.contentWindow`，带关联 id，见 §6）。

## 6. 能力桥（P1 落地，P2 补查询）

widget 可用的宿主 API（`window.kepcup.*`，由渲染端桥转发为 `widgets.ui.*` RPC，core 执行）：

| API | 行为 | 审批 |
|---|---|---|
| `kepcup.storage.get/set/delete/list` | 命名空间 = widgetId 的 KV（`widget_docs`）；配额每组件 1MB / 1000 键（单值 256KB）；限流（storage 与 query 合计、按卡片资源）：令牌桶容量 20（`BOT_WIDGET_CALLS_BURST`，看板 `Promise.all` 一次拉全部查询模板不会被拒）、每秒回填 5（持续速率上限）、同时在途至多 20（query 在子进程里异步执行，在途是真实并发）；工具说明与垫片注释都写明了这组数字 | 免审（作用域天然隔离） |
| `kepcup.query(name, params)`（P2，已落地；审查修复后见 §6.1） | 只能调用 `widget_create`/`widget_update` 时随**卡片钉住版本**登记的命名只读查询模板（`:param` 占位）；模板**只能读两张作用域视图**（`widget_kv` = 本组件 KV、`conversation_messages` = 卡片所在对话的文字消息），交付与运行时各过一次名字闸，在**独立只读子进程**里执行并过物理闸，超时 / 内存超限杀进程（`WIDGET_QUERY_TIMEOUT`）；open 时对模板内容复算摘要防「审查对象被偷换」；带行数上限（200 行，多取一行判定截断，恰好 200 行不算截断）与回执字节上限（1MB；超出任一上限截断并标记 `truncated`）。参数只允许 JSON 标量（boolean 归一 1/0；超出 ±2^53 的 bigint 拒绝——绑定按 double 会静默失真；结果侧超大整数列同样降精度），行是「列名→值」对象（BLOB → base64 字符串） | SQL 随版本被人审查（open 前强制展开），运行时免审 |
| `kepcup.openLink(url)` | 与 `apps.ui.openLink` 同路径（https-only + 主进程白名单 + 卡内确认条 + 冷却） | 卡内确认 |
| `kepcup.theme()` / `setHeight(px)` | 主题（建桥时一次性读取，不推送变更）与高度协商（夹取 `BOT_WIDGET_HEIGHT_MIN/MAX`，未上报时缺省 380px） | 免审 |

结构化查库采用**预审模板**而非运行时 SQL：运行时的输入永远只是参数，没有注入面；这是「Bot 需要数据库」与「core 只跑可信代码」的交汇点——widget 只见命名查询。

### 6.1 查询的数据范围与执行边界（审查修复）

人工预审不能当成唯一防线：用户看不出一条 SQL 读了哪些表、会不会把 core 冻住。原实现的模板跑在 core 主库连接上、无表白名单、无时限——一个 widget 可 `select` 其他 Bot / 对话的消息、`app_connections`、`secrets` 密文，再经 openLink 确认条外带；`WITH RECURSIVE … count(*)`、大表全扫、`randomblob(1e9)` 在同步 better-sqlite3 下能冻结整个 core 或吃掉 GB 级内存。现在是四层：

1. **数据范围 = 两张作用域视图**（`core/widgets/query-gate.ts`）：`widget_kv(key, value_json, updated_at)` = 本组件的 `widget_docs` 行；`conversation_messages(id, seq, sender_type, sender_bot_id, text, created_at)` = 卡片所在对话 `kind='text'`、未撤回的消息（只暴露 `content_json.text`）。视图每次执行前在查询连接的 temp schema 里按卡片的 widgetId / conversationId 现建（字面量内联）。视图名刻意不与 main 的任何表重名，子进程还会核对——视图缺失时 SQL 得「no such table」，不会静默落到同名物理表上读全量（fail closed）。
2. **名字闸**（core 进程内，交付时与每次运行前各一次）：首词必须 SELECT/WITH；**表引用位置白名单**（`tableReferenceViolation`，第二轮审查修复：原先是只拦 `pragma_*` / `dbstat` 的黑名单）——`FROM` / `JOIN` / FROM 子句里的逗号 / `IN` 之后（含括号分组的 join、表值函数调用）的标识符只能是两张作用域视图、`json_each` / `json_tree`、或作用域内声明过的 CTE，带库名前缀（`main.x` / `temp.x`）一律拒绝。eponymous 虚表在任何库里都编译得过，虚表的 `VOpen` 在 EXPLAIN 里只有指针（分不出 json_each 与 pragma_table_list / sqlite_dbpage），物理闸的 OpenRead 核对对它无效，所以只能在名字层拦，而且必须是白名单——`sqlite_dbpage`（加密库下读出的是**解密后**的页，含 secrets）、`sqlite_stmt`、`generate_series` 等将来编译选项一变就会出现。词法与 SQLite 同口径（字符串 / 注释跳过，`"…"` / `` `…` `` / `[…]` 引用标识符，只折 ASCII 大小写——防 `K`（U+212A）经 Unicode 小写化冒充视图名）；CTE 名按括号层跟踪作用域（内层子查询声明的 CTE 在外层不可见，先引用后声明拒绝）；`WINDOW` 只在 `WINDOW 名 AS` 时视为子句、`IS [NOT] DISTINCT FROM` 不是 FROM 子句；分析偏保守，认不出的写法只会多拒。另保留一层「已知危险名」（`pragma_*`、`dbstat`、`sqlite_dbpage`、`sqlite_stmt` 出现在任何位置即拒）作纵深防御。然后在一个**只有这两张视图同名同列「桩表」（建在 temp、main 为空）的内存库**里编译——编译成功 ⇔ 模板引用的表全是作用域视图（`main.x`、任何物理表、attach 的库都「no such table」）；再查桩库上的 `EXPLAIN`：只允许在桩表上 `OpenRead`，读 `sqlite_schema` / `sqlite_temp_schema` 或出现任何写操作码一律拒绝。
3. **执行边界：独立只读子进程**（`core/widgets/query-runner.ts`）：本运行时以 `ELECTRON_RUN_AS_NODE=1` 起一个常驻 Node 子进程（脚本经 `-e` 内联，不依赖打包产物路径；密钥只走 IPC），用 `readonly` + `PRAGMA query_only=ON` + `trusted_schema=OFF` 另开一条到 main.db 的连接，串行执行。建好视图后做**物理闸**：对模板 `EXPLAIN`，每个 `OpenRead` / `ReopenIdx` 必须在 main（库号 0）、rootpage 经 `sqlite_schema` 映射回的表名 ∈ 白名单（`widget_docs`、`messages`）——视图在编译期展开，视图套视图、CTE、子查询读到的每张表都会出现在程序里；触发器只在写语句上触发，只读语句 + `query_only` 下不会出现。超过 `BOT_WIDGET_QUERY_TIMEOUT_MS`（3s，不含子进程启动）或常驻内存超过 `BOT_WIDGET_QUERY_MEMORY_MAX_BYTES`（512MB，Linux 按 `/proc/<pid>/status` 采样；其他平台只靠时限）即 SIGKILL，**当下**回 `WIDGET_QUERY_TIMEOUT`（不等 exit 事件），排队的下一条在新进程里跑；空闲 60s 子进程退出。core 关闭（`dispose`）时在途与排队的查询**立即**以「执行服务已关闭」失败，再杀子进程——不依赖关闭途中可能永不到达的 exit 事件；子进程的 `error` 事件（spawn 失败或 IPC send 失败——后者子进程仍活着）先 SIGKILL 再按退出处理，不留孤儿。
   - **公平性**（第二轮审查修复）：子进程是所有组件共用的串行资源，原先是全局 FIFO——一个组件并发灌满递归 CTE（每条 3s 才杀、再重起进程），别的组件排队数分钟、新查询被全局上限拒绝。现在：排队按组件（`job.owner` = widgetId，同一组件的多个资源共用额度）分桶，派活取「最久没被服务」的组件（轮转，「上次被服务」跨越排队清空保留，防每次只排一条的组件插队），别人的查询最多等当前这条 + 一条；每组件同时排队 + 执行至多 `BOT_WIDGET_QUERIES_MAX`（20，看板一次拉全部模板不被拒），超出立即 `WIDGET_RATE_LIMITED`（文案带上限）；同一组件**连续** 2 次超时 / 内存超限即熔断 30s——它排队中的查询立即失败、冷却期内新查询直接 `WIDGET_RATE_LIMITED`（「连续超时，已暂停 N 秒」），冷却后半开（再超时一次立即重新熔断），任何一次正常结束（含 SQL 报错）清零。全局排队上限 64 只是兜底。
   - **打包态的驱动加载**（第二轮审查修复）：子进程 `require` 的 SQLite 驱动路径由 `resolveQueryDriverPath` 给出——打包后 core 的模块解析落在 `app.asar/node_modules/better-sqlite3-multiple-ciphers/lib/index.js`，映射到 `app.asar.unpacked` 下的真实文件（与 D72 stdio 代理同一 `unpackedAsarPath`，`core/infra/asar-path.ts`），不依赖 Electron 在 Node 模式下的 asar 补丁；解出目录不存在时退回原路径。该包运行时无其他依赖（原生库按平台在 `prebuilds/`），electron-builder 的 smartUnpack 本就因 `.node` 整包解出（26.x `unpackDetector` 按 `moduleRootPath` 解整包），`electron-builder.yml` 另显式写了 `asarUnpack` 规则。实测（Electron 44.4.5，`ELECTRON_RUN_AS_NODE=1`）：asar 内路径与解出路径都能加载并查询加密库——原审查担心的「主进程能加载 ≠ 子进程能加载」在当前版本不成立，改为解出路径是为了不依赖补丁与启发式。加载失败时报「执行环境不可用：<原因>（驱动 <路径>；子进程 node x / electron y，平台-架构，ELECTRON_RUN_AS_NODE=…）」并写诊断日志。
   - **打包态验证**：`afterPack`（`apps/desktop/scripts/pack-hooks.cjs`）硬校验 `app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/lib/index.js` 与目标平台原生库存在；目标平台 = 构建机平台时，用产物里的 Electron 以 Node 模式加载该驱动、对 chacha20 加密临时库建表写入再以 `readonly` + `query_only` 读回（与查询子进程同一加载与开库方式），失败即构建失败。跨平台构建（CI 交叉打包）只做静态校验，到目标机手工验证：装好产物后在一张带查询模板的组件卡上触发一次 `kepcup.query`，应返回行；若报「执行环境不可用」，按文案里的驱动路径与运行时信息排查（日志里同一条 `widget query sandbox unavailable`）。
   - **为什么不是 worker_threads**：better-sqlite3 编译时去掉了进度回调（`SQLITE_OMIT_PROGRESS_CALLBACK`），也不暴露 `sqlite3_interrupt`；一条卡在原生 `sqlite3_step` 里的递归 CTE 不会回到 JS，`worker.terminate()` 永远不 resolve（实测连 `process.exit` 都会被这个线程拖住）。只有进程边界能真正止损。`PRAGMA hard_heap_limit` 在 `SQLITE_DEFAULT_MEMSTATUS=0` 的构建下不生效（实测），所以内存靠进程级采样。
4. **预审强制化**：带模板的版本未展开过 SQL 不能 open（§5 审查态，core + 渲染端双侧）。

已知余量：子进程只在 core 正常运行时受控——core 被强杀时，正卡在原生循环里的子进程要到这条查询自己结束才退出（IPC 断开后它不会再接新活）；非 Linux 平台的内存上限只靠 3s 时限间接约束。

实施要点（P1 实现期确定）：

- **数据流**：widget（垫片）`parent.postMessage` → `BotWidgetCard` 的 `WidgetBridgeHost`（renderer，只收 `event.source === iframe.contentWindow` 的消息）→ `core.call('widgets.ui.storage' | 'widgets.ui.openLink', { resourceId, … })` → core 以 `resourceId` 反查内存资源拿 widgetId（凭据即命名空间，resourceId 过期 → `WIDGET_RESOURCE_EXPIRED`）。widget 侧 opaque origin，postMessage 只能 `targetOrigin '*'`，`event.source` 校验是唯一来源防线；消息带自增关联 id 配对请求 / 回执。
- **垫片注入**：`core/widgets/sdk-injection.ts`——`open()` 登记时前置静态 `<script>`（resourceId 不进脚本，没有拼注入面；CSP `script-src 'unsafe-inline'` 允许内联）。插入点必须在 `<!DOCTYPE html>` **之后**（doctype 前出现任何节点触发 quirks mode，改变盒模型与 CSS 语义）：优先 `<head>` 开标签之后 → 退到 doctype `>` 之后 → 都没有才前置文档开头。
- **KV**：落 `widget_docs`（0028 已建表），值存 JSON 文本；超单值 / 总配额 / 键数上限 → `WIDGET_STORAGE_QUOTA`，值不可序列化 → `INVALID_INPUT`；覆盖旧键释放旧体积、不增键数。**免审批**的理由：命名空间即 widgetId，组件天然读不到别人的数据，审批没有额外信息量。
- **外链**：renderer 先 `normalizeAppLink`（https、无凭据、有主机名）再出卡内确认条（`pendingLink` 单例 + 拒绝后 `MCP_APP_LINK_COOLDOWN_MS` 5s 冷却，同 McpAppCard）；core `openLink` 再核一次同样规则，经主进程 `shell.openExternal`。
- **错误码**：`WIDGET_RESOURCE_EXPIRED`（重开卡片即恢复；渲染端自动重开重放）、`WIDGET_RATE_LIMITED`、`WIDGET_STORAGE_QUOTA`、`WIDGET_QUERY_UNKNOWN` / `WIDGET_QUERY_FAILED` / `WIDGET_QUERY_TIMEOUT`（查询，§6.1）、`WIDGET_REVIEW_REQUIRED`（含模板版本未审查即加载）、`WIDGET_LIMIT`（每 Bot 存量上限，工具返回）（登记 shared `errors.ts`，zh-CN 文案在 `chats.errorCode.*`）。桥回执的拒绝形状是 `{ok:false, error, code?}`——`error` 是可直接展示的中文，`code` 是机器可读错误码（Bot 写的组件据它程序化区分限速 / 配额 / 过期）；宿主对每个带可解析 id 的请求保证恰好一条回执（含格式拒收），组件侧 promise 不会挂起。

## 7. RPC 面

- renderer → core：`widgets.ui.open {messageId}`（登记内存资源并返回 iframe 地址；同时做卡片 sha256 与版本行的一致性校验，不一致 → `WIDGET_INVALID`）、`widgets.ui.source {messageId}`（审查态取 HTML 原文与查询模板全文，不登记资源）、`widgets.ui.close {resourceId}`；P1 已增 `widgets.ui.storage`（op: get/set/delete/list 判别 union）、`widgets.ui.openLink`；P2 已增 `widgets.ui.query`（能力桥查询）与管理入口 `widgets.list`（Bot 全部组件）/ `widgets.delete`（清四表 + 摘在途资源）/ `widgets.publish`（Bot 级组件发卡到指定对话）。
- 平台（主进程 → core）：`widgets.ui.resource {resourceId, host}` → `{html, csp}`（html 为垫片版）。
- 契约集中在 `packages/shared/src/domain/widgets-ui.ts`（写法同 `apps-ui.ts`）：`BOT_WIDGET_CARD_TYPE = 'bot_widget'`、`widgetCardSchema`、各 RPC in/out schema、体积/数量/配额/限速/查询常量。卡片字段挂 `cardContentSchema.cardWidget`（同 `appUi` 的挂法）。

## 8. 安全清单

1. iframe `sandbox="allow-scripts"`（无 allow-same-origin / popups / top-navigation / forms），`allow=""`，无 preload——opaque origin，摸不到 renderer DOM / localStorage / `window.kepcup`。
2. 响应头 CSP `connect-src 'none'` + 默认全禁；主进程子框架导航拦截、权限一律拒绝原样覆盖 `kepcup-app:`。
3. HTML 不落盘以外的地方：不进模型上下文（卡片对模型只渲染一行固定文案）、不进日志。
4. 按版本人工确认 + sha256 记忆；新版本 = 新代码。
5. 存储 KV 每组件命名空间隔离 + 配额 + 限速；无文件系统、无子进程、无网络。
5a. 查询模板只能读作用域视图（名字闸的表引用白名单 + 子进程物理闸），在独立只读子进程里带时限 / 内存上限执行，按组件轮转、限额、连续超时熔断；含模板的版本必须先展开审查 SQL 才能加载（§6.1）。
5b. 每 Bot 组件数 / 版本总字节上限与版本修剪（§3）；桥入口先核对版本行存活（§5）。
6. 每工具面：仅任务可创建/更新；每 run 发卡 ≤8。
7. 删除级联全覆盖（Bot / 会话）。

## 9. 分期

- **P0（骨架，已落地）**：工具 + 迁移 + 卡片 + 审查态渲染 + 协议分流。验收：Bot 在对话里写出可交互组件，用户加载即用；重启后旧卡可重开且仍为原版本。
- **P1（能力桥，已落地）**：postMessage 桥 + `storage` KV + `openLink` + 主题/高度。
- **P2（结构化数据与资产，已落地）**：命名只读查询模板 + `query()`；`scope='bot'` 组件的管理入口（Bot 详情「组件」Tab：列表/删除）+ 跨对话引用（`widget_publish` 工具 + `widget_update` 解禁到任意对话 + Tab 内「发到当前对话」）。

## 10. 本期不做

- 生成代码访问网络、文件系统、子进程、Electron API（永久不做）。
- core 内执行 Bot 生成的 JS（永久不做；结构化能力一律走宿主提供的命名 API）。
- 运行时 raw SQL 透传。
- 组件市场 / 分享 / 多 Bot 共用组件模板（未设计）。
- 组件的无人值守自动加载（确认默认不可跳过）。
