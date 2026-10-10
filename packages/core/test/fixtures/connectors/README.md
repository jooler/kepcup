# 连接应用的真实工具定义快照（逐家适配用）

每家一个文件：`<slug>.tools.json`，`slug` 与 `apps/desktop/resources/connectors/catalog.json` 的条目一致。
内容是该应用 MCP server 的 `tools/list` 原样输出（JSON 数组，元素含 `name` / `title` / `description` /
`inputSchema` / `annotations`，有的带 `_meta`）。**不含令牌、授权码或账号信息。**

用途：

- 适配一家应用时（`todo/extension-center.md` §4）：核对 `toolPolicy`、统计注解覆盖率、给逐工具定风险。
- 测试：用作 `toolPolicy` 覆盖度与风险分档的回归依据；上游悄悄改了工具（新增 / 改注解），重新导出后
  `git diff` 一目了然（配合运行时的工具定义锁定）。

## 怎么导出一家

1. 桌面端 设置 → 应用 → 自定义，勾选「开发者模式」，在该服务器下点「查看原始定义」。
2. 复制 JSON，存成 `packages/core/test/fixtures/connectors/<slug>.tools.json`（一家一个文件）。
3. 提交前扫一眼：不要有真实邮箱、工作区名、内部链接；示例性的 `alex@example.com` 之类没问题。
4. 汇总：`node packages/core/scripts/connector-spike/summarize-tools.mjs [slug …] [--list]`（需先
   `pnpm --filter @kepcup/shared build`），用产品里的 `classifyRiskDetailed` 输出工具数、注解覆盖率、
   只读 / 写 / 破坏性分布，以及判定不来自注解的工具。

这些文件只在测试 / 开发里使用，**不要**放进 `apps/desktop/resources/`（那里会随应用分发）。
