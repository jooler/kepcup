# P0a-3 · 界面：「已安装」页签、同意面板、本地安装对话框、来源徽标与管理项锁定、e2e

> 状态：**待实施**。依赖：P0a-2 已合入。分支：`feat/plugins/p0a-3-ui`（从 P0a-2 合入点拉出）。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §5（同意卡内容）、§7（管理项）、§9（UI）。

## 1. 目标

交付后：扩展中心多出**最前面**的「已安装」页签：列出本机已装插件（名 / 版本 / 来源 / 分级 / 内容计数），可启停、卸载（带确认）、打开所在目录、展开看内容并跳转到对应管理页签；页头有「从本地安装…」「从文件夹安装…」两个入口，走「选路径 → 检视 → 同意面板（含 MCPB 的 `user_config` 表单）→ 确认安装」；Skills / 连接 / MCP 三个管理页签里，插件来源的条目带「插件 · 名」徽标，技能的卸载按钮与 MCP 的编辑 / 删除按钮被替换为「由插件管理」。web / headless 外壳隐藏本地安装入口。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| `tabs.ts` / `ExtensionCenterBody.svelte` 新增 `installed` 页签（最前）；设置覆盖率排除项 | 「市场」页签、更新徽标（P1-3） |
| `plugins` store、`plugin-install.ts` 纯函数 | Bot 确认卡（P1-3） |
| `PluginConsentPanel` / `PluginInstallDialog` / `PluginSourceBadge` / `ExtensionInstalled` | 邮件模板下拉（P1-3） |
| 平台通道：`selectDirectory` 支持自定义提示文案 | 内置插件在列表里的展示（P0b 数据一到自然出现，本阶段的组件已按 `origin: 'builtin'` 写好） |
| 来源徽标 + 管理项锁定（技能 / MCP / 连接） | |
| i18n（两种语言）、单测、e2e、文档同步 | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -3
rg -n "EXTENSION_CENTER_TABS|ExtensionCenterTab" apps packages --glob '!**/dist/**' --glob '!node_modules' -l
rg -n "extension-tab|EXCLUDED_SETTING_LOCATIONS" packages/shared/src/settings-catalog/coverage.ts | head
rg -n "'skills','connections','mcp','mail','localCollab'|\"skills\",\"connections\"" apps packages --glob '!**/dist/**' --glob '!node_modules'
rg -n "selectDirectory" apps/desktop/src --glob '!*.test.ts'
rg -n "endpointSupports\\('local-file-dialog'\\)" apps/desktop/src | head -3
```

必读（路径均在 `apps/desktop/src/renderer/src/lib/` 下，除非另写）：`features/extension-center/{ExtensionCenterBody.svelte,tabs.ts,tabs.test.ts,market.svelte.ts,ExtensionMcp.svelte}`、`features/settings/{McpbInstall.svelte,mcpb-install.ts,McpSection.svelte}`（本阶段的安装对话框**照 `McpbInstall` 的结构写**）、`features/right-panel/SkillsTab.svelte`、`features/apps/{AppCatalogGrid,ConnectAppPanel,AppConnectionDetail}.svelte`、`features/settings-card/deep-link.ts`、`stores/{shell,settings,apps,skills}.svelte.ts`、`i18n/{state.svelte.ts,locales.test.ts}`、`features/web-shell/{endpoint.ts,web-shim.ts}`、`apps/desktop/src/main/index.ts`（`dialog:selectDirectory` 约 l.476）、`apps/desktop/src/preload/index.ts`（l.41）、`apps/desktop/test/e2e/extension-center.spec.ts`。

## 4. 步骤

### 步骤 1：平台通道 `selectDirectory` 支持自定义提示

现状：`dialog:selectDirectory` 的 `message` 写死为「选择要作为工作目录的目录」。改为可选参数，**无参行为不变**：

- `apps/desktop/src/main/index.ts`：`ipcMain.handle('dialog:selectDirectory', async (_event, options?: unknown) => …)`；`message` 取 `typeof options === 'object' && options !== null && typeof (options as { message?: unknown }).message === 'string' ? 截断到 200 字 : 原默认文案`；其余不变。
- `apps/desktop/src/preload/index.ts` l.41：`selectDirectory: (options?: { message?: string }): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory', options)`。
- `lib/shim.d.ts` l.35 同步签名；`features/web-shell/web-shim.ts` 的 `selectDirectory` 接受并忽略参数。
- 既有调用方（`SetupPathCard.svelte`、`stores/workdirs.svelte.ts`）**不改**。验证：`pnpm --filter @kepcup/desktop typecheck`。

### 步骤 2：页签与覆盖率约束

1. `features/extension-center/tabs.ts`：`ExtensionCenterTab` 增 `'installed'`；`EXTENSION_CENTER_TABS` 改为 `['installed', 'skills', 'connections', 'mcp', 'mail', 'localCollab']`。**数组必须保持字面量写法、不得换行格式化成别的形态**——`packages/shared/test/unit/settings-ui-scan.ts` 用正则 `/EXTENSION_CENTER_TABS[^=]*=\s*\[([^\]]*)\]/` 解析它。
2. `tabs.test.ts`：顺序断言改成新顺序；循环导航断言按新顺序重算（`skills`+ArrowLeft → `installed`；`localCollab`+ArrowRight → `installed`；`connections`+Home → `installed`；`connections`+End → `localCollab`）。
3. `ExtensionCenterBody.svelte`：
   - `TAB_LABEL_KEYS` 加 `installed: 'extensionCenter.tabs.installed'`；
   - 内容区的 `{#if … {:else if …}` 链**在最后的裸 `{:else}`（`localCollab`）之前**插入 `{:else if tab === 'installed'}<ExtensionInstalled />`——漏了的话 `installed` 会渲染成 `ExtensionLocalCollab`；
   - 页签条加 `overflow-x-auto`，按钮加 `shrink-0 whitespace-nowrap`（窄屏 375px 下 6 个页签不能撑破布局）；
   - 文件头注释里的分组列表同步。
