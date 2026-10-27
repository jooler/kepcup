# P0a-1 · 基础：`package-guard` 抽包、shared 契约、迁移、夹具、包暂存管线

> 状态：**待实施**。依赖：无（从当前集成分支拉出）。分支：`feat/plugins/p0a-1-foundation`。
> 先读 [README.md](README.md) §1、§4（固定契约）；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §3（包格式）、§5（安装管线 1–2 步与存储布局）、§7（数据模型）。

## 1. 目标

交付后：仓库里有一个无依赖的 zip 读取 / 路径守卫包；清单与 RPC 契约已在 shared 定义好；`plugins` / `plugin_items` 两张表和 `AppPaths.pluginsDir` 就位；测试夹具能构造合法与恶意的 `.kepcup`；core 里的 `PluginPackager` 能把一个 `.kepcup` 文件或一个开发目录**安全地暂存**到 `{home}/plugins/.staging/` 并给出清单与 sha256。**本阶段没有任何用户可见行为**——不注册 RPC、不接 `start.ts`。

## 2. 范围

| 包含 | 不包含（后续阶段） |
|---|---|
| `@kepcup/package-guard`（从 `apps/mcpb/zip.ts` 抽出，行为不变） | zip 写入（P2） |
| shared：清单 / RPC / 事件 / 错误码契约、`ConnectorOrigin` 加 `plugin`、`McpServerSource` 联合 | RPC 注册与 `start.ts` 接线（P0a-2） |
| 迁移 `0053`、`pluginsDir`、`docs/dev/03-data-model.md` | 投影器、`PluginRegistry`、守卫（P0a-2） |
| testkit `buildPluginFixture` / `buildPluginDir` | 界面（P0a-3） |
| core：`plugins/ids.ts`、`manifest-loader.ts`、`package.ts` | 内置插件、市场（P0b / P1） |

## 3. 开工前核对

```bash
git status --short && git log --oneline -3
ls packages/core/migrations/main | tail -3                      # 确认最新迁移（写作时 0052），本阶段用下一个编号；README §1.7
rg -n "run build|typecheck" package.json .github/workflows/ci.yml   # 现有构建顺序，步骤 1 要改
rg -n "'bundled'.*'directory'.*'local'|connectorOriginSchema" packages apps --glob '!**/dist/**' --glob '!node_modules'   # 步骤 2 要同步的断言
rg -n "mcpServerSourceSchema|McpServerSource" packages apps --glob '!**/dist/**' --glob '!node_modules' | head -30
```

必读：`packages/core/src/apps/mcpb/{zip,install,index,manifest}.ts`（尤其 `install.ts` 的 `#withSnapshot` 与 `#extract`，包暂存管线照它的写法）、`packages/testkit/src/mcpb-fixture.ts`、`packages/shared/src/domain/{types.ts(l.370–475),connector-catalog.ts,mcpb.ts,mail.ts}`、`packages/core/src/infra/paths.ts`、`packages/core/migrations/main/0050_project_board.sql`（DDL 风格）、`packages/core/test/unit/mcpb.test.ts`（恶意包的测试写法）。

## 4. 步骤

### 步骤 1：抽出 `@kepcup/package-guard`（纯重构，独立提交序列）

**目标**：把 `packages/core/src/apps/mcpb/zip.ts` 的 zip 读取与路径守卫挪到新工作区包，core 里的 `zip.ts` 变成薄适配层，**所有 `mcpb` 既有测试原样全绿、一行断言都不改**。

1. 新建 `packages/package-guard/`：
   - `package.json`（照 `@kepcup/shared` 的写法）：

     ```json
     {
       "name": "@kepcup/package-guard",
       "version": "0.0.0",
       "private": true,
       "type": "module",
       "exports": { ".": "./dist/index.js" },
       "main": "./dist/index.js",
       "types": "./dist/index.d.ts",
       "scripts": {
         "build": "tsc -p tsconfig.json",
         "typecheck": "tsc -p tsconfig.json --noEmit",
         "test": "node ../../scripts/run-tests.mjs run --project package-guard"
       }
     }
     ```

   - `tsconfig.json`：与 `packages/app-validator/tsconfig.json` 相同（`extends ../../tsconfig.base.json`，`outDir: dist`、`rootDir: src`、`types: ["node"]`、`include: ["src"]`）。
   - `src/zip.ts`：把 core 的 `zip.ts` **整份搬来**，只做下面这些改动：
     - 去掉 `import { AppError } from '@kepcup/shared'`；
     - 常量改名：`MCPB_MAX_ENTRIES→ZIP_MAX_ENTRIES`、`MCPB_MAX_ENTRY_BYTES→ZIP_MAX_ENTRY_BYTES`、`MCPB_MAX_UNPACKED_BYTES→ZIP_MAX_UNPACKED_BYTES`、`MCPB_MAX_FILE_BYTES→ZIP_MAX_FILE_BYTES`，**数值不变**；
     - 新增 `export type ZipErrorFactory = (message: string) => Error;` 与 `export interface ZipGuardOptions { error?: ZipErrorFactory; label?: string }`；默认 `error` 抛 `PackageGuardError`（`export class PackageGuardError extends Error {}`），默认 `label = 'zip'`；
     - 原来所有 `invalid(message)`（即 `new AppError('MCPB_INVALID', message)`）改为调用实例上的 `this.#error(message)`（静态方法里用参数）；原文案里写死的 `.mcpb` 改成模板 `${label}`：`'不是有效的 .mcpb（ZIP）文件'` → `` `不是有效的 ${label}（ZIP）文件` ``，`'不支持 ZIP64 的 .mcpb 包'` → `` `不支持 ZIP64 的 ${label} 包` ``，`'不支持加密的 .mcpb 包'` → `` `不支持加密的 ${label} 包` ``，`'不是有效的 .mcpb（ZIP）文件：找不到目录结尾'` 同理。其余中文文案**逐字不变**；
     - `ZipArchive.open(filePath: string, options: ZipGuardOptions = {})`：把 `error` 与 `label` 存进实例（`private constructor` 多接一个参数），`read()` / `close()` 等实例方法用实例上的；
     - `safeEntryPath(name: string, error: ZipErrorFactory = defaultError): string`；
     - 其余（`crc32`、`ZipEntry`、`WINDOWS_DEVICE_NAME`、读取逻辑）不动。
   - `src/index.ts`：`export * from './zip.js';`
2. 改 core：
   - `packages/core/package.json` 的 `dependencies` 加 `"@kepcup/package-guard": "workspace:*"`；根目录 `pnpm install`（会改 `pnpm-lock.yaml`，一并提交）。
   - 把 `packages/core/src/apps/mcpb/zip.ts` **改写成适配层**，保持**对外导出名完全不变**（`ZipArchive`、`safeEntryPath`、`crc32`、`ZipEntry`、`MCPB_MAX_ENTRIES`、`MCPB_MAX_ENTRY_BYTES`、`MCPB_MAX_UNPACKED_BYTES`、`MCPB_MAX_FILE_BYTES`）：

     ```ts
     import {
       ZIP_MAX_ENTRIES, ZIP_MAX_ENTRY_BYTES, ZIP_MAX_FILE_BYTES, ZIP_MAX_UNPACKED_BYTES,
       ZipArchive as GuardZipArchive, crc32, safeEntryPath as guardSafeEntryPath,
       type ZipEntry,
     } from '@kepcup/package-guard';
     import { AppError } from '@kepcup/shared';

     const invalid = (message: string): Error => new AppError('MCPB_INVALID', message);

     export { crc32, type ZipEntry };
     export const MCPB_MAX_ENTRIES = ZIP_MAX_ENTRIES;
     export const MCPB_MAX_ENTRY_BYTES = ZIP_MAX_ENTRY_BYTES;
     export const MCPB_MAX_UNPACKED_BYTES = ZIP_MAX_UNPACKED_BYTES;
     export const MCPB_MAX_FILE_BYTES = ZIP_MAX_FILE_BYTES;
     export const safeEntryPath = (name: string): string => guardSafeEntryPath(name, invalid);
     export class ZipArchive {
       static open(filePath: string): Promise<GuardZipArchive> {
         return GuardZipArchive.open(filePath, { error: invalid, label: '.mcpb' });
       }
     }
     ```

     > 若 `install.ts` / 测试把 `ZipArchive` 当类型用（`zip: ZipArchive`），把适配层改成 `export type ZipArchive = GuardZipArchive; export const ZipArchive = { open: ... }`，**以 `pnpm --filter @kepcup/core typecheck` 通过为准**；不要去改 `install.ts`。
