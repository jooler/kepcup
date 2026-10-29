# P0b · 内置插件化：加载器、preset-skills / connectors 迁入、打包、`preset://` 迁移、`mcp-presets` 删除

> 状态：**待实施**。依赖：P0a-2 已合入（P0a-3 不是前置，但 `plugins.list` 里内置插件的展示依赖其界面，数据先到先显示）。分支：`feat/plugins/p0b-builtin`。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §2（第 2、6 条）、§12。

## 1. 目标

把今天随应用分发的**预置技能**与**连接应用目录**改造成两个**内置插件**（`com.kepcup/starter-skills`、`com.kepcup/connections`），位于 `apps/desktop/resources/plugins/`；内置插件**只读、不入 `plugins` 表**，技能仍是**目录型**（逐条安装，`install_skill(preset_id)` / `<recommended_skills>` / `skills.presets.*` 行为不变）、连接器仍是**打包快照来源**（`directory-merge` 锚点、发行门禁、`origin: 'bundled'` 全部不变）。同时：环境变量合并为 `KEPCUP_BUILTIN_PLUGINS`、桌面三平台打包与 `kepcup-server` 打包改接新目录（**server 拷贝时按发行门禁过滤连接器**）、已装用户的 `preset://` 来源一次性迁移、`mcp-presets` 空壳删除、全部随之变化的测试 / 脚本 / 文档同步。

**对用户可见的行为：除 headless 服务端首次获得预置技能与连接目录外，没有任何变化**（`plugins.list` 里多出两条只读的内置插件）。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| `resources/plugins/` 新布局 + 一次性迁移脚本（不提交） | 邮件厂商预设与 `AGENT_CATALOG`（留代码，Q2 / Q3） |
| `BuiltinPlugins` 加载器、`SkillPresetsService` / `ConnectorCatalog` 改读它 | 连接器签名目录通道（不动，Q4）；但 `sign-connector-index.mjs` 的**默认输入路径**要改 |
| 迁移 `0054`（`preset://` → `plugin://`） | 内置插件的启停 / 卸载（永远不提供） |
| 打包：`electron-builder.yml`、`core-host.ts`、`pack-server.mjs`、server 入口 | |
| 测试 / e2e / 脚本 / 文档同步；`mcp-presets` 删除 | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -3
ls packages/core/migrations/main | tail -3                                   # 本阶段迁移编号 = 最新 + 1（写作时 0054）
# 所有「旧路径 / 旧环境变量」的引用面——本阶段要逐个处理；做完后再跑一遍，剩下的只允许是历史文档
rg -n "resources/connectors|resources/preset-skills|preset-skills|connectors/catalog|mcp-presets|KEPCUP_PRESET_SKILLS|KEPCUP_CONNECTORS|resolvePresetSkillsDir|resolveConnectorsDir|readConnectorCatalogSource|PRESET_SOURCE_PREFIX" \
  --glob '!node_modules' --glob '!**/dist/**' --glob '!pnpm-lock.yaml' --glob '!todo/plugin-system/**' --glob '!docs/design/51-plugin-system.md' --glob '!docs/design/README.md'
rg -n "preset-skills|connectors" apps/desktop/electron-builder.yml
rg -n "presetSkillsEnv|connectorsEnv" apps/desktop/src
ls apps/desktop/resources/preset-skills apps/desktop/resources/connectors apps/desktop/resources/connectors/icons
```

必读：`packages/core/src/skills/presets.ts` 全文、`packages/core/src/apps/catalog.ts` 全文、`packages/core/src/infra/paths.ts`（`resolvePresetSkillsDir`）、`apps/desktop/src/main/core-host.ts`（l.170–260）、`scripts/pack-server.mjs`、`apps/server/src/server.ts`、`scripts/sign-connector-index.mjs`（l.30–60 与读 catalog 的位置）、`scripts/sync-mineru-skill.mjs`、`apps/desktop/resources/{preset-skills,connectors}/README.md`、`apps/desktop/connector-release-gates.json`、`docs/guides/add-connected-app.md`。

## 4. 步骤

### 步骤 1：新布局与一次性迁移（脚本不提交）

目标布局（`apps/desktop/resources/plugins/`；**内置插件目录无版本后缀**）：

```text
plugins/com.kepcup/starter-skills/
  plugin.json              # 清单（见下）
  NOTICE.md  README.md     # 原样从 preset-skills/ 搬来（README 里的路径说明要改写）
  skills/{docx,xlsx,pptx,pdf,meeting-notes,weekly-report,internal-comms,doc-coauthoring,mineru}/…   # 原 preset-skills/<id>/，git mv
plugins/com.kepcup/connections/
  plugin.json
  README.md                # 原 connectors/README.md，路径说明改写
  connectors/<slug>/server.json    # 原 catalog.json 里该条目的整段 JSON（含 _meta）
  connectors/<slug>/<icon>.svg      # 原 connectors/icons/<icon>
```

**迁移脚本**（写到 `scripts/migrate-builtin-plugins.mjs`，**跑完删掉，不要提交**）：

```js
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const res = path.join(root, 'apps/desktop/resources');
const out = path.join(res, 'plugins', 'com.kepcup');
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' });

// ── starter-skills ──
const presets = JSON.parse(readFileSync(path.join(res, 'preset-skills/catalog.json'), 'utf8')).presets;
const skillsPlugin = path.join(out, 'starter-skills');
mkdirSync(path.join(skillsPlugin, 'skills'), { recursive: true });
for (const p of presets) {
  git('mv', path.join(res, 'preset-skills', p.dir), path.join(skillsPlugin, 'skills', p.dir));
}
git('mv', path.join(res, 'preset-skills/NOTICE.md'), path.join(skillsPlugin, 'NOTICE.md'));
git('mv', path.join(res, 'preset-skills/README.md'), path.join(skillsPlugin, 'README.md'));
git('rm', '-q', path.join(res, 'preset-skills/catalog.json'));
writeFileSync(
  path.join(skillsPlugin, 'plugin.json'),
  JSON.stringify(
    {
      format_version: 1,
      id: 'com.kepcup/starter-skills',
      name: 'KepCup 入门技能',
      version: '1.0.0',
      description: '随应用分发的预置技能；逐条安装为公共技能。',
      contributions: {
        skills: presets.map((p) => ({
          dir: `skills/${p.dir}`,
          displayName: p.displayName,
          summary: p.summary,
          icon: p.icon ?? 'puzzle',
          section: p.section,
          version: p.version,
          tryIt: p.tryIt ?? '',
          ...(p.vendored === true ? { vendored: true } : {}),
        })),
      },
    },
    null,
    2,
  ) + '\n',
);

