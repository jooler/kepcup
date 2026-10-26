# P1-1 · 市场核心：签名索引共享模块、同步与下载、市场来源安装、撤销、自托管公钥、签名脚本

> 状态：**待实施**。依赖：P0a-2（P0b 不是前置）。分支：`feat/plugins/p1-1-marketplace-core`。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §6.1（索引 / 签名 / 托管 / endpoint）、§6.3（Bot 与更新的前半）、§8（设置条目）、§10。
> 现有机制参照：`docs/design/29-connected-apps.md` §11.4 / §15.2、`infra/cloudflare/directory/README.md`、`packages/core/src/apps/directory-sync.ts`、`scripts/sign-connector-index.mjs`。

## 1. 目标

交付后：core 能每日拉取并验签**插件市场索引**（`dl.kepcup.com/plugins/v1/index.json` + 分离签名），防回滚、落缓存、离线回落；能按索引条目下载 `.kepcup`（流式 + sha256 + 体积上限）；`plugins.inspect` / `plugins.install` 支持 `{ kind: 'marketplace', id, version? }` 来源；撤销名单生效（`warn` 标记 / `disable` 自动停用）；用户可在设置里换市场地址并登记自己的公钥（条目封顶 `community`）；CI 签名脚本与基础设施交接说明就位。**本阶段没有新界面**（P1-3），**没有更新流**（P1-2；已装插件的 `updateAvailable` 在本阶段只做计算与展示字段）。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| `infra/signed-index.ts` 抽取（`DirectorySync` 变薄，**行为不变**）——**独立提交** | 更新执行（P1-2） |
| shared：`plugin-index.ts`、设置键、设置目录条目与分组、`PluginSource` 的 `marketplace`、市场 RPC schema | 市场页 / 更新徽标 / Bot 工具 / 邮件模板（P1-3） |
| `MarketplaceSync` / `MarketplaceService`（endpoint + 公钥解析、同步、下载、缓存） | 详情页 README 拉取（本期不做，见 §6 DEV 提示） |
| 注册表接入市场来源、撤销名单、`updateAvailable` 计算 | |
| `plugins.marketplace.list / refresh`、`start.ts` 接线与测试钩子 | |
| `scripts/sign-plugin-index.mjs`、`infra/cloudflare/plugins/README.md`、`_headers` | 真实密钥 / R2 / DNS / CI（**用户待办**，见步骤 7） |

## 3. 开工前核对

```bash
git status --short && git log --oneline -5
ls packages/core/migrations/main | tail -3
rg -n "verifySignedIndex|sha256Hex|DirectorySync\b" packages scripts apps --glob '!**/dist/**' --glob '!node_modules' -l
rg -n "directorySync\?:|directoryTest|CONNECTOR_INDEX_PUBLIC_KEYS" packages/core/src/start.ts
rg -n "PENDING_DESKTOP_ANCHORS" packages/shared/src/settings-catalog/coverage.ts | head -3
sed -n 1100,1135p packages/shared/src/settings-catalog/items.ts    # remote.relay：本阶段两个设置条目的写法模板
```

必读：`packages/core/src/apps/directory-sync.ts` 全文（**尤其 `#loadCache` / `#pull` 的防回滚与缓存逻辑**）、`packages/shared/src/domain/directory-index.ts`、`packages/core/test/unit/directory-sync.test.ts` 与 `packages/core/test/support/directory-fixture.ts`（测试夹具如何用**真实签名脚本**造索引）、`scripts/sign-connector-index.mjs`、`infra/cloudflare/directory/README.md`、`packages/core/src/apps/auth/safe-fetch.ts`（`createSafeFetch`）、`packages/shared/src/settings-catalog/{items.ts,define.ts,types.ts,query.ts}`、`packages/shared/src/domain/types.ts`（`settingsSchema` l.754–866 与 `remoteRelayUrl` 一带）、`packages/shared/src/rpc/methods.ts`（`settingsUpdateInputSchema` l.355–426）。

## 4. 步骤

### 步骤 1：抽出 `SignedIndexSync`（纯重构，独立提交序列；`directory-sync` 测试零改动）

**目标**：把 `DirectorySync` 里**与连接器无关**的部分（验签、棘轮、缓存、定时、状态机）挪进 `packages/core/src/infra/signed-index.ts`，`DirectorySync` 变成它的薄封装；公开 API 与行为**一字不变**。

