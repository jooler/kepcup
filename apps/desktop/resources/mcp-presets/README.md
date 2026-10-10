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

## TODO（接线前必须补齐——现在只是未接线的空壳，加载器**没有**这些防护）

`core/src/mcp/presets.ts` 目前没有任何调用方（清单为空、不接 RPC、不进安装包）。第一个条目接线之前，下面这些必须一起做，否则一份被篡改或写错的清单就能让用户安装任意东西：

- [ ] **`mcpb.file` 的 realpath 包含校验**：schema 只挡了 `..` / 绝对路径 / 反斜杠；接线时要 `realpath` 后确认仍在清单目录内（防符号链接逃逸），并只读该文件。
- [ ] **完整性绑定**：`sha256` 目前只是 schema 字段；安装时必须对实际读到的字节重算并比对（复用 `mcpb.install` 的 sha256 绑定），清单本身随应用签名 / 打包，不能在运行时被替换。
- [ ] **`stdio` 命令 / `http` 主机白名单**：清单里的 `command` 只允许受信任的启动器（如 `npx` / `uvx` 加固定包名与版本）或包内二进制；`http` 主机要走已有的 SSRF 防护与目录主机校验，不能是回环 / 内网。
- [ ] **带认证的发现**：精选清单只收**无 OAuth** 的 MCP；一旦条目需要认证，必须改走 `connectors/catalog.json`（连接组），不能在这里用 header / 手填密钥。
- [ ] **版本上限**：`version` 目前无上界语义；接线时要定义可接受的清单 `version` 范围（高于客户端已知版本的清单整体忽略并告警），避免旧客户端误读新格式。
- [ ] 同时补：RPC（列出 + 安装，经 `mcpb`/MCP 现有审批）、`electron-builder.yml` 三个平台块的 `extraResources`、core-host 的 `KEPCUP_MCP_PRESETS`、`ExtensionMcp.svelte` 的卡片渲染。