// ── connections ──
const catalog = JSON.parse(readFileSync(path.join(res, 'connectors/catalog.json'), 'utf8'));
const connPlugin = path.join(out, 'connections');
const connectorFiles = [];
for (const entry of catalog.connectors) {
  const meta = entry._meta['app.kepcup/connector'];
  const dir = path.join(connPlugin, 'connectors', meta.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'server.json'), JSON.stringify(entry, null, 2) + '\n');
  const icon = path.join(res, 'connectors/icons', meta.icon);
  if (existsSync(icon)) cpSync(icon, path.join(dir, meta.icon));
  connectorFiles.push({ file: `connectors/${meta.slug}/server.json` });
}
git('mv', path.join(res, 'connectors/README.md'), path.join(connPlugin, 'README.md'));
git('rm', '-rq', path.join(res, 'connectors'));
writeFileSync(
  path.join(connPlugin, 'plugin.json'),
  JSON.stringify(
    {
      format_version: 1,
      id: 'com.kepcup/connections',
      name: 'KepCup 连接应用',
      version: '1.0.0',
      description: '随应用分发的连接应用目录（打包快照）。',
      contributions: { connectors: connectorFiles },
    },
    null,
    2,
  ) + '\n',
);
```

运行后：

1. `git rm -rq apps/desktop/resources/connectors apps/desktop/resources/preset-skills` 补掉脚本没清干净的残留（`icons/` 目录等），然后 `ls apps/desktop/resources` 应只剩 `plugins`（外加其它无关目录），**没有** `connectors` / `preset-skills`。
2. 格式化：`pnpm exec prettier --write apps/desktop/resources/plugins`（仓库有 `fmt:check`）。
3. **等价性核对**（一次性，结果写进实施记录）：用 `git show HEAD:apps/desktop/resources/connectors/catalog.json` 取旧 catalog，与新目录里按 `plugin.json` 顺序读出的 9 个 `server.json` 逐条 `deepStrictEqual`；预置技能：旧 `catalog.json` 的 9 个条目与新 `plugin.json` 的展示字段逐字段相等、`SKILL.md` 内容未变（`git diff -M --stat` 应全是 rename）。
4. 保留 `hidden: true`（`gcalendar` / `gdrive`）、`releaseGate`、`vendored` 等字段**原样**。

### 步骤 2：`BuiltinPlugins` 加载器

文件 `packages/core/src/plugins/builtin.ts`（并在 `plugins/index.ts` 导出）。

```ts
/** env 覆盖 → 向上最多 8 层查找 `apps/desktop/resources/plugins` → null（照 resolvePresetSkillsDir 的写法）。 */
export function resolveBuiltinPluginsDir(env: NodeJS.ProcessEnv): string | null;

export interface LoadedBuiltinPlugin { id: string; dir: string; manifest: PluginManifest }
export interface BuiltinSkillOffer {
  id: string;                 // = path.basename(contribution.dir) = 技能名
  dir: string;                // 绝对路径
  section: string; displayName: string; summary: string; icon: string; version: string; tryIt: string;
  vendored: boolean;
}
export class BuiltinPlugins {
  constructor(deps: { env: NodeJS.ProcessEnv; logger: Pick<CoreLogger, 'warn' | 'info'> });
  readonly dir: string | null;
  /** 每次调用都重新读盘（插件清单很小；保持与 SkillPresetsService「改了资源立即可见」的既有行为一致）。坏插件 warn 并跳过。 */
  list(): LoadedBuiltinPlugin[];
  get(id: string): LoadedBuiltinPlugin | null;
  /** 取 `com.kepcup/starter-skills` 的技能贡献；缺 displayName / summary / section 的条目 warn 并跳过。 */
  skillOffers(): BuiltinSkillOffer[];
  /** 取 `com.kepcup/connections` 的连接器条目，形状同旧的 `ConnectorCatalogSource`（见步骤 4）。 */
  connectorSource(): ConnectorCatalogSource;
  /** `plugins.list` 里内置插件的只读摘要（origin/tier = builtin，state = installed，enabled = true，dirPath = null）。 */
  summaries(): PluginSummary[];
}
```

加载规则：扫描 `{dir}/*/*/plugin.json`（两层）；`parsePluginManifestText` 校验；**`manifest.id` 必须等于 `{目录名1}/{目录名2}`**，否则 warn 跳过；**不调用 `assertInstallablePluginId`**（内置允许 `com.kepcup`）；不做 `checkPluginCompatibility`（内置随应用发布）；`verifyContributionFiles(manifest, dir)` 失败 → warn 跳过该插件。

**测试**：
- 先给 testkit 加夹具 `packages/testkit/src/builtin-plugins-fixture.ts`（`index.ts` 导出）：

  ```ts
  export interface BuiltinFixtureSkill { id: string; displayName?: string; summary?: string; section?: string; version?: string; icon?: string; tryIt?: string; description?: string; skillMd?: string }
  export interface BuiltinFixtureOptions { dir: string; skills?: BuiltinFixtureSkill[]; connectors?: Array<Record<string, unknown>> }   // connectors = 原始条目（含 _meta），图标按 meta.icon 写占位 svg
  /** 写出 `{dir}/com.kepcup/starter-skills` 与 `{dir}/com.kepcup/connections`（给了哪类就写哪类），返回 `dir`。 */
  export function buildBuiltinPluginsDir(options: BuiltinFixtureOptions): Promise<string>;
  ```

  技能 `SKILL.md` 默认 `---\nname: {id}\ndescription: {description ?? summary}\n---\n# {id}\n`（`skillMd` 给了就原样写）；展示字段缺省值：`displayName = id`、`summary = '{id} summary'`、`section = 'starter'`、`version = '1.0.0'`、`icon = 'puzzle'`、`tryIt = ''`。
