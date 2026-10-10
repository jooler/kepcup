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

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
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
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/13「仅这一次」与「命令行」、design/30 §7.3、docs/dev/02-architecture「工具网关」D75 补充、04-agent-runtime（D75 常量表）。
- 补充（D75 审查修复 M5 / LOW-6，`t/d75-fixb`）：「使用该授权的那一次工具调用」落实为**归属**——每条 once 授权在内存里记录它的所属工具调用（`grantId → ToolCallScope`，撤销即清除）：当场批准的归批准它的那次调用；`request_access` 预授权在被用到前不属于任何调用，**第一次用到它的调用认领**。`listEffective` / `hasEffectiveGrant` / 沙箱策略只把 once 授权算给它的所属调用（未认领的对任何调用可见、用即认领），同一 run 内并行的工具调用不再共享 once 授权，长调用也不会让它对别的调用持续有效。`bash` 仍把它看得见的 once 授权（自己的 + 可认领的）全部并入策略并消费：命令实际碰了哪些挂载不可观测，按命令文本猜路径会漏掉脚本 / `cd` / 变量，挂进策略即视为使用是安全的一侧；代价是 `request_access` 之后、重跑之前若先跑了一条无关命令，预授权会被它用掉（需重新申请）。once 授权的自动撤销（调用结束消费、`GRANT_ABSOLUTE_TTL_MS`、run 结束）现在经 `GrantsService.onAutoRevoke` 发布 `grant.changed`（按对话在微任务内合并），右侧面板不再停留在过期状态。影响范围追加：`permissions/grants.ts`（归属、`onAutoRevoke`、TTL 定时推送）、`gateway/index.ts`（订阅并发布）。

### DEV-010 任务会话的桥 / 引擎键按会话行而非任务 id（D75 W4）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 W4
- 是否阻塞：否
- 问题：design/30 §8.5 写「`sessionKey = bot:conv:agent:task`」，同时要求 `continues_task_id` 把旧任务的会话行**继承**给新任务（`UPDATE … SET task_id = 新`）。引擎复用保留会话时要求 `kept.sessionKey === RunSpec.external.sessionKey`，桥 token 也按 `sessionKey` 签发：若键含任务 id，继承后新任务的键与保留会话开会话时的键不同，引擎会把它当作不匹配而关闭（继承落空），或需要给引擎 / 桥加一套「换键」逻辑。
- 影响范围：`dispatch/orchestrator.ts`（`#agentSessionKey`）、`domain/agent-sessions.ts`（`inheritTask`）。
- 可选方案：
  1. 任务行的键 = `bot:conv:agent:task:{会话行 id}`：每个任务新建的会话各有一行 → 各有自己的键与桥 token（与「按任务」等价）；继承只改行的 `task_id`、行 id 不变，键与 token 随行沿用；指纹变化换新行 = 换新键。引擎、桥零改动 — 优点：改动面最小、继承天然成立；缺点：键里不直接出现任务 id（日志里按行 id 对应）。
  2. 键 = 任务 id，引擎在复用时接受「上一个键」并重签 token、重绑 run — 缺点：引擎与桥都要改，复用路径多一处失败模式。
- 推荐：1。非任务 run（D72 期的响应 run，`task_id = ''`）的键保持 `bot:conv:agent` 不变。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/30 §8.5「键加任务」、design/28 §1 D75 修订注、docs/dev/02-architecture（`RunSpec.external.sessionKey`）、03-data-model（agent_sessions）、04-agent-runtime（D75 W4 要点）。