3. 根目录接线：
   - `vitest.config.ts`：`resolve.alias` 加 `'@kepcup/package-guard': fileURLToPath(new URL('./packages/package-guard/src/index.ts', import.meta.url))`；`projects` 加 `{ test: { name: 'package-guard', include: ['packages/package-guard/test/**/*.test.ts'] } }`（放在 `app-validator` 项目旁）。
   - 根 `package.json` 的 `typecheck` 与 `dev` 脚本：在 `pnpm --filter @kepcup/shared run build &&` 之后、`pnpm --filter @kepcup/core run build` 之前插入 `pnpm --filter @kepcup/package-guard run build &&`。
   - 步骤 3 核对命令里 `.github/workflows/*.yml` 若有逐个包的 build 步骤（`ci.yml` 里只有 `@kepcup/shared`，`pnpm test` 走 vitest 别名，**不需要**改；`release.yml` 用 `pnpm -r build`，按依赖拓扑自动先建，**不需要**改）——核对后在实施记录写明结论。
4. **测试**：新增 `packages/package-guard/test/zip.test.ts`（项目 `package-guard`）。夹具用 `import { buildZip } from '../../testkit/src/mcpb-fixture.js'`（相对路径，同 `packages/app-validator/test/support.ts` 的做法）。覆盖：自定义 `error` 工厂被调用且文案含 `label`；`safeEntryPath` 的拒绝表（`../x`、`a/../../x`、`/abs`、`C:/x`、`a\\b`、含 NUL、含冒号、段以点或空格结尾、`CON` / `NUL.txt`、空段）与通过用例（`a/b/c`、目录名带尾斜杠被去掉）；`ZipArchive.open` 拒绝：非 zip（太短 / 找不到目录结尾）、ZIP64 标志、加密标志、中央目录里声明的条目大小或偏移越界（造法：先 `buildZip` 出一个合法包，再按 `packages/core/test/unit/mcpb.test.ts` 里的 `patchCentral` 直接改中央目录字段——该函数是那个测试文件的本地函数、没有导出，在新测试里**本地照写一份**，不要去导出它）、CRC 损坏（翻转数据字节 → `read()` 抛错）；符号链接条目 `isSymlink === true`；stored 与 deflate 两种条目读出的内容与写入一致。**不要**为了测「条目数超限」而造两万个条目的包。
5. **验证**（全部要过）：

   ```bash
   pnpm --filter @kepcup/package-guard run build
   pnpm --filter @kepcup/package-guard typecheck
   node scripts/run-tests.mjs run packages/package-guard
   node scripts/run-tests.mjs run packages/core/test/unit/mcpb.test.ts packages/core/test/integration/mcpb.test.ts   # 原样全绿
   pnpm --filter @kepcup/core typecheck
   pnpm --filter @kepcup/server run build   # headless 构建不受影响
   ```

   提交信息：`refactor(mcpb): extract zip reader into @kepcup/package-guard`（单独提交，不含任何其它改动）。

### 步骤 2：shared 契约

**文件**：新建 `packages/shared/src/domain/plugin-manifest.ts`、`packages/shared/src/domain/plugins.ts`；改 `domain/connector-catalog.ts`、`domain/types.ts`、`errors.ts`、`rpc/events.ts`、`rpc/methods.ts`、`index.ts`。

**2.1 `plugin-manifest.ts`**（纯 zod + 纯函数，不得 import Node API）：

```ts
import { z } from 'zod';
import { connectorNameSchema } from './connector-catalog.js';
import { mailModeSchema, mailSecureSchema } from './mail.js';

export const PLUGIN_FORMAT_VERSION = 1;
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;
export const PLUGIN_SOURCE_PREFIX = 'plugin://';
export const PLUGIN_RESERVED_NAMESPACES = ['com.kepcup', 'local.kepcup'] as const;
export const PLUGIN_MCP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PLUGIN_MAX_SKILLS = 50;
export const PLUGIN_MAX_CONNECTORS = 20;
export const PLUGIN_MAX_MCP = 10;
export const PLUGIN_MAX_MAIL = 10;

export const pluginIdSchema = connectorNameSchema;           // 规则同 Registry 命名空间
export const pluginVersionSchema = z.string().max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

/** `io.github.alice/doc-tools` → `io.github.alice`（小写）。 */
export function pluginNamespaceOf(id: string): string { return id.slice(0, id.indexOf('/')).toLowerCase(); }
export function isReservedPluginNamespace(namespace: string): boolean {
  return (PLUGIN_RESERVED_NAMESPACES as readonly string[]).includes(namespace.toLowerCase());
}

/** 包内相对 POSIX 路径：非空、≤300、无反斜杠 / 冒号 / 控制字符、不以 / 开头、段不为空 / . / ..。 */
export function isSafePluginRelPath(value: string): boolean { /* 按注释实现 */ }
export const pluginRelPathSchema = z.string().refine(isSafePluginRelPath, { message: 'unsafe relative path' });

/** 技能来源标记（写进 skill_library.source_url）：`plugin://{pluginId}/{skillName}`。渲染层也要用，所以放 shared。 */
export function pluginSkillSource(pluginId: string, skillName: string): string {
  return `${PLUGIN_SOURCE_PREFIX}${pluginId}/${skillName}`;
}
/** 去掉前缀后按 `/` 切，**恰好三段**（命名空间、名字、技能名）才返回，否则 null。 */
export function parsePluginSkillSource(sourceUrl: string): { pluginId: string; skillName: string } | null { /* 按注释实现 */ }
```

贡献 schema（全部 `z.strictObject`，未知字段一律拒绝）：

| schema | 字段 |
|---|---|
| `pluginSkillContributionSchema` | `dir: pluginRelPathSchema`；展示字段（仅内置插件使用，其他来源允许但忽略）：`displayName?`（≤100）、`summary?`（≤500）、`icon?`（≤64）、`section?`（≤64）、`tryIt?`（≤500）、`version?`（≤32）、`vendored?: boolean` |
| `pluginConnectorContributionSchema` | `file: pluginRelPathSchema`（必须以 `.json` 结尾，用 `.refine`） |
| `pluginMcpContributionSchema` | `z.discriminatedUnion('kind', [...])`：`mcpb`：`id: z.string().regex(PLUGIN_MCP_KEY_PATTERN)`、`name?`（≤100）、`description?`（≤200）、`file: pluginRelPathSchema`（以 `.mcpb` 结尾）；`http`：`id`、`name?`、`description?`、`url: z.string().url().max(2000)`（**https 校验不在 schema 里**，放 core，因为要复用 `isSafeDirectoryRemoteUrl`） |
| `pluginMailContributionSchema` | `id`（同 `PLUGIN_MCP_KEY_PATTERN`）、`label`（1–60）、`imap` / `smtp`：`{ host: 1–253, port: int 1–65535, secure: mailSecureSchema }`、`defaultMode: mailModeSchema.default('auto')`、`defaultPollSec: int 60–21600 default 300`、`minPollSec: int 60–21600 default 60`、`helpUrl?: https url ≤500` |

`pluginManifestSchema = z.strictObject({...}).superRefine(...)`：

```jsonc
{
  "format_version": 1,                       // z.literal(PLUGIN_FORMAT_VERSION)
  "id": "io.github.alice/doc-tools",         // pluginIdSchema
  "name": "文档工具集",                        // 1–100
  "version": "1.2.0",                         // pluginVersionSchema
  "description": "",                          // ≤1000，默认 ''
  "author": { "name": "Alice", "url": "https://…" },   // 可选；url 必须 https，≤500
  "homepage": "https://…",                    // 可选；https，≤500
  "engines": { "kepcup": ">=0.4.0" },         // 可选；字符串 1–100
  "platforms": ["darwin", "win32", "linux"],  // 可选；至少 1 项
  "contributions": { "skills": [], "connectors": [], "mcp": [], "mail": [] }   // 每类默认 []，各有 PLUGIN_MAX_* 上限
}
```

`superRefine` 必须校验：四类贡献合计 ≥ 1；技能 `dir` 互不相同；连接器 `file` 互不相同；mcp `id` 在 `mcpb` 与 `http` 两种 kind 之间**全局唯一**；mcpb `file` 互不相同；邮件 `id` 互不相同。错误信息用中文，`path` 指到出错项（如 `['contributions','mcp',1,'id']`）。**清单里不得出现 `tier` / `categories` / `permissions` 等字段**（`strictObject` 已保证）。

导出类型 `PluginManifest`（`z.infer`）及各贡献类型。**`format_version` 比 1 大的清单要先于 schema 被识别**（core 的 `parsePluginManifestText` 先单独读 `format_version`，大于 1 报 `PLUGIN_INCOMPATIBLE`「请升级 KepCup」；见步骤 6），所以 schema 里 `z.literal(1)` 只是兜底。

**2.2 `plugins.ts`**（RPC / 事件载荷）：

```ts
export const pluginOriginSchema = z.enum(['builtin', 'marketplace', 'local']);
export const pluginTierSchema = z.enum(['builtin', 'verified', 'community', 'developer']);
export const pluginStateSchema = z.enum(['installing', 'installed', 'uninstalling']);
export const pluginContributionKindSchema = z.enum(['skill', 'connector', 'mcp', 'mail']);
export const pluginItemKindSchema = z.enum(['skill', 'connector', 'mcp', 'mail', 'disabled_connection']);

