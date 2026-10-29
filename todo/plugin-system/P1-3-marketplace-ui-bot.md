# P1-3 · 市场界面、更新界面、Bot 发起安装、邮件预填模板

> 状态：**待实施**。依赖：P1-2（更新流）与 P0a-3（界面基础）已合入。分支：`feat/plugins/p1-3-marketplace-ui-bot`。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §6.3（Bot 发起安装）、§4（mail 行）、§9（UI）。Q6 已确认：**Bot 只能提议官方索引里 `verified` 级插件**。

## 1. 目标

交付后：扩展中心有最前面的「**市场**」页签（浏览官方市场、按类别 / 关键字筛选、认证与社区分组、从市场安装）；「已安装」页签能看到更新徽标、检查更新、单个 / 全部更新（权限扩大时弹差异并要求勾选确认）、撤销提示，并带上市场设置项；**Bot 可以检索官方市场并提议安装插件**（对话里出现带同意内容的确认卡，用户点「安装」后 run 续跑）；邮件「添加邮箱」表单多出插件提供的预填模板。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| 核心：e2e 测试缝（`KEPCUP_TEST_PLUGIN_MARKET`）、`mail.providerTemplates.list`、`PluginInstallRequests`、`plugin_search` / `plugin_request_install` 及其全部登记、`confirm-plugin-install` 设置需求 | ACP 外部智能体的插件工具（**不提供**；不进任何能力包） |
| 渲染：`market` 页签、`ExtensionMarket`、对话框的市场 / 更新模式、「已安装」页的更新 / 撤销 / 设置区、Bot 确认卡、邮件表单模板 | 详情页 README 拉取、远程图标 URL（**图标已改为签名索引内联，见 DEV-053 修订**） |
| i18n、单测、e2e、文档 | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -5
rg -n "app_propose_local_connector|confirm-local-connector|LocalConnectorToolFacade" packages apps --glob '!**/dist/**' --glob '!node_modules' -l
rg -n "install_skill|app_request_connection" packages/core/src/tools/index.ts packages/core/src/agent/effects/classify.ts packages/core/src/settings/context.ts packages/core/src/agent/context/system-prompt.ts packages/core/test/unit/tool-effects.test.ts
rg -n "hasAppRequestTool" packages/core/src
rg -n "PENDING_DESKTOP_ANCHORS" packages/shared/src/settings-catalog/coverage.ts
ls apps/desktop/src/renderer/src/lib/features/chats | rg "Confirm|Setup"
```

必读（**逐行对照写，不要凭印象**）：`packages/core/src/tools/app-tools.ts`（`app_propose_local_connector` 的工具定义与 facade：l.23–60、149–170）、`packages/core/src/dispatch/orchestrator.ts`（`#localConnectorFacade` l.5590–5634、`setupHit` l.3616、`setupRequirementErrorText` l.5934、工具 deps 装配 l.4105 一带、`hasAppRequestTool` l.4676）、`packages/core/src/apps/local-connectors.ts`（`#rateLimit` l.497–524）、`packages/core/src/tools/index.ts`（`ResponseToolDeps`、`buildResponseTools` 的 `turn` 与 task 两个分支）、`packages/core/src/agent/context/system-prompt.ts`（l.100–110 标志、l.143–165 与 l.655–676 规则、l.738、l.1057–1058）、`apps/desktop/src/renderer/src/lib/features/chats/ConfirmLocalConnectorBody.svelte`、`features/settings-card/SettingSetupBody.svelte`（l.86–92）、`stores/chat-session.svelte.ts`（`continueAfterSetup` l.323、`dismissSetupCard` l.313）、`features/mail/MailAccountAddForm.svelte`、`features/plugins/*`（P0a-3 成果）、`packages/core/test/integration/local-connectors.test.ts`（脚本化假模型调用工具的写法）。

## 4. 步骤

### 步骤 1：核心——测试缝与邮件模板 RPC