### DEV-011 无内置模型的对话轮降级只实现第 2 级（D75 W2）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 W2
- 是否阻塞：否
- 问题：design/30 §8.4 给「没有内置模型、只有外部智能体」的 Bot 两级降级：① 用 `backgroundAgentId` 的 `complete()`（一次性精简会话）跑对话轮；② 关闭路由判断，「永远一个任务，新指令排队到任务结束」。第 1 级要把对话轮的工具调用（`start_task` / `inject_task` / `forward_task_result`…）塞进只输出 JSON 的 `complete()` 会话，等于为对话轮另造一套结构化决策协议，W2 范围内做不完；第 2 级的「排队到任务结束」与「等价于今天的行为」（今天是注入正在跑的 loop）两句自相矛盾。
- 影响范围：`dispatch/orchestrator.ts`（`#executeRun` 对话轮模型门禁、`#routeWithoutModel`）。
- 可选方案：
  1. 只做第 2 级，且新消息**注入**进行中的任务（`inject_task`，与今天的「执行中注入」一致；Agent 不支持 steering 时注入降为 `queued`，此时另起一个任务，写任务按租约排在后面），没有进行中的任务就派一个（写权限随 Agent 档位）；任务结果原文转发（`forward_task_result` 同一路径），失败 / 中断发一条简短说明；对话轮本身不调模型，`engine='builtin'`、`completed` 结算 — 优点：无内置模型的用户照常可用，行为可预测；缺点：没有「直接回答」「取消」这类判断，路由留痕只靠任务卡（W3）。
  2. 字面执行「排队」：新消息停在 mailbox 直到任务结束再派新任务 — 缺点：用户在任务期间说的话完全无效，体验比今天差。
  3. 实现第 1 级 — 缺点：需要新的结构化对话轮协议与提示词，工作量 + 风险大，且受 Agent 冷启动影响每轮数十秒。
- 推荐：1；第 1 级作为后续独立项。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/30 §8.4、design/02「无内置模型的 Bot」、design/28 §1 D75 修订注、docs/dev/04-agent-runtime（模型解析顺序）。

### DEV-012 跨 Bot 委派（D71）的结果仍取被委派方「那一个对话轮」的回复（D75 W2）

- 状态：已落实（2026-10-09，方案二按用户决定修订后实现，borrowings W6，commit `8cb925b`）
- 阶段：D75 W2
- 是否阻塞：否
- 问题：D71 把 B 的「被委派 run」终态时的最终回复贴回 A 作结果卡。D75 后 B 被委派触发的是**对话轮**（只读、秒级）：需要动手的委派，B 只能派任务并回复「我去做」，这句话就会作为结果贴回 A，真正的结果之后出现在 B 的私聊里、不回到 A。design/30 §1.2 说「D71 不变」，没有覆盖这一点。
- 影响范围：`dispatch/delegation.ts`（`onRunSettled` 按 run 匹配）、对话轮提示词（委派触发一条）。
- 可选方案：
  1. 现状 + 提示词约束：委派触发的对话轮能用只读查询答复的在本轮给完整结果；需要动手的照常派任务并说明「结果稍后在这里给出」— 优点：零改动；缺点：A 侧拿到的是过程性答复。
  2. 委派跟随任务：被委派对话轮派出的任务（`origin_run_id`）未结算前委派保持 `working`，由消费这些任务结果的下一个对话轮的最终回复作为委派结果 — 优点：语义正确；缺点：委派与任务的结算串联，需要改 DelegationHost 的匹配与崩溃恢复。
- 推荐：2，作为 D75 收口后的独立修订；本期按 1。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/30 §1.2、design/27 D75 说明、design/02「跨 Bot 委派」、docs/dev/04-agent-runtime（对话轮版平台规则第 11 条）。
- 修订决定（用户 2026-10-09）：方案二的结果规则改为「**各任务结果摘要拼接**」，不再是原文的「消费任务结果的下一个对话轮的最终回复」；同时 `delegate_to_bot` 增 `intent`（`request` / `question` / `fyi`），只有 `request` 跟随任务。
- 实现（borrowings W6，`todo/borrowings-from-personal-agents.md`）：main `0021_delegation_intent.sql` 重建 `delegations`（status 增 `awaiting_tasks`，增 `intent`、`task_ids_json`）；`request` 的委派轮派出了任务（`origin_run_id`）时委派转 `awaiting_tasks`，沿续接链跟到最新一环，全部终态后按派出顺序拼接结果（总长 ≤ `DELEGATION_RESULT_MAX_CHARS`，未完成的标注状态；失败 / 中断的任务等 B 消费过结果再定局）；任务终态挂在 TaskHost 既有的 `onSettled` 回调与新增的 `onConsumed` 上（`tasks.ts` 只动 deps 接口与 `markConsumed`）；取消委派一并停任务，A 侧删除除外（用户决定）；等待没有单独超时，靠任务墙钟兜底。
- 代价（随修订决定一并记录）：B 的任务原始结果不经 B 的对话轮整理就直接到 A（以 `<untrusted>` 交给 A、结果卡给用户看）；此前 B 有机会先筛一遍。
- 已更新的文档（2026-10-09 回写）：design/27（文件头、D71 决策、§2.3 说明、§3.1 / §3.2、新增 §3.6）、design/30 §1.2、design/02「跨 Bot 委派」、design/README（D71 行）、docs/dev/04-agent-runtime（对话轮版平台规则、工具目录、触发段）、docs/dev/03-data-model（delegations，W6 实施时已同步）。

