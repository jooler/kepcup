# 指南：新增一家连接应用

> 适用：往 KepCup「扩展中心 → 连接」组里新增一家预置的连接应用（如 Notion、Linear）。
> 前提：连接应用的底座（MCP OAuth、Token Vault、风险分级、工具锁定、目录与发行门禁，D73 P0–P3）和扩展中心（设计 29 §16）已就绪。
> 决策背景：普通用户**不能**自己填 MCP 地址去连接；连接组里的应用全部由我们**预置**，**测好一家上一家**。详见 [todo/extension-center.md](../../todo/extension-center.md) 与 [设计 29](../design/29-connected-apps.md)。
> 做过的样例：Notion、Linear（提交 `463d3cb`、`da154a8`；结论见 [todo/connected-apps.md](../../todo/connected-apps.md) 附录 B.8）。照着它们的 diff 对照着做最快。

## 总览

```
S0 评估能不能上 → S1 备账号 → S2 写目录条目 → S3 连接并导出工具快照 → S4 定 toolPolicy
→ S5 定 whoami → S6 定 scopes → S7 测试 → S8 真实走一遍 → S9 放行 → S10 更新文档 → S11 发布
```

**顺序有意义**：放行（S9）放在真实验收（S8）之后；守门测试要求「已放行的条目必须有工具快照」，所以快照（S3）在放行之前。

## S0 评估能不能上目录

按授权方式决定走哪条路：

| 该家的授权 | 能不能上 | 怎么做 |
|---|---|---|
| 支持 **CIMD** 或 **DCR**，且 PKCE S256 | ✅ 可上 | `auth.registration: "auto"` |
| 必须预注册客户端，且平台把桌面应用的 client secret **当作非保密**（如 Google「桌面应用」类型） | ✅ 可上，但要先注册 | `registration: "preregistered"` + `clientRef`，客户端信息放 `apps/desktop/oauth-clients.json`（见 [user-actions U4](../../todo/connected-apps-user-actions.md)） |
| 要求**保密的 client secret**（如 GitHub 的 GitHub App / OAuth App） | ❌ 本期不上 | 原则：保密 secret 不随桌面应用分发；等 P4 托管网关（[hosted-auth-gateway.md](../../todo/hosted-auth-gateway.md)）。GitHub 已按此推迟 |
| 只有 stdio / 本地包 | 不走本流程 | 走 MCPB（扩展中心 → MCP） |

做法：

1. 把候选加进 `packages/core/scripts/connector-spike/probe.mjs` 的 `CANDIDATES`（`slug`、MCP 地址、官方文档链接；**地址以厂商当前文档为准**，不要凭记忆）。
2. 运行无登录探测（不登录、不注册、不带令牌）：
   ```
   node packages/core/scripts/connector-spike/probe.mjs --only <slug> --out /tmp/probe.json
   ```
   看：`initialize` 是否 401 + `WWW-Authenticate`、受保护资源元数据（RFC 9728）、授权服务器元数据里有没有 `client_id_metadata_document_supported` / `registration_endpoint`、`code_challenge_methods_supported` 含 `S256`、`scopes_supported`、有没有吊销端点。
3. 结论写进 [todo/connected-apps.md](../../todo/connected-apps.md) 附录 B（该家「可上目录 / 需预注册 / 暂不支持」）。**不满足上表前两行的，到此为止，不要做半套。**
4. 也可以用官方 MCP Registry 生成条目骨架：`node scripts/import-mcp-registry.mjs <registry-name>`（只打印，不写文件；`privacyPolicy` 留 `TODO` 迫使你补全）。

## S1 备账号（账号持有人做，Agent 不碰凭证）

- 用**专用测试账号 / 工作区**和虚构数据，不要用主账号、工作账号，不要放真实资料。
- **密码、令牌、client secret 不给 Agent，也不贴进聊天**；登录只在持有人自己的浏览器里完成。
- 各家特例先弄清楚：涉钱的（Stripe）**只用测试模式 + 受限权限**；有管理员「已批准客户端 / 域名」限制的（Atlassian）要用有管理员权限的测试站点验证 KepCup 的 CIMD 客户端会不会被拦；可能有等候名单的（Canva）先确认可用性。
- 多账号验收需要第二个账号，一并准备。