export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4096) }),
]); // P1 再加 marketplace（加性变更）

/** 一条已登记的投影项（来自账本；missing = 内容在应用外被删，yielded = 连接器因冲突让位）。 */
export const pluginItemRefSchema = z.object({
  kind: pluginContributionKindSchema,
  ref: z.string(),
  missing: z.boolean().optional(),
  yielded: z.boolean().optional(),
});

export const pluginSummarySchema = z.object({
  id: pluginIdSchema, name: z.string(), version: z.string(), description: z.string(),
  author: z.string().nullable(),
  origin: pluginOriginSchema, tier: pluginTierSchema, state: pluginStateSchema,
  enabled: z.boolean(),
  dirPath: z.string().nullable(),            // 绝对路径；内置插件为 null
  marketplace: z.string().nullable(),
  installedAt: z.number().int().nullable(), updatedAt: z.number().int().nullable(),
  counts: z.object({ skills: z.number().int(), connectors: z.number().int(), mcp: z.number().int(), mail: z.number().int() }),
  items: z.array(pluginItemRefSchema),
  updateAvailable: z.object({ version: z.string() }).nullable(),   // P0a 恒 null
});

// ── 同意面板数据（plugins.inspect 的返回，渲染端「同意面板」与之一一对应）──
export const pluginConsentSkillSchema = z.object({ name: z.string(), description: z.string(), runtimeDeps: z.array(z.string()), compatible: z.boolean(), incompatibleReason: z.string().nullable() });
export const pluginConsentConnectorSchema = z.object({ slug: z.string(), name: z.string(), title: z.string(), hosts: z.array(z.string()), scopes: z.array(z.string()), authKind: z.string() });
export const pluginConsentMcpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcpb'), id: z.string(), displayName: z.string(),
    serverType: z.enum(['node', 'python', 'binary', 'uv']), launchCommand: z.string(),
    runtime: z.object({ kind: z.enum(['node', 'python', 'uv']), available: z.boolean() }).nullable(),
    mcpbSha256: z.string(), unpackedSize: z.number().int(),
    userConfigFields: z.array(mcpbUserConfigFieldSchema),
    compatible: z.boolean(), incompatibleReason: z.string().nullable() }),
  z.object({ kind: z.literal('http'), id: z.string(), displayName: z.string(), url: z.string(), host: z.string() }),
]);
export const pluginConsentMailSchema = z.object({ id: z.string(), label: z.string(), imapHost: z.string(), smtpHost: z.string() });
export const pluginConflictSchema = z.object({
  kind: z.enum(['plugin', 'skill', 'connector', 'mcpb', 'mail']),
  ref: z.string(),                 // 冲突项（技能名 / slug / name@version / 模板 id / 插件 id）
  withWhat: z.string(),            // 与谁冲突（人类可读，如「公共技能 docx（预置）」）
});
export const pluginInspectOutputSchema = z.object({
  id: pluginIdSchema, name: z.string(), version: z.string(), description: z.string(),
  author: z.string().nullable(), homepage: z.string().nullable(),
  origin: z.enum(['marketplace', 'local']), tier: z.enum(['verified', 'community', 'developer']),
  packageSha256: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.number().int().min(0),
  skills: z.array(pluginConsentSkillSchema), connectors: z.array(pluginConsentConnectorSchema),
  mcp: z.array(pluginConsentMcpSchema), mail: z.array(pluginConsentMailSchema),
  conflicts: z.array(pluginConflictSchema),
  existing: z.object({ version: z.string() }).nullable(),   // 同 id 已装（本地来源 = 走更新流）
  update: z.object({ from: z.string(), permissionsExpanded: z.boolean(), added: z.array(z.string()) }).nullable(), // P0a 恒 null
  installable: z.boolean(),
  blockers: z.array(z.string()),        // 不可安装的人话原因（冲突、不兼容、运行时缺失…）
});