### DEV-013 `create_skill` 留在对话轮工具面（D75 W2 审查 L5）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 W2 审查修复
- 是否阻塞：否
- 问题：design/30 §2.1 的对话轮工具面表没有列 `create_skill`，「不可写」一栏写了「技能安装——一律经任务」。审查 L5 指出 W2 把 `create_skill` 留在了对话轮工具面，问是否该移到任务。
- 影响范围：`tools/index.ts`（对话轮工具面）、`skills/`（skill_authoring 后台 loop）。
- 可选方案：
  1. 保留在对话轮：`create_skill` 只登记一个 `skill_authoring` 后台作业（与对话轮里登记定时任务、Wiki 入库请求同类，属于 §2.1「异步托管动作」），生成、验证、启用都在后台 loop 里完成并自带验证，对话轮本身不写任何文件 — 优点：「以后都这样做」这类话不必为登记一项后台作业派一个任务；缺点：工具面表需补一行。
  2. 移到任务 — 缺点：任务里调用它也只是登记同一个后台作业，多一次任务往返没有收益。
- 推荐：1。
- 决定：1（调度会话，审查 L5）。用户确认（2026-10-08）。`install_skill`（预置 / 外部仓库导入，会落盘）仍只在任务里。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/30 §2.1（「可写」行与「异步托管动作」行）、docs/dev/04-agent-runtime（工具目录 `create_skill` 行）。

### DEV-014 对话轮审查修复中对设计 30 的细化（D75 W2 审查 M2 / M4 / M6）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
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
- 补充（重试去重的限制，审查批 E L7）：重试的对话轮（审查 L6）认「被重试那一轮已派出的任务」只按**标题精确匹配**（去掉首尾空白）：重试时模型换了措辞的同一件事不会被认出、会再派一个任务；标题相同的另一件事会被当成已派出（返回 `alreadyStarted`）。
- 推荐：均按上述实现。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/30 §2.1（对话轮永不等用户）、§3.2（消费）、§5.3 / §7.3 / §8.5（群聊判断超时）、design/02「任务的结算」「调度器与名额」、design/12、design/13、docs/dev/02-architecture、04-agent-runtime。

### DEV-015 同一 project 的写任务在任务层排队，「强制收回」对它不起作用（D75 W3）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 W3
- 是否阻塞：否
- 问题：D29 / BR-P04-001 的「强制收回」用于「等待 X 完成对项目的修改」：等待者在 `ensureWriteLease` 上排队（`waiting_lease` + `lease.waiting`），收回后它立刻取得租约。D75 的 TaskHost 在**派任务时**就按 workdir 拦住第二个写任务（`#blockedBy`：同一 workdir 已有在跑的写任务 → 停在 submitted，原因「等写入租约（任务 … 持有）」），它根本不去申请租约；对这种排队点「强制收回」只会让持有方任务失去写权限，排队的任务仍要等持有方任务结束才启动。另一路——写任务启动前 `ensureWriteLease(pin)` 被非任务持有者（宿主伪身份等）挡住——仍是 `lease.waiting`，状态行照旧给出「强制收回」。
- 影响范围：`dispatch/tasks.ts`（`#blockedBy`）、desktop 状态行 / 任务卡；e2e `projects.spec.ts` 原「lease waiting … can be force revoked」用例改为「排在另一对话的写任务之后、取消持有任务后执行」。
- 可选方案：
  1. 现状：任务层排队显示原因，放行方式是在持有任务的卡片上取消（或等它结束）；「强制收回」只对租约层的等待出现 — 优点：零改动、语义清楚（同一 workdir 一个写任务）；缺点：跨对话时用户要切到持有方对话去取消。
  2. 强制收回 = 取消持有租约的写任务（任务卡同一路径，记为用户取消）— 优点：保留「一键让我先来」；缺点：比收回租约更重（持有方任务被结束而不只是失去写权限），需要在 core 增加按租约找任务并取消的入口。
