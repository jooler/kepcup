# P0a-2 · 投影与注册：账本、三类投影器、`PluginRegistry`、守卫、RPC、接线

> 状态：**待实施**。依赖：P0a-1 已合入。分支：`feat/plugins/p0a-2-projection`（从 P0a-1 合入点拉出）。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §2、§4（投影与冲突规则）、§5（管线 3–7 步）、§7（生命周期）、§10。

## 1. 目标

交付后：core 里能通过 RPC `plugins.inspect` → `plugins.install` 安装一个本地 `.kepcup`（或开发目录），把其中的**技能、内嵌 MCPB、远端 http MCP、连接器**投影进既有服务，并能启停、卸载（按账本级联）、崩溃恢复；对插件管理项的单项删除在 core 层被拒。**本阶段没有界面**（P0a-3），验证全靠 core 集成测试。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| `PluginStore`（`plugins` / `plugin_items`） | 更新流（P1-2）、市场来源（P1-1） |
| `McpbInstaller` 小改（`register` 覆盖项、按包引用统计、`slotConflict`）——**独立提交** | 邮件模板的读取 RPC 与表单（P1-3；P0a 的 mail 投影器只登记账本） |
| 投影器：skills / mcp / connectors / mail（登记型） | 内置插件（P0b） |
| `ConnectorCatalog` 的 plugin 来源 + `ConnectorOrigin='plugin'` 全链路 | Bot 工具（P1-3） |
| `PluginRegistry`（inspect / install / setEnabled / uninstall / list / recover / 互斥 / 审计 / 事件） | |
| 守卫（`PLUGIN_MANAGED`）、RPC、`start.ts` 接线、`mcp.attachHttpFetch` 谓词 | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -5                 # 确认 P0a-1 已在
ls packages/core/src/plugins packages/package-guard/src    # ids / manifest-loader / package 已存在
rg -n "attachHttpFetch|attachLocal\(" packages/core/src/start.ts
rg -n "isDirectorySourced|isLocal\(|originOf\(" packages/core/src --glob '!*.test.ts'
rg -n "settingsPermissionEffects|new SettingsCatalogHost|new Orchestrator\(|const appConnections|services.appConnections =" packages/core/src/start.ts
rg -n "uninstall\(botId|uninstallPublic" packages/core/src/skills/registry.ts
```

必读：`packages/core/src/apps/mcpb/install.ts` 全文、`packages/core/src/apps/catalog.ts` 全文、`packages/core/src/apps/local-connectors.ts` 的 `remove()`（l.451）与 `#rateLimit`、`packages/core/src/skills/presets.ts` 的 `install()` 与 `#resolveAll()`（技能安装的完整配方）、`packages/core/src/rpc/apps-runtime-bindings.ts`（`mcp.removeServer`）、`packages/core/src/rpc/bindings.ts` 的 `settings.update`（l.468–617）、`packages/core/src/apps/connections.ts` 的 `update()`（l.525）与 `catalogConnectionOptions`、`packages/core/test/unit/mcpb.test.ts` 的 `harness()`、`packages/core/test/integration/mcpb.test.ts`。

## 4. 步骤

### 步骤 1：`PluginStore`

文件 `packages/core/src/plugins/store.ts`，风格照 `packages/core/src/board/board-store.ts`（构造参数 `db: SqliteDatabase`，预编译语句，`snake_case` ↔ `camelCase` 转换函数）。

```ts
export interface PluginRow {
  id: string; version: string;
  origin: 'marketplace' | 'local';
  tier: 'verified' | 'community' | 'developer';
  state: 'installing' | 'installed' | 'uninstalling';
  enabled: boolean; packageSha256: string; marketplace: string | null;
  dir: string; installedAt: number; updatedAt: number;
}
export class PluginStore {
  constructor(db: SqliteDatabase);
  list(): PluginRow[];                                   // order by installed_at, id
  get(id: string): PluginRow | null;
  insert(row: PluginRow): void;
  update(id: string, patch: Partial<Pick<PluginRow,
    'version' | 'tier' | 'state' | 'enabled' | 'packageSha256' | 'marketplace' | 'dir' | 'updatedAt'>>): void;
  delete(id: string): void;                              // plugin_items 随 FK 级联
  items(pluginId: string): Array<{ kind: PluginItemKind; ref: string }>;
  refs(pluginId: string, kind: PluginItemKind): string[];   // 按插入顺序（用 rowid）
  addItem(pluginId: string, kind: PluginItemKind, ref: string): void;   // INSERT OR IGNORE
  removeItem(pluginId: string, kind: PluginItemKind, ref: string): void;
  ownerOf(kind: PluginItemKind, ref: string): string | null;  // 走 plugin_items_ref 索引
}
```

**测试** `packages/core/test/unit/plugin-store.test.ts`（临时 home + 加密 `main.db` + `runMigrations`，写法照 `skills-presets.test.ts` 的 `makeRig()`）：增删改查往返；`refs` 保持插入顺序；`addItem` 幂等；`delete` 级联清账本；`ownerOf` 命中 / 未命中；`enabled` 的布尔 ↔ 整数转换。

### 步骤 2：投影器接口与 barrel

文件 `packages/core/src/plugins/projectors/index.ts`（先只放类型与 barrel 骨架）：