1. `infra/signed-index.ts` 导出：
   - `sha256Hex`、`writeAtomic`、`ED25519_SPKI_PREFIX`、`publicKeyObject`、`shortId`、`FUTURE_SKEW_MS`、`FETCH_TIMEOUT_MS`（原样搬）；
   - `IndexRejectReason`（原样）与泛化的 `verifySignedIndex<T extends { generatedAt: number; keyId: string }>(bytes, signatureText, keys, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, limits: { maxBytes: number; maxSigBytes: number })`，返回 `{ ok: true; index: T; keyId; sha256 } | { ok: false; reason; message }`（函数体 = 原 `verifySignedIndex`，把写死的 `connectorIndexSchema` / `CONNECTOR_INDEX_MAX_BYTES` / `CONNECTOR_INDEX_SIG_MAX_BYTES` 换成参数）；
   - 泛型类 `SignedIndexSync<T extends { generatedAt: number; keyId: string }>`：构造参数 `{ dir; keys; fetch; clock; logger; baseUrl; indexFile; sigFile; schema; limits; enabled?(): boolean; intervalMs?; retryMs?; initialDelayMs?; random?; intervals: { sync; retry; jitterRatio; initialDelay: {min; max}; staleAfter } }`；方法 `index(): T | null`（当前已采纳的已验签索引）、`revision(): number`、`syncState(): { state; lastSync; generatedAt; keyId; error; disabledReason }`、`sync()`、`start()`、`stop()`——**内部就是原 `DirectorySync` 的 `#loadCache` / `#pull` / `#persist` / `#saveState` / `#schedule` / `#fetchBytes` / `DirectoryRejection`**，只是不再认识 `entries`。
2. `apps/directory-sync.ts`：保留导出 `DirectorySync`、`verifySignedIndex`（**签名与旧版相同**：`(bytes, signatureText, keys)`，内部调用泛化版并传入 `connectorIndexSchema` 与 `CONNECTOR_INDEX_*` 上限）、`sha256Hex`（re-export）、`DirectoryFetch`、`IndexRejectReason`、`DirectorySyncDeps`；`DirectorySync` 内部持有一个 `SignedIndexSync<ConnectorIndex>`，`entries()` / `revision()` / `status()` 的映射逻辑（含「设置开关翻转算一次变化」「`remoteEntries` 计数」）留在这里。
3. **验证（全部原样通过，一行测试都不改）**：`node scripts/run-tests.mjs run packages/core/test/unit/directory-sync.test.ts packages/core/test/unit/directory-merge.test.ts packages/core/test/integration/catalog-connect.test.ts packages/core/test/unit/connector-catalog.test.ts`；`pnpm --filter @kepcup/core typecheck`。
4. **为 `SignedIndexSync` 补直接测试**（新文件 `packages/core/test/unit/signed-index.test.ts`，用一个最小自定义 schema `z.object({ generatedAt: …, keyId: …, items: z.array(z.string()) })` 与内存 fetch）：验签通过 / 坏签名 / 未知 key / 吊销 key / key 过期；棘轮（更旧拒绝、同字节视为未变、同时间不同字节拒绝、超前一天以上拒绝）；缓存装载时重新验签；304 处理；失败后继续用上一份已验签索引；`enabled()=false` 不联网；`stop()` 后不再调度。
5. 提交信息：`refactor(core): extract SignedIndexSync from DirectorySync`（单独提交，不含其它改动）。

### 步骤 2：shared 契约

**2.1 `packages/shared/src/domain/plugin-index.ts`**（并从 `index.ts` 导出）：

```ts
export const PLUGIN_INDEX_BASE_URL = 'https://dl.kepcup.com/plugins/v1';
export const PLUGIN_INDEX_FILE = 'index.json';
export const PLUGIN_INDEX_SIG_FILE = 'index.json.sig';
export const PLUGIN_INDEX_MAX_BYTES = 8 * 1024 * 1024;
export const PLUGIN_INDEX_SIG_MAX_BYTES = 1024;
export const PLUGIN_INDEX_MAX_ENTRIES = 5000;
export const PLUGIN_INDEX_MAX_REVOKED = 1000;
export const PLUGIN_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;          // = ZIP_MAX_FILE_BYTES
/** 生产公钥列表（形态同 CONNECTOR_INDEX_PUBLIC_KEYS）。**空 = 市场关闭**；用户生成密钥并登记前保持为空。 */
export const PLUGIN_INDEX_PUBLIC_KEYS: readonly ConnectorIndexPublicKey[] = [];
```

- 复用 `directory-index.ts` 的 `connectorIndexKeyIdSchema`、`connectorIndexPublicKeySchema`、`ConnectorIndexPublicKey`、`selectIndexKey`（直接 import）；把该文件里**未导出**的 `generatedAtSchema` 加上 `export`（唯一的既有文件改动）。
- 同步节奏常量**直接复用** `CONNECTOR_INDEX_SYNC_INTERVAL_MS` / `_RETRY_MS` / `_JITTER_RATIO` / `_INITIAL_DELAY_MS` / `_STALE_AFTER_MS`（节奏相同，不再造一套）。
- schema：

  ```ts
  pluginIndexEntrySchema = z.object({
    id: pluginIdSchema, version: pluginVersionSchema,
    tier: z.enum(['verified', 'community']),
    sha256: sha256Hex（64 位小写十六进制）, size: z.number().int().min(1).max(PLUGIN_PACKAGE_MAX_BYTES),
    downloadUrl: z.string().url().max(500).refine(https),
    engines: z.object({ kepcup: z.string().min(1).max(100) }).optional(),
    platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).min(1).optional(),
    categories: z.array(pluginContributionKindSchema).max(4),             // 签名时由贡献推导写入
    summary: z.object({ name: z.string().min(1).max(100), description: z.string().max(500).default(''),
                        author: z.string().max(100).nullable().default(null) }),
    updatedAt: z.number().int().min(0),
  });
  pluginIndexRevokedSchema = z.object({ id: pluginIdSchema, version: pluginVersionSchema.optional(),
    action: z.enum(['warn', 'disable']).default('warn'), reason: z.string().max(200).default('') });
  pluginIndexSchema = z.object({
    version: z.literal(1), generatedAt: generatedAtSchema, keyId: connectorIndexKeyIdSchema,
    entries: z.array(z.unknown()).max(PLUGIN_INDEX_MAX_ENTRIES),          // 逐条校验在 core，坏条目单独跳过
    revoked: z.array(pluginIndexRevokedSchema).max(PLUGIN_INDEX_MAX_REVOKED).default([]),
  });
  ```

  （设计 51 §6.1 的 `manifestDigest` 与 `summary.icon` 本期**不进 schema**：详情页 README 拉取与远程图标不做，见 §6。）

