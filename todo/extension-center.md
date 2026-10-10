# 扩展中心：把「技能市场」升级为 Skills / 连接 / MCP 三组，并逐家预置连接应用

> 状态：**X0–X4、X6 已在 `t/extension-center` 分支实现（2026-10-10，待评审合并）**；X5 逐家适配未开始。偏差见 DEV-023。2026-10-10 由用户决定后写成，编号待分配（接 D73 / D74 之后）。上游：[connected-apps.md](connected-apps.md)（连接应用 P0–P3 已实现）、[connected-apps-status.md](connected-apps-status.md)。
>
> **本文取代原 U2**：原「U2 测试账号 → 登录实测 → 放行发行门禁」不再是用户待办，而是本文 §4 的**持续适配工作**（Agent 做，账号持有人只负责浏览器里的那一次登录）。

> **补充（2026-10-10）**：长尾厂商另有[本机连接](local-connector-authoring.md)（设计 29 §17）——开发者模式开启时 Bot 可读文档生成只存本机的连接，「连接」组底部增加折叠的「本机自建」区（L4，渲染端待做）；它是第三方开放平台门户（[developer-portal.md](developer-portal.md)，已降级为后续）的入口，不替代本文的「逐家预置」。

## 0. 决定与背景

用户决定（2026-10-10）：

1. 连接应用「测试各家、补目录数据、放行」本质是**逐家适配**，属于后续开发，不是一次性的用户待办。U2 整体从用户待办里拿掉。
2. **后面不再让用户自己新建 MCP 来连接**（OAuth 类的自定义 server）。入口改成「**扩展中心**」：把现有「技能市场」升级，内部按 **Skills / 连接（Connections）/ MCP** 三组展示。
3. 「连接」组里的应用**预置**：测试好一家，就上线一家（沿用现有发行门禁机制：`connector-release-gates.json` 放行才进发行构建）。

不变的底座：P0–P3 做完的 OAuth 引擎、Token Vault、风险分级、工具锁定、污点外发、签名目录——扩展中心只是**面向用户的壳与内容策略**，不推翻这些。

## 1. 目标与非目标

目标：

- 一个统一入口发现并添加三类扩展：技能、连接应用、MCP。
- 连接组只展示**已适配、已放行**的预置应用；每家适配的流程固定、可重复（§4）。
- 普通用户看不到「填一个 MCP 地址去连」的入口，减少误连与钓鱼面。

非目标：

- 不删除 P0 / P2 的自定义 OAuth 连接能力（开发者模式、MCPB、BYO 客户端、第三方子注册表仍依赖它）；只调整**入口可见性**。
- 不做第三方开发者门户 / 公开提交（见 [developer-portal.md](developer-portal.md)）。
- 不改签名目录与发行门禁的安全语义。

## 2. 现状（代码锚点，开工前先读）

| 部分 | 位置 | 说明 |
| ---- | ---- | ---- |
| 技能市场对话框 | `apps/desktop/src/renderer/src/lib/features/skill-market/`（`SkillMarketDialog.svelte`、`market.svelte.ts`、`icons.ts`） | 弹框形态，随应用分发的预置技能按场景分区，一键添加；安装走 RPC `skills.presets.install` |
| 入口 | `features/sidebar/AppSidebar.svelte`（折叠态与展开态各一个按钮，`data-testid="skill-market-button"`）、`stores/shell.svelte.ts`（`skillMarketOpen` / `openSkillMarket()`）、文案 `sidebar.skillMarket` | 左下角 |
| 预置技能数据 | `apps/desktop/resources/preset-skills/`（`catalog.json` + 各技能目录，[README](../apps/desktop/resources/preset-skills/README.md)） | 内容哈希对比给「更新」 |
| 设置「应用」分区 | `features/settings/AppsSection.svelte`、`sections.ts`（页签：目录 `catalog` / 已连接 `connected` / 自定义 `custom`） | 连接应用的发现、账号管理、自定义 server（原 MCP 设置并入） |
| 连接组件 | `features/apps/ConnectAppPanel.svelte`、`AppConnectionsList.svelte`、`AppConnectionDetail`；`features/settings/McpSection.svelte` / `McpbInstall.svelte` / `McpDevTools.svelte` | 设置页与对话卡共用 |
| 目录与门禁 | `apps/desktop/resources/connectors/catalog.json`（6 家）、`apps/desktop/connector-release-gates.json`（`approved: []`）、RPC `apps.catalog.list` | 发行构建只收录放行条目；开发构建不过滤 |
| e2e | `apps/desktop/test/e2e/skill-market.spec.ts`、`sidebar-resize.spec.ts` | 改名与改结构时要跟着改 |

## 3. 产品形态（推荐方案；带 ⚠ 的是开工前要你确认的点）

**入口**：侧栏左下角「技能市场」改名「**扩展中心**」，仍是明确打开的管理界面（点遮罩不关闭，沿用现有行为）。内部三个分组（页签 / 分段）：