```ts
export type ProjectedKind = 'skill' | 'connector' | 'mcp' | 'mail';

export interface PluginIdentity {
  id: string; version: string;
  origin: 'marketplace' | 'local';
  tier: 'verified' | 'community' | 'developer';
}

/** 账本句柄（已绑定到某个插件）。写入前先 add；unproject / 回滚按账本做。 */
export interface PluginLedger {
  add(kind: PluginItemKind, ref: string): void;       // 幂等
  remove(kind: PluginItemKind, ref: string): void;
  list(kind: PluginItemKind): string[];
}

export interface PluginProjectionContext {
  plugin: PluginIdentity;
  manifest: PluginManifest;
  /** 解包树的绝对路径：inspect 时是 staging 目录；project / activate 时是最终目录。 */
  dir: string;
  /** 内嵌 MCPB 的 user_config 值，键 = mcp 贡献 id；仅安装时有值。 */
  userConfig: Readonly<Record<string, Record<string, McpbUserConfigValue>>>;
  ledger: PluginLedger;
}

export interface ProjectorInspection<T> { items: T[]; conflicts: PluginConflict[]; blockers: string[] }

export interface PluginProjector<T = unknown> {
  readonly kind: ProjectedKind;
  /** 只读，不写任何东西。用户可见的问题放进 blockers / conflicts，不要抛；只有程序错误才抛。 */
  inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<T>>;
  /** 写入。每项**写之前**先 `ctx.ledger.add(kind, ref)`。失败直接抛，由注册表按账本回滚。 */
  project(ctx: PluginProjectionContext): Promise<void>;
  /** 精确移除 `refs`。必须幂等（缺失 = 成功）。 */
  unproject(plugin: PluginIdentity, refs: readonly string[], ledger: PluginLedger): Promise<void>;
  /** 隐藏 / 恢复，不动账本里的投影项（`disabled_connection` 除外，那是连接器投影器自己的簿记）。 */
  setEnabled(ctx: PluginProjectionContext, refs: readonly string[], enabled: boolean): Promise<void>;
  /** 启动时对「已装且启用」的插件重建运行期状态（不写账本）。技能 / MCP 的状态在 DB / settings 里，无需实现。 */
  activate?(ctx: PluginProjectionContext): Promise<void>;
  /** 返回内容在应用外被删除的 refs（`plugins.list` 的 `missing` 标记）。 */
  missing?(plugin: PluginIdentity, refs: readonly string[]): string[];
}

/** 固定顺序：先技能、MCP，再连接器、邮件；卸载 / 回滚按相反顺序。 */
export const PLUGIN_PROJECTOR_ORDER: readonly ProjectedKind[] = ['skill', 'mcp', 'connector', 'mail'];
```

`ProjectorInspection<T>` 的 `T` 分别是 shared 的 `PluginConsentSkill` / `PluginConsentMcp` / `PluginConsentConnector` / `PluginConsentMail`（`z.infer`）。

**覆盖率测试**（照 `settings-adapters-coverage.test.ts`）`packages/core/test/unit/plugin-projectors-coverage.test.ts`：`createPluginProjectors(deps)` 返回的 `kind` 集合恰好等于 `pluginContributionKindSchema.options`，且顺序与 `PLUGIN_PROJECTOR_ORDER` 一致（漏接新贡献类别就失败）。

### 步骤 3：技能投影器

文件 `plugins/projectors/skills.ts`。依赖：`{ skills: SkillsService; environment?: { depAvailable(dep: string): boolean }; enhancedSandbox?: { available(): boolean }; logger }`。**配方完全照抄** `SkillPresetsService.install()` 与 `#resolveAll()`：`parseSkillDir` → `scanSkillDir(dir, parsed, { enhancedSandboxAvailable })` → `hashDirectory` → `skills.installPublic(...)`。

| 方法 | 行为 |
|---|---|
| `inspect` | 每个技能贡献：`dir = path.join(ctx.dir, c.dir)`；`parseSkillDir` 为 `null` → blocker「技能 {c.dir} 的 SKILL.md 无法解析」；否则 `scanSkillDir`，条目 `{ name, description, runtimeDeps: scan.runtimeDeps, compatible, incompatibleReason }`，兼容性用 `resolveEffectiveCompatibility(scan, enhancedAvailable)`（`skills/registry.ts:153` 导出）——**不兼容不阻塞安装**（`installPublic` 会把它登记成 `incompatible` 状态），只在同意面板标红。冲突：`skills.publicSkillRow(name) !== null` → `{ kind: 'skill', ref: name, withWhat: '已有同名公共技能' }`（**任何来源**的同名公共技能都算；Bot 私有同名技能是遮蔽，不算冲突）；同一包内两个技能解析出同名 → blocker。 |
| `project` | 按清单顺序：`ctx.ledger.add('skill', name)`；`installPublic({ name, scan, sourceUrl: pluginSkillSource(plugin.id, name), commitOid: plugin.version, contentHash, stagingDir: dir })` |
| `unproject` | 每个 name：`row = skills.publicSkillRow(name)`，`null` → 跳过；`lib = skills.libraryGet(row.library_id)`；`parsePluginSkillSource(lib?.source_url ?? '')?.pluginId === plugin.id` 才 `skills.uninstallPublic(name)`，否则 `logger.warn` 并跳过（**绝不删别人的技能**）；最后 `ledger.remove('skill', name)` |
| `setEnabled(false)` | 同 `unproject` 的删除动作（不动账本）；`setEnabled(true)`：对账本里「`publicSkillRow` 为 null」的名字重新走 `project` 的写入部分（不重复 `ledger.add`） |
| `missing` | 行不存在，或 `libraryDirOf` 的目录不存在 |

**测试** `packages/core/test/unit/plugin-projector-skills.test.ts`（临时 home + 真 `SkillsService`，照 `skills-presets.test.ts` 的 rig）：inspect 的同名冲突（含 Bot 私有同名不冲突）；project 后 `publicSkillRow` 在、`skill_library.source_url` 是 `plugin://…`；unproject 只删自己的（先用别的来源装同名技能 + 账本里硬塞同名 ref，断言**不被删**）；setEnabled 往返；`missing`。

### 步骤 4：`McpbInstaller` 小改（独立提交，`refactor(mcpb)`，既有测试零改动）

文件 `packages/core/src/apps/mcpb/install.ts`。**目标**：让插件投影器能「以调用方指定的 server id / 来源 / 分级」登记 MCPB server，并让包的引用计数同时认 `mcpb` 与 `plugin` 两种来源。独立安装路径（`mcpb.install` RPC）行为**一字不变**。

1. 新增并导出：

   ```ts
   export interface McpbPackageRef { name: string; version: string; sha256: string }
   /** kind 'mcpb' → 来源本身；kind 'plugin' → source.mcpb ?? null；其余 → null。 */
   export function mcpbPackageOf(source: McpServerSource | undefined): McpbPackageRef | null;
   export interface McpbRegistration {
     serverId: string;                    // 覆盖随机的 mcpb_{hex}
     source: McpServerSource;             // 覆盖 {kind:'mcpb',…}
     tier: 'developer' | undefined;       // 覆盖默认（默认：非 fromCatalog 安装为 developer）
     name?: string | undefined;           // 覆盖 server.name（默认 inspection.displayName）
     description?: string | undefined;    // 写入 server.description
   }
   ```