**2.2 设置键与目录**（先读 `remote.relay` 条目与 `remoteRelayUrl` 的 schema 写法，照抄）：

- `packages/shared/src/domain/types.ts` 的 `settingsSchema`（l.754–866）加三个**顶层**键（带 `.default`，已有数据自动回填，无需迁移）：
  - `pluginAutoCheckUpdates: z.boolean().default(true)`；
  - `pluginMarketplaceUrl: pluginMarketplaceUrlSchema.default('')`，其中 `pluginMarketplaceUrlSchema` = `z.union([z.literal(''), z.string().max(500).refine(isHttpsUrlWithoutCredentials)])`（只许 https、无用户信息；规则写成 shared 里的纯函数）；
  - `pluginMarketplacePublicKey: z.union([z.literal(''), z.string().length(44).regex(/^[A-Za-z0-9+/]+={0,2}$/)]).default('')`（Ed25519 原始 32 字节公钥的 base64）。
- `packages/shared/src/rpc/methods.ts` 的 `settingsUpdateInputSchema`（l.355–426）加这三个键的 `.optional()` 版本（照 l.413–418 的 `remoteEnabled` / `remoteRelayUrl` 先例；漏了会被静默剥掉）。
- 设置目录：`settings-catalog/types.ts` 的 `settingGroupSchema` 加 `'plugins'`；`settings-catalog/query.ts` 的 `SETTING_GROUP_TITLES`（穷举 Record，漏写编译失败）加 `plugins: '插件'`；`items.ts` 的 `SETTING_ITEMS` **末尾**追加两条（**逐字段照 `remote.relay` 写**，`item({ id, group, title, summary, keywords, scope: 'global', fields, write, card, deepLink, store })`）：

  | id | group | fields | write | card | deepLink | store |
  |---|---|---|---|---|---|---|
  | `plugins.updates` | `plugins` | `field('enabled', '自动检查更新', 'toggle', { path: 'pluginAutoCheckUpdates' })` | `write('confirm')` | `'field-editor'` | `{ surface: 'extension-center', section: 'installed', anchor: 'plugins-updates' }` | `{ kind: 'settings', paths: ['pluginAutoCheckUpdates'], generic: true }` |
  | `plugins.marketplace` | `plugins` | `field('url', '市场地址', 'text', { path: 'pluginMarketplaceUrl', hint: '留空 = 官方市场；自建市场须 https' })`、`field('publicKey', '签名公钥（base64）', 'text', { path: 'pluginMarketplacePublicKey', hint: '自建市场用自己的密钥签名索引；留空 = 官方公钥。自建市场的插件最高按「社区」级对待' })` | `write('user-only')`（**不要**加 `widensPermission: true`——generic 条目的目录测试要求它为 false；`user-only` 本身已保证 Bot 不能写值） | `'field-editor'` | `{ surface: 'extension-center', section: 'installed', anchor: 'plugins-marketplace' }` | `{ kind: 'settings', paths: ['pluginMarketplaceUrl', 'pluginMarketplacePublicKey'], generic: true }` |

  `title` / `summary` / `keywords` 用中文，写法同相邻条目。
- **覆盖率与待补锚点**：这两个条目的深链锚点在 UI（P1-3）才会出现。照仓库既有做法，把 `'plugins-updates'`、`'plugins-marketplace'` 先登记进 `coverage.ts` 的 `PENDING_DESKTOP_ANCHORS`（P1-3 加 UI 锚点时必须同时从中删除，否则覆盖率测试报「待补锚点已存在」）；同时把 P0a-3 在 `EXCLUDED_SETTING_LOCATIONS` 里为 `installed` 页签加的排除项**删掉**（现在有条目深链到该页签了）。
- 测试同步：`packages/shared/test/unit/settings-catalog.test.ts` 的 generic 条目清单（l.398–408）末尾加 `'plugins.updates'`、`'plugins.marketplace'`（**顺序 = 登记顺序**）；user-only 清单（l.120–145）加 `'plugins.marketplace'`；其余硬编码计数 / 分组用例按失败提示修正。`packages/core/test/unit/settings-adapters-coverage.test.ts` **无需改**（generic 条目免适配器），跑一遍确认。