1. **e2e 测试缝**：`start.ts` 在 `__KEPCUP_TEST_HOOKS__ === true && env.NODE_ENV === 'test'` 时读环境变量 `KEPCUP_TEST_PLUGIN_MARKET`（JSON：`{ "baseUrl": "http://127.0.0.1:PORT/plugins/v1", "keys": [<ConnectorIndexPublicKey>…] }`），等价于 `options.pluginMarketplace` 并把 `baseUrl` 的 host 同时作为**回环允许主机**：传给 `createSafeFetch({ loopbackHosts: [...] })`，并让 `MarketplaceSync.download()` 的 URL 守卫放行该 host（`isSafeDirectoryRemoteUrl(url) || testLoopbackHosts.includes(new URL(url).host)`；`MarketplaceSyncDeps` 加 `testLoopbackHosts?: readonly string[]`）。**仅测试构建生效**（打包构建里该分支被 `define` 死码剔除，`pack-hooks.test.ts` 的标记检查不应新增报错——跑一遍确认）。
2. **邮件模板契约**（shared）：`domain/mail.ts` 加

   ```ts
   export const mailProviderTemplateSchema = z.object({
     id: z.string(),                       // `${pluginId}#${localId}`
     pluginId: z.string(), pluginName: z.string(),
     label: z.string(),
     imap: z.object({ host: z.string(), port: z.number().int(), secure: mailSecureSchema }),
     smtp: z.object({ host: z.string(), port: z.number().int(), secure: mailSecureSchema }),
     defaultMode: mailModeSchema, defaultPollSec: z.number().int(), minPollSec: z.number().int(),
     helpUrl: z.string().nullable(),
   });
   export const mailProviderTemplatesListOutputSchema = z.object({ templates: z.array(mailProviderTemplateSchema) });
   ```

   `rpc/methods.ts`：`'mail.providerTemplates.list': { input: voidInput, output: mailProviderTemplatesListOutputSchema }` + `APP_METHODS`。
3. **core**：`PluginRegistry.mailTemplates(): MailProviderTemplate[]`——遍历 `installed && enabled` 的行，读清单的 `contributions.mail` 映射（读不到的插件跳过）；`rpc/mail-bindings.ts` 注册 `mail.providerTemplates.list`（`services.plugins?.mailTemplates() ?? []`）。
4. **测试**：`plugin-registry.test.ts` 补 `mailTemplates`（停用的插件不出现、`id` 形状）；`packages/core/test/integration/plugins.test.ts` 补：装一个含 `mail` 贡献的夹具后 `mail.providerTemplates.list` 返回对应模板；用模板的字段经 `mail.accounts.create`（`provider: 'custom'` + 端点 + `imapSecure` / `smtpSecure` / `mode` / `pollIntervalSec`，**用现有 mail 集成测试的假 IMAP/SMTP 服务器**，参照 `packages/core/test/integration/mail*.test.ts`）能创建账号，且 `minPollSec` 之上的全局 60 秒下限仍生效（传 30 秒被夹到 60）。

### 步骤 2：核心——Bot 工具

**2.1 `plugins/install-requests.ts`**（`PluginInstallRequests`）：

```ts
export interface PluginToolContext { botId: string | null; conversationId: string | null; runId: string | null }
export interface PluginSearchHit { id: string; version: string; name: string; description: string; categories: string[] }
export class PluginInstallRequests {
  constructor(deps: { marketplace: MarketplaceService; registry: Pick<PluginRegistry, 'list'>; clock: Clock; appVersion: string; platform?: NodeJS.Platform });
  /** 只读：官方市场里 verified 级、兼容、未被撤销的条目，按 query 切词后对 id / name / description / categories 做大小写不敏感匹配，最多 10 条。 */
  search(query: string): PluginSearchHit[];
  /** 校验并限频；通过时返回要放进 run.setup 的需求。 */
  request(input: { pluginId: string; version?: string; reason: string }, context: PluginToolContext):
    | { ok: true; requirement: Extract<SetupRequirement, { kind: 'confirm-plugin-install' }> }
    | { ok: false; message: string };
}
```

`request` 的顺序（失败一律 `{ ok:false, message }`，文案固定、不回显索引原文）：① **限频**（先于任何校验，照 `LocalConnectors.#rateLimit`：`runId` 内 ≤ 5 次、同一 `conversationId` 每小时 ≤ 20 次，`clock` 计时，两个 Map 与 200 条上限的 run 计数裁剪）；② `marketplace.current()` 为空或 `!marketplace.isOfficial()` → 「插件市场未启用，或当前不是官方市场」；③ `find(...)` 为空 → 「官方市场里没有这个插件」；④ `entry.tier !== 'verified'` → 「只有官方认证的插件可以由 Bot 提议安装」；⑤ 已被撤销 / 不兼容 → 对应固定文案；⑥ `registry.list()` 里该 id 已装 → 「已经安装了（v…）」；⑦ 通过：`requirement = { kind: 'confirm-plugin-install', pluginId, version: entry.version, name: sanitizeDisplayText(entry.summary.name, 100), reason: sanitizeDisplayText(input.reason, 300) }`（`reason` 清洗后为空则报「请说明为什么需要它」）。

**2.2 shared：`confirm-plugin-install` 设置需求**：`packages/shared/src/domain/types.ts` 的 `setupRequirementSchema`（l.1507–1583，`z.discriminatedUnion('kind', …)`）加成员 `z.object({ kind: z.literal('confirm-plugin-install'), pluginId: z.string().min(3).max(200), version: z.string().min(1).max(64), name: z.string().min(1).max(100), reason: z.string().max(300) })`（本地 `z.string()` 约束，**不要 import `plugin-manifest.ts`**，避免循环引用）。`pnpm --filter @kepcup/shared run build`。核心里有穷举 `switch` 的地方会编译失败，按提示补：`dispatch/orchestrator.ts` 的 `setupRequirementErrorText`（l.5934，无 `default`）加 case，文案「Bot 建议安装插件「{name}」，请在对话里确认」。测试：`packages/shared/test/unit/plugin-setup.test.ts`（schema 往返、拒绝多余 / 缺字段）。

**2.3 `tools/plugin-tools.ts`**（照 `app-tools.ts` 的 `app_propose_local_connector` 段落写）：

```ts
export const PLUGIN_SEARCH_TOOL = 'plugin_search';
export const PLUGIN_REQUEST_INSTALL_TOOL = 'plugin_request_install';
export interface PluginToolFacade {
  search(query: string): PluginSearchHit[];
  request(input: { pluginId: string; version?: string; reason: string }):
    Promise<{ ok: true } | { ok: false; message: string }>;     // ok:true 时 facade 已把 requirement 记进 setupHit
}
export function buildPluginTools(input: { identity: RunIdentity; facade: PluginToolFacade; gateway: ToolGateway }): ToolDefinition<never>[];
```

- `plugin_search`：参数 `{ query: string }`（`Type.String({ minLength: 1, maxLength: 100 })`）；返回文本：无结果 → 「官方市场里没有匹配的插件」；有结果 → 每条一行 `- {name}（plugin_id: {id}，v{version}，{categories 的中文}）：{description 截断到 120 字}`，**整段用 `untrustedBlock(...)` 包裹**（`core/src/infra/data-boundary.ts`，不要手写 `<untrusted>`），总长 ≤ 4000 字。工具描述写明「只检索官方认证插件」。
- `plugin_request_install`：参数 `{ plugin_id: string; version?: string; reason: string }`；调 `facade.request`；`ok:false` → `{ ok: false, content: message, errorCode: 'INVALID_INPUT' }`；`ok:true` → `{ ok: false, content: '已向用户发起插件安装确认，等待用户操作；不要再重复请求。', errorCode: TOOL_SETUP_REQUIRED }`（`TOOL_SETUP_REQUIRED` 从 `tools/image-tools.ts` 引，与 `app-tools.ts` l.105 / l.167 同写法）。工具描述写明：只会出确认卡、由用户决定；不要索要令牌 / 密钥；不要同一插件反复请求。
- **文件里 `name:` 必须独占一行写成 `name: 'plugin_search',` / `name: 'plugin_request_install',`**，且常量写成 `export const PLUGIN_REQUEST_INSTALL_TOOL = 'plugin_request_install';`（`tool-effects.test.ts` 用正则扫这两种形态）。

**2.4 登记（逐处照做，漏一处就有测试失败或行为缺失）**：