2. `McpbInstallRequest` 加 `register?: McpbRegistration | undefined`。`#installSnapshot` 里：
   - `serverId = input.register?.serverId ?? \`mcpb_${randomBytes(6).toString('hex')}\``；若 `settings.mcpServers` 已有同 id → `AppError('ALREADY_EXISTS', …)`（仅 `register` 时检查，随机 id 不需要）；
   - `source = input.register?.source ?? { kind: 'mcpb', name, version, sha256 }`；
   - `server.name` / `description` / `tier` 按 `register` 覆盖；无 `register` 时保持原逻辑（`tier: 'developer'` 除非 `fromCatalog`）；
   - 同槽冲突检查（l.352–366）与 `sameSlot` 改用 `mcpbPackageOf(server.source)`；
   - `#audit` 的第三个参数改为 `McpbPackageRef`（调用处传 `{ name: manifest.name, version: manifest.version, sha256: inspection.sha256 }`），**审计 detail 的键名与值不变**。
3. `afterServerRemoved`（l.554）：`const pkg = mcpbPackageOf(removed?.source); if (pkg === null) return;` 后续 `#releasePackage(pkg)` 与 `#audit('mcpb_uninstall', …)`；`#releasePackage(pkg: McpbPackageRef)` 的 `stillUsed` 判断改用 `mcpbPackageOf(server.source)` + `sameSlot`。
4. `verify(source: McpbPackageRef | McpServerSource)`：入口先归一化（有 `kind` 的走 `mcpbPackageOf`，无则当 `McpbPackageRef`）；`#extract` 内部的调用同步改。**`uninstall(serverId)`（仅测试使用）保持只认 `kind === 'mcpb'`，不动**。
5. 新增公开方法 `slotConflict(name: string, version: string, sha256: string): { serverId: string } | null`：在 `settings.mcpServers` 里找同 `name@version` 槽位且 `sha256` 不同的 server（用 `mcpbPackageOf`），供注册表预检（`#installSnapshot` 里原有的拒绝逻辑保留，二者共用一个私有函数）。
6. **新增测试**（不要改既有测试文件）：`packages/core/test/unit/mcpb-register.test.ts`，**把 `mcpb.test.ts` 的 `harness()`（l.48–95）与 `expectCode()`（l.97–105）复制一份**到新文件：`register` 安装得到指定 id / `source.kind==='plugin'` / `tier` 覆盖（`undefined` 时无 `tier`）/ 敏感 `user_config` 的 secret 键是 `mcp:{指定id}:env:{KEY}`；同 id 已存在 → `ALREADY_EXISTS`；`afterServerRemoved` 对 plugin 来源释放解包树，且当另一个 server 仍引用同包时不删；`slotConflict` 命中 / 未命中；无 `register` 的安装行为不变（断言 `mcpb_` 前缀与 `tier:'developer'`）。
7. 验证：`node scripts/run-tests.mjs run packages/core/test/unit/mcpb.test.ts packages/core/test/unit/mcpb-register.test.ts packages/core/test/integration/mcpb.test.ts` 全绿；`pnpm --filter @kepcup/core typecheck`。

### 步骤 5：MCP 投影器

文件 `plugins/projectors/mcp.ts`。依赖：

```ts
interface PluginMcpDeps {
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  mcpb: McpbInstaller;
  mcp: Pick<McpService, 'closeServer'>;
  disconnector: Pick<AppDisconnector, 'removeCustomServer'>;
  revokeMcpServerChanges(previous: readonly McpServer[], next: readonly McpServer[]): void;
  logger: CoreLogger;
}
```

纯函数（导出，单测）：`mcpTierFor(tier): 'developer' | undefined`（`verified` → `undefined`，其余 → `'developer'`）；`mcpDescriptionFor(tier, text): string | undefined`（仅 `verified` 返回清洗后的 `oneLine(text, 200)`，其余 `undefined`——描述会进系统提示的 `<capabilities>` 目录行）。

| 方法 | 行为 |
|---|---|
| `inspect` | 按清单顺序。`mcpb`：`const r = await mcpb.inspect(path.join(ctx.dir, c.file))` → 条目 `{ kind:'mcpb', id, displayName: c.name ?? r.displayName, serverType, launchCommand, runtime, mcpbSha256: r.sha256, unpackedSize, userConfigFields, compatible, incompatibleReason }`；`!r.compatible` → blocker `「{displayName}」{incompatibleReason}`；`r.runtime?.available === false` → blocker `「{displayName}」需要 {Node.js / Python / uv} 运行时，请先在「设置 → 环境」安装后重试`（P0 不做内联安装）；`mcpb.slotConflict(...)` 命中 → conflict `{ kind:'mcpb', ref:'name@version', withWhat:'已安装同名同版本但内容不同的 MCPB 包' }`。`http`：`isSafeDirectoryRemoteUrl(c.url)` 为 false → blocker `「{id}」的端点不是可接受的公网 https 地址`；条目 `{ kind:'http', id, displayName: c.name ?? \`${manifest.name} · ${c.id}\`, url, host }`。两种都检查 `pluginServerId(plugin.id, c.id)` 是否已是现有 server id → conflict（理论上不会发生，兜底）。 |
| `project` | 对每个贡献：`serverId = pluginServerId(plugin.id, c.id)`，`ctx.ledger.add('mcp', serverId)`。`mcpb`：先 `r = await mcpb.inspect(file)`，再 `mcpb.install({ filePath: file, sha256: r.sha256, userConfig: ctx.userConfig[c.id] ?? {}, register: { serverId, source: { kind:'plugin', pluginId, version, key: c.id, mcpb: { name: r.name, version: r.version, sha256: r.sha256 } }, tier: mcpTierFor(plugin.tier), name: c.name ?? r.displayName, description: mcpDescriptionFor(plugin.tier, c.description) } })`。`http`：构造 `{ id: serverId, name, transport: 'http', url: c.url, enabled: true, autoApprove: false, auth: 'none', source: { kind:'plugin', pluginId, version, key: c.id }, ...(tier ? { tier } : {}), ...(description ? { description } : {}) }`，先 `mcpServerSchema.parse(...)`，再在**同步区内** `const cur = settings.get(); settings.update({ mcpServers: [...cur.mcpServers, server] })`。 |
| `unproject` | 每个 serverId，**镜像 `mcp.removeServer` 的四步**（`rpc/apps-runtime-bindings.ts:44–64`）：① 同步区内 `previous = settings.get()`，若存在则 `next = settings.update({ mcpServers: previous.mcpServers.filter(...) })`，再 `revokeMcpServerChanges(previous.mcpServers, next.mcpServers)`；② `await disconnector.removeCustomServer(serverId)`（吊销 + 清 `mcp:{id}:*` 密钥 + 关连接）；③ `await mcpb.afterServerRemoved(previous.mcpServers, serverId)`；④ `ledger.remove('mcp', serverId)`。每步 `try/catch`，记 warn 后继续（卸载要尽力而为）。 |
| `setEnabled` | 同步区内把这些 server 的 `enabled` 改成目标值（`settings.update`）；`enabled=false` 时再 `await mcp.closeServer(id)` 并 `revokeMcpServerChanges(previous, next)`。 |
| `missing` | 对 mcpb 来源：`await`-free 的轻检查——server 不在 `settings.mcpServers` 里即缺失（解包树完整性由 `McpbInstaller.verify` 在启动时负责，不在此重复） |