4. **设置覆盖率**（否则 `settings-catalog` 的测试会失败）：
   - `packages/shared/src/settings-catalog/coverage.ts` 的 `EXCLUDED_SETTING_LOCATIONS` 加 `{ kind: 'extension-tab', id: 'installed', reason: '已安装插件的对象管理（装 / 卸 / 启停），不是设置；插件相关设置项在 P1 以 plugins.* 条目登记并改指此页签' }`；
   - `packages/shared/test/unit/settings-catalog.test.ts` l.328–333 的硬编码页签清单改成新顺序。
5. 深链：`features/settings-card/deep-link.ts` 用 `EXTENSION_CENTER_TABS` 校验，**无需改**；确认 `open-deep-link.ts:24` 的 `action.tab` 类型随之放宽即可。
6. 窄屏：`ExtensionCenterBody` 同时被 `NarrowExtensionsPage` 使用，无需另改。

**测试**：`tabs.test.ts`（上面）；`node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts apps/desktop/src/renderer/src/lib/features/extension-center/tabs.test.ts apps/desktop/src/renderer/src/lib/stores/shell.svelte.test.ts`。

### 步骤 3：纯函数 `plugin-install.ts` 与 shared 的技能来源解析

- `features/plugins/plugin-install.ts`（纯函数，`plugin-install.test.ts` 单测）：

  | 导出 | 行为 |
  |---|---|
  | `type PluginForm = Record<string, McpbForm>` | 键 = mcp 贡献 id；值 = 该 MCPB 的表单（复用 `settings/mcpb-install.ts` 的 `McpbForm`） |
  | `initialPluginForm(info: PluginInspectOutput): PluginForm` | 对 `info.mcp` 里 `kind==='mcpb'` 的每项用 `initialForm(item.userConfigFields)` |
  | `missingPluginConfig(info, form): string[]` | 汇总各 mcpb 的 `missingRequired(...)`，每项前缀 `「{displayName}」` |
  | `buildPluginUserConfig(info, form): Record<string, Record<string, McpbUserConfigValue>>` | 每个 mcpb id → `buildUserConfig(fields, form[id])`；空对象的 id 也保留为 `{}` |
  | `clearPluginSensitive(info, form): PluginForm` | 每个 mcpb 用 `clearSensitive(...)`（提交后立刻清空敏感值） |
  | `canInstallPlugin(info, missing): boolean` | `info.installable && missing.length === 0` |
  | `pluginIdOfSkillSource(sourceUrl: string): string \| null` | **直接调用 shared 的 `parsePluginSkillSource`**（见下），取 `pluginId` |
  | `managedServerPluginId(server: McpServer): string \| null` | `server.source?.kind === 'plugin' ? server.source.pluginId : null` |

- 技能来源的解析函数 `parsePluginSkillSource` 已在 P0a-1 放进 shared（`plugin-manifest.ts`），渲染层直接 `import { parsePluginSkillSource } from '@kepcup/shared'`；**不要在渲染层再写一份**。

**测试**：`plugin-install.test.ts`：各函数表驱动；`buildPluginUserConfig` 对布尔 / 数字 / 多值 / 空白的处理沿用 mcpb 的规则（只断言委托正确，不重复测 mcpb 的细节）；`pluginIdOfSkillSource` 往返与畸形输入；`managedServerPluginId`。

### 步骤 4：`plugins` store

`features/plugins/plugins.svelte.ts`，**照 `extension-center/market.svelte.ts` 的写法**（单例、`start()` 只订阅一次、`load(force)`、`loadError`、`reset()`）：

```ts
class PluginsState {
  plugins = $state<PluginSummary[]>([]);
  loading = $state(false);
  loadError = $state<string | null>(null);
  busy = new SvelteSet<string>();            // 正在启停 / 卸载的插件 id
  start(): void;                              // core.onEvent('plugins.changed', () => void this.load(true))
  load(force?: boolean): Promise<void>;       // core.call('plugins.list', undefined)
  nameOf(id: string): string;                 // 找不到时返回 id
  setEnabled(id: string, enabled: boolean): Promise<void>;
  uninstall(id: string): Promise<void>;
  afterMutation(): Promise<void>;             // 刷新受影响的 store
  reset(): void;
}
export const plugins = new PluginsState();
```

- `setEnabled` / `uninstall`：`busy.add` → `core.call('plugins.setEnabled' | 'plugins.uninstall', …)` → `await this.afterMutation()` → `finally busy.delete`；**失败不吞**，抛给调用方（组件用 `errorText` + toast）。
- `afterMutation()`：`await this.load(true)`；`await settingsStore.refresh()`（MCP server 列表来自 settings）；`void appsStore.refresh()`（连接目录）；技能列表由既有的 `skills.changed` 事件刷新，不用手动。
- 安装成功后同样调用 `afterMutation()`（安装对话框调用）。

**测试**：`plugins.svelte.test.ts`（`desktop-svelte` 项目，mock `core`，仿 `market` / `workbench` 的 svelte 单测）：`start()` 幂等且 `plugins.changed` 触发重拉；`setEnabled` 成功后调用 `settingsStore.refresh` 与 `appsStore.refresh`；失败时抛出且 `busy` 被清理；`nameOf`。

### 步骤 5：同意面板与安装对话框

**5.1 `features/plugins/PluginConsentPanel.svelte`**（展示组件，props：`info: PluginInspectOutput`、`form: PluginForm`（`$bindable`）、`missing: string[]`、`testid?: string = 'plugins-consent'`）。内容与顺序：