| 位置 | 改动 |
|---|---|
| `tools/index.ts` | `ResponseToolDeps` 加 `pluginInstall?: PluginToolFacade`（紧挨 `apps`，约 l.201）；`buildResponseTools` 里 `const pluginTools = deps.pluginInstall !== undefined ? buildPluginTools({ … }) : [];`，并在 **`turn` 分支**（`finalize([...])`，约 l.1223–1260，紧跟 `...appTools`）与**任务分支**（约 l.1263–1307，紧跟 `...appTools`）都展开 `...pluginTools`；子代理（`buildSubagentResearchTools`）**不加** |
| `dispatch/orchestrator.ts` | `OrchestratorDeps` 加 `pluginInstall?: { search(query: string): PluginSearchHit[]; request(input, context: PluginToolContext): { ok: true; requirement } \| { ok: false; message } }`（约 l.466，紧挨 `skillInstall`）；在 `#localConnectorFacade`（l.5590–5634）旁新增 `#pluginInstallFacade(identity, setupHit)`：`request` 调 `deps.pluginInstall.request(input, { botId, conversationId, runId })`，成功时 `setupHit.requirement = requirement`（**写法逐行对照 l.5616**）并返回 `{ ok: true }`；在工具 deps 装配处（l.4105 一带 `…(apps !== undefined ? { apps: … } : {})` 旁）按同样的条件展开 `pluginInstall: this.#pluginInstallFacade(…)`；**turn 与 task 两条构建路径都要传**（对照 `apps` 的传法） |
| `start.ts` | 在 `new Orchestrator({…})`（约 l.2194）之前 `const pluginInstallRequests = new PluginInstallRequests({ marketplace, registry: plugins, clock, appVersion: options.appVersion ?? '0.0.0', … })`；Orchestrator deps 里加 `pluginInstall: pluginInstallRequests`（`search` / `request` 直接是它的方法，注意绑定 `this`） |
| `agent/effects/classify.ts` | `BUILTIN_EFFECTS` 加 `plugin_search: 'none'`、`plugin_request_install: 'local'`（紧挨 `app_request_connection` l.71） |
| `settings/context.ts` | `plugin_search` 进 `UNTRUSTED_TOOLS`（l.109 起，返回外部目录文本）；`plugin_request_install` 进 `TRUSTED_TOOLS`（l.37 起，同 `app_request_connection`）。测试 `settings-catalog-host.test.ts:441–453` 要求每个已分类工具恰在其中一个清单里 |
| `test/unit/tool-effects.test.ts` | 把 `tools/plugin-tools.ts` 加进 l.150–178 的被扫描文件清单 |
| `agent/context/system-prompt.ts` | `SystemPromptInput`（l.100–110 的标志区）加 `hasPluginTools?: boolean`；在 l.655–676 的规则 IIFE 里紧挨 `hasAppRequestTool`（l.658）加一条**固定措辞**的规则：「缺少某项能力（如处理某类文件、接入某个服务）且已装技能与预置技能都解决不了时，先用 plugin_search 检索官方插件市场；有合适的认证插件再用 plugin_request_install 请用户确认安装（只会弹确认卡，由用户决定，安装后你会被续跑）；不要索要令牌或密钥，不要对同一插件重复请求。」；把 D63 阶梯文本（任务规则 l.143–165 一带，写作时 l.162）改为「已安装技能 → `<recommended_skills>` 预置 → 官方插件市场 → `web_search` 外部仓库」——**只在 `hasPluginTools` 时多出「官方插件市场」这一级**，否则文本逐字不变；ACP 版（l.1057–1058、`AGENT_PLATFORM_RULES`、`HOST_POLICY_LINES`）**不动** |
| `dispatch/orchestrator.ts` | 与 `hasAppRequestTool` 同处（l.4676–4677 以及 ACP / 其它构建 prompt 的位置按 `rg -n hasAppRequestTool` 逐个对照）传 `hasPluginTools: true`——**仅当 `pluginInstall` deps 存在**，且只在 turn / task 两条路径，ACP 路径不传 |
| `docs/dev/04-agent-runtime.md` | 工具目录（l.461、l.481 一带）加 `plugin_search`、`plugin_request_install` 两行 |
| ACP 外部智能体 | **首期不注入**：不要改 `shared/src/domain/host-capabilities.ts` 的任何能力包、不要加进 `READ_ONLY_TOOLS`（`agent/external/capabilities.ts`）。加一条断言（放 `shared/test/unit/plugin-setup.test.ts` 或 host-capabilities 的既有测试旁）：`capabilityOfTool('plugin_search')` 与 `capabilityOfTool('plugin_request_install')` 均为 `null` |

**2.5 测试**：
- `packages/core/test/unit/plugin-install-requests.test.ts`：`search`（只返回 verified / 兼容 / 未撤销、切词匹配、上限 10、官方市场未启用返回空）；`request` 的每个失败分支与固定文案、限频（run 内第 6 次、同对话每小时第 21 次被拒，`clock` 前进一小时后恢复；限频先于校验，失败也计数）、`reason` 清洗（控制 / 零宽 / 尖括号被去掉、超长截断、清洗后为空被拒）、已装被拒、成功返回的 `requirement`。
- `packages/core/test/unit/plugin-tools.test.ts`（模板：`mcp-tools-auth.test.ts:270–322`）：两个工具的参数校验与结果形状；`plugin_search` 的结果被 `<untrusted>` 包裹且无法被条目文案里的 `</untrusted>` 逃逸；`plugin_request_install` 成功时返回 `SETUP_REQUIRED`；**仅在 facade 存在时注册**，且 turn 与 task 两种模式都有、子代理没有。
- `packages/core/test/unit/context-assembly.test.ts`（或新文件，模板 l.129–147）：`hasPluginTools` 开 / 关时规则与阶梯文本的有无；关时与旧文本逐字相同（快照式断言）。
- `packages/core/test/integration/plugins-bot.test.ts`（脚本化假模型，写法照 `integration/local-connectors.test.ts`）：假模型依次调用 `plugin_search`（命中夹具里的认证插件）→ `plugin_request_install` → run 以 `setup.kind === 'confirm-plugin-install'` 失败结束；之后经 `plugins.install`（`marketplace` 来源）装上，再 `runs.retry`，run 续跑成功；`community` 级条目被拒；官方市场未启用时被拒。
- 既有：`tool-effects.test.ts`、`settings-catalog-host.test.ts`、`app-prompt-capabilities.test.ts` 通过。

### 步骤 3：渲染——页签、store 与对话框扩展