## S2 写目录条目

编辑 `apps/desktop/resources/connectors/catalog.json`，在 `connectors` 里加一项（`server.json` 子集 + `_meta["app.kepcup/connector"]`）。schema 见 `packages/shared/src/domain/connector-catalog.ts`，字段含义：

```jsonc
{
  "name": "com.example/mcp",            // Registry 命名空间（反向域名 / io.github.*），全目录唯一
  "title": "Example",
  "description": "一句话说清能做什么（中文）",
  "version": "1.0.0",                   // 条目变化就递增，目录合并按它判断新旧
  "websiteUrl": "https://example.com",
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }],  // 必须 https
  "_meta": {
    "app.kepcup/connector": {
      "slug": "example",                // [a-z0-9]{2,16}，唯一；也是快照文件名与门禁名
      "icon": "example.svg",            // resources/connectors/icons/ 下的文件
      "category": "productivity",       // productivity|development|project|design|payments|crm|communication|data|other
      "tier": "builtin",
      "auth": { "kind": "oauth", "registration": "auto", "clientRef": null,
                "scopes": { "default": [], "write": [] } },
      "toolPolicy": {},                 // S4
      "skills": [], "ui": false,
      "privacyPolicy": "https://example.com/privacy",   // 必填，https
      "releaseGate": "example"          // 先写上；是否放行由 S9 的门禁文件决定
    }
  }
}
```

- 图标：`icons/<slug>.svg` 是**中性占位图标**（圆角方块 + 首字母），**不要放厂商商标图形**（品牌素材许可未确认）；SVG 不得带脚本。照现有几个复制改字母。
- `registration: "preregistered"` 时必须写 `clientRef`（对应 `oauth-clients.json` 的键）。
- 先**不要**动 `connector-release-gates.json`。

## S3 连接并导出工具快照

开发者模式面板列的是**自建的自定义服务器**（`settings.mcpServers`），目录里的预置连接不在其中。所以导出原始工具定义要临时「自建」一个同地址的服务器：

1. 起开发版（建议隔离数据目录，别动平时用的 `~/.kepcup`）：
   ```
   KEPCUP_HOME=/tmp/kepcup-adapt pnpm dev
   ```
2. **设置 → 开发者模式**，打开开关 →「添加服务器」，类型选 HTTP，填该家的 MCP 地址，认证选 OAuth，保存后点「连接」（账号持有人在浏览器里登录授权）。
3. 在该服务器下点「查看原始定义」，复制整段 JSON（含注解）。导出后可以删掉这个临时服务器（目录里的预置连接在 S8 单独验）。
4. 存为 `packages/core/test/fixtures/connectors/<slug>.tools.json`（**一家一个文件**，原样保存，prettier 已忽略此目录，便于以后 `git diff` 看出上游改了什么）。提交前扫一眼，不要有真实邮箱、工作区名、内部链接（示例性的 `alex@example.com` 没问题）。详见该目录的 [README](../../packages/core/test/fixtures/connectors/README.md)。
5. 汇总：
   ```
   pnpm --filter @kepcup/shared build
   node packages/core/scripts/connector-spike/summarize-tools.mjs <slug> --list
   ```
   看：工具总数、**注解覆盖率**（带 `readOnlyHint` / `destructiveHint` 的比例）、只读 / 写 / 破坏性分布，以及「判定不来自注解（需人工看）」的工具。

## S4 定 toolPolicy（逐工具风险）

先理解规则（`packages/shared/src/policy/{risk,tool-policy}.ts`）：