- `packages/core/test/unit/builtin-plugins.test.ts`：`resolveBuiltinPluginsDir` 的 env 覆盖 / 向上查找 / 不存在；`list` 对坏 `plugin.json` / id 与目录不符 / 缺贡献文件的容错；`skillOffers` 字段映射与缺字段跳过；`connectorSource` 条目与图标路径；`summaries` 形状；**每次调用重新读盘**（改文件后再调用立即可见）。

### 步骤 3：技能侧改读内置插件

`packages/core/src/skills/presets.ts`：

- 删除 `catalogEntrySchema` / `catalogSchema` / `#readCatalog()` / `resolvePresetSkillsDir` 的使用；`SkillPresetsDeps` 去掉 `env`、加 `builtin: Pick<BuiltinPlugins, 'skillOffers'>`；构造函数不再日志「preset skills directory not found」（改为 `builtin.skillOffers().length === 0` 时 `logger.info` 一次）；
- `PRESET_SOURCE_PREFIX` 改为 `'plugin://com.kepcup/starter-skills/'`（常量名保留，注释改写）；`install()` 里 `sourceUrl: \`${PRESET_SOURCE_PREFIX}${preset.entry.id}\``；`#installState` 的 `foreign` 判断沿用该常量；
- `#resolveAll()` 改为遍历 `builtin.skillOffers()`：`dir` 已是绝对路径（去掉 `path.join` 与「路径逃逸」检查，加载器已保证在插件目录内）；其余（`parseSkillDir` → `scanSkillDir` → `hashDirectory`、`list` / `install` / `promptSection` / `describePreset`）**一行不改**；
- `ResolvedPreset.entry` 的类型改为 `BuiltinSkillOffer`（字段名与原 `CatalogEntry` 一致：`id / section / displayName / summary / icon / version / tryIt`，`vendored`）。
- `packages/core/src/infra/paths.ts`：删除 `resolvePresetSkillsDir`；改为新增 `resolveBuiltinPluginsDir` 的实现放在 `plugins/builtin.ts`（paths.ts 里只保留一行指向说明或直接删除该函数及其注释）。
- `start.ts` l.1627 `new SkillPresetsService({ env, … })`：改传 `builtin: builtinPlugins`（`builtinPlugins` 在步骤 4 里于更早处构造）。

**测试改写**（只改**夹具与断言入口**，不放宽任何断言）：

| 文件 | 改法 |
|---|---|
| `packages/core/test/unit/skills-presets.test.ts` | `makePresetDir()`（l.61–91）改成用 `buildBuiltinPluginsDir({ dir, skills: [...] })`；`makeService()`（l.93–100）改传 `builtin: new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger })`；「目录缺失退化为空」用例用 `env: {}` + 不存在的目录；「catalog 指向不存在目录时跳过」改成「清单里的技能目录被删后跳过」；其余断言原样 |
| `packages/core/test/integration/skill-presets.test.ts` | `createTestStack({ env: { KEPCUP_BUILTIN_PLUGINS: dir } })`，目录用 `buildBuiltinPluginsDir` |
| `packages/core/test/unit/preset-skills-catalog.test.ts` | 守护真实随包目录：路径改为 `apps/desktop/resources/plugins/com.kepcup/starter-skills`，用 `pluginManifestSchema` 校验 `plugin.json`；「id 唯一 / `dir` 不含分隔符 / `SKILL.md` 存在」改为对 `contributions.skills` 的等价断言（`dir` 形如 `skills/<id>`）；`NOTICE.md` 在新位置；其余（description ≤300、无沙箱声明、vendored 必须完全兼容、NOTICE 记录上游与 commit）不变。**文件可改名为 `starter-skills-plugin.test.ts`，也可不改名**，由你选，写进实施记录 |

### 步骤 4：连接器侧改读内置插件

`packages/core/src/apps/catalog.ts`：

- `ConnectorCatalogSource` 增可选 `iconPaths?: ReadonlyMap<string, string>`（slug → 图标绝对路径）；
- 删除 `resolveConnectorsDir` 与 `readConnectorCatalogSource`（连同其注释里的 `KEPCUP_CONNECTORS` 说明）；`ConnectorCatalog` 构造里 `this.#source = options.source ?? { entries: [], iconsDir: null }`（**不再自己读盘**；调用方负责给 `source`）；`ConnectorCatalogOptions.env` 若不再被使用则保留字段但注释说明「仅为兼容构造参数」——**优先删掉 `env` 并同步改调用方；以 typecheck 通过为准，改动面太大时保留并记录**；
- `iconSvg(slug)`：先查 `#source.iconPaths?.get(slug)`（有则读该文件，必须 `.svg` 结尾，读失败返回 `null`），再回退到原有的 `iconsDir` 逻辑（远端独有 / 本机 / 插件来源的规则**不变**）；
- `BuiltinPlugins.connectorSource()` 返回 `{ entries: [raw JSON…], iconsDir: null, iconPaths }`：`entries` 是各 `server.json` 解析后的原始对象（顺序 = `plugin.json` 的 `connectors` 顺序），`iconPaths` 的图标路径 = `server.json` 同目录 + `_meta.icon`（文件不存在则不放进 map）。

`start.ts`：

- 在读到 `env` 之后、构造 `ConnectorCatalog` 与 `SkillPresetsService` 之前（l.1213 之前找合适位置）：`const builtinPlugins = new BuiltinPlugins({ env, logger });`；
- l.1271 `new ConnectorCatalog({...})`：`source` 改为 `__KEPCUP_TEST_HOOKS__ === true && env.NODE_ENV === 'test' && !env.KEPCUP_BUILTIN_PLUGINS ? { entries: [], iconsDir: null } : builtinPlugins.connectorSource()`（**保持原有「测试构建且未显式指定目录 → 连接目录为空」的语义**，只是把判断用的变量换成 `KEPCUP_BUILTIN_PLUGINS`）；技能侧**没有**这个测试期清空（与现状一致）；
- `PluginRegistry` 构造处（P0a-2 步骤 10）加依赖 `builtin: builtinPlugins`。

`PluginRegistry`（P0a-2 的文件）改动：`deps.builtin?: Pick<BuiltinPlugins, 'summaries' | 'get'>`；`list()` 先返回 `builtin.summaries()` 再返回已装插件；`setEnabled` / `uninstall` 对内置 id → `AppError('INVALID_INPUT', '内置插件不能停用或卸载')`；`inspect` / `install` 对保留命名空间的拒绝已由 `assertInstallablePluginId` 保证。**测试**：补 `plugin-registry.test.ts` 与集成测试 `plugins.test.ts` 各一条（`list` 含内置、对内置 `uninstall` / `setEnabled` 报错）。