**测试** `plugin-projector-mcp.test.ts`（构造 `McpbInstaller` 的 rig 复用 `mcpb-register.test.ts` 的 harness；http 部分用内存 settings 替身）：`mcpTierFor` / `mcpDescriptionFor` 表驱动；inspect 的运行时缺失 / 不兼容 / 槽位冲突 / 不安全 http（`http://…`、`https://127.0.0.1/…`、带用户信息）；project 后 server 的 id / source / tier / description；`verified` 不带 `tier`、`community` 与 `local` 带 `developer`；unproject 后 settings、secrets（`mcp:{id}:*`）、解包树都清；账本在 project 中途失败时已含已写项（用会抛错的第二个贡献）；`setEnabled` 往返。

### 步骤 6：`ConnectorCatalog` 的 plugin 来源 + 连接器投影器

**6.1 `packages/core/src/apps/catalog.ts` 改动**（`ConnectorCatalog` 现有四个来源：打包快照 / 远端目录 / `extra` / 本机；本步骤加第五个，**位置在发行门禁之后、本机连接之前**）：

```ts
export interface PluginConnectorEntry {
  entry: ConnectorCatalogEntry;    // 已由连接器投影器改写过（tier / releaseGate / toolPolicy / packages）
  pluginId: string;
  iconPath: string | null;         // 绝对路径，已确认在插件目录内
}
export interface PluginConnectorSource { revision(): number; entries(): readonly PluginConnectorEntry[] }
```

- `ConnectorCatalogOptions` 加 `plugin?: readonly PluginConnectorEntry[]`；`buildConnectorCatalog` 在**门禁过滤之后、本机条目之前**追加：与 `entries`（门禁前的全集）及已追加条目的 slug / name 冲突 → `logger.warn` 并跳过（让位），否则 push 并记入 `pluginSlugs`（`Set`）、`pluginIcons`（`Map<slug, iconPath|null>`）、`pluginOwners`（`Map<slug, pluginId>`）；返回值新增 `pluginSlugs / pluginIcons / pluginOwners / yieldedPluginSlugs`。**本机条目的冲突检查要把已追加的 plugin 条目也算进 `takenSlugs / takenNames`**（本机让位于插件）。
- `ConnectorCatalog`：新增 `attachPlugins(source: PluginConnectorSource): void`（同 `attachLocal`：`#revision = ''` 触发重建；`#refresh()` 的 revision 串加上 plugin 的 revision）；新增 `isPlugin(slug): boolean`、`pluginIdOf(slug): string | null`、`yieldedPluginSlugs(): ReadonlySet<string>`。
- `originOf(slug)`：本机 → `'local'`；插件 → `'plugin'`；远端独有 → `'directory'`；否则 `'bundled'`。
- `isDirectorySourced(slug)`：现在 = 远端独有；**改为「远端独有 或 插件来源」**（连接前把端点重新校验为公网 https，永不给回环例外——`connections.ts:234` 已经调用它，无需改调用方）。补注释写明语义已扩大。
- `iconSvg(slug)`：插件条目读 `pluginIcons.get(slug)`（`null` → `null`；非 `.svg` → `null`）；**不要**走 `iconsDir`。
- 门禁：`releaseGate` 已被改写成 `'plugin'`，但插件条目在门禁**之后**追加，不经 `filterReleasedConnectors`，无需处理。

**测试** `packages/core/test/unit/connector-catalog-plugin.test.ts`（新文件；**不要改**既有 `connector-catalog.test.ts` / `directory-merge.test.ts`）：用 `new ConnectorCatalog({ env: {}, source: { entries: [...], iconsDir: null }, approvedGates: null })` + `attachPlugins` 的假来源。覆盖：插件条目出现在 `list()` 末尾且在本机条目之前；`originOf==='plugin'`；`isDirectorySourced` 为真；与打包 / 远端 / 本机条目 slug 或 name 冲突时让位且记入 `yieldedPluginSlugs`；本机条目与插件条目冲突时本机让位；`iconSvg` 读插件自带图标、无图标 → `null`；`revision()` 变化后重建。

**6.2 `plugins/projectors/connectors.ts`**：类 `ConnectorsProjector implements PluginProjector, PluginConnectorSource`（内存里维护 `Map<pluginId, PluginConnectorEntry[]>` 与递增的 `#revision`）。依赖：`{ catalog: ConnectorCatalog; connectionStore: Pick<AppConnectionStore, 'listByConnector'>; disconnector: Pick<AppDisconnector, 'disconnect'>; connections: Pick<AppConnectionsService, 'update'>; events; logger }`。

纯函数（导出、单测）`rewriteConnectorEntry(raw: unknown, plugin: PluginIdentity, iconAbsPath: string | null)`：`connectorCatalogEntrySchema.parse(raw)` 后返回改写后的条目，规则见 README §4.1「连接器条目改写」：`tier` ← 映射（`local→developer`、`verified→verified`、`community→community`）；`releaseGate ← 'plugin'`；删 `hidden`；`toolPolicy` 只留 `risk === 'destructive'`；**`packages` 非空 → 抛**；`remotes` 为空 → 抛；任一 `remotes[].url` 不满足 `isSafeDirectoryRemoteUrl` → 抛；`name` 以 `LOCAL_CONNECTOR_NAME_PREFIX` 开头 → 抛。抛 `AppError('PLUGIN_INVALID', …)`；`inspect` 把这些抛错转成 blocker。

