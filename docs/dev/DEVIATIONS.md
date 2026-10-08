# 偏差与待确认问题

记录规则见 [README.md](README.md#偏差与问题)。每条一节，按编号递增，处理后不要删除，只更新状态。

状态取值：`待决定` / `已决定` / `已落实`。

## 模板

```markdown
### DEV-001 （简短标题）

- 状态：待决定
- 阶段：Pxx
- 是否阻塞：是 / 否
- 问题：（发现了什么，与哪份文档的哪一节冲突）
- 影响范围：（涉及的模块、阶段）
- 可选方案：
  1. （方案）— 优点 / 缺点
  2. （方案）— 优点 / 缺点
- 推荐：（方案编号及理由）
- 决定：（由人工填写）
- 已更新的文档：（落实后填写）
```

## 条目

### DEV-001 测试用 file keystore（超出 05-testing.md 记载的 memory 实现）

- 状态：待决定
- 阶段：P00
- 是否阻塞：否
- 问题：[05-testing.md](05-testing.md#测试夹具) 只定义了 `KEPCUP_KEYSTORE=memory` 的内存钥匙串。内存实例不能跨进程存活，端到端测试"杀掉核心服务后自动重启并恢复"时，重启出的核心进程拿到的是空钥匙串 + 已存在的数据库，会直接进入 `locked`，无法验证恢复路径（真实场景下系统钥匙串会返回同一把密钥）。
- 影响范围：`packages/core/src/infra/keystore.ts`、端到端测试（`apps/desktop/test/e2e/lifecycle.spec.ts`）。
- 可选方案：
  1. 新增仅 `NODE_ENV=test` 时可用的 `KEPCUP_KEYSTORE=file` 实现（密钥明文写入 `KEPCUP_FILE_KEYSTORE_PATH`，权限 0600；非 test 环境设置该值会拒绝启动）— 实现小、贴近真实行为；代价是密钥明文落盘（仅测试环境）。
  2. 崩溃重启用例改为不重启核心进程，仅测试主进程重启逻辑 — 无法覆盖真实的"核心崩溃后 UI 恢复"路径。
- 推荐：方案 1（已在 P00 实现并通过测试）；若人工认为不妥，可改为把 e2e 降级为手工验证并移除 file keystore。
- 决定：（由人工填写）
- 已更新的文档：（落实后填写）

### DEV-002 pi 的 API key 注入机制：CredentialStore 而非 Agent `getApiKey`

- 状态：已落实
- 阶段：P01
- 是否阻塞：否（已实现，等待人工确认）
- 问题：[04-agent-runtime.md](04-agent-runtime.md#pi-的封装) 的映射表写"API key 通过 `getApiKey` 回调，从 secrets 表解密提供"。pi 0.87.1 中注入密钥的正规入口是 `createModels({ credentials })` 的 `CredentialStore`（`read(providerId)` 在每次请求的鉴权解析时调用）；`Agent` 构造参数虽有 `getApiKey`，但仅用于覆盖请求 options，业务侧自建 `Models` 集合时应使用 CredentialStore。
- 影响范围：`packages/core/src/agent/models.ts`（唯一接入点）；AgentEngine 接口不变。
- 可选方案：
  1. 自定义 `CredentialStore`，`read()` 从 secrets 表按 provider 解密（当前实现）。密钥仅在每次请求的鉴权解析中解密，不落盘、不进环境变量、不写 pi 配置文件，与设计意图一致 — 优点：走 pi 官方路径，支持内建厂商目录；缺点：与文档表格的表述不同。
  2. 每次请求显式传 `apiKey` options — 需要包装 `streamFn`，绕过 provider 鉴权链路，侵入性更强。
- 推荐：方案 1（保持现状），并更新 04-agent-runtime.md 的表述为"CredentialStore（每次请求时从 secrets 表解密提供）"。
- 决定：采纳方案 1（2026-09-30 审查报告 BR-P01-004 确认保持 CredentialStore 并同步文档）。
- 已更新的文档：04-agent-runtime.md 映射表已改为 CredentialStore 表述（2026-09-30）。

### DEV-003 自带 bwrap / socat（Linux）：无可靠的跨发行版静态构建

- 状态：待决定
- 阶段：P02
- 是否阻塞：否（Linux 上当前改用系统 PATH 中的 bwrap / socat，缺失时沙箱探测失败并给出安装提示）
- 问题：[10-sandbox.md](../design/10-sandbox.md#默认级srt) 要求"应用自带其依赖：rg（所有平台）、bwrap、socat（Linux）"。rg 14.1.1 已按平台落位 `apps/desktop/resources/bin/{platform}-{arch}/`（Linux 为 musl 静态链接，可直接自带）。但 bwrap 与 socat 上游均不发布静态构建：Ubuntu/Debian/Fedora 的发行版包都是动态链接（glibc 版本不一，Ubuntu 24.04 的二进制在 Debian 12 上不可用），复制单个二进制无法覆盖 05-testing.md 要求的三个发行版。
- 影响范围：`packages/core/src/sandbox/backend-srt.ts`（`bwrapPath`/`socatPath` 仅在自带文件存在时传入，否则走系统 PATH）、Linux 的沙箱可用性探测（缺失时 `probe()` 返回不可用 + 安装命令提示）、CI（Ubuntu 增加 `apt-get install bubblewrap socat`）。
- 可选方案：
  1. Linux 上使用系统包管理器安装的 bwrap / socat，缺失时在设置页提示安装命令（当前实现）— 优点：立即可用、无供应链风险；缺点：首次使用需要用户装两个包，与"随应用自带"的设计不符。
  2. 自行构建静态 bwrap / socat（musl 工具链）并随应用分发 — 优点：符合设计、零依赖；缺点：需要维护构建流水线并跟踪上游安全更新，超出本阶段范围。
  3. 打包发行版的 .deb/.rpm 并在首次运行时引导安装 — 优点：用户操作少；缺点：引入包管理依赖，跨发行版维护成本高。
- 推荐：短期维持方案 1；P06（环境管理器）落地后用方案 2 或 3 补齐（环境管理器本就负责宿主层依赖的安装与引导）。
- 决定：（由人工填写）
- 已更新的文档：（落实后填写）

### DEV-004 大仓库首次检查点快照超过 10 秒

- 状态：待决定
- 阶段：P04
- 是否阻塞：否（一次性成本，后续快照实测 0.2 秒；任务书要求的测量已完成并给出方案）
- 问题：[P04 任务书](phases/P04-project.md#需验证技术点)要求在 5 万文件级别的仓库上测量首次快照耗时，超过 10 秒时记录偏差并提出方案。实测（macOS arm64，200 目录 × 250 文件 = 5 万文件）：首次快照（addAll + writeTree + commit）15.1 秒，其中 addAll 13.7 秒；第二次无改动快照 0.16 秒（libgit2 按 stat 跳过未变文件）。首次快照阻塞在取得租约的工具调用内（`waiting_lease` 语义下不消耗 token），但用户可感知。
- 影响范围：`packages/core/src/project/checkpoints.ts`（`snapshot()`）。
- 可选方案：
  1. 接受现状（当前实现）：首次快照一次性 O(全部文件)，之后每次快照只重刷变化文件 — 优点：实现最简、正确性由 libgit2 保证；缺点：超大仓库首次绑定后第一次写入前的等待明显。
  2. 首次快照只纳入 git 已跟踪文件 + 本次改动文件（任务书建议的方案）：打开 project 自身 `.git`（只读）读 index 取已跟踪清单，未跟踪文件按需 — 优点：常见大型项目（node_modules 已被 ignore，跟踪文件数千级）秒级完成；缺点：需处理 project 不是 git 仓库的情况（回退方案 1）、与自身 `.git` 只读约束的边界（只读 index，不写）。
  3. 快照移到后台进行，租约先发放 — 违反"快照必须在第一次写入之前完成"的任务书注意事项，不可取。
- 推荐：先维持方案 1（正确、可预期），把方案 2 作为 P06+ 的体验优化项；如人工认为 15 秒不可接受，再按方案 2 实施。
- 决定：（由人工填写）
- 已更新的文档：（落实后填写）

### DEV-005 srt 0.0.78 不支持限制本机端口范围（allowed_ports）

- 状态：待决定
- 阶段：P04
- 是否阻塞：否（设计的默认行为"默认不限"完整实现并验证；端口范围是可选的收紧配置）
- 问题：[08-project.md](../design/08-project.md)（"每个 project 可以限定允许的端口范围（默认不限）"）与 P04 任务 8 要求按 `allowed_ports` 限制沙箱可访问的本机端口。srt 0.0.78 的网络配置只有 `allowLocalBinding` 布尔值（seatbelt 规则 `(allow network-bind (local ip "*:*"))` + `(allow network-outbound (remote ip "localhost:*"))`），不存在端口范围字段；且沙箱子进程环境含 `NO_PROXY=localhost,127.0.0.1,...`，回环访问完全绕过 srt 代理直连（由 seatbelt 规则裁决），代理层的 `filterRequest` 回调对回环流量不可见，无法按端口过滤。
- 影响范围：`packages/core/src/sandbox/policy.ts`、`packages/core/src/sandbox/backend-srt.ts`、projects 表的 `allowed_ports_json` 列与项目设置界面。
- 可选方案：
  1. 端口范围存入 projects 表并在设置界面可配置，当前版本不强制（当前实现；界面注明"当前沙箱版本不强制端口范围，仅记录配置"）— 优点：数据模型与设计一致，升级 srt 后即可接入；缺点：配置了范围的 project 实际不受限。
  2. 升级 srt 到支持端口范围的版本后接入（关注 srt 上游 issue；P12 增强沙箱阶段可自行生成 seatbelt 规则 `(allow network-outbound (remote ip "localhost: N-M"))`）。
- 推荐：方案 1（当前实现），srt 版本升级后按方案 2 收口。
- 决定：（由人工填写）
- 已更新的文档：（落实后填写）

### DEV-006 es-git 0.7.0 的 diff.print() 丢失行前缀；检查点 diff 文本改用系统 git CLI 生成

- 状态：待决定
- 阶段：P04
- 是否阻塞：否（检查点 diff 查看功能完整可用，改动仅涉及其文本来源）
- 问题：P04 任务书指定检查点影子仓库使用 es-git。实现中发现 es-git 0.7.0 的两个绑定缺陷：① `Diff.print()`（含显式 `format: 'Patch'`）输出的 hunk 内容丢失 `+`/`-`/空格 行前缀（如 `+world` 输出为 `world`），产出的文本不是合法 unified patch，@pierre/diffs 无法解析；② `initRepository(path)` 会自动在路径后追加 `/.git/`（即真实 gitdir 是 `checkpoints.git/.git/`），而 `noDotgitDir: true` 又要求显式 workdir 并会在 workdir 中创建 `.git` gitlink 文件——违反"不在 project 目录创建任何应用自己的文件"的底线。
- 影响范围：`packages/core/src/project/checkpoints.ts`。
- 处理（当前实现）：
  - 布局：影子仓库以 `bare: true, noDotgitDir: true` 初始化于 `checkpoints.git`，再经配置 `core.bare=false` + `core.worktree=<project>` 指向工作区（与 git 次级工作树同构）。libgit2 正常读写，project 目录零文件，系统 git CLI 可直接操作该 gitdir。
  - diff 文本：`Diff.print()` 不可用，改为 `spawnSync('git', ['--git-dir', <shadow>, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', <before>, <after>])` 生成标准 unified patch（外部 diff 驱动已禁用；影子仓库为应用自有数据，不触碰用户仓库）。系统未装 git 时 diff 文本为空，界面显示"该检查点已超出保留期，无法显示 diff"。
- 可选方案：
  1. 维持当前实现（系统 git CLI 生成 diff 文本）— 优点：立即正确；缺点：diff 查看依赖系统 git（git_remote 本就依赖系统 git，依赖面未扩大）。
  2. 自实现 Myers diff 从 es-git 读取的文件内容生成 patch — 优点：零 CLI 依赖；缺点：自写 diff 算法的正确性/性能风险，收益低。
  3. 向 es-git 上游报告 print() 缺陷，修复后切回 — 与 1 不冲突，可作为后续演进。
- 推荐：维持 1，同时向 es-git 上游报缺陷（3），升级后可切回纯 es-git。
- 决定：（由人工填写）
- 已更新的文档：（落实后填写）

### DEV-007 本地向量模型（embedding-model）的 ONNX 推理运行库：新大型依赖，待人工决定

- 状态：已落实（2026-10-04，按「运行库与模型经环境管理器按需下载、不入应用安装包」的方向实现，见下方"决定"）
- 阶段：P07
- 是否阻塞：否（已实现并有测试；三平台实测体积与耗时见 todo/cross-platform-acceptance.md P07 小节——macOS arm64 已实测，Windows/Linux 待复测）
- 问题：[P07 任务书](phases/P07-memory.md) 任务 2 要求本地向量实现"在核心服务中用 ONNX 推理运行小型多语言向量模型（运行库与模型型号需验证后确定）"。候选运行库（`@huggingface/transformers` / `onnxruntime-node` 及其原生绑定）属[全局纪律](../../todo/handoff-P07-P13.md)定义的**新大型依赖**（原生模块 + 运行时），须先记 DEVIATIONS 等待决定；模型型号选择（要求中英文效果良好、文件 ≤200MB、CPU 单条 ≤50ms）也需在运行库确定后实测三个平台。因此 P07 交付：`Embedder` 接口 + `LocalEmbedder` 占位实现（`ready()` 恒为 false，`embed()` 抛 `NOT_IMPLEMENTED`）+ 环境目录 `embedding-model` 预留条目（`downloadPending` 标记，不下载任何文件）+ 系统发起的 `environment` 审批全流程（botId null）。未启用本地模型期间检索按任务书退化为全文检索（bm25 OR 组合，见 PROGRESS P07 的 Segmenter 结论），厂商向量接口（OpenAI 兼容 `/v1/embeddings`）完整可用。
- 影响范围：`packages/core/src/memory/embedder.ts`（LocalEmbedder）、`packages/core/src/env/catalog.ts`（embedding-model 条目）、`packages/core/src/memory/manager.ts`（memory_vec 建表已就绪，维度来自 embedder）、设置页向量来源（P07-B 界面）。DEV-007 落实时：在 catalog 条目钉住 url/sha256/version、清除 `downloadPending`、实现 LocalEmbedder（加载 `toolchains/embedding-model/{version}/` 模型）并在三平台实测体积与耗时。
- 可选方案：
  1. `@huggingface/transformers`（ONNX Runtime Web/Node 封装）+ 型号如 `jina-embeddings-v2-base-zh` / `bge-m3` 量化版 / `multilingual-e5-small` onnx — 优点：生态成熟、模型仓库可直接拉 ONNX；缺点：依赖体积大（原生 binding + shader 等），需评估打包体积与 utilityProcess 内加载。
  2. `onnxruntime-node` 直接 + 自管理 tokenizer（tokenizers wasm）— 优点：依赖面最小、可控；缺点：tokenizer 与预处理自行维护，工作量大。
  3. 放弃本地推理，仅提供厂商向量接口 — 优点：零新依赖；缺点：与 design/14"默认使用本地的小型多语言向量模型"冲突，离线场景不可用。
- 推荐：方案 1，型号在 Mac（arm64）上以 20 条中英文样例实测召回与耗时后钉死，再于 Windows/Linux 复测（跨系统清单）。
- 决定：以**方案 2 为基础**落地（2026-10-04）——运行库选 `onnxruntime-node`（方案 1 的核心正是它的封装，直接用可少一层抽象），tokenizer 自实现纯 TS（`memory/bpe-tokenizer.ts`，RoBERTa 字符级 BPE，避开 tokenizers wasm 依赖；与 HF tokenizers 逐 id 对齐）。与原推荐的关键差异：**运行库不进应用安装包**，而是新增环境条目 `onnxruntime`（npm 官方 tarball，`registry.npmmirror.com` 分发、与 registry.npmjs.org 字节一致且 integrity 核对一致），与 `embedding-model` 合成**一张审批卡**、批准后链式安装到 `toolchains/`——安装包体积零增长，运行库/模型可独立升级。模型钉 `jina-embeddings-v2-base-zh` q8 量化 ONNX 导出（jinaai 官方权重 Apache-2.0，Xenova 移植；ModelScope 分发），768 维、中英双语、约 163MB。GPU 加速按平台自动选执行单元（`env/gpu.ts`）：macOS CoreML（随包内置）、Windows DirectML（随包携带 DirectML.dll，任意 DX12 显卡）、Linux CPU（npm 包未携带 CUDA EP），首选 EP 会话创建失败回退 CPU。实现：`env/catalog.ts` 新增 `files` 安装类型（多文件钉住 + 归档解包落位）、`EnvManager` bundle 审批与 `#ensureChainedItem`、`memory/embedder.ts` 真实 `LocalEmbedder`（createRequire 从 toolchains 加载、模块级会话缓存、mean 池化）。macOS arm64 实测：模型+运行库合计 276,331,875 字节（约 276MB）、语义方向正确（同义 0.65 / 跨语言 0.68 / 无关 0.04）、短句 warm 约 4ms（CPU EP）/ 约 26ms（CoreML EP），≤50ms 达标；会话创建约 170ms-2s；1024 token 单条约 367ms，产品截断 512。
- 已更新的文档：design/14（向量模型型号）、design/16（向量来源：本地运行库与 GPU 选型）、design/07（宿主层环境条目）、design/11（toolchains 布局）、dev/phases/P07-memory.md（任务 2 实现记录）、PROGRESS.md（P07 补充交付）。

### DEV-008 ZCode（智谱）外部智能体放弃接入（D72 P5）

- 状态：已落实（2026-10-08，放弃；目录不收录）
- 阶段：D72 P5（外部智能体引擎第二部分）
- 是否阻塞：否（其余 Agent 不受影响；ZCode 不进目录）
- 问题：todo/acp-external-agents.md 附录 A.1 的 P0 只读评估认为 ZCode Protocol 的门禁项都能映射，计划以进程内垫片（`transport:'shim'`）拉起用户已装 ZCode 桌面应用自带的 `resources/glm/zcode.cjs app-server --stdio`。P5 实现前逐项核对 v3.14.3 源码（未运行任何程序）发现：
  1. **认证无法在不碰凭据的前提下映射（决定性）**：app-server 模式下 ZCode 的订阅登录（`zcode login` / GLM Coding Plan）由宿主提供：进程级 Provider Registry 不带凭据（`startProcessProviderRegistryRuntime(env)` 不传 `standalone`），账号模型的配置经 `provider/updateAccountConfig` 由宿主推送、每次模型请求前经反向请求 `interaction/requestProviderRuntimeHeaders` 向宿主索取鉴权头；KepCup 若接入就必须自己读取 / 中转用户的 ZCode 凭据，违反「不读取、不中转任何凭据」（design 28 §9.1）（`bootstrap/src/zcode-protocol-entrypoint.ts`、`app/process-provider-registry-runtime.ts` `startProcessProviderRegistryRuntime`、`zcode-protocol/provider-runtime-headers.ts`、`zcode-protocol/workspace-model-runtime.ts`）。`zcode login` 写入的 `~/.zcode/v2/credentials.json` 只被 CLI 的独立模式（`prompt` / TUI 的 `createStandaloneProviderRuntimeHeadersPort`）使用，app-server 不读。不提供鉴权头时账号模型请求失败；只有用户在 ZCode 里自配的 API key Provider 可用——这不是目录条目承诺的「GLM Coding Plan 登录」。
  2. **档位只能部分映射**：`edit` 模式对写入「不区分工作区内外」自动批准（`core/src/tool/path-policy.ts`），`auto` 一律拒绝、`yolo` 全放行；可用的只有 `plan`（只读）与 `build`（写入 / 命令询问）。但 `build` 之前还会被用户级 `~/.zcode/cli/config.json` 的 `permission.allowedTools`、SQLite 中「在此项目中始终允许」的规则、用户级 PreToolUse hooks 自动放行，没有关闭开关（只能以 `ZCODE_DATA_BASE_DIR` 整体迁走数据根，这又会连带丢掉 1 中本就不可用的登录态）；project 的 `zcode.json` / `.zcode/config.json` 也可携带 allowedTools 与自动连接的 stdio MCP server。
  3. 协议无版本握手、`session/send` / `session/stop` 已标废弃，`zcode-protocol-legacy-types.ts` 注明旧协议将被删除（v4 未冻结）。
- 影响范围：目录不收录 `zcode`，不新增 `providers/zcode/`。保留通用部分：`AgentProvider.connect(proc, client)` + `acp/client.ts` `createShimChannel` + AgentHost 的 `transport:'shim'` 接线（单测覆盖，供日后确有协议垫片的 Agent 使用）。
- 可选方案：
  1. 放弃（当前）——不碰凭据、不承诺不可用的登录方式。
  2. 由 KepCup 充当 ZCode 桌面宿主：读取 / 刷新 ZCode 账号凭据并在 `requestProviderRuntimeHeaders` 中返回——违反 §9.1 与条款审慎原则，不采纳。
  3. 只支持 ZCode 内自配的 API key Provider——体验与目录描述不符、仍有 2 的权限残留，不采纳。
  4. 等 ZCode 提供 ACP 或在 app-server 中支持 CLI 凭据（standalone 账号源）后重新评估。
- 推荐：1，并跟踪 4。
- 决定：按用户既定原则（「ZCode 评估不能完整覆盖即放弃」）放弃。
- 已更新的文档：design/28 §9.2（ZCode 行）、design/28 第 16 行（本期 Agent 列表）、design/README.md（28 行与 D72 行）、design/09-tech-stack.md（外部智能体引擎行）、todo/acp-external-agents.md §8.1 / §8.4 / 附录 A.1（补充核对结论）。

### DEV-009 「仅这一次」= 单次工具调用：request_access 预授权与外部智能体审批的落法（D75 W1-C）

- 状态：待决定（已按推荐方案实现，可调整）
- 阶段：D75 W1-C
- 是否阻塞：否
- 问题：design/30 §7.3、design/13「授权」把「仅这一次」收紧为**单次工具调用**即失效。字面执行有两处与现有流程冲突：
  1. `request_access`（design/13「Bot 也可以在批量操作前主动调用 request_access」「命令因沙箱限制失败时……调用 request_access 申请授权，批准后重新执行」）本身就是一次工具调用；若授权在这次调用结束即失效，选「仅这一次」的预申请永远用不上，「批准后重新执行命令」的流程断掉。
  2. 外部智能体的权限请求（ACP `session/request_permission`，permission-bridge）不经工具网关执行，批准即回答了那一条请求；旧实现仍把它落成 run 级 once 授权，同一路径的后续请求会被它放行。
- 影响范围：`permissions/grants.ts`（`noteOnceUse`、TTL 惰性过期）、`permissions/tool-call-scope.ts`（新增）、`agent/tool-execution.ts`（每次工具调用开一个作用域）、`gateway/index.ts`（使用即消费、`ensurePathAccess({ preauthorize })`）、`tools/index.ts`（request_access 传 `preauthorize: true`）、`agent/external/permission-bridge.ts`（once 不落授权）。
- 可选方案：
  1. 「单次工具调用」= **使用该授权的那一次工具调用**：文件工具越界当场批准的授权在本次调用内有效、调用结束即撤销；`request_access` 的预授权不绑定申请那次调用，而由**随后第一次真正用到它的工具调用**消费（文件工具命中、或进入某条命令的沙箱策略）；外部智能体审批的 once 不落授权（批准即那一次）；所有 once 另受 `GRANT_ABSOLUTE_TTL_MS` 与 run 结束兜底 — 优点：预申请与「批准后重跑命令」流程照旧可用，长任务里不会退化成整任务放行；缺点：预授权在被用到之前最长可悬置 10 分钟。
  2. 字面执行（申请那次调用结束即失效）— 优点：最简单；缺点：request_access 的「仅这一次」选项形同虚设，沙箱拦截后的重试只能选「本对话内一直允许」，与收紧的初衷相反。
- 推荐：1。
- 决定：（待人工确认）
- 已更新的文档：无（design/13 的「仅这一次」条目建议补一句预授权的消费规则，留给 W5 文档同步）
- 补充（D75 审查修复 M5 / LOW-6，`t/d75-fixb`）：「使用该授权的那一次工具调用」落实为**归属**——每条 once 授权在内存里记录它的所属工具调用（`grantId → ToolCallScope`，撤销即清除）：当场批准的归批准它的那次调用；`request_access` 预授权在被用到前不属于任何调用，**第一次用到它的调用认领**。`listEffective` / `hasEffectiveGrant` / 沙箱策略只把 once 授权算给它的所属调用（未认领的对任何调用可见、用即认领），同一 run 内并行的工具调用不再共享 once 授权，长调用也不会让它对别的调用持续有效。`bash` 仍把它看得见的 once 授权（自己的 + 可认领的）全部并入策略并消费：命令实际碰了哪些挂载不可观测，按命令文本猜路径会漏掉脚本 / `cd` / 变量，挂进策略即视为使用是安全的一侧；代价是 `request_access` 之后、重跑之前若先跑了一条无关命令，预授权会被它用掉（需重新申请）。once 授权的自动撤销（调用结束消费、`GRANT_ABSOLUTE_TTL_MS`、run 结束）现在经 `GrantsService.onAutoRevoke` 发布 `grant.changed`（按对话在微任务内合并），右侧面板不再停留在过期状态。影响范围追加：`permissions/grants.ts`（归属、`onAutoRevoke`、TTL 定时推送）、`gateway/index.ts`（订阅并发布）。

### DEV-010 任务会话的桥 / 引擎键按会话行而非任务 id（D75 W4）

- 状态：已按推荐方案实现（不阻塞，可调整）
- 阶段：D75 W4
- 是否阻塞：否
- 问题：design/30 §8.5 写「`sessionKey = bot:conv:agent:task`」，同时要求 `continues_task_id` 把旧任务的会话行**继承**给新任务（`UPDATE … SET task_id = 新`）。引擎复用保留会话时要求 `kept.sessionKey === RunSpec.external.sessionKey`，桥 token 也按 `sessionKey` 签发：若键含任务 id，继承后新任务的键与保留会话开会话时的键不同，引擎会把它当作不匹配而关闭（继承落空），或需要给引擎 / 桥加一套「换键」逻辑。
- 影响范围：`dispatch/orchestrator.ts`（`#agentSessionKey`）、`domain/agent-sessions.ts`（`inheritTask`）。
- 可选方案：
  1. 任务行的键 = `bot:conv:agent:task:{会话行 id}`：每个任务新建的会话各有一行 → 各有自己的键与桥 token（与「按任务」等价）；继承只改行的 `task_id`、行 id 不变，键与 token 随行沿用；指纹变化换新行 = 换新键。引擎、桥零改动 — 优点：改动面最小、继承天然成立；缺点：键里不直接出现任务 id（日志里按行 id 对应）。
  2. 键 = 任务 id，引擎在复用时接受「上一个键」并重签 token、重绑 run — 缺点：引擎与桥都要改，复用路径多一处失败模式。
- 推荐：1。非任务 run（D72 期的响应 run，`task_id = ''`）的键保持 `bot:conv:agent` 不变。
- 决定：（待人工确认）
- 已更新的文档：无（design/30 §8.5「键加任务」一句建议改为「键随任务的会话行」，留给 W5）

### DEV-011 无内置模型的对话轮降级只实现第 2 级（D75 W2）

- 状态：已按推荐方案实现（不阻塞，可调整）
- 阶段：D75 W2
- 是否阻塞：否
- 问题：design/30 §8.4 给「没有内置模型、只有外部智能体」的 Bot 两级降级：① 用 `backgroundAgentId` 的 `complete()`（一次性精简会话）跑对话轮；② 关闭路由判断，「永远一个任务，新指令排队到任务结束」。第 1 级要把对话轮的工具调用（`start_task` / `inject_task` / `forward_task_result`…）塞进只输出 JSON 的 `complete()` 会话，等于为对话轮另造一套结构化决策协议，W2 范围内做不完；第 2 级的「排队到任务结束」与「等价于今天的行为」（今天是注入正在跑的 loop）两句自相矛盾。
- 影响范围：`dispatch/orchestrator.ts`（`#executeRun` 对话轮模型门禁、`#routeWithoutModel`）。
- 可选方案：
  1. 只做第 2 级，且新消息**注入**进行中的任务（`inject_task`，与今天的「执行中注入」一致；Agent 不支持 steering 时注入降为 `queued`，此时另起一个任务，写任务按租约排在后面），没有进行中的任务就派一个（写权限随 Agent 档位）；任务结果原文转发（`forward_task_result` 同一路径），失败 / 中断发一条简短说明；对话轮本身不调模型，`engine='builtin'`、`completed` 结算 — 优点：无内置模型的用户照常可用，行为可预测；缺点：没有「直接回答」「取消」这类判断，路由留痕只靠任务卡（W3）。
  2. 字面执行「排队」：新消息停在 mailbox 直到任务结束再派新任务 — 缺点：用户在任务期间说的话完全无效，体验比今天差。
  3. 实现第 1 级 — 缺点：需要新的结构化对话轮协议与提示词，工作量 + 风险大，且受 Agent 冷启动影响每轮数十秒。
- 推荐：1；第 1 级作为后续独立项。
- 决定：（待人工确认）
- 已更新的文档：无（design/30 §8.4 第 2 级建议改为「注入进行中的任务，无任务则派出」，留给 W5）

### DEV-012 跨 Bot 委派（D71）的结果仍取被委派方「那一个对话轮」的回复（D75 W2）

- 状态：待决定（暂按现状，已在提示词里说明）
- 阶段：D75 W2
- 是否阻塞：否
- 问题：D71 把 B 的「被委派 run」终态时的最终回复贴回 A 作结果卡。D75 后 B 被委派触发的是**对话轮**（只读、秒级）：需要动手的委派，B 只能派任务并回复「我去做」，这句话就会作为结果贴回 A，真正的结果之后出现在 B 的私聊里、不回到 A。design/30 §1.2 说「D71 不变」，没有覆盖这一点。
- 影响范围：`dispatch/delegation.ts`（`onRunSettled` 按 run 匹配）、对话轮提示词（委派触发一条）。
- 可选方案：
  1. 现状 + 提示词约束：委派触发的对话轮能用只读查询答复的在本轮给完整结果；需要动手的照常派任务并说明「结果稍后在这里给出」— 优点：零改动；缺点：A 侧拿到的是过程性答复。
  2. 委派跟随任务：被委派对话轮派出的任务（`origin_run_id`）未结算前委派保持 `working`，由消费这些任务结果的下一个对话轮的最终回复作为委派结果 — 优点：语义正确；缺点：委派与任务的结算串联，需要改 DelegationHost 的匹配与崩溃恢复。
- 推荐：2，作为 D75 收口后的独立修订；本期按 1。
- 决定：（待人工确认）
- 已更新的文档：无

### DEV-013 `create_skill` 留在对话轮工具面（D75 W2 审查 L5）

- 状态：已决定（调度会话决定，已按此实现）
- 阶段：D75 W2 审查修复
- 是否阻塞：否
- 问题：design/30 §2.1 的对话轮工具面表没有列 `create_skill`，「不可写」一栏写了「技能安装——一律经任务」。审查 L5 指出 W2 把 `create_skill` 留在了对话轮工具面，问是否该移到任务。
- 影响范围：`tools/index.ts`（对话轮工具面）、`skills/`（skill_authoring 后台 loop）。
- 可选方案：
  1. 保留在对话轮：`create_skill` 只登记一个 `skill_authoring` 后台作业（与对话轮里登记定时任务、Wiki 入库请求同类，属于 §2.1「异步托管动作」），生成、验证、启用都在后台 loop 里完成并自带验证，对话轮本身不写任何文件 — 优点：「以后都这样做」这类话不必为登记一项后台作业派一个任务；缺点：工具面表需补一行。
  2. 移到任务 — 缺点：任务里调用它也只是登记同一个后台作业，多一次任务往返没有收益。
- 推荐：1。
- 决定：1（调度会话，审查 L5）。`install_skill`（预置 / 外部仓库导入，会落盘）仍只在任务里。
- 已更新的文档：无（design/30 §2.1「异步托管动作」一行建议补「技能生成请求（create_skill，登记 skill_authoring 后台作业）」，留给 W5）

### DEV-014 对话轮审查修复中对设计 30 的细化（D75 W2 审查 M2 / M4 / M6）

- 状态：已按推荐方案实现（不阻塞，可调整）
- 阶段：D75 W2 审查修复（`t/d75-fixd`）
- 是否阻塞：否
- 问题：审查发现三处设计 30 没写细、实现按最宽的读法做了、结果出错的地方：
  1. **消费**（§3.2「触发批里含该条目的对话轮到达终态时标记消费」）：W2 在对话轮每条退出路径上都标消费，包括启动前被取消、Bot 停用 / 对话只读直接返回、用户取消、更新闸门 `cancelAllActive` —— 这些对话轮根本没处理触发，结果就此静默丢失。
  2. **对话轮里的阻塞审批**（§2.1「对话轮只读 → 基本不触发审批」、§7.3）：`propose_profile_change` 在对话轮里阻塞等用户决定；`read` / `ls` / `find` / `grep` 越界时发起访问审批并等待 —— 都会占住（Bot, 对话）的 mailbox，用户再说什么都只能排队。
  3. **群聊判断**（§8.2「后台任务仍占 `agent:{id}` 槽位并为对话保留一个」）：对话轮不再跑在 Agent 上之后，Agent 的槽位全归任务，调度器不再为 priority 0 预留；经 Agent 的群聊判断可能排在长任务后面几小时，`#triaging` 期间整个群的分派被挡住。
- 影响范围：`dispatch/orchestrator.ts`（`#releaseTurnMailbox`）、`tools/memory-tools.ts`、`memory/service.ts`、`permissions/approvals.ts`、`gateway/index.ts`、`tools/coding-tools.ts`、`dispatch/dispatcher.ts`。
- 可选方案与实现：
  1. 消费 = 对话轮**处理了**触发（引擎已启动；或 §8.4 降级已确定性路由；或因缺设置失败、设置卡完成后会以同一触发重试）**且**终态为 `completed` / `failed`（含 `skip_reply`）。其余（启动前取消、停用 / 只读、用户或更新闸门取消、中断、引擎启动前崩溃）不消费，由对账按 at-least-once 补投（`TASK_REDELIVER_AFTER_MS` / 重启）。代价：用户取消正在转述结果的对话轮后，结果会在补投窗口后再出现一次。
  2. 对话轮永不等用户：`propose_profile_change` 在对话轮里改为非阻塞提交（审批卡不随对话轮结束而取消——一般化为「非阻塞提交的审批不随 run 取消」），用户决定后以内部事件 `profile_change_result` 唤醒下一轮；任务里仍阻塞。对话轮的越界读取当场失败（`PATH_OUT_OF_SCOPE`，提示派任务、在任务里 `request_access`），不发起审批；已有授权覆盖的路径照常可读。
  3. 群聊判断的超时从**提交**开始计（不是开始执行时），到时按「仅 @ / 回复响应」放行（`no_action`），仍在排队的作业撤出队列。备选「Agent 是后台路由时为判断保留一个槽位」需要调度器知道哪些 Agent 当前承担后台路由，且仍不能约束内置 provider 上的同类排队，弃用。
- 推荐：均按上述实现。
- 决定：（待人工确认）
- 已更新的文档：无（design/30 §3.2「消费」、§2.1 / §7.3、§8.2 的对应句子建议在 W5 按上述补写）

### DEV-015 同一 project 的写任务在任务层排队，「强制收回」对它不起作用（D75 W3）

- 状态：待决定（暂按现状，界面如实显示排队原因）
- 阶段：D75 W3
- 是否阻塞：否
- 问题：D29 / BR-P04-001 的「强制收回」用于「等待 X 完成对项目的修改」：等待者在 `ensureWriteLease` 上排队（`waiting_lease` + `lease.waiting`），收回后它立刻取得租约。D75 的 TaskHost 在**派任务时**就按 workdir 拦住第二个写任务（`#blockedBy`：同一 workdir 已有在跑的写任务 → 停在 submitted，原因「等写入租约（任务 … 持有）」），它根本不去申请租约；对这种排队点「强制收回」只会让持有方任务失去写权限，排队的任务仍要等持有方任务结束才启动。另一路——写任务启动前 `ensureWriteLease(pin)` 被非任务持有者（宿主伪身份等）挡住——仍是 `lease.waiting`，状态行照旧给出「强制收回」。
- 影响范围：`dispatch/tasks.ts`（`#blockedBy`）、desktop 状态行 / 任务卡；e2e `projects.spec.ts` 原「lease waiting … can be force revoked」用例改为「排在另一对话的写任务之后、取消持有任务后执行」。
- 可选方案：
  1. 现状：任务层排队显示原因，放行方式是在持有任务的卡片上取消（或等它结束）；「强制收回」只对租约层的等待出现 — 优点：零改动、语义清楚（同一 workdir 一个写任务）；缺点：跨对话时用户要切到持有方对话去取消。
  2. 强制收回 = 取消持有租约的写任务（任务卡同一路径，记为用户取消）— 优点：保留「一键让我先来」；缺点：比收回租约更重（持有方任务被结束而不只是失去写权限），需要在 core 增加按租约找任务并取消的入口。
- 推荐：1；如需跨对话一键放行再按 2 补。
- 决定：（待人工确认）
- 已更新的文档：无（design/12「焦点二」等待租约附「强制收回」一句、design/30 §5.1 留给 W5）
