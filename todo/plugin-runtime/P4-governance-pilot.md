# P4 · 治理管线与百炼文生图执行型试点

> 状态：**已实施（2026-11-16，开发收口；真机验收待用户执行）** · 依赖：本方案 P1–P3 · 分支：`feat/plugin-platform`（未提交，按用户要求不执行 git 操作）
> 必读：[61 号设计 §7 / §8](../../docs/design/61-plugin-runtime-platform.md)、[51 号 §安装管线/市场](../../docs/design/51-plugin-system.md)、[16 号逐厂商 API 参考](../../docs/design/16-capability-models.md)（百炼文生图协议事实）、`packages/core/src/media/adapters/dashscope.ts`（协议现成实现，本试点的对照物）

## 1 目标

治理自动化落地（同意卡能力披露 UI、市场 CI 静态扫描钩子），并用首个执行型官方插件——**阿里云百炼文生图（`plugins/dashscope-t2i/`）**——走通「安装 → 配置 → Bot 绑定 → 运行 → 反馈 → 产物」全链路作为 D125 收口 dogfood。

**试点定位（重要）**：百炼文生图协议与内置 `dashscope` 引擎**同源**（wan 系列异步：`X-DashScope-Async` 提交 + `GET /api/v1/tasks/{id}` 轮询），内置引擎已能跑通同能力。试点**有意**在插件内重新实现该协议（经 `host.net.fetch`），目的是 A/B dogfood 执行型运行时的全路径（提交/轮询/进度/取消/错误映射/产物落附件），而非补能力空白。收口时在实施记录里给出 A/B 结论（两条路径的行为与观测差异），并就「参考插件保留为样例 or 退役」给出建议——该去留是用户决策，不在本阶段自行定。

## 2 范围

| 包含 | 不包含 |
|---|---|
| 同意卡能力披露 UI（联网域名 / 凭据字段 / 存储配额） | community 执行型开放（Q4） |
| 市场 CI 静态扫描钩子（native/eval/远程动态 require/白名单一致性） | 索引服务端新机制（沿用 D104 签名/撤销） |
| `plugins/dashscope-t2i/` 执行型试点（wan 异步文生图协议，插件内自带实现） | 试点插件正式上架运营（走既有 release 流程） |
| A/B dogfood 记录（执行型路径 vs 内置引擎路径） | `host.secrets.set`（Q1；若试点证实必需，只记入 61 §11 修订建议） |
| 全量 `pnpm test` 收口一次 | 任何新引擎/新契约 |
| 61 号补「现状」节、51 号 §15 回写 | — |

## 3 开工前核对

```bash
git log --oneline -3
rg "DEV-" DEVIATIONS.md | tail -5
node scripts/run-tests.mjs run packages/core/test/unit/plugin-host.test.ts   # P2 基线绿
rg "X-DashScope-Async" packages/core/src/media   # 协议对照实现定位
```

## 4 步骤

### 步骤 1：同意卡能力披露

安装同意卡（D104 既有组件）对含 `runtime` 清单增渲染区：「可联网域名」清单（逐条列出，含通配说明）、「将请求的凭据」字段名列表（不含值）、「本地存储」配额说明；更新时清单扩大 → 重新同意（D104 既有 diff 机制延伸）。文案口径与 D104 一致（能力 = 事实披露，不做安全承诺措辞）。

### 步骤 2：市场 CI 扫描钩子

官方插件索引构建流程（现有 CI）对含 `runtime` 的包逐版本加静态扫描步骤（Node 脚本，结果进构建产物状态）：

1. 文件面：`.node` / `.wasm` / 可执行位 / symlink 逃逸 → fail；
2. 代码面（对打包 JS 文本）：`eval(`/`new Function(`/`require('child_process')`/`process.binding`/`Worker(`/非白名单动态 `import(` → fail；
3. 白名单一致性：提取包内字符串中的 `https?://host` 与 `network.allow` 比对，未知域 → warn（人工复审）；
4. 结果写入索引条目（复用 tier/状态机制），fail 不出包。

### 步骤 3：`plugins/dashscope-t2i/` 执行型试点插件