| 方法 | 行为 |
|---|---|
| `inspect` | 每个连接器贡献：读 `path.join(ctx.dir, c.file)` 的 JSON → 取 `icon` 文件名在**同目录**下的路径（不存在 → blocker）→ `rewriteConnectorEntry` 失败 → blocker；成功则条目 `{ slug, name, title, hosts: 去重的 URL host, scopes: auth.scopes.default ∪ write, authKind }`。冲突：`catalog.list()` 里已有同 slug 或同 name 的条目（`catalog` 的全集，含其他插件；不含本插件自己，因为尚未安装）→ `{ kind:'connector', ref: slug, withWhat: '目录里已有同 slug / 同名的连接应用（来源：…）' }`（来源用 `catalog.originOf`）。同包内 slug / name 重复 → blocker。 |
| `project` | 对每个条目：`ctx.ledger.add('connector', slug)`；放进 Map、`#revision++`；`events.emit('apps.catalog_changed', { connectorId: slug, change: 'added' })` |
| `activate` | 启动时：对该插件逐个读文件、`rewrite…`、放进 Map（坏条目 `logger.warn` 跳过，不阻塞启动）；不写账本 |
| `unproject` | 每个 slug：从 Map 移除、`#revision++`；然后**两次**扫描 `connectionStore.listByConnector(slug)` 并 `disconnector.disconnect(id, { removeRow: true })`（第二次兜住摘条目瞬间刚落地的连接，写法同 `LocalConnectors.remove`）；`events.emit('apps.catalog_changed', { connectorId: slug, change: 'removed' })`；`ledger.remove('connector', slug)` |
| `setEnabled(false)` | 从 Map 移除（目录隐藏）、`#revision++`；对每个 slug 的每个状态不是 `disabled` 的连接：`await connections.update({ connectionId, disabled: true })` 并 `ledger.add('disabled_connection', connectionId)`；发 `apps.catalog_changed removed` |
| `setEnabled(true)` | 放回 Map；对账本 `disabled_connection` 里的每个 id：`connections.update({ connectionId, disabled: false })` 后 `ledger.remove('disabled_connection', id)`（**只恢复由插件停用的连接**，用户本来就停用的不动）；发 `apps.catalog_changed added` |
| `missing` | 恒返回 `[]`（连接器条目在内存里，不依赖外部文件） |

**测试** `plugin-projector-connectors.test.ts`：`rewriteConnectorEntry` 表驱动（各改写规则、各拒绝条件、`toolPolicy` 的 `read`/`write` 被剔除而 `destructive` 保留）；inspect 的冲突 / 重复 / 缺图标；project → `catalog.list()` 含条目且 `tier` 正确；unproject 先断开连接再摘条目（用假 `connectionStore` 记录调用顺序）；setEnabled 往返并只恢复自己停用的连接；`activate` 对坏文件容错。

**6.3 `mcp.attachHttpFetch` 谓词**（`start.ts` 约 l.1297）：现为 `row !== null && connectorCatalog.isLocal(row.connectorId) ? guardedMcpFetch : undefined`。改为：

```ts
mcp.attachHttpFetch((server) => {
  if (server.source?.kind === 'plugin') return guardedMcpFetch;          // 插件登记的 http MCP
  const row = apps.store.get(server.id);
  return row !== null && (connectorCatalog.isLocal(row.connectorId) || connectorCatalog.isPlugin(row.connectorId))
    ? guardedMcpFetch : undefined;
});
```

（插件内嵌 MCPB 是 stdio，不走 HTTP；`source.kind==='plugin'` 对它也返回守卫是无害的。）**测试**：在 `plugin-projector-connectors` 或集成测试里断言谓词对 plugin 来源 server / plugin 连接器返回守卫 fetch、对打包连接器返回 `undefined`（由于谓词在 `start.ts` 的闭包里，把它抽成 `apps/http-fetch-policy.ts` 里的纯函数 `useGuardedMcpFetch(server, { store, catalog })` 再单测；`start.ts` 调用它）。

### 步骤 7：邮件投影器（登记型）

`plugins/projectors/mail.ts`：P0a **不落任何运行期状态**（模板在 P1 由 `PluginRegistry` 动态读已装且启用插件的清单提供）。`inspect`：条目 `{ id, label, imapHost, smtpHost }`，邮件模板 `id` 与**内置厂商 id**（`mailProviderSchema.options`）或同包重复 → conflict / blocker；`project`：只 `ctx.ledger.add('mail', id)`；`unproject`：只 `ledger.remove`；`setEnabled`：空操作；无 `activate`。**测试**：inspect 的冲突、project / unproject 只动账本。

### 步骤 8：`PluginRegistry`

文件 `packages/core/src/plugins/registry.ts`。

```ts
export interface PluginRegistryDeps {
  store: PluginStore; packager: PluginPackager;
  projectors: readonly PluginProjector[];       // createPluginProjectors() 的结果（顺序 = PLUGIN_PROJECTOR_ORDER）
  pluginsDir: string; clock: Clock; logger: CoreLogger;
  events: { emit(name: 'plugins.changed', payload: { ids: string[] }): void };
  audit?: { recordSystem(action: string, detail: Record<string, unknown>): unknown };
}
export class PluginRegistry {
  constructor(deps: PluginRegistryDeps);
  start(): Promise<void>;                                  // sweepStaging + recoverInterrupted + activate
  recoverInterrupted(): Promise<number>;
  list(): PluginSummary[];
  inspect(source: PluginSource): Promise<PluginInspectOutput>;
  install(input: { source: PluginSource; sha256: string; userConfig: Record<string, Record<string, McpbUserConfigValue>>; via: 'file' | 'folder' | 'bot' }): Promise<PluginSummary>;
  setEnabled(id: string, enabled: boolean): Promise<PluginSummary>;
  uninstall(id: string): Promise<void>;
  ownerOf(kind: PluginItemKind, ref: string): string | null;
  contributionsOf(id: string): PluginManifest['contributions'] | null;   // 读已装插件清单（P1 邮件模板用）
}
```