**测试改写**（四个直接读真实 `catalog.json` 的测试 + 一个夹具）：

先加一个测试用的读取助手 `packages/core/test/support/shipped-connectors.ts`：

```ts
/** 读随包的内置连接器条目（原 catalog.json 的 `connectors` 数组），顺序 = plugin.json 里的顺序。 */
export function readShippedConnectorEntries(): Array<Record<string, unknown>>;
export const SHIPPED_PLUGINS_DIR: string;       // apps/desktop/resources/plugins
```

| 文件 | 改法 |
|---|---|
| `packages/core/test/unit/connector-whoami.test.ts`（l.15） | `JSON.parse(readFileSync(.../catalog.json)).connectors` → `readShippedConnectorEntries()` |
| `packages/core/test/unit/connector-tool-snapshots.test.ts`（l.24） | 同上 |
| `packages/core/test/unit/local-connector-isolation.test.ts`（l.214–216） | 「默认输入 = catalog.json 逐字节」的断言改为对 `scripts/lib/builtin-connectors.mjs`（步骤 7 新增）的输出与 `readShippedConnectorEntries()` 的 `deepStrictEqual` |
| `packages/core/test/unit/connector-catalog.test.ts`（l.34 的 `connectorsDir`，以及 345–371 经 `readConnectorCatalogSource({KEPCUP_CONNECTORS: dir})` 的用例） | `connectorsDir` 改指新插件目录；经 env 注入的用例改成 `new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger }).connectorSource()`；契约文件 `contract/connector-catalog.contract.ts` 若引用旧路径同步改 |
| `packages/core/test/fixtures/connectors/README.md` | 路径说明改写 |

### 步骤 5：迁移 `0054`（`preset://` → `plugin://`）

`packages/core/migrations/main/0054_plugin_skill_source.sql`（编号以核对为准；英文注释）：

```sql
-- D104: preset skills are now the 'com.kepcup/starter-skills' built-in plugin.
-- Rewrite the library source marker so already-installed presets keep being recognised
-- (SkillPresetsService treats rows whose source_url starts with the new prefix as its own).
UPDATE skill_library
   SET source_url = 'plugin://com.kepcup/starter-skills/' || substr(source_url, length('preset://') + 1)
 WHERE source_url LIKE 'preset://%';
```

**测试** `packages/core/test/unit/plugin-skill-source-migration.test.ts`：照 `todo-pending-when-migration.test.ts` 的升级路径写法（`migrationsUpTo(53)` 先迁到旧版本 → 插入三行 `skill_library`：`preset://docx`、`https://github.com/x/y`、`plugin://io.github.a/b/c` → 再 `runMigrations(db, migrationsUrl('main'))` → 只有第一行被改写为 `plugin://com.kepcup/starter-skills/docx`，其余原样；`applied` 含 54）。同时核对 `public-skills-migration.test.ts` 的回拨重放不受影响（本迁移是纯 `UPDATE`，无需 `drop`）。

### 步骤 6：环境变量与打包

1. **桌面**：
   - `apps/desktop/src/main/core-host.ts`：删除 `presetSkillsEnv()` 与 `connectorsEnv()` 及其在环境合并处（约 l.178 一带）的调用，改为一个 `builtinPluginsEnv()`：`const dir = join(process.resourcesPath ?? '', 'plugins'); return existsSync(dir) ? { KEPCUP_BUILTIN_PLUGINS: dir } : {};`。若 `core-host` 有单测引用旧函数名，同步改（`rg -n "presetSkillsEnv|connectorsEnv" apps/desktop`）。
   - `apps/desktop/electron-builder.yml`：三个平台块（mac / win / linux）里各自的 `extraResources`，把 `resources/preset-skills → preset-skills` 与 `resources/connectors → connectors` **两条**换成一条 `- from: resources/plugins` / `to: plugins`，并把注释改写（`core-host 注入 KEPCUP_BUILTIN_PLUGINS 指向 Resources/plugins`）。**现状三个块里的条目并不齐**（核对命令 `rg -n "preset-skills|connectors" apps/desktop/electron-builder.yml` 的输出为准）——统一成**三个块都有**，并在实施记录写明原先缺哪个块。
   - `apps/desktop/scripts/dist.mjs`：不引用这两个目录（只注入发行门禁的 `define`），**无需改**；核对后在实施记录写明。
2. **headless 服务端**（Q9）：
   - 先建步骤 7 里的 `scripts/lib/builtin-connectors.mjs`（本步骤的过滤逻辑**直接写在 `pack-server.mjs` 里**，不另抽函数）；
   - `scripts/pack-server.mjs`：在 `pnpm deploy` 之后、「裁剪发行物」之前加一步 `3.6`：把 `apps/desktop/resources/plugins` 拷到 `${pkgDir}/plugins`；然后**按发行门禁过滤连接器**：读 `apps/desktop/connector-release-gates.json` 的 `approved`，对 `${pkgDir}/plugins/com.kepcup/connections/connectors/*/server.json`：`_meta['app.kepcup/connector'].hidden === true` 或 `releaseGate` 不在 `approved` 里 → 删该目录，并从 `${pkgDir}/plugins/com.kepcup/connections/plugin.json` 的 `contributions.connectors` 里去掉对应项。**server 是 tsc 产物，没有发行门禁的 esbuild `define`，不过滤就会把未放行条目带进 headless 构建**。
   - `apps/server/src/builtin-plugins.ts`（新，纯函数）`builtinPluginsEnv(distDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`：`env.KEPCUP_BUILTIN_PLUGINS` 已设 → 原样返回；否则若 `path.resolve(distDir, '..', 'plugins')` 存在 → 返回 `{ ...env, KEPCUP_BUILTIN_PLUGINS: 该路径 }`；否则原样返回。`apps/server/src/server.ts` 的 `createCoreServices({ …, env: … })` 改为 `builtinPluginsEnv(path.dirname(fileURLToPath(import.meta.url)), test.env ?? process.env)`（核对 `dist` 的实际布局：`server.js` 在 `package/dist/` 下则 `..` 即包根，以 `tar -tzf` 的输出为准）。**测试** `apps/server/test/builtin-plugins.test.ts`：三种情形（已设 / 同级 `plugins/` 存在 / 都没有）。
   - **验证**：`node scripts/pack-server.mjs --skip-web`（若 `apps/server/web/index.html` 不存在，先 `pnpm --filter @kepcup/desktop run build:web` 并按脚本提示设 `KEPCUP_WEB_OUTDIR`，或本地跳过该验证并在实施记录说明）；`tar -tzf release-server/kepcup-server-*.tar.gz | rg "plugins/"` 应含 `plugins/com.kepcup/starter-skills/…` 与**仅已放行**连接器（`notion linear atlassian sentry canva stripe cloudflare`，**不含** `gcalendar`、`gdrive`）。