1. manifest：`id:'io.kepcup/dashscope-t2i'`、展示名「百炼文生图（执行型试点）」、`runtime:{entry:'dist/main.js', hostApi:'^1', network:{allow:['dashscope.aliyuncs.com']}}`、`instances:['capability-model']`、实例字段 `{apiKey: sensitive, required}`、`contributions.capabilityModels` 一条 image 条目（`model` 取 16 号 wan 系列预置 id、**不填 `engine`**、`params` 带默认 size/n）。
2. 实现（SDK，协议以 `dashscope.ts` 与 16 号文档为准）：`generateImage` = 组参（`model/prompt/size/n/seed`，prompt 顶层 `input.prompt`）→ `host.net.fetch` POST（`X-DashScope-Async: enable`）拿 `task_id` → 轮询 `GET /api/v1/tasks/{task_id}`（2s 间隔，状态机 PENDING/RUNNING→SUCCEEDED/FAILED 映射）→ `host.progress` 上报（排队/生成中 + 百分比估算）→ 返回 `output.results[].url`（下载落附件由 core 做）；`host.signal` 取消 = 尽快返回（服务端任务自然过期，不做删除调用）。
3. 错误映射：401 → `PROVIDER_AUTH_FAILED`、402/配额词 → `PROVIDER_QUOTA`、429 → `PROVIDER_RATE_LIMITED`、其余 → `PROVIDER_UNAVAILABLE`（与人话文案表对齐）。
4. 真机验收：Bot 绑定条目 → `generate_image` 一条真实出图 → 进度阶段可见（排队/生成中）→ 产物落附件 → 活动抽屉全记录 → 插件卡 busy→ready。
5. **A/B 对照**：同 prompt/size 分别走插件条目与内置引擎全局槽位各一次，记录差异（延迟/错误文案/活动记录形态）进实施记录。

### 步骤 4：全量收口与文档回写

```bash
pnpm test   # 全量一次（阶段收口，AGENTS.md）
```

1. 61 号补「§12 现状（D125 收口后）」——仿 51 §15：实际落地与决策差异、迁移实际号、DEV 偏差索引、试点 A/B 结论。
2. 51 号 §15 增「运行时平台」小节指向 61；design/README 61 号索引行状态改「已实施（日期）」（评审通过后）。
3. AGENTS.md / docs/dev 若需补「执行型插件开发指引」链接（指向 SDK README），最小增量。

## 5 验收

