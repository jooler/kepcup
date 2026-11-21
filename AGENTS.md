# KepCup 编程 Agent 约定

开发流程与规范见 [docs/dev/README.md](docs/dev/README.md)；测试细则见 [docs/dev/05-testing.md](docs/dev/05-testing.md#开发中如何跑测试)。

## 执行型插件（D125）

- 给插件加 `runtime` 段或编写携带代码的插件时，开发约定见 [packages/plugin-sdk/README.md](packages/plugin-sdk/README.md)（SDK / esbuild 单文件打包 / `host` 命名空间 / 实例字段与凭据注入 / 静态扫描约束）；设计与现状见 [docs/design/61-plugin-runtime-platform.md](docs/design/61-plugin-runtime-platform.md)。

## 测试：先定向、后全量

- 迭代中只跑与改动相关的测试：`node scripts/run-tests.mjs run <测试文件或目录>`（可加 `-t "用例名"`），或单包 `pnpm --filter @kepcup/<包> test`；类型检查同理用 `pnpm --filter @kepcup/<包> typecheck`。
- 全量 `pnpm test` 只在三种情况跑：阶段收口或最终交付前跑**一次**；改了跨包公共部分（shared 契约、testkit、迁移、vitest 配置）；用户明确要求。
- 不做连续多轮全量；偶发失败只单跑该文件复核。改动前不重跑全量建基线，引用已记录的基线。
- PROGRESS.md 里「连续 N 轮全绿」是历史取证记录，不是要照做的流程。

## 设置：只走设置目录

- 任何需要用户配置的新能力，先在 `packages/shared/src/settings-catalog/items.ts`（或拆分后的 `items/`）登记目录条目。设置目录是唯一事实来源：Bot 工具、设置卡、设置页、测试都从它读，不要另建设置清单。
- 新增条目按层补齐：目录条目（id / fields / write / card / deepLink / store）→ core 适配器（`packages/core/src/settings/contributions/` 加贡献或并入现有组；实现在 `adapters.ts`）→ 渲染层卡片（`apps/desktop/src/renderer/src/lib/features/settings-card/cards/index.ts` 加一条 + `SettingCardEmbed.svelte` 加分支）→ 设置页 `data-settings-anchor`。漏适配器会让 `settings-adapters-coverage.test.ts` 失败；确实不需要适配器的条目只能在 `contributions/index.ts` 的 `EXPLICIT_ADAPTER_FALLBACK` 里登记并写明理由，没有静默兜底（漏登记读 `unknown`）。
- 简单全局标量设置优先用 `store: { kind: 'settings', generic: true }` + `card: 'field-editor'`（字段用 `path` 指到 settings 顶层键）：不改 core、不改卡片，Bot 即可搜读写、`FieldEditorCard` 自动出卡；设置页入口用一行 `SettingsCatalogFields itemIds={[...]}`（锚点由页面静态写）。复杂设置才写专用适配器和卡片。
- `direct` 只能加进 `DIRECT_ITEM_IDS`，新条目默认 `maxMode` 不得为 `direct`。敏感字段（secret / oauth / account）只能由用户在卡片里填，永不出现在 `settings_change.values` 或 Bot 可读快照里。
- 改设置相关代码后至少跑定向测试：`node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts packages/core/test/unit/settings-item-writes.test.ts packages/core/test/unit/settings-adapters-coverage.test.ts apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`。
- 设计细节以 `docs/design/38-conversational-settings.md` 和 `todo/settings-catalog-registry.md` 为准。

## 闭源目录：apps/team-server（嵌套私有仓）

- `apps/team-server/` 是闭源仓 [jooler/kepcup-team-server](https://github.com/jooler/kepcup-team-server) 的嵌套 clone（挂载根）：`server/` = `@kepcup/team-server`、`console/` = `@kepcup/team-console`，`docs/`、`todo/` 为内部文档。`.gitignore` 整目录忽略 `apps/team-server/`；`README.md`（闭源说明）是私有仓 clone 之前就已提交的**已跟踪文件**——gitignore 不影响已跟踪文件，所以它是公开仓在该路径保留的唯一文件，也不会被当成 gitlink。
- 闭源改动在该目录内 git 提交/推送（remote 指向私有仓 `main`）；开源改动在仓库根提交。混合改动分别提交，**不要把私有仓内容复制或引用进公开仓文件**（私有仓里的 `apps/team-server/server/...` 路径在公开 checkout 不存在）。
- 两个包仍在宿主 workspace（`pnpm-workspace.yaml` 显式登记为 `apps/team-server/server|console`，并 `'!apps/team-server'` 排除私有仓根）：`pnpm --filter @kepcup/team-server test`、根 vitest、typecheck 照常使用。**pnpm 安装/测试/构建只在仓库根执行**，不要在 `apps/team-server/` 里做安装（那里是私有仓自己的 workspace，依赖由宿主 workspace 解析）；唯一例外是开发编排 `cd apps/team-server && pnpm dev`（dev.mjs 同时起 server watch、console vite 与渲染层 web vite，bin 从宿主根探测）。
- 根 vitest 的 `team-server` / `team-console` 项目按 `apps/team-server/server/package.json` 存在性条件注册：公开 checkout 自动跳过，私有 clone 就位后自动恢复。公开 CI 在 `pnpm install` 前跑 `scripts/prune-lockfile-importers.mjs` 剪除无 package.json 目录的 lockfile importer。
- **不要对宿主仓跑 `git clean -x`（含 `-fdx`）**：会把整个嵌套私有仓连同 `.git` 一起删掉（内容可从私有仓重新 clone，但本地未推送提交会丢）。
- 设计与流程见 [docs/design/63-closed-source-team-server.md](docs/design/63-closed-source-team-server.md)。