- 风险来自**服务端注解**经 KepCup 的分级函数（W5）：只读 / 写 / 破坏性。**服务端自报的注解不可信**：名字含写动词的工具即使声明只读也不算只读；缺注解按「破坏性」取严。
- 目录的 `toolPolicy` **只能把风险调高，永远不能放宽**（唯一例外：`builtin` 条目上，注解缺失导致「缺省取严」的工具，目录可以给它定档）。
- 服务端标成破坏性的，**照单全收**（决策 2026-10-10：Linear 的 `save_*` 等「创建或更新」类每次都要确认、不能「总是允许」；用一段时间再决定是否放宽）。

要做的判断：

1. 注解覆盖率必须 100%；有缺的，要么在 `toolPolicy` 里逐个定档，要么这一家暂不放行。
2. 找出**服务端标得偏松**的工具，调高：对外可见 / 会通知别人 / 不可无痕撤回 / 涉钱 / 涉权限分享。例：Notion 的 `notion-create-comment` 服务端标「写」，调到 `destructive`（与 Linear 的 `save_comment` 同档）。
3. 涉钱的家（Stripe）**逐工具取严**。
4. `toolPolicy` 的键必须是快照里真实存在的工具名（守门测试会查）。

## S5 定 whoami（账号识别）

用来给连接起可读标签，并判断「同一账号」。

1. 选一个**只读**工具，能返回当前登录者（如 Notion `notion-get-self`、Linear `get_user {"query":"me"}`）。
2. 快照里没有输出结构，**字段路径不能猜**：让一个已授权这家的 Bot 调用该工具，持有人把**返回结构**（邮箱、名字可打码，要字段名和嵌套层级）给你。
3. 填 `whoami`：`{ "tool", "arguments"?, "labelPath", "subjectPath"? }`，路径是点号路径（数组下标用数字）。
4. **`subjectPath` 要选「令牌实际绑定的那个东西」**：同一 `subject` 的重新授权会复用旧连接，换了就报「账号不一致」。Notion 的令牌绑工作区，所以用 `workspace.id`；Linear 返回里只有用户，用用户 `id`。选错会把不同账号并成一行，或让连接悄悄换了工作区。拿不准就不设 `subjectPath`（退回自动编号「Xxx #1」，不影响功能）。
5. 把路径钉进 `packages/core/test/unit/connector-whoami.test.ts`：用**结构相同、值虚构**的样本，**不要把真实邮箱 / id 写进仓库**。

## S6 定 scopes

- 默认 `scopes: { "default": [], "write": [] }`：由服务端的 `WWW-Authenticate` / 资源元数据决定，最稳妥。
- 想做「默认只读、写工具时再追加权限」（step-up），先**真实验证**：只读令牌调写工具，服务端是否回 `403 insufficient_scope`。没验证过不要拆，否则写工具可能直接失败。验证后再改成 `default: [只读范围]`、`write: [写范围]`。

## S7 测试

1. 在 `packages/core/test/unit/connector-tool-snapshots.test.ts` 的「risk distribution」里加这一家的分布断言（读 / 写 / 破坏性计数，有 `toolPolicy` 调高的也断言）。上游以后改了工具，重新导出快照时这里会变红，逼人重新审一遍。
2. 有 `whoami` 的，补 `connector-whoami.test.ts`（S5）。
3. **测试必须在 Docker 里跑**（宿主机 glibc 加载不了 es-git，在宿主机上跑会得到误导性的失败）：
   ```
   export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH
   NODE_DIR=$HOME/.nvm/versions/node/v24.13.0; WT=$PWD
   docker run --rm --name kepcup-t -v $WT:$WT -v $NODE_DIR:$NODE_DIR:ro -w $WT --user $(id -u):$(id -g) \
     -e HOME=/tmp/home -e PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin kepcup-test:trixie \
     bash -c "mkdir -p /tmp/home && node scripts/run-tests.mjs run \
       packages/core/test/unit/connector-catalog.test.ts \
       packages/core/test/unit/connector-tool-snapshots.test.ts \
       packages/core/test/unit/connector-whoami.test.ts"
   ```
   不要在容器里跑 `pnpm test` / `pnpm install`。已知基线失败见 [dev/05-testing.md](../dev/05-testing.md) 与 [docker-test-runner 说明](../../todo/acp-manual-followups.md)。
