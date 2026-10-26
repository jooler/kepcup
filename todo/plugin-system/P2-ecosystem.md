# P2 · 生态工具：`package-guard` 写入、`kepcup-app` 插件校验 / 脚手架 / 打包、headless 本地安装 CLI

> 状态：**待实施**。依赖：P0a-2（P1 可并行）。分支：`feat/plugins/p2-ecosystem`。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §11（开发者体验）、§6.2（headless 本地安装）、§14 开放问题 5、7。

## 1. 目标

交付后：

1. **第三方开发者不读源码**就能：`kepcup-app init plugin <dir>` 生成骨架 → 编辑 → `kepcup-app validate <dir | .kepcup>` 本地自检（离线、`--json` 可机读）→ `kepcup-app pack <dir>` 产出**可复现**（同输入逐字节相同）的 `.kepcup`；
2. headless 服务端用户能 `kepcup-server plugin install <路径>` 在服务器本机安装插件（web 外壳没有本地文件选择器，这是它唯一的本地安装入口）。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| `@kepcup/package-guard`：`buildZipBuffer`（写）与 `extractZip`（共享的安全解包）；core 的 `PluginPackager` 改用 `extractZip`（**独立重构提交**） | 市场审核流水线、提交流程（P3） |
| 把 `isSafeDirectoryRemoteUrl` 挪进 shared（core 里 re-export；**独立重构提交**） | 对 Claude / Cursor 插件目录的导入、智能体 / settings 贡献的评估 |
| `kepcup-app`：`validate` 的插件模式（离线）、`init plugin`、`pack`；`plugin.*` 检查项与 README 锚点；开发者指南 | 在线探测连接器远端（插件模式下连接器的**联网**校验仍用既有 `kepcup-app validate <server.json> --auth`） |
| `kepcup-server plugin install` + `/admin/plugins/*` | `plugin list / uninstall`（网页「已安装」页已覆盖） |

## 3. 开工前核对

```bash
git status --short && git log --oneline -5
ls packages/package-guard/src packages/app-validator/src packages/app-validator/src/checks apps/server/src
rg -n "isSafeDirectoryRemoteUrl" packages apps scripts --glob '!**/dist/**' --glob '!node_modules'
rg -n "command ===|command:" apps/server/src/config.ts | head
sed -n 1,40p packages/app-validator/test/readme-anchors.test.ts
rg -n "toEqual\(\{" packages/app-validator/test/cli.test.ts | head -5       # 整个报告 toEqual 的地方：加 mode 字段时要同步
```

必读：`packages/package-guard/src/zip.ts`（P0a-1 成果）、`packages/core/src/plugins/package.ts`（解包部分）、`packages/testkit/src/mcpb-fixture.ts` 的 `buildZip`（**写入器的参照实现**，CRC / deflate / Unix 模式的写法）、`packages/app-validator/src/{cli,args,validate,types,report}.ts`、`checks/manifest.ts`（`checkManifest`）、`packages/app-validator/README.md` 与 `test/readme-anchors.test.ts`、`apps/server/src/{cli,config,admin,server}.ts`、`apps/server/test/server-integration.test.ts`、`packages/core/src/apps/directory-merge.ts`（`isSafeDirectoryRemoteUrl`）。

## 4. 步骤

### 步骤 1：`package-guard` 的写入与共享解包（含 core 改用，独立重构提交）

**1.1 写入器**（`packages/package-guard/src/zip-writer.ts`，从 `index.ts` 导出）：

```ts
export interface ZipWriteEntry {
  name: string;                 // 相对 POSIX 路径；目录以 '/' 结尾；写入前一律过 safeEntryPath
  data?: Uint8Array;            // 文件内容；目录省略
  mode?: number;                // Unix 权限位（只认 0o755 / 0o644 两档：含任一可执行位 → 0o755，否则 0o644）
}
/** 生成 zip 字节。**确定性**：条目按 name 字典序排序、时间戳固定为 1980-01-01 00:00（DOS 日期 0x0021、时间 0）、压缩级别固定。 */
export function buildZipBuffer(entries: readonly ZipWriteEntry[], options?: ZipGuardOptions): Buffer;
```