1. **页签**：`tabs.ts` 的数组改为 `['market', 'installed', 'skills', 'connections', 'mcp', 'mail', 'localCollab']`（字面量写法不变）；`tabs.test.ts`、`settings-catalog.test.ts` l.328–333 的硬编码清单、`extension-center.spec.ts` 的循环断言同步（`localCollab` + ArrowRight → `market`；`skills` + ArrowLeft → `installed`）；`ExtensionCenterBody.svelte` 加 `TAB_LABEL_KEYS.market` 与 `{:else if tab === 'market'}<ExtensionMarket />`（**在最后的裸 `{:else}` 之前**）；`EXCLUDED_SETTING_LOCATIONS` 加 `{ kind: 'extension-tab', id: 'market', reason: '插件市场的浏览与安装是对象管理，不是设置；市场地址等设置项在「已安装」页签' }`。
2. **store**：`plugins.svelte.ts` 增 `market = $state<PluginMarketEntry[]>([])`、`marketStatus = $state<PluginMarketStatus | null>(null)`、`marketLoading`；`loadMarket()`（`plugins.marketplace.list`）、`refreshMarket()`（`plugins.marketplace.refresh` 后 `loadMarket()` + `load(true)`）；订阅 `plugins.marketplace.updated` 事件触发 `loadMarket()`；`updateAll()`：对 `plugins` 里 `updateAvailable !== null` 的每个：`plugins.inspect({ source: { kind:'marketplace', id } })` → 若 `info.installable && info.update?.permissionsExpanded !== true && missingPluginConfig(info, initialPluginForm(info)).length === 0` 则 `plugins.update({ id, sha256: info.packageSha256, userConfig: buildPluginUserConfig(info, form) })`，否则计入「需逐个确认」；返回 `{ done, skipped }`。单测（`plugins.svelte.test.ts` 补）：`updateAll` 的三种分流、事件刷新。
3. **`PluginInstallDialog` 扩展**：`mode: 'file' | 'folder' | 'marketplace'`，新增 props `marketplace?: { id: string; version?: string }`。`marketplace` 模式：不渲染路径输入 / 选择按钮，**打开即自动 `inspect`**（`source = { kind:'marketplace', id, version }`）；`info.update` 非空时的更新块（`plugins.update.from`、`plugins.update.expanded` + `info.update.added` 列表、必须勾选的 `plugins-install-ack-diff`、未勾选时确认按钮禁用）**P1-2 步骤 7 已做简版**，这里把它整理成独立的 `data-testid="plugins-install-update-block"` 区块并补上版本对比的排版，不要重复实现；`info.existing` 非空且来源是市场 → 确认调用 `plugins.update`（带 `sha256`、`userConfig`、`acknowledgeDiff`），否则 `plugins.install`（本地来源的同 id 重装也在这里，带 `acknowledgeDiff`）；更新模式下 `plugins.update.keepSecrets` 提示出现在配置表单上方；按钮文案「更新」/「确认并安装」；成功 toast `plugins.update.done` / `plugins.toast.installed`；`PluginConsentPanel` 增 `update` 展示（由对话框传入，不改 props 以外的行为）。
4. **testid**：`plugins-install-ack-diff`、`plugins-install-update-block`。

### 步骤 4：渲染——市场页、已安装页补充、Bot 确认卡、邮件表单

**4.1 `features/extension-center/ExtensionMarket.svelte`**（根 `data-testid="extension-market"`，挂载时 `plugins.start(); void plugins.loadMarket()`）：

- 顶栏：搜索框 `plugins-market-search`、类别筛选 `plugins-market-cat-all|skill|connector|mcp|mail`（按 `categories` 过滤）、「刷新」`plugins-market-refresh`（调 `plugins.refreshMarket()`，进行中禁用并显示 `plugins.market.refreshing`）；
- 状态横幅 `plugins-market-status`：`state==='disabled'` → `plugins.market.status.disabled.{reason}`；`degraded` / `stale` → 对应文案；`endpoint==='custom'` → 常驻 `plugins.market.status.custom`；
- 列表分两组：**认证**（`tier==='verified'`，默认展开，标题 `plugins.market.verifiedSection`）与**社区**（默认折叠，标题 `plugins.market.communitySection`，开关 `plugins-market-community-toggle`）；客户端按搜索词与类别过滤；空态 `plugins-market-empty` / `plugins-market-nomatch`；
- 卡片 `plugins-market-card-{id}`：插件图标（`PluginIcon`，来自签名索引内联的 `summary.icon`，**不发起远程图片请求**；缺失 / 不可用时回落宿主默认拼图图标，不再显示名称首字母）、名称、版本、分级徽标、类别标签、描述（截断）、右侧按钮：未装 → 「安装」（`plugins-market-install-{id}`）；已装且 `installed.updateAvailable` → 「更新到 v…」（`plugins-market-update-{id}`）；已装 → 「已安装 · v…」（禁用）；`compatible === false` → 禁用并显示 `plugins.market.incompatible`；`revoked` → 红色徽标 `plugins.market.revokedWarn|Disable`，安装按钮禁用；
- 点击安装 / 更新 → 打开 `PluginInstallDialog`（`mode:'marketplace'`）。

**4.2 `ExtensionInstalled.svelte` 补充**：
- 卡片：`updateAvailable` 非空 → 徽标 `plugins.update.available` + 「更新」按钮 `plugins-update-{id}`（打开 `marketplace` 模式对话框）；`revoked` 非空 → 红色提示条 `plugins-revoked-{id}`（`plugins.revoked.warn|disable`）；`summary.origin === 'local'` 的卡片多一个「重新安装」入口 `plugins-reinstall-{id}`（打开 `file` 模式对话框）；
- 页头：「检查更新」`plugins-check-updates`（`plugins.refreshMarket()`，进行中显示 `plugins.update.checking`）、「全部更新」`plugins-update-all`（有可更新项时可点；完成后 toast `plugins.update.allResult`）；
- 页脚「插件设置」区，**两个锚点必须是静态字面量**：

  ```svelte
  <div data-settings-anchor="plugins-updates"><SettingsCatalogFields itemIds={['plugins.updates']} /></div>
  <div data-settings-anchor="plugins-marketplace"><SettingsCatalogFields itemIds={['plugins.marketplace']} /></div>
  ```

  同时把 `'plugins-updates'`、`'plugins-marketplace'` 从 `coverage.ts` 的 `PENDING_DESKTOP_ANCHORS` **删除**（P1-1 登记的；否则覆盖率测试报「待补锚点已存在」）。