export const pluginsListOutputSchema = z.object({ plugins: z.array(pluginSummarySchema) });
export const pluginsInspectInputSchema = z.object({ source: pluginSourceSchema });
export const pluginsInstallInputSchema = z.object({
  source: pluginSourceSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** 按 mcp 贡献 id → 该 MCPB 的 user_config 值。 */
  userConfig: z.record(z.string(), z.record(z.string(), mcpbUserConfigValueSchema)).default({}),
});
export const pluginsInstallOutputSchema = z.object({ plugin: pluginSummarySchema });
export const pluginsSetEnabledInputSchema = z.object({ id: pluginIdSchema, enabled: z.boolean() });
export const pluginsSetEnabledOutputSchema = z.object({ plugin: pluginSummarySchema });
export const pluginsUninstallInputSchema = z.object({ id: pluginIdSchema });
export const pluginsChangedPayloadSchema = z.object({ ids: z.array(pluginIdSchema).max(200) });
```

`mcpbUserConfigFieldSchema` / `mcpbUserConfigValueSchema` 从 `./mcpb.js` 引入。导出对应 `type`。

**2.3 既有契约改动**：

- `connector-catalog.ts:54`：`connectorOriginSchema = z.enum(['bundled', 'directory', 'local', 'plugin'])`。步骤 3 核对命令找出的断言了「恰好三个值」的测试，同步改。
- `types.ts:378` 的 `mcpServerSourceSchema` 改为联合（**注意不要 import `plugin-manifest.ts`**，会和 `connector-catalog.ts` 形成循环引用，用本地 `z.string()` 约束）：

  ```ts
  const mcpbPackageRefSchema = z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  });
  export const mcpServerSourceSchema = z.discriminatedUnion('kind', [
    mcpbPackageRefSchema.extend({ kind: z.literal('mcpb') }),
    z.object({
      kind: z.literal('plugin'),
      pluginId: z.string().min(3).max(200),
      version: z.string().min(1).max(64),
      key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
      mcpb: mcpbPackageRefSchema.optional(),
    }),
  ]);
  ```

  `McpServer.source` 的 `.optional().catch(undefined)` **保留**。改完后 `rg -n "source\?\.kind|source\.kind" packages apps` 的每一处都要核对：读 `kind === 'mcpb'` 时 TypeScript 现在会收窄成 mcpb 分支，原有逻辑仍成立；`settings/adapters.ts:2069 / 2092`（按 `source.kind` 数 MCPB 与非 MCPB 服务器）**语义不变，不要动**——但要确认「非 MCPB」那一行把 plugin 来源的 server 也算进去是否符合其用途（它是设置卡里的计数文案），在实施记录写下结论。
- `errors.ts`：在 `'BOARD_LOCKED'`（`ERROR_CODES` 最后一项）之后、`] as const` 之前追加四个码，附一行注释「插件系统（D104）」。
- `rpc/events.ts`：从 `./../domain/plugins.js` 引 `pluginsChangedPayloadSchema`，在 `rpcEventSchemas`（l.401 起）里加 `'plugins.changed': pluginsChangedPayloadSchema`（注释写明用途）。
- `rpc/methods.ts`：import 新 schema；`rpcMethodSchemas` 加 `plugins.list` / `plugins.inspect` / `plugins.install` / `plugins.setEnabled` / `plugins.uninstall`（`list` 入参是 `voidInput`，`uninstall` 出参是 `okOutput`，其余见 2.2）；`APP_METHODS` 同步加五个字符串。
- `index.ts`：`export * from './domain/plugin-manifest.js'; export * from './domain/plugins.js';`

**2.4 测试**（项目 `shared`）：

- `packages/shared/test/unit/plugin-manifest.test.ts`：合法最小清单（一个技能）通过；`strict`：多出 `tier` / `categories` 字段被拒；`format_version: 2` 被拒；贡献合计为 0 被拒；mcp `id` 跨 kind 重复被拒；技能 `dir` 重复被拒；`pluginRelPathSchema` 的拒绝表（`..`、绝对路径、反斜杠、冒号、空段、尾斜杠、NUL、超长）；`http` 贡献 url 非 URL 被拒；`mail` 默认值（`defaultMode: 'auto'`、`defaultPollSec: 300`、`minPollSec: 60`）；`isReservedPluginNamespace`（大小写不敏感）；`pluginNamespaceOf`。
- `packages/shared/test/unit/plugins-contracts.test.ts`：五个 `plugins.*` 方法都在 `APP_RPC_METHODS`；`plugins.changed` 在 `RPC_EVENT_NAMES`；四个错误码在 `ERROR_CODES`；`connectorOriginSchema.options` 含 `plugin`；`mcpServerSchema` 解析带 `mcpb` 来源与 `plugin` 来源的 server 都保留 `source`；畸形 `source`（`kind:'plugin'` 缺 `key`）被丢弃为 `undefined` 而整条 server 仍有效；`pluginInspectOutputSchema` / `pluginSummarySchema` 往返；`pluginsInstallInputSchema` 缺省 `userConfig` 为 `{}`。
- 受影响的既有测试（步骤 3 核对命令列出的）原样通过或按「值域增加」最小修改。

**2.5 构建**：`pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck && node scripts/run-tests.mjs run packages/shared`。

### 步骤 3：迁移、路径、数据模型文档

1. **迁移** `packages/core/migrations/main/0053_plugins.sql`（编号以开工核对为准；写法照 `0050_project_board.sql`，英文注释）：

   ```sql
   -- Plugin system (D104, docs/design/51-plugin-system.md §7).
   -- Built-in plugins are read-only app resources and never get a row here.
   -- plugin_items is the projection ledger: uninstall / rollback / conflict checks read it.

   CREATE TABLE plugins (
     id             TEXT PRIMARY KEY,                       -- 'io.github.alice/doc-tools'
     version        TEXT NOT NULL,
     origin         TEXT NOT NULL CHECK (origin IN ('marketplace','local')),
     tier           TEXT NOT NULL CHECK (tier IN ('verified','community','developer')),
     state          TEXT NOT NULL CHECK (state IN ('installing','installed','uninstalling')),
     enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
     package_sha256 TEXT NOT NULL,
     marketplace    TEXT,                                   -- source endpoint; marketplace origin only
     dir            TEXT NOT NULL,                          -- relative to {home}/plugins: '{ns}/{name}@{version}'
     installed_at   INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL,
     CHECK ((origin = 'marketplace') = (marketplace IS NOT NULL)),
     CHECK ((origin = 'local') = (tier = 'developer'))
   );

   CREATE TABLE plugin_items (
     plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
     kind      TEXT NOT NULL CHECK (kind IN ('skill','connector','mcp','mail','disabled_connection')),
     ref       TEXT NOT NULL,                               -- skill name / connector slug / server id / template id / connection id
     PRIMARY KEY (plugin_id, kind, ref)
   );
   CREATE INDEX plugin_items_ref ON plugin_items(kind, ref);
   ```

2. **既有测试同步**（必须做，否则整库回拨重放会报 `table already exists`）：`packages/core/test/unit/public-skills-migration.test.ts` 在 105–133 行一串 `drop table ...` 里**按依赖顺序**加 `drop table plugin_items; drop table plugins;`（`plugin_items` 先）。

3. **`AppPaths.pluginsDir`**：`packages/core/src/infra/paths.ts` 的 `AppPaths` 接口加 `pluginsDir: string`（带一行注释），`resolvePaths()` 里 `pluginsDir: path.join(home, 'plugins')`；`start.ts` 约 l.718 `mkdirSync(paths.toolchainsDir, …)` 旁加 `mkdirSync(paths.pluginsDir, { recursive: true })`。在 `packages/core/test/unit/paths.test.ts` 加一条断言 `paths.pluginsDir === path.join(home, 'plugins')`。

4. **文档** `docs/dev/03-data-model.md`：
   - 迁移表（约 l.57，`0052` 行之后）加行：`| main | \`0053_plugins.sql\` | D104：新表 \`plugins\`（市场 / 本地插件，内置插件不入表）、\`plugin_items\`（投影账本，随插件 \`ON DELETE CASCADE\`） |`；
   - `## main.db` 末尾（`### agent_sessions` 之后、`## runs.db` 之前）加 `### plugins / plugin_items（插件，D104，迁移 0053）` 小节，含上面 DDL 的 SQL 代码块（照 `board_columns / board_cards` 小节的写法）与 3–5 条说明（账本语义、状态机、`origin`/`tier` 约束、内置不入表）；
   - `## 删除级联` 的「删除对话」与「删除 Bot」两张表各加一行：`| plugins / plugin_items | 保留（全局数据，不随对话 / Bot 删除） | D104 |`。

