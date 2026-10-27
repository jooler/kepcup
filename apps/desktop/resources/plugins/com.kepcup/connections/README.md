# com.kepcup/connections：连接应用内置插件（D73 / D104 P0b）

随应用打包的内置连接应用插件（设计：`docs/design/29-connected-apps.md` §4；
D104 P0b 起目录数据改为本内置插件，只读、随应用分发）。

- `connectors/<slug>/server.json`：每家应用一个目录，`server.json` 即
  server.json + `_meta["app.kepcup/connector"]`（原 `catalog.json` 的每条 entry），
  schema 见 `packages/shared/src/domain/connector-catalog.ts`；core 运行时经
  `BuiltinPlugins.connectorSource()` 读取（`packages/core/src/plugins/builtin.ts` →
  `packages/core/src/apps/catalog.ts`），契约测试
  `packages/core/test/contract/connector-catalog.contract.ts`。
- `connectors/<slug>/<icon>.svg`：**中性占位图标**（圆角方块 + 首字母），与该条目的
  server.json 同目录（`_meta.icon` 文件名），不含任何厂商商标图形；上线前由用户确认
  各家品牌素材许可后再替换。
- 发行门禁：`apps/desktop/connector-release-gates.json`（`approved` = 当前已放行的门禁清单）。条目 `releaseGate`
  未被放行时，发行构建不收录（headless server 打包 `scripts/pack-server.mjs` 亦按同一
  门禁过滤并删除未放行条目）；开发构建与测试不过滤。**全部条目在完成带登录实测与适配（流程见 todo/extension-center.md §4）前保持关闭，测好一家放行一家（已放行：notion、linear，2026-10-10；每个放行条目必须有 `packages/core/test/fixtures/connectors/<slug>.tools.json` 快照，守门测试 `unit/connector-tool-snapshots.test.ts`）。** 放行后的条目在发行构建里出现在**扩展中心 →「连接」组**（设计 29 §16；设置「应用」分区只管已连接账号，普通界面没有「填 URL」入口）；开发构建不过滤，便于适配时逐家测试。
- 骨架导入：`node scripts/import-mcp-registry.mjs <registry-name>` 打印条目 JSON，
  落到 `connectors/<slug>/server.json`，`_meta` 扩展字段为占位，人工补。

## 如何新增一家连接应用

1. `connectors/<slug>/server.json`（开放平台格式 + `_meta["app.kepcup/connector"]`，
   `privacyPolicy` 等占位字段必须补齐）。
2. `connectors/<slug>/<slug>.svg` 图标（`_meta.icon` 与文件名一致）。
3. 在 `plugin.json` 的 `contributions.connectors` 增加一项
   `{ "file": "connectors/<slug>/server.json" }`。
4. 门禁登记：`apps/desktop/connector-release-gates.json` 的 `approved` 里加入该
   `releaseGate`（放行前必须有工具定义快照与登录实测）。