**4.3 Bot 确认卡**：
- `features/chats/ConfirmPluginInstallBody.svelte`（照 `ConfirmLocalConnectorBody.svelte` 的结构与 props 约定；先读它）：props 取自 `setup`（`pluginId / version / name / reason`）与会话回调；**挂载时** `core.call('plugins.inspect', { source: { kind: 'marketplace', id: pluginId, version } })`，期间显示加载态，失败显示 `plugins.inspectFailed`；成功渲染：标题 `plugins.bot.title`、`plugins.bot.reason`（`reason` 作为**纯文本**渲染，不当 HTML / Markdown）、`plugins.bot.notice`、`<PluginConsentPanel>`（含 `mcpb` 的 `user_config` 表单）；按钮「确认安装」`plugins-bot-confirm`（调用 `plugins.install`，`sha256 = info.packageSha256`；成功后 `plugins.afterMutation()` 并调用会话的 `continueAfterSetup()`）与「不装了」`plugins-bot-dismiss`（`dismissSetupCard()`）；`info.installable === false`（冲突 / 已装 / 不兼容）→ 显示 `blockers`，只留「不装了」。
- 路由：`features/settings-card/SettingSetupBody.svelte`（l.86–92 的分支链）加 `confirm-plugin-install` → 渲染该组件；`features/chats/setup-alias.ts` 对新 kind 应返回 `null`（核对，不是别名）；任何对 `SetupRequirement.kind` 的穷举（`rg -n "confirm-local-connector" apps/desktop/src` 逐个对照）补上新 kind。

**4.4 邮件表单模板**：
- 纯函数 `features/mail/mail-template.ts`（单测 `mail-template.test.ts`）：`templateOptionValue(id) = 'tpl:' + id`、`parseTemplateOption(value): string | null`、`applyTemplate(template): { provider: 'custom'; imapHost; imapPort: string; smtpHost; smtpPort: string; imapSecure; smtpSecure; mode; pollIntervalSec }`（端口转字符串，与表单现有 `$state` 一致）。
- `MailAccountAddForm.svelte`：挂载时 `core.call('mail.providerTemplates.list')`（失败静默当作空）；`<select>`（l.98–105）在内置厂商之后加 `<optgroup label=t('mail.template.group')>`，每个模板一个 `<option value={templateOptionValue(id)}>`，文案 `mail.template.option`；**`bind:value={provider}` 不能直接装模板 id**——新增 `$state` `templateId`，`select` 的 `onchange` 里：选中模板 → `provider = 'custom'`、`templateId = id`、用 `applyTemplate` 填 `imapHost / smtpHost / imapPort / smtpPort` 与新增的 `imapSecure / smtpSecure / mode / pollIntervalSec` 状态；选中普通厂商 → `templateId = null`；模板选中时备注区显示 `mail.template.note`、帮助链接用 `template.helpUrl`；`mail.accounts.create` 的入参（l.61–75）在 `provider==='custom'` 时附带 `imapSecure / smtpSecure / mode / pollIntervalSec`（**仅当 `templateId !== null`** 附带，普通自定义邮箱的请求体保持原样）。两个调用方（`ExtensionMail.svelte:201`、`SettingCardEmbed.svelte:276`）不改。

### 步骤 5：i18n

两种语言**同位置**追加（`locales.test.ts` 强制键序一致）。`plugins.update.from / expanded / ack / keepSecrets` 四个键**已在 P1-2 步骤 7 添加**，这里不要重复。`extensionCenter.tabs.market` 放在 `extensionCenter.tabs.installed` 之前；`plugins.market.* / plugins.update.* / plugins.revoked.* / plugins.bot.*` 放在 P0a-3 加的 `plugins.*` 块末尾；`mail.template.*` 放在 `mail.*` 块末尾。

| key | zh-CN | en-US |
|---|---|---|
| `extensionCenter.tabs.market` | 市场 | Market |
| `plugins.market.title` | 插件市场 | Plugin marketplace |
| `plugins.market.search` | 搜索插件 | Search plugins |
| `plugins.market.category.all` | 全部 | All |
| `plugins.market.category.skill` | 技能 | Skills |
| `plugins.market.category.connector` | 连接 | Apps |
| `plugins.market.category.mcp` | MCP | MCP |
| `plugins.market.category.mail` | 邮件 | Mail |
| `plugins.market.refresh` | 刷新 | Refresh |
| `plugins.market.refreshing` | 同步中… | Syncing… |
| `plugins.market.empty` | 市场里暂时没有可用的插件。 | No plugins are available in the marketplace yet. |
| `plugins.market.noMatch` | 没有符合条件的插件。 | No plugins match. |
| `plugins.market.verifiedSection` | 认证插件 | Verified plugins |
| `plugins.market.communitySection` | 社区插件（未经 KepCup 人工审核） | Community plugins (not reviewed by KepCup) |
| `plugins.market.communityShow` | 显示社区插件 | Show community plugins |
| `plugins.market.communityHide` | 收起社区插件 | Hide community plugins |
| `plugins.market.status.disabled.no_keys` | 插件市场尚未启用（此版本没有内置的市场签名公钥）。 | The marketplace is not enabled (this build has no marketplace signing key). |
| `plugins.market.status.disabled.no_custom_key` | 已设置自建市场地址但没有填写签名公钥，市场不可用。 | A custom marketplace URL is set without a signing key, so the marketplace is unavailable. |
| `plugins.market.status.degraded` | 同步失败，正在使用上一次的缓存：{error} | Sync failed; showing the last cached data: {error} |
| `plugins.market.status.stale` | 市场数据已超过 3 天未更新。 | Marketplace data has not been updated for over 3 days. |
| `plugins.market.status.custom` | 当前使用自建市场，其插件最高按「社区」级对待。 | Using a custom marketplace; its plugins are treated as Community at most. |
| `plugins.market.install` | 安装 | Install |
| `plugins.market.installed` | 已安装 · v{version} | Installed · v{version} |
| `plugins.market.updateTo` | 更新到 v{version} | Update to v{version} |
| `plugins.market.incompatible` | 不兼容：{reason} | Incompatible: {reason} |
| `plugins.market.revokedWarn` | 已被撤销，不建议使用 | Revoked; not recommended |
| `plugins.market.revokedDisable` | 已被撤销并停用 | Revoked and disabled |
| `plugins.update.available` | 有新版本 v{version} | Update available: v{version} |
| `plugins.update.button` | 更新 | Update |
| `plugins.update.check` | 检查更新 | Check for updates |
| `plugins.update.checking` | 检查更新… | Checking for updates… |
| `plugins.update.all` | 全部更新 | Update all |
| `plugins.update.allResult` | 已更新 {done} 个，{skipped} 个需要你逐个确认（权限有变化或需要配置）。 | Updated {done}; {skipped} need your confirmation one by one (permissions changed or configuration needed). |
| `plugins.update.title` | 更新插件 | Update plugin |
| `plugins.update.failed` | 更新失败：{reason} | Update failed: {reason} |
| `plugins.update.done` | 已将「{name}」更新到 v{version} | Updated "{name}" to v{version} |
| `plugins.reinstall` | 重新安装… | Reinstall… |
| `plugins.revoked.warn` | 该插件版本已被撤销，建议卸载。 | This plugin version has been revoked; consider uninstalling it. |
| `plugins.revoked.disable` | 该插件已被撤销并自动停用。 | This plugin was revoked and has been disabled automatically. |
| `plugins.settings.title` | 插件设置 | Plugin settings |
| `plugins.bot.title` | Bot 建议安装插件 | A Bot suggests installing a plugin |
| `plugins.bot.reason` | Bot 的理由：{reason} | The Bot's reason: {reason} |
| `plugins.bot.notice` | 只有你确认后才会安装；确认前不会写入任何内容。 | Nothing is installed until you confirm. |
| `plugins.bot.confirm` | 确认安装 | Confirm install |
| `plugins.bot.dismiss` | 不装了 | Not now |
| `mail.template.group` | 来自插件的模板 | Templates from plugins |
| `mail.template.option` | {label}（{plugin}） | {label} ({plugin}) |
| `mail.template.note` | 此模板由插件「{plugin}」提供，创建的账号按「自定义」邮箱保存。 | This template comes from the plugin "{plugin}"; the account is saved as a Custom mailbox. |

