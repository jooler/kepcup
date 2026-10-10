# 连接应用目录（D73）

随应用打包的内置连接应用目录（设计：`docs/design/29-connected-apps.md` §4）。

- `catalog.json`：`{ "version": 1, "connectors": [server.json + _meta["app.kepcup/connector"]] }`，
  schema 见 `packages/shared/src/domain/connector-catalog.ts`；core 运行时读取
  （`packages/core/src/apps/catalog.ts`），契约测试 `packages/core/test/contract/connector-catalog.contract.ts`。
- `icons/*.svg`：**中性占位图标**（圆角方块 + 首字母），不含任何厂商商标图形；上线前由用户确认
  各家品牌素材许可后再替换。
- 发行门禁：`apps/desktop/connector-release-gates.json`（`approved: []`）。条目 `releaseGate`
  未被放行时，发行构建不收录；开发构建与测试不过滤。**全部条目在完成带登录实测与适配（流程见 todo/extension-center.md §4）前保持关闭，测好一家放行一家（已放行：notion、linear，2026-10-10；每个放行条目必须有 `packages/core/test/fixtures/connectors/<slug>.tools.json` 快照，守门测试 `unit/connector-tool-snapshots.test.ts`）。**
- 骨架导入：`node scripts/import-mcp-registry.mjs <registry-name>`，`_meta` 扩展字段为占位，人工补。