5. **测试**：新增 `packages/core/test/unit/plugins-migration.test.ts`，照 `project-board-migration.test.ts` 的写法：迁移后 `user_version` 等于 `migrationTargetVersion`；两表与索引存在；`origin='local'` 且 `tier='verified'` 被 CHECK 拒绝；`origin='marketplace'` 且 `marketplace` 为空被拒；`state` 非法值被拒；删 `plugins` 行级联删 `plugin_items`；`plugin_items` 主键冲突被拒。

### 步骤 4：testkit 夹具

新建 `packages/testkit/src/plugin-fixture.ts`（并在 `index.ts` 导出），**基于已有的 `buildZip` 与 `buildMcpbFixture`**（同目录 `mcpb-fixture.ts`），不要另写 zip 编码：

```ts
export interface PluginFixtureSkill { name: string; description?: string; extraFiles?: Record<string, string> }
export interface PluginFixtureConnector { slug: string; url?: string; entry?: Record<string, unknown>; iconName?: string }
export interface PluginFixtureMcpb { id: string; fileName?: string; mcpb?: Omit<McpbFixtureOptions, 'dir'>; name?: string; description?: string }
export interface PluginFixtureHttp { id: string; url: string; name?: string; description?: string }
export interface PluginFixtureOptions {
  dir: string;                                   // 输出目录（不存在则创建）
  fileName?: string;                             // 默认 `${id.replace('/', '__')}-${version}.kepcup`
  manifest?: Record<string, unknown>;            // 浅合并到默认清单上；值为 null 表示删键
  skills?: PluginFixtureSkill[];                 // → skills/{name}/SKILL.md（frontmatter name / description）
  connectors?: PluginFixtureConnector[];         // → connectors/{slug}/server.json + {slug}.svg
  mcpb?: PluginFixtureMcpb[];                    // → mcp/{id}.mcpb（用 buildMcpbFixture 生成真 .mcpb）
  http?: PluginFixtureHttp[];
  mail?: Array<Record<string, unknown>>;
  extraEntries?: ZipEntryInput[];                // 追加 / 覆盖的条目（构造恶意包：../x、符号链接、重名…）
  omitManifest?: boolean;
  rawManifest?: string;                          // 逐字写成 plugin.json
}
export interface PluginFixture { path: string; sha256: string; size: number; manifest: Record<string, unknown> }
export function buildPluginFixture(options: PluginFixtureOptions): Promise<PluginFixture>;
/** 同一份内容，写成未打包的目录（开发目录安装用）；返回目录路径。 */
export function buildPluginDir(options: Omit<PluginFixtureOptions, 'fileName'>): Promise<{ path: string; manifest: Record<string, unknown> }>;
export function connectorFixtureEntry(slug: string, options?: { url?: string; tier?: string }): Record<string, unknown>;
```

- 默认清单：`{ format_version: 1, id: 'io.github.tester/fixture', name: 'Fixture', version: '1.0.0', description: 'KepCup plugin fixture', contributions: {…按传入数组生成} }`；`skills[]` → `{dir:'skills/<name>'}`，`connectors[]` → `{file:'connectors/<slug>/server.json'}`，`mcpb[]` → `{kind:'mcpb', id, file:'mcp/<id>.mcpb', …}`，`http[]` → `{kind:'http', …}`。
- 技能 SKILL.md：`---\nname: <name>\ndescription: <description ?? 'Fixture skill'>\n---\n# <name>\n`。
- `connectorFixtureEntry(slug)`：照 `packages/core/test/support/catalog-connect-env.ts` 的 `fakeCatalogEntry`（`name: 'test.<slug>/mcp'`、`remotes: [{type:'streamable-http', url: 'https://mcp.<slug>.test/mcp'}]`、`_meta['app.kepcup/connector']` 含 `slug`、`icon: '<slug>.svg'`、`category:'productivity'`、`tier:'builtin'`（插件管线会改写它）、`auth: {kind:'oauth', registration:'auto', clientRef:null, scopes:{default:[],write:[]}}`、`toolPolicy:{}`、`skills:[]`、`ui:false`、`privacyPolicy:'https://example.com/privacy'`、`releaseGate:'test'`）。**不要 import core 的测试 support**（testkit 不依赖 core 的 test 目录）。
- 图标：`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`。
- **测试**：`packages/testkit/test/plugin-fixture.test.ts`（项目 `testkit`）：默认包能被 `ZipArchive`（`@kepcup/package-guard`）打开、含 `plugin.json` 与期望条目；`manifest: { name: null }` 删键；`extraEntries` 的恶意名原样存入；`buildPluginDir` 的目录内容与 zip 内容一致；内嵌 `.mcpb` 是合法 zip 且 `manifest.json` 可解析。

### 步骤 5：`plugins/ids.ts`

`packages/core/src/plugins/ids.ts`，全部纯函数，各带单元测试（`packages/core/test/unit/plugin-ids.test.ts`）：

| 导出 | 行为 |
|---|---|
| `pluginDirName(id, version): string` | `` `${id}@${version}`.toLowerCase() ``（含一个 `/`，即 `{ns}/{name}@{version}`） |
| `pluginDirOf(pluginsDir, id, version): string` | 解析为绝对路径，**守卫同 `McpbInstaller.installDirOf`**：`id` 须通过 `pluginIdSchema`、`version` 通过 `pluginVersionSchema`；结果必须以 `path.resolve(pluginsDir) + path.sep` 开头，且相对 `pluginsDir` 恰好两段（`ns`、`name@version`）；否则抛 `AppError('PLUGIN_INVALID', '安装目录越界：…')` |
| `pluginServerId(pluginId, key): string` | `'plg_' + sha256Hex(`${pluginId}#${key}`).slice(0, 12)`（用 `node:crypto`）；结果必须满足 `MCP_SERVER_ID_PATTERN` |
| `assertInstallablePluginId(id): void` | 命名空间是保留的（`isReservedPluginNamespace`）→ `PLUGIN_INVALID`「命名空间 … 为 KepCup 保留」；内置加载器**不**调用它 |

技能来源标记的 `pluginSkillSource` / `parsePluginSkillSource` 在 shared（步骤 2.1），core 直接 `import { … } from '@kepcup/shared'`，**不要在 `ids.ts` 里再定义一份**。

测试要点：同输入同输出、不同输入不同输出、`pluginServerId` 恒匹配 `MCP_SERVER_ID_PATTERN`；`pluginDirOf` 拒绝 `ns` 里带 `..` 的变体（`pluginIdSchema` 本就拒绝，仍加用例）、大小写不同的 id 得到同一目录；`assertInstallablePluginId` 对 `com.kepcup/x`、`local.kepcup/x` 的拒绝（含大小写变体）。`pluginSkillSource` / `parsePluginSkillSource` 的往返与畸形输入（少于 / 多于三段、前缀不对、空串）放在 shared 的 `plugin-manifest.test.ts`。

### 步骤 6：`plugins/manifest-loader.ts`

