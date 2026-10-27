# P1-2 · 更新流：权限差异再同意、server id 稳定、端点变化断连、崩溃回滚、本地同 id 重装

> 状态：**待实施**。依赖：P1-1 已合入。分支：`feat/plugins/p1-2-updates`（从 P1-1 合入点拉出）。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §6.3（更新语义）、§6.2（本地同 id 重装 = 更新流）、§7、§10 的「更新」行。Q7 已确认：**更新永远由用户点击触发；权限集扩大再同意**。

## 1. 目标

交付后：已安装插件可以更新到新版本（市场来源：索引里更高的兼容版本；本地来源：任意重新选择的包 / 目录，含同版本不同内容）。更新**不是「先卸后装」**：

- MCP server id 因确定性派生**保持不变**，所以能力 `mcp:{serverId}`、逐工具策略（`toolPolicies`）、`enabled`、Bot 勾选都保留；**`autoApprove` 一律重置为 `false`**（新代码不继承旧信任）；敏感 `user_config` 值**留空 = 保留已存的 secret**；
- 连接器条目原位替换；slug 不变；**端点或认证绑定变化 → 经 `AppDisconnector` 断开该连接器的既有连接**（令牌受众不再成立），没变则连接保留；
- 技能按内容哈希原地替换，新版本里删掉的技能 / server / 连接器 / 模板被清理；
- **推导出的权限集比旧版本大 → 必须带 `acknowledgeDiff: true` 才执行**（界面在 P1-3 弹差异）；
- 更新是**有日志的事务**：任一步失败 → 补偿回到旧版本；进程在更新中途崩溃 → 下次启动按日志回滚。