### 步骤 6：e2e 与文档

**6.1 e2e** `apps/desktop/test/e2e/plugins-market.spec.ts`（启动 / 清理照 `plugins.spec.ts`；市场由测试内起一个本地 HTTP 服务——`@kepcup/testkit` 的 `file-server`——托管**用测试密钥签的** `index.json` / `.sig` 与 `.kepcup` 包，env 设 `KEPCUP_TEST_PLUGIN_MARKET`）。索引与包用 `packages/core/test/support/plugin-market-fixture.ts`（P1-1）造；**e2e 不能 import core 的 test support 时**，把需要的两个函数（`buildPluginIndex`、`pluginIndexEntryFor`）搬进 `@kepcup/testkit`（`src/plugin-market-fixture.ts`），core 测试改从 testkit 引——**由你判断搬不搬**，写进实施记录。用例：

| 用例 | 断言 |
|---|---|
| 未配置市场（不设 env） | 「市场」页签存在且是最前一个；`plugins-market-status` 显示 `no_keys` 文案；无卡片 |
| 浏览与筛选 | 设 env 后：认证卡片可见、社区卡片默认折叠（点 `plugins-market-community-toggle` 展开）；搜索词与类别筛选生效 |
| 从市场安装 | 点 `plugins-market-install-{id}` → 对话框自动检视 → 同意面板（认证来源**没有** developer 警示）→ 确认 → 「已安装」页出现、`plugins-tier-{id}` 含「已认证」；市场卡变为「已安装」 |
| 更新 | 把索引换成 1.1.0（含新增主机权限）并重新签名 → 点 `plugins-check-updates` → `plugins-update-{id}` 出现 → 打开对话框：更新块与新增权限列表可见、`plugins-install-ack-diff` 未勾选时确认禁用 → 勾选后更新成功；版本变 1.1.0 |
| 撤销 | 索引加 `revoked: [{ id, action: 'disable' }]` → 刷新后卡片出现 `plugins-revoked-{id}`，启用开关为关 |
| 自建市场 | 在「已安装」页的设置区填 `pluginMarketplaceUrl` 无公钥 → 市场页显示 `no_custom_key` |
| Bot 确认卡 | 脚本化假模型调用 `plugin_search` → `plugin_request_install`（假模型脚本写法见 `apps/desktop/test/e2e/` 里其它用 `startMockLlm` 驱动工具调用的规格，如 `local-connectors.spec.ts`）→ 对话里出现 `plugins-bot-confirm`、同意面板、Bot 理由 → 点确认后插件已装且 run 续跑。**若脚本化成本过高**，用 core 集成测试（步骤 2.5）+ 组件逻辑单测替代，并在实施记录说明 |

**6.2 文档**：`docs/design/29-connected-apps.md` §16.1 表加「市场」行；`docs/design/22-file-skill-routing.md` 在 D63 阶梯处加一句「P1 起升级为插件阶梯（设计 51 §6.3）」；`docs/design/35-mail-channel.md` 加一句「插件可提供基于自定义邮箱的预填模板（设计 51）」；`docs/dev/PROGRESS.md` 验收表加行「插件系统 P1（D104）」。

