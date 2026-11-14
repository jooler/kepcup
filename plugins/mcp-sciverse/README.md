# Sciverse 文献检索

让 KepCup Bot 检索学术文献：内嵌 Sciverse 官方检索服务
（[opendatalab/Sciverse-Agent-Tools](https://github.com/opendatalab/Sciverse-Agent-Tools)），
Bot 可直接调用 6 个检索工具，凭据只保存在本机。

## 能力

| 工具 | 用途 |
|---|---|
| `semantic_search` | 自然语言语义检索，返回文献证据片段与原文定位（RAG 主入口） |
| `search_metadata` | 结构化元数据检索（关键词、作者 / 年份 / 期刊 / 学科过滤、排序、分页） |
| `list_paper_relations` | 查询单篇论文的参考文献 / 被引 / 相关工作 |
| `read_content` | 按 Unicode 码点区间分段读取论文全文 |
| `get_resource` | 拉取原文中的图表二进制 |
| `list_catalog` | 枚举可用字段、过滤算子与示例值（字段自查） |

## 安装与启用

1. 扩展中心安装本插件，按提示填入 **Sciverse API Token**
   （在 [sciverse.space/tokens](https://sciverse.space/tokens) 创建，`sv-` 开头）；
2. 在 Bot 详情「插件」区块添加本插件；
3. 直接对 Bot 说「帮我找几篇 Transformer 注意力机制的论文」即可。

## 开发者说明

目录结构：

```
plugin.json          插件清单（contributions.mcp = 内嵌 sciverse.mcpb）
icon.svg             插件图标
mcp/manifest.json    MCPB v0.3 清单（user_config.token → SCIVERSE_API_TOKEN env 注入）
mcp/sciverse.mcpb    构建产物：内嵌官方 sciverse-mcp-server（由 build.mjs 生成，入库追踪）
build.mjs            MCPB 构建脚本
```

构建与校验（需 macOS / Linux）：

```bash
node plugins/mcp-sciverse/build.mjs                                    # 生成 mcp/sciverse.mcpb
node packages/app-validator/dist/cli.js validate plugins/mcp-sciverse  # 校验（零 error）
node packages/app-validator/dist/cli.js pack plugins/mcp-sciverse --out /tmp/dist/mcp-sciverse.kepcup
```

构建脚本会把官方 `sciverse-mcp-server@^1.0.1` 装进临时目录并校验内容契约
（入口文件在位、`SCIVERSE_API_TOKEN` env 键未被官方包更名）后再打包，
防止 npm 空装或上游契约漂移时产出「成功」的坏包。

打包 `.kepcup` 后按 [plugins/README.md](../README.md) 的发布流程走策展 / 签名 / 分发；
未发布前可经扩展中心「从文件夹安装」试用。
