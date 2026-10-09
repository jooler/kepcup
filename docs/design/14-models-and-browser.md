# 14 模型配置与浏览器工具

## 模型配置

直接复用 pi（`@earendil-works/pi-ai`）的模型能力。

### 来源

- pi 内置的厂商与模型列表（含上下文长度、价格等元数据）。
- 国内厂商（阿里云百炼、火山方舟）：对话走各家 OpenAI 兼容根（见下文「国内厂商与能力模型」）。
- 自定义接口：OpenAI 兼容接口、Ollama 等本地模型，通过 `baseUrl` 接入。

### API key

- 由 pi 在每次请求时通过 `getApiKey` 获取；核心服务从加密的敏感数据表中解密后提供，见 [11-storage.md](11-storage.md#敏感数据api-key-等凭据)。
- 不写入环境变量，也不写入 pi 自己的配置文件。

### 配置层级

| 位置 | 内容 |
|---|---|
| 设置页 | 默认主模型、默认轻量模型、并发、厂商（API key、自定义接口）、按能力的能力模型配置（见 [16-capability-models.md](16-capability-models.md)）、向量来源 |
| Bot Profile | 主模型、轻量模型（可选，覆盖默认值）；主模型位置可改选已启用的外部智能体，并设其模型、推理强度、权限档位与注入的能力包（D72） |

各类 loop 使用的模型：

| Loop | 模型 |
|---|---|
| 响应、技能生成、Wiki 维护 | 主模型 |
| 群聊判断、反思、记忆整理 | 轻量模型 |
| 画像整理（全局唯一） | 设置页中的默认主模型 |

### 外部智能体（D72，未实现）

没有 API key、只有 Claude / ChatGPT / Copilot / GLM Coding Plan 等订阅的用户，可在设置页「智能体」目录启用 Claude Agent、Codex、OpenCode 等（按需安装 + 厂商官方登录，KepCup 不接触凭据），再在 Bot 的主模型位置改选该智能体。外部智能体的模型由其自身提供，经 ACP `session/set_config_option` 选择；对话模型以外的能力（图像 / 语音 / 视频生成、图片理解、检索等）以能力包形式按 Bot 选择注入。后台 loop 在没有任何内置模型时改由外部智能体以一次性精简会话完成（更慢、默认降频；续接 L2 仲裁关闭）。详见 [28-external-agents-acp.md](28-external-agents-acp.md)。

### 用量与费用

pi 返回的每次调用用量，结合模型价格元数据，写入用量账本，用于用量展示与预算控制。外部智能体引擎的用量按订阅计（`provider='agent:{id}'`、无费用，只记智能体上报的 token），预算改以 run 级轮数 / 时长上限约束（D72）。

### 向量模型

- 记忆检索需要向量模型（embedding），不属于对话模型，在「能力模型」的向量 section 配置（厂商 + 模型 + key），向量来源 section 决定用本地模型还是该配置。
- 本地模型已钉型号（DEV-007 已落实）：`jina-embeddings-v2-base-zh` q8 量化 ONNX 导出（768 维，中英双语，约 163MB）+ `onnxruntime-node` 运行库（约 114MB），二者合成一张环境审批卡、按需下载到应用私有 `toolchains/`（不入安装包），GPU 加速按平台自动选择（macOS CoreML / Windows DirectML，回退 CPU）。细节见 [16-capability-models.md](16-capability-models.md)「向量来源的本地实现」。
- 更换向量模型需要重建记忆的向量索引。

## 国内厂商与能力模型

国内主流平台（阿里云百炼、火山方舟）的对话接口都兼容 OpenAI `/chat/completions`；其余模型能力（向量、重排、多模态、语音、图片、视频）的配置与逐厂商适配见 [16-capability-models.md](16-capability-models.md)。要点：

- **按能力配置**：设置页每种能力一个 section（厂商 + 模型 + key），一种能力至多一条生效配置；厂商下拉只列已适配该能力的厂商，端点差异全部下沉到适配层。
- **两层实现**：描述层（`packages/shared/src/domain/vendors.ts`）承载厂商 id、默认 baseUrl、能力矩阵与各能力预置模型，设置 UI 与 core 路由共享同一份事实；适配层（`packages/core/src/media/`）每家厂商一个 adapter，`MediaService` 按能力配置解析厂商后路由。新增厂商 = 描述符 + 适配器 + ADAPTERS 表登记一行。
- **API key 按厂商共享**：对话与各能力复用 `provider:{厂商id}` 这一条 key，在任意 section 设置后全局生效；厂商条目可覆盖 OpenAI 兼容根（如切换地域），能力配置不单独存 baseUrl。
- 暴露的 RPC：`media.generateImage / synthesizeSpeech / transcribeSpeech / generateVideo / videoStatus / rerank / understandImage`；向量能力供 memory 的向量来源（`GatewayEmbedder`）与 embedding 探测共用。

### 连通性测试按能力路由

每个能力 section 与厂商卡片都可「测试连接」（`providers.test`），按能力发一次最小真实请求（对话 = pi ping；向量 = 一次单词 embed；重排 = query + 2 条文档；多模态 = 内置纯色 PNG；图片/语音 = 最小生成；视频 = 提交即取消）。详见 [16-capability-models.md](16-capability-models.md#连通性测试providers-test-带-capability)。

## 浏览器工具

每个 Bot **默认具备**浏览任意网页的能力，无需安装。

### 实现

- 使用 Electron 内置的 Chromium。
- 浏览器页面由主进程托管，核心服务通过内部 IPC 控制；使用 Electron 自带的调试协议接口（`webContents.debugger`），**不开放远程调试端口**。
- 能力：打开网页、读取页面结构与文本、点击、输入、滚动、截图、下载（下载到当前 workspace）。

### 动作结局与防护（D77）

模型必须能区分「没做」「做了」「不确定」，否则一次快照失败就可能让它把已提交的表单再提交一遍。

- **结局三态**：打开网页、点击、输入、按键、滚动、后退的结果带 `outcome`：
  - `not_started`：派发前失败（参数错、ref 失效或预检不符、页面已关闭、请求被拦截等），`ok:false`，可以重试；
  - `completed`：调试协议调用已返回。之后取快照失败仍按成功返回（`ok:true`），文本写明「动作已执行，但获取页面快照失败……不要重复该动作」，模型应先 `browser_snapshot`；
  - `uncertain`：已经派发之后出错或超时（含操作中页面跳转、重载、崩溃），`ok:false`、`BROWSER_OUTCOME_UNKNOWN`，提示先快照核实，确认未生效再做，涉及提交 / 付款 / 发送时用 `ask_user` 问用户。
  - 判定依据是宿主错误上的阶段标记（`details.phase`：派发前 `pre` / 派发后 `post`）。没有阶段标记的错误：失效 ref、页面关闭、被拦截、参数错、Bot / 对话已删除、浏览器不可用按 `not_started`；其余在点击 / 输入 / 按键 / 后退上按 `uncertain`（宁可多报不确定），在打开网页与滚动上按 `not_started`（GET 导航与滚动可安全重做）。
  - 工具说明统一写明：已完成或结果不确定的动作不要重放；不确定先快照核实。
- **ref 指纹预检**：快照里的每个 ref 记下节点、角色与可访问名。点击 / 输入前重新解析节点（按键不带 ref，不做预检），检查仍在文档中、可见、未禁用，且角色与名字仍和快照一致（名字去掉短数字串后比前 40 字，快照名被截断时允许前缀匹配）；不符返回 `BROWSER_REF_STALE`（不派发，提示重新快照），元素被禁用（`disabled` 或 `aria-disabled="true"`）同样返回 `BROWSER_REF_STALE`。点击在同一 JS 回合里再校验一次，输入先确认焦点确实落在目标上，避免预检与派发之间的页面变化。
- **无进展熔断**：同一动作（动作 + 目标 + 参数）连续 `BROWSER_NO_PROGRESS_LIMIT`（3）次后页面都没变（快照文本去掉 ref 编号后的 hash，并入元素的值与勾选 / 展开等状态），第 4 次直接返回 `BROWSER_NO_PROGRESS`（不派发），提示换做法或问用户。只统计点击、输入与 Enter / Escape 键；滚动、其他按键、后退、打开网页不计数并清零。`browser_screenshot` 与上一张相同时不回图，只回一句「上一张仍有效」。两者都按 run 计：另一个 run 操作过该页面即清零。
- **敏感输入**：`browser_type` 有可选参数 `sensitive`（密码、验证码、卡号必须置 true）；目标是密码框时宿主强制按敏感处理。敏感值不进结果文本，执行记录里该参数写成 `«redacted:N chars»`，同一 run 之后落盘的步骤与续接摘要中出现的该值一并抹掉，也不进外部副作用台账（D78）。残留：模型未标注、执行中才发现的密码框，其明文在该次调用执行期间短暂存在于执行记录；外部智能体自身会话里的参数不受控。凭据按站点自动填充（不经模型）不在本期范围。
- **元素上限**：快照最多列 150 个交互元素（`BROWSER_SNAPSHOT_MAX_ELEMENTS`），截断时在末尾提示「还有 N 个元素未列出」，可滚动或缩小范围。

### 隔离

- 每个 Bot 使用独立的浏览器会话：cookie、登录状态、缓存互相隔离，与用户自己的浏览器完全无关。
- 需要登录的网站，由用户在该 Bot 的浏览器窗口中手动登录，登录状态保存在该 Bot 的会话中。
- 页面内容视为不可信输入，遵循信任隔离规则，见 [06-isolation-and-storage.md](06-isolation-and-storage.md#信任隔离防提示注入与记忆污染)。
- 删除 Bot 时清理其浏览器会话数据。

### 网络

| 目标 | 默认 |
|---|---|
| 公网任意网页 | 可访问 |
| 本机端口（localhost） | 对话绑定了 project 时可访问，用于查看和测试开发服务器 |
| 其他内网地址、链路本地地址、云服务器元数据接口 | 拦截 |

### 可见性

用户可以打开 Bot 的浏览器窗口，实时查看它正在操作的页面。目前用户与 Bot 可以同时操作同一页面，没有独占；用户一操作即接管的接管租约、以及多个 Bot 显式共享浏览器资料，原计划随 D77 一起做，本轮暂缓（见 [todo/borrowings-from-personal-agents.md](../../todo/borrowings-from-personal-agents.md) W8）。