**2.3 `plugins.ts` 追加**：

- `pluginSourceSchema` 增第三个分支 `z.object({ kind: z.literal('marketplace'), id: pluginIdSchema, version: pluginVersionSchema.optional() })`；
- `pluginSummarySchema` 增 `revoked: z.enum(['warn', 'disable']).nullable().default(null)`（其余字段不动；`tier` 已够用，不要再加市场分级字段）；
- 市场视图：

  ```ts
  export const pluginMarketStatusSchema = z.object({
    state: z.enum(['disabled', 'ok', 'degraded', 'stale']),
    disabledReason: z.enum(['no_keys', 'no_custom_key']).nullable(),
    lastSync: z.number().nullable(), generatedAt: z.number().nullable(),
    error: z.string().nullable(),
    endpoint: z.enum(['official', 'custom']),
  });
  export const pluginMarketEntrySchema = z.object({
    id: pluginIdSchema, version: z.string(), tier: z.enum(['verified', 'community']),
    name: z.string(), description: z.string(), author: z.string().nullable(),
    categories: z.array(pluginContributionKindSchema), size: z.number().int(), updatedAt: z.number().int(),
    compatible: z.boolean(), incompatibleReason: z.string().nullable(),
    installed: z.object({ version: z.string(), updateAvailable: z.boolean() }).nullable(),
    revoked: z.enum(['warn', 'disable']).nullable(),
  });
  export const pluginsMarketplaceListOutputSchema = z.object({ status: pluginMarketStatusSchema, entries: z.array(pluginMarketEntrySchema) });
  export const pluginsMarketplaceRefreshOutputSchema = z.object({ status: pluginMarketStatusSchema });
  export const pluginsMarketplaceUpdatedPayloadSchema = z.object({ generatedAt: z.number().nullable() });
  ```

- `rpc/methods.ts`：`rpcMethodSchemas` 与 `APP_METHODS` 加 `plugins.marketplace.list`（入参 `voidInput`）、`plugins.marketplace.refresh`（入参 `voidInput`）；`rpc/events.ts` 加 `'plugins.marketplace.updated'`。
- `pnpm --filter @kepcup/shared run build`。**shared 测试**：`plugin-index.test.ts`（schema 合法 / 非法、坏条目不影响信封、`revoked` 默认值、`downloadUrl` 必须 https）、`plugins-contracts.test.ts` 补新方法 / 事件、`settings-merge-validate` 类用例补三个设置键（非法 URL / 非法公钥被拒）。

### 步骤 3：`MarketplaceSync` 与 `MarketplaceService`

**3.1 `packages/core/src/plugins/marketplace-sync.ts`**：

```ts
export interface MarketplaceSyncDeps {
  dir: string;                                   // 缓存目录：{cacheDir}/plugins-market/{official | custom-<url sha256 前 12>}
  baseUrl: string; keys: readonly ConnectorIndexPublicKey[];
  endpoint: 'official' | 'custom';               // custom → 条目 tier 一律封顶 community
  fetch: DirectoryFetch; downloadFetch?: DirectoryFetch;   // 下载用（体积上限更大）；缺省同 fetch 的工厂
  clock: Clock; logger; enabled?: () => boolean; intervalMs?; retryMs?; initialDelayMs?; random?;
}
export class MarketplaceSync {
  constructor(deps: MarketplaceSyncDeps);
  readonly endpoint: 'official' | 'custom'; readonly baseUrl: string;
  entries(): PluginIndexEntry[];                 // 逐条 pluginIndexEntrySchema.safeParse，坏条目 warn 跳过；custom 时 tier 改写为 'community'
  revoked(): PluginIndexRevoked[];
  revision(): number;
  /** 同 id 的候选里取最高 semver 且 engines / platforms 兼容的一条；给了 version 就精确匹配（不兼容也返回，由调用方报错）。 */
  find(id: string, options?: { version?: string; appVersion: string; platform: NodeJS.Platform }): PluginIndexEntry | null;
  revocationOf(id: string, version: string): 'warn' | 'disable' | null;   // 命中 revoked 项（version 缺省 = 该 id 全部版本）；disable 优先于 warn
  status(): PluginMarketStatus;
  sync(): Promise<PluginMarketStatus>; start(): void; stop(): void;
  download(entry: PluginIndexEntry): Promise<string>;    // 返回缓存里 .kepcup 的绝对路径
}
```