规则：条目名过 `safeEntryPath`；大小写折叠后重名 → 报错；条目数 ≤ `ZIP_MAX_ENTRIES`、单条目 ≤ `ZIP_MAX_ENTRY_BYTES`、总未压缩 ≤ `ZIP_MAX_UNPACKED_BYTES`、成品 ≤ `ZIP_MAX_FILE_BYTES`（任一超限报错）；非空文件用 `deflateRawSync(data, { level: 9 })`，空文件与目录用 stored；写 Unix "version made by"（host 3）与 `external attrs = mode << 16`；**不写符号链接、不写 ZIP64、不加密**；本地头 / 中央目录布局照 `testkit/src/mcpb-fixture.ts` 的 `buildZip`（读它，**复制其字节布局，不要自己发明**），UTF-8 名标志位 `0x0800`。

**1.2 共享解包**（`packages/package-guard/src/extract.ts`）：

```ts
/** 把已打开的 archive 安全解到 destDir（destDir 必须已存在且为空目录或不存在）。逐条目：safeEntryPath、拒绝符号链接与大小写重名、目录 mkdir、文件 writeFile（mode 只留 0o755 / 0o644）、目标路径必须 resolve 后仍在 destDir 内。 */
export function extractZip(archive: ZipArchive, destDir: string, options?: ZipGuardOptions): Promise<{ files: number; bytes: number }>;
```

**1.3 测试**（项目 `package-guard`）：`zip-writer.test.ts`——往返（写 → `ZipArchive.open` 读，内容 / 模式 / 目录一致）、**确定性**（同输入两次逐字节相同；改变输入顺序结果相同）、各拒绝项（`../x`、重名、超限用**小的可覆盖上限参数**不实际造大包——给 `ZipGuardOptions` 加可选 `limits?: Partial<{ maxEntries; maxEntryBytes; maxUnpackedBytes; maxFileBytes }>`，默认取 `ZIP_MAX_*` 常量；**写入器与 P0a-1 里的读取器都改为从该选项取上限**，读取器的既有行为（不传 = 常量）与测试不变，测试传小值）；`extract.test.ts`——正常解包、恶意条目被拒且目标目录外无落盘、重名、符号链接、模式位清洗。

**1.4 core 改用**（独立提交 `refactor(plugins): use package-guard extractZip`）：`PluginPackager.stage` 里 file 来源的「解包到 staging」部分改调 `extractZip`；**`plugin-package.test.ts` 与 `plugins.test.ts` 零改动全绿**。

### 步骤 2：把 `isSafeDirectoryRemoteUrl` 挪进 shared（独立重构提交）

`packages/core/src/apps/directory-merge.ts` 里的 `isSafeDirectoryRemoteUrl` 逐字挪到 `packages/shared/src/domain/connector-catalog.ts`（紧挨 `isSafeSkillSourceUrl`，保留中文注释），从 shared 导出；`directory-merge.ts` 改为 `import { isSafeDirectoryRemoteUrl } from '@kepcup/shared'` 并 `export { isSafeDirectoryRemoteUrl }`（**保持原导出名**，所有 core 内调用方与测试不用改）。`directory-merge.test.ts` 里关于它的用例**复制一份**到 `packages/shared/test/unit/connector-catalog.test.ts`（原处保留）。验证：`pnpm --filter @kepcup/shared run build`，`node scripts/run-tests.mjs run packages/core/test/unit/directory-merge.test.ts packages/shared/test/unit/connector-catalog.test.ts`。

### 步骤 3：`kepcup-app` 的命令与参数

`packages/app-validator/src/args.ts`：`ParsedArgs` 增三种命令（**不破坏 `validate <server.json | URL>` 的既有行为**）：