| 分组 | 内容 | 来源 |
| ---- | ---- | ---- |
| **Skills** | 现有技能市场的全部内容原样迁入 | `preset-skills/catalog.json` |
| **连接** | **预置**的连接应用卡片（Notion、Linear……）：一键连接 → 账号 → Bot 勾选；已连接显示状态与账号数；管理细节（权限、逐工具策略、待复核 diff、断开）进详情 | `connectors/catalog.json` 且通过发行门禁 |
| **MCP** | 预置 / 精选的 MCP（含 MCPB 本地包）与已安装 MCP 的启停管理 | 新增精选清单（见 X4） |

要点：

- 「连接」组**不提供**「填一个 URL」的入口。条目不在目录里 = 当前不支持，用户用不了——这是有意的收紧。
- ⚠ **决定 A（推荐）**：自建 / 填 URL / 手填客户端 / 开发者模式等「自定义」能力**收进「设置 → 高级 / 开发者模式」**，默认隐藏，代码与测试保留；已存在的 `settings.mcpServers` 与已建立的连接不迁移、不删除。备选：完全移除自建入口（会让 MCPB、BYO 客户端、第三方子注册表失去 UI，不推荐）。
- ⚠ **决定 B（推荐）**：设置「应用」分区保留，只做**已连接账号的管理**（列表 / 详情 / 重新授权 / 断开）；**发现与添加**统一到扩展中心的「连接」组。「目录」页签随之移除或改成跳转到扩展中心。
- ⚠ **决定 C**：「MCP」组首期放什么。推荐先做「已安装 MCP 管理 + MCPB 本地包安装」，精选清单待有第一个值得预置的无 OAuth MCP 时再填；空清单时该组只显示管理视图。

## 4. 单家连接应用的适配流程（原 U2，现为持续工作）

每新增一家，按固定清单走，全部做完才加入放行清单（`connector-release-gates.json`）：

1. **无登录探测**：`node packages/core/scripts/connector-spike/probe.mjs --only <slug>`，确认 401 + 发现元数据 + CIMD 或 DCR + PKCE S256（只做探测，不登录）。
2. **账号准备**：测试账号 / 测试站点 / 测试数据由账号持有人准备并保管（不把密码、令牌给 Agent，也不贴进聊天）。各家特例：Atlassian 需有管理员权限的测试站点（验证「已批准客户端 / 域名」是否拦 CIMD 客户端；可用 Microsoft 账号登录）；Canva 先确认私有访问 / 等候名单；Stripe 只用测试模式 + 受限权限。
3. **带登录实测**（账号持有人在浏览器登录一次；**工具快照一家一个文件**存 `packages/core/test/fixtures/connectors/<slug>.tools.json`，导出方法与汇总命令见该目录 README；`node packages/core/scripts/connector-spike/summarize-tools.mjs <slug>` 给出工具数、注解覆盖率和风险分布）：用桌面端开发者模式（P2 §6.6）连接，导出原始工具定义（不含令牌）；也可补写 `connector-spike/login-probe.mjs`（用 P0 引擎连接并输出工具清单、注解覆盖率、`whoami` 可行性，令牌只在内存）。
4. **补目录数据**：`catalog.json` 的 `toolPolicy`（逐工具风险：只读 / 写 / 破坏性；缺注解的工具按保守档）、`whoami`（账号识别方式）、`auth.scopes`；Stripe 之类涉钱的逐工具取严。
5. **自动化测试**：以假服务器复现该家的特殊点（发现路径、scope、账号识别）；工具清单快照进测试，防止上游悄悄改动而不被发现（配合工具定义锁定）。
6. **真实走一遍**：目录连接 → 多账号（需第二个账号时由持有人再备一个）→ Bot 勾选 → 对话里完成一件事 → 写工具审批卡显示账号 → 令牌过期重连 → 断开吊销。
7. **放行**：把 slug 加进 `connector-release-gates.json`，结论写入 [connected-apps.md](connected-apps.md) 附录 B；发版后用户在扩展中心「连接」组看到它。

### 4.1 适配队列（按建议顺序）

| 顺序 | 应用 | 现状 | 备注 |
| ---- | ---- | ---- | ---- |
| 1 | Notion | 已适配并放行（2026-10-10）：快照 50 个工具、注解 50/50；`toolPolicy` 把 `notion-create-comment` 调到破坏性；门禁已开 | `whoami` 已补；待真实走一遍（U6） |
| 2 | Linear | 已适配并放行（2026-10-10）：快照 64 个工具、注解 64/64；`toolPolicy` 为空（服务端标的破坏性照单全收）；门禁已开 | `whoami` 已补；待 scopes 拆 step-up（需真实验证）、真实走一遍（U6） |
| 3 | Sentry | 待账号 | 免费版 + 测试项目 + 测试事件 |
| 4 | Atlassian | 待账号 | 管理员限制验证；Microsoft 登录；端点 `authv2` / `v2` 一并确认 |
| 5 | Stripe | 待账号 | 仅测试模式；逐工具取严 |
| 6 | Canva | 待确认可用性 | 可能仍是等候名单；不可用则暂缓 |
| 后续 | Google、Microsoft、Slack、Asana、HubSpot | 需预注册客户端（U4） | 走 P2 的预注册客户端机制；先有客户端再进队列；**Google 优先**（它同时是 P2 预注册验收的那一条） |
| 推迟 | GitHub | 要 client secret（2026-10-10 用户决定推迟） | 等 P4 托管网关（[hosted-auth-gateway.md](hosted-auth-gateway.md)），不进本期队列 |