- [x] 同意卡对执行型插件显示三项披露；更新扩权触发重新同意。证据：`PluginConsentPanel.svelte` 渲染 `plugins-consent-runtime[-network|-credentials|-storage]`；`plugin-runtime-disclosure.test.ts`（4 用例）；`plugin-host.test.ts`「更新扩权（D125 P4）」断言 `permissionsExpanded` + `added` 含 `执行型插件新增可访问的网络域名 api.example.com` / `执行型插件新增实例凭据字段 secretKey`，无 `acknowledgeDiff` 时 `INVALID_INPUT`。
- [x] CI 扫描钩子对违规样例包 fail（样例进测试夹具）、对 reference-media 与 dashscope-t2i 放行。证据：`scripts/scan-plugin-runtime.mjs`；`scan-plugin-runtime.test.ts`（14 用例，含 .node/.wasm/.dll/.so/.exe/可执行位/symlink、eval 标识符（含 `(0,eval)` / 全局成员混淆）/Function(/require/createRequire/process.binding/getBuiltinModule/Worker、静态与动态 import（受限内置模块、data:/远程、拼接、包外路径、无扩展名相对 import、注释 trivia）、反射式取全局（Reflect/getOwnPropertyDescriptor/constructor.constructor）、域名 warn、entry 的 ESM 策略（`.js/.mjs`、`.js` 需 `type: module`、禁嵌套 package.json）、`.kepcup-ignore` 目录口径、真实两包 pass）；`sign-plugin-index.test.ts` 新增 5 用例（runtimeScan 写入索引 / warn / fail 拒签 / 无扩展名 entry 扫描 / 可执行位与 symlink 拒签）。
- [ ] 百炼文生图试点真机全链路一次成功出图 + A/B 对照记录。证据：集成层全链路（真实子进程 + 假 fetch）在 `plugin-host.test.ts`「百炼文生图执行型试点…」与「A/B 对照（集成层）」；**真机待用户验证**（无 API Key）：填入 Key → Bot 勾选条目 → `generate_image` 一次，见 61 §12.4 与 `plugins/dashscope-t2i/README.md`。
- [x] 全量 `pnpm test` 一次全绿。证据：2026-11-16（P4 独立审查修正后，最终工作区）原样输出：
  `Test Files  803 passed | 3 skipped (806)` / `Tests  8646 passed | 44 skipped (8690)` / `Duration 171.78s`。
  开发首轮的 8633 passed 基线是修复两处回放测试未摘除 `plugin_storage` 后的结果；审查轮新增
  兼容 / 扫描 / SSRF / 试点取消 / ESM entry 用例后为 8646。审查中还修正了 `media-tools.test.ts` 的视频下载打桩：
  `safeFetch` 改用 undici 自身的 fetch 后，旧的 `globalThis.fetch` 打桩不再生效（4 个用例暴露）。
- [x] 61/51 号文档回写完成。证据：61 §12（现状 / 迁移 / DEV 索引 / A/B / Q1–Q5 / 验收锚点）、51 §15.10、design/README 61 行与 D125 行状态、AGENTS.md 与 docs/dev 的执行型插件开发指引、DEVIATIONS DEV-123..129。

## 6 实施记录

- 分支 / 提交：`feat/plugin-platform`，基于 `69e11af0`（D125-P3 收口）；本阶段按用户要求**未 commit / 未 add**，工作区改动即交付物。
- DEV-114 方案 1：`runtime.instanceFields`（复用 `pluginFieldSchema`，≤16，key 查重）+ `invoke.context.instanceId`（可选）；core `capabilityModelInstanceFields` 合并 runtime 声明（声明序去重）→ 实例表单 / secrets / `ctx.credentials` 全链；`runtimeDisclosureOf.credentialFields` = runtime 敏感键 ∪ 引擎凭据。测试：shared schema 接受 / 拒重复 key / 上限（`plugin-manifest-capability-models.test.ts`）、invoke 帧 instanceId（`plugin-runtime-protocol.test.ts`）、真实子进程 credentials + instanceId（`plugin-host.test.ts`）、inspect 披露（同文件）。
- A/B 对照结论（执行型 vs 内置引擎）：见 61 §12.4。要点：内置 `dashscope.generateImage` 是 qwen-image **同步**接口，未实现 wan 异步文生图（任务书「同源」前提需修正）；插件路径有 2s 轮询节奏、四段进度、插件活动记录、可取消；内置路径单请求、无插件级进度 / 活动 / 工具取消链。错误文案分别来自插件映射与 `media/http.ts`。真机待用户验证。
- 实际迁移号 / DEV 偏差汇总：迁移 **0076**（无新增）；DEV **123–129**（见 DEVIATIONS）。
- 独立审查修正（2026-11-16）：①`ready.features` 握手让旧 SDK 不收到 `instanceId`（原草案会静默丢帧直到超时）；②静态扫描按绕过实测加固（`(0,eval)`、`Function()`、全局/process 计算成员、`createRequire` + 静态 import、`data:` import、拼接 specifier、注释 trivia、模板插值 / 正则掩码失步、无扩展名相对 import；并把 entry 收紧为 `.js/.mjs` + `type: module` 的 ESM 约定、目录扫描镜像 `.kepcup-ignore`），已知假阴性面见 DEV-129；③`safeFetch` 改用 undici 自身的 `fetch`——全局 fetch 与外部 Agent 版本漂移会 `UND_ERR_INVALID_ARG`，所有公网产物下载都会失败（新增真实连接链路测试）；④`runtime.instanceFields` 与引擎凭据字段重名拒绝、`networkDomains` 去重；⑤试点 `sleep` 清理 abort 监听（长轮询不再累积）。
- 遗留与建议（Q1–Q5 中被试点证实的项、参考插件去留建议）：
  - Q1 `host.secrets.set`：试点未需要（用户填 Key，只读注入足够）；维持只读。
  - Q2 并发：试点串行无瓶颈；维持。
  - Q3 / Q5：未涉及，仍未决。Q4：扫描管线已落地，community 执行型维持拒绝。
  - 参考插件 `plugins/reference-media` 的去留（保留为开发者样例 or 退役）留给用户决策；本阶段未改动其定位。
  - 建议后续：真机确认 wan 文生图 model id（DEV-124）；`runtimeScan` 是否在市场 UI 展示（当前只写索引，未消费）；静态扫描的已知假阴性面（变量别名的计算成员、`Object.getPrototypeOf(...).constructor`、Unicode 转义标识符）只能靠 verified 人工复审兜底，见 DEV-129。