3. **桌面端等价性**：`pnpm --filter @kepcup/desktop build` 通过；`KEPCUP_BUILTIN_PLUGINS` 未设时（`pnpm dev` / e2e）靠「向上查找」找到 `apps/desktop/resources/plugins`——核对 `resolveBuiltinPluginsDir` 的查找起点与 `core` 的 `dist` 位置兼容（原 `resolvePresetSkillsDir` 用的是同一套 `fileURLToPath(import.meta.url)` + 向上 8 层，**照抄**即可）。

### 步骤 7：脚本、READMEs 与文档同步

| 位置 | 改法 |
|---|---|
| `scripts/lib/builtin-connectors.mjs`（新） | `readBundledConnectorEntries(repoRoot)`：读 `apps/desktop/resources/plugins/com.kepcup/connections/plugin.json`，按 `contributions.connectors` 顺序读各 `server.json` 返回数组（纯 Node，无依赖） |
| `scripts/sign-connector-index.mjs`（l.46 `DEFAULT_CATALOG`） | 默认输入改用 `readBundledConnectorEntries`；`--extra-dir` 等其余行为不变。**本阶段不改索引格式 / 签名 / 路径**（Q4）。用 `node scripts/sign-connector-index.mjs --generate-dev-key <临时目录>` 生成一次性密钥后实跑一遍签名 + `--verify`，确认产物与改前**内容等价**（条目集合相同），把命令与结论写进实施记录 |
| `scripts/import-mcp-registry.mjs`（注释 l.10） | 注释里的目标路径改成「`apps/desktop/resources/plugins/com.kepcup/connections/connectors/<slug>/server.json`」；若脚本会直接写 `catalog.json`，改成写 `server.json` 并**同时提示手动把文件登记进 `plugin.json`**（读代码后按实际行为改，别猜） |
| `scripts/sync-mineru-skill.mjs`（l.5、14、29） | 目标路径改为 `apps/desktop/resources/plugins/com.kepcup/starter-skills/skills/mineru/SKILL.md`；注释里「bump catalog 的 version」改为「bump `plugin.json` 里该技能的 `version`」；README 引用路径同步 |
| `apps/desktop/resources/plugins/com.kepcup/starter-skills/README.md`、`…/connections/README.md` | 把原 `preset-skills/README.md`、`connectors/README.md` 里的目录布局、`catalog.json` 字段、环境变量、「如何新增一条」的步骤改写成新布局（新增预置技能 = 加 `skills/<id>/` + 在 `plugin.json` 加一项；新增连接器 = 加 `connectors/<slug>/server.json` + 图标 + 在 `plugin.json` 加一项 + 门禁登记） |
| `README.md` l.252、l.326；`README.zh-CN.md` l.252、l.326 | `NOTICE.md` 链接改为 `apps/desktop/resources/plugins/com.kepcup/starter-skills/NOTICE.md` |
| `docs/guides/add-connected-app.md`、`docs/dev/02-architecture.md`、`docs/design/29-connected-apps.md`（§16.1 表与 §16.4）、`docs/design/22-file-skill-routing.md`、`docs/design/17-mineru-document-parsing.md`、`docs/design/35-mail-channel.md`、`docs/design/40-capability-mounting.md` | 只改**描述当前路径 / 环境变量**的句子（`resources/connectors`、`resources/preset-skills`、`catalog.json`、`KEPCUP_CONNECTORS`、`KEPCUP_PRESET_SKILLS`）；设计 29 §16.4 的「精选清单空壳」段落改写为「已由插件市场承担（D104），空壳已删除」；**历史任务书**（`docs/dev/phases/*`、`todo/**`、`docs/dev/DEVIATIONS.md`、`docs/dev/PROGRESS.md` 的既往记录）**不改** |
| `packages/shared/src/domain/connector-catalog.ts` l.10、l.30 | 注释里的路径改写 |
| `infra/cloudflare/directory/README.md` l.53 | 「条目默认来自 …catalog.json」改为新位置 |

### 步骤 8：删除 `mcp-presets` 空壳

- 删：`apps/desktop/resources/mcp-presets/`（含 README）、`packages/core/src/mcp/presets.ts`、`packages/core/test/unit/mcp-presets-catalog.test.ts`；`rg -n "mcp-presets|mcp/presets|loadMcpPresetCatalog|mcpPresetCatalogSchema|KEPCUP_MCP_PRESETS" packages apps` 清掉其余引用（预期只有 `ExtensionMcp.svelte` 的注释）。
- `apps/desktop/src/renderer/src/lib/features/extension-center/ExtensionMcp.svelte` 注释里的「精选清单」句子删掉。
- 设计 29 §16.1 / §16.4 与 `todo/extension-center.md` 的描述按步骤 7 的规则同步（`todo/extension-center.md` 是历史任务书，**只在文件头补一行**「MCP 精选清单空壳已于 D104 删除，见设计 51」）。

### 步骤 9：e2e 与其余测试的夹具

e2e 三份规格各自用 env 指向临时目录；改成 `KEPCUP_BUILTIN_PLUGINS`。新增 e2e 助手 `apps/desktop/test/e2e/helpers/builtin-plugins.ts`：

```ts
/** 把随包的 resources/plugins 整份拷到临时目录；connectorSlugs 给了就只保留这些连接器（并同步改写 plugin.json）。返回临时 plugins 目录。 */
export async function copyShippedPlugins(dest: string, options?: { connectorSlugs?: string[]; skills?: 'all' | 'none' }): Promise<string>;
```