- 内部持有 `SignedIndexSync<PluginIndex>`（步骤 1），`schema = pluginIndexSchema`，`limits = { maxBytes: PLUGIN_INDEX_MAX_BYTES, maxSigBytes: PLUGIN_INDEX_SIG_MAX_BYTES }`，节奏常量用 `CONNECTOR_INDEX_*`。
- 条目版本比较用 `apps/directory-merge.ts` 导出的 `compareConnectorVersions`；兼容判断：`platforms` 含当前平台（缺省 = 全平台）、`engines.kepcup` 用 `satisfiesRange`（`appVersion` 核心为 `0.0.0` 时视为兼容）。
- **`download(entry)`**：① `isSafeDirectoryRemoteUrl(entry.downloadUrl)` 否则 `AppError('PLUGIN_INVALID', …)`；② 缓存命中：`{cacheDir}/plugins/{sha256}.kepcup` 存在 → 重新算 sha256 与 `entry.sha256` 比对，相符直接返回，不符删除重下；③ 否则 `fetch(entry.downloadUrl)`（`createSafeFetch({ maxBytes: PLUGIN_PACKAGE_MAX_BYTES, timeoutMs: 10 * 60_000 })`）：`Content-Length` 已知且大于 `entry.size` → 拒绝；**流式**写到 `.tmp-*`，边写边累计字节与 sha256，字节数超过 `entry.size` 立即中止并删临时文件；结束后字节数与 sha256 必须与 `entry` 完全相符，否则删除并抛 `PLUGIN_INVALID`；`rename` 到最终名（`mode 0o600`）。④ 并发下载同一 sha256 合并（`Map<sha256, Promise<string>>`）。
- **缓存清理**：`start()` 时异步删除 `{cacheDir}/plugins/` 下 mtime 超过 7 天的文件（失败只 warn）。

**3.2 `packages/core/src/plugins/marketplace-service.ts`（`MarketplaceService`）**：根据设置**解析出当前生效的 `MarketplaceSync`**，设置变化时切换。

```ts
export interface MarketplaceServiceDeps {
  settings: Pick<SettingsService, 'get'>;
  cacheDir: string; clock: Clock; logger: CoreLogger; events;
  official: { keys: readonly ConnectorIndexPublicKey[]; baseUrl: string };    // 默认 PLUGIN_INDEX_PUBLIC_KEYS / PLUGIN_INDEX_BASE_URL；测试可注入
  fetchFactory: (options: { maxBytes: number; timeoutMs?: number }) => DirectoryFetch;
  timing?: { intervalMs?; retryMs?; initialDelayMs? };
}
export class MarketplaceService {
  current(): MarketplaceSync | null;            // 公钥解析不出（官方列表空 / 自建未填公钥）→ null
  status(): PluginMarketStatus;                 // current() 为 null 时 state='disabled' + disabledReason
  /** id 字符串，写入 plugins.marketplace 列：官方 = PLUGIN_INDEX_BASE_URL；自建 = 规范化后的 URL。 */
  endpointId(): string;
  isOfficial(): boolean;
  start(): void; stop(): void;                  // 每次读 current() 前先 #resolve()：设置里的 url / publicKey 变了就停旧建新
}
```

解析规则（`#resolve()`）：读 `settings.pluginMarketplaceUrl` / `pluginMarketplacePublicKey`：
- url 为空 → 官方：`keys = official.keys`（空则市场关闭，`no_keys`），`endpoint:'official'`，缓存目录 `…/official`；
- url 非空 → 自建：**必须同时有公钥**（`keys = [{ keyId: 'custom', publicKey, validFrom: 0, revoked: false }]`），否则市场关闭（`no_custom_key`）；`endpoint:'custom'`；缓存目录 `…/custom-{sha256(url).slice(0,12)}`；
- 切换 = 停旧 `MarketplaceSync`、建新的（自带独立缓存与棘轮）→「清空市场视图重同步」；**不影响已装插件**；每次切换 `events.emit('plugins.marketplace.updated', { generatedAt: null })`；
- `pluginAutoCheckUpdates === false` 时：`enabled: () => settings.get().pluginAutoCheckUpdates` 传给 `MarketplaceSync`（只控制**定时**拉取；`sync()` 手动调用仍联网）——实现：`MarketplaceSync` 的 `enabled` 只影响 `start()` 的定时器，`sync()` 不看它（与 `DirectorySync` 不同，这里要写清楚并测试）。

**测试**：
- `marketplace-sync.test.ts`（新夹具见步骤 6）：条目逐条校验（坏条目跳过）；custom 封顶 community；`find` 选最高兼容版本 / 精确版本 / 不兼容；`revocationOf`（版本精确、整 id、disable 优先）；`download` 的各分支（sha256 不符、大小超过声明、`Content-Length` 超限、URL 不安全、缓存命中重新校验、并发合并、中断后无残留临时文件）；缓存清理。
- `marketplace-service.test.ts`：官方 / 官方公钥为空 → `no_keys` / 自建无公钥 → `no_custom_key` / 自建有公钥 → 使用其公钥验签（官方公钥签的索引被自建端点拒绝）/ 切换后旧实例停止且新缓存目录独立 / `isOfficial` / `endpointId`。

### 步骤 4：注册表接入市场来源、撤销与 `updateAvailable`

`PluginRegistryDeps` 加 `marketplace?: MarketplaceService`（P0a 测试不传即可）。