| 命令 | 形态 |
|---|---|
| `validate <target>` | `target` 是 **目录**（含 `plugin.json`）或 **以 `.kepcup` 结尾的文件** → 插件模式；否则走既有的连接器模式（路径 / https URL）。判定在 `validate.ts` 入口按 `target` 做（`stat` 是目录 / 后缀 `.kepcup`），不新增参数 |
| `init plugin <dir> [--id <id>] [--name <名称>] [--force]` | 生成骨架；`--id` 缺省 `io.github.your-name/{目录名小写}`；`--name` 缺省目录名 |
| `pack <dir> [--out <文件>] [--json]` | 先做与 `validate` 相同的校验，**有 error 则中止**；输出默认 `{id 里 / 换成 __}-{version}.kepcup` 到当前目录 |

`USAGE` 文本同步（英文，写法同现有）。`--help` / `--version` 行为不变。`cli.ts` 的 `runCli` 按 `parsed.command` 分发到 `validate` / `initPlugin` / `packPlugin`（后两个放新文件 `plugin/init.ts`、`plugin/pack.ts`；`plugin/validate.ts` 放插件校验）。**测试**：`args.test.ts`（若不存在则并入 `cli.test.ts`）补新命令的解析与错误；既有解析用例零改动。

### 步骤 4：插件模式 `validate`（离线）

`packages/app-validator/src/plugin/validate.ts`：`validatePlugin(target: string, options): Promise<ValidationReport>`。**全部离线**，不联网、不执行包内任何代码。

1. **取得目录**：目录输入 → 直接用（先做目录遍历检查：拒绝符号链接 / 逃逸 / 超限，**同 core `PluginPackager.stage(folder)` 的规则**，用 `package-guard` 的常量）；`.kepcup` 输入 → `ZipArchive.open` + `extractZip` 解到 `mkdtemp` 临时目录（`finally` 清理）。
2. **清单**：读 `plugin.json` → `pluginManifestSchema.safeParse`（`@kepcup/shared`）。
3. **检查项**（id 一律 `plugin.<区域>-<含义>`，**单点号**——`readme-anchors.test.ts` 的正则靠它；严重度、触发条件如下）：

   | id | 严重度 | 条件 |
   |---|---|---|
   | `plugin.manifest-read` | error | `plugin.json` 缺失 / 超过 64KB / 非 JSON |
   | `plugin.manifest-format` | error | `format_version` 大于 1 |
   | `plugin.manifest-schema` | error | schema 校验失败（`message` 取前 3 条 issue，`subject` = 路径） |
   | `plugin.manifest-namespace` | error | `id` 命名空间是保留的（`isReservedPluginNamespace`） |
   | `plugin.manifest-metadata` | warn | 缺 `description` / `author` / `homepage` / `engines` 之一（各一条，`hint` 说明作用） |
   | `plugin.readme` | warn | 缺 `README.md` |
   | `plugin.files-path` | error | 贡献引用的文件 / 目录缺失、类型不对、是符号链接、realpath 逃逸 |
   | `plugin.files-limits` | error | 条目数 / 单文件 / 总大小超过 `package-guard` 的上限 |
   | `plugin.package-entries` | error | 仅 `.kepcup` 输入：zip 层问题（不安全路径 / 符号链接 / 重名 / 加密 / ZIP64）；`message` 取守卫抛的文案 |
   | `plugin.skill-frontmatter` | error | 技能目录的 `SKILL.md` 没有开头的 `---` frontmatter 块，或块里缺 `name:` / `description:` 键（**只做轻量文本检查**，不引入 YAML 依赖；完整解析与沙箱兼容扫描在安装时由 KepCup 执行，`hint` 写明） |
   | `plugin.connector-entry` | error | 对每个连接器文件调**既有** `checkManifest(raw)`（`checks/manifest.ts`），把其中 `severity: 'error'` 的检查原样转成本项（`subject` 加文件路径前缀）；`warn` 同样转发 |
   | `plugin.connector-packages` | error | 连接器条目的 `packages` 非空（插件里的本地执行只能走 `mcp` 贡献） |
   | `plugin.connector-remote` | error | 任一 `remotes[].url` 不满足 `isSafeDirectoryRemoteUrl` |
   | `plugin.connector-icon` | error | `icon` 文件不在 `server.json` 同目录 |
   | `plugin.mcpb-package` | error | 内嵌 `.mcpb`：不是合法 zip、缺 `manifest.json`、`manifest_version` 不在 0.1 / 0.2 / 0.3、`server.entry_point`（非 `uv` 类型）指向的文件不在包内；`info` 另给出提示「完整校验在安装时执行」 |
   | `plugin.mcp-http` | error | `http` 贡献的 `url` 不满足 `isSafeDirectoryRemoteUrl`；另给一条 `info`「需要 OAuth 的远端请改做连接器贡献」 |
   | `plugin.mail-host` | error | 邮件模板的 host 是 IP 字面量 / `localhost` / 不含点 / 内网后缀（`.local .internal .lan …` 规则同 `isSafeSkillSourceUrl` 的主机部分） |
   | `plugin.permissions` | info | 汇总推导出的权限（主机、OAuth 范围、MCPB 与其 `user_config` 字段名、邮件模板）——这就是用户在同意卡上会看到的东西 |