- 推荐：1；如需跨对话一键放行再按 2 补。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档（W5，2026-10-08，原标「待确认」，用户确认后已去掉）：design/30 §5.1、design/08「并发：写入租约」D75 修订注、design/12（状态行与「焦点二」修订注）、design/02「写互斥」、docs/dev/05-testing（e2e 迁移说明）。

### DEV-016 外部智能体任务没有 `ask_user`（D75 审查批 E L6）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 审查修复批 E（`t/d75-fixe`）
- 是否阻塞：否
- 问题：design/30 §2.4.6「任务向用户提问」没有区分引擎。`ask_user` 只在内置引擎的任务工具面注册（`tools/index.ts`，`loopType === 'task'`）；外部智能体任务的宿主工具经能力包过滤（`agent/external/capabilities.ts`，不属于任何能力包的工具一律不注入），`ask_user` 不在任何能力包里，因此外部智能体任务——包括 §8.4 降级（DEV-011）下只有外部智能体的 Bot 的全部任务——无法挂出问题卡；它们只能用 Agent 自带的提问方式（ACP 权限请求）或在结果里写明「需要用户决定」，由对话轮转述。
- 影响范围：`agent/external/capabilities.ts`、shared 能力包定义（`capabilityOfTool`）、`dispatch/tasks.ts`（`ask` 阻塞在桥的工具调用里，桥调用的超时与取消语义需核对）。
- 可选方案：
  1. 现状：外部智能体任务不提问，需要用户拍板的事作为结果交回对话轮 — 优点：零改动，不让一个外部会话挂起数小时占着 `agent:{id}` 的并发；缺点：§2.4.6 的「点选直注」对这类任务不可用。
  2. 把 `ask_user` 放进 `core` 能力包注入 — 缺点：桥上的一次工具调用可能挂起到 `TASK_QUESTION_TTL_MS`（24 小时），各家 Agent 的 MCP 调用超时（多为分钟级）会先把它打断；需要逐家实测。
- 推荐：1；2 待各家 MCP 工具调用超时实测后再议。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档：design/30 §2.4.6、docs/dev/04-agent-runtime（D72 要点与工具目录）在 W5 已写明「外部智能体任务没有 `ask_user`」；工具目录 `ask_user` 行补了本条编号（审查批 E）。

### DEV-017 W5 文档收口发现的设计与实现不一致（D75）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 W5 收口（由审查批 E 登记）
- 是否阻塞：否
- 问题与建议：
  1. **对话轮的 `web_search` / `web_fetch`**：design/30 §2.1 / §12.1 要求「按 Bot 配置开关」且每轮不超过 1 次；实现是配置了搜索就对所有对话轮注册，次数只受 `TURN_MAX_TURNS` 约束。建议：保持现状（`TURN_MAX_TURNS` 已经封顶），有了用量数据再决定是否加开关 / 次数上限。
  2. **`start_task` 的 `engine?` 参数**（§4.1）：未实现，任务一律用 Bot 配置的任务引擎（内置或其外部智能体）。建议：推迟，按 Bot 的任务引擎执行。
  3. **`inject_task` 也接受 `submitted` 任务**（§4.1 写的是只接受 `running`）：未启动任务的追加被记录下来、启动时并入简报（`TaskBrief.injects`）。建议：保留——严格更有用，不会丢指令。
  4. **反思的去抖**（§7.2「纯对话轮按去抖登记反思」）：未实现，每个 `completed` 的对话轮与每个 `completed` 的任务都登记一次反思作业。建议：以后补去抖；目前的代价是对话轮频繁时反思作业偏多（受每日后台预算约束）。
- 影响范围：`tools/index.ts`（对话轮工具面）、`tools/task-tools.ts`、`dispatch/tasks.ts`（`inject`）、`dispatch/orchestrator.ts`（`registerReflection`）。
- 推荐：按上述各项建议。
- 决定：用户确认（2026-10-08），按推荐方案。
- 已更新的文档：无

### DEV-018 审查批 E 对设计 30 的细化（D75，`t/d75-fixe`）