1. **`inspect` / `install` 的 `marketplace` 来源**（`source.kind === 'marketplace'`）：
   - 解析：`sync = marketplace.current()`，`null` → `AppError('PLUGIN_INVALID', '插件市场未启用')`；`entry = sync.find(id, { version, appVersion, platform })`，`null` → `NOT_FOUND`；`sync.revocationOf(entry.id, entry.version) !== null` → `AppError('PLUGIN_INVALID', '该插件版本已被撤销，不能安装')`；
   - `path = await sync.download(entry)`；`staged = await packager.stage({ kind: 'file', path })`；**校验包内清单与索引一致**：`manifest.id === entry.id && manifest.version === entry.version`，否则 `PLUGIN_INVALID('包内清单与索引不符')`；`staged.packageSha256 === entry.sha256`；
   - 身份：`origin: 'marketplace'`、`tier: entry.tier`（`MarketplaceSync` 已封顶）、`marketplace: marketplace.endpointId()`；
   - **其余管线（冲突 / 预检 / 同意 / 落盘 / 投影 / 账本 / 审计）与本地来源完全相同**；`via: 'marketplace'`（`audit` 的 `via` 与 `plugins.install` 入参里不新增字段，`via` 由 `source.kind` 推导；Bot 发起在 P1-3 传 `'bot'`）。
2. 同 id 已安装的处理：**P1-1 仍报 `PLUGIN_CONFLICT`（「请先卸载」）**，更新在 P1-2 打开。
3. `inspect` 输出 `tier` 对市场来源 = `entry.tier`；`origin` = `'marketplace'`。
4. **撤销名单生效**：`PluginRegistry.applyRevocations()`（互斥锁内）：对每个 `origin === 'marketplace'` 且 `marketplace === 当前 endpointId()` 的已装插件，`revocationOf(id, version)`：命中 `disable` 且 `enabled` → 走与 `setEnabled(id, false)` 相同的路径（审计 `plugin_set_enabled`，detail 加 `reason: 'revoked'`）；命中任意级别 → `list()` 的 `revoked` 字段给出对应值。调用时机：`MarketplaceSync` 每次**采纳新索引**之后（`MarketplaceService` 暴露 `onAdopted(handler)`，`start.ts` 里接 `registry.applyRevocations()`；`try/catch`）与 `registry.start()` 末尾。
5. **`list()`**：对 `origin === 'marketplace'` 且来源 = 当前市场的行：`latest = sync.find(id, { appVersion, platform })`，`compareConnectorVersions(latest.version, row.version) > 0` 且该版本未被撤销 → `updateAvailable: { version }`；其它 `null`；`revoked` 同上。
6. **`plugins.marketplace.list`**（`rpc/plugins-bindings.ts`）：`status = marketplace.status()`；`entries` = 每个 id 取 `find()` 的最高兼容版本（没有兼容版本的 id 取最高版本并 `compatible: false` + `incompatibleReason`），带 `installed`（来自 store，`updateAvailable` 同上）与 `revoked`；**若距上次成功同步超过 10 分钟，后台触发一次 `sync()`（不等待）**。**`plugins.marketplace.refresh`**：`await sync.sync()` 后返回 `{ status }`；市场未启用时直接返回其 `status`。
7. **事件**：`MarketplaceSync` 采纳新索引后 `events.emit('plugins.marketplace.updated', { generatedAt })`，并 `events.emit('plugins.changed', { ids: [] })`（让「已安装」页刷新 `updateAvailable`；`ids` 空 = 全量刷新，渲染端对 `ids` 不做过滤）。
8. **`start.ts` 接线**：
   - `CoreServicesOptions` 加测试钩子 `pluginMarketplace?: { keys?: ConnectorIndexPublicKey[]; baseUrl?: string; fetch?: DirectoryFetch; downloadFetch?: DirectoryFetch; intervalMs?: number; initialDelayMs?: number }`，**仅在 `__KEPCUP_TEST_HOOKS__ === true && env.NODE_ENV === 'test'` 时生效**（照 `directorySync` 选项 l.423 与 l.1250–1268 的写法）；
   - 构造 `MarketplaceService`（`cacheDir: paths.cacheDir`；`fetchFactory` 默认 `createSafeFetch({ maxBytes, timeoutMs })`，测试覆盖）→ 传给 `PluginRegistry`；`CoreServices.marketplace: MarketplaceService | null`（可选；只为 `close()` 与 RPC 绑定取用，也可只挂在 `plugins` 上，**由你选，写进实施记录**）；
   - `registry.start()` 之后 `marketplace.start()`；`services.close()` 里 `marketplace.stop()`（放在 `directorySync.stop()` 旁）。