| 导出 | 行为 |
|---|---|
| `parsePluginManifestText(text: string): PluginManifest` | ① `Buffer.byteLength(text) > PLUGIN_MANIFEST_MAX_BYTES` → `PLUGIN_INVALID`；② `JSON.parse` 失败 → `PLUGIN_INVALID`；③ 先单独读 `format_version`：是数字且 `> PLUGIN_FORMAT_VERSION` → `AppError('PLUGIN_INCOMPATIBLE', '此插件需要更新版本的 KepCup')`；④ `pluginManifestSchema.safeParse`，失败 → `PLUGIN_INVALID`，`message` 取**前 3 条** issue 的 `路径: 说明`，**不回显原文** |
| `checkPluginCompatibility(manifest, env: { appVersion: string; platform: NodeJS.Platform }): void` | `platforms` 存在且不含 `env.platform` → `PLUGIN_INCOMPATIBLE`；`engines.kepcup` 存在且 `appVersion` 核心部分不是 `0.0.0` 且 `!satisfiesRange(appVersion, range)`（从 `../apps/mcpb/manifest.js` 引入）→ `PLUGIN_INCOMPATIBLE`「需要 KepCup {range}，当前 {appVersion}」；`range` 含 `satisfiesRange` 不支持的写法时它会返回 false，这是预期（按不兼容处理） |
| `verifyContributionFiles(manifest, dir): Promise<void>` | 对**已解包到 `dir` 的树**逐项检查：技能 `dir` 是目录且含 `SKILL.md`；连接器 `file` 是普通文件；mcpb `file` 是普通文件；用 `lstat` 拒绝符号链接；用 `realpath` 确认结果仍在 `dir` 的 `realpath` 之内（防符号链接逃逸）。违规 → `PLUGIN_INVALID`，`message` 指出相对路径 |

测试（`plugin-manifest-loader.test.ts`）：超大清单、非 JSON、`format_version: 2`（`PLUGIN_INCOMPATIBLE`）、strict 多余字段、`platforms` 不含当前平台、`engines` 不满足、`appVersion: '0.0.0-test'` 时跳过 `engines`、贡献文件缺失 / 是目录而非文件 / 是符号链接 / realpath 逃逸（在 `os.tmpdir()` 下手工造 `fs.symlink`；Windows 上建符号链接可能失败，用例 `it.skipIf(process.platform === 'win32')`）。

### 步骤 7：`plugins/package.ts`（`PluginPackager`）

```ts
export interface StagedPlugin {
  manifest: PluginManifest;
  /** 绝对路径：{pluginsDir}/.staging/{随机}/ ——解包后的完整树，永远是私有副本 */
  stagingDir: string;
  /** file：`.kepcup` 文件字节的 sha256；folder：树哈希（见下） */
  packageSha256: string;
  sizeBytes: number;
  source: { kind: 'file' | 'folder'; path: string };
}
export interface PluginPackagerDeps { pluginsDir: string; logger: CoreLogger; appVersion: string; platform?: NodeJS.Platform }
export class PluginPackager {
  constructor(deps: PluginPackagerDeps);
  stage(source: { kind: 'file' | 'folder'; path: string }): Promise<StagedPlugin>;
  discard(staged: StagedPlugin): Promise<void>;     // 删 stagingDir，幂等
  sweepStaging(): Promise<void>;                    // 启动时清空 .staging/（P0a-2 在启动恢复里调用）
}
```

**`stage` 的算法（file）**——照 `McpbInstaller.#withSnapshot` + `#inspectSnapshot` + `#extract`，**不要自己重新发明**：

1. `path.isAbsolute(path)` 否则 `PLUGIN_INVALID`；`stat` 不存在 → `NOT_FOUND`；不是普通文件 → `PLUGIN_INVALID`；`size > ZIP_MAX_FILE_BYTES` → `PLUGIN_INVALID`。
2. **私有快照**：在 `{pluginsDir}/.staging/` 下建 `.snap-{随机}.kepcup`（`open(..., 'wx', 0o600)`），边拷边算 sha256、边累计大小（流式，超限即中止并删快照）。此后所有步骤只读快照。`finally` 删快照。
3. `ZipArchive.open(snapshot, { error: (m) => new AppError('PLUGIN_INVALID', m), label: '.kepcup' })`。逐条目：`safeEntryPath(entry.name, factory)`；`entry.isSymlink` → `PLUGIN_INVALID`「包内含符号链接，已拒绝：…」；`name.toLowerCase()` 去重 → 「包内有重复路径：…」。
4. 读 `plugin.json`（须存在、`size ≤ PLUGIN_MANIFEST_MAX_BYTES`，否则 `PLUGIN_INVALID`）→ `parsePluginManifestText` → `checkPluginCompatibility`。
5. 解包到 `{pluginsDir}/.staging/{随机}/`：目录用 `mkdir -p`；文件 `writeFile(target, data, { mode })`，`mode = (entry.unixMode & 0o111) !== 0 ? 0o755 : 0o644`（**不要保留 group/world 可写位**）；每个 `target` 须 `path.resolve` 后仍以 staging 目录 + `sep` 开头。
6. `verifyContributionFiles(manifest, stagingDir)`。
7. 返回 `StagedPlugin`。**任何一步抛错 → 删除 staging 目录与快照后再抛**。

**`stage`（folder）**：`path.isAbsolute`；`lstat` 根必须是目录且不是符号链接。递归遍历：每个条目 `lstat`；符号链接 / 非普通文件非目录 → `PLUGIN_INVALID`；相对路径过 `safeEntryPath`；累计条目数 ≤ `ZIP_MAX_ENTRIES`、单文件 ≤ `ZIP_MAX_ENTRY_BYTES`、总大小 ≤ `ZIP_MAX_UNPACKED_BYTES`（超限即中止）；**复制到 staging**（`copyFile`，文件 mode 同上规则）后**只用副本**做后续校验（防止「校验后用户再改源目录」）。`packageSha256` = 树哈希：对每个文件算 `` `${relPosixPath}\0${sha256(content)}` ``，数组排序后以 `\n` 连接再 sha256（同 `McpbInstaller` 的 `treeHashOf`）。`sizeBytes` = 文件字节总和。其余（清单读取 / 校验）同 file。

**测试**（`packages/core/test/unit/plugin-package.test.ts`，用步骤 4 的夹具，临时目录）：

| 用例 | 期望 |
|---|---|
| 合法 `.kepcup`（2 技能 + 1 连接器 + 1 内嵌 mcpb） | `stage` 成功；staging 里文件齐全；`packageSha256` = 文件 sha256；快照已删除 |
| 同内容的开发目录 | `stage(folder)` 成功；`manifest` 相同；树哈希稳定（重复 stage 同值） |
| 恶意条目：`../evil`、`/abs`、`a\\b`、`C:/x`、符号链接、大小写重名 | 全部 `PLUGIN_INVALID`，staging 目录被清理，`{home}` 下无 `evil` |
| 缺 `plugin.json` / 清单超限 / 清单非法 / `format_version: 2` / 平台不兼容 | 对应错误码 |
| 贡献文件缺失（清单声明 `skills/x` 但包里没有） | `PLUGIN_INVALID` |
| 开发目录里有符号链接（指向目录外） | `PLUGIN_INVALID`（`skipIf win32`） |
| 开发目录 stage 后改源目录文件 | 已暂存副本不变（证明只用副本） |
| 相对路径 / 不存在的文件 | `PLUGIN_INVALID` / `NOT_FOUND` |
| `discard` 幂等；`sweepStaging` 清空 `.staging/` | 通过 |
| 解包出的文件无 group/world 写位（POSIX） | `skipIf win32` |

## 5. 验收