- 状态：已决定（用户 2026-10-08 确认，按推荐方案）
- 阶段：D75 审查修复批 E
- 是否阻塞：否
- 问题：审查发现以下几处设计 30 没写到、实现按最宽的读法出了错：
  1. **结果投递无上限**（§3.2「宁可重复一次，不可静默丢失」）：对话轮在引擎启动前抛错时不算「处理了触发」、不消费（DEV-014 第 1 项），对账每 `TASK_REDELIVER_AFTER_MS` 补投一次，永远循环、每次一条失败横幅。
  2. **对话轮吸收缓冲批**（W2 审查 M1）丢掉了被吸收的 @ 连锁批的连锁绑定（该轮再 @ 别人会开一条新连锁、层数从 1 重新算，`BOT_CHAIN_MAX_DEPTH` / `BOT_CHAIN_TOKEN_BUDGET` 被绕过）；也会把用户消息 / 任务结果吸收进 D71 被委派的对话轮（其最终回复被当作委派结果贴回 A）。
  3. **提问等待**（§2.4.6）：`ask_user` 阻塞期间任务占着调度名额与写租约，reaper 把等待时间算进 `TASK_MAX_WALL_MS`，用户迟迟不答的任务被判「运行超过时限」、回答丢失。
- 影响范围：`dispatch/tasks.ts`、`dispatch/orchestrator.ts`（`#absorbIntoTurn`）、`scheduler/mailbox.ts`、`domain/runs.ts`（`setTrigger`）、shared 常量。
- 实现：
  1. 终态条目记投递次数（`content_json.$.deliveries`，不加迁移）；达到 `TASK_REDELIVER_MAX_ATTEMPTS`（5）后标记消费，并在对话里发一条用户可见的系统提示（`task_result_undelivered`，Bot 上下文里渲染为固定文案，不含模型起的标题）。§3.2 的 at-least-once 由此变为「至多 5 次，之后明示放弃」。另：Bot 已持有的结果（已开始执行或已创建仍在调度器排队的对话轮的触发、mailbox 缓冲里的批）对账不再补投、不计数、不放弃（不再出现「转述一半时被补投、下一轮再转述一遍」；最终审查 L-3 补上「排队中 / 缓冲中」两种，并且投递时抛错的不计数）；吸收 / 合并时丢弃任务已被消费的结果条目（重试的对话轮自己的触发除外）。
  2. 同一个对话轮只处理「能同轮」的批（`canShareTurn`）：委派批独占一轮（既不被吸收、也不吸收别的批）；不同连锁的批不同轮；带用户消息（含编辑通知）的未绑定批不与连锁批同轮（最终审查 L-5：否则用户的话继承连锁的层数 / 预算）；同一连锁取最深的层数；吸收了连锁批的对话轮把 `chain_id` / `chain_depth` 落到 run 行。不能同轮的批留在缓冲里，下一轮处理。
  3. `ask_user` 等待期间经 `Scheduler.yieldSlotWhile` 让出 provider 名额（与等租约同一机制），等待时间（到重新拿到名额为止）不计入 `TASK_MAX_WALL_MS`；等待期间被取消的任务不再排队拿回名额，直接收尾、当场放掉写租约（最终审查 M-1）；超过 `TASK_QUESTION_TTL_MS`（24 小时）没有回答，任务收到「用户未回答，按你自己的判断继续」，问题卡显示「（超时未回答）」，并记一条追加条目。**写租约保留**：它是任务从开始就钉住的租约，任务的文件改到一半，中途换别的写者会在半成品上工作；用户可以在任务卡上取消。
  4. 经 `inject_task` 转交的自由文本回答带上用户原消息（附件行等，同普通追加）；问题卡上只显示转交的文本。
- 推荐：均按上述实现。
- 决定：用户确认（2026-10-08），按推荐方案。
- 补充（调度会话追加的项，同批实现）：
  5. **强制收回 = 持有方写任务失去写权限**（design 30 §5.1）：此前收回只关掉持有方的租约窗口，持有方任务下一次写入会悄悄以新窗口重新取得租约（不再钉住），而 `run_changes` 按 `run_id` 覆盖写入，第一个窗口的改动记录丢失、整次回退撤不掉它。现在被收回的钉住 run 记为「租约已被收回」，`writeDenial` 以「写入租约已被用户收回」拒绝它（及其子代理）的一切写入；`run_changes` 跨窗口累积（每个文件记首个窗口前 / 末个窗口后的快照，别人夹在两个窗口之间改过的文件回退时按冲突处理），只对不钉住的执行（宿主伪身份等）仍会出现多窗口。
