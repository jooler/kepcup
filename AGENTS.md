# KepCup 编程 Agent 约定

开发流程与规范见 [docs/dev/README.md](docs/dev/README.md)；测试细则见 [docs/dev/05-testing.md](docs/dev/05-testing.md#开发中如何跑测试)。

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