4. `pnpm typecheck`、`pnpm lint`（宿主机；lint 只允许 main 带来的 `debug-dev-pin.spec.ts` 基线错误）。

目录契约测试（`connector-catalog.contract`）会自动检查：schema 合法、slug 与 name 唯一、图标存在且无脚本、`remotes[0]` 是 https、`toolPolicy` 的风险值合法、带 `releaseGate`、预注册条目有 `clientRef`。

## S8 真实走一遍（账号持有人，开发版）

开发构建**不过滤**发行门禁，新条目在 扩展中心 → 连接 里立刻可见、可连接——这一步验的是目录里的**预置连接**。

- [ ] 在 扩展中心 → 连接 里连接成功，标签是 `whoami` 给的（不是「Xxx #1」）。
- [ ] 多账号：再连一个账号，标签能区分；同一个 Bot 对同一应用只能勾选一个连接。
- [ ] Bot 勾选后，在对话里完成一件只读的事（搜索 / 列表）。
- [ ] 写工具：触发一次，审批卡显示「以哪个账号」+ 参数摘要；破坏性档没有「总是允许」。
- [ ] 令牌过期后重连（对话里出重连卡，重连后任务续跑）；断开后令牌被吊销 / 清除。
- [ ] 该家特有的限制验证过（S1 的特例）。

任何一项失败，回到对应步骤修，不要放行。

## S9 放行

1. 把 slug 加进 `apps/desktop/connector-release-gates.json` 的 `approved`。
2. 再跑 S7 的测试：守门测试会要求「已放行的条目必须有快照且注解齐全」。
3. 发行构建（`pnpm dist`）才按门禁过滤；开发构建与测试不过滤，所以你在 S3 起就能看到它——**放行只决定用户能不能在发行版里看到**。

## S10 更新文档

- [ ] [todo/connected-apps.md](../../todo/connected-apps.md) 附录 B：加一小节（工具数、注解覆盖、分级分布、`toolPolicy` / `scopes` / `whoami` 结论、放行）。参照 B.8。
- [ ] [todo/extension-center.md](../../todo/extension-center.md) §4.1 适配队列：更新这家的状态。
- [ ] [docs/dev/PROGRESS.md](../dev/PROGRESS.md)：加一条适配记录（交付、验证、未做）。
- [ ] 偏离了本指南或设计的地方，记 [DEVIATIONS.md](../dev/DEVIATIONS.md)。
- [ ] 发现本指南和现实不符，当场修本文件。

## S11 发布

条目随应用发布（`catalog.json` 与门禁文件都会被打进发行构建）。想在两次应用发版之间更新目录，可走签名目录通道（`dl.kepcup.com`）：`infra/cloudflare/sign-directory.sh` 签名、`with-env.sh wrangler deploy` 部署，细节与限制见 [infra/cloudflare/directory/README.md](../../infra/cloudflare/directory/README.md) 与 DEV-022（目录合并与发行门禁的权威来源）。**放行类变更仍以随应用打包的门禁为准**，不要指望只靠目录远程放行。

## 常见陷阱

- **在宿主机上跑测试**：glibc 加载不了 es-git，会得到一堆与改动无关的失败，且可能把真回归当成环境问题放过（这个坑踩过）。一律 Docker。
- **`toolPolicy` 想放宽没用**：它只能调高。要放宽，等用了一段时间后在设计层面另行决定。
- **`subjectPath` 选错**：会合并不同账号或让连接换了工作区（S5.4）。
- **把真实账号信息提交进仓库**：快照要扫一遍；`whoami` 测试用虚构值。
- **厂商文档里的地址过期**：以厂商当前文档为准，探测一次再写。
- **条目改了没升 `version`**：目录合并按版本判断新旧，改了条目就递增。
- **忘了图标**：契约测试会红；用占位图标，不放商标。
- **凭证**：任何时候都不要让令牌 / 密码 / secret 出现在聊天、日志、提交里。