- 已更新的文档（审查批 E，原标「待确认」，用户确认后已去掉）：design/30 §2.2（上限行）、§2.4.6、§3.2（不变量、投、对账、故障表）、§4.3（任务卡渲染）、§5.1（强制收回）；design/02（时限、提问、吸收、对账、强制收回、任务卡渲染）；design/08「并发：写入租约」D75 修订注（钉住租约与 `acquire_project_write` / `PATH_OUT_OF_SCOPE`、强制收回）；docs/dev/02-architecture（Mailbox、TaskHost）、03-data-model（任务问题卡、结果放弃提示、`deliveries`、`setTrigger` 的连锁绑定、run_changes 多窗口）、04-agent-runtime（上下文渲染、工具目录、常量表、已删除的续接仲裁 / 中途注入代码）。
- 最终审查（`t/d75-fixf`）对上面 1–3 的细化：M-1（等待中被取消不拿回名额、墙钟到拿回名额才恢复）、L-3（排队中 / 缓冲中的结果算持有，抛错的投递不计数）、L-5（用户消息不与连锁批同轮）；已同步 design/30 §2.4.6 / §3.2、design/02、docs/dev/02 / 04 / 05。

### DEV-019 连接应用 P0 实现对设计 29 / 执行方案的偏差与补充（D73）

- 状态：待决定（实现者按下列推荐落地；用户确认后改「已决定」）
- 阶段：D73 P0（`todo/connected-apps.md` §4）
- 是否阻塞：否
- 问题：实现 P0 时，设计 29 §5 / §12 与 todo §4 有若干没写到或与实现细节冲突之处：
  1. **多一张 `oauth_clients` 表**（设计 29 §12 未列）：按 issuer 一行，记客户端来源（`dcr` / `manual` / `preregistered`）与已登记的 `redirect_uris`。没有它就无法判断「客户端是否来自 DCR（最后一个引用方断开后才清除）」，也无法在打开浏览器前做 DCR 端口预判。客户端 id / secret 仍逐值存 secrets。同在迁移 `0024_app_connections.sql`。
  2. **`TokenVault.saveTokens` 要求连接行已存在**（否则抛 `APP_CONNECTION_NOT_FOUND`）：交互流程先建行（状态 `connecting`）再换令牌，令牌写入与 `token_expires_at` / `scopes` 更新在同一处完成，避免有令牌而无行的孤儿状态。测试里直接种子令牌须先 `ensureCustom`。
  3. **回调服务把浏览器请求保持到换令牌结束**（todo §4.6 只写「回给浏览器一个结果页」）：为让「已连接，可回到 KepCup」只在真正连上之后显示，回调请求挂起，由流程在换令牌后 `respond({ok})` 决定成功页或失败页；未响应 30 秒自动中性收尾，`close()` 立即销毁连接。代价：浏览器标签页在换令牌期间转圈，通常不到一秒。
  4. **`listTools` 的 GET 事件流收到 401**（todo §4.7 的待验证问题）：用 pi-mcp 真实传输层验证（`mcp-auth-transport.test.ts` 锁定）——GET 流的 401 只走 `client.onError`，不触发 `onClose`、不使连接失败，POST 照常；所以**不**对 OAuth 连接关闭 GET 流。`onUnauthorized` / `token()` 抛出的 `AppAuthRequiredError` 原样穿出传输层（`McpService` 仍保留对 `cause` 链的防御）。
  5. **账号标识未做**：todo 的 `account_sub`（`id_token` sub 等）与 `id_token` 解析 P0 不做——连接行的 `account_sub` 恒为 NULL，`label` 取 server 名；`id_token` 不保存。多账号（同一 Connector 多行）随 P1 目录一起做。
  6. **`grantBotId` 仅接受、P0 不用**：`apps.connect` 接受 `grantBotId` 并传入流程，P0 不使用它（不据此给 Bot 授权）（Bot 授权是 P1 §5.7）；P0 的 Bot 仍经 `mcp_server_ids` 勾选使用自定义应用。
  7. **`settings.update` 改认证方式 / URL 时断开旧连接**（todo 未写）：令牌的受众绑定 server URL（RFC 8707），所以原为 OAuth 的 server 被改成 `none` / `headers`、或 URL 变了，在替换 `mcpServers` **之前**吊销并清除旧连接（`AppDisconnector.reconcileServers`），并取消该 server 进行中的授权流程。纯改名、改 `autoApprove`、URL 规范化后相同则保持连接。被 `settings.update` 差集删掉的 server 不在此处理（走显式 `mcp.removeServer`，幂等）。
  8. **`apps.setClientCredentials` 在同一流程上续跑**：保存凭据后流程自行发出 `discovering` 并继续（同一 `flowId`），渲染端不再重复 `apps.connect`（早先版本的 store 会重发一次，无害但多余，已去掉）。
  9. **`app_request_connection` 的注册条件**：Bot 勾选了应用级启用的 OAuth 自定义 server 即注册（不要求此刻有需要重连的应用），因为 run 中途授权失效时模型也需要它；工具名 `app_` 前缀留给 P1 的 `apps` 能力包，P0 的 ACP 外部智能体 Bot 拿不到。
  10. **迁移号已顺延**：本分支起初取 main `0022` / `0023`，与 D80 的 `0022_schedule_title_origin.sql`、W7 的 `0023_watches.sql` 撞号；合入 main 时 D73 顺延为 `0024_app_connections.sql` / `0025_app_tools.sql`。
  11. **复查后的补强（2026-10-09，不改设计语义）**：① SSRF 判定 `isPrivateAddress` 改为按 16 字节解析 IPv6（IPv4 映射 / NAT64 / 6to4 内嵌 IPv4 复判，Teredo、IPv4 兼容、站点本地、完整 `fe80::/10`、组播、文档段一律拒绝），IPv4 补 192.0.0.0/24、192.0.2.0/24、198.18.0.0/15、198.51.100.0/24、203.0.113.0/24；② `mcp.test` 的 OAuth server 只有「已保存且 URL / 认证方式一致」才会带已存令牌发请求，草稿一律「未连接」；`ConnectionAuthRegistry.providerFor(connectionId, serverUrl)` 再核对连接行记录的 URL；③ 每个连接记录授权时所用的客户端（secrets `conn:{id}:client_id|client_secret`，无迁移），刷新 / 吊销优先用它，其次 issuer 客户端，最后 CIMD——同一 issuer 上别的连接重新注册不再让既有连接失效；④ `apps.disconnect` 先取消并等待该连接进行中的交互流程（状态落 `not_connected`），registry 的世代号保证在途刷新在断开 / 重新授权后丢弃结果、不写回令牌；⑤ 流程总时限在每次尝试（含 `invalid_client` 重试、停放在 `OAUTH_CLIENT_REQUIRED`）开始时重新计时；`invalid_client` 重试后授权主机变了会重新进入 `awaiting_consent`；⑥ 启动时把上次未正常退出遗留的 `connecting` 行修正（有令牌 → `connected` / `expired`，否则 `not_connected`）；⑦ `McpService.listTools` 缓存连接上刷新后仍 401 同样产生 `AppAuthRequiredError` + `needs_auth`；⑧ `app_request_connection` 登记为 `local` 副作用类别。