1. 头部：名称 + 版本 + 来源徽标 + 分级徽标；作者、描述、sha256（`font-mono`，可选中）、体积（`formatBytes`，复用 `settings/mcpb-install.ts`）；
2. **`tier === 'developer'`** 时一条醒目的警示条（`plugins.consent.developerWarn`），`data-testid="{testid}-developer-warn"`；
3. 有 `blockers` / `conflicts` / `existing` 时一个红色区块（`plugins.consent.blockers` / `conflicts` / `existing`），`data-testid="{testid}-blockers"`，**此时下面的「配置」表单不渲染**；
4. 技能区（`plugins.consent.skills`）：每项名称 + 描述；`compatible === false` 标红并显示 `skillIncompatible`；`runtimeDeps` 非空显示 `skillDeps`；
5. MCP 区：`mcpb` 项显示 `displayName`、`serverType`、**完整 `launchCommand`**（`font-mono`、可横向滚动）、运行时状态（`runtime?.available === false` 标红 `runtimeMissing`）、`mcpbSha256`；`http` 项显示 `consent.mcpHttp`（host）与完整 URL；
6. 每个 `mcpb` 项下方的「配置」表单（`plugins.consent.configTitle`）：**逐字段照 `McpbInstall.svelte` l.215–255 的渲染规则**——布尔 → `Checkbox`；`multiple` → `<textarea>`（每行一个）；其余 `Input`（`sensitive` → `type="password"`，`type==='number'` → `type="number"`）；标签后带「必填 / 敏感」小标；`data-testid="{testid}-field-{mcpId}-{key}"`；
7. 连接应用区（`plugins.consent.connectors`）：标题 + `hosts` + `scopes`；
8. 邮件模板区：`label` + 两个主机；
9. 底部 `missing.length > 0` 时 `plugins.consent.requiredMissing`，`data-testid="{testid}-missing"`。

**5.2 `features/plugins/PluginInstallDialog.svelte`**（props：`open: boolean`（`$bindable`）、`mode: 'file' | 'folder'`）。**状态机与 `McpbInstall.svelte` 同构**：`path`、`inspecting`、`installing`、`info`、`error`、`form`；`close()` 复位。

- 选择：`mode==='file'` → `window.kepcup?.platform?.selectFile?.(['kepcup'])`；`mode==='folder'` → `window.kepcup?.platform?.selectDirectory?.({ message: t('plugins.pickFolderMessage') })`；选中后自动 `inspect()`。路径输入框始终可手填（Enter 触发检视）——**e2e 靠它输入路径**。
- `inspect()`：`core.call('plugins.inspect', { source: { kind: mode, path: path.trim() } })` → `info = result`、`form = initialPluginForm(result)`；失败 `error = t('plugins.inspectFailed', { reason: errorText(code, message) })`（本组件**用** `errorText`，与 `McpbInstall` 不同——`PLUGIN_*` 码有 i18n）。
- `install()`：守卫 `info !== null && canInstallPlugin(info, missing)`；`core.call('plugins.install', { source, sha256: info.packageSha256, userConfig: buildPluginUserConfig(info, form) })`；成功 `toast.success(t('plugins.toast.installed', { name }))`、`await plugins.afterMutation()`、`close()`；失败 `toast.error(t('plugins.installFailed', { reason }))`，对话框保持打开；`finally` 里 `form = clearPluginSensitive(info, form)`、`installing = false`。
- 对话框用 `components/ui/dialog` 的 `Dialog / DialogContent / DialogHeader / DialogTitle / DialogDescription`（同 `McpbInstall`），`DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl"`；**不拦截点遮罩关闭**（同 `McpbInstall`；它不属于需要 `registerEscapeLayer` 的自绘层）。
- testid：`plugins-install-dialog`、`plugins-install-path`、`plugins-install-pick`、`plugins-install-inspect`、`plugins-install-error`、`plugins-install-confirm`、`plugins-install-cancel`（面板内的见 5.1）。

**5.3 `features/plugins/PluginSourceBadge.svelte`**（props：`pluginId: string`、`testid?: string`）：`<Badge variant="outline">` 文案 `plugins.badge`（`{name}` = `plugins.nameOf(pluginId)`），`title` 为完整 id；组件挂载时 `plugins.start(); void plugins.load()`（幂等）。

### 步骤 6：「已安装」页签 `ExtensionInstalled.svelte`

位置 `features/extension-center/ExtensionInstalled.svelte`，根 `div` 仿 `ExtensionMcp.svelte`：`class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-installed"`。挂载时 `plugins.start(); void plugins.load(true)`。

- 头部：标题 `plugins.title` + 说明 `plugins.hint`；右侧两个按钮 `plugins-install-file`（「从本地安装…」）、`plugins-install-folder`（「从文件夹安装…」），**仅在 `endpointSupports('local-file-dialog')` 为真时渲染**（web / headless 隐藏）；点击设置对话框的 `mode` 并打开。
- 列表：`plugins.plugins` 每项一张卡（`data-testid="plugins-card-{id}"`，`data-plugin-id={id}`）：
  - 标题行：名称、`plugins.version`、来源徽标（`plugins.origin.*`）、分级徽标（`plugins.tier.*`；`developer` 用红色 destructive 样式，`data-testid="plugins-tier-{id}"`）、内容计数（四类各自 `plugins.countItem`，计数为 0 的不显示）；
  - 右侧：启用开关（`plugins-toggle-{id}`，用既有 `Checkbox` 或 `Switch`——**以仓库里已有的为准，不新增组件**，`aria-label=plugins.toggleLabel`；`busy` 时禁用）、「打开所在目录」按钮（`plugins-reveal-{id}`，仅当 `plugin.dirPath !== null && window.kepcup?.showItemInFolder !== undefined`，调 `window.kepcup.showItemInFolder(dirPath)`）、「卸载」按钮（`plugins-uninstall-{id}`）；**`origin==='builtin'`（P0b 起 `plugins.list` 会返回内置插件）时启用开关与卸载按钮都不渲染**，只显示「内置」徽标；
  - 「查看内容 / 收起」展开（`plugins-details-{id}`）：按类别列出 `items`——技能名 / MCP 服务器名（从 `settingsStore` 的 `mcpServers` 里按 `server.id` 反查名称，查不到显示 id）/ 连接应用 slug / 邮件模板 id；每类末尾一个「前往」按钮跳到对应页签（`shell.extensionCenterTab = 'skills' | 'mcp' | 'connections'`）；`missing` 标 `plugins.itemMissing`，`yielded` 标 `plugins.itemYielded`；
