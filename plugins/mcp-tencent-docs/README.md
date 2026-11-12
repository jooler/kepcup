# 腾讯文档（mcp-tencent-docs）

让 KepCup Bot 读写你的腾讯文档空间：搜索文档、读取正文、按 Markdown 新建文档、批量写入在线表格与智能表（走腾讯文档官方 MCP 端点）。

## 启用步骤

1. 安装并启用本插件（扩展中心 → 已安装）。
2. 获取 MCP token：桌面版腾讯文档**进入目标空间**，点右上角「≡ → 使用 MCP → 获取 MCP token」复制**当前空间**的 token。
   - 获取 token 需要腾讯文档**超级会员 / 超级会员 Plus**。
   - token **按空间发放**：一个 token 只覆盖一个空间，多空间请添加多个工具服务（每个各粘一个空间的 token）。
   - token 有效期一年；在同一页面可重置（重置后旧 token 立即失效，需回插件卡更新）。
3. 扩展中心 → 已安装 → 腾讯文档 →「管理」→「添加工具服务」，在 `Authorization` 一栏**直接粘贴裸 token 即可** —— `Bearer ` 前缀由插件自动补（已带前缀也会被规范化，不会出现 `Bearer Bearer …`）。
   - 实测 `https://docs.qq.com/openapi/mcp`（2026-11）硬要求 `Authorization: Bearer <token>`：裸 token 回 `401 {"error":"invalid_token","error_description":"Bearer token required"}`。清单里该 header 声明了 `scheme: "bearer"`，保存时只存裸 token、发送时自动补前缀。
   - 前缀正确后仍回 `401 invalid or expired token`，说明 token 本身已失效 / 被重置或不属于该空间。
4. 在 Bot 详情勾选启用本插件，Bot 即获得腾讯文档读写工具。

凭据（token）只保存在本机 secrets（裸 token 形态），不会进入对话上下文或界面。