| 规格 | 改法 |
|---|---|
| `skill-market.spec.ts`（l.79 的 `KEPCUP_PRESET_SKILLS`） | 用 testkit 的 `buildBuiltinPluginsDir({ dir, skills: [...] })` 造临时目录，env 改 `KEPCUP_BUILTIN_PLUGINS` |
| `extension-center.spec.ts`（l.141–169：拷 shipped 的 `resources/connectors`、过滤出 Notion 条目、`KEPCUP_CONNECTORS`） | `copyShippedPlugins(dest, { connectorSlugs: ['notion'] })`，env 改 `KEPCUP_BUILTIN_PLUGINS`；第一个用例（空目录）保持「未设 env + 测试构建 → 目录为空」语义 |
| `connect-abort.spec.ts`（l.55–83） | 同上 |

其余规格不涉及；**全部相关 e2e 都跑一遍**（步骤验收里列了清单）。

## 5. 验收

- [ ] 步骤 1 的等价性核对完成（旧 catalog 与新 `server.json` 逐条相等；技能 `SKILL.md` 零内容改动，`git diff -M --stat` 全是 rename）。
- [ ] `rg -n "KEPCUP_PRESET_SKILLS|KEPCUP_CONNECTORS|resolvePresetSkillsDir|resolveConnectorsDir|readConnectorCatalogSource|resources/preset-skills|resources/connectors|mcp-presets" packages apps scripts infra --glob '!node_modules' --glob '!**/dist/**'` **无输出**（历史文档除外，文档范围见步骤 7）。
- [ ] 测试：`node scripts/run-tests.mjs run packages/core/test/unit/builtin-plugins.test.ts packages/core/test/unit/skills-presets.test.ts packages/core/test/unit/preset-skills-catalog.test.ts packages/core/test/integration/skill-presets.test.ts packages/core/test/unit/connector-catalog.test.ts packages/core/test/unit/connector-whoami.test.ts packages/core/test/unit/connector-tool-snapshots.test.ts packages/core/test/unit/local-connector-isolation.test.ts packages/core/test/unit/plugin-skill-source-migration.test.ts packages/core/test/unit/plugin-registry.test.ts packages/core/test/integration/plugins.test.ts apps/server/test` 全绿。
- [ ] 迁移后行为不变：预置技能仍**逐条**可装、`install_skill(preset_id)` 的 `skill_preset` 审批与 `<recommended_skills>` 段不变（`context-assembly` / 技能工具相关既有测试不回归：`node scripts/run-tests.mjs run packages/core/test/unit/skill-tools.test.ts packages/core/test/unit/context-assembly.test.ts`）；老库里 `preset://` 来源被改写后，预置技能显示「已添加」且 `foreign` 为假。
- [ ] 连接目录与发行门禁无回归：`node scripts/run-tests.mjs run packages/core/test/integration/catalog-connect.test.ts packages/core/test/unit/directory-merge.test.ts packages/core/test/unit/directory-sync.test.ts`。
- [ ] 打包：`pnpm --filter @kepcup/desktop build` 通过；`rg -n "preset-skills|resources/connectors" apps/desktop/electron-builder.yml` 无输出且三个平台块都有 `resources/plugins`；`pack-server` 的 tarball 清单符合步骤 6（含已放行连接器、不含 `gcalendar` / `gdrive`）。
- [ ] e2e：`pnpm build` 后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/skill-market.spec.ts test/e2e/extension-center.spec.ts test/e2e/connect-abort.spec.ts test/e2e/plugins.spec.ts test/e2e/narrow-layout.spec.ts` 全绿。
- [ ] 阶段收口**跑一次**全量 `pnpm test`；失败集合不超出基线。
- [ ] `docs/dev/PROGRESS.md` 验收表加一行「插件系统 P0b（D104）」。

## 6. 实施记录

### 实施记录（2026-10-26，P0b 全步骤完成）

**做了什么**（提交序）：

1. `refactor(plugins): move preset-skills and connectors into builtin plugin resource trees`——步骤 1：`apps/desktop/resources/{preset-skills,connectors}` 迁入 `resources/plugins/com.kepcup/{starter-skills,connections}`（技能目录 / NOTICE.md / 两份 README 全部 `git mv`，零内容改动；`catalog.json` 的 9 条连接器逐条拆成 `connectors/<slug>/server.json`，图标随条目入各目录；展示字段并入两份 `plugin.json`）。迁移脚本按任务书照抄运行后**已删除，未提交**。
2. `feat(plugins): BuiltinPlugins loader ...`——步骤 2：`plugins/builtin.ts`（`resolveBuiltinPluginsDir` env 覆盖 → 向上 8 层查找；`BuiltinPlugins.list/get/skillOffers/connectorSource/summaries`，每次调用重新读盘；`parsePluginManifestText` + 同步版贡献文件校验（无符号链接、无越界），坏插件 warn 跳过；不调 `assertInstallablePluginId`、不做 `checkPluginCompatibility`）；testkit `buildBuiltinPluginsDir` 夹具；11 例单测。
3. `feat(plugins): skill presets and connector catalog read the builtin plugins`——步骤 3+4：`SkillPresetsService` 去掉 catalog.json 读取、改 `builtin.skillOffers()`，`PRESET_SOURCE_PREFIX = 'plugin://com.kepcup/starter-skills/'`（install / foreign 判断沿用）；`paths.ts` 删 `resolvePresetSkillsDir`；`ConnectorCatalog` 不再自己读盘（`source` 由调用方注入，新增 `iconPaths`，`iconSvg` 先查它再回退旧 `iconsDir` 规则），`env` 选项删除；`PluginRegistry` 加 `builtin` 依赖（`list()` 内置摘要在前、`setEnabled` / `uninstall` 对内置 id 报 `INVALID_INPUT`）；`start.ts` 在 ConnectorCatalog/SkillPresetsService 之前构造 `BuiltinPlugins` 并接线；testkit `createTestCore` 未显式注入时把 `KEPCUP_BUILTIN_PLUGINS` 缺省指向测试 home 下的空目录（**自行判断点**：否则所有测试栈都会看到真实随包资源，`plugins.list` / 技能市场 / 连接目录全部不密闭）；`sign-connector-index.mjs` 默认输入改经 `scripts/lib/builtin-connectors.mjs`（`--catalog` 覆盖保留，`sign-connector-index.test.ts` 不受影响）；四份读真实 catalog 的测试与 `local-connector-isolation` 的默认输入断言改用 `test/support/shipped-connectors.ts` + `readBundledConnectorEntries` 互证；契约测试 `connector-catalog.contract.ts` 加可选 `iconPaths`（内置插件图标分散在各条目目录）。
4. `feat(plugins): migration 0054 ...`——步骤 5：`0054_plugin_skill_source.sql`（`preset://%` → `plugin://com.kepcup/starter-skills/{id}`，纯 UPDATE）；升级路径测试（53 → 三行样本 → 只有第一行改写，`applied` 含 54，重放为空操作）。
5. `feat(plugins): KEPCUP_BUILTIN_PLUGINS across desktop and headless server packaging`——步骤 6：core-host 两个旧 env 函数合并为 `builtinPluginsEnv()`；`electron-builder.yml` 三平台块统一 `- from: resources/plugins / to: plugins`；`pack-server.mjs` 加步骤 3.6（拷 `plugins/` 进包根 + 按发行门禁过滤连接器：删目录 + 改写 `plugin.json`）；`apps/server/src/builtin-plugins.ts` 的 `builtinPluginsEnv(distDir, env)`（已设 → 原样；`dist` 同级 `plugins/` 存在 → 注入；否则透传）接入 `server.ts`。
6. `chore(plugins): remove the unwired mcp-presets shell; docs and scripts ...`——步骤 7+8：删 `resources/mcp-presets/`、`core/src/mcp/presets.ts`、`mcp-presets-catalog.test.ts`；`ExtensionMcp.svelte` 注释、`todo/extension-center.md` 文件头、设计 29 §16.1/§16.4、设计 40 同步「空壳已删除，预置 MCP 由插件市场承担」；两份内置插件 README 按 `plugin.json` 布局改写；`import-mcp-registry.mjs` / `sync-mineru-skill.mjs` 目标路径与注释、`add-connected-app.md`、`02-architecture.md`、设计 17/29/35、shared `connector-catalog.ts` 注释、`infra/cloudflare/directory/README.md`、两份根 README 的 NOTICE 链接全部改到新位置（历史任务书与 `docs/dev/phases/*` 未动）。
7. `test(plugins): e2e specs inject builtin plugins ...`——步骤 9：新增 `test/e2e/helpers/builtin-plugins.ts` 的 `copyShippedPlugins(dest, { connectorSlugs, skills })`；`skill-market` 用 testkit `buildBuiltinPluginsDir`、`extension-center` / `connect-abort` 用 `copyShippedPlugins(dest, { connectorSlugs: ['notion'] })`（后者再把 Notion 远端改成本机 hold 端点），env 全部改 `KEPCUP_BUILTIN_PLUGINS`。
8. `test(plugins): isolate the plugins e2e spec from builtin summaries; lint cleanups`——DEV-052（见下）。