4. **报告**：沿用 `ValidationReport`（`types.ts`），新增可选字段 `mode: 'connector' | 'plugin'`（连接器模式补 `mode: 'connector'`；**`schemaVersion` 仍为 1**，只加字段）；`target` 为用户给的参数；`remote: null`、`auth: false`；`exitCode` 规则同前（有 error → 1）。`formatReport` 文本输出沿用。**既有测试若对整份报告 `toEqual`**：只补 `mode` 字段，不改其它断言，并在实施记录列出改了哪些。
5. **README 与锚点**：`packages/app-validator/README.md` 增「Plugin mode」一节（用法、`init` / `pack`、上表全部检查项）；每个新 id 一个 `<a id="plugin-manifest-read">` 形式的锚点（`docAnchor` 把 `.` 换成 `-`，参照 README 里既有锚点写法）；`test/readme-anchors.test.ts` 的正则 `(?:manifest|remote|auth|tool|tools|ui|mcp)` 里加 `plugin`，使新增 id 的锚点同样被强制。
6. **测试**（`packages/app-validator/test/plugin-validate.test.ts`，夹具用 `@kepcup/testkit` 的 `buildPluginDir` / `buildPluginFixture`，相对路径引入同 `support.ts`）：合法插件（含技能 / 连接器 / http / mcpb / mail）零 error；上表**每个 id 至少一个触发用例**与一个不触发用例；`.kepcup` 与目录两种输入对同一内容得到相同的检查集合（除 `plugin.package-entries`）；恶意 `.kepcup`（`../x`、符号链接）→ `plugin.package-entries`；`--json` 输出可被 `JSON.parse` 且 `mode === 'plugin'`、`schemaVersion === 1`；连接器条目的错误经 `plugin.connector-entry` 带文件路径转发；不联网（用 `vi.stubGlobal('fetch', …)` 断言零调用）。

### 步骤 5：`init plugin` 与 `pack`

**`init plugin <dir>`**（`plugin/init.ts`）：目标目录已存在且非空且无 `--force` → 报错退出 2；写入：

```text
{dir}/plugin.json            # format_version 1、id、name、version "0.1.0"、description "TODO"、engines.kepcup ">=0.4.0"、contributions.skills = [{ "dir": "skills/hello" }]
{dir}/README.md              # 骨架：这是什么 / 贡献了什么 / 如何本地安装与打包（指向 kepcup-app validate / pack）
{dir}/skills/hello/SKILL.md  # frontmatter name: hello / description: …；正文一段示例
```

`--id` 必须通过 `pluginIdSchema` 且不是保留命名空间，否则报错；文本字段写入前不做模板拼接以外的处理。**测试**：生成的骨架能被 `validatePlugin` 校验为**零 error**（`manifest-metadata` 的 warn 允许）；已存在目录的保护与 `--force`；非法 `--id`。