**互斥**：私有 `#mutex`（promise 链，照 `SettingsWriteLock` 的写法但**没有超时**）；`install` / `setEnabled` / `uninstall` / `recoverInterrupted` 都在锁内；`inspect` / `list` 不取锁。

**`inspect(source)`**：`staged = await packager.stage(source)`，`finally` 里 `discard`。`identity = { id, version, origin:'local', tier:'developer' }`（P0a 只有本地来源）；对 `PLUGIN_PROJECTOR_ORDER` 里**清单里有该类贡献的**投影器调 `inspect({ …, dir: staged.stagingDir, userConfig: {}, ledger: nullLedger })`；汇总：`skills / connectors / mcp / mail` 条目、`conflicts`、`blockers`。再补：同 id 已安装 → `existing: { version }` 且 blocker「已安装同 id 插件（v{x}），请先卸载（更新流在后续版本提供）」；保留命名空间 → blocker；`installable = blockers.length === 0 && conflicts.length === 0`。`update` 恒 `null`。

**`install(input)`**（互斥锁内；每一步失败都要清理，不留半成品）：

1. `staged = await packager.stage(input.source)`；`try { … } finally { await packager.discard(staged) }`。
2. `staged.packageSha256 !== input.sha256` → `AppError('PLUGIN_INVALID', '包与确认时不一致，请重新选择')`。
3. `assertInstallablePluginId(manifest.id)`；`store.get(id) !== null` → `PLUGIN_CONFLICT`（文案同上）。
4. 运行 `inspect` 的同一套逻辑（复用私有函数 `#inspectStaged`）；有 `conflicts` → `AppError('PLUGIN_CONFLICT', …)`（`message` 列出前 3 项）；有 `blockers` → `AppError('PLUGIN_INCOMPATIBLE', blockers.join('；'))`。
5. **用户配置预校验**（任何持久写入之前）：对每个 `mcpb` 贡献，用 `inspect` 结果里的 `userConfigFields` 与 `manifest.ts` 导出的 `validateUserConfig(fields, input.userConfig[c.id] ?? {})`；失败直接抛（保持其错误码）。
6. `finalDir = pluginDirOf(pluginsDir, id, version)`；`rm(finalDir, { recursive: true, force: true })`（清掉无行的残留目录）；`mkdir(dirname(finalDir), { recursive: true })`；`rename(staged.stagingDir, finalDir)`；之后 `staged.stagingDir = ''`（让 `discard` 变成空操作）。
7. `store.insert({ id, version, origin:'local', tier:'developer', state:'installing', enabled:true, packageSha256, marketplace:null, dir: 相对目录, installedAt: now, updatedAt: now })`。
8. 构造 `ctx`（`dir: finalDir`、`userConfig: input.userConfig`、`ledger` 绑定到该插件的 `store.addItem/removeItem/refs`）。按 `PLUGIN_PROJECTOR_ORDER` 对**清单里有该类贡献的**投影器 `await projector.project(ctx)`。**任一步抛错 → `await this.#teardown(id, identity)`，再原样重抛**（`AppError` 保持原码，其它错误包成 `AppError('INTERNAL', …)`；日志里记原错误）。
9. `store.update(id, { state:'installed', updatedAt })`；`audit.recordSystem('plugin_install', { pluginId, version, origin, tier, via })`；`events.emit('plugins.changed', { ids: [id] })`；返回 `#summaryOf(row)`。

**`#teardown(id, identity)`**（卸载与回滚共用，必须幂等）：`store.update(id, { state:'uninstalling' })`（行存在时）→ 按 `PLUGIN_PROJECTOR_ORDER` **逆序**，对每类取 `refs = store.refs(id, kind)`，`await projector.unproject(identity, refs, ledger)`（单个投影器抛错：`logger.warn` 记下、继续下一个，最后若有错误则在**卸载**路径抛出首个错误但仍完成其余清理；**回滚**路径只记日志）→ `rm(finalDir)`（路径经 `pluginDirOf` 校验）→ `store.delete(id)`。

**`uninstall(id)`**：锁内；行不存在 → `NOT_FOUND`；`#teardown`；审计 `plugin_uninstall`；事件。

**`setEnabled(id, enabled)`**：锁内；行不存在 / `state !== 'installed'` → `NOT_FOUND` / `INVALID_INPUT`；相同值直接返回当前摘要；读已装目录的清单构造 `ctx`（`userConfig: {}`），**禁用按逆序、启用按正序**对有账本项的类别调 `projector.setEnabled(ctx, refs, enabled)`；`store.update(enabled)`；审计 `plugin_set_enabled`；事件。

**`recoverInterrupted()`**：锁内；对 `state ∈ {installing, uninstalling}` 的每一行：构造 `identity` 后 `#teardown`（日志 info 记「恢复中断的安装 / 卸载」）；返回处理的行数。**`start()`** = `packager.sweepStaging()` → `recoverInterrupted()` → 对所有 `installed && enabled` 的插件构造 `ctx`（读磁盘清单；读不到则 `logger.warn` 跳过）并对有 `activate` 的投影器调用（每个 `try/catch`）。

**`list()`**：每行 + 读清单（按 `id@version` 缓存；读失败则 `name = id`、描述空）；`items` 来自账本，`missing` 来自各投影器的 `missing?.()`，`yielded`（连接器让位）来自 `catalog.yieldedPluginSlugs()`（由投影器暴露一个只读方法 `yieldedSlugs()`；注册表通过构造参数拿到它，不直接依赖 `ConnectorCatalog`）；`dirPath` = 绝对目录；`updateAvailable: null`。

**`createPluginProjectors(deps)`**（`projectors/index.ts`）：按 `PLUGIN_PROJECTOR_ORDER` 构造并返回数组（供覆盖率测试与 `start.ts` 使用）。

**测试**：
- `packages/core/test/unit/plugin-registry.test.ts`（真 `PluginStore` + 真 `PluginPackager` + **假投影器**，临时目录）：成功安装的状态 / 账本 / 目录 / 事件 / 审计；投影器在第 2 项抛错 → 回滚（假投影器记录 `unproject` 调用的 refs 与顺序）、目录与行都被清、重抛原错误；`sha256` 不符；同 id 已装 → `PLUGIN_CONFLICT`；保留命名空间；冲突 / blocker 的错误码；`setEnabled` 顺序（禁用逆序、启用正序）与幂等；`uninstall` 中某投影器抛错仍清完其余并抛首个错误；**崩溃恢复**：手工插入 `installing` 行 + 账本 + 目录 → `recoverInterrupted()` 后全清；`uninstalling` 行同理；`start()` 对 `activate` 抛错的容错；互斥（并发两个 `install` 串行，用带 `await` 的假投影器验证交错不发生）。
- `packages/core/test/unit/plugin-projectors-coverage.test.ts`（步骤 2 已述）。