- 卸载确认对话框（`plugins-uninstall-dialog`、确认按钮 `plugins-uninstall-confirm`）：文案 `plugins.uninstallBody`；确认后 `plugins.uninstall(id)`，成功 `toast.success(t('plugins.toast.uninstalled', { name }))`，失败 `toast.error(t('plugins.toast.failed', { reason }))`；
- 启停：`plugins.setEnabled(id, next)`，成功 toast（`enabled` / `disabled`），失败回滚并 toast；
- 空态 `plugins-empty`（`plugins.empty`）；加载失败 `plugins-error`（`plugins.loadFailed`）；
- `<PluginInstallDialog bind:open={installOpen} mode={installMode} />` 挂在组件里。

### 步骤 7：来源徽标与管理项锁定

| 位置（均在 `apps/desktop/src/renderer/src/lib/features/` 下） | 改动 |
|---|---|
| `settings/McpSection.svelte`：服务器行头部徽标区（`disabled` 徽标之后，约 l.590） | `{#if managedServerPluginId(server) !== null}<PluginSourceBadge pluginId=… testid="mcp-plugin-badge-{server.id}" />{/if}` |
| 同文件：「编辑」「删除」按钮（约 l.647–663） | 受管 server：**不渲染这两个按钮**，改渲染一行小字 `plugins.managedBy` + `plugins.managedHint`（`data-testid="mcp-managed-{server.id}"`）；「测试」「工具」按钮保留。另在 `editServer(server)`（约 l.315）与 `removeServer(server)`（约 l.431）函数开头对受管 server 直接 `return`（双保险；core 层的 `PLUGIN_MANAGED` 才是权威） |
| `right-panel/SkillsTab.svelte`：列表行与详情的 scope 徽标旁（约 l.184–188、l.230–237） | `pluginIdOfSkillSource(skill.sourceUrl)` 非空时加 `PluginSourceBadge`（`testid="skill-plugin-badge-{name}"`）；**判断前先确认 `SkillEntry` 上取来源地址的字段名**（`packages/shared/src/domain/types.ts` 的 `SkillEntry`，`sourceUrl` 以实际字段为准，字段名不对时在实施记录登记） |
| 同文件：卸载按钮（约 l.378–387） | 受管技能：按钮替换为 `plugins.managedBy` 小字（`data-testid="skill-managed-{name}"`）；不再进 `uninstallTarget` 流程 |
| `apps/AppCatalogGrid.svelte`：卡片标题行（分级徽标之后，约 l.265） | `entry.origin === 'plugin'` 时加 `PluginSourceBadge`（需要插件 id：`AppCatalogEntry` 目前没有 `pluginId` 字段——**给 `apps.catalog.list` 的条目加可选 `pluginId?: string`**：shared 的 `appCatalogEntrySchema`（`domain/app-connections.ts`）加字段、core `connections.ts` 构造条目处（l.163 附近）用 `catalog.pluginIdOf(meta.slug)` 填，对应测试补一条断言） |
| `apps/ConnectAppPanel.svelte` l.328、`apps/AppConnectionDetail.svelte` l.390（现有本机徽标处） | 同样的 `origin === 'plugin'` 徽标 |

**测试**：核心断言靠 e2e（步骤 9）；新增的纯逻辑（`managedServerPluginId` 等）已在步骤 3 覆盖。`pluginId` 加到 `apps.catalog.list` 的 core 侧补进 `packages/core/test/integration/plugins.test.ts`（P0a-2 的集成测试）里一条断言：`origin:'plugin'` 的条目带 `pluginId`。

### 步骤 8：i18n

两种语言**同位置**追加（`zh-CN.ts` 与 `en-US.ts` 的键顺序必须一致；`locales.test.ts` 强制，英文不得含中文、非空、`{占位符}` 一致）：

- `extensionCenter.tabs.installed`：加在 `extensionCenter.tabs.skills` **之前**（页签顺序即键顺序，便于阅读；位置两份一致即可）；
- `plugins.*` 整组：放在两个文件里 `extensionCenter.*` 块结束之后；
- `chats.errorCode.PLUGIN_*` 四条：放在各自 `chats.errorCode.*` 块的末尾。