**`pack <dir>`**（`plugin/pack.ts`）：① `validatePlugin(dir)`，有 error → 打印报告、退出 1、不产出文件；② 收集文件：遍历目录，**排除** `.git/`、`node_modules/`、`.DS_Store`、`*.kepcup`、`.kepcup-ignore` 自身与其中列出的路径（`.kepcup-ignore` 是可选文件，每行一个相对路径或 `目录/`，`#` 注释；**只支持精确路径与目录前缀，不支持通配符**）；遇到符号链接 → 报错退出 1；③ `buildZipBuffer`（步骤 1），`mode` 取源文件的可执行位；④ 写到 `--out`（缺省见上，已存在则覆盖）；⑤ 打印 `path`、`sha256`、大小（`--json` 输出对象）；⑥ **打包后自检**：用 `package-guard` 读回、`extractZip` 到临时目录再 `validatePlugin`，必须零 error。**测试**：同一目录两次打包 sha256 相同；改变文件遍历顺序（用 `fs` 的不同创建顺序）结果相同；排除规则（含 `.kepcup-ignore`）；符号链接被拒；有 error 的目录不产出文件；产物能被 core 的 `PluginPackager.stage({ kind:'file' })` 接受（`packages/core/test/unit/plugin-pack-compat.test.ts`：从 `@kepcup/app-validator` 的构建产物或源码引入 `packPlugin`——`core` 测试跨包相对路径引入 `../../../app-validator/src/plugin/pack.js`，**照 `app-validator/test/support.ts` 引 testkit 的相对路径做法**）。

### 步骤 6：开发者指南

新建 `docs/guides/write-a-plugin.md`（中文）：插件是什么（声明式、无代码执行）→ 目录结构与 `plugin.json` 字段（对照设计 51 §3，示例完整）→ 四类贡献各一个最小例子（技能、连接器、内嵌 MCPB、http MCP、邮件模板）→ 工作流：`kepcup-app init plugin` → 编辑 → `kepcup-app validate` → 本地「从文件夹安装」调试 → `kepcup-app pack` → 分发（本地安装 / 等待市场收录）→ 信任分级与同意卡会展示什么 → 常见错误（对照 `plugin.*` 检查项）。`docs/guides/` 里若有索引文件则登记。

### 步骤 7：headless `kepcup-server plugin install`

现状：`kepcup-server pair / devices` 是**运行中服务**的本机 `/admin/*` 接口（仅环回 + Bearer token，`apps/server/src/admin.ts`）的薄客户端，token 在数据目录的 `admin-token`。插件安装照同一模式。

