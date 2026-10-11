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

## 3. 数据模型（main.db `0028_widgets.sql`）

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

-- widget_versions：每个版本一份完整 HTML，只增不改（旧消息卡片钉住旧版本）
CREATE TABLE widget_versions (
  widget_id    TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  html         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  created_by_run TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (widget_id, version)
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
- 删除级联：**会话删除** → `scope='conversation'` 的组件随 `conversations` 行 FK 级联清除；**Bot 删除** → bots 行改占位、FK 不触发，由 `lifecycle.deleteBot` 经 `WidgetService.deleteForBot` 显式清除该 Bot 全部三表（登记 `docs/dev/03-data-model.md` 级联表）。`scope='bot'` 的组件跨对话存活，直到 Bot 删除或用户在管理界面删除（P2）。

## 4. Bot 侧工具（task 面）

| 工具 | 参数 | 行为 |
|---|---|---|
| `widget_create` | `title`(1–120)、`description`(给用户的一句话)、`html`(单文件 HTML，≤2MB)、`scope`?(`'conversation'`缺省/`'bot'`) | 建组件 + v1，落库，发卡片消息；返回 widgetId/version 与提示（不要再用文字复述代码） |
| `widget_update` | `widgetId`、`html`、`changeNote` | 追加新版本并发**新卡**（版本只增不改，旧卡仍开旧版）；每 run 发卡上限同 MCP Apps（8 张） |

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
- **审查态**（renderer）：卡片初始不挂 iframe，显示标题、版本、能力声明（"本组件禁网"、"不保存任何数据"，P1 起按能力桥实际开放更新）与「查看源码」「加载运行」；按版本 HTML 的 sha256（内容寻址）首次确认后记入 localStorage，之后自动加载；`widget_update` 产生的新版本视为新代码重新确认。open 失败不记忆确认（避免下次自动重试失败请求）。
- 组件关闭 / 过期沿用 `UiResourceStore` 的 TTL（30 分钟滑动）+ 上限（64）模型，重新打开即重新登记（HTML 在库里，不丢失）。
- widget 内没有 preload、没有 `window.kepcup`：P0 是纯静态组件；能力桥（P1）由卡片组件内的 postMessage 宿主桥提供（只信 `event.source === iframe.contentWindow`，带关联 id）。

## 6. 能力桥（P1 起逐步提供）

widget 可用的宿主 API（由渲染端桥转发为 `widgets.ui.*` RPC，core 执行）：

| API | 行为 | 审批 |
|---|---|---|
| `kepcup.storage.get/set/delete/list` | 命名空间 = widgetId 的 KV（`widget_docs`）；配额每组件 1MB / 1000 键；限速同 `MCP_APP_CALLS_PER_SECOND` | 免审（作用域天然隔离） |
| `kepcup.query(name, params)`（P2） | 只能调用 `widget_create`/`widget_update` 时随版本登记的**命名只读查询模板**（`:param` 占位）；core `prepare()` 后校验 `stmt.readonly`，带行数/超时上限 | SQL 随版本被人审查，运行时免审 |
| `kepcup.openLink(url)` | 与 `apps.ui.openLink` 同路径（https-only + 主进程白名单 + 卡内确认条 + 冷却） | 卡内确认 |
| `kepcup.theme` / `setHeight` | 主题与高度协商 | 免审 |

结构化查库采用**预审模板**而非运行时 SQL：运行时的输入永远只是参数，没有注入面；这是「Bot 需要数据库」与「core 只跑可信代码」的交汇点——better-sqlite3 全程在 core，widget 只见命名查询。

## 7. RPC 面

- renderer → core：`widgets.ui.open {messageId}`（登记内存资源并返回 iframe 地址；同时做卡片 sha256 与版本行的一致性校验，不一致 → `WIDGET_INVALID`）、`widgets.ui.source {messageId}`（审查态取 HTML 原文，不登记资源）、`widgets.ui.close {resourceId}`；P1 增 `widgets.ui.storage`、`widgets.ui.openLink`。
- 平台（主进程 → core）：`widgets.ui.resource {resourceId, host}` → `{html, csp}`。
- 契约集中在 `packages/shared/src/domain/widgets-ui.ts`（写法同 `apps-ui.ts`）：`BOT_WIDGET_CARD_TYPE = 'bot_widget'`、`widgetCardSchema`、各 RPC in/out schema、体积/数量常量。卡片字段挂 `cardContentSchema.cardWidget`（同 `appUi` 的挂法）。

## 8. 安全清单

1. iframe `sandbox="allow-scripts"`（无 allow-same-origin / popups / top-navigation / forms），`allow=""`，无 preload——opaque origin，摸不到 renderer DOM / localStorage / `window.kepcup`。
2. 响应头 CSP `connect-src 'none'` + 默认全禁；主进程子框架导航拦截、权限一律拒绝原样覆盖 `kepcup-app:`。
3. HTML 不落盘以外的地方：不进模型上下文（卡片对模型只渲染一行固定文案）、不进日志。
4. 按版本人工确认 + sha256 记忆；新版本 = 新代码。
5. 存储 KV 每组件命名空间隔离 + 配额 + 限速；无文件系统、无子进程、无网络。
6. 每工具面：仅任务可创建/更新；每 run 发卡 ≤8。
7. 删除级联全覆盖（Bot / 会话）。

## 9. 分期

- **P0（骨架）**：工具 + 迁移 + 卡片 + 审查态渲染 + 协议分流。验收：Bot 在对话里写出可交互组件，用户加载即用；重启后旧卡可重开且仍为原版本。
- **P1（能力桥）**：postMessage 桥 + `storage` KV + `openLink` + 主题/高度。
- **P2（结构化数据与资产）**：命名只读查询模板 + `query()`；`scope='bot'` 组件的管理入口（列表/删除/跨对话引用）。

## 10. 本期不做

- 生成代码访问网络、文件系统、子进程、Electron API（永久不做）。
- core 内执行 Bot 生成的 JS（永久不做；结构化能力一律走宿主提供的命名 API）。
- 运行时 raw SQL 透传。
- 组件市场 / 分享 / 多 Bot 共用组件模板（未设计）。
- 组件的无人值守自动加载（确认默认不可跳过）。