| key | zh-CN | en-US |
|---|---|---|
| `extensionCenter.tabs.installed` | 已安装 | Installed |
| `plugins.title` | 已安装的插件 | Installed plugins |
| `plugins.hint` | 插件把技能、MCP 服务器、连接应用打包成一份可分发的扩展。 | Plugins bundle skills, MCP servers and connected apps into one distributable extension. |
| `plugins.installFile` | 从本地安装… | Install from file… |
| `plugins.installFolder` | 从文件夹安装… | Install from folder… |
| `plugins.empty` | 还没有安装任何插件。 | No plugins installed yet. |
| `plugins.loadFailed` | 加载失败：{reason} | Failed to load: {reason} |
| `plugins.version` | 版本 {version} | Version {version} |
| `plugins.origin.builtin` | 内置 | Built-in |
| `plugins.origin.marketplace` | 市场 | Marketplace |
| `plugins.origin.local` | 本地 | Local |
| `plugins.tier.builtin` | 内置 | Built-in |
| `plugins.tier.verified` | 已认证 | Verified |
| `plugins.tier.community` | 社区 | Community |
| `plugins.tier.developer` | 未审核 | Unreviewed |
| `plugins.kind.skill` | 技能 | Skills |
| `plugins.kind.mcp` | MCP 服务器 | MCP servers |
| `plugins.kind.connector` | 连接应用 | Connected apps |
| `plugins.kind.mail` | 邮件模板 | Mail templates |
| `plugins.countItem` | {kind} {count} | {kind} {count} |
| `plugins.toggleLabel` | 启用或停用该插件 | Enable or disable this plugin |
| `plugins.uninstall` | 卸载 | Uninstall |
| `plugins.reveal` | 打开所在目录 | Show in folder |
| `plugins.details` | 查看内容 | Show contents |
| `plugins.hideDetails` | 收起 | Hide |
| `plugins.goTo` | 前往 | Open |
| `plugins.itemMissing` | 内容缺失 | Content missing |
| `plugins.itemYielded` | 与现有条目冲突，已让位 | Yielded to an existing entry |
| `plugins.toast.installed` | 已安装「{name}」 | Installed "{name}" |
| `plugins.toast.uninstalled` | 已卸载「{name}」 | Uninstalled "{name}" |
| `plugins.toast.enabled` | 已启用「{name}」 | Enabled "{name}" |
| `plugins.toast.disabled` | 已停用「{name}」 | Disabled "{name}" |
| `plugins.toast.failed` | 操作失败：{reason} | Operation failed: {reason} |
| `plugins.uninstallTitle` | 卸载插件 | Uninstall plugin |
| `plugins.uninstallBody` | 将移除「{name}」安装的全部内容（技能、MCP 服务器、连接应用），并断开其连接应用的所有账号连接。此操作不可撤销。 | This removes everything "{name}" installed (skills, MCP servers, connected apps) and disconnects every account connected through its apps. This cannot be undone. |
| `plugins.uninstallConfirm` | 确认卸载 | Uninstall |
| `plugins.cancel` | 取消 | Cancel |
| `plugins.badge` | 插件 · {name} | Plugin · {name} |
| `plugins.managedBy` | 由插件「{name}」管理 | Managed by plugin "{name}" |
| `plugins.managedHint` | 要移除它，请在「已安装」里卸载该插件。 | To remove it, uninstall the plugin under Installed. |
| `plugins.installTitle` | 安装插件 | Install plugin |
| `plugins.installHint` | 先检视包的内容与权限，确认后才会安装。 | Review what the package contains and asks for. Nothing is installed until you confirm. |
| `plugins.pathLabel` | 插件包（.kepcup）或文件夹路径 | Plugin package (.kepcup) or folder path |
| `plugins.pathPlaceholder` | /path/to/plugin.kepcup | /path/to/plugin.kepcup |
| `plugins.pickFile` | 选择文件… | Choose file… |
| `plugins.pickFolder` | 选择文件夹… | Choose folder… |
| `plugins.pickFolderMessage` | 选择插件目录（包含 plugin.json） | Choose the plugin folder (containing plugin.json) |
| `plugins.inspect` | 检视 | Inspect |
| `plugins.inspecting` | 检视中… | Inspecting… |
| `plugins.inspectFailed` | 检视失败：{reason} | Inspection failed: {reason} |
| `plugins.confirm` | 确认并安装 | Confirm and install |
| `plugins.installing` | 安装中… | Installing… |
| `plugins.installFailed` | 安装失败：{reason} | Installation failed: {reason} |
| `plugins.consent.sha` | 包 sha256 | Package sha256 |
| `plugins.consent.size` | 体积 | Size |
| `plugins.consent.author` | 作者 | Author |
| `plugins.consent.developerWarn` | 未审核来源：它的连接应用与 MCP 工具每次调用都需要你确认，也没有持续授权。 | Unreviewed source: tools from its connected apps and MCP servers need your confirmation on every call, with no standing grants. |
| `plugins.consent.skills` | 技能（安装后对所有 Bot 可见） | Skills (visible to all Bots once installed) |
| `plugins.consent.skillIncompatible` | 与当前环境不兼容：{reason} | Incompatible with this environment: {reason} |
| `plugins.consent.skillDeps` | 需要运行时：{deps} | Needs runtimes: {deps} |
| `plugins.consent.mcp` | MCP 服务器 | MCP servers |
| `plugins.consent.mcpb` | 内嵌本地包 · 启动命令 | Embedded local package · launch command |
| `plugins.consent.mcpHttp` | 远端服务 · {host} | Remote service · {host} |
| `plugins.consent.runtimeMissing` | 需要 {runtime} 运行时，尚未安装 | Needs the {runtime} runtime, which is not installed |
| `plugins.consent.configTitle` | 配置 | Configuration |
| `plugins.consent.required` | 必填 | Required |
| `plugins.consent.sensitive` | 敏感 | Sensitive |
| `plugins.consent.connectors` | 连接应用（安装后仍需你逐个连接） | Connected apps (you still connect each one yourself) |
| `plugins.consent.connectorHosts` | 服务地址：{hosts} | Service: {hosts} |
| `plugins.consent.connectorScopes` | 申请范围：{scopes} | Scopes: {scopes} |
| `plugins.consent.mail` | 邮件模板 | Mail templates |
| `plugins.consent.blockers` | 无法安装 | Cannot install |
| `plugins.consent.conflicts` | 冲突 | Conflicts |
| `plugins.consent.conflictItem` | {ref}：{withWhat} | {ref}: {withWhat} |
| `plugins.consent.existing` | 已安装同 id 的插件（v{version}） | A plugin with this id is already installed (v{version}) |
| `plugins.consent.requiredMissing` | 还有必填项未填：{fields} | Required fields missing: {fields} |
| `chats.errorCode.PLUGIN_INVALID` | 插件包无效 | Invalid plugin package |
| `chats.errorCode.PLUGIN_INCOMPATIBLE` | 插件与当前环境不兼容 | The plugin is not compatible with this environment |
| `chats.errorCode.PLUGIN_CONFLICT` | 插件与已有内容冲突 | The plugin conflicts with existing content |
| `chats.errorCode.PLUGIN_MANAGED` | 该项由插件管理，请在「已安装」里卸载插件 | This item is managed by a plugin; uninstall the plugin under Installed |

