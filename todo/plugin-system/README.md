# 插件系统（Plugin System）实施编排 · 总览

> 状态：**已完成（2026-10-28）**。P0a-1 → P2 全部阶段已交付并合入 `v0.5.0`，随后的商店化
> （内置插件清空、连接器目录通道下线、扩展中心 3 页签）亦已落地，见 [docs/dev/PROGRESS.md](../../docs/dev/PROGRESS.md)。
> **本目录已被 [todo/plugin-platform/](../plugin-platform/README.md) 取代**：插件系统的下一轮迭代
> （能力类型注册表、实例与配置、注入模型、开发文档）以新任务书为准；本目录保留为第一期实施记录，
> 其固定契约（`plugins` / `plugin_items` 表、`plugins.*` RPC、`PLUGIN_*` 错误码）继续有效。
> 早期阶段：不做向后兼容、不迁旧数据（唯一例外是 P0b 的 `preset://` → `plugin://` 一次性迁移）；一切以语义准确、逻辑正确为准。

| 阶段 | 文件 | 交付 | 依赖 |
|---|---|---|---|
| P0a-1 | [P0a-1-foundation.md](P0a-1-foundation.md) | `@kepcup/package-guard` 抽包、shared 契约、迁移 `0053`、`AppPaths.pluginsDir`、testkit 夹具、包暂存管线（zip / 目录 → 校验 → staging） | 无 |
| P0a-2 | [P0a-2-projection.md](P0a-2-projection.md) | 账本 store、技能 / MCP / 连接器投影器、`McpbInstaller` 与 `ConnectorCatalog` 改造、`PluginRegistry`、守卫、RPC、`start.ts` 接线 | P0a-1 |
| P0a-3 | [P0a-3-ui.md](P0a-3-ui.md) | 扩展中心「已安装」页签、同意面板、本地安装对话框、来源徽标与插件管理项锁定、i18n、e2e | P0a-2 |
| P0b | [P0b-builtin.md](P0b-builtin.md) | 内置插件加载器、preset-skills / connectors 迁入、`KEPCUP_BUILTIN_PLUGINS`、打包（桌面 + server）、`preset://` 迁移、`mcp-presets` 删除 | P0a-2（UI 无依赖） |
| P1-1 | [P1-1-marketplace-core.md](P1-1-marketplace-core.md) | 签名索引共享模块（`SignedIndexSync` 抽取）、市场同步与下载、市场来源安装、撤销名单、自托管公钥、设置条目、签名脚本、基础设施交接 | P0a-2 |
| P1-2 | [P1-2-updates.md](P1-2-updates.md) | 更新流（权限差异再同意、server id 稳定、`autoApprove` 重置、端点变化断连、崩溃回滚、本地同 id 重装 = 更新）、`McpbInstaller` 的替换模式 | P1-1 |
| P1-3 | [P1-3-marketplace-ui-bot.md](P1-3-marketplace-ui-bot.md) | 「市场」页签与更新 UI、`plugin_search` / `plugin_request_install` + `confirm-plugin-install`、邮件预填模板 | P1-2、P0a-3 |
| P2 | [P2-ecosystem.md](P2-ecosystem.md) | `package-guard` 写入、`kepcup-app` 的 `validate`（插件）/ `init plugin` / `pack`、headless `kepcup-server plugin install` | P0a-2（P1 可并行） |

**P3（服务端提交 / 审核）不在本任务书范围**：设计 51 §11 已写明它与 developer-portal 的约束冲突，需先单独做设计。
也**不做**：智能体贡献、settings 贡献、读取 Claude / Cursor 插件目录（设计 51 §14 开放问题 2、6，P2 仅「评估」，本任务书不含评估工作）。

## 0. 一句话目标