### 步骤 9：守卫（`PLUGIN_MANAGED`）

文件 `plugins/guards.ts`：

```ts
/** 插件登记的 MCP server 里，这些字段只能由插件管线改写。 */
export const PLUGIN_SERVER_PROTECTED_FIELDS = ['transport', 'command', 'args', 'env', 'url', 'headers', 'auth', 'source', 'tier'] as const;
export function assertPluginServersIntact(previous: readonly McpServer[], next: readonly McpServer[]): void;
```

规则：① `previous` 里每个 `source?.kind === 'plugin'` 的 server：在 `next` 里缺失 → 抛 `PLUGIN_MANAGED`「「{name}」由插件 {pluginId} 管理，请在扩展中心「已安装」里卸载该插件」；存在但受保护字段 `isDeepStrictEqual` 不等 → 同码，文案「不能修改插件管理的 MCP 服务器的 {字段}」；② `next` 里任何 `source?.kind === 'plugin'` 的 server，在 `previous` 里不存在同 id 的 plugin 来源 server → 抛 `PLUGIN_MANAGED`「不能手工创建插件来源的 MCP 服务器」（防伪造）。`name`、`enabled`、`autoApprove`、`toolPolicies`、`description` **可以改**。

接入点（**只在 RPC 路径**；注册表自己经 `services.domain.settings.update` 写，不受影响）：

1. `rpc/bindings.ts` 的 `settings.update`：在 `settingsLocked(() => { … })` 回调里，`resolve(current)` 得到 `rest` 之后、`domain.settings.update({...})` 之前：`if (rest.mcpServers !== undefined) assertPluginServersIntact(current.mcpServers, rest.mcpServers);`（**必须在锁内、用最新设置比对**——表单提交的是整份快照，不能拿它自带的 `base` 比）。
2. `rpc/apps-runtime-bindings.ts` 的 `mcp.removeServer`：最前面 `const target = domain.settings.get().mcpServers.find(s => s.id === input.serverId); if (target?.source?.kind === 'plugin') throw new AppError('PLUGIN_MANAGED', …)`。
3. 技能：`SkillsService`（`skills/registry.ts`）新增 `attachPublicUninstallGuard(guard: (name: string) => void): void`，在 `uninstall(botId, name)` 的「无私有行 → 走公共卸载」分支（`this.uninstallPublic(name)` 之前）调用它；**不要**在 `uninstallPublic` 里调用（插件投影器与预置更新都直接用它）。`start.ts` 里 `skills.attachPublicUninstallGuard((name) => { if (plugins.ownerOf('skill', name) !== null) throw new AppError('PLUGIN_MANAGED', …); })`。
4. 其它改 `settings.mcpServers` 的入口核对一遍：`rg -n "mcpServers" packages/core/src/settings/adapters.ts packages/core/src/rpc` —— 设置目录的 `mcpServersAdapter`（只切 `enabled`）允许；若发现别的会删 / 改 server 的路径，在实施记录登记并加守卫。

**测试** `plugin-guards.test.ts`：`assertPluginServersIntact` 表驱动（删除、改 url、改 command、改 tier、改 source、改 `enabled`/`toolPolicies`/`name` 通过、伪造 plugin 来源被拒、非 plugin 来源不受影响）；集成层见步骤 11。

### 步骤 10：RPC 绑定与 `start.ts` 接线

1. `packages/core/src/rpc/plugins-bindings.ts`：`bindPluginsMethods(services: CoreServices): Record<string, RpcMethodSpec>`，**文件内自带 `method()` 助手**（照 `mcpb-bindings.ts` l.12–18 复制）。`registry()` 访问器：`services.plugins === null` → `AppError('NOT_IMPLEMENTED', '插件模块未就绪')`。

   | 方法 | 处理 |
   |---|---|
   | `plugins.list` | `{ plugins: registry().list() }` |
   | `plugins.inspect` | `assertLocalSource(input.source)`；`registry().inspect(input.source)` |
   | `plugins.install` | `assertLocalSource`；`{ plugin: await registry().install({ …input, via: input.source.kind }) }` |
   | `plugins.setEnabled` | `{ plugin: await registry().setEnabled(input.id, input.enabled) }` |
   | `plugins.uninstall` | `await registry().uninstall(input.id); return { ok: true as const }` |

   `assertLocalSource(source)`：`source.kind !== 'marketplace' && currentRemoteSource() !== null` → `AppError('INVALID_INPUT', '远程端点不能从主机本地路径安装插件')`（`currentRemoteSource` 来自 `../remote/audit.js`）。
2. `rpc/bindings.ts`：import 并在 `bindAppMethods` 的展开处（l.1537–1552 一带，`...bindAppsRuntimeMethods(…)` 旁）加 `...bindPluginsMethods(services)`。
3. `rpc/settings-bindings.ts` 的 `EXTRA_METHOD_ITEMS`（l.118–132）：给 `'plugins.install'`、`'plugins.uninstall'`、`'plugins.setEnabled'` 各加 `itemIdsForSettingsPaths(['mcpServers'])`（与 `'mcp.removeServer'` 同写法），这样它们间接改了 `mcpServers` 后会补发 `settings.changed`。
4. `start.ts`：
   - `CoreServices` 接口加 `plugins: PluginRegistry | null`；`services` 初始化 `plugins: null`；
   - 在 `new SettingsCatalogHost(...)` 之后、`new Orchestrator(` 之前：构造 `PluginStore(mainDb)`、`PluginPackager`、投影器（依赖来自同函数作用域里的 `skills`、`environment`、`settings`、`mcpb`、`mcp`、`appRuntime.disconnector`、`settingsPermissionEffects`、`connectorCatalog`、`apps.store`、`appConnections`、`events`、`logger`）、`PluginRegistry`；`connectorCatalog.attachPlugins(connectorsProjector)`；`skills.attachPublicUninstallGuard(...)`；`audit` 传 `domain.audit`（`AuditService`，即 `new AuditService` 的实例；变量名以 l.1240 附近为准）；
   - `services.plugins = plugins`（与 `services.mcpb = mcpb` 同一段赋值，l.3121–3155 一带）；
   - 启动恢复：在 `environment.recoverInterrupted()`（l.2870 附近）之后加 `await plugins.start()`（`try/catch`，失败只 `logger.error`，**不得让 core 启动失败**）；
   - `close()`：无定时器，不需要显式停止；
   - `mcp.attachHttpFetch` 谓词按步骤 6.3 改。