1. **`config.ts`**：新增命令 `plugin`：`kepcup-server plugin install <路径> [--yes] [--config <json 文件>] [--json]`（沿用 `--data-dir` / `--port` 等既有选项解析方式）；`ServerConfig` 的 `command` 联合加 `'plugin'`，并带 `pluginAction: 'install'`、`pluginPath: string`、`pluginYes: boolean`、`pluginConfigFile: string | null`；路径缺失 / 子命令不是 `install` → `ConfigError`。`usageText()` 同步。
2. **`admin.ts`**：`isAdminPath` 加 `/admin/plugins/inspect`、`/admin/plugins/install`；`AdminDeps` 加 `pluginsInspect(input: unknown): Promise<unknown>`、`pluginsInstall(input: unknown): Promise<unknown>`；两个端点都是 `POST` + JSON 体（沿用现有的 `readJson` 与 64KB 上限），环回 + token 校验在 `handleAdminRequest` 顶部**已统一**，不要绕过；处理器 `await` 对应 deps，成功 `200 + JSON`，`AppError` → `400 { error: message, code }`，其它 → `500 { error: 'internal' }`。`createAdminClient(port, token)` 加 `pluginsInspect(source)` / `pluginsInstall(input)` 两个方法。
3. **`server.ts`**：构造 `AdminDeps` 处加两项：`pluginsInspect: (body) => services.appMethods['plugins.inspect']!.handle(pluginsInspectInputSchema.parse(body))`、`pluginsInstall: (body) => services.appMethods['plugins.install']!.handle(pluginsInstallInputSchema.parse(body))`（直接调 `handle`，**不经 RPC 层，因此 `currentRemoteSource()` 为 null，`file` / `folder` 来源被允许**——这是预期：调用者在服务器本机且持有 admin token）。方法不存在（core 未带插件）→ `AppError('NOT_IMPLEMENTED')`。
4. **`cli.ts`**：`config.command === 'plugin'`：`path.resolve(pluginPath)`；`stat` 判断目录 / 文件 → `source = { kind: 'folder' | 'file', path }`；`inspect` → 打印摘要（插件名 / 版本 / 分级 / 包 sha256；技能名；MCP 的启动命令与运行时状态；连接器的主机与范围；邮件模板；`conflicts` 与 `blockers`；`developer` 级的「未审核」警示）；`installable === false` → 打印原因、退出 1；需要的 `user_config`：对每个 `mcpb` 的必填字段，若 `--config` 文件（`{ "<mcpId>": { "<key>": 值 } }`，用 `userConfig` 的值 schema 校验）没有给 → 列出缺失键并退出 1（**不在终端里交互输入敏感值**）；确认：`--yes` 直接继续，否则 TTY 下提示 `继续安装？[y/N]`（`readline/promises`，同 `ensureAdminAccount` 的用法），非 TTY 又没给 `--yes` → 退出 1 并提示；`install`（带 `sha256`）→ 打印结果（`--json` 输出 `plugins.install` 的返回）。`--config` 文件内容**不得**出现在任何日志 / 错误输出里。
5. **测试**：`apps/server/test/config.test.ts` 补 `plugin install` 的解析与错误；`apps/server/test/admin-plugins.test.ts`（假 `AdminDeps`）：非环回 → 403、错 token → 401、两个端点的成功 / `AppError` 映射 / 体积上限；`apps/server/test/server-integration.test.ts` 补（照其现有起服务器的写法）：起带 core 的服务 → 用 `buildPluginFixture` 的 `.kepcup` 经 `createAdminClient` 调 `pluginsInspect` + `pluginsInstall` → `plugins.list`（经 `/rpc` 或 core 句柄）出现该插件；**经远程端点（`/ws` viewer）调同样的 `file` 来源仍被拒**（回归 P0a-2 的远程守卫）；CLI 的摘要渲染抽成纯函数 `formatPluginInspection(info): string` 单测。
6. `apps/server/README.md` 加「安装插件」一节（命令、`--config` 格式、安全说明：仅本机、需 admin token、网页端没有本地文件入口）。

## 5. 验收

- [ ] 两个重构提交（`package-guard` 解包、`isSafeDirectoryRemoteUrl` 挪动）独立，各自原有测试**零改动**全绿。
- [ ] 新测试全绿：`node scripts/run-tests.mjs run packages/package-guard packages/app-validator packages/shared/test/unit/connector-catalog.test.ts packages/core/test/unit/plugin-pack-compat.test.ts packages/core/test/unit/plugin-package.test.ts apps/server/test`。
- [ ] **端到端手工链路**（把命令与输出要点写进实施记录）：`node packages/app-validator/dist/cli.js init plugin /tmp/demo-plugin --id io.github.test/demo` → `validate /tmp/demo-plugin`（零 error）→ `pack /tmp/demo-plugin --out /tmp/demo.kepcup`（打印 sha256）→ 再 `pack` 一次 sha256 相同 → `validate /tmp/demo.kepcup`（零 error）→ 桌面应用「从本地安装…」装上它；headless：`kepcup-server plugin install /tmp/demo.kepcup --yes` 成功。
- [ ] `kepcup-app validate <server.json>`（连接器模式）的既有测试与行为不变（只多了 `mode` 字段）。
- [ ] `pnpm --filter @kepcup/app-validator build`、`pnpm --filter @kepcup/package-guard build`、`pnpm --filter @kepcup/server run build` 通过；`pnpm typecheck` 通过。
- [ ] `docs/guides/write-a-plugin.md` 与 `packages/app-validator/README.md` 已写；`docs/dev/PROGRESS.md` 加行「插件系统 P2（D104）」。
- [ ] 阶段收口**跑一次**全量 `pnpm test`；失败集合不超出基线。

## 6. 实施记录

（执行智能体在最后一个提交里填写：做了什么 / 偏差与 DEV 编号 / 既有测试因 `mode` 字段改动的清单 / 手工链路结果 / 遗留问题。）
