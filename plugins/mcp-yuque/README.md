# 语雀（mcp-yuque）

让 KepCup Bot 读写你的语雀知识库：浏览知识库、按 Markdown 创建与更新文档、维护目录
（内嵌语雀官方 `yuque-mcp` server，github.com/yuque/yuque-mcp-server）。

## 启用步骤

1. 获取 API Token：浏览器打开 [www.yuque.com/settings/tokens](https://www.yuque.com/settings/tokens)
   创建，勾选需要的授权范围。
   - **个人令牌需要语雀超级会员**（2023 年起收紧）；企业 / 空间版用户不受此限。
   - 空间版（私有部署 / 团队空间）用户改用**团队 Token**，并把 host 换成空间域名
     （如 `https://your-space.yuque.com`）。
2. 安装本插件（扩展中心），在安装表单填入 Token（与可选的 host）。Token 只存本机 secrets。
3. 在 Bot 详情勾选启用本插件，Bot 即获得语雀读写工具。

## 开发者说明

`.mcpb` 产物由 `build.mjs` 生成（npm 安装官方包 + zip 打包）：

```bash
node plugins/mcp-yuque/build.mjs
node packages/app-validator/dist/cli.js validate plugins/mcp-yuque
```

限流提示：语雀 API 未公开具体限流数值，Bot 批量读写请小步串行，遇 429 指数退避。