- 影响范围：`apps/*`、`migrations/main/0024`、`0025`、`rpc/bindings.ts`（`settings.update`）、渲染端 `stores/apps.svelte.ts`；设计 29 §12 补 `oauth_clients`。
- 可选方案：按上述实现保留（推荐）；或逐项回到设计原文（1、2、3 会损失可观察行为，不推荐）。
- 推荐：均保留；设计 29 在用户确认后补 `oauth_clients`、「改认证方式 / URL 断开」两处。
- 决定：（由人工填写）
- 已更新的文档：`docs/dev/02-architecture.md`（连接应用）、`03-data-model.md`、`04-agent-runtime.md`、`05-testing.md`、`docs/design/23-mcp-and-subagent.md`（认证方式）、`docs/dev/PROGRESS.md`

### DEV-020 连接应用 P1 实现对设计 29 / 执行方案的偏差与补充（D73）

- 状态：待决定（实现者按下列推荐落地；用户确认后改「已决定」）
- 阶段：D73 P1（`todo/connected-apps.md` §5）；P0 的项见 DEV-019
- 是否阻塞：否
- 问题：实现 P1 时，设计 29 §4 / §6 / §7 / §9 与 todo §5 有若干没写到或与实现细节冲突之处：
  1. **群聊并发连接的 Bot 授权由 core 合并**（todo §5.8 只写「后到的卡片加入同一流程，完成后各自按自身勾选授权」，没说由谁授权）：同一目录目标在途时，后到的 `apps.connect` 把自己的 `grantBotId` 并入该流程的 Bot 集合（`Flow.catalog.grantBotIds`），流程确认时 `CatalogFlowHost.confirm({connectionId, grantBotIds})` 逐个 `BotsService.grantConnection`（每个 Bot 单独 try / catch，一个失败不影响其余）。`Flow.ending` 守卫：授权已开始（`confirmTools` 之后）或流程已终止后再带 `grantBotId` 来的调用**不并入、不追溯**，而是起新流程。渲染端 `ConnectAppSetupBody` 仍保留幂等兜底：`done` 后若本卡的 Bot 仍未持有该连接，经 `contacts.update` 自行补写 Profile。
  2. **重新授权的 scopes 取并集**（设计 29 §5.4 只对对话卡的 step-up 写了「旧 ∪ 新」）：`apps.connect` 带 `connectionId` 时请求的 scopes = 连接行现有 scopes ∪（入参 `scopes` ?? 目录默认），设置页「重新连接」与对话卡一致，不会把先前追加过的权限收窄。
  3. **`mcp.test` 不登记工具锁定行**（todo §5.5「测试成功后展示工具清单，保存即批准」）：测试只返回 `toolHashes`（+ `needsAuth`），锁定行在保存 / 「批准这些工具」经 `apps.tools.approveAfterTest` 时才写；因此测试之后的风险徽标来自随后的 `apps.connections.tools` 查询，而不是测试结果本身。
  4. **隐私政策链接以纯文本呈现**（设计 29 §4 / §9 隐含可点击）：渲染端没有打开任意外部 URL 的通道（`shell.openExternal` 只由 core 的授权流程经端口 B 调用，不向渲染端开放），`ConnectAppPanel` 把 `privacyPolicy` 显示为文字；要点击需另开白名单通道，留待后续。
  5. **目录条目全部门禁关闭发布**：`catalog.json` 的 6 条（notion / linear / atlassian / sentry / canva / stripe）`toolPolicy` / `whoami` / `scopes` 为空，`connector-release-gates.json` 为 `approved: []`——真实账号登录实测（用户待办 U2）前不放行任何条目；发布构建里目录为空，开发构建 / 测试不过滤。
  6. **ACP 一次性提示的触发与存储**（todo §5.10「Bot 切到外部智能体且勾选 `apps` 包时首次弹框」）：在 Bot 表单里由用户动作触发（选中外部智能体 / 勾选 `apps` 包的那一刻，`shouldShowAcpAppsNotice`），确认状态存 `localStorage` 键 `kepcup.apps.acpNoticeAck`（按本机，不进 settings、不随数据目录迁移）。
  7. **目录面板只经显式 `reconnectConnectionId` 解析到已有连接**（设计 29 §6 的多账号没有规定面板语义）：目录卡的「连接」/「再连一个账号」一律新建连接（新账号），只有详情页「重新连接」与对话卡的过期 / step-up 才带 `reconnectConnectionId` 落到既有行；同账号重复授权由 core 按 `account_sub` 复用旧行。