- [ ] `mcpb` 既有测试（`unit/mcpb.test.ts`、`integration/mcpb.test.ts`）**零改动**全绿；`refactor(mcpb)` 提交里只有 `package-guard` 抽取相关改动。
- [ ] `pnpm typecheck`（根目录，含新的构建顺序）通过；`pnpm --filter @kepcup/server run build` 通过。
- [ ] 步骤 1–7 列出的全部新测试通过：`node scripts/run-tests.mjs run packages/package-guard packages/shared/test/unit/plugin-manifest.test.ts packages/shared/test/unit/plugins-contracts.test.ts packages/core/test/unit/plugins-migration.test.ts packages/core/test/unit/plugin-ids.test.ts packages/core/test/unit/plugin-manifest-loader.test.ts packages/core/test/unit/plugin-package.test.ts packages/testkit/test/plugin-fixture.test.ts packages/core/test/unit/public-skills-migration.test.ts packages/core/test/unit/paths.test.ts`。
- [ ] 阶段收口**跑一次**全量 `pnpm test`（本阶段改了 shared 契约与迁移），失败集合不超出 PROGRESS.md 记录的沙箱基线。
- [ ] `docs/dev/03-data-model.md` 三处更新已做。
- [ ] 没有注册任何 RPC、没有改 `start.ts`（除 `mkdirSync(pluginsDir)` 一行）。

## 6. 实施记录

（2026-10-26，分支 `feat/plugins/p0a-1-foundation`，执行智能体填写。）

### 做了什么（按提交）

| 提交 | 内容 |
|---|---|
| `f792b9b4` | 步骤 1：`refactor(mcpb): extract zip reader into @kepcup/package-guard` —— 新建工作区包 `@kepcup/package-guard`（`ZipArchive` / `safeEntryPath` / `crc32` / `ZIP_MAX_*` / `ZipGuardOptions` / `PackageGuardError`，无运行时依赖），core 的 `apps/mcpb/zip.ts` 改为薄适配层（导出面不变）；vitest 别名与 `package-guard` 项目、根 `package.json` 的 `typecheck` / `dev` 构建顺序插入 package-guard、core 依赖 + lockfile；新增 `packages/package-guard/test/zip.test.ts`（11 例）。该提交上 `unit/mcpb.test.ts` + `integration/mcpb.test.ts` 35 例零改动全绿（`git diff v0.5.0 HEAD -- <两个文件>` 为空）。 |
| `2a5853c3` | 步骤 2：shared 契约 —— 新建 `domain/plugin-manifest.ts`（常量、id/version/relPath schema、四类贡献 strict schema、`pluginManifestSchema` + superRefine 去重/非空、`pluginSkillSource` / `parsePluginSkillSource`）、`domain/plugins.ts`（origin/tier/state/itemKind/source/summary/inspect/install/setEnabled/uninstall/changed 全套 zod）；`connectorOriginSchema` 增 `'plugin'`、`mcpServerSourceSchema` 改判别联合（`types.ts` 本地约束，不 import plugin-manifest）、`ERROR_CODES` 增四个 `PLUGIN_*`、`rpc/events.ts` 增 `plugins.changed`、`rpc/methods.ts` 注册五个 `plugins.*`（`rpcMethodSchemas` + `APP_METHODS`）、`index.ts` 导出；i18n `chats.errorCode.PLUGIN_*` 四条 × 两种语言（locales.test 通过）。新增 `plugin-manifest.test.ts` / `plugins-contracts.test.ts`。`install.ts` 仅类型层收窄（见 DEV-048）。 |
| `bacccfaf` | 步骤 3：迁移 `0053_plugins.sql`（DDL 逐字照任务书）；`public-skills-migration.test.ts` 的 drop 链按依赖顺序加 `drop table plugin_items; drop table plugins;`；`AppPaths.pluginsDir` + `resolvePaths` + `start.ts` `mkdirSync(paths.pluginsDir)`（对 start.ts 的唯一改动）+ `paths.test.ts` 断言；`docs/dev/03-data-model.md` 三处（迁移表行、`### plugins / plugin_items` 小节、两张删除级联表各一行）；新增 `plugins-migration.test.ts`（6 例）。 |
| `2cca7fc0` | 步骤 4：testkit `plugin-fixture.ts`（`buildPluginFixture` / `buildPluginDir` / `connectorFixtureEntry`，基于 `buildZip` + `buildMcpbFixture`）+ `plugin-fixture.test.ts`（6 例）。 |
| `14b2302a` | 步骤 5：`core/src/plugins/ids.ts`（`pluginDirName` / `pluginDirOf` / `pluginServerId` / `assertInstallablePluginId`）+ `plugin-ids.test.ts`（7 例）。 |
| `9b9920c1` | 步骤 6+7：`core/src/plugins/manifest-loader.ts`（`parsePluginManifestText` / `checkPluginCompatibility` / `verifyContributionFiles`）与 `core/src/plugins/package.ts`（`PluginPackager.stage`（file 快照管线 + folder 遍历复制管线）/ `discard` / `sweepStaging`）+ `plugin-manifest-loader.test.ts`（15 例）/ `plugin-package.test.ts`（12 例）。 |
| `c45a6dad` | `fix(plugins)`：package-guard 的 error/label 改存为一个实例上的 options 对象（修 `no-unused-private-class-members`，语义仍是「存进实例」），顺带修 `#stageFile` 里 sha256 双 `digest` 的笔误。 |

### 偏差与 DEV 编号

- **DEV-048**：`mcpServerSourceSchema` 联合化后，任务书「不改 install.ts」的假设在 `verify` / `#releasePackage` / `#audit` 三处签名上不成立（直接在联合上取 `name`/`version`/`sha256`）。做了最小类型收窄（`Extract<McpServerSource, { kind: 'mcpb' }>`），行为零改动；`McpbInstaller` 面向 plugin 来源的完整改造仍按计划归 P0a-2。
- 其余为自由度内的判断点（见下），不构成偏差。

### 迁移实际编号

开工核对 `ls packages/core/migrations/main | tail -3`：最新为 `0052_todo_pending_when.sql`，本阶段用 **0053**（`0053_plugins.sql`），与任务书一致，未占用、未顺延。

### `ci.yml` / `release.yml` 构建顺序核对结论

- `.github/workflows/ci.yml`：跑根 `pnpm typecheck`（第 26 行，注释说明它先构建 shared+core；根脚本已把 `pnpm --filter @kepcup/package-guard run build &&` 插在 shared 之后、core 之前），另有一步显式 `pnpm --filter @kepcup/shared run build`（第 44 行）。**没有逐包 build core 的步骤，不需要改 ci.yml。**
- `.github/workflows/release.yml`：两处 `pnpm -r build`（138、288 行），按 workspace 依赖拓扑自动先建 package-guard（core 依赖它）。**不需要改。**

### `settings/adapters.ts` plugin 来源计数结论

`developerCustomMcpAdapter`（2069 行，`source?.kind !== 'mcpb'` → 「N 个自定义 MCP」）与 `developerMcpbAdapter`（2092 行，`=== 'mcpb'` → 「N 个 .mcpb 包」）统计的是 `settings.mcpServers` 条目。联合化后 plugin 来源的 server 落进前者的「自定义 MCP」计数——**符合其用途**：设置卡的这两条文案都是「开发者 MCP」桶的计数，插件登记的 server（内嵌 MCPB / 远端 http）本质也是经插件进入的自定义 server，出现在 MCP 设置页并计入该桶是准确的；若 P0a-3 的界面想单独标出插件来源，改渲染层徽标即可，core 计数不需要动。P0a-1 未改这两行。

### 自由度内的判断点（登记）