## 5. 任务拆分

每个任务都带测试；E2E 用现有 Electron e2e 方式；全量按 [AGENTS.md](../AGENTS.md) 在 Docker 里先定向后全量。

- [x] **X0 设计定稿**：在 `docs/design/` 新增（或扩展 29）一节「扩展中心」：信息架构、三组职责、决定 A / B / C 的结论、与设置「应用」分区的分工、对已有 `mcpServers` 的兼容策略。**先确认 ⚠ 三点再动代码**。
- [x] **X1 外壳**：`SkillMarketDialog` → `ExtensionCenterDialog`（目录名、`shell.skillMarketOpen` → `extensionCenterOpen`、`sidebar.skillMarket` → `sidebar.extensionCenter`、`data-testid` 随之更名），三个页签；Skills 页签 = 现有内容原样迁入，行为与测试不变。更新 `skill-market.spec.ts` / `sidebar-resize.spec.ts`。
- [x] **X2 连接页签**：复用 `apps.catalog.list` 与 `ConnectAppPanel` 的目录卡；只列放行条目（开发构建照旧全部可见，便于适配）；已连接状态、账号数、跳详情；空态文案（「暂无已适配的应用」）。
- [x] **X3 自定义入口收口**（决定 A）：「自定义」页签 / 填 URL 入口移入开发者模式；设置「应用」分区只留已连接管理（决定 B）；保留深链 `openSettings('apps', …)` 与别名 `mcp` 的兼容；e2e 与 `sections.test.ts` 更新。
- [x] **X4 MCP 页签**：已安装 MCP 的启停 / 状态 / 工具策略入口 + MCPB 安装（`McpbInstall`）；精选清单数据结构（对齐 `catalog.json` 风格）先建空壳。
- [ ] **X5 逐家适配**（持续任务，§4 流程）：先 Notion、Linear（账号已就绪，可立即开始），其余随账号到位逐个推进。每家一个提交，含目录数据、测试、放行与附录 B 结论。
- [x] **X6 文案与文档收尾**：zh-CN 文案、`docs/dev/PROGRESS.md`、`todo/connected-apps*.md` 的引用、`connectors/README.md` 的放行说明。

**实施记录（2026-10-10，X0–X4 / X6）**：三项 ⚠ 决定均取推荐方案（A / B / C）。设计定稿在 [设计 29 §16](../docs/design/29-connected-apps.md)；代码在 `features/extension-center/`（`ExtensionCenterDialog` + `ExtensionSkills` / `ExtensionConnections` / `ExtensionMcp`）；自定义 MCP 与开发者模式开关在设置新分区「开发者模式」（`DeveloperSection`），设置「应用」只管已连接账号；精选 MCP 清单空壳在 `resources/mcp-presets/` + core `mcp/presets.ts`。实现取舍见 DEV-023，验证结果见 `docs/dev/PROGRESS.md`「扩展中心」。

依赖：X0 → X1 → (X2、X3、X4 并行，注意都动 `settings` / `shell` 文件，按文件归属拆分) → X6；X5 与 X1–X4 并行（只动 `connectors/` 数据与测试）。

## 6. 验收

- 侧栏入口为「扩展中心」，三个分组可用；Skills 的既有行为与测试无回归。
- 连接组在发行构建里只出现已放行条目；一条未放行的都不可见（沿用既有测试）。
- 普通界面里找不到「填 MCP 地址」的入口；开发者模式里仍可用，原有自定义连接不丢。
- 至少 Notion、Linear 两家完成 §4 全部步骤并放行；附录 B 与 `catalog.json` 数据一致。

## 7. 风险与注意

- 收紧入口会影响已经自建 MCP 的用户：不迁移、不删除，仅隐藏入口；设置里仍可管理已有项。
- 发行门禁与 `catalog.json` 的版本要一起发：放行只对「发了新版本」的用户可见（目录同步另见签名目录，已上线）。
- 和 D73 分支的合并顺序：本任务的 X1–X4 在 D73 合入 main **之后**开工，避免与 `shell.svelte.ts` / `settings` / `sections.ts` 等热点文件冲突。X5 的数据与测试可在分支上先做。