5. 其它：`packages/core/src/index.ts` 若导出了各服务类型，按相邻风格补 `PluginRegistry`；`docs/dev/02-architecture.md` 的 core 模块清单（如有）加 `plugins/` 一行，没有则跳过并在实施记录写明。

### 步骤 11：集成测试

`packages/core/test/integration/plugins.test.ts`，用 `createTestStack({ mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } } })`（照 `integration/mcpb.test.ts` 的 `setup()`），夹具用 `buildPluginFixture`，调用用 `stack.core.rpc.call(...)`。至少覆盖：

| 用例 | 断言 |
|---|---|
| 完整安装（2 技能 + 1 内嵌 mcpb + 1 http + 1 连接器） | `plugins.inspect` 返回 `installable: true` 且各类条目齐全 → `plugins.install` 后：`skills.list` 出现 2 个公共技能（`scope:'public'`）；`settings.get().mcpServers` 有 2 个 `plg_…` server（`source.kind==='plugin'`、本地来源 `tier:'developer'`）；`apps.catalog.list` 含连接器且 `origin:'plugin'`、`tier:'developer'`；`plugins.list` 的计数与 `items` 对；内嵌 mcpb 的 server 能真正被 `core.services.mcp!.callTool` 调通（照 `integration/mcpb.test.ts`） |
| 开发目录安装 | 同一份内容经 `{kind:'folder'}` 得到相同 `packageSha256` 之外的全部结果一致（`origin` 同为 local） |
| sha256 不符 | `plugins.install` 带错 sha256 → `PLUGIN_INVALID`，无任何残留（目录、行、技能、server） |
| 冲突 | 先装一个同名公共技能（经 `skills.presets` 或直接 `installPublic`）→ `inspect.conflicts` 含 skill、`install` → `PLUGIN_CONFLICT` 且无残留；同 slug 连接器冲突同理 |
| 运行时缺失 | 不注入 `mcpbRuntimes` → `inspect.blockers` 含运行时说明，`install` → `PLUGIN_INCOMPATIBLE` |
| `user_config` 必填缺失 | `install` 抛错且**没有**目录 / 行残留 |
| 启停 | `setEnabled(false)`：技能消失、server `enabled:false`、连接器从 `apps.catalog.list` 消失；`setEnabled(true)` 恢复；`plugins.list.enabled` 随之变 |
| 卸载级联 | 先给 mcpb 的敏感 `user_config` 落一个 secret、给连接器造一个连接（用 `AppConnectionStore` 直接 insert 或 testkit 的假授权，**由你判断**更省事的方式，写进实施记录）→ 卸载后：技能无、server 无、`mcp:{id}:*` secrets 无、连接行无、`toolchains/mcpb/*` 解包树无、目录无、`plugin_items` 无 |
| 守卫 | `mcp.removeServer` 对插件 server → `PLUGIN_MANAGED`；`settings.update` 删除 / 改 `url` → `PLUGIN_MANAGED`，改 `enabled` / `toolPolicies` 成功；`skills.uninstall` 对插件技能 → `PLUGIN_MANAGED`；对用户自己装的同名私有技能仍可卸载 |
| 远程端点 | 经 `withRemoteSource('dev_x', …)`（`remote/audit.ts`）调 `plugins.inspect` 的 `file` 来源 → `INVALID_INPUT` |
| 重启恢复 | 关闭 core 再用同一个 `home` 起新 core：插件连接器仍在目录里（`activate`）；技能 / server 仍在 |

## 5. 验收

- [ ] `refactor(mcpb)` 提交独立；`mcpb` 既有测试（`unit/mcpb.test.ts`、`integration/mcpb.test.ts`）**零改动**全绿。
- [ ] 步骤 1–11 的新测试全绿：`node scripts/run-tests.mjs run packages/core/test/unit/plugin-store.test.ts packages/core/test/unit/mcpb-register.test.ts packages/core/test/unit/plugin-projector-skills.test.ts packages/core/test/unit/plugin-projector-mcp.test.ts packages/core/test/unit/plugin-projector-connectors.test.ts packages/core/test/unit/connector-catalog-plugin.test.ts packages/core/test/unit/plugin-registry.test.ts packages/core/test/unit/plugin-guards.test.ts packages/core/test/unit/plugin-projectors-coverage.test.ts packages/core/test/integration/plugins.test.ts`。
- [ ] 既有相关测试不回归：`node scripts/run-tests.mjs run packages/core/test/unit/connector-catalog.test.ts packages/core/test/unit/directory-merge.test.ts packages/core/test/unit/skills-presets.test.ts packages/core/test/integration/local-connectors.test.ts packages/core/test/integration/catalog-connect.test.ts packages/core/test/unit/settings-adapters-coverage.test.ts`。
- [ ] `pnpm --filter @kepcup/core typecheck` 通过；`pnpm --filter @kepcup/shared build` 后 desktop 的 `typecheck` 通过（`ConnectorOrigin` / `McpServerSource` 的变化没有打破渲染层类型）。
- [ ] 注入失败 / 崩溃恢复不留半成品（`plugin-registry.test.ts`）。
- [ ] `plugins.install` 全程**没有** `import()` / `require()` / `vm` / `eval` 对包内文件的使用（`rg -n "import\\(|require\\(|new Function|vm\\." packages/core/src/plugins` 逐条核对，结论写进实施记录）。
- [ ] 本阶段**不跑**全量 `pnpm test`（P0a-3 收口时跑）。

## 6. 实施记录

（执行智能体在最后一个提交里填写：做了什么 / 偏差与 DEV 编号 / 卸载级联用例里连接行的造法 / 其它改 `mcpServers` 的入口核对结论 / 遗留问题。）