**测试**（`packages/core/test/integration/plugins-marketplace.test.ts`，`createTestStack({ pluginMarketplace: { keys, fetch, downloadFetch, initialDelayMs: 0, intervalMs: 3_600_000 }, mcpbRuntimes })`）：
- 官方公钥空（不注入）→ `plugins.marketplace.list` 返回 `state: 'disabled'`、`no_keys`，`inspect({kind:'marketplace'})` 报 `PLUGIN_INVALID`；
- 注入测试密钥 + 内存索引（含一个 `.kepcup` 夹具，`downloadUrl: 'https://pkg.test/…'`，`fetch` 返回索引与签名、`downloadFetch` 返回包字节）：`refresh` 后 `list` 含条目；`inspect` → `install` 全流程 → `plugins.list` 里 `origin:'marketplace'`、`tier:'verified'`、`marketplace` 列 = 官方 base URL；
- 篡改：索引字节被改 / 签名错 / 包字节被改（sha256 不符）/ 包内清单 id 与索引不符 → 全部拒绝且无残留；
- 防回滚：用较旧 `generatedAt` 的合法索引再 `refresh` → 保持旧视图并 `status.error` 含 rollback；
- 撤销：`revoked: [{ id, action: 'disable' }]` 新索引采纳后，已装插件被自动停用（技能消失）、`list.revoked === 'disable'`、再装被拒；`warn` 只标记；
- `updateAvailable`：已装 1.0.0，索引有 1.1.0 → `list.updateAvailable.version === '1.1.0'`；索引的 1.1.0 被撤销 → 为 `null`；
- 自建：设 `pluginMarketplaceUrl` 无公钥 → `no_custom_key`；设公钥后用**自建密钥**签的索引可用且条目 `tier` 封顶 `community`、官方公钥签的被拒；切换回官方后旧实例停止；自建来源安装的插件 `marketplace` 列 = 自建 URL；
- 远程端点可以走 `marketplace` 来源（`withRemoteSource`）但不能走 `file`（P0a 已测，回归）；
- `pluginAutoCheckUpdates=false`：定时不拉取（`intervalMs` 很小时索引请求次数不增加），手动 `refresh` 仍拉取。

### 步骤 5：审计与摘要细节

- `plugin_install` 审计 `via` 取 `'marketplace'`；detail 里再加 `marketplace: endpointId`（不含密钥材料）。
- `PluginSummary.marketplace` 返回 `endpointId` 字符串（官方即 base URL）。

### 步骤 6：测试夹具

- `packages/core/test/support/plugin-market-fixture.ts`：**不要复用 `sign-connector-index.mjs` 的 `buildIndex`**（它是连接器信封）；而是：从 `directory-fixture.ts` 复用 `makeKey`（`TestKey` / 公钥条目）；用 `node:crypto` 的 `sign(null, bytes, privateKey)` 对**原始字节**签名；导出
  `buildPluginIndex({ key, generatedAt, entries, revoked? }): { indexBytes: Buffer; sig: string }`、`pluginIndexEntryFor(fixture: PluginFixture, extra: { tier?; downloadUrl?; categories?; summary? }): PluginIndexEntry`（`sha256`/`size` 取夹具）、`memoryMarketFetch(files: Map<string, Buffer>): DirectoryFetch`（按 URL 返回字节，404 否则；支持 `ETag`/304 的简化版即可）。
- 夹具索引 JSON 形状 = `pluginIndexSchema`（`generatedAt` 用毫秒整数）。

### 步骤 7：签名脚本与基础设施交接（**不动真实密钥 / 线上资源**）

1. `scripts/sign-plugin-index.mjs`：**读 `scripts/sign-connector-index.mjs`，复制其「密钥读取（环境变量 `KEPCUP_PLUGIN_SIGNING_KEY`，PKCS8 PEM 或 32 字节种子 base64）/ Ed25519 签名 / 自检 / `--verify` / `--generate-dev-key <目录>` / `--key-id` / `--generated-at`」部分**，把「条目构造」换成插件包：
   - 输入：`--packages <目录>`（放若干 `.kepcup`）与 `--catalog <json>`（策展文件：`[{ "file": "x.kepcup", "tier": "verified" | "community", "summary": { "name", "description", "author" } }]`）；`--revoked <json>`（可选，`pluginIndexRevokedSchema` 数组）；`--out <目录>`。
   - 对每个包：用 `@kepcup/package-guard`（`packages/package-guard/dist/index.js`，脚本里 `import`）读 `plugin.json`、算整包 sha256 与大小；`categories` 由 `contributions` 里非空的类别推导（`skills→skill`、`connectors→connector`、`mcp→mcp`、`mail→mail`）；`engines` / `platforms` 取自清单；`downloadUrl` = `{--download-base}/{sha256}.kepcup`（`--download-base` 必填，如 `https://pkg.kepcup.com`）；`updatedAt` = 打包文件 mtime 或 `--generated-at`。
   - 输出：`{out}/plugins/v1/index.json`、`index.json.sig`，以及 `{out}/packages/{sha256}.kepcup`（内容寻址拷贝）。
   - `--verify <dir>`：读回产物，用 `PLUGIN_INDEX_PUBLIC_KEYS`（经 `@kepcup/shared` dist）或 `--keys <文件>` 验签，并核对每个包的 sha256 / 大小。
   - 导出 `buildPluginIndexBytes(...)` / `verifyPluginIndexBytes(...)` 供测试（照 `sign-connector-index.mjs` 的导出方式）。**测试**：`packages/core/test/unit/sign-plugin-index.test.ts` 用 `--generate-dev-key` 的一次性密钥 + `buildPluginFixture` 的包跑一遍「签名 → `verifySignedIndex`（步骤 1 的泛化版）验过 → 篡改一字节验不过」；产物的 `entries` 逐条能过 `pluginIndexEntrySchema`。