**本阶段没有界面**；验证靠 core 集成测试。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| 迁移：`plugins` 加更新日志列 | 更新的界面、「全部更新」按钮（P1-3） |
| `McpbInstaller` 的 `replaceExisting` 与公开的 `releaseIfUnused`——**独立提交** | 邮件模板读取（P1-3） |
| `PluginProjector` 接口：`update` / `beginUpdate` / `commitUpdate` / `rollbackUpdate`；四个投影器的实现与冲突排除（`owned`） | |
| `plugins/permissions.ts`（权限集推导与差异） | |
| `PluginRegistry.update`、本地同 id 重装、`inspect` 的 `update` 字段、崩溃回滚、孤儿目录清理 | |
| RPC `plugins.update`；`plugins.install` 加 `acknowledgeDiff` | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -5
ls packages/core/migrations/main | tail -3                       # 本阶段迁移 = 最新 + 1（写作时 0055；P0b 占 0054）
rg -n "blocker|已安装同 id" packages/core/src/plugins/registry.ts   # P0a-2 里「已安装同 id → 请先卸载」的位置，本阶段要改
rg -n "#releasePackage|afterServerRemoved|slotConflict" packages/core/src/apps/mcpb/install.ts
rg -n "validateUserConfig|renderLaunch" packages/core/src/apps/mcpb/manifest.ts | head
```

必读：`packages/core/src/plugins/{registry.ts,projectors/*.ts,store.ts,ids.ts}`（P0a-2 成果）、`packages/core/src/apps/mcpb/{install.ts,manifest.ts}`（**尤其 `renderLaunch` 对 `sensitive` 字段的处理与 `validateUserConfig`**）、`packages/core/src/apps/directory-merge.ts`（`compareConnectorVersions`、规则 2「slug 不得变」）、`packages/core/src/apps/disconnect.ts`（`oauthBindingChanged`）。

## 4. 步骤

### 步骤 1：迁移与 `PluginStore`

1. `packages/core/migrations/main/0055_plugin_update_journal.sql`（编号以核对为准）：

   ```sql
   -- D104: update journal. A non-NULL update_to marks an update in flight; the row keeps describing
   -- the OLD version/dir until the commit statement flips everything at once.
   ALTER TABLE plugins ADD COLUMN update_to TEXT;
   ALTER TABLE plugins ADD COLUMN update_snapshot TEXT;   -- JSON {kind: opaque string} from projector.beginUpdate()
   ```

2. `PluginStore`：`PluginRow` 加 `updateTo: string | null`、`updateSnapshot: string | null`；`update()` 的 patch 类型加这两个字段（可置 `null`）；新增 `listUpdating(): PluginRow[]`（`update_to IS NOT NULL`）。
3. 测试：`plugins-migration.test.ts` 补两列存在且默认 `NULL`；`plugin-store.test.ts` 补读写往返与 `listUpdating`。`public-skills-migration.test.ts` 的回拨重放**无需改**（`ALTER ADD COLUMN`，且 `plugins` 表已在 P0a 里被 `drop`）。`docs/dev/03-data-model.md`：迁移表加行、`plugins` 小节补两列说明。

### 步骤 2：`McpbInstaller` 替换模式（独立提交，`refactor(mcpb)`，既有测试零改动）

文件 `packages/core/src/apps/mcpb/install.ts`：

1. `McpbRegistration` 加 `replaceExisting?: boolean | undefined`。`#installSnapshot` 在 `register.replaceExisting === true` 时：
   - **要求**现有 server（按 `register.serverId`）存在且 `source?.kind === 'plugin'` 且 `pluginId` 与 `register.source` 的一致，否则 `AppError('NOT_FOUND', …)`；**不再报** `ALREADY_EXISTS`；
   - 新 server 对象照常构造，然后**保留**现有的 `enabled` 与 `toolPolicies`、`autoApprove: false`（强制）；在 `settings.mcpServers` 里**按 id 原位替换**（保持数组顺序），仍在同一个同步区内读—改—写；
   - 敏感 `user_config`：**只对本次提供了值的字段** `secrets.setValue(...)`；没提供值的敏感字段，若 secret `mcp:{serverId}:env:{KEY}` 已存在则视为「保留」——为让 `validateUserConfig` / `renderLaunch` 通过，在**内存里**给它塞占位值 `'\u0000kept'`（只用于校验与生成 `secret:env:{KEY}` 占位符，**绝不写入 secrets**）；不存在且必填 → 照常报缺失。为判断「secret 已存在」，`McpbInstallerDeps.secrets` 加可选 `hasValue?(name: string): boolean`（`start.ts` 传 `secrets.has…`——以 `SecretsService` 实际方法名为准；缺省视为不存在）；
   - **不释放旧包解包树**（回滚可能还要用）；旧包由注册表在提交后经下面的 `releaseIfUnused` 释放。
2. 把私有的 `#releasePackage(pkg)` 公开为 `releaseIfUnused(pkg: McpbPackageRef): Promise<void>`（行为不变：仍被任何 server 的 `mcpbPackageOf(source)` 引用就不删；marker 校验保留）。原内部调用改指新名。
3. `#audit('mcpb_install', …)` 在替换模式 detail 加 `replaced: true`（其余键不变）。
4. **测试**（新文件 `packages/core/test/unit/mcpb-replace.test.ts`，harness 复制自 `mcpb.test.ts`）：替换后 id 不变、位置不变、`enabled` / `toolPolicies` 保留、`autoApprove` 被强制 `false`（即使旧值 `true`）；新包解包树存在、**旧包树仍在**；`releaseIfUnused(旧包)` 后旧树消失，仍被引用的包不删；敏感字段留空 → secret 值未变且 server 的 env 仍是 `secret:env:KEY` 占位符；敏感字段提供新值 → secret 被覆盖；敏感必填字段留空且无已存 secret → 报缺失；`replaceExisting` 对不存在 / 非 plugin 来源 / 别的 pluginId 的 server → `NOT_FOUND`；无 `replaceExisting` 的路径行为不变（既有测试保证）。
5. 验证：`node scripts/run-tests.mjs run packages/core/test/unit/mcpb.test.ts packages/core/test/unit/mcpb-register.test.ts packages/core/test/unit/mcpb-replace.test.ts packages/core/test/integration/mcpb.test.ts`；`pnpm --filter @kepcup/core typecheck`。

### 步骤 3：权限集推导 `plugins/permissions.ts`

纯函数，单测 `plugin-permissions.test.ts`：

```ts
export interface ConsentItems { skills: PluginConsentSkill[]; connectors: PluginConsentConnector[]; mcp: PluginConsentMcp[]; mail: PluginConsentMail[] }
/** 规范化权限令牌集合（用于「新版本是否比旧版本多要了东西」）。 */
export function permissionTokens(items: ConsentItems): Set<string>;
export function diffPermissions(oldTokens: ReadonlySet<string>, newTokens: ReadonlySet<string>): { expanded: boolean; added: string[] /* 令牌，已排序 */ };
/** 令牌 → 一句中文，给同意面板的「新增权限」列表。 */
export function describePermission(token: string): string;
```

令牌（**全部小写前缀 + 冒号**，一类一种）：

| 来源 | 令牌 |
|---|---|
| 技能 | `skill:{name}` |
| 连接器 | `connector:{slug}`、每个 host 一个 `host:{host}`、每个范围一个 `scope:{slug}:{scope}` |
| MCP（mcpb） | `mcpb:{id}`、有运行时则 `runtime:{kind}`、每个 `user_config` 字段一个 `config:{id}:{key}` |
| MCP（http） | `mcp-http:{id}`、`host:{host}` |
| 邮件模板 | `mail:{id}` |

`diffPermissions.expanded` = 新集合里存在旧集合没有的令牌（**只删不增 = 不扩大**）。`describePermission` 示例：`skill:docx` →「新增技能 docx（对所有 Bot 可见）」；`host:api.x.com` →「新增网络主机 api.x.com」；`scope:notion:write` →「应用 notion 新增授权范围 write」；`mcpb:db` →「新增本地 MCP 服务器 db」；`runtime:node` →「需要 Node.js 运行时」；`config:db:token` →「MCP 服务器 db 新增配置项 token」；`mcp-http:docs` / `connector:x` / `mail:x` 同理；未知前缀原样返回。

### 步骤 4：投影器接口与四个投影器的更新实现

**4.1 接口**（`plugins/projectors/index.ts`）：

```ts
export interface PluginProjectionContext {
  // …P0a-2 的字段…
  /** 本插件当前已拥有的 refs（来自账本）；`inspect` 判冲突时要**排除**它们。install 时为空集。 */
  owned: Readonly<Record<ProjectedKind, ReadonlySet<string>>>;
}
export interface PluginProjector<T = unknown> {
  // …P0a-2 的方法…
  /** 让运行期状态从 oldCtx 对应的版本变成 newCtx 对应的版本；保留用户状态；可重入（失败后可被反向调用）。 */
  update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void>;
  /** 更新开始前记录「只靠补偿无法精确还原」的状态；返回要存进 update_snapshot 的字符串，或 null。 */
  beginUpdate?(plugin: PluginIdentity): Promise<string | null>;
  /** 更新提交后清理旧版本遗留（释放旧包解包树等）。 */
  commitUpdate?(plugin: PluginIdentity, snapshot: string | null): Promise<void>;
  /** 更新失败 / 崩溃回滚：精确还原到 snapshot。实现了它的投影器，回滚时**不再**用反向 `update`。 */
  rollbackUpdate?(plugin: PluginIdentity, snapshot: string | null): Promise<void>;
}
```

四个投影器的 `inspect` 都要把 `ctx.owned[kind]` 里的 ref 排除出冲突判断：技能（`owned.skill` 含该名 → 不算冲突）、连接器（`owned.connector` 含该 slug → 不算冲突）、MCP（`owned.mcp` 含派生 server id → 不算冲突；同槽 `slotConflict` 同样排除自己旧包）、邮件（`owned.mail`）。

**4.2 技能 `update`**：对新清单的每个技能：`ledger.add('skill', name)`；`row = publicSkillRow(name)`——存在则取 `lib = libraryGet(row.library_id)`，`parsePluginSkillSource(lib.source_url)?.pluginId !== plugin.id` → 抛 `PLUGIN_CONFLICT`（别人的技能）；`lib.content_hash === 新 contentHash` → 跳过；否则 `uninstallPublic(name)` 后 `installPublic({ … sourceUrl: pluginSkillSource(新插件 id, name), commitOid: 新版本 })`。旧清单里有、新清单里没有的技能：按 `unproject` 的同一套带归属检查的删除，并 `ledger.remove`。无 `beginUpdate`（反向 `update(新→旧)` 即可还原：旧目录还在）。

**4.3 MCP**（`beginUpdate` / `commitUpdate` / `rollbackUpdate` / `update`）：

- `beginUpdate(plugin)`：同步读 `settings.mcpServers` 里 `source.kind==='plugin' && source.pluginId===plugin.id` 的全部 server，返回 `JSON.stringify({ servers })`（**不含 secret 值**——`env` 里只有 `secret:env:KEY` 占位符）。
- `update(oldCtx, newCtx)`：对新清单每个 mcp 贡献：`serverId = pluginServerId(plugin.id, c.id)`，`ledger.add('mcp', serverId)`；`wasOwned = oldCtx.owned.mcp.has(serverId)`；
  - `mcpb`：`r = await mcpb.inspect(file)`，`mcpb.install({ filePath, sha256: r.sha256, userConfig: newCtx.userConfig[c.id] ?? {}, register: { serverId, source: {kind:'plugin', pluginId, version: 新版本, key: c.id, mcpb: {…}}, tier: mcpTierFor(新 tier), name: …, description: mcpDescriptionFor(新 tier, …), replaceExisting: wasOwned } })`；
  - `http`：`wasOwned` → 同步区内就地替换该 server（`url`、`name`、`description`、`source`、`tier` 取新值；`enabled`、`toolPolicies` 保留；`autoApprove: false`）；否则按 `project` 的方式新增。
  - 旧清单里有、新清单里没有的 server：按 `unproject` 的四步删除，并 `ledger.remove`。
  - 完成后 `revokeMcpServerChanges(previous, next)`；被替换 / 删除的 server `await mcp.closeServer(id)`（让新命令生效、旧连接断开）。
- `commitUpdate(plugin, snapshot)`：解析 `snapshot.servers`，对每个的 `mcpbPackageOf(source)` 调 `mcpb.releaseIfUnused(pkg)`（仍被新 server 引用的不会被删）。
- `rollbackUpdate(plugin, snapshot)`：同步区内把 settings 里本插件的 server 还原成快照：快照里有的按 id 放回（已存在则覆盖，不存在则追加）、快照里没有但现在属于本插件的删除（并 `removeCustomServer` + `afterServerRemoved`，释放**新**包树）；`revokeMcpServerChanges`；对被还原 / 删除的 id `mcp.closeServer`。快照为 `null` 视为「更新前本插件没有 server」→ 删除全部本插件 server。

**4.4 连接器 `update`**：旧条目 = 内存 Map 里该插件当前的条目；新条目 = 读新目录并 `rewriteConnectorEntry`（`plugin` 身份用新版本 / 新 tier）。对 slug 同时存在于新旧的条目：**绑定变化判定** `bindingChanged = 旧 remotes 的第一个 streamable-http url !== 新的 || 旧 auth.kind !== 新 || 旧 auth.registration !== 新 || 旧 auth.clientRef !== 新`（范围变化走 D73 的 step-up，**不算**绑定变化）；变化 → 对该 slug 的全部连接 `disconnector.disconnect(id, { removeRow: true })`（两次扫描，同 `unproject`）；slug 在新旧里**不同名但 slug 相同**（`name` 变了）视为 `slug_changed` → `PLUGIN_INVALID`（照 `directory-merge` 规则 2 的精神：slug 是 `app_{slug}_*` 工具前缀与连接行的键，不得变）。新增的 slug：`ledger.add` + 放入 Map；旧有新无的：按 `unproject` 删除；其余原位替换；最后 `#revision++` 并发 `apps.catalog_changed`（`added`）。反向 `update(新→旧)` 可还原（条目由文件推导）；被断开的连接**无法恢复**——这是已知限制，写进实施记录。

**4.5 邮件 `update`**：只同步账本（新增 `ledger.add`、删除 `ledger.remove`）。

**测试**：`plugin-projector-update.test.ts`（技能 / 连接器 / 邮件投影器的 `update`，用真服务 rig，参照 P0a-2 的投影器测试）：技能内容变化被替换、未变化不重装、删除的技能被清理且不碰别人的同名技能；连接器端点变化断连 / 不变保留连接 / slug 被改名报错 / 新增删除；`owned` 排除使得更新自己不报冲突。MCP 的 `update` / `beginUpdate` / `commitUpdate` / `rollbackUpdate` 放进 `plugin-projector-mcp.test.ts`（补用例）：server id 稳定、`enabled` / `toolPolicies` 保留、`autoApprove` 重置、http 与 mcpb 两种、新包树存在且旧包树在 `commitUpdate` 之前仍在、`rollbackUpdate` 还原快照并释放新包树、快照为 `null`。

### 步骤 5：`PluginRegistry` 的更新流

**5.1 `inspect` 的 `existing` / `update`**（替换 P0a-2 里「已装同 id → 阻塞」的逻辑）：

| 已装行 | 来源 | 结果 |
|---|---|---|
| 无 | — | 全新安装（同前） |
| `origin==='local'` | `file` / `folder` | **更新**：`existing = { version }`；版本不限（可同版本、可更低） |
| `origin==='marketplace'` 且 `row.marketplace === 当前 endpointId()` | `marketplace` | **更新**：要求 `compareConnectorVersions(新, 旧) > 0`，否则 blocker「已是最新版本或更旧（不允许降级）」 |
| 其它组合 | — | blocker「已安装同 id 插件（来源：…），请先卸载」 |

更新时 `inspect` 额外：用 `ctx.owned`（账本）排除自己的冲突；`update = { from: row.version, permissionsExpanded, added: added.map(describePermission) }`，其中旧权限集用**已装目录**跑各投影器 `inspect` 取 `items`（**忽略其 `conflicts` / `blockers`**）再 `permissionTokens`；新权限集同理用 staging。`installable` 仍 = 无 blocker 且无 conflict。

**5.2 入口**：
- `plugins.install`：同 id 已装且为本地更新（上表第二行）→ 走更新流（`via` 为 `file` / `folder`），其余已装情形仍 `PLUGIN_CONFLICT`；入参加 `acknowledgeDiff`（`pluginsInstallInputSchema` 增 `acknowledgeDiff: z.boolean().default(false)`，加性）。
- 新增 RPC `plugins.update`：`pluginsUpdateInputSchema = { id: pluginIdSchema, version?: pluginVersionSchema, sha256, userConfig（同 install）, acknowledgeDiff: z.boolean().default(false) }`，输出 `{ plugin: PluginSummary }`；行不存在 → `NOT_FOUND`；`origin==='local'` → `INVALID_INPUT('本地插件请重新选择文件或目录安装')`；`row.marketplace !== 当前 endpointId()` → `INVALID_INPUT('该插件来自另一个市场（当前市场地址已更改），不能更新')`；否则解析 `{ kind:'marketplace', id, version }`（缺省取最高兼容版本）并走更新流。登记到 `rpcMethodSchemas` 与 `APP_METHODS`；`rpc/settings-bindings.ts` 的 `EXTRA_METHOD_ITEMS` 给 `'plugins.update'` 同样加 `itemIdsForSettingsPaths(['mcpServers'])`。

**5.3 `#performUpdate`**（互斥锁内；`row` = 现行、`staged` 已 `stage` 且 sha256 已与入参核对）。**严格按此顺序**：

1. 校验：`manifest.id === row.id`；`origin` / `marketplace` 与上表一致；新 `tier`（市场 = 条目 tier；本地 = `developer`）。
2. 读旧清单（旧目录 `oldDir = pluginDirOf(row.id, row.version)` 下的 `plugin.json`）；`newDir = pluginDirOf(row.id, 新版本)`；`sameDir = oldDir === newDir`。
3. 各投影器 `inspect`（新：`dir = staged.stagingDir`、`owned` = 账本）→ 有 `conflicts` → `PLUGIN_CONFLICT`；有 `blockers` → `PLUGIN_INCOMPATIBLE`。**`user_config` 预校验**：对新版本每个 mcpb 贡献，必填字段若是敏感且 `secrets` 里已有 → 视为已满足，其余必填字段必须在 `input.userConfig[c.id]` 里有值，否则抛 `INVALID_INPUT`。权限差异：`expanded && !acknowledgeDiff` → `AppError('INVALID_INPUT', '更新新增了权限，请先确认差异', { permissionsExpanded: true, added })`。
4. **日志**：对每个实现了 `beginUpdate` 的投影器取快照，`store.update(id, { updateTo: 新版本, updateSnapshot: JSON.stringify(按 kind 的快照对象), updatedAt })`（此后进程任何时刻崩溃，启动恢复都能回滚）。
5. **文件**：`sameDir` → `rename(oldDir, prevDir)`（`prevDir = oldDir + '.prev'`，同父目录；路径经 `plugins/ids.ts` 新增的 `pluginPrevDirOf(dir)` 守卫）；然后 `rename(staged.stagingDir, newDir)`；`staged.stagingDir = ''`。`oldCtxDir = sameDir ? prevDir : oldDir`。
6. **投影**：按 `PLUGIN_PROJECTOR_ORDER`，对「旧或新清单含该类贡献」的投影器 `await projector.update(oldCtx, newCtx)`。任何一步抛错 → 第 8 步补偿后**原样重抛**。
7. **提交**（单条 `store.update`，把一切一起翻转）：`{ version: 新, tier: 新, packageSha256: 新, dir: 相对新目录, marketplace: 市场来源则 endpointId、本地不变, updateTo: null, updateSnapshot: null, updatedAt }`；然后对实现了 `commitUpdate` 的投影器 `await commitUpdate(…, 快照)`（每个 `try/catch`，失败只 warn）；`rm(oldCtxDir, { recursive: true, force: true })`；审计 `plugin_update`（detail：`{ pluginId, from, to, origin, tier, via, permissionsExpanded }`）；`events.emit('plugins.changed', { ids: [id] })`；返回新摘要。
8. **补偿**（第 6 步失败时；每步 `try/catch`，记 error 日志后继续）：按 `PLUGIN_PROJECTOR_ORDER` **逆序**：实现了 `rollbackUpdate` 的 → `rollbackUpdate(旧身份, 快照)`；否则 → `projector.update(newCtx, oldCtx)`（反向）。然后 `rm(newDir)`；`sameDir` → `rename(prevDir, oldDir)`；`store.update(id, { updateTo: null, updateSnapshot: null })`；审计 `plugin_update` 带 `failed: true`（detail 加 `error` 的 `code`，**不含文案里的路径或配置值**）。

**5.4 崩溃恢复**：`recoverInterrupted()`（P0a-2）在处理 `installing` / `uninstalling` 行**之前**先处理 `store.listUpdating()`：对每行 `#rollbackUpdate(row)`：`oldVersion = row.version`、`newVersion = row.updateTo`；`oldDir` / `newDir` / `prevDir` 同上；
- `newDir` 不存在（崩溃发生在第 5 步之前）→ 只清日志（`updateTo = null`），若 `prevDir` 存在则 `rename(prevDir, oldDir)`；
- 否则按第 8 步的补偿流程执行（`snapshot = JSON.parse(row.updateSnapshot)`；`oldCtx` / `newCtx` 的清单从磁盘读，读不到则跳过对应投影器并 warn）。

**5.5 孤儿清理**：`start()` 末尾 `#sweepOrphanDirs()`：遍历 `{pluginsDir}/*/*`（跳过 `.staging`）：目录名形如 `{name}@{version}` 且 `(ns/name, version)` 在 `store.list()` 里没有对应行 → 删除；形如 `…@{version}.prev` 且对应行没有 `updateTo` → 删除。**不清理**任何名字不符合模式的目录（只处理自己创建的）。

**5.6 其余**：`list()`（P1-1）已有 `updateAvailable`；更新成功后它自然变 `null`。`setEnabled` 在 `updateTo !== null` 的行上直接 `INVALID_INPUT('插件正在更新')`（正常不会发生：互斥锁已串行）。

### 步骤 6：测试

- `plugin-permissions.test.ts`（步骤 3）；
- `plugin-registry.test.ts`（补，真 store + 真 packager + **假投影器**）：更新成功顺序（日志写入 → 文件 → 投影 → 提交 → 提交钩子 → 删旧目录）；任一投影器 `update` 抛错 → 逆序补偿（`rollbackUpdate` 优先于反向 `update`）、文件还原（`sameDir` 的 `.prev` 换回）、日志清空、重抛原错误；`expanded && !acknowledgeDiff` 被拒且**零写入**；不扩大无需 `acknowledgeDiff`；市场来源不允许降级 / 同版本；本地来源允许同版本 / 更低版本；`row.marketplace` 与当前 endpoint 不符 → 拒；崩溃恢复（手工插入带 `updateTo` 的行 + 新旧目录 → `recoverInterrupted()` 后还原；`newDir` 不存在的分支）；孤儿目录清理（含「不动不符合模式的目录」）；
- `packages/core/test/integration/plugins-update.test.ts`（`createTestStack` + 市场夹具 + `buildPluginFixture`，`mcpbRuntimes` 注入 node）：

  | 用例 | 断言 |
  |---|---|
  | 市场更新 1.0.0 → 1.1.0 | `plugins.list.version` 变；技能内容换新（`skill_library` 新行、旧行被回收）；MCP server id 不变、`toolPolicies` 与 `enabled` 保留、`autoApprove` 被重置、旧 mcpb 解包树在提交后消失、新树存在；连接器条目换新、端点不变的连接**还在** |
  | 连接器端点变化 | 事先插入一条该连接器的连接行 → 更新后该行被删（经 `AppDisconnector`）；认证 `registration` 变化同理 |
  | 删除的内容被清理 | 新版本去掉一个技能 / 一个 mcp / 一个连接器 → 对应 ref 与账本行消失，被删连接器的连接被断开 |
  | 权限扩大 | `inspect.update.permissionsExpanded === true` 且 `added` 非空；不带 `acknowledgeDiff` 的 `plugins.update` → `INVALID_INPUT` 且旧版本完好无损；带则成功 |
  | 敏感配置 | 旧版本装时填了敏感 `user_config`；更新时留空 → secret 未变且 server 仍可用；改值 → secret 被覆盖 |
  | 本地同 id 重装 | `plugins.install` 同 id（`file`）→ 走更新（`existing` 非空）；同版本不同内容也行；`.prev` 目录在成功后消失 |
  | 回滚 | 在 mcp 投影器的 `update` 里用测试钩子 / 注入替身让第二个 server 失败（**由你判断**怎么注入：推荐给 `PluginRegistryDeps` 加测试用的 `projectorWrap?: (p) => p`，仅 `__KEPCUP_TEST_HOOKS__` 下生效；写进实施记录）→ 更新失败后：版本、server 配置、技能、连接器、目录全部回到旧版本，`updateTo` 清空 |
  | 撤销与更新 | 目标版本被撤销 → `inspect`/`update` 被拒 |
  | 重启恢复 | 构造「更新进行到一半」的磁盘与 DB 状态后重启 core → 回到旧版本且可用 |

### 步骤 7：P0a-3 界面与 e2e 的必要联动（让 P1-2 单独合入时界面不自相矛盾）

P0a-3 的界面把「已安装同 id」当作**阻塞**；P1-2 之后同 id 的本地重装变成**更新**，所以做三处最小联动（完整的更新界面在 P1-3）：

1. `features/plugins/PluginConsentPanel.svelte`：红色「已安装同 id 的插件」（`plugins.consent.existing`）只在 `info.existing !== null && info.update === null` 时显示；`info.update !== null` 时改显示一行中性提示 `plugins.update.from`（`{from}` / `{to}` = 已装版本 / 包内版本）；`info.update?.permissionsExpanded === true` 时列出 `info.update.added`（每项一行）并在其下渲染必须勾选的复选框 `data-testid="plugins-install-ack-diff"`（文案 `plugins.update.ack`），**未勾选时 `PluginInstallDialog` 的确认按钮禁用**，勾选状态随 `plugins.install` 的 `acknowledgeDiff` 带上。
2. 新增的四个 i18n 键（**P1-3 不再重复添加**，两种语言同位置追加在 `plugins.*` 块末尾）：

   | key | zh-CN | en-US |
   |---|---|---|
   | `plugins.update.from` | 从 v{from} 更新到 v{to} | Updating from v{from} to v{to} |
   | `plugins.update.expanded` | 新版本新增了以下权限： | The new version asks for additional permissions: |
   | `plugins.update.ack` | 我已了解新增的权限 | I understand the new permissions |
   | `plugins.update.keepSecrets` | 敏感配置项留空表示保留已保存的值。 | Leave sensitive fields empty to keep the saved values. |

3. `apps/desktop/test/e2e/plugins.spec.ts`（P0a-3）：原「冲突阻塞」用例（同一夹具装两次）改成**真正的冲突**：先装插件 A（含技能 `dup-skill`），再检视另一个 id 不同但也含 `dup-skill` 的插件 B → `plugins-consent-blockers` 可见、`plugins-install-confirm` 禁用；另加用例「本地同 id 重装 = 更新」：改一个技能的内容后重新打包同 id 同版本 → 检视面板显示中性更新提示（无红色阻塞）、确认后技能内容变化、插件 id 不变。

## 5. 验收

- [ ] `refactor(mcpb)` 提交独立；`mcpb` 既有测试（`unit/mcpb.test.ts`、`integration/mcpb.test.ts`、`unit/mcpb-register.test.ts`）零改动全绿。
- [ ] 步骤 7 的联动已做，`node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/i18n` 通过；e2e：`pnpm build` 后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/plugins.spec.ts` 全绿。
- [ ] 步骤 1–6 的新测试全绿：`node scripts/run-tests.mjs run packages/core/test/unit/mcpb-replace.test.ts packages/core/test/unit/plugin-permissions.test.ts packages/core/test/unit/plugin-projector-update.test.ts packages/core/test/unit/plugin-projector-mcp.test.ts packages/core/test/unit/plugin-registry.test.ts packages/core/test/unit/plugin-store.test.ts packages/core/test/unit/plugins-migration.test.ts packages/core/test/integration/plugins-update.test.ts`。
- [ ] 不回归：`node scripts/run-tests.mjs run packages/core/test/integration/plugins.test.ts packages/core/test/integration/plugins-marketplace.test.ts packages/core/test/unit/plugin-projectors-coverage.test.ts packages/core/test/unit/public-skills-migration.test.ts`。
- [ ] `plugin-projectors-coverage.test.ts` 额外断言：每个投影器都实现了 `update`（漏接新贡献类别的更新会失败）。
- [ ] `pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/core typecheck && pnpm --filter @kepcup/desktop typecheck` 通过。
- [ ] 在实施记录里写明已知限制：① 更新失败后被断开的连接无法恢复；② 更新时非敏感 `user_config` 需重新确认（旧值不留存）；③ 同版本本地重装的 `.prev` 机制。
- [ ] 本阶段**不跑**全量 `pnpm test`。

## 6. 实施记录

（执行智能体在最后一个提交里填写：做了什么 / 偏差与 DEV 编号 / 迁移实际编号 / `projectorWrap` 测试缝的取舍 / `hasValue` 依赖的 `SecretsService` 方法名 / 遗留问题。）

### 实施记录（2026-10-27）

**做了什么**（7 个提交）：

| 提交 | 内容 |
|---|---|
| `ddad7c1e` | 步骤 1：迁移 `0055_plugin_update_journal.sql`（`update_to` / `update_snapshot` 两列）+ `PluginRow` 扩展与 `listUpdating()` + `plugins-migration` / `plugin-store` 测试 + `docs/dev/03-data-model.md` 迁移表行与 `plugins` 小节两列说明 |
| `1a930a08` | 步骤 2（独立 `refactor(mcpb)`）：`McpbRegistration.replaceExisting`（要求现有 server 为同插件 plugin 来源，保留 `enabled` / `toolPolicies`、强制 `autoApprove: false`、原位替换保序）+ 敏感 `user_config` 留空保留已存 secret（内存占位 `'\u0000kept'`，绝不写入 secrets）+ `#releasePackage` 公开为 `releaseIfUnused` + 替换审计 `replaced: true`；新测试 `mcpb-replace.test.ts`（13 例），既有 mcpb 三测试文件零改动 |
| `a6a7eaa4` | 步骤 3–6：`plugins/permissions.ts`（令牌推导 / `diffPermissions` / `describePermission`）；投影器接口加 `update` / `beginUpdate` / `commitUpdate` / `rollbackUpdate` 与 `ctx.owned`，四个投影器的更新实现（技能内容哈希原地换、MCP server id 稳定 + 快照回滚、连接器绑定变化断连 + slug 不得变、邮件只同步账本）；`PluginRegistry` 的 `#performUpdate` 八步事务（日志 → `.prev` 换入 → 正序投影 → 单条翻转提交 → `commitUpdate` → 删旧目录；失败逆序补偿 + 还原 + 审计 `failed`）、`inspect` 的 `existing` / `update` / `owned` 排除、市场更新入口 `plugins.update` RPC、崩溃恢复先回滚 `listUpdating()`、孤儿目录清理、`projectorWrap` 测试缝；集成 `plugins-update.test.ts`（12 例） |
| （工作树收尾） | 步骤 7：`PluginConsentPanel` 的中性更新行 / 权限差异列表 / `plugins-install-ack-diff` 勾选 / `keepSecrets` 提示（`existing` 红块仅在 `update === null` 时显示）；`PluginInstallDialog` 的 `ackDiff` 状态与 `acknowledgeDiff` 回传；`canInstallPlugin` 加 `ackDiff` 参数；i18n 四键 × 两语言；`plugins.spec.ts` 原「同 id 冲突阻塞」改为真冲突（不同 id 抢同名技能）+ 新增「本地同 id 重装 = 更新」用例（9/9 全绿） |

**偏差与 DEV 编号**：无新增 DEV（当前最大 DEV-055）。任务书与现实无冲突。

**迁移实际编号**：`0055_plugin_update_journal.sql`（与任务书一致，开工核对无占用）。

**`projectorWrap` 测试缝取舍**：按任务书推荐实现——`PluginRegistryDeps.projectorWrap?: (p) => p`，仅在 `__KEPCUP_TEST_HOOKS__ === true` 时生效（`registry.ts` 与 `start.ts` 双重门控），用于 `plugins-update.test.ts` 的「第二个 server 更新失败 → 回滚」用例。

**`hasValue` 依赖的 `SecretsService` 方法名**：`hasValue(name: string): boolean`（`packages/core/src/domain/secrets.ts:130`，既有方法，非新增）；`McpbInstallerDeps.secrets.hasValue?` 缺省视为不存在，`start.ts` 显式转发（原型方法需绑定）。

**验收证据**（全部真实执行）：
- 核心 8 文件（mcpb-replace / plugin-permissions / plugin-projector-update / plugin-projector-mcp / plugin-registry / plugin-store / plugins-migration / 集成 plugins-update）→ **81 例全绿**；不回归 7 文件（plugins / plugins-marketplace / coverage / public-skills-migration / mcpb 三件套）→ **69 例全绿**；mcpb 既有测试零改动（`git diff` 对照基点为空）。
- `plugin-projectors-coverage.test.ts` 已加「每个投影器都实现 `update`」断言。
- `pnpm --filter @kepcup/shared run build` ✓；`@kepcup/core typecheck` ✓；`@kepcup/desktop typecheck`（tsc + svelte-check）0 errors ✓。
- i18n / plugins 定向单测 19 例全绿；`plugins.spec.ts` e2e **9/9 全绿**（`pnpm build` 后）。
- 本阶段未跑全量 `pnpm test`（P1-3 收口跑）。
- 阶段文件 prettier / eslint 干净。

**已知限制**（任务书要求写明）：① 更新失败时被断开的连接无法恢复（`AppDisconnector` 断连不可逆）；② 更新时非敏感 `user_config` 需重新确认（旧值不留存，仅敏感值留空保留 secret）；③ 同版本本地重装经 `.prev` 目录机制（`pluginPrevDirOf` 守卫）。

**遗留问题**：
- 执行过程说明：本阶段开发智能体在步骤 7 中途因配额中断，剩余收尾（e2e 断言补完、格式、实施记录）由调度方完成；步骤 1–6 的三个提交在中断前已落地。
- P1-3 将复用本阶段的更新块（`plugins-install-update-block` 整理、市场模式对话框、`updateAll`）；`plugins.update.from` 等四键已就位，P1-3 勿重复添加。
- 更新流的「条目级版本不降」校验（P1-1 遗留）已随本阶段市场更新入口实现（`compareConnectorVersions(新, 旧) > 0` 才允许）。

### 审查修正（2026-10-27，独立审查智能体）

审查（`git diff c38c3308..93d3e340`）确认八步事务顺序、`.prev` 换入 / 换回、单条翻转提交、逆序补偿、`McpbInstaller` 替换语义、权限令牌表与「零写入」拒绝均符合任务书；以下问题已修正（各自独立提交，均带回归测试）：

1. **孤儿清扫会误删版本以 `.prev` 结尾的真实插件**（registry `#sweepOrphanDirs`）：`pluginVersionSchema` 允许 `1.0.0-a.prev` 这类 prerelease，旧逻辑先做 `.prev` 剥离匹配、真实槽位目录会被当垃圾删除。改为先查 `occupied`（有行的槽位一律不动），`.prev` 启发式只对无行目录生效。测试：`plugin-registry.test.ts` 孤儿清扫用例补「`.prev` 后缀真实槽位保留」。
2. **技能更新按「贡献目录」而非「技能名」比对增删**（skills `update`）：新版本只挪了技能目录时会把刚装好的技能又删掉。改为两侧解析 SKILL.md name、按名字比对。测试：`plugin-projector-update.test.ts` 新增「目录改名不丢技能 / name 改变清理旧名」。
3. **禁用插件的更新会把投影重新公开**（registry `#performUpdate`）：skills `update` 无条件 `installPublic`、新增 http server 落 `enabled: true`，违反设计 51 §7「enabled=0 → 投影层整体摘除」。提交后对 `enabled === false` 的行重跑一遍禁用回退（`#convergeDisabled`，尽力而为）。测试：`plugin-registry.test.ts` 新增「禁用插件更新收敛回禁用」。
4. **同槽（同名同版本）不同内容的 mcpb 更新破坏回滚**（`McpbInstaller` + mcp 投影器）：`#extract` 会先 `rm` 旧解包树再换入新树，任务书「不释放旧包树（回滚可能还要用）」在这条路径上不成立——更新中途失败 / 崩溃后，回滚恢复的旧 server 仍指向该槽位、实际运行的是新代码。现在替换前把完整的旧树（marker 校验通过）停放到槽位旁 `{slot}.rb-{hex}`；`rollbackUpdate` 经 `restoreRollbackBackup`（marker 驱动、崩溃恢复同样生效）把旧内容换回原槽位，`commitUpdate` 经 `discardRollbackBackups` 清掉备份。测试：`mcpb-replace.test.ts` 3 例 + `plugin-projector-mcp.test.ts` 2 例（回滚后 `verify(旧包).ok`）。已知残留：提交后、`commitUpdate` 执行前崩溃会留下一个无引用的 `.rb-` 备份目录（纯垃圾，无害）。
5. **更新时必填敏感留空被界面判为缺项**（renderer `missingPluginConfig` → `missingRequired` 加 `keepSensitiveEmpty`）：与同屏的 `plugins.update.keepSecrets` 提示自相矛盾，「留空保留 secret」流程被禁用的确认按钮堵死。更新检视（`info.update !== null`）跳过必填敏感字段；确实无已存值时由 core 报 `INVALID_INPUT`。测试：`plugin-install.test.ts` 2 例（敏感留空仅在更新时不算缺项；ack 勾选门控）。
6. **实施记录证据修正**：上表「阶段文件 prettier / eslint 干净」抽查不实——`registry.ts` / `projectors/mcp.ts` / `plugin-registry.test.ts` / `plugin-projector-update.test.ts` 有 prettier 漂移、4 处 eslint 未用变量（`#sweepOrphanDirs` 的死变量 `updating` 等）。已全部清理；修正后上述文件 prettier / eslint 干净。

以上均为实现层修正，不改变任何任务书契约与命名，无需新增 DEVIATIONS。修正后重跑：核心 8 文件 88 例、不回归 7 文件 69 例、desktop 单测、`shared build` + core/desktop typecheck 全绿。