**迁移实际编号**：开工核对 `ls packages/core/migrations/main | tail -3` 为 `…0052_todo_pending_when.sql / 0053_plugins.sql`，与任务书一致，**实际编号 0054**（未被占用）。

**偏差与 DEV 编号**：**DEV-052**——步骤 9 称「其余规格不涉及」，但同一任务书 §1 的「`plugins.list` 多出两条只读内置插件」让 P0a-3 的 `plugins.spec.ts` 两处 `plugins-empty` 空态断言失效；处理 = 该规格 `launch()` 把 `KEPCUP_BUILTIN_PLUGINS` 指向空目录（断言零改动），已登记 DEVIATIONS。

**electron-builder.yml 原先各平台块的缺项**：**没有缺项**。核对（`rg -n "preset-skills|connectors" apps/desktop/electron-builder.yml`）确认 mac / win / linux 三块原先就各有 `preset-skills` 与 `connectors` 两条（任务书预警的「三个块里的条目并不齐」与本仓库现状不符），本次只是把每块两条换成一条 `resources/plugins`。

**`sign-connector-index.mjs` 实跑结论**（一次性 dev key，密钥在 `/tmp`、未入库）：`node scripts/sign-connector-index.mjs --generate-dev-key <tmp>` → `KEPCUP_CONNECTOR_SIGNING_KEY=<dev-key.pem> node scripts/sign-connector-index.mjs --out <tmp> --key-id dev-1 --keys <dev-keys.json>` 输出 `signed 9 entries (keyId=dev-1, entriesHash=88adf2ea…, deltas=0)`；`node scripts/sign-connector-index.mjs --verify <out> --keys <dev-keys.json>` 输出 `OK keyId=dev-1 … entries=9`；**等价性**：签名产物的 `index.entries` 与改前（`git show 5a2aa68b:apps/desktop/resources/connectors/catalog.json`）的 `connectors` 数组 `deepStrictEqual`（9 条，含 `_meta`）。

**pack-server 验证结果**：先 `KEPCUP_WEB_OUTDIR=… pnpm --filter @kepcup/desktop run build:web`（本地 `apps/server/web/` 原缺失），再 `node scripts/pack-server.mjs --skip-web` 成功（日志含「发行门禁过滤连接器：gcalendar / gdrive」）。tarball（`release-server/kepcup-server-v0.4.0-darwin-arm64.tar.gz`）清单：`plugins/com.kepcup/starter-skills/`（plugin.json + 9 个技能目录 + NOTICE + README）、`plugins/com.kepcup/connections/` 含**恰好 7 个**连接器目录（notion linear atlassian sentry canva stripe cloudflare），`gcalendar` / `gdrive` 文件与 manifest 条目均不在（改写后的 `plugin.json` 只剩 7 条）。

**「清单里的技能目录被删后跳过」语义变化（自行判断点）**：旧 catalog 时代坏目录只跳过那一条目；D104 起清单与贡献文件由 `BuiltinPlugins` 统一校验，贡献缺失 = 整个插件不可信 → warn 并跳过该插件（fail-closed，`skills-presets.test.ts` 对应用例按此改写为「市场为空」，其余断言原样）。`#resolveAll` 内的逐条防御（SKILL.md 缺失 / parse 失败跳过该条）保留。

**验收证据**（全部真实执行）：