**6.3 收口**：本阶段**跑一次**全量 `pnpm test`；e2e：`pnpm build` 后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/plugins-market.spec.ts test/e2e/plugins.spec.ts test/e2e/extension-center.spec.ts test/e2e/narrow-layout.spec.ts`。

## 5. 验收

- [ ] 步骤 1–6 列出的测试全绿；既有测试不回归（`tool-effects`、`settings-catalog-host`、`settings-catalog`、`locales`、`extension-center` 的 e2e）。
- [ ] 默认构建（无公钥、无测试 env）下：市场页签可打开、显示「未启用」、**零网络请求**；Bot 的 `plugin_search` 返回空、`plugin_request_install` 被拒且不弹卡。
- [ ] Bot 只能提议官方 `verified` 级：核心测试覆盖 `community`、自建市场、已装、已撤销、限频五种拒绝。
- [ ] ACP 外部智能体拿不到插件工具（断言见步骤 2.4 末行）。
- [ ] `rg -n "plugins-updates|plugins-marketplace" packages/shared/src/settings-catalog/coverage.ts` 里 `PENDING_DESKTOP_ANCHORS` 已不含这两项；设置覆盖率测试通过。
- [ ] 渲染层无硬编码中文；`locales.test.ts` 通过；`pnpm --filter @kepcup/desktop typecheck`、`build`、`build:web` 通过。
- [ ] 全量 `pnpm test` 失败集合不超出 PROGRESS.md 的基线；e2e 清单全绿。

## 6. 实施记录

### 完成（2026-10-27）

P1-3 六个步骤全部完成，并经一轮独立审查 + 聚焦复核。收口改动在当前分支工作树（见文末「收口改动」），阶段末提交由人工确认后执行。

**提交清单（已完成部分）**

| 提交 | 内容 |
|---|---|
| `84145246` | 步骤 1：`mailProviderTemplateSchema` + `mail.providerTemplates.list`；`PluginRegistry.mailTemplates()`；`KEPCUP_TEST_PLUGIN_MARKET` 测试缝（`testLoopbackHosts` 同时放行索引 fetch 与包下载；仅测试钩子构建读取） |
| `929083b2` | 步骤 2：`confirm-plugin-install` 设置需求（strict）；`PluginInstallRequests`（官方市场 only、`verified` only、限频先于校验、固定文案、名称 / 理由清洗）；`plugin_search` / `plugin_request_install`（turn + task，子代理结构性无此能力）；系统提示规则与 D63 阶梯（仅 `hasPluginTools`）；`docs/dev/04-agent-runtime.md` 两行 |
| `b6e9f284` | 步骤 3–5：`market` 页签（最前）+ 覆盖率排除项 + `PENDING_DESKTOP_ANCHORS` 清空；store 的市场视图 / `refreshMarket` / `updateAll` / `marketplace.updated` 订阅；`ExtensionMarket.svelte`；`ExtensionInstalled` 的更新徽标 / 检查更新 / 全部更新 / 撤销提示 / 重新安装 / 两个设置锚点；`PluginInstallDialog` 的 `marketplace` 模式与 `plugins.update` 路径；`ConfirmPluginInstallBody`；`MailAccountAddForm` 的模板预填（`tpl:` 前缀）；i18n 两语言 |
| `69f152a8` | 既有 e2e 的页签断言同步（`extension-center.spec.ts`、`plugins.spec.ts`：7 个页签、market 最前、键盘循环） |

**收口改动（已随 `846be723` 等收口提交入库）**

- **步骤 6.1 e2e**：新增 `apps/desktop/test/e2e/plugins-market.spec.ts`（6 例）。本地 `startFileServer` 托管用测试密钥签名的 `index.json` / `.sig` 与 `.kepcup`，`KEPCUP_TEST_PLUGIN_MARKET` 指过去；覆盖未配置市场（no_keys、无卡片、无空态）、认证 / 社区分组与搜索 / 类别筛选、从市场安装（无 developer 警示、市场卡变已安装）、检查更新 → 权限扩大（新增技能 + 新增主机）→ 勾选差异 → 更新到 1.1.0、撤销（提示 + 自动停用 + 开关关）、自建市场缺公钥（no_custom_key）以及「清空自建地址 → 官方市场重新可用」。
- **测试夹具上移**：`buildPluginIndex` / `pluginIndexEntryFor` / `makeMarketKey` / `memoryMarketFetch` / `PluginMarketKey` 从 `packages/core/test/support/plugin-market-fixture.ts` 搬到 `packages/testkit/src/plugin-market-fixture.ts`（e2e 不能引 core test support）；六个 core 测试改从 `@kepcup/testkit` 引。`makeMarketKey` 的原始公钥字节与 `memoryMarketFetch` 的 ETag / 304 行为逐字保留；`pluginIndexEntryFor` 的 `summary` 仍是「缺省字段不写入」的旧形状（schema 解析后等价）。
- **市场同步测试缝**：`MarketplaceSync.#parseEntry` 在 `testLoopbackHosts` 命中且 `downloadUrl` 是回环 `http:` 时，用占位 https URL 过共享 schema 再换回原地址（DEV-057）；`#downloadUrlAllowed` 同时要求 `http:` 协议。仅测试钩子构建会注入白名单。
- **UI 修复**：`ExtensionMarket` 每次挂载强制 `loadMarket(true)`（设置页切换市场端点后返回市场不会停在旧 status / 空列表）；新增市场专用 `marketError` 横幅与刷新失败 toast；`PluginInstallDialog` 的 `updating` 在 `info === null` 时不再误判为更新。
- **`updateAll` 收紧**：任何带 `user_config` 字段的 MCPB 都计入「需逐个确认」（不只必填）——更新的非敏感可选字段不会保留，直接更新会把用户改过的值静默换回默认。
- **Bot 工具加固**：`plugin_search` 的名称 / 描述经 `sanitizeDisplayText`；无 `version` 的 `request` 优先取与 `search` 相同的 verified 候选（找不到时回落到普通 `find`，保留 community / 撤销 / 不兼容的固定文案）；`platform` 从 `CoreServicesOptions` 透传；限频 Map 按使用刷新并在超限时清理过期对话键；搜索输出按 UTF-16 预算计算 `<untrusted>` 包裹开销（截断不劈开代理对）。
- **P1-1 回归修复**：`DirectorySync.revision()` 改为单调递增（内层 revision 变化或开关翻转都 +1）。此前「关闭 → 重新打开」后首次读取会因 revision 回退到关闭前的数而误判「没变化」，目录保持空列表（`connected-apps-p3-tier-directory.test.ts` 实测）。
- **文档**：设计 29 §16.1 加「市场」行；设计 22 D63 阶梯加插件市场一句；设计 35 加邮件模板一句；`docs/dev/PROGRESS.md` 加「插件系统 P1（D104）」行；`docs/dev/DEVIATIONS.md` 新增 DEV-056 / DEV-057。

**验证（真实执行）**

- 全量：`node scripts/run-tests.mjs run --maxWorkers=8` → **6844 通过 / 0 失败 / 37 跳过**（649 文件，2 skipped）。默认并发下 `user-avatar` 与 `watch` 两个既有负载敏感用例偶发超时；单跑分别通过（`user-avatar` 2/2、`watch` 13/13、`permission-bridge` 42 例批内全绿）。
- 构建：`pnpm build` 通过；`pnpm --filter @kepcup/desktop test:e2e plugins-market + plugins + extension-center + narrow-layout` → **19 例全绿**（6 + 9 + 2 + 2）。
- 类型检查：`pnpm --filter @kepcup/core typecheck`、`pnpm --filter @kepcup/desktop typecheck`（svelte-check 0 errors / 0 warnings）。
- 格式与 lint：对本阶段全部改动文件（`git diff --name-only c38c3308` + untracked，排除 `.sql`）跑 `prettier --check` 与 `eslint`，均干净。
- 定向：`plugin-install-requests`（13）、`plugin-tools`（6）、`marketplace-sync`（16）、`directory-sync`（28）、`context-assembly`（35）、`tool-effects`（34）、`plugins-bot`（3）、`connected-apps-p3-tier-directory`（4）、渲染端 `plugins` / `plugin-install` / `tabs`（19）全绿。