扩展中心的技能 / 连接 / MCP / 邮件模板以**声明式插件包**（`*.kepcup`：zip，包根 `plugin.json` + 各类贡献）补充：插件**不含任何在宿主进程里执行的代码**，需要代码的能力一律以 MCP 形态进入（包内 MCPB 或远端 https）。三类来源——内置（只读）、市场（Ed25519 签名索引）、本地（上传 / 开发目录）——市场与本地走**同一条**安装管线；各贡献**投影**进既有服务，运行时的审批 / 风险 / 工具锁定 / 污点 / 能力挂载语义**一字不改**。

## 1. 给执行智能体的规则（必读，违反任何一条都会返工）

### 1.1 阅读顺序

1. 本文件（尤其 §4「固定契约」）。
2. 你的阶段文件。
3. 阶段文件里「必读」列出的设计章节与源码。
4. [AGENTS.md](../../AGENTS.md)、[docs/dev/01-conventions.md](../../docs/dev/01-conventions.md)、[docs/dev/05-testing.md](../../docs/dev/05-testing.md#开发中如何跑测试)。
5. 先例任务书（体例与做法，可参考，不是依据）：[todo/project-board/](../project-board/README.md)。

### 1.2 不得自行决定的事

- **所有标识符名称**（表名、列名、RPC 方法名、事件名、错误码、常量名、文件名、类名、`data-testid`、i18n key）以 §4 与阶段文件为准，**一个字母都不要改**。没写到的新名字，按相邻已有命名风格取，并在你阶段末尾「实施记录」登记。
- **行为**以阶段文件与设计 51 为准。阶段文件与设计 51 冲突 → 以阶段文件为准（更晚、更具体），同时在 [DEVIATIONS](../../docs/dev/DEVIATIONS.md) 记一条（编号 = 文件里最大的 `DEV-NNN` 加 1；开工时用 `rg -n "^### DEV-" docs/dev/DEVIATIONS.md | tail -1` 查）。
- 设计 51 §14 的九项决策已定：内置插件只读 / 目录型 / 不入表（Q1）、邮件厂商预设留代码（Q2）、智能体贡献首期不做（Q3）、连接器签名目录通道不动（Q4）、自托管市场自带公钥且封顶 community（Q5）、Bot 只能发起官方 `verified` 及以上（Q6）、更新由用户点击且权限扩大再同意（Q7）、插件管理项在 core 层拒绝单项删除（Q8）、内置插件随 headless 服务端分发并按发行门禁过滤（Q9）。

### 1.3 你有自由度的地方

函数内部实现、私有辅助函数命名、测试夹具写法、文件内代码组织（遵循相邻代码风格）。阶段文件里写「由你核对 / 由你判断」的地方，必须在实施记录写下判断依据。

### 1.4 测试规则（AGENTS.md 的具体化）

- **迭代中只跑相关测试**：`node scripts/run-tests.mjs run <测试文件或目录>`（可加 `-t "用例名"`）；单包 `pnpm --filter @kepcup/<包> test`；desktop 单测 `node scripts/run-tests.mjs run --project desktop`。`run-tests.mjs` 没有帮助文本，参数原样透传给 vitest。
- 类型检查：`pnpm --filter @kepcup/<包> typecheck`。**改了 shared 之后先 `pnpm --filter @kepcup/shared run build`**；改了 `package-guard` 之后先 `pnpm --filter @kepcup/package-guard run build`；改了 core 之后 desktop 要先 `pnpm --filter @kepcup/core run build`（根目录 `pnpm typecheck` 已按序做，P0a-1 会把 `package-guard` 加进这个顺序）。
- e2e：`pnpm build` 之后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/<spec>.spec.ts`。
- `*.svelte.test.ts` 跑在 `desktop-svelte` 项目（无 DOM，不能挂组件）；组件级行为靠 e2e。
- core 测试：集成测试经 `createTestStack` / `createTestCore`（`@kepcup/testkit`），调 RPC 要写 `core.rpc.call(method, input)`（**不是** `core.call`）；`createTestCore` 默认 `appVersion` 是 `'0.0.0-test'`。
- **全量 `pnpm test` 只在阶段收口跑一次**：P0a-1（改了 shared 契约与迁移）、P0a-3、P0b、P1-3、P2 各一次；P0a-2 / P1-1 / P1-2 不跑（只跑各自文件列出的定向测试）。**不要连续多轮全量**，偶发失败只单跑该文件复核；**改动前不重跑全量建基线**，引用 [05-testing.md](../../docs/dev/05-testing.md) 与 [PROGRESS.md](../../docs/dev/PROGRESS.md) 已记录的基线（沙箱类用例在本环境有已知基线失败），保证失败集合不超出基线。
- 每个阶段都要**新增**它要求的测试；不能只靠已有测试通过。不要为让测试通过而放宽断言、跳过或删除用例（阶段明确要求改的除外）。
- 新增依赖：**除 P0a-1 新建的工作区包 `@kepcup/package-guard` 外一律不允许新增 npm 依赖**（不引 zip 库、semver 库、MIME 库等；要的能力仓库里已有，见各阶段「复用清单」）。

### 1.5 提交与分支

- Conventional Commits：`feat(plugins): …`、`refactor(mcpb): …`、`test(plugins): …`、`docs(plugins): …`。**每个提交必须可构建**（至少相关包 `typecheck` 通过）。
- 一个阶段文件一个分支：`feat/plugins/p0a-1-foundation`、`feat/plugins/p0a-2-projection`、`feat/plugins/p0a-3-ui`、`feat/plugins/p0b-builtin`、`feat/plugins/p1-1-marketplace-core`、`feat/plugins/p1-2-updates`、`feat/plugins/p1-3-marketplace-ui-bot`、`feat/plugins/p2-ecosystem`；后一份从前一份合入点拉出。**不 push，不合入 main**，合入由用户确认。
- 纯重构（P0a-1 的 `package-guard` 抽取、P0a-2 的 `McpbInstaller` 改造）**必须是独立提交，不夹带行为改动**，且该提交上 `mcpb` 相关既有测试原样全绿。
- 阶段末尾的「实施记录」在最后一个提交里更新。

### 1.6 遇到偏差怎么办

设计 / 阶段文件与代码现实冲突（函数已不存在、假设不成立）→ **停止相关部分**，在 DEVIATIONS 按模板新增一条，继续不受影响的部分，最后写进「实施记录」。不要自行换方案。

### 1.7 全局「不要做」

- 不要编辑**历史迁移 SQL**（`packages/core/migrations/**/00NN_*.sql`）；只能新增。写作时 main 最新为 `0052_todo_pending_when.sql`，本任务书用 `0053`（P0a-1）与 `0054`（P0b）——**开工时先 `ls packages/core/migrations/main | tail -3` 核对，若已被占用则顺延，并在实施记录与 DEVIATIONS 登记**。
- **不要对插件包里的任何文件做 `import()` / `require()` / `vm` / `eval` / `new Function` / `Worker` 加载**。包里唯一允许被执行的东西是内嵌 `.mcpb`，且只经 `McpbInstaller` 既有的受管启动。
- **不要信任清单自述**：分级（tier）、权限、是否需要运行时一律由来源与贡献内容推导；`plugin.json` 里出现 `tier` 之类字段 → schema 是 `strict`，直接拒绝。
- 不要在 `settings.mcpServers` 里写来自清单的裸 stdio `command` / `args`；插件登记的 MCP server 只有两种：内嵌 MCPB（命令由 `McpbInstaller` 渲染）与远端 http。
- 不要在日志、审计、RPC 错误细节里放 `user_config` 的值、令牌、密钥。
- 不要给 `plugins` 之外的表加列；不要改任何既有贡献类别的审批 / 风险 / 锁定 / 污点 / 能力挂载代码路径。
- 不要在渲染层硬编码中文，文案进 `zh-CN.ts` 与 `en-US.ts`，**两份键顺序必须一致**（`locales.test.ts` 强制：键与顺序相同、英文不含中文且非空、`{占位符}` 一致）。
- 不要引入向后兼容分支、旧名别名、`@deprecated` 导出。
- 代码、标识符、注释用英文；文档用中文。

### 1.8 代码规范摘要

zod 校验所有边界输入；时间用 `infra/clock`，UTC 毫秒整数；错误用 `AppError(code, message, details?)`；依赖注入、无全局单例（`start.ts` 装配）；`packages/shared` 不依赖 core / Electron / Node API（**所以 sha256 之类要用 `node:crypto` 的函数放 core**）；renderer 只经 `lib/rpc` 调 core；Svelte 5 runes；滚动 / 高度链用 `min-h-0` + `overflow-*`；core 内模块依赖方向见 [01-conventions.md](../../docs/dev/01-conventions.md#仓库结构)。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| 插件包格式、安装管线、账本、启停卸载、技能 / MCP（内嵌 MCPB + 远端 http）/ 连接器投影、邮件预填模板（P1） | 智能体贡献、settings 贡献、插件依赖 / 合集、热重载、部分安装 |
| 内置插件（preset-skills / connectors 迁入） | 邮件厂商预设与 `AGENT_CATALOG` 迁移（留代码） |
| 市场（签名索引、R2 包托管、更新、撤销）、Bot 发起安装 | 站内发布流、账号体系、付费、服务端提交 / 审核（P3） |
| `kepcup-app` 插件校验 / 脚手架 / 打包、headless 本地安装 CLI（P2） | 对 Claude Code / Cursor 插件目录的导入 |

## 3. 阶段依赖

```text
P0a-1 基础 ──→ P0a-2 投影与注册 ──┬──→ P0a-3 界面 ──┐
                                  ├──→ P0b 内置插件化 │
                                  ├──→ P1-1 市场核心 ──→ P1-2 更新流 ──→ P1-3 市场界面与 Bot 工具（也依赖 P0a-3）
                                  └──→ P2 生态工具
```

- 多阶段共改的文件：`packages/shared/src/rpc/{methods,events}.ts`、`packages/shared/src/errors.ts`、`packages/shared/src/index.ts`、`packages/core/src/start.ts`、`packages/core/src/rpc/bindings.ts`、`apps/desktop/src/renderer/src/lib/i18n/locales/{zh-CN,en-US}.ts`、`apps/desktop/src/renderer/src/lib/features/extension-center/{tabs.ts,ExtensionCenterBody.svelte}`、`packages/shared/src/settings-catalog/*`。冲突时两边都保留，重跑 typecheck 与本阶段测试。

## 4. 固定契约（所有阶段共用，名字不得改动）

### 4.1 数据

| 项 | 内容 |
|---|---|
| 迁移（P0a-1） | `packages/core/migrations/main/0053_plugins.sql`：表 `plugins`、`plugin_items`（DDL 见 [P0a-1 步骤 3](P0a-1-foundation.md)） |
| 迁移（P0b） | `0054_plugin_skill_source.sql`：把 `skill_library.source_url` 的 `preset://{id}` 改写为 `plugin://com.kepcup/starter-skills/{id}` |
| 迁移（P1-2） | `0055_plugin_update_journal.sql`：`plugins` 加 `update_to`、`update_snapshot` 两列（更新日志，崩溃回滚用） |
| 目录布局 | `{home}/plugins/{ns}/{name}@{version}/`（目录名小写化）、`{home}/plugins/.staging/`、`{home}/cache/plugins/`（P1-1，下载的 `.kepcup` 缓存，`{sha256}.kepcup`）、`{home}/cache/plugins-market/{official|custom-xxxx}/`（P1-1，已验签的索引缓存）、`{home}/plugins/{ns}/{name}@{version}.prev`（P1-2，同版本更新期间的旧目录暂存）；内置插件在应用资源 `resources/plugins/{ns}/{name}/`（无版本后缀） |
| `AppPaths` | 新增 `pluginsDir: string`（`path.join(home, 'plugins')`）；`createCoreServices` 里与 `toolchainsDir` 同处 `mkdirSync(..., { recursive: true })` |
| 插件身份 | 主键 = 插件 id（形如 `io.github.alice/doc-tools`，规则 = `connectorNameSchema`）；保留命名空间 `com.kepcup`、`local.kepcup`：**仅内置插件可用 `com.kepcup`**，任何安装来源一律拒绝这两个命名空间 |
| 来源与分级 | 本地 `origin='local'` → `tier='developer'`；市场 `origin='marketplace'` → `tier` 取索引（`verified` / `community`，自托管市场封顶 `community`）；内置 `origin='builtin'` → `tier='builtin'`（**不入 `plugins` 表**） |
| 技能来源标记 | `skill_library.source_url = plugin://{pluginId}/{skillName}`（常量 `PLUGIN_SOURCE_PREFIX = 'plugin://'`） |
| MCP server id | `plg_` + `sha256("{pluginId}#{contributionId}")` 的前 12 位十六进制（core 的 `pluginServerId()`，**shared 里不放**） |
| MCP server 来源 | `McpServer.source = { kind: 'plugin', pluginId, version, key, mcpb?: { name, version, sha256 } }`（`mcpb` 仅内嵌 MCPB 有；`key` = 清单里该 mcp 贡献的 `id`） |
| MCP server 分级 | `tier: 'developer'`：本地插件与 community 插件；`verified` 不写 `tier` |
| 连接器条目改写 | 插件来源条目：`_meta["app.kepcup/connector"].tier` ← 来源映射（local→`developer`、verified→`verified`、community→`community`）；`releaseGate` ← `'plugin'`；`hidden` 删除；`toolPolicy` 只保留 `risk === 'destructive'` 的项；`packages` 必须为空数组；`icon` 取 `server.json` 同目录文件 |
| 审计动作 | `plugin_install`、`plugin_uninstall`、`plugin_set_enabled`（P0a）；`plugin_update`（P1）。detail 只含 `{ pluginId, version, origin, tier, via }`，`via` ∈ `file` / `folder` / `marketplace` / `bot` |

### 4.2 shared

| 项 | 内容 |
|---|---|
| 新文件 | `packages/shared/src/domain/plugin-manifest.ts`（清单 zod + 常量 + 纯函数）、`packages/shared/src/domain/plugins.ts`（RPC / 事件载荷 zod）；`P1` 再加 `domain/plugin-index.ts`（索引 + 公钥常量）。均在 `packages/shared/src/index.ts` 导出 |
| 清单常量 | `PLUGIN_FORMAT_VERSION = 1`、`PLUGIN_MANIFEST_MAX_BYTES = 65536`、`PLUGIN_MCP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/`、`PLUGIN_RESERVED_NAMESPACES = ['com.kepcup', 'local.kepcup']`、`PLUGIN_MAX_SKILLS = 50`、`PLUGIN_MAX_CONNECTORS = 20`、`PLUGIN_MAX_MCP = 10`、`PLUGIN_MAX_MAIL = 10`、`PLUGIN_SOURCE_PREFIX = 'plugin://'` |
| 清单 schema | `pluginManifestSchema`（**strict**，形状见 [P0a-1 步骤 2](P0a-1-foundation.md)）、`pluginSkillContributionSchema`、`pluginConnectorContributionSchema`、`pluginMcpContributionSchema`、`pluginMailContributionSchema`、`pluginIdSchema`、`pluginVersionSchema`、`pluginRelPathSchema`；类型 `PluginManifest` 等 |
| 错误码（`ERROR_CODES` 末尾追加） | `PLUGIN_INVALID`、`PLUGIN_INCOMPATIBLE`、`PLUGIN_CONFLICT`、`PLUGIN_MANAGED`；`chats.errorCode.<CODE>` 文案四条（两种语言） |
| 事件 | `plugins.changed`：`{ ids: string[] }`（P0a）；`plugins.marketplace.updated`：`{ generatedAt: number \| null }`（P1） |
| 既有契约改动 | `connectorOriginSchema` 增 `'plugin'`（`domain/connector-catalog.ts:54`）；`mcpServerSourceSchema` 由单一对象改为 `z.discriminatedUnion('kind', [mcpb 对象, plugin 对象])`（`domain/types.ts:378`），`McpServer.source` 的 `.optional().catch(undefined)` 保留 |
| 同意面板数据 | `pluginInspectOutputSchema`（形状见 [P0a-1 步骤 2](P0a-1-foundation.md)），渲染端「同意面板」与 core 的 `inspect` 只认这一份 |

**RPC**（每个都要同时登记到 `rpcMethodSchemas` **和** `APP_METHODS`，漏登记会静默地不在 `APP_RPC_METHODS` 里）：

| 阶段 | 方法 |
|---|---|
| P0a | `plugins.list`、`plugins.inspect`、`plugins.install`、`plugins.setEnabled`、`plugins.uninstall` |
| P1-1 | `plugins.marketplace.list`、`plugins.marketplace.refresh` |
| P1-2 | `plugins.update` |
| P1-3 | `mail.providerTemplates.list` |

`plugins.inspect` / `plugins.install` 的 `source`：P0a 只有 `{ kind: 'file', path }` 与 `{ kind: 'folder', path }`；P1 增 `{ kind: 'marketplace', id, version? }`（加性变更）。**`file` / `folder` 来源在远程端点（`currentRemoteSource() !== null`）上一律拒绝**（`AppError('INVALID_INPUT', …)`）。

### 4.3 core

| 项 | 内容 |
|---|---|
| 新包 | `packages/package-guard`（`@kepcup/package-guard`，无运行时依赖，node-only）：`ZipArchive`、`safeEntryPath`、`crc32`、上限常量；P2 增 zip 写入 |
| 目录 | `packages/core/src/plugins/`：`ids.ts`、`manifest-loader.ts`、`package.ts`（`PluginPackager`）、`store.ts`（`PluginStore`）、`registry.ts`（`PluginRegistry`）、`guards.ts`、`projectors/{index,skills,connectors,mcp,mail}.ts`、`index.ts`；P0b 增 `builtin.ts`；P1 增 `marketplace-sync.ts`、`marketplace-service.ts`、`permissions.ts`、`install-requests.ts`；共享的签名索引机制在 `packages/core/src/infra/signed-index.ts`（P1-1） |
| 服务装配 | `start.ts`：`CoreServices.plugins: PluginRegistry \| null`（初始 `null`），在 `new SettingsCatalogHost(` 语句之后、`new Orchestrator(` 之前构造（写作时约 l.2083 与 l.2194；那里 `settingsPermissionEffects` 已可用）；`close()` 里停；RPC 在 `rpc/plugins-bindings.ts`（`bindPluginsMethods(services)`）用本文件自己的 `method()` 助手注册，并在 `rpc/bindings.ts` 的 `bindAppMethods` 里展开 |
| 投影器接口 | `PluginProjector`（形状见 [P0a-2 步骤 2](P0a-2-projection.md)）；`PLUGIN_PROJECTORS` barrel 与覆盖率测试（每类贡献必须有一个投影器） |
| 账本 | `plugin_items.kind` ∈ `skill` / `connector` / `mcp` / `mail` / `disabled_connection`；**先登记账本、后写入**，卸载 / 回滚按账本反向做，所有 `unproject` 必须幂等 |
| 互斥 | `PluginRegistry` 内一把 promise 链互斥，覆盖 install / update / uninstall / setEnabled；等锁不设超时 |
| 恢复 | `PluginRegistry.recoverInterrupted()`：启动时处理 `state ∈ {installing, uninstalling}` 的行（`installing` → 按账本回滚并删目录；`uninstalling` → 继续完成卸载）；在 `environment.recoverInterrupted()` 同一段启动恢复里调用 |
| 设置写入 | 投影器改 `settings.mcpServers`：**读最新 → 改 → `settings.update` 必须在同一个同步区内（之间不得有 `await`）**——单线程下这就是原子的，与 `settings.update` RPC 的写锁临界区不会交错；**不要**去取 `settingsCatalog.runLocked`（不可重入，`McpbInstaller` 内部写入本来就是同步区）。网络副作用（断开、吊销、关连接）一律放在同步区之外 |
| 引擎版本 | `engines.kepcup` 用 `apps/mcpb/manifest.ts` 导出的 `satisfiesRange(appVersion, range)`；`appVersion` 的 `x.y.z` 核心部分为 `0.0.0`（开发 / 测试，含 `0.0.0-test`）时**跳过**校验 |

### 4.4 renderer

| 项 | 内容 |
|---|---|
| 目录 | `apps/desktop/src/renderer/src/lib/features/plugins/`（逻辑与共享组件）；扩展中心页签组件仍放 `features/extension-center/` |
| P0a-3 文件 | `features/plugins/plugins.svelte.ts`（单例 store `plugins`）、`plugin-install.ts`（纯函数）、`PluginConsentPanel.svelte`、`PluginInstallDialog.svelte`、`PluginSourceBadge.svelte`；`features/extension-center/ExtensionInstalled.svelte` |
| 页签 | `ExtensionCenterTab` 增 `'installed'`（P0a，**放在最前**，新顺序 `installed, skills, connections, mcp, mail, localCollab`）；P1 再增 `'market'`（**放在 `installed` 之前**，最终顺序 `market, installed, skills, …`）；默认页签仍是 `skills` |
| i18n 前缀 | `plugins.*`（正文）、`extensionCenter.tabs.installed` / `extensionCenter.tabs.market`（页签标签）、`chats.errorCode.PLUGIN_*` |
| testid 约定 | `plugins-*` 前缀；页签 `extension-center-tab-installed`；全部 testid 列表在各阶段文件登记 |

## 5. 术语

- **落地型 / 目录型**：设计 51 §2 第 6 条。落地型（市场 / 本地插件的技能、MCP）随插件登记即生效；目录型（连接器、邮件模板、内置插件的技能）只进目录，仍由用户逐项连接 / 安装。
- **账本**：`plugin_items` 表，记录插件投影出去的每一项；卸载 / 回滚 / 冲突检测都读它，不靠各服务里的来源标记反推。
- **插件管理项**：账本里登记的技能、MCP server；core 层拒绝对它们的单项删除与结构改写（`PLUGIN_MANAGED`）。
- **同意面板**：`plugins.inspect` 返回的内容的渲染；本地安装对话框、市场详情（P1）、Bot 确认卡（P1）共用同一个组件 `PluginConsentPanel`。

## 6. 完成定义（每个阶段都适用）

1. 阶段文件「验收」清单逐条通过，并在实施记录里写出每条的证据（命令与结果）。
2. 本阶段新增 / 修改的测试全绿；相关包 `typecheck` 通过；`pnpm lint` 不新增本阶段文件的报错（仓库已有的 lint 失败基线见 PROGRESS.md）。
3. 文档同步：阶段文件要求的 `docs/dev/*` 更新已做；[docs/dev/PROGRESS.md](../../docs/dev/PROGRESS.md) 的验收表加一行（最后一个阶段做）。
4. 实施记录写在阶段文件末尾：做了什么、与任务书的偏差（含 DEV 编号）、遗留问题。
