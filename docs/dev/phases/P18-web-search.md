# P18 联网检索工具（web_search / web_fetch）

## 目标

宿主具备联网检索：模型可搜索公网资料、抓取网页文本；检索供应商在设置页可配置、可测试；未配置时在对话内就地引导配置并自动续跑。

## 依赖

P15（SETUP_REQUIRED 内联引导模式与设置卡复用结构）。

## 设计依据

- [design/21-web-search.md](../../design/21-web-search.md)（全文，决策 D62）
- [design/18-inline-setup.md](../../design/18-inline-setup.md)（setup 模式）
- [design/16-capability-models.md](../../design/16-capability-models.md)（厂商适配层风格参照）
- [04-agent-runtime.md](../04-agent-runtime.md)（工具目录）
- todo/conversation-rich-media.md（规划与验收口径）

## 背景（现状，实现前必读）

- 宿主无任何联网检索/抓取工具；`scan.ts` 的 `HOST_CAPABILITY_PATTERNS` 把 `WebSearch/WebFetch` 判为本宿主不提供（需同步修正）。
- key 存储先例：`secrets` 表名字 `provider:{vendor}`（`SecretsService`）；设置页测试按钮先例：`providers.test`。
- 设置引导先例：`SetupRequirement` discriminated union + `SetupRequiredCard`（main-model / capability-model 两分支）；`#mediaFacade(setupHit)` 捕获错误码记 requirement 的模式。
- 工具注册：`buildResponseTools` 按 `ResponseToolDeps` facade 存在性挂载；orchestrator deps 在 `start.ts` 组装。
- testkit 有 web server fixture 可测 HTTP 适配器。

## 任务（全部完成）

- [x] shared：`settingsSchema.webSearch = { provider: 'tavily'|'brave'|'bocha'|null }`；`setupRequirementSchema` 增 `{kind:'web-search'}`；RPC `websearch.test`
- [x] core/search：模块与三家适配器（归一 `SearchHit{title,url,snippet}`；15s 超时；key 取 `websearch:{provider}`）；`SearchService.search/fetchPage/isConfigured/test`
- [x] core/search：`web_fetch` 文本化（html 剥标签 ≤50k 字符；二进制拒绝；≤3MB；20s；DNS 解析后拒绝私网/环回/元数据；重定向逐跳复检 ≤5）
- [x] core/tools：`web-tools.ts`（web_search 缺配置 → SETUP_REQUIRED；web_fetch 独立）；orchestrator 挂 `search` facade + setupHit 记 `{kind:'web-search'}`；`start.ts` 注入
- [x] core/skills/scan：`WebSearch/WebFetch` 移出「宿主不提供」清单
- [x] desktop/settings：新「联网检索」分组（供应商三选一 + key 轮换/清除 + 测试连接）；i18n
- [x] desktop/chats：`SetupRequiredCard` 第三分支（内嵌供应商+key+测试表单，与设置页同一批 RPC）；`continueAfterSetup` 复用
- [x] 测试：适配器/防止单测（testkit fixture）；工具三态；`websearch.test`；e2e setup 卡 web-search 路径

## 验收（2026-10-04 全部通过）

1. 未配置时 `web_search` → run 失败带 `setup={kind:'web-search'}`、卡片出现（单测 `web-tools.test.ts` SETUP_REQUIRED 路径；卡片分支随 SetupRequiredCard web-search 分支落地，卡内表单与设置页同 RPC，保存后 `continueAfterSetup` 自动续跑）。
2. 设置页「联网检索」分组：供应商三选一 + key + 测试连接三态（`SearchService.test` 成功/鉴权失败/网络失败，单测覆盖）。
3. `web_fetch`：html 剥标签、json 原文、二进制拒绝、私网/元数据地址拒绝、重定向逐跳复检（单测 `web-tools.test.ts` SSRF 组）。
4. 三家适配器归一 SearchHit（tavily/brave/bocha，注入 fetch 单测）。
5. `pnpm test` 全绿。

## 备注

1. 未配置时模型调 `web_search` → run 失败带 `setup={kind:'web-search'}`、卡片出现；卡内选供应商+填 key+测试通过+确认 → 原 run 自动重试并返回真实检索结果。
2. 设置页可切换/清除供应商与 key，测试按钮三态正确（成功/鉴权失败/网络失败）。
3. `web_fetch` 对公网 URL 返回正文文本；对私网/元数据地址拒绝；对 PDF 返回引导性失败。
4. `web_search` 正常返回编号结果列表（标题/URL/摘要），包 `<untrusted>`。
5. `pnpm test` 全绿。

## 备注

- 检索不记用量账本（无 token 成本）；不引入审批（只读公网，与浏览器工具同级）。
- 供应商三家都实现（均为单请求 JSON API，增量成本低），UI 三选一。