**自行判断点**

- `confirm-plugin-install` 用 `z.strictObject`（同块其它成员是普通 `z.object`）：需求由宿主生成、跨进程传递，多余字段是缺陷；shared 单测按「拒绝多余字段」断言。
- `sanitizeDisplayText` **不剥离尖括号**（全仓共用助手只处理控制 / 双向 / 零宽 / 空白）——任务书步骤 2.5 写的「尖括号被去掉」与实现不符；卡片按纯文本渲染，尖括号无注入风险，测试按真实行为断言（DEV-056）。
- `updateAll` 的「需逐个确认」判定：`installable === false`、`update.permissionsExpanded === true`、或任一 MCPB 有**任何** `user_config` 字段（含仅可选字段）→ skip。
- `PluginInstallRequests.search` 在上限内按 id 去重取最高兼容版本；无 version 的 `request` 复用同一 verified 候选集。
- **Bot 确认卡 e2e 用 core 集成测试替代**（任务书 §6.1 允许）：`packages/core/test/integration/plugins-bot.test.ts` 覆盖「plugin_search → plugin_request_install → setup 失败 → 用户安装 → retry 续跑」全流程；未再为 `ConfirmPluginInstallBody` 增加组件级测试。
- **市场测试缝的 schema 例外**：共享 `pluginIndexEntrySchema` 保持 https-only；只有测试构建注入 `testLoopbackHosts` 时才接受回环 http 条目（DEV-057）。
- **`__KEPCUP_TEST_PLUGIN_MARKET` 只在测试钩子构建 + `NODE_ENV=test` 读取**；打包构建被 define 折叠，普通构建市场公钥为空 = `no_keys`。

**已知遗留（不阻塞本阶段）**

- 详情页 README 拉取仍未做（DEV-053）；市场图标已改为签名索引内联（原始图标 ≤64 KiB），不再需要远程图标 URL。
- 「全部更新」的 UI 行为没有独立 e2e（store 单测覆盖三种分流）；市场「零网络请求」由 core 集成测试断言，e2e 只断言状态与无卡片。
- 全量测试在本机默认并发下存在既有负载敏感超时（`user-avatar` / `watch` / `permission-bridge`）；`--maxWorkers=8` 收口运行全绿。

**审查**

- 一审（独立只读）：无 P0；P1 为市场端点切换后停旧状态、`updateAll` 静默丢失可选配置、阶段文件格式 / lint 回归；P2 若干（搜索 / 限频 / 错误展示 / 夹具形状等）。
- 上述 P1 与可快速处理的 P2 已全部修复并补测试。二审聚焦复核除「搜索输出按码点截断、UTF-16 长度仍可能超 4000」一项外均通过；该项已改为按 UTF-16 预算截断（不劈开代理对）并补 emoji 用例，单测通过。

### 合入 v0.5.0 后的独立审查修复（2026-10-27）

六个域并行只读审查（核心 Bot 工具 / 核心市场同步与邮件模板 / 渲染层 / package-guard / app-validator / server），本阶段相关的修复：

- **`confirm-plugin-install` 需求过不了 schema（P2）**：`reason` / `name` 由 `sanitizeDisplayText` 按码点截断，而 `setupRequirementSchema` 的 `.max()` 按 UTF-16 码元计；200 个 emoji 的 reason 会让该对话的 `runs.list` / `runs.retry` 输出校验失败（INTERNAL）。`install-requests.ts` 增加 UTF-16 预算收口（不劈代理对），名称清洗后为空退回插件 id；`plugin_request_install` 的三个参数加硬上限（`plugin_id` 200 / `version` 64 / `reason` 1000）。补用例：400 字与 200 emoji 的 reason 产出的需求均 `safeParse` 通过。
- **测试补齐**：`request` 的「不兼容」固定文案（指定版本）与「无版本时当作没有可装版本」、`search` 排除不兼容条目、描述截断到 120 码点、`runId` / `conversationId` 为 null 时对应维度不计数；`context-assembly` 对 D63 阶梯「关」态改为**整段逐字**断言并断言 `hasPluginTools: false` 与缺省完全等价。
- **按任务书回正**：`plugin-tools.ts` 的 `name:` 改为字面量独占一行（`tool-effects` 两条扫描正则都能命中）；「已安装」拒绝文案带上已装版本（`已经安装了该插件（v1.0.0），无需再次请求。`）。
- **测试缝加固**：`KEPCUP_TEST_PLUGIN_MARKET` 改为 zod 解析（`baseUrl` 必须是 URL、`keys` 按 `connectorIndexPublicKeySchema` 校验且非空），`new URL` 挪进解析分支，**只接受回环地址**（`loopbackHostOf`），任何不合法的缝打 warn 日志后整体忽略；`apps/desktop/scripts/pack-hooks.cjs` 的 `FORBIDDEN_MARKERS` 加入该 env 名（此前是唯一没有产物 grep 兜底的缝）。
- **`mailTemplates()`**：清单读不到的插件跳过时打 `warn`（与启动路径同款），不再静默。
- **渲染层**：`PluginInstallDialog` 的检视加请求序号（关闭 / 换目标后晚返回的旧结果不覆盖、不提前解除 loading）；邮件表单从模板切回内置厂商 / 自定义时清掉模板带出的主机 / 端口 / secure / mode / 轮询（否则会建出「模板 host + 默认参数」的混搭账号）；模板 `helpUrl` 渲染前只认 `https://`；`refreshMarket()` 进行中吞掉 `plugins.marketplace.updated` 事件（避免同一轮刷新拉两遍）；市场卡「已装无更新」态独立 testid `plugins-market-installed-{id}`（e2e 同步）；「全部更新」进行中禁用「检查更新」与单个「更新」；`SettingSetupBody` / `SetupRequiredCard` 的 kind 清单注释补 `confirm-plugin-install`；`plugins.svelte.test.ts` 的 `updateAll` 用例改为断言真实 `sha256` 透传（此前断言的是 `undefined`）并新增「刷新期间事件去重」用例；e2e 夹具目录 `afterEach` 清理、`plugins.spec.ts` 用例名改为 land on market。
- 未改的审查意见：新增源码注释为中文——与各文件既有风格一致，README §1.7 的「注释用英文」与仓库现实的既有张力，不在本次返工范围；`refreshMarket` 与 `afterMutation` 的事件双拉在 `plugins.changed` 路径保持 P0a-3 既有模式。
