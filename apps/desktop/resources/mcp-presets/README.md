# mcp-presets：精选 MCP 清单（扩展中心「MCP」分组的数据源）

设计：`docs/design/29-connected-apps.md` §16（扩展中心，决定 C）。

- `catalog.json`：`{ "version": 1, "presets": [...] }`。**首期为空**——扩展中心「MCP」分组在清单为空时
  只显示已安装 MCP 的管理视图（启停 / 状态 / 工具策略）+ MCPB 本地包安装；等有第一个值得预置的
  **无 OAuth** MCP（需要 OAuth 的第三方应用走「连接」分组 + `connectors/catalog.json`）再填。
- 条目 schema 与加载器：`packages/core/src/mcp/presets.ts`（`mcpPresetCatalogSchema` /
  `loadMcpPresetCatalog`），单测 `packages/core/test/unit/mcp-presets-catalog.test.ts`。
  条目字段：`id` / `section` / `displayName` / `summary` / `icon` / `version` / `tryIt` +
  `install`（`mcpb` 本地包相对路径 + sha256，或 `stdio` 命令，或 `http` https 地址）。
- 解析：开发 / 仓库检出自包位置向上查找 `apps/desktop/resources/mcp-presets`，或 `KEPCUP_MCP_PRESETS`
  覆盖；找不到目录 = 空清单。
- 首个条目落地时再补：RPC（列出 + 安装）、`electron-builder.yml` 的 `extraResources`（三个平台块）、
  core-host 的 `KEPCUP_MCP_PRESETS` 注入，以及 `ExtensionMcp.svelte` 里按清单渲染的卡片。
