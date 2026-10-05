# 21 联网检索工具

宿主此前没有任何联网检索能力（技能扫描甚至把 `WebSearch/WebFetch` 判为本宿主不提供）。Bot 要「全网检索」的诉求有两类：通用问答/资料查证，以及为用户上传的文件寻找能处理它的技能（见 [22-file-skill-routing.md](22-file-skill-routing.md)）。本文决定能力形态、供应商接入与配置引导。

## 决策

- **D62 联网检索工具**：以**内置宿主工具**（`web_search` + `web_fetch`）提供联网检索，不做「默认安装一个搜索技能」——检索是服务调用而非操作流程，技能（提示词+脚本）只能包一层 curl 抓取，对搜索引擎反爬/解析脆弱且不可控；工具走 core 进程 HTTP（与媒体适配器同层），可配置供应商、可连通性测试、可被响应 loop 与全部后台 loop 复用；检索供应商为独立配置 `settings.webSearch`（tavily / brave / bocha 三选一，key 按供应商存密钥表 `websearch:{provider}`），设置页新增「联网检索」分组与 `websearch.test` 连通性测试；未配置/缺 key 时 `web_search` 返回 `SETUP_REQUIRED` 并以结构化 setup `{kind:'web-search'}` 失败，复用 D58 内联设置引导（卡片内选供应商+填 key+测试，完成后原 run 自动重试）；`web_fetch` 不依赖检索配置，独立可用（见 21）。

## 1 为什么是工具而不是默认技能

| 维度 | 内置工具（选定） | 默认安装搜索技能 |
|---|---|---|
| 可靠性 | 直连供应商 API，JSON 结果稳定 | curl 抓搜索结果页，反爬/改版即碎 |
| 可控性 | 供应商/配额/key 收敛在设置页，可测试 | 逻辑散在技能脚本里，无配额可见性 |
| 复用 | 响应/反思/Wiki/技能发现等所有 loop 直接调用 | 只有加载该技能的响应 loop 能用 |
| 生态 | 无可靠可 vendored 的官方「搜索技能」 | — |
| 安全 | core 出网，SSRF 防护集中一处 | 沙箱 bash 出网，域控依赖网络策略 |

技能的正确分工仍是「操作流程」（怎么用 MinerU 解析 PDF）；检索是「能力服务」，归工具层。技能扫描对 `WebSearch/WebFetch` 的不兼容判定同步修正（本宿主此后提供同名能力）。

## 2 配置模型

- `settings.webSearch: { provider: 'tavily' | 'brave' | 'bocha' | null }`（null = 未配置）；key 不进 Settings，存密钥表，名字 `websearch:{provider}`（与 `provider:{vendor}` 同规矩）。
- 三家适配器（core 进程直连，均以 key 鉴权）：
  - **tavily**：`POST https://api.tavily.com/search`，返回 `results[]{title,url,content}`，AI 检索友好、有免费档；
  - **brave**：`GET https://api.search.brave.com/res/v1/web/search`（`X-Subscription-Token`），免费档较大；
  - **bocha**（博查）：`POST https://api.bochaai.com/v1/web-search`（Bearer），国内直连友好、面向 AI 的网页/摘要。
- 适配器各自处理鉴权头、参数命名与结果归一：`SearchHit { title, url, snippet }`；超时 15s、结果数上限 8。
- RPC `websearch.test { provider, key? }`：发一次最小真实查询（无 key 时用入参 key 不落库），返回 ok/时延/结果数或错误——与 `providers.test` 的「按能力最小探测」同思路。

## 3 工具契约

- **`web_search { query, max_results? }`**：未配置供应商或缺 key → `SETUP_REQUIRED`（setupHit `{kind:'web-search'}`）；否则返回编号结果列表（标题/URL/摘要截断），外层 `<untrusted>`。**无审批**——只读公网检索，与浏览器工具（D44）同级。
- **`web_fetch { url }`**：GET 抓取并文本化——`text/*`、`application/json` 原文截断（≤50k 字符）；`text/html` 剥标签取正文；二进制（PDF/图片等）不抓取，返回提示改用浏览器工具或技能下载。防护：仅 http/https、DNS 解析后拒绝私网/环回/链路本地/元数据地址（与浏览器 facade 的内网/元数据拦截同一策略）、**连接时逐连接复检解析地址**（undici Agent 自定义 lookup——fetch 内部的再次解析也走同一校验，先行解析 + 连接时校验两层封死 DNS rebinding 窗口）、重定向逐跳复检（≤5）、响应体 ≤3MB、超时 20s（与调用方取消信号合并，覆盖全部重定向跳与 body 读取）。
- 两个工具始终注册（缺配置的失败语义进模型上下文，模型可改道）；`web_fetch` 不触发设置引导（没有可配置项）。

## 4 界面与引导

- 设置页左栏新增「联网检索」分组：供应商三选一（含「未配置」）、key 输入（轮换/清除同厂商卡片）、测试连接按钮（结果内联展示）。
- `SetupRequirement` 增 `{kind:'web-search'}`：`SetupRequiredCard` 第三种卡片内嵌同款「供应商 + key + 测试」表单（与设置页同一批 RPC，「同一份事实」），保存后 `continueAfterSetup()` 原路自动续跑。

## 5 测试锚点

- 适配器单测（testkit http fixture）：鉴权头/参数归一/错误映射/超时。
- `web_fetch` 单测：私网与元数据地址拒绝、重定向复检、超长截断、二进制拒绝。
- 工具单测：未配置 → SETUP_REQUIRED；配置后正常返回；`websearch.test` 三态（ok / 鉴权失败 / 网络失败）。
- e2e：设置卡「web-search」路径（不带配置触发 → 卡内配置 → 自动续跑）。

## 6 非目标

- 不做自建搜索引擎/SearXNG 接入、不做结果缓存与去重、不做网页正文的可读性精提取（剥标签即可）、不做垂直搜索（新闻/图片）、不把检索记录进用量账本（无 token 成本）。