- 影响范围：`apps/auth/flow.ts`、`apps/connections.ts`、`mcp/service.ts`（`mcp.test`）、渲染端 `features/apps/*`、`features/chats/ConnectAppSetupBody.svelte`、`features/bot-panel/BotProfileForm.svelte`、`apps/desktop/resources/connectors/`、`connector-release-gates.json`。
- 可选方案：按上述实现保留（推荐）；或 1 改为只认首个 `grantBotId`（群聊里其余 Bot 全靠渲染端兜底，不推荐）、4 另开渲染端外链白名单通道（P2 起可做）、6 改存 settings（需 RPC，收益小）。
- 推荐：均保留；设计 29 在用户确认后补 §5.4「重新授权亦取并集」、§6「目录面板新建 / 重连语义」两处；U2 完成后再逐条打开门禁。
- 决定：（由人工填写）
- 已更新的文档：`docs/dev/02-architecture.md`（连接应用 P1 模块与 RPC）、`04-agent-runtime.md`（两段提示词、`app_request_connection`、应用工具暴露与时长）、`05-testing.md`（P1 用例分布）、`docs/design/29-connected-apps.md`（修订记录与三处旁注）、`docs/dev/PROGRESS.md`、`todo/connected-apps.md`（§5.8–5.11 实施记录）