文案里要用到列表分隔的地方（`{hosts}`、`{scopes}`、`{deps}`）用 `listSeparator()`（`$lib/i18n` 已导出，`McpbInstall` 里有用法）拼好再传入。

### 步骤 9：e2e

新增 `apps/desktop/test/e2e/plugins.spec.ts`，**启动与清理照 `extension-center.spec.ts`**（临时 `KEPCUP_HOME`、`startMockLlm`、`NODE_ENV: 'test'` 等同一套 env；`try/finally` 清理）。夹具用 `@kepcup/testkit` 的 `buildPluginFixture`（含 2 个技能 + 1 个连接器 + 1 个 http MCP；**不含 mcpb**，e2e 环境没有受管 Node 运行时）。**界面里打不开原生文件对话框，所以全程用路径输入框。** 用例：

| 用例 | 步骤与断言 |
|---|---|
| 页签与默认 | 打开扩展中心：6 个页签、`installed` 在最前；默认选中仍是 `skills`；方向键循环（`localCollab` + ArrowRight → `installed`） |
| 本地安装全流程 | 点 `installed` → `plugins-empty` 可见 → 点 `plugins-install-file` → 在 `plugins-install-path` 输入夹具路径 → 点 `plugins-install-inspect` → `plugins-consent-developer-warn` 可见、技能与连接器名称在面板里 → 点 `plugins-install-confirm` → 对话框关闭、`plugins-card-{id}` 出现且 `plugins-tier-{id}` 含「未审核」 |
| 受管项 | Skills 页签：该插件技能行有 `skill-plugin-badge-{name}`，`skill-uninstall-{name}` 不存在、`skill-managed-{name}` 存在；MCP 页签：http server 行有 `mcp-plugin-badge-{id}` 与 `mcp-managed-{id}`，`mcp-edit-{id}` 不存在；连接页签：连接器卡带插件徽标 |
| core 守卫 | `page.evaluate(() => window.__kepcupRpc('mcp.removeServer', { serverId }))` → 抛含 `PLUGIN_MANAGED` 的错误 |
| 启停 | 点 `plugins-toggle-{id}` 停用 → Skills 页签里技能消失、连接页签里连接器消失；再启用恢复 |
| 卸载 | 点 `plugins-uninstall-{id}` → 对话框 `plugins-uninstall-dialog` → `plugins-uninstall-confirm` → 卡片消失；技能 / server / 连接器全部消失 |
| 冲突阻塞 | 先经 RPC 安装一次，再用同一夹具走检视 → `plugins-consent-blockers` 可见且 `plugins-install-confirm` 禁用 |
| 窄屏 | 视口 375px 宽：`narrow-tab-extensions` → `extension-center-tabs` 可横向滚动、`installed` 页签可点 |

另外修改既有 e2e：`extension-center.spec.ts` 第 102–117 行的页签循环断言（`localCollab` + ArrowRight 现在回到 `installed`，不再是 `skills`）与文件头的页签顺序注释；其余 `skill-market.spec.ts` / `narrow-layout.spec.ts` / `local-connectors.spec.ts` / `connect-abort.spec.ts` 不应受影响，但**都跑一遍**确认。

### 步骤 10：文档与收口