- 步骤 1 等价性核对：旧 `catalog.json`（`git show HEAD:…`）与新目录按 `plugin.json` 顺序读出的 9 个 `server.json` 逐条 `deepStrictEqual`；旧 `presets` 9 条与新 `plugin.json` 展示字段（displayName/summary/icon/section/version/tryIt/vendored + `dir = skills/<id>`）逐字段相等；`git diff -M --cached --name-status` 除 `catalog.json` 与 `icons/*` 删除（内容分别进了 server.json 与各条目目录）外**全部为 R100 rename**，`SKILL.md` 零内容改动。`pnpm exec prettier --check` 通过。
- 残留检查：`rg -n "KEPCUP_PRESET_SKILLS|KEPCUP_CONNECTORS|resolvePresetSkillsDir|resolveConnectorsDir|readConnectorCatalogSource|resources/preset-skills|resources/connectors|mcp-presets" packages apps scripts infra --glob '!node_modules' --glob '!**/dist/**'` **无输出**（本机 `apps/desktop/release/*` 的陈旧打包产物已删除）。
- 定向测试：`node scripts/run-tests.mjs run` 验收清单 12 项（builtin-plugins、skills-presets、starter-skills-plugin〔原 preset-skills-catalog 改名〕、integration/skill-presets、connector-catalog、connector-whoami、connector-tool-snapshots、local-connector-isolation、plugin-skill-source-migration、plugin-registry、integration/plugins、apps/server/test）→ **17 文件 187 例全绿**；行为回归（skill-tools、context-assembly、catalog-connect、directory-merge、directory-sync）+ `sign-connector-index` → **6 文件 119 例全绿**。
- 迁移后行为不变：`skills.presets.*` / `install_skill(preset_id)` / `<recommended_skills>` 相关的 skill-tools + context-assembly 全绿；迁移测试覆盖 `preset://` 行改写、其余行不动；`foreign` 判定沿新前缀（skills-presets 同名非预置用例 foreign=true、预置安装 upToDate/foreign=false 用例原样通过）。
- 打包：`pnpm typecheck`（shared → package-guard → core build → 各包）全过；`pnpm build`（`pnpm -r build`，含 desktop electron-vite）通过；`rg -n "preset-skills|resources/connectors" apps/desktop/electron-builder.yml` 无输出且三平台块各有 `resources/plugins`；`apps/desktop/scripts/dist.mjs` 核对不引用这两个目录（只注入门禁 define），未改。
- e2e（`pnpm build` 后）：`skill-market` 1 + `extension-center` 2 + `connect-abort` 1 + `plugins` 8 + `narrow-layout` 2 = **14 例全绿**（合并跑一次；`plugins` 因 DEV-052 的隔离改动单独复核 8/8 通过后纳入合并跑）。
- 全量 `pnpm test`（阶段收口一次）：**634 文件：632 通过 / 2 跳过；6678 用例通过 / 37 跳过 / 0 失败（Duration 196.91s）**。失败集合为空，不超出 PROGRESS.md 基线（含 P0a-3 记录过的 `memory.test.ts` 负载型偶发——本轮未复现）。
- `pnpm lint`（本阶段全部新增 / 改动文件）：0 error 0 warning（修复过程中 eslint 报过的两处未使用 import 已清）。

**遗留问题**：

- `pnpm deploy` 会把 `@kepcup/core` 的 `test/` 一并打进 headless tarball 的 `node_modules`（本轮 tar 清单可见），属 pack-server 既有行为（与 P0b 无关），未处理。
- dev / e2e 里 testkit `createTestCore` 的内置插件缺省为空目录是测试密闭性选择；需要随包内容的测试显式注入（如 `starter-skills-plugin` 守护测试直接读仓库资源）。
- 签名目录通道的正式 CI 签名输入（`infra/cloudflare/sign-directory.sh` → 脚本）走同一默认（`readBundledConnectorEntries`），行为不变；线上重签由发版流程触发，本阶段不涉及。

### 审查修正（2026-10-26，独立审查轮）

独立审查（对照 `5a2aa68b..HEAD`）复核结论：内容等价性与行为不变性成立（旧 catalog 9 条与新 `server.json` 逐条 `deepStrictEqual`、SKILL.md 全部 R100 零改动、`plugin.json` 展示字段逐字段相等、`#resolveAll` 只换数据源、迁移 0054 纯 UPDATE）。修正以下问题（提交 `fix(plugins): review - …`）：

1. **lint**：`apps/catalog.ts` 删除 `readConnectorCatalogSource` 后残留未用的 `existsSync` import（本阶段引入的 eslint error，`pnpm lint` 全仓失败）；顺手把 `start.ts` 的 `ConnectorsProjector` 改 `import type`（基点即有的 type-only 误用）。修后 `pnpm lint` **全仓 0 error**。
2. **prettier**：本阶段新增/改动的 30 个「基点时 prettier-clean」文件被重新格式化（含 `builtin-plugins-fixture.ts` 第 38 行 `{  const root` 的换行丢失）；基点即不干净的 6 个文件（`presets.ts`、`start.ts`、`skills-presets.test.ts`、`testkit/fixtures.ts`、`apps/server/src/server.ts`、`scripts/sync-mineru-skill.mjs`）按 P0a-3 审查先例保持原样。§6 早前「`pnpm exec prettier --check` 通过」的记录只对 resources/（prettier-ignore）成立，代码文件此前并不干净——以本节为准。
3. **文档**：`docs/dev/03-data-model.md` 迁移表按惯例补 `0054_plugin_skill_source.sql` 一行（该表每迁移一行，0053 之后缺 0054）；`connections/README.md` 的「`approved: []`」改为如实描述（随包文件已有 7 项放行，原句沿自旧 README 的过期写法并与同句「已放行」矛盾）。
4. **证据复核**：任务书 §5 的 rg 残留命令复跑无输出；pack-server 重跑 tarball 清单复核（starter-skills 全量 + 恰好 7 家已放行连接器、gcalendar/gdrive 不在）；定向测试与 e2e 五规格重跑全绿（见下）。

审查重跑证据：§5 定向 12 项 + 行为回归 6 项全绿；`pnpm --filter @kepcup/core typecheck`、desktop typecheck 通过；`pnpm build` 后 e2e 五规格 14 例全绿；`pnpm lint` 全仓通过。