1. **`platforms` 条目类型**：任务书只说「至少 1 项」，取 `z.enum(['darwin', 'win32', 'linux'])`（与 mcpb `MCPB_PLATFORMS` 一致；未知平台串没有意义）。
2. **`pluginDirOf` 的「恰好两段」**：插件目录名本身含一个 `/`，mcpb 的 `dirname === root` 检查不能照搬，改为 `path.relative(root, dir)` 恰好两段且拼回等于小写化名字（守卫强度等价，`a/b` 这类 schema 合法 id 正确放行）。
3. **`connectorFixtureEntry`**：在任务书列出的字段外补了 `title` / `description` / `version`（照 `fakeCatalogEntry` 的完整形状，P0a-2 过 `connectorCatalogEntrySchema` 时必需）。
4. **package-guard 实例上的 error/label**：任务书要求「存进实例」，为过 `no-unused-private-class-members`（label 在 open 阶段后才无读者），存为一个 `Required<ZipGuardOptions>` 对象字段 `#guard`，`read()` 用 `this.#guard.error`，语义不变。
5. **`chats.errorCode.PLUGIN_*` 文案**：任务书未给词，按相邻错误文案风格自拟（中文四条 + 英文对应，两文件键顺序一致）。
6. **folder 管线的条目计数**：目录与文件都计入 `ZIP_MAX_ENTRIES`（与 zip 条目口径一致）；复制用 `copyFile` + `chmod` 落 0755/0644 规则。
7. **清单超限错误口径**：zip 条目尺寸检查先于 `parsePluginManifestText` 的字节预算触发时报「plugin.json 过大」，两者都是 `PLUGIN_INVALID`，测试按 `/过大|上限/` 断言。

### 验收清单逐条证据

1. **mcpb 既有测试零改动全绿**：`node scripts/run-tests.mjs run packages/core/test/unit/mcpb.test.ts packages/core/test/integration/mcpb.test.ts` → 2 文件 35 例全绿；`git diff v0.5.0 HEAD -- packages/core/test/unit/mcpb.test.ts packages/core/test/integration/mcpb.test.ts` 为空；`refactor(mcpb)` 提交（`f792b9b4`）只含 package-guard 抽取相关文件（git show --stat 核对）。
2. **根 `pnpm typecheck` 通过**（含新构建顺序：shared → package-guard → core → `-r typecheck`，desktop svelte-check 0 错误）；`pnpm --filter @kepcup/server run build` 通过。
3. **全部新测试**：`node scripts/run-tests.mjs run packages/package-guard packages/shared/test/unit/plugin-manifest.test.ts packages/shared/test/unit/plugins-contracts.test.ts packages/core/test/unit/plugins-migration.test.ts packages/core/test/unit/plugin-ids.test.ts packages/core/test/unit/plugin-manifest-loader.test.ts packages/core/test/unit/plugin-package.test.ts packages/testkit/test/plugin-fixture.test.ts packages/core/test/unit/public-skills-migration.test.ts packages/core/test/unit/paths.test.ts` → 10 文件 113 例全绿。
4. **阶段收口全量 `pnpm test`（macOS arm64，本机）**：619 个测试文件（617 通过 / 2 跳过）、6612 例——**6575 通过 / 0 失败 / 37 跳过**，退出码 0（约 190 秒）。失败集合为空，不超出 PROGRESS.md 记录的沙箱基线（最近一轮 macOS 收口记录同为 0 失败；沙箱环境类用例不在本机常规全量路径内）。未放宽或删除任何既有断言。
5. **`docs/dev/03-data-model.md` 三处更新**：迁移表 `0053` 行、`### plugins / plugin_items（插件，D104，迁移 0053）` 小节（`agent_sessions` 之后、`## runs.db` 之前，含 DDL 与 4 条说明）、「删除对话」「删除 Bot」两表各加 `plugins / plugin_items | 保留 | D104` 行。
6. **无 RPC 注册、`start.ts` 仅一行 mkdir**：`rg -n "bindPluginsMethods|plugins\." packages/core/src/rpc packages/core/src/start.ts` 只有 `mkdirSync(paths.pluginsDir)`；`rpc/` 目录未新增文件，`bindAppMethods` 未动。

### 遗留问题

- 无阻塞项。`plugins.install` 的 `userConfig` 消费、`plugins.inspect` 的推导（技能 parse/scan、连接器 schema、MCPB 检视、http 主机校验）、账本写入与投影器、RPC 绑定与 `start.ts` 装配均在 P0a-2。
- `pluginSourceSchema` 目前只有 `file` / `folder`，`marketplace` 分支按计划 P1 加性加入。
- 本机（macOS）无 bubblewrap，沙箱类用例按基线失败，与改动无关。

### 审查修正（2026-10-26，独立审查智能体）

审查范围：`git diff 3b092d6d..HEAD`；结论：可合入，未发现 P0/P1 问题。修正分两个 `fix(plugins)` 提交：

1. **folder 管线树哈希改读 staging 副本**（`core/src/plugins/package.ts`）：原实现对每个文件 `copyFile` 到 staging 后再 `readFile(源路径)` 算哈希——复制与哈希之间源文件被改时，`packageSha256` 绑定的不是实际暂存的字节，违反「校验后只用副本」与设计 51 §7「`package_sha256` 包文件内容绑定」。改为哈希 staging 副本，并补注释说明。
2. **superRefine 的 mcpb `file` 去重 issue path 用全量 `mcp` 数组的下标**（`shared/src/domain/plugin-manifest.ts`）：原实现先 `filter(kind === 'mcpb')` 再去重，`path` 里的下标是 mcpb 子集内的位置；当前面有 `http` 贡献时指向错误的元素。`dup` 助手改为接收 `[value, 原数组下标]` 对，mcpb 分支用 `flatMap` 带出原下标；新增用例断言 `['contributions','mcp',2,'file']`（http 在前时）。
3. **realpath 逃逸分支补直接用例**（`core/test/unit/plugin-manifest-loader.test.ts`）：原「symlinked parent」用例的符号链接落在贡献目录本身，`lstat` 的 symlink 分支先命中，realpath 包含性检查从未被执行。新增用例把符号链接放在贡献的**祖先目录**（`skills` → 包外），`lstat` 见到的是真实目录，只有 realpath 包含性检查能拒绝（断言 `越界（符号链接逃逸）`）。
4. **清理与规范**：`plugin-package.test.ts` / `plugin-fixture.test.ts` 删掉函数内动态 `import('node:fs/promises')`（其一 `void` 后未使用，属复制粘贴残留），并入顶层静态导入；P0a-1 全部 15 个新增/改动文件过 `prettier --check`（此前 14 个不干净，仓库 lint 基线不受影响，CI 只跑 eslint）。
5. **DEV-049**：任务书称「`satisfiesRange` 不支持的写法返回 false（按不兼容处理）」，与 `mcpb/manifest.ts` 实际实现（未知子句 `continue` 忽略 → 返回 true 放行）相反；实现按任务书可操作指令复用共享助手、语义与 MCPB 一致，登记偏差不另写一层。

审查确认无须改动的判断点：`pluginSummarySchema` / `pluginInspectOutputSchema` 的 `version` 用 `pluginVersionSchema`（任务书代码块写 `z.string()`；系统内版本恒经清单 schema 校验，取更严者且与同块 `id: pluginIdSchema` 对称）；folder 管线目录条目计入 `ZIP_MAX_ENTRIES`；staging 子目录用默认 `mkdir -p` 模式（任务书只约束文件位，与 `McpbInstaller` 解包先例一致）。