2. `infra/cloudflare/directory/public/_headers`：追加 `/plugins/v1/index.json` 与 `/plugins/v1/index.json.sig` 两段（内容照 `/connectors/v1/…` 的两段：`Cache-Control: public, max-age=300` 等）；新建 `infra/cloudflare/directory/public/plugins/v1/.gitignore`（忽略 `index.json*`，同 `connectors/v1`）。`verify.mjs` 的 `--keys` 机制不动；在 `infra/cloudflare/directory/README.md` 加一节「插件市场索引（`/plugins/v1/`）」指向新脚本与 `infra/cloudflare/plugins/README.md`。
3. 新建 `infra/cloudflare/plugins/README.md`（**用户待办清单**，Agent 不代做）：
   - 生成真实签名密钥（Ed25519，`node scripts/sign-plugin-index.mjs --generate-dev-key` 仅用于测试；生产密钥与连接器目录**不共用**），私钥放 CI 机密 `KEPCUP_PLUGIN_SIGNING_KEY`，公钥以新 `keyId`（如 `kepcup-plugins-2026-1`）登记进 `PLUGIN_INDEX_PUBLIC_KEYS` 并发版（在此之前客户端不联网同步）；
   - 创建 R2 bucket（建议 `kepcup-plugins`）与自定义域（建议 `pkg.kepcup.com`），对象键 `{sha256}.kepcup`，`Cache-Control: public, max-age=31536000, immutable`；说明 **Workers Static Assets 单文件 25 MiB 上限装不下插件包，所以包走 R2，索引走现有 `dl.kepcup.com` 静态资源**；
   - CI 步骤序列（拉上一版索引 → 签名 → `--verify` → 上传包到 R2 → 部署索引）；
   - 首次部署后记入 `docs/dev/PROGRESS.md` 并走一遍「篡改 / 回滚被拒、离线回落」的端到端验收。
4. **本步骤不得**：生成或提交任何真实私钥、改 `PLUGIN_INDEX_PUBLIC_KEYS`（保持空）、联网部署。

## 5. 验收

- [ ] `refactor(core): extract SignedIndexSync…` 提交独立；`directory-sync.test.ts`、`directory-merge.test.ts`、`catalog-connect.test.ts`、`connector-catalog.test.ts` **零改动**全绿。
- [ ] 新测试全绿：`node scripts/run-tests.mjs run packages/core/test/unit/signed-index.test.ts packages/core/test/unit/marketplace-sync.test.ts packages/core/test/unit/marketplace-service.test.ts packages/core/test/unit/sign-plugin-index.test.ts packages/core/test/integration/plugins-marketplace.test.ts packages/shared/test/unit/plugin-index.test.ts packages/shared/test/unit/plugins-contracts.test.ts packages/shared/test/unit/settings-catalog.test.ts packages/core/test/unit/settings-adapters-coverage.test.ts packages/core/test/unit/settings-item-writes.test.ts apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`（后两个是 AGENTS.md 要求的设置相关定向测试）。
- [ ] P0a 的测试不回归：`node scripts/run-tests.mjs run packages/core/test/integration/plugins.test.ts packages/core/test/unit/plugin-registry.test.ts`。
- [ ] `pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/core typecheck && pnpm --filter @kepcup/desktop typecheck` 通过。
- [ ] 默认构建下（`PLUGIN_INDEX_PUBLIC_KEYS` 为空）**不发任何网络请求**（`MarketplaceService.start()` 不启动定时器；测试断言 `fetch` 零调用）。
- [ ] `rg -n "PLUGIN_INDEX_PUBLIC_KEYS" packages/shared/src` 的生产列表仍为空数组。
- [ ] 本阶段**不跑**全量 `pnpm test`（P1-3 收口时跑）。

## 6. 与设计 51 的有意差异（在 DEVIATIONS 各记一条，状态「已决定」，决定栏写「按任务书」）

1. 索引条目**不含 `manifestDigest` 与 `summary.icon`**，市场详情**不拉取 README**：设计 51 §6.1 / §9 的这两处依赖「按 digest 校验拉取富文本」，需要额外的 RPC、体积上限与 Markdown 渲染的 XSS 评审，推迟到有真实市场内容之后另立设计；本期详情页展示索引 `summary` + 同意面板。
2. 市场同步的定时开关 `pluginAutoCheckUpdates` 只控制**定时**拉取，手动 `refresh` / 打开市场页仍联网（设计 51 §6.3「只控制检查」的落地解释）。

## 7. 实施记录

（执行智能体在最后一个提交里填写：做了什么 / 偏差与 DEV 编号 / `CoreServices.marketplace` 的取舍 / 用户待办清单是否完整 / 遗留问题。）