1. `docs/design/29-connected-apps.md` §16.1 的页签表加一行「**已安装**（插件）」，内容栏写「插件的装 / 卸 / 启停与内容总览，见设计 51」（该文件内用它自己的相对链接 `51-plugin-system.md`）；§16.1 开头「页签（WAI-ARIA tabs；D84 起四组）」的计数文案改成「六组」。
2. `docs/dev/PROGRESS.md` 的验收表末尾加一行：`| 插件系统 P0a（D104） | 待验收 | {日期} | — | …（做了什么 / 全量 pnpm test 结果 / e2e 结果） |`。
3. 阶段收口**跑一次**全量 `pnpm test`（本阶段改了 shared 契约）；e2e：`pnpm build` 后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/plugins.spec.ts test/e2e/extension-center.spec.ts test/e2e/skill-market.spec.ts test/e2e/narrow-layout.spec.ts test/e2e/local-connectors.spec.ts`。

## 5. 验收

- [ ] 手工路径（桌面应用里，`pnpm dev`）：从文件夹安装一个含技能 + 连接器 + http MCP 的插件 → 三个管理页签都出现带徽标的条目、技能与 MCP 的删除入口被「由插件管理」替代 → 启停 / 卸载正常 → 卸载后三处都干净。把过程与截图要点写进实施记录。
- [ ] `node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/plugins apps/desktop/src/renderer/src/lib/features/extension-center apps/desktop/src/renderer/src/lib/i18n packages/shared/test/unit/settings-catalog.test.ts` 全绿；`pnpm --filter @kepcup/desktop typecheck` 与 `pnpm --filter @kepcup/shared typecheck` 通过。
- [ ] e2e 步骤 9 列出的规格全绿（既有规格不回归；沙箱 / 环境类基线失败不算）。
- [ ] 全量 `pnpm test` 失败集合不超出 PROGRESS.md 记录的基线。
- [ ] web 外壳（`pnpm --filter @kepcup/desktop build:web`）构建通过；`installed` 页签在 web 下可打开，「从本地安装…」「从文件夹安装…」不渲染。
- [ ] 渲染层没有任何硬编码中文；`locales.test.ts` 通过。
- [ ] `docs/design/29` 与 `PROGRESS.md` 已更新。

## 6. 实施记录

（执行智能体在最后一个提交里填写：做了什么 / 偏差与 DEV 编号 / `SkillEntry` 来源字段名核对结论 / `appCatalogEntrySchema.pluginId` 改动 / 手工验证要点 / 遗留问题。）

### 实施记录（2026-10-26，P0a-3 全步骤完成）

**做了什么**（提交序）：

1. `feat(plugins): allow selectDirectory to take a custom prompt`——步骤 1：`dialog:selectDirectory` 接受可选 `{ message }`（截断 200 字，无参行为不变），preload / `shim.d.ts` / web-shim 同步签名；既有调用方未动。
2. `feat(plugins): add the Installed tab ...`——步骤 2：`tabs.ts` 新顺序（`installed` 最前，数组保持单行字面量 + `prettier-ignore` 防重排版）、`tabs.test.ts` 重算、`ExtensionCenterBody` 加 `installed` 分支与 `overflow-x-auto` / `shrink-0 whitespace-nowrap`、覆盖率排除表加 `extension-tab/installed`、`settings-catalog.test.ts` 硬编码清单更新；`ExtensionInstalled.svelte` 先落占位（步骤 6 填充）。
3. `feat(plugins): i18n ... (steps 2+8)`——两种语言的 `extensionCenter.tabs.installed`、整组 `plugins.*`（96 条）、`PLUGIN_*` 文案改写；`locales.test.ts` 通过。
4. `feat(plugins): plugin install form helpers ...`——步骤 3：`plugin-install.ts` 七个导出（表单播表 / 缺项汇总带「{displayName}」前缀 / userConfig 组装含空对象保留 / 敏感清空 / 安装门 / 技能来源解析直接调 shared 的 `parsePluginSkillSource` / 受管 server 判定）+ 表驱动单测。
5. `feat(plugins): plugins store ...`——步骤 4：单例 store（`start()` 幂等订阅 `plugins.changed`、`load(force)`、`nameOf` 回退 id、`setEnabled` / `uninstall` 带 `busy` 清理与失败上抛、`afterMutation` 刷新 plugins → settings → apps）+ desktop-svelte 单测（mock core / settings / apps）。
6. `feat(plugins): consent panel, install dialog and source badge`——步骤 5：`PluginConsentPanel`（8 段内容与顺序照任务书 5.1，blockers 时不渲染 user_config 表单，字段渲染规则照 `McpbInstall`，testid `{testid}-field-{mcpId}-{key}`）、`PluginInstallDialog`（状态机同构 `McpbInstall`，检视失败走 `errorText`，提交后清敏感值，不拦遮罩关闭）、`PluginSourceBadge`（挂载幂等拉列表）。
7. `feat(plugins): Installed tab with plugin cards ...`——步骤 6：卡片（名 / 版本 / 来源 / 分级徽标 / 非零内容计数 / 内置只读无开关）、启停（失败自动回位 + toast）、打开所在目录、内容明细展开（MCP 按 settings 反查名，缺失 / 让位标记，「前往」跳 skills / connections / mcp）、卸载确认对话框、空态 / 加载失败态、`PluginInstallDialog` 挂载。
8. `feat(plugins): source badges and managed-item locks ...`——步骤 7：`McpSection`（受管行徽标 `mcp-plugin-badge-{id}`、编辑 / 删除按钮替换为 `mcp-managed-{id}` 文案、`editServer` / `removeServer` 双保险早退）、`SkillsTab`（行与详情徽标 `skill-plugin-badge-{name}`、卸载按钮替换为 `skill-managed-{name}`）、`AppCatalogGrid` / `ConnectAppPanel` / `AppConnectionDetail` 的 `origin === 'plugin'` 徽标；shared `appCatalogEntrySchema` 加可选 `pluginId`、core `catalogEntries()` 用 `catalog.pluginIdOf(slug)` 填充、`plugins.test.ts` 集成断言补 `pluginId: PLUGIN_ID`。
9. `test(plugins): e2e ...`——步骤 9：`plugins.spec.ts` 八个用例全绿（页签与默认 / 全流程安装 / 受管项 / core 守卫 / 启停 / 卸载 / 冲突阻塞 / 窄屏），`extension-center.spec.ts` 的页签循环断言与注释改为新顺序（键序不变，仍全绿）。
10. `docs(plugins): P0a-3 closure`——设计 29 §16.1（六组 + 「已安装」行）、本实施记录、PROGRESS.md 验收行。

**验收证据**：

- 定向测试：`node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/plugins apps/desktop/src/renderer/src/lib/features/extension-center apps/desktop/src/renderer/src/lib/i18n packages/shared/test/unit/settings-catalog.test.ts` → 8 文件 65 例全绿；`packages/shared/test/unit/settings-catalog.test.ts`、`settings-ui-scan.test.ts` 单跑全绿。
- typecheck：`pnpm --filter @kepcup/shared typecheck`、`pnpm --filter @kepcup/desktop typecheck`（tsc + svelte-check 0 err）、`pnpm --filter @kepcup/core typecheck`（经 core build）全过；desktop `tsc -p tsconfig.node.json` 与 svelte-check 均 0 错。
- core 全量单包 `pnpm --filter @kepcup/core test`：4503 通过 / 37 跳过（第二次运行 0 error；第一次运行报过一次 `Errors 1 error` 的未处理 rejection，无失败用例，重跑同一命令全绿——与 PROGRESS.md 基线里已知的环境类偶发一致，未超出基线）。
- e2e（`pnpm build` 后）：`plugins.spec.ts` 8/8 通过；`extension-center.spec.ts` 2/2、`skill-market.spec.ts` 1/1、`narrow-layout.spec.ts` 2/2、`local-connectors.spec.ts` 2/2、`connect-abort.spec.ts` 1/1 全部通过（共 8/8）。
- 全量 `pnpm test`（阶段收口一次）：**6666 通过 / 1 失败 / 37 跳过（632 文件里 1 个失败文件）**。唯一失败是 `packages/core/test/integration/memory.test.ts` 的「两个 Bot 同时产生画像提案」用例——全量并跑下的 `Timed out waiting for completed response run`（testkit helpers 的 waitFor 超时，负载型偶发），**单跑该文件 15/15 全绿复核通过**，与本阶段改动面（插件 UI）无交集。失败集合不超出 PROGRESS.md 基线（D103 记录 21 例沙箱基线失败；本机这次 run 里 `sandbox-isolation` / `toolchain-sandbox` / `workspace-tools` 等沙箱用例实际全过——本机环境具备这些用例需要的执行途径，基线是「不超出」上限而非下限）。
- `pnpm --filter @kepcup/desktop build:web` 通过；web 端点 `endpointSupports('local-file-dialog')` 恒 false（`local-file-dialog` ∈ shared 的 `DESKTOP_ONLY_CAPABILITIES`），「从本地安装…」「从文件夹安装…」不渲染，`installed` 页签本身可打开（纯数据面板，无桌面通道依赖）。仓库没有 web e2e harness，此条以构建 + 能力门控代码为证。
- `pnpm lint`（eslint 对本阶段全部新增 / 修改文件单跑）：0 报错。
- 渲染层硬编码中文：新增组件全部经 `t()`；`locales.test.ts`（键与顺序一致、英文无中文非空、占位符一致）通过。

**`SkillEntry` 来源字段名核对结论**：字段名就是 `sourceUrl`（`packages/shared/src/domain/types.ts` 的 `skillEntrySchema`，`sourceUrl: z.string().nullable()`），与任务书一致，无需偏差登记。`SkillsTab` 里用 `skill.sourceUrl ?? ''` 传给 `pluginIdOfSkillSource`（null → 非插件来源）。

**`appCatalogEntrySchema.pluginId` 改动**：按任务书加可选字段 `pluginId: z.string().optional()`（紧跟 `origin`）；core `AppConnections.catalogEntries()` 在 `originOf` 旁用 `catalog.pluginIdOf(meta.slug)` 填充（null 不出键）。集成测试补 `expect(entry).toMatchObject({ origin: 'plugin', tier: 'developer', pluginId: PLUGIN_ID })`。`ConnectAppPanel` / `AppConnectionDetail` 的现有本机徽标分支不动，plugin 分支走 `else if`。

**手工验证要点（e2e 与组件证据替代说明）**：本环境无法真开 Electron 窗口做人工截图，手工路径以 e2e 全流程替代并逐条对上验收清单：从文件安装含 2 技能 + 1 连接器 + 1 http MCP 的插件 → 同意面板出现未审核警示条与全部贡献 → 三处管理页签出现带 `Plugin · Fixture` 徽标的条目 → 技能卸载按钮与 MCP 编辑 / 删除按钮被「由插件管理 · 要移除它，请在『已安装』里卸载该插件。」替换 → core 层 `mcp.removeServer` 抛 `PLUGIN_MANAGED` → 启停后技能 / 连接器摘除、再启用恢复 → 卸载（确认框明示不可撤销）后卡片与三处投影全部消失、回到空态。附：窄屏 375px 六页签横滚可点；`extension-center.spec` / `skill-market` / `narrow-layout` / `local-connectors` / `connect-abort` 无回归。

**偏差（DEV 编号）**：

- **DEV-051**：`chats.errorCode.PLUGIN_*` 四条 P0a-1 已登记（紧跟 `BOARD_*` 组），任务书「追加到块末尾」会撞重复键——保留既有位置、文案按本步骤的表逐条改写（zh / en 同步）。见 `docs/dev/DEVIATIONS.md` DEV-051。
- 其余为任务书留白的自行判断（见下），未构成偏差。

**自行判断点**：

1. `EXTENSION_CENTER_TABS` 单行字面量加了 `// prettier-ignore`（printWidth=100 下该行 137 字符，不加的话 `pnpm fmt` 会把数组重排成多行——正则 `[^\]]*` 虽能吞换行，但任务书明确要求保持字面量形态，注释把约束钉住）。
2. `PluginConsentPanel` 的 user_config 输入用 `value` + `oninput`（受控）而非 `bind:value`：表单是 `Record<mcpId, Record<key, value>>` 两层嵌套 + `noUncheckedIndexedAccess`，Svelte 的 bind 目标语法不接受 `form[item.id]?.[key]` 形状；Checkbox 仍走 `checked` + `onCheckedChange`。行为与 `McpbInstall` 的 bind 等价（击键即写回 form）。
3. 同意面板 `requiredMissing` 的 `{fields}` 与技能依赖 `{deps}`、连接器 `{hosts}` / `{scopes}` 都经 `listSeparator()` 拼接（`McpbInstall` 同款）。
4. `plugins.enabled` 停用失败时 UI 自动回位：开关 `checked={plugin.enabled}` 直读 store，失败路径 store 未变，无需手工回滚。
5. 内容明细的「前往」只对 skill / connector / mcp 三类渲染（mail 无对应页签，任务书 goTo 语义只列三处）。
6. `plugins.svelte.test.ts` 对 load 失败断言「列表保留旧值 + loadError 透出」（与 `market.svelte.ts` 行为一致），任务书未规定此细节。

**遗留问题**：

- 无阻塞遗留。P1-3 将把「市场」页签插到最前、更新徽标与 Bot 确认卡复用 `PluginConsentPanel`；`PluginSummary.updateAvailable` / `PluginInspectOutput.update` 仍为 null（P1 填充）。
- `pnpm --filter @kepcup/core test` 首跑出现过一次无失败用例的 `Errors 1 error`（未处理 rejection），重跑全绿；如后续收口再现在意，可单独定位（不在本阶段改动面内）。
- 全量 run 里 `memory.test.ts` 画像提案合并用例在全量负载下超时一次（单跑全绿）；它是负载敏感型集成用例，与本阶段无关，后续阶段收口若复现属同类偶发。
