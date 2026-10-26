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
- 问题：[08-project.md](../design/08-workdir.md)（"每个 project 可以限定允许的端口范围（默认不限）"）与 P04 任务 8 要求按 `allowed_ports` 限制沙箱可访问的本机端口。srt 0.0.78 的网络配置只有 `allowLocalBinding` 布尔值（seatbelt 规则 `(allow network-bind (local ip "*:*"))` + `(allow network-outbound (remote ip "localhost:*"))`），不存在端口范围字段；且沙箱子进程环境含 `NO_PROXY=localhost,127.0.0.1,...`，回环访问完全绕过 srt 代理直连（由 seatbelt 规则裁决），代理层的 `filterRequest` 回调对回环流量不可见，无法按端口过滤。
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
  1. **对话轮的 `web_search` / `web_fetch`**：design/30 §2.1 / §12.1 要求「按 Bot 配置开关」且每轮不超过 1 次；实现是配置了搜索就对所有对话轮注册。原先次数还受 `TURN_MAX_TURNS`（8）封顶；该常量现为 0（不设步数上限），对话轮不再因步数失败，是否派任务只由提示词引导。次数开关仍按原决定保持现状，有了用量数据再决定是否加开关 / 次数上限。
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
  1. **多一张 `oauth_clients` 表**（设计 29 §12 未列）：按 issuer 一行，记客户端来源（`dcr` / `manual` / `preregistered`）与已登记的 `redirect_uris`。没有它就无法判断「客户端是否来自 DCR（最后一个引用方断开后才清除）」，也无法在打开浏览器前做 DCR 端口预判。客户端 id / secret 仍逐值存 secrets。同在迁移 `0025_app_connections.sql`。
  2. **`TokenVault.saveTokens` 要求连接行已存在**（否则抛 `APP_CONNECTION_NOT_FOUND`）：交互流程先建行（状态 `connecting`）再换令牌，令牌写入与 `token_expires_at` / `scopes` 更新在同一处完成，避免有令牌而无行的孤儿状态。测试里直接种子令牌须先 `ensureCustom`。
  3. **回调服务把浏览器请求保持到换令牌结束**（todo §4.6 只写「回给浏览器一个结果页」）：为让「已连接，可回到 KepCup」只在真正连上之后显示，回调请求挂起，由流程在换令牌后 `respond({ok})` 决定成功页或失败页；未响应 30 秒自动中性收尾，`close()` 立即销毁连接。代价：浏览器标签页在换令牌期间转圈，通常不到一秒。
  4. **`listTools` 的 GET 事件流收到 401**（todo §4.7 的待验证问题）：用 pi-mcp 真实传输层验证（`mcp-auth-transport.test.ts` 锁定）——GET 流的 401 只走 `client.onError`，不触发 `onClose`、不使连接失败，POST 照常；所以**不**对 OAuth 连接关闭 GET 流。`onUnauthorized` / `token()` 抛出的 `AppAuthRequiredError` 原样穿出传输层（`McpService` 仍保留对 `cause` 链的防御）。
  5. **账号标识未做**：todo 的 `account_sub`（`id_token` sub 等）与 `id_token` 解析 P0 不做——连接行的 `account_sub` 恒为 NULL，`label` 取 server 名；`id_token` 不保存。多账号（同一 Connector 多行）随 P1 目录一起做。
  6. **`grantBotId` 仅接受、P0 不用**：`apps.connect` 接受 `grantBotId` 并传入流程，P0 不使用它（不据此给 Bot 授权）（Bot 授权是 P1 §5.7）；P0 的 Bot 仍经 `mcp_server_ids` 勾选使用自定义应用。
  7. **`settings.update` 改认证方式 / URL 时断开旧连接**（todo 未写）：令牌的受众绑定 server URL（RFC 8707），所以原为 OAuth 的 server 被改成 `none` / `headers`、或 URL 变了，在替换 `mcpServers` **之前**吊销并清除旧连接（`AppDisconnector.reconcileServers`），并取消该 server 进行中的授权流程。纯改名、改 `autoApprove`、URL 规范化后相同则保持连接。被 `settings.update` 差集删掉的 server 不在此处理（走显式 `mcp.removeServer`，幂等）。
  8. **`apps.setClientCredentials` 在同一流程上续跑**：保存凭据后流程自行发出 `discovering` 并继续（同一 `flowId`），渲染端不再重复 `apps.connect`（早先版本的 store 会重发一次，无害但多余，已去掉）。
  9. **`app_request_connection` 的注册条件**：Bot 勾选了应用级启用的 OAuth 自定义 server 即注册（不要求此刻有需要重连的应用），因为 run 中途授权失效时模型也需要它；工具名 `app_` 前缀留给 P1 的 `apps` 能力包，P0 的 ACP 外部智能体 Bot 拿不到。
  10. **迁移号已顺延**：本分支起初取 main `0022` / `0023`，与 D80 的 `0022_schedule_title_origin.sql`、W7 的 `0023_watches.sql` 撞号；合入 main 时 D73 顺延为 `0024_app_connections.sql` / `0025_app_tools.sql`；2026-10-10 main 又新增 `0024_stickies.sql`（辅助阅读便签），D73 再顺延为 `0025_app_connections.sql` / `0026_app_tools.sql` / `0027_egress_approval.sql`。
  11. **复查后的补强（2026-10-09，不改设计语义）**：① SSRF 判定 `isPrivateAddress` 改为按 16 字节解析 IPv6（IPv4 映射 / NAT64 / 6to4 内嵌 IPv4 复判，Teredo、IPv4 兼容、站点本地、完整 `fe80::/10`、组播、文档段一律拒绝），IPv4 补 192.0.0.0/24、192.0.2.0/24、198.18.0.0/15、198.51.100.0/24、203.0.113.0/24；② `mcp.test` 的 OAuth server 只有「已保存且 URL / 认证方式一致」才会带已存令牌发请求，草稿一律「未连接」；`ConnectionAuthRegistry.providerFor(connectionId, serverUrl)` 再核对连接行记录的 URL；③ 每个连接记录授权时所用的客户端（secrets `conn:{id}:client_id|client_secret`，无迁移），刷新 / 吊销优先用它，其次 issuer 客户端，最后 CIMD——同一 issuer 上别的连接重新注册不再让既有连接失效；④ `apps.disconnect` 先取消并等待该连接进行中的交互流程（状态落 `not_connected`），registry 的世代号保证在途刷新在断开 / 重新授权后丢弃结果、不写回令牌；⑤ 流程总时限在每次尝试（含 `invalid_client` 重试、停放在 `OAUTH_CLIENT_REQUIRED`）开始时重新计时；`invalid_client` 重试后授权主机变了会重新进入 `awaiting_consent`；⑥ 启动时把上次未正常退出遗留的 `connecting` 行修正（有令牌 → `connected` / `expired`，否则 `not_connected`）；⑦ `McpService.listTools` 缓存连接上刷新后仍 401 同样产生 `AppAuthRequiredError` + `needs_auth`；⑧ `app_request_connection` 登记为 `local` 副作用类别。
- 影响范围：`apps/*`、`migrations/main/0025`、`0026`、`rpc/bindings.ts`（`settings.update`）、渲染端 `stores/apps.svelte.ts`；设计 29 §12 补 `oauth_clients`。
- 可选方案：按上述实现保留（推荐）；或逐项回到设计原文（1、2、3 会损失可观察行为，不推荐）。
- 推荐：均保留；设计 29 在用户确认后补 `oauth_clients`、「改认证方式 / URL 断开」两处。
- 决定：（由人工填写）
- 已更新的文档：`docs/dev/02-architecture.md`（连接应用）、`03-data-model.md`、`04-agent-runtime.md`、`05-testing.md`、`docs/design/23-mcp-and-subagent.md`（认证方式）、`docs/dev/PROGRESS.md`

### DEV-020 连接应用 P1 实现对设计 29 / 执行方案的偏差与补充（D73）

- 状态：已决定（2026-10-10 用户确认：全部保留）
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
- 决定：全部保留（用户，2026-10-10）
- 已更新的文档：`docs/dev/02-architecture.md`（连接应用 P1 模块与 RPC）、`04-agent-runtime.md`（两段提示词、`app_request_connection`、应用工具暴露与时长）、`05-testing.md`（P1 用例分布）、`docs/design/29-connected-apps.md`（修订记录与三处旁注）、`docs/dev/PROGRESS.md`、`todo/connected-apps.md`（§5.8–5.11 实施记录）

### DEV-021 连接应用 P2 实现对设计 29 / 执行方案的偏差与补充（D73）

- 状态：已决定（2026-10-10 用户确认：按推荐，全部保留）
- 阶段：D73 P2（`todo/connected-apps.md` §6）；P0 / P1 的项见 DEV-019 / DEV-020
- 是否阻塞：否
- 问题：实现 P2 时，设计 29 §5 / §7 / §8.3 / §11.3 与 todo §6 有若干没写到或与既有实现冲突之处：
  1. **开发者档语义收窄**（todo §6.6「自定义条目 tier `developer`：所有工具每次确认」）：`mcp/policy.ts` 的 `isDeveloperTier(server)` 只对 `McpServer.tier === 'developer'` 的 server 生效（MCPB 包安装生成的 server 带该标记；来自目录条目的 MCPB 不带）：全部风险档默认 `ask`（只读也不再自动放行），`destructive` 恒 `ask`，可逐工具 / server 级 `autoApprove` 放宽其余。**普通自定义 server 保持 W5 已落地的默认**（只读自动、写 / 破坏性确认），不因开发者模式开关改变——否则会推翻 W5 的用户决定。开发者模式开关（`settings.apps.developerMode`）只控制「自定义」页是否显示原始工具定义 / 授权事件日志 / 手动刷新。
  2. **OAuth 客户端选择顺序调整**（设计 29 §5「预注册 → CIMD → DCR → 手填」）：实际顺序 = 用户自带 / 已存的非 DCR 客户端（`apps.oauthClients.*`，`source: manual`）→ 目录 `clientRef` 在预注册表（`oauth-clients.json`）里的项（按 issuer 校验）→ 此前 DCR 得到的客户端 → CIMD → DCR → `OAUTH_CLIENT_REQUIRED`。已存 DCR 客户端让位于预注册项（否则一次早先的 DCR 会永远盖住后来发布的预注册）；`registration: 'preregistered'` 的条目**不回退**：表项 issuer 与发现到的不符 → `OAUTH_ISSUER_MISMATCH`，表里没有该 `clientRef` → 目录连接在发起时即拒绝（`NOT_IMPLEMENTED`，「当前版本未包含」），流程内则停放为 `OAUTH_CLIENT_REQUIRED` 等用户自带客户端，均不改走 CIMD / DCR。issuer 比较前先规范化（trim + 去尾斜杠）；DCR 结果保存不再覆盖流程中途出现的 BYO 客户端。
  3. **污点期间写工具的混合规则**（todo §6.2 / 设计 29 §8.3「降级为每次确认 / 新增 `egress` kind」）：本来就会弹 `mcp_tool` 卡的写工具调用只出**一张**卡——带 `tainted` 标记、`taintedSince` 与完整参数（`argsFull`）；本来不出卡的调用（持续授权命中、`auto` 策略、server `autoApprove`）改弹 `egress` 卡（channel `app_tool` / `mcp_tool`，只有「允许一次」）。同理 `git_remote` 与确认模式的 `command` 卡不叠第二张，带 `tainted` 标记。设计 / 方案原文是一律 `egress` 卡，会让用户对同一次调用连点两张。
  4. **污点的来源与传递范围**：来源**只有目录连接的应用工具**（`wrapMcpTool` 成功返回后置位）；自定义 MCP 工具是通道（非只读或 `openWorldHint:true` 的才算）不是来源。判定按**对话**（`TaintService.guard`：该对话里任一 Bot 的行未过期）——群聊里任一成员读过应用数据，所有成员的外发都要确认；委派投递 / 结果贴回时 `TaintService.inherit` 把污点带到目标对话（保留 `first_at`，`expires_at` 取较晚者，接线在 `DelegationsService.onMoved`）。对话删除删该对话全部行，Bot 删除只删它私聊里的行。设计只写「按（Bot, 对话）计」。另：`watch_create`（网页监看，会周期性用 Bot 的浏览器资料访问 URL）与浏览器点击（deny-by-default：只有惰性角色白名单免确认，未知 ref 也算）也纳入外发通道，设计 29 §8.3 的表未列。
  5. **MCPB 的同意方式与参数**（todo §6.5「审批卡显示完整启动命令、来源、体积」）：设置页安装没有对话可以挂审批卡，**以对话框内的确认面板作为同意**（面板显示完整启动命令、来源、sha256、体积，`mcpb.inspect` 供数）；`mcpb.install` 必须回传面板上看到的 `sha256`（文件在确认后被替换 → 拒绝）；只有带 `conversationId` 的安装才走 `environment` 类审批卡（完整命令、遮蔽后的密钥、sha256、体积、来源）。已知隐患：D41 无人值守会自动批准 `environment` 卡，因此本期 `mcpb.install` 只由用户在设置页（或带 `conversationId` 的 RPC 调用方）发起，没有 Agent 发起的入口，所以暂未给该卡加「永不自动批准」标记；将来任何由 Agent 发起的安装入口必须先加上（代码里已在 `rpc/mcpb-bindings.ts` 的 `conversationId` 分支留注释）。
  6. **step-up 待追加 scopes 只在进程内**（迁移冻结，todo §6.1 未规定存放处）：`AppConnectionStore.setPendingScopes` / `getPendingScopes`（经 Token Vault）；卡片被忽略或被限流抑制后，设置页「重新连接」/ `apps.connect({connectionId})` 由 `AppConnectionsService #begin` 并入请求；重启后丢失，下一次 403 重新得到。目录连接首次只申请 `auth.scopes.default`。限流名额（`AppStepUpLimiter`，进程内，`APP_STEP_UP_WINDOW_MS` 30 分钟）在卡片随 run 发出时才占用，被抑制的调用返回普通失败 `APP_SCOPE_INSUFFICIENT`。
  7. **对话轮 / 子代理遇到外发确认不等待**（D75 的后果，设计 29 §8.3 没有区分）：污点期间的外发在对话轮 / 子代理里非无人值守时直接 `RUN_READ_ONLY` 失败并引导 `start_task`（任务里逐次确认）；无人值守下仍按 D41 自动批准并审计 `egress_tainted`（`apps.egressSummary` 在 Bot 详情汇总）。
  8. **只读子代理的按需发现**：（D91 现状）能力的已启用工具总数超过 `EXTERNAL_TOOLS_INLINE_MAX` 时，只读子代理拿 `capability_search` / `capability_call`，但搜索与调用范围限于「只读 + 免审」子集（网关另在子代理上拒绝其余）。
  9. **迁移**：P2 只新增 main `0027_egress_approval.sql`（`approvals` 重建加 `egress`；`app_taint`）；顺延规则同前，最终合并时若 main 又前进则再顺延。
- 影响范围：`apps/{step-up,taint,discovery,oauth-clients}.ts`、`apps/auth/{flow,flow-log}.ts`、`apps/mcpb/*`、`apps/connections.ts`、`apps/exposure.ts`、`mcp/policy.ts`、`mcp/tools.ts`、`tools/{app-tools,browser,watch-tools}.ts`、`gateway/index.ts`（`egressCheck`）、`permissions/approvals.ts`、`agent/external/permission-bridge.ts`、`dispatch/orchestrator.ts`、`domain/{lifecycle,delegations,audit}.ts`、`rpc/{apps-bindings,apps-runtime-bindings,apps-connections-bindings,mcpb-bindings}.ts`、`migrations/main/0027`、shared `domain/{mcpb,oauth-clients}.ts` 与 `mcpServerSchema.source` / `tier`、渲染端 `features/settings/{OAuthClientsPanel,McpDevTools,McpbInstall,UnattendedSection}.svelte`、`features/bot-panel/EgressSummary.svelte`、`features/chats/ConnectAppSetupBody.svelte`。
- 可选方案：按上述实现保留（推荐）；或 1 改为所有自定义 server 在开发者模式下全部确认（推翻 W5，不推荐）、3 改为一律 `egress` 卡（同一调用两张卡，不推荐）、4 改回只按（Bot, 对话）计（群聊可洗白污点，不推荐）、5 改为设置页安装也出审批卡（需先有承载卡片的对话，收益小）、6 把待追加 scopes 落库（需新迁移，等下一次合并窗口）。
- 推荐：均保留；用户确认后设计 29 §5 客户端顺序、§8.3 外发规则、§11.3 开发者档的旁注并入正文。
- 决定：全部保留（用户，2026-10-10）
- 已更新的文档：`docs/dev/02-architecture.md`（连接应用 P2 模块与 RPC）、`03-data-model.md`（`app_taint`、`egress`、`apps.developerMode` / `taintGuard`、MCP server `source` / `tier`）、`04-agent-runtime.md`（按需发现、step-up、外发确认、开发者档）、`05-testing.md`（P2 用例分布）、`docs/design/29-connected-apps.md`（修订记录与五处旁注）、`docs/dev/PROGRESS.md`、`todo/connected-apps.md`（§6 实施记录）

### DEV-022 连接应用 P3 实现对设计 29 / 执行方案的偏差与补充（D73）

- 状态：待决定
- 阶段：D73 P3（`todo/connected-apps.md` §7）；P0–P2 的项见 DEV-019 / DEV-020 / DEV-021
- 是否阻塞：否
- 问题：实现 P3 时，设计 29 §8.2 / §11.3 / §11.4 / §11.6 与 todo §7 有若干没写到或与既有实现冲突之处：
  1. **发行门禁的权威来源按条目来源区分**（todo §7.1「与打包快照合并（同名取较新且通过验签者）」）：随应用打包的 `builtin` 条目，`releaseGate` 恒取快照值，合并之后快照来源的条目仍整体过 `filterReleasedConnectors`（厂商门禁留在客户端，U2 放行才可见）；**远端独有条目**以验签为授权——它们声明的 `releaseGate` 一律忽略并改写为 `'directory'`，不受厂商门禁约束（否则社区目录在发行构建里永远是空的），但必须通过严格的端点校验（`isSafeDirectoryRemoteUrl`：https、无用户信息、带点的非 IP 域名、非 `localhost`；`ConnectorCatalog.isDirectorySourced`，`apps/connections.ts` 再断言一次，目录来源条目永远拿不到注册表里的回环例外）。分级也被钳制：远端自称 `builtin` 按 `verified`，`developer` 丢弃。
  2. **社区应用首连确认由 core 强制，且无工具可复核的条目没有确认步骤**（todo §7.2 只写「首连额外提示」）：渲染端勾选框之外，`apps.connect.confirmTools({acknowledgeCommunity})` 在 `tier === 'community'` 时缺确认返回 `INVALID_INPUT`（`apps/auth/flow.ts`）；确认挂在工具复核步骤（`reviewing_tools`，事件新带 `tier`）上，没有任何待复核工具的社区条目没有这一步，也就没有确认（此时没有可被授权的工具）。`community` 的写工具时长只有 `once` / `conversation`；**任何创建路径**都不能产生 Bot 级授权（`AppToolGrants.create({connectionTier})` 兜底拒绝，`find({excludeBotLevel})` 令已存在的 Bot 级行对该档不命中）；分级未知 / 缺失一律 fail-closed 按 `community`。
  3. **目录增量文件客户端暂不消费**（todo §7.1「增量 `deltas/{from}-{to}.json` 按内容寻址」）：签名脚本会生成增量并随索引发布（`index.json` 的 `deltas` 引用、`applyDirectoryDelta` 已有纯函数与测试），但 `directory-sync.ts` 每次拉完整索引（≤ 4 MiB / 5000 条）；消费增量留待目录变大后。
  4. **技能克隆发生在审批之前，且无体积 / 时间上限**（todo §7.6「走既有 `skill_import` 审批」）：`SkillImporter.import` 先用 libgit2 把目录声明的 https 来源克隆到暂存区、扫描，再提交 `skill_import` 审批卡（来源、commit、扫描结果在卡上）；克隆本身没有大小 / 时间上限——这是 D63 既有行为，未改，列为 D63 的后续项。目录声明的技能名必须等于 SKILL.md 里的名字（`expectedName`，不符 → `status: 'mismatch'`，不提交审批，本进程内不再提示 / 不再克隆）；`isSafeSkillSourceUrl`（https、无用户信息 / 端口 / 查询、带点域名、非 IP / localhost / `.local`、≤ 500 字符）在目录 schema 与安装时各校验一次。
  5. **MCP Apps 的 iframe 没有独立 partition**（设计 29 §11.6 原文「独立 partition、独立 origin `kepcup-app://{connectionId}/`」）：spike（todo 附录 B.7）证实 `<iframe>` 无法有自己的 partition，特权协议 `kepcup-app` 只能挂在宿主窗口所在的默认 session。隔离改由 opaque origin（`sandbox="allow-scripts"` 且无 `allow-same-origin`）+ 逐应用响应头 CSP + `frame-src kepcup-app:` + 子框架 `will-frame-navigate` 拦截（判定失败即关闭）+ 默认 session 权限白名单（`kepcup-app:` 来源一律拒绝）+ `allow=""` + 无 preload 共同保证；URL 形态为 `kepcup-app://{host}/{resourceId}`（host 由 server id 派生，resourceId 是 128 位随机数）。
  6. **界面发起的工具调用 `visibility` 默认拒绝**（MCP Apps 规范缺省 `["model","app"]`）：`tools/call` 只允许同一 server 的、`_meta.ui.visibility` **显式**含 `app` 的工具，未声明 / 仅模型可见 / 未知工具一律 `APP_UI_TOOL_NOT_ALLOWED`，不出卡不调用。
  7. **界面发起的写入一律要人点**（设计 29 §8.1 的无人值守 / 持续授权规则不适用）：`origin: 'app_ui'` 的调用走 `requireHuman`——无人值守、`auto` 策略、server `autoApprove`、持续授权都不能代替，卡片时长只有 `once`（应用不能给自己铸授权），载荷与审计带 `origin:'app_ui'` 与应用名，卡片标「来自应用界面的操作」；同一张卡对被拒绝的工具 30 秒内静默，每个对话至多 3 个待处理的界面调用；卡片关闭 / 过期 / 应用断开 / server 移除会取消待处理审批，之后批准也不执行。ACP 桥（外部智能体）调用应用工具时不出 `mcp_app` 卡。
  8. **MCP Apps 页面的 CSP 响应头带 `sandbox allow-scripts` 与 `frame-ancestors file: http://localhost:*`**（todo spike 原写 `default-src 'none'` 系列、未提 `frame-ancestors`）：CSP 来源清洗后只接受 https / wss 的精确域名，**拒绝一切通配**，回环只认所属本机 server 的完全相同 `host:port`；`frame-ancestors` 不设 `'none'`，因为宿主页是 `file://`（打包）或 `http://localhost`（开发）。
  9. **`@modelcontextprotocol/ext-apps` 钉在 1.7.5**：2.x 的 peer 依赖是 SDK 2，仓库锁在 SDK 1.32.1；升级只换 `app-bridge-host.ts` 的 import。
  10. **`core-port` 握手加秘密 nonce**（评审发现的严重问题，设计未涉及）：渲染端原先接受任何 `message` 事件的 `core-port`，沙箱 iframe 可 `parent.postMessage('core-port', …)` 劫持界面的 core RPC 端口。现 preload 发 `{type:'core-port', nonce}`（nonce 每次加载随机），渲染端只在 `event.source === window` 且 nonce 匹配时接管端口（`rpc/port.ts`）；e2e 探针在旧实现上被证实会失败。测试用页面钩子 `window.__kepcupRpc` 也列入 `pack-hooks` 的 `FORBIDDEN_MARKERS`（产物里不得出现）。
  11. **社区目录条目在发行构建里无需应用发行门禁即可见，但只经已验签的索引**：生产公钥列表 `CONNECTOR_INDEX_PUBLIC_KEYS` 在用户完成 U5 之前为空——此时目录同步 `disabled`（`disabledReason: 'no_keys'`），不联网，只用打包快照；因此在 U5 之前不存在这条旁路。
  12. **远端索引不能降低 `builtin` 应用的工具风险**（todo §7.1 只写「同名取较新」）：同名 `builtin` 条目的 `remotes` / `packages` / `auth` / `whoami` / `icon` / `slug` / `skills` 钉死为快照值，`toolPolicy` 只升不降（快照里没有的工具名只接受 `destructive`），远端能更新的只有标题 / 描述 / 版本 / 隐私政策 / 类别 / `ui`；换端点必须发新版应用。
  13. **远端字符串进系统提示词前先清洗**（设计 29 §8.3 只要求应用输出包 `<untrusted>`）：`<available_apps>` / `<capabilities>` 里的标题 / 说明经 `apps/prompt.ts oneLine`，去掉 `<` `>`、控制字符、双向控制符与零宽字符并截断，目录条目（含签名过的）不能借提示词注入。
- 影响范围：`apps/{directory-sync,directory-merge,tier,skills-offer,catalog,connections,grants,prompt}.ts`、`apps/auth/flow.ts`、`apps/ui/*`、`mcp/{risk,service,tools}.ts`、`gateway/index.ts`、`permissions/approvals.ts`、`skills/library.ts`、`dispatch/orchestrator.ts`、`domain/messages.ts`、`rpc/{apps-bindings,apps-connections-bindings,apps-skills-bindings,apps-ui-bindings,bindings}.ts`、`start.ts`、shared `domain/{directory-index,apps-ui,app-skills,connector-catalog}.ts` 与 `policy/*`（从 core 抽出的纯函数）、`scripts/sign-connector-index.mjs`、`infra/cloudflare/{directory,registry}/`、`packages/app-validator/`、主进程 `main/{apps-ui,apps-ui-policy,index}.ts` 与 `apps/desktop/scripts/pack-hooks.cjs`、渲染端 `features/apps-ui/*`、`features/apps/{AppCatalogGrid,ConnectAppPanel,ConnectedSkillsPrompt}.svelte`、`rpc/port.ts`；无新迁移。
- 可选方案：按上述实现保留（推荐）；或 1 让远端独有条目也受厂商门禁约束（社区目录在发行构建里恒为空，不推荐）、2 去掉 core 侧强制只靠界面勾选（绕过界面即可跳过确认，不推荐）、3 现在就实现增量消费（收益小，等目录变大）、4 在 D63 的导入器里加克隆体积 / 时间上限并改成「先审批后克隆」（需要把来源与 commit 提到审批卡前，工作量较大，留作 D63 后续）、5 给 MCP Apps 另开 `BrowserWindow` / `webview` 以换独立 partition（隔离更强但卡片内嵌体验与消息流集成要重做，不推荐）、6 / 7 放宽为规范缺省或允许持续授权（应用可借此自授权写入，不推荐）。
- 推荐：均保留；用户确认后设计 29 §8.2 / §11.3 / §11.4 / §11.6 的旁注并入正文，U5 完成时再核对第 11 项的前提（生产公钥已填入）。
- 决定：（由人工填写）
- 已更新的文档：`docs/dev/02-architecture.md`（连接应用 P3 模块与 RPC）、`04-agent-runtime.md`（分级规则、界面发起的审批、随附技能提示、MCP Apps 卡）、`05-testing.md`（P3 用例分布与注入点）、`docs/design/29-connected-apps.md`（修订记录与三处旁注）、`docs/dev/PROGRESS.md`、`todo/connected-apps.md`（§7 实施记录）、`todo/connected-apps-user-actions.md`

### DEV-023 扩展中心（X0–X4 / X6）实现对任务书 / 设计 29 的细化与取舍（D73）

- 状态：待决定
- 阶段：扩展中心（`todo/extension-center.md` X0–X4、X6；设计 29 §16）；分支 `t/extension-center`
- 是否阻塞：否
- 问题：任务书把几处落点留给实现者选择，实现时的取舍如下（均已写入设计 29 §16）：
  1. **「开发者模式」是一个常驻的设置分区**（决定 A 的落点）：`SettingsSectionId` 增 `developer`，导航项始终可见（开关就在分区里，隐藏则无法开启）；开关关闭时只显示一句说明，**自定义入口**（新建 server：stdio / HTTP / SSE，BYO 客户端面板，原始工具定义 / 授权日志）全部不渲染。扩展中心「MCP」组里**不放**开关或自定义入口。
  2. **`mcp` 别名与 `openSettings('apps', anchor, 'custom')` 落「开发者模式」分区**（原落「应用 → 自定义」页）。开发者模式关闭时用户看到的是开关而不是 server 列表——已有 server 的管理改在扩展中心「MCP」组（启停 / 编辑 / 删除 / 逐工具策略 / OAuth 连接仍在行内），`settings.mcpServers` 与既有连接不迁移、不删除。
  3. **设置「应用」的「目录」页签直接移除**（任务书允许「移除或改成跳转」）：整个分区去掉页签（只剩已连接管理），顶部加跳转扩展中心的横条；`APPS_TABS` / `appsTabForKey` 删除，`AppsTab` 类型保留 `'catalog' | 'connected' | 'custom'` 仅为旧深链参数可编译（`catalog` / `connected` 被忽略，`custom` → 开发者模式）。Bot 面板的「去连接」改为直接打开扩展中心「连接」组。
  4. **「MCP」组复用 `McpSection` 的 `manage` 形态**：保留已有 server 的编辑 / 删除（只隐藏「新建 server」与 BYO 客户端面板），`.mcpb` 安装留在这里。
  5. **精选 MCP 清单只建空壳，不接 RPC、不进安装包**：`resources/mcp-presets/catalog.json`（空）+ core `mcp/presets.ts` 的 schema / 加载器 + 单测；`extraResources`、core-host 环境变量、RPC 与卡片渲染等第一个条目落地时再补（见该目录 README）。
  6. **扩展中心弹框改为固定高度（`h-[70vh]`）**：原技能市场是 `max-h-[85vh]` 随内容伸缩；三个分组共用一个框，固定高度避免切页签时抖动。Skills 分组内容与行为不变（`skill-market-*` testid 原样保留，仅弹框与入口按钮改名）。
  7. **「连接」组的目录为空时隐藏搜索 / 分类筛选**，只显示「暂无已适配的应用」（新增 `AppCatalogGrid` 的 `onManage` 属性与目录空态；设置里不再使用该网格）。
- 影响范围：渲染端 `features/extension-center/*`、`features/settings/{sections,SettingsDialog,AppsSection,DeveloperSection,McpSection}`、`features/apps/{AppCatalogGrid,AppConnectionsList}`、`stores/shell.svelte.ts`、`i18n/locales/zh-CN.ts`；core `mcp/presets.ts`；e2e `skill-market` / `sidebar-resize` / 新增 `extension-center`。无 RPC / 迁移 / 共享契约改动。
- 可选方案：按上述实现保留（推荐）；或 1 把「开发者模式」开关放进「通用」分区、仅开启后才出现分区导航（多一处开关入口，不推荐）、5 现在就接 RPC 与打包（清单为空时是死代码，不推荐）。
- 推荐：均保留。
- 决定：（由人工填写）
- 已更新的文档：`docs/design/29-connected-apps.md`（§16、§9、D73 第 7 条、修订记录）、`docs/design/{03-bot,05-wiki-and-skills,22-file-skill-routing}.md`（技能市场 → 扩展中心 Skills 分组）、`todo/connected-apps*.md`、`apps/desktop/resources/{connectors,preset-skills,mcp-presets}/README.md`、`docs/dev/PROGRESS.md`。

- **DEV-023 修订（评审后，2026-10-10）**：
  8. **core 改动 `ensureCustom` 换源兜底**（超出「无 core 改动」的原表述）：自定义 server 的 URL origin 变化时重置连接行并清令牌（见 PROGRESS「扩展中心 评审修复」）；`settings.update` 主路径的行为（`reconcileServers` 对任何 URL 变化先吊销并断开）不变，比 origin 判定更严。
  9. **开发者模式关闭时收紧**：「MCP」组里已有 server 的命令 / 参数 / URL 只读；目录应用的 `OAUTH_CLIENT_REQUIRED` 不再给手填表单（已存在的自定义 server 除外）。
  10. **指引文案**：「设置 → MCP 服务器」「设置 → 应用 中连接账号」「设置的『自定义』页」「设置页检查配置」等改指扩展中心。
  11. **core / shared 契约小改（缺陷修复，向后兼容）**：`apps.connection_status` 事件新增可选 `removed: true`（行被删）；临时行（`connecting` 且无令牌的目录行）不计入 `connectedAccounts` 与 `apps.connections.list`。测试基建新增 `desktop-svelte` vitest 项目（见 PROGRESS「缺陷修复」）。

- **DEV-023 被取代（2026-10-15，`e75b950`）**：第 1、2、9 项（常驻「开发者模式」设置分区、`mcp` 别名 / `custom` 深链落该分区、开发者模式关闭时「MCP」组只读）已被「扩展中心 MCP 全量管理」取代：设置里的「开发者模式」分区与设置目录条目 `developer.mode` 移除；新建 / 编辑自定义 MCP server、BYO OAuth 客户端、原始工具定义与授权日志、`.mcpb` 安装一律在「扩展中心 → MCP」，不再有门禁；旧深链 `mcp` / `developer` 改开扩展中心。`settings.apps.developerMode` 成为遗留字段（保留写接口以免旧客户端报错，不再被任何门禁读取）。第 4 项（「MCP」组只隐藏新建 server 与 BYO 面板）随之失效。设计 29 §16 已同步。

### DEV-024 本机连接（L0–L3、L5）实现对任务书 / 设计 29 的细化与取舍（D73）

- 状态：待决定
- 阶段：本机连接（`todo/local-connector-authoring.md` L0–L3、L5；设计 29 §17）；分支 `t/local-connectors`（基于 `t/d73-connected-apps`）；L4 渲染端未做
- 是否阻塞：否
- 问题：任务书把几处落点留给实现者选择，或与现状不符，取舍如下（均已写入设计 29 §17）：
  1. **目录连接的 `developer` 分级此前并未生效**（安全要求，已补齐）：设计 29 §11.3 / DEV-021 第 1 项只对 `McpServer.tier === 'developer'`（MCPB）实现；目录连接的审批决定 `ConnectedApps.#decide` 没有传分级，所以 `tier: developer` 的目录条目只读工具仍自动放行。现在把分级传入 `decideMcpTool`（全部默认每次确认、用户可逐工具放宽、破坏性恒确认），并新增 `tierAllowsStandingGrants`：`developer` 在网关里 `grantable=false`（既无 Bot 级也无对话级持续授权，`assertGrantAllowedForTier` 兜底），授权前 `awaiting_consent` 恒触发（同站点也不自动打开浏览器）。此前目录里没有 `developer` 条目（远端目录丢弃它），所以对既有连接无影响。
  2. **不支持「完全无认证」的 MCP 服务**（任务书 §1.4 写了「OAuth 或完全无认证」）：目录连接底座只实现 OAuth（`connectionToMcpServer` 恒 `auth: 'oauth'`，`apps.catalog.list` 对非 oauth 条目 `connectable=false`）。匿名服务在探测时带原因拒绝，并指向「设置 → 开发者模式」手动添加。本机条目的记录 schema 因此只接受 `oauth` + `auto`。
  3. **新增 `apps.localConnectors.reject`**（任务书只列 list / confirm / remove）：确认卡的「取消」要显式丢弃提案，而不是等 TTL；另新增事件 `apps.catalog_changed`（`{connectorId, change}`）与三个错误码 `LOCAL_CONNECTOR_REJECTED` / `LOCAL_CONNECTOR_EXPIRED` / `DEVELOPER_MODE_REQUIRED`。均为追加，不改既有契约。
  4. **本机条目的 MCP 工具调用流量也走 SSRF 守卫**（任务书只写了探测阶段）：`McpService.attachHttpFetch` 给本机连接的 Streamable HTTP 传输换用 `createGuardedMcpFetch`（连接时校验解析地址、仅同源重定向、不缓冲 SSE）。理由：地址由 Bot 提供，探测通过不等于之后不会被 DNS 重绑定到内网。打包目录 / 远端目录条目沿用原行为（未改）。
  5. **手册是 TS 常量而不是 Markdown 资源**（`apps/local-connector-guide.ts`）：core 被 esbuild 并成单个入口，没有运行时资源目录；常量随 core 打包，打包流程无需改动。
  6. **探测到的 scopes 冻结进条目** `auth.scopes.default`：确认卡展示的就是将请求的范围；服务端之后改范围时需删除重加。无范围则保持 `[]`（按服务端提示）。
  7. **本机条目的 `privacyPolicy` 是占位**（服务自己的 origin，schema 要求必填 URL）、`icon` 是占位文件名（`iconSvg` 对本机条目恒返回 null）；L4 不应把它们当作「已审核的隐私政策 / 图标」展示。
  8. **隔离的纵深防御**：远端目录合并丢弃使用 `local.kepcup/` 命名空间或 `releaseGate: local` 的条目；`scripts/sign-connector-index.mjs` 拒收这类条目（防误把本机记录丢进 `--extra-dir`）。
  9. **可用面**：`developer` 条目的只读工具有效审批是 `ask`，所以不在对话轮的只读工具面（`allowedOnReadOnlySurface` 要求 `auto`）里——本机连接的工具默认只在任务里可用，用户把某个只读工具逐个放宽为「自动」后才进对话轮。符合「每次确认」，不是缺陷。
  10. **数量与时间**：本机条目上限 20、待确认提案上限 10（同一服务的新提案顶掉旧的）、提案 TTL 30 分钟；`settings.apps.localConnectors` 的值读取时才逐条校验（类型是 `Record<string, unknown>`），一条损坏的记录只丢它自己，且仍可被 `remove` 删掉。
- 影响范围：shared `domain/{local-connectors,connector-catalog,app-connections,types}.ts`、`rpc/{methods,events}.ts`、`errors.ts`；core `apps/{local-connectors,local-connector-probe,local-connector-guide,catalog,exposure,tier,audit,directory-merge,connections}.ts`、`apps/auth/flow.ts`、`mcp/service.ts`、`gateway/index.ts`、`tools/app-tools.ts`、`agent/effects/classify.ts`、`dispatch/orchestrator.ts`、`rpc/apps-connections-bindings.ts`、`start.ts`；`scripts/sign-connector-index.mjs`。无迁移；无渲染端改动（`SetupRequiredCard` 遇到 `confirm-local-connector` 会落到最后的分支，L4 前开发者模式默认关闭，不会触发）。
- 可选方案：按上述实现保留（推荐）；或 2 为匿名 MCP 补一条 `auth: none` 的目录连接路径（需要改 `connectionToMcpServer`、连接流程、`connectable` 与工具复核，工作量不小，且匿名服务没有「账号」概念）、4 对所有目录条目都加 MCP 流量守卫（行为变更面更大，需要单独评审）。
- 推荐：均保留。
- 决定：（由人工填写）
- **DEV-024 修订（独立安全评审后，2026-10-10）**：
  11. **A1 跨站授权服务器**：卡片 `issuerCrossSite` + 强警告，`confirm` 要 `acknowledgeCrossSiteIssuer`（新错误码 `LOCAL_CONNECTOR_ACK_REQUIRED`，缺确认不消耗提案）；`developer` 分级只用 CIMD / DCR（不用预注册表兜底、不用 BYO）。
  12. **A2 issuer 钉死**：目录条目 schema 新增可选 `_meta.expectedIssuer`（本机条目必填）；连接时 issuer 漂移 → `OAUTH_ISSUER_MISMATCH`。
  13. **A3**：shared `sanitizeDisplayText` / `sanitizeScopes` 为唯一清洗实现，`oneLine`、账号标签、内联工具说明同用；本机连接忽略授权服务器给的 name / email / sub（自动编号），并且不再把令牌发去 userinfo。此项改变了 `oneLine` 的行为：不可见 / 格式字符现在是**删除**而非替换成空格（`app-prompt-sanitize` 用例相应更新）。
  14. **A4**：`McpAppUiService.uiAllowed`——**只**对本机 / `developer` 条目生效，没有按「预置条目的 `ui: false`」一概禁用（那会让现有的 MCP Apps 渲染测试与预置应用失效：预置条目的 `ui` 目前只是声明、MCP Apps 由工具元数据驱动）。记录：`toolDefinitionHash` 不含 `_meta`。
  15. **A5–A7、B**：主机名规范化与同域不同路径的明确提示；提案限流（每 run 5、每对话每小时 20）；错误文案固定；`<available_apps>` 本机优先（≤10）；`settings.update` 的 `apps` 对最新设置合并；`developer` 分级的内联工具说明加「第三方数据」前缀并清洗（没有套 `<untrusted>`：内联工具说明属于工具定义，走工具锁定复核）。
  16. **L4 引入的两处小 core 改动**：`apps.connections.tools` 的有效审批与 `setToolPolicy` 的「变严」判断按条目分级计算（此前本机连接的只读工具在详情页误显示「自动」）；e2e 测试钩子 `KEPCUP_TEST_OAUTH_LOOPBACK`（仅测试钩子构建 + `NODE_ENV=test`，真实 Electron 里没有 createCore 选项可传回环白名单）。
  17. **未做**：真实 Electron 里 DNS 重绑定的端到端（只有可注入解析器的 `createGuardedMcpFetch` 单测）；匿名 MCP 仍不支持（见第 2 项）。
- 已更新的文档：`docs/design/29-connected-apps.md`（新增 §17、§17.3a、§11.3 旁注）、`docs/guides/add-connected-app.md`（「本机生成」）、`todo/{local-connector-authoring,developer-portal,extension-center,connected-apps-status}.md`、`docs/dev/PROGRESS.md`。
- **DEV-024 修订（2026-10-15，`e75b950`，已决定）**：本机连接取消开发者模式门禁——core 不再抛 `DEVELOPER_MODE_REQUIRED`（`propose` / `confirm` 去掉门禁检查；错误码仅为兼容保留在 `errors.ts`），orchestrator 对**所有 Bot** 提供 `app_local_connector_guide` / `app_propose_local_connector`。安全边界不变：Bot 只能发起提案，任何条目都要用户在确认卡（`confirm-local-connector`）上点「添加」才落库；`developer` 分级的审批规则（默认每次确认、无持续授权、跨站授权服务器强警告与显式确认）照旧。第 2 项里「匿名服务指向『设置 → 开发者模式』手动添加」改为指向「扩展中心 → MCP」手动添加（该文案的 core 改动在本文撰写时尚未提交）。

### DEV-025 邮件通道的 IMAP/SMTP 库（设计 35 §11 授权实施期选型）

- 状态：已落实
- 阶段：D84 邮件通道 P0
- 是否阻塞：否
- 问题：设计 35 §11 写明 IMAP/SMTP 客户端库在实施期选定，要求维护活跃、支持 IDLE 与自定义 ID。01-conventions 对未列入阶段文档的大型依赖要求先记录。这里的库是协议客户端，不是框架、运行时或原生模块。
- 影响范围：`packages/core` 依赖 `imapflow@2.4.0`、`nodemailer@10.1.0`、`mailparser@3.9.38`。
- 可选方案：
  1. 使用上述三个库 — IDLE、ID、MIME 解析都有现成实现；许可证 MIT。
  2. 自写 IMAP/SMTP — 不增加依赖，但 IDLE 与 MIME 容易错。
- 推荐：方案 1。设计已把选型交给实施。163 不在 CAPABILITY 里广告 ID 时，连接后仍强制发 `ID name=KepCup`（库默认只在广告了 ID 时才发）。
- 决定：采用方案 1。
- 已更新的文档：`docs/dev/03-data-model.md` 删除 Bot 级联增加邮箱绑定。

### DEV-026 对话内应用设置 P0 实现对 todo/conversational-app-setup.md 的偏差与补充（D89）

- 状态：已落实（编号与 D89 / design 38 一样，合并时以最后一个空号为准）
- 阶段：D89 对话内应用设置 P0
- 是否阻塞：否
- 问题：方案按「P0 实现前逐项复核」落地时，以下几处与方案文字不同或方案未写：
  1. **`maxMode` 与 `effectiveMode` 的 link 兜底**：目录里 `maxMode` 记的是**目标**档位（如 `bot.network` 为 confirm / 放宽 user-only、`unattended.enable` 为 user-only）；没有内嵌组件（`card = null`）的条目由 `effectiveMode` 兜底成 `link`（规则代号 `no-card`）。P0 内嵌卡只有 9 个键 18 个条目，其余 core 条目当前出的都是跳转卡，不是方案表里的 confirm / user-only 内嵌卡（方案 §八 P0 本就只要求 D58 用过的组件嵌入化，这里只是把「表里的档位」与「当次实际档位」分开说明）。
  2. **`settings_read` / `settings_change` 增 `bot_id`**：方案只在 §5.3 第 4 条提到管家可改别的 Bot，未给参数。实现为两个工具各增可选 `bot_id`（默认自己；只对 Bot 范围条目有意义）；普通 Bot 指向别的 Bot 直接 `refused`，管家最多 confirm。
  3. **目录条目比方案 §4.2 示例多**：共 58 条，另登记了 `models.widget-review`、`models.concurrency`、`connections.taint-guard`、`agents.default`、`bot.agent`、`bot.file-access`、`developer.mode`、`diagnostics.*` 等，覆盖率测试要求设置界面每个位置都有条目或排除理由，登记齐比只登示例更稳。
  4. **loop 限制**：方案说「对话轮与任务都注册」；实现里 `effectiveMode` 对 turn / task 之外的 loop（后台作业、制作 loop 等）一律 `refused`（规则 `loop`），防止后台 loop 改设置。
  5. **`unattended.enable` 出跳转卡**：方案写「开启无人值守出 user-only 空白卡」。`UnattendedSection` 尚未嵌入化，P0 实际出的是 user-only 档的**跳转卡**（`card = null` → link），`values` 同样不被采用；空白卡等 P1。关闭（`unattended.disable`）由宿主直接调 `unattended.disable`。
  6. **pending 卡 TTL**：方案只写「过期标 `expired`」。实现为 pending 卡 7 天无人处理过期（`SETTING_CARD_PENDING_TTL_MS`，与拒绝窗口同值），惰性判定；回执卡不过期（24 小时撤销窗口）。
  7. **自定义 / 新厂商缺 Key → form**：`needsSensitiveInput` 在要换到没有 Key 的厂商（含自定义厂商）时把档位收紧为 form；因此种子 mock 厂商没配 Key 的环境里，「换默认模型」从 direct 变成 form 卡（e2e 先给 mock 厂商补 Key 再测 direct）。
  8. **不可信内容判定范围（审查后改为可信白名单）**：方案列了网页 / 邮件 / 浏览器 / MCP / 连接应用 / 附件正文。实现改为**可信白名单**（`TRUSTED_TOOLS`）——不在白名单里的工具一律按不可信，含动态的 `mcp_*` / `app_*` 与未来新增的工具；`read` / `grep` / `ls` / `find`、历史消息、记忆、知识库、任务 / 子代理结果（`list_tasks`、`get_run`、`delegate_task` …）都算不可信；每个内置工具必须在可信或不可信集合里显式登记（单测强制）。以 `tool_call` 发生（而非 `tool_result`）即置位；触发批带附件时 run 一开始就算不可信。
  9. **「已经是想要的值」不出卡；任务 `required` 且已配好直接放行**：方案未写，避免无意义的卡和重复失败续跑。
  10. **`settings.cards.complete` 增核对语义**：link 卡 / 渲染层条目点「我已设置好」，core 能核对的核对一次（与建议值一致、已配置好、或字段与出卡时不同都算完成，卡上记实际值；未通过卡片保持 pending），渲染层 / 只读条目按用户所说标 applied；方案只写「改由用户点我已设置好」。
  11. **ACP 一律按不可信**：方案只说 ACP 默认不注入 `settings_change`。审查后决定：外部智能体执行的 run 从一开始就按读过不可信内容处理（它的原生工具不经宿主分类、会话跨 run 保留），开启 `settings:change` 也最多 confirm。
  12. **`required:true` 的限制**：方案只说走失败续跑链。实现里它不占每 run 出卡名额（不在消息流里出卡），但同样受按条目的 7 天拒绝退避约束——用户拒绝两次的项既不出卡、也不为它暂停任务。
  13. **应用与「不用了」的竞争（pending → applying 占位）**：`settings.items.apply` 带卡片时在写锁内、写之前再确认卡片仍是 pending，写后在同一同步关键区标 applied；被抢先「不用了」的应用报错且不写。带卡片时作用对象以卡为准。每 run 出卡名额在第一个 `await` 前同步占位，并行工具调用不超限。
  14. **写锁范围与等待上限**：锁只罩同步的读-合并-写，`settings.update` 的网络副作用在锁外；等锁上限 10 秒（`TIMEOUT`）。设置页整对象保存的既有覆盖问题不在 P0 解决，只靠回执卡撤销时的冲突报告兜底。
- 影响范围：design/38、`packages/shared/src/settings-catalog/*`、`packages/core/src/settings/*`、`tools/settings-tools.ts`、`features/settings-card/*`。
- 推荐 / 决定：以上均按现状保留；方案文档已就 P0 状态做了标注，设计篇 38 记录的是实际行为。
- 已更新的文档：`docs/design/38-conversational-settings.md`、`docs/design/README.md`（D89）、`docs/design/18-inline-setup.md`、`docs/design/02-execution.md`、`docs/design/30-supervisor-and-tasks.md`、`docs/dev/03-data-model.md`、`docs/dev/04-agent-runtime.md`、`todo/conversational-app-setup.md`。

### DEV-027 模型请求 session id 由原始对话 id 改为按安装派生的不透明值

- 状态：已落实
- 阶段：评审修复（f3126b7 / 8720d1e）
- 是否阻塞：否
- 问题：`f3126b7` 给每个模型请求附加 `kep-<conversationId>`（无对话回退 `kep-<runId>`），测试连接附加 `kep-provider-test:<provider>`，注释称「pi-ai 只发给 OpenCode、其它供应商忽略」。核对 pi-ai 1.0.2 源码，实际不只 OpenCode：OpenAI Responses 发 `session_id` / `x-client-request-id` 与 body `prompt_cache_key`；Azure Responses 发 `prompt_cache_key`；Mistral 发 `x-affinity` 与 `prompt_cache_key`；Chat Completions 对 OpenRouter 识别出的端点发 `x-session-id`，对地址含 `api.openai.com` 的端点（含代理）发 `prompt_cache_key`；Anthropic Messages 对 OpenRouter 发 `x-session-id`。原始内部 id 因此稳定地发给第三方，跨供应商可关联；且所有用途（对话轮、任务、摘要、记忆……）共用一个缓存键。
- 决定：保留 session id（OpenCode 必需，其余供应商的提示缓存有实际收益），但值改为 `kep-` + HMAC-SHA256 前 128 位（hex，共 36 字符，低于 OpenAI 64 字符上限）。密钥 `SecretsService.modelSessionKey()` 由每次安装随机、存在系统钥匙串里的主密钥按 HKDF 派生（`KEY_INFO.modelSession = 'model-session:v1'`），不新增存储。输入为供应商 id、锚点（对话 + Bot；无对话 = Bot；都没有 = run，每次新值）与用途（`loop` / `oneshot` + loopType）；测试连接为（`provider-test`，供应商 id）。不按供应商关闭：值不透明后，供应商能得到的只是「这些请求属于同一会话」，这从共享提示词前缀本来就看得出。
- 未做：系统提示词的 workspace 段含 `bots/<botId>/workspaces/<conversationId>` 路径，原始 id 仍随**提示词内容**到达供应商（模型需要这个路径）；集成测试的「不泄露」断言因此覆盖请求头、会话字段与正文里内容以外的字段，不含 messages / input / instructions / tools。
- 已更新的文档：`docs/dev/04-agent-runtime.md`（模型请求的 session id）。
- **集成复审后的补充（2026-10-14）**：
  - 深色前景取纯黑 `#000000`：用 `#0a0a0a` 时正文的保证对比度只有约 4.40:1，原先写的 4.58:1 不成立；现在对任意 `#rrggbb` 都满足图标 3:1、正文 4.5:1，测试按全部灰度级与 RGB 网格计算最坏情况。
  - 取不到 session 密钥（读取抛错或密钥短于 16 字节）时整条 session id 省略，不使用任何回退密钥，也不崩溃；供应商测试在没有密钥时不发 `x-session-id`，仍返回供应商自己的错误。
  - 输入框在布局或按键变化后（附件清空、发送 / 语音键切换、回复栏出现）在新布局里重测单行宽度；宽度估算抽成纯函数 `singleLineWidth`。

### DEV-028 权限审查修复：沙箱内命令自动放行与污点、只读白名单、中途权限卡的留痕（f2b9627 / ef2a565 补记）

- 状态：已落实（编号按当时最大号 + 1，合并时以最后一个空号为准）
- 阶段：权限 / 审批审查修复（t/fix-perms）
- 是否阻塞：否
- 问题：
  1. **f2b9627 没有记录**：外部智能体「每次确认」档（`ask`）在 Agent 确认 OS 沙箱时沙箱内命令自动放行（Claude 开 `autoAllowBashIfSandboxed`），扩充内置只读白名单并给已有安装补种。用户决定保留「沙箱内命令自动放行」。后果：Claude Code 自己放行沙箱内 Bash，宿主权限桥里的 D73 污点闸门对 Claude 永远到不了（workspace 档在 f2b9627 之前就已如此）；文档里「每次确认档仍对写入逐次确认」对沙箱内命令的写入不成立。
  2. **ef2a565 没有记录**：中途权限卡（access / command / mcp_tool / agent_tool / egress / git_remote / unsandboxed）不再进对话消息流。无人值守自动决定的卡从不进 dock，于是用户完全看不到；W4 回执行随之消失。
  3. 白名单的若干漏洞：pnpm / yarn / cargo / rustc / go 版本探测会经 corepack / rustup / GOTOOLCHAIN 按项目文件下载或执行工具链；`git branch` 前缀放过 `-qD`、`-f`、建分支等写法；豁免的 git 命令遵从 Bot 可写的仓库配置（fsmonitor、diff.external、filter …）；审批卡「加入白名单」会把 `bash -c …`、`curl …` 缩成裸程序；自定义条目在只读 run 与污点期间仍被豁免。
- 核对结果（claude-agent-acp 0.86.0、claude-agent-sdk 0.3.287 d.ts、Claude Code 2.1.x 二进制字符串）：
  - SDK 的 `sandbox` 只在 `query()` / `session/new` 读取；适配器只把 `applyFlagSettings` 用于模型 / effort / fastMode，ACP 没有中途改沙箱设置或权限规则的入口。
  - 沙箱网络并非不受限：不在 `network.allowedDomains`（我方未配置）里的主机，Claude Code 的代理以 `SandboxNetworkAccess`（ACP kind `other`、`rawInput.host`）逐主机询问宿主，批准后 `addSessionAllowedHost`——本会话内该主机不再询问。
- 决定：
  1. **污点外发控制开着时（默认）由宿主裁决沙箱内命令**：`hostGatesSandboxedExec` → Claude 会话 `autoAllowBashIfSandboxed: false`，每条 Bash 经权限桥；未污点时桥自动放行（`ask` / `workspace` 档的用户感受与 f2b9627 相同，且留下审计），污点期间逐条弹 `egress` 卡。控制关闭时与 f2b9627 一样由 Claude Code 放行。该项进 `_meta` → 会话指纹，开关切换后不复用旧会话。没有选「只在建会话时已污点才关」：污点来源（本 run 的应用工具、邮件、群里别的 Bot、委派继承）都可能在会话中途出现，而 SDK 设置改不了。
  2. 权限桥把 `SandboxNetworkAccess` 识别为联网：污点期间弹 `egress` 卡（覆盖污点出现前已在跑的命令的新连接），否则仍弹卡并写明批准对整个会话有效；只读档拒绝。
  3. **残留风险（不声称已防住）**：本会话里污点出现前批准过的主机，Claude Code 不再询问——污点出现前已在运行的命令连向这些主机时不弹卡（污点出现后发起的命令都会先弹外发卡）；「加载我的个人配置」时用户 Claude 配置的 `allowedDomains` / `WebFetch(domain:…)` 不经宿主；关闭污点控制即回到 f2b9627 行为。
  4. 内置白名单去掉 pnpm / yarn / cargo / rustc / go 探测并在升级时删除旧内置行（同文本自定义行保留）；内置集合由单测钉住形状与精确内容，新增需显式决定。node / npm / python / pip / tsc / eslint / prettier / ruby / php 的 `--version` 保留：它们解析全局程序、打印常量；豁免执行时 PATH 去掉相对项（不会解析到 `node_modules/.bin`），关闭 corepack / go / npm / pip 的网络与更新检查。版本管理器 shim（volta / asdf / pyenv）仍可能按工作目录里的版本文件选版本（volta 可能下载官方 node），不执行项目代码，未处理。
  5. 豁免 git：执行前 `git config --list --show-scope -z` 读仓库级（local / worktree）配置，有会执行程序的项或读取失败（含 git < 2.26）即改为弹卡；另加 `GIT_PAGER=cat`、`GIT_OPTIONAL_LOCKS=0`、`GIT_CONFIG_COUNT`（`core.fsmonitor=false`、`core.pager=cat`，git ≥ 2.31 生效）。**没有**设 `GIT_CONFIG_NOSYSTEM`：系统配置由管理员写、不归 Bot，且 Git for Windows / git-lfs 的系统级 filter 去掉后 `git status` 会给出错误结果；也没有给 diff/log/show 追加 `--no-ext-diff --no-textconv`（改写命令文本；仓库级驱动已由配置检查拦下，全局驱动是用户自己的）。文件工具写 `.git/config`、`.git/hooks/**`、`.git/info/attributes` 需要敏感授权（project 内先看租约）。
  6. `git branch` 只豁免列出；通用 git 危险参数里去掉 `-d/-D/-m/-M`（原先误伤 `git diff -M`、`git log -m`）。
  7. 自定义条目准入规则放在 shared（`allowlistPatternRefusal`），`AllowlistService.add` 与审批卡共用；自定义条目在只读 run 里不执行、污点期间改弹带污点标记的命令卡、不豁免沙箱联网命令的外发卡；外部智能体桥同样（只读档 / 污点期间不算）。
  8. 中途权限卡加 `record` 标记：无人值守自动决定的卡、`egress` 卡、payload 带 `tainted` 的卡在对话里留一行折叠记录（待决时仍只在 dock）；用户在 dock 里处理的普通权限卡维持 ef2a565 的不留痕，回执只在审计 / 台账。「策略自动批准」（MCP auto 策略、持续授权）不建审批行，本来就没有卡，未改。
  9. 新增内置条目在已有安装上默认启用（f2b9627 起）。「新增」标记需要新列或迁移，且设置页白名单组件不在本车道，未做。
- 影响范围：`packages/core/src/agent/external/{permission-bridge,engine,types}.ts`、`providers/claude.ts`、`start.ts`（一行接线）、`permissions/{allowlist,allowlist-match,git-config-risk,approvals}.ts`、`gateway/index.ts`、`sandbox/confirm-executor.ts`、`domain/messages.ts`、`packages/shared/src/{policy/allowlist-pattern,domain/types}.ts`、desktop `features/approvals/*`、`MessageList.svelte`、`zh-CN.ts`（权限 / 白名单文案）。
- 集成时已补改（原先留给其他车道的两处）：设置目录里 Bot 智能体档位的 `ask` 标签改为「编辑前确认（沙箱内命令自动）」，与 `contacts.agentPermissionAsk` 一致；`agent/context/system-prompt.ts` 的确认模式提示改为「命中白名单的命令无需确认（自定义条目在只读任务里仍不会执行，污点期间仍需确认）」。
- 已更新的文档：`docs/design/13-permissions.md`（档位表、白名单、回执、界面）、`10-sandbox.md`、`12-ui-layout.md`、`28-external-agents-acp.md`。
- **集成复审后的补充（2026-10-14）**：
  - 自定义白名单条目按「前缀之后还能接什么」判断：条目必须已经固定了要执行什么（具体脚本或子命令），固定部分不得含加载代码、联网或改配置的参数；只有选项的前缀（`python -u`、`node --no-warnings`、`npm --silent`）和 `-m` / `--import` / `--require` / `--loader` 等一律拒绝。参数决定一切的程序（awk、sed、tar、docker、podman、kubectl、gh、make、man、编辑器、DNS 工具）无论写成什么形式都拒绝；git 的 `config`、`submodule`、`rebase` 和联网子命令（`push` / `fetch` 等）也拒绝，**此前允许的 `git push` 自定义条目不再接受**。卡片默认建议整条命令。
  - 豁免的 git 命令执行前先问 git 要读哪个仓库：git 目录、common 目录和所有 alternates 对象目录都必须通过读权限检查，否则改为普通确认卡；解析失败也退回确认卡。文件工具写 `.git` 指针文件、`commondir`、`worktrees/<n>/gitdir`、`objects/info/alternates`、子模块的 `info/attributes` / config / hooks 需要授权。子模块递归被阻止。
  - 仓库配置检查只看这些只读命令真正会执行的键：`core.fsmonitor`、`diff.external`、diff textconv / command、`filter.*`、`include` / `includeIf`、`core.worktree`、`gpg.program`。去掉了 `core.hooksPath`、`core.editor`、`sequence.editor`、`core.sshCommand`、merge driver、`core.pager` / `pager.*`（husky 等工具会在本地设置 hooksPath，导致每条 `git status` 都弹卡；无终端时不会启动分页器）。检查改为异步 spawn，超时即杀。
  - git 用清洗后 PATH 解析出的绝对路径运行（排除工作区与项目目录），Windows 设置 `NoDefaultCurrentDirectoryInExePath=1`，PowerShell 也用绝对路径启动。豁免命令的 PATH 去掉位于工作区 / 项目里的条目并设置 `VOLTA_BYPASS=1`；pyenv / rbenv / asdf 的垫片只选择已安装版本、不执行项目代码，只做记录不拦截。
  - `git branch` 的参数按 git 自己的规则吃掉取值（`--format -l evil` 在 git 2.34 里会把 `-l` 当作 `--format` 的值并创建分支 `evil`），「只是列出」在取值之后才判定；`git branch -l evil` 是按模式列出，不创建。
  - 折叠记录只在批准项确知仍待决时才隐藏，批准列表上限 200 条之外的旧记录照常显示。
  - **剩余风险**：检查与执行之间，由用户批准的并行沙箱外命令可能改了仓库配置或新增过滤器；已知并记录。

### DEV-029 对话内应用设置合并后审查修复的取舍（D89）

- 状态：已落实
- 阶段：D89 P0 + P1 合并后审查修复（`t/fix-settings`）
- 是否阻塞：否
- 问题与决定：
  1. **过期整表单保存（P0 遗留，§8.3）选三方合并，不选乐观并发版本号**：`settings.update` / `bots.update` 增可选 `base`，core 在写锁里用 `mergeThreeWay` 与最新值合并。设置页与右栏 Profile 都是自动保存，版本号冲突会让每次并发都弹错；三方合并只在两边改了同一字段时需要取舍（以这次保存为准——那是用户刚亲手改的值）。按 id 寻址的数组按条合并。不带 `base` 的调用方保持整份覆盖：右栏以外直接调 `bots.update` 的入口（失败续跑卡、连接授权卡、侧栏对话框、头像）都是「读当前 → 改一处 → 立刻保存」，窗口极短，未改。
  2. **仍由组件调用原 RPC 保存（不经宿主写锁 / CAS）的条目**，审查后逐项核对，它们都不是整表快照提交：
     - `connections.tool-policy`：`apps.connections.setToolPolicy` 同步改一条工具的策略行（不写 settings），策略变严时中断任务；卡片保存的是用户亲手选的档位，无快照可过期。
     - `browser.shared-profiles`：`browserProfiles.create` 在服务里同步读当前列表再追加一条，不会覆盖别处的新建。
     - `group.members`：`groups.addMembers` / `groups.removeMember` 按 Bot 增删（移出是异步级联，不能放进写锁）；卡片改为只提交用户亲手勾 / 不勾的差异（`group-members.ts`），卡片挂着时别处新加的成员不会被移出。原实现按挂载时的成员快照算差异，会把之后加进来的 Bot 移出——这是真问题，已修。
     - 项目两项、`unattended.enable`、环境三项：user-only，保存与风险确认留在组件里，宿主不写。
     - `mcp.servers` **原来是**从渲染层缓存整表提交 `settings.update`（会把并发修改覆盖回去）——改为宿主写入适配器（写锁里读最新列表、CAS、只改 `enabled`，锁外 `mcpRevocationsBetween`）。
  3. **适配器写入的锁外收尾**：`ItemAdapter.write` 仍是同步的，需要 await 的副作用（中断任务、关浏览器页面、收回授权）以 `afterUnlock` 返回，宿主释放写锁后执行；副作用失败只记日志，不把已完成的写入报成失败（与 `bots.update` RPC 原来的行为一致）。
  4. **`environment.allowlist` 状态恒为 `unknown`**：没有能说明「Bot 要的那条命令是否免审批」的状态，`configured` 会让 required 直接放行、核对直接通过。代价：用户点「我已设置好」时无法核对，按用户所说结卡（与渲染层条目相同）。没有给白名单加任何写入路径。
  5. **`bot.skills` 拒绝公共技能**，没有做「按 Bot 覆盖公共技能」：注册表没有这种行，新增它要动技能的数据模型。
  6. **自动核对（`settings.cards.complete{auto}`）只认「变过」**：值不同；值为 null 的概要类条目看概要变了且现在不是未配置 / 部分可用。手动「我已设置好」的核对也加了概要变化这一条（此前值为 null 的条目只能靠 `configured`）。
  7. **`general.language` 改为静态选项**（目录写死 `zh-CN`），core 按它校验；渲染层 `localeOptions` 加语言时同步目录，desktop 单测核对两边一致。
- 影响范围：`packages/shared/src/settings-catalog/{merge,validate,items}.ts`、`rpc/methods.ts`、`domain/types.ts`；`packages/core/src/settings/*`、`rpc/{bindings,settings-bindings}.ts`、`start.ts`（设置目录宿主的装配）；desktop `features/settings-card/*`、`McpSection`、`AppearanceSection`、`GroupSettingsDialog`、`RightPanel` 的保存、`stores/{settings,contacts}`。
- 已更新的文档：`docs/design/38-conversational-settings.md`（§1.4 / §1.5 / §4 / §11）、`todo/conversational-app-setup.md`（§8.2 / §8.3 / §8.6）、`docs/dev/PROGRESS.md`。
- **集成复审后的补充（2026-10-14）**：
  - MCP 编辑框只保存真正改过的字段：编辑开始时记下初始副本，保存时取当前服务、只套用与初始副本不同的字段，`enabled`、`autoApprove`、`toolPolicies` 始终取当前值（编辑框没有这些控件）；编辑期间服务在别处被删除则报错、不重建。长期存在的草稿必须自己记录打开时的快照。
  - 写后收尾：先撤销授权（MCP、连接），再关浏览器页；每一步各自 try/catch，`settle()` 不抛错、返回失败列表由调用方记日志；宿主写入发生后 `afterUnlock` 放在 `finally` 里，失败只记日志、不当作写入失败。
  - 三方合并 `mergeThreeWay` / `mergePatchOnto` 只读写自有键，`__proto__` / `constructor` 当普通键处理。
  - `settings.cards.complete{auto}` 只在卡片要的事做成时关闭：有建议值的卡要求当前值满足建议值；放宽权限的 user-only 卡没有建议值时，只在放宽方向的变化上关闭。**偏保守**：Bot 想收紧一个会放宽权限的条目（例如把污点保护重新打开）时，卡不会自动关闭，用户点「我已设置好」即可。

### DEV-030 UI 新建的群没有群定位与目录：建群后在哪里设置（`0254e1b`）

- 状态：已落实（2026-10-18，随 D92 项目组实施）
- 阶段：新建群聊改版（2026-10-15，`0254e1b`；取代设计 19 / D60 的对话内四问）
- 是否阻塞：否
- 问题：新建群改为主区域顶部点选成员、空回车即 `groups.create` 直接建群（群名为成员名拼接）后，创建时不再收集「本群主要处理什么事务」与工作目录。UI 新建的群 `description` 恒为空，`<conversation_info>` 的「本群主要处理：…」（D60）不会注入，群内 Bot 判断「归不归我」只剩成员名片与群名可依据。目录可在右栏「群详情」的 project 选择器补绑（无创建期引导）；群定位**没有任何编辑入口**，也没有对应的 RPC（`description` 只在 `groups.setup.answer` 里写）。D60 的后端（`groups.setup.*`、orchestrator 四问、`GroupSetupCard`、store 的 `createGroupViaSetup` / `answerGroupSetup` / `cancelGroupSetup`）保留但 UI 不可达。
- 影响范围：群聊响应质量（`<conversation_info>`）、设计 19 / 01 / 08、右栏 `GroupInfo`、core `groups` / `conversations`。
- 可选方案：
  1. 群详情加「群定位」文本框（新增 `groups.update` 一类 RPC 写 `description`），目录继续在群详情绑定 — 改动小、与改名 / 加减成员同处；缺点是用户不一定会去填。
  2. 建群后在群对话里出一张一次性提示卡（定位 + 目录，可跳过），复用 `GroupSetupCard` 的 purpose / project 两步 — 有引导；缺点是又回到部分向导，和「点选即建」的初衷有张力。
  3. 不做，群定位让 Bot 从群名与历史推断，并删除 D60 后端 — 最简；缺点是丢掉已验证有用的群语义，且要删除 D60 的代码路径（`description` 列可保留为空，不需要迁移）。
- 推荐：1（必要时叠加 2 的轻提示）；在决定前保留 D60 后端不删。
- 决定：采纳方案 1 的 D92 形态——「**详情页编辑项目目标**」：`conversations.description` 随 T1a 改名 `goal`（项目目标），经 `projects.update` 在**项目详情页「概览」**编辑（WP1 落 RPC、WP4 落设置目录条目 `project.goal` 与提示词注入、WP7 落详情页编辑器）；非空才注入 `<conversation_info>`。D60 的四问后端已整体删除（方案 3 的删除部分随之完成）。目录绑定同样落详情页「概览」。
- 已更新的文档：`docs/design/41-project-team.md`（§11.3 / §18 / DEV-030 引用）、`docs/design/01-conversation.md`、`docs/design/19-work-path-and-group-setup.md`、`docs/design/08-workdir.md`、`docs/design/12-ui-layout.md`、`docs/design/README.md`（D60 / D92 行）；历史类文档（`docs/dev/phases/P16`、`todo/conversation-work-path.md`）正文不动。

### DEV-031 WP3 的 `forcedTarget`「工作台派发用」前提与代码现实不符

- 状态：已落实
- 阶段：项目组 T1a（WP3，2026-10-17）
- 是否阻塞：否
- 问题：[WP3-routing.md](../../todo/project/WP3-routing.md) §1 流程图、§5 步骤 5 与 §8 陷阱都说 `PendingBatch.forcedTarget` 「保留（工作台派发还在用，只删 `redistribute` 方法）」。代码现实：自 WP1 起 `dispatchWorkbenchMessage` 用**结构化 @**（`mentions: [leadBotId]`，见 todo-service `#dispatch` 的 `leadBotId` 入参）指定目标，`forcedTarget` 在 HEAD 上唯一的入口是被删除的 `groups.redistribute`（group_no_claim 点选重发）。删除 `redistribute` 后，`forcedTarget` 分支在生产代码中已无调用方。
- 影响范围：`packages/core/src/dispatch/project-turn.ts`（`PendingBatch.forcedTarget`、`#dispatch` 首分支）、`dispatchWorkbenchMessage`。
- 处理：按 WP 字面要求**保留** `forcedTarget` 分支（工作台「指定负责 Bot」语义的快路径，行为与结构化 @ 等价），并给 `onUserBatch` 增加可选 `options.forcedTarget` 入参使 WP §5 场景 b（forcedTarget 优先）可测；`dispatchWorkbenchMessage` 维持结构化 @ 路径不变（零行为漂移）。后续若工作台派发要绕开显式 @ 语义，可改传 `forcedTarget`（WP8/WP4 一并评估）。
- 已更新的文档：`todo/project/WP3-routing.md`（实施记录）。

### DEV-032 项目 wiki（WP9）验收自检 rg#1 非空：`enqueueIngest` 的执行者字段与旧 RPC 入参形态同形（D92 T1b）

- 状态：已按 WP 语义收口（自检解读，非代码缺陷）
- 阶段：群聊→项目组 WP9（`feat/project/wp9-wiki-core`）
- 是否阻塞：否
- 问题：WP9 验收清单要求 `rg -n "wikiBotIdInputSchema|storeFor\(botId|botWikiRoot\(deps|botId: input\.botId" packages/core/src/wiki packages/core/src/rpc` 为空，但 WP §2/§3 同时规定 `enqueueIngest({ owner, botId, … })` 保留 `botId` 为**执行者**字段（成员入库记在该成员名下）。该服务层入参（`wiki/service.ts` 的 `botId: input.botId`）与自检模式同形，自检按字面不可能为空。另有两处同形命中均为预期：`wiki/ingest.ts` 的 `resolveSource` 内部 identity（执行者传给 gateway 的自有入参，非旧 RPC 形态残留）、`rpc/bindings.ts` 的 `skills.import`（非 wiki 方法）。
- 影响范围：仅验收自检的解读；`wiki_ingest:${wikiOwnerKey(owner)}:…` 去重键、payload `owner`、RPC `wikiOwnerInputSchema` 均已按新形态落地（自检 rg#2 为空）。
- 处理：自检按「无旧形态残留」解读——rg#1 的三处命中逐一核对为 WP 明文保留的执行者字段或无关方法；`wikiBotIdInputSchema`、`storeFor(botId`、`botWikiRoot(deps` 在 wiki/ 与 rpc/ 下均为零命中。
- 决定：（由人工确认）
- 已更新的文档：`todo/project/WP9-wiki-core.md` §9 实施记录。

### DEV-033 WP4 验收自检 rg#1 无法按字面清零：四处命中均为 WP7/WP8 待办或迁移夹具（D92 T1a）

- 状态：已按 WP 语义收口（自检解读 + 临时处理登记）
- 阶段：群聊→项目组 WP4（`feat/project/migration`）
- 是否阻塞：否
- 问题：WP4 验收清单要求 `rg -n "propose_team|propose_group|BUTLER_TEAM_SIZE|assignee_group_id|listByAssigneeGroup|group_id|group-title|group-members|group-dialog|groups\.delete|isGroup" packages apps` 全空（允许项仅 query-gate 与 items.ts 的 `group:` 分类字段），但四处命中在 WP4 的范围内无法消除：
  1. `GroupSettingsDialog.svelte` 的 `data-settings-anchor="group-title"` / `"group-members"` 与 `anchor-scroll.test.ts` 夹具——该对话框 WP7 才删除；若现在改成 `project-*` 会撞上 `PENDING_DESKTOP_ANCHORS`（覆盖率测试断言「列在 pending 里的锚点确实还不存在」）。
  2. `ApprovalCard.svelte` 的 `approval-butler-group-title` / `-members` testid——WP4 §3.B.4 明文「审批卡只做编译修复」，文案与卡上改负责人的 UI 归 WP8。
  3. `test/fixtures/connectors/linear.tools.json` 的 `isGroup`——Linear 连接器的外部 API 字段（WP0-2 已确立连接器夹具不改的先例）。
  4. `workbench-project.test.ts` 的 0042 迁移夹具——迁移测试必须用旧列名 `assignee_group_id` 造数（与 main 0040 迁移测试同形）。
- 影响范围：仅验收自检的解读；core / shared 源码内旧名（`propose_team`、`proposalType: 'group'`、`assignee_group_id`、`GROUP_MENTION_PREFIX`、`isGroup`、`origin: 'group'` 等）均已清零（rg#2、rg#3 为空）。
- 处理：rg#1 剩余 13 处逐一核对为上述四类；`tool-labels.ts` 的 `propose_team` 键、`group-members.ts` 文件名等渲染层可安全改名处已在本 WP 内一并改掉。
- 决定：（由人工确认）
- 已更新的文档：`todo/project/WP4-prompt-and-integrations.md` §8 实施记录。
### DEV-034 WP5 创建自检 rg 非空：命中的全部是 WP5 §5 明令留下的两个 e2e 旧名文件（D92 T1a）

- 状态：已按 WP 语义收口（自检解读，非代码缺陷）
- 阶段：群聊→项目组 WP5（`feat/project/wp5-ui-create`，2026-10-17）
- 是否阻塞：否
- 问题：WP5 验收清单要求 `rg -n "composingGroup|beginGroupCompose|cancelGroupCompose|commitGroupCompose|GroupComposeBar|group-compose|groupCompose\.|sidebar\.createGroup|start-chat-create-group|WP5 replaces" apps/desktop -g '!node_modules' -g '!**/dist/**' -g '!test/**'` 自检为空，但 rg 的 glob 语义里 `!test/**` 只匹配仓库根下的 `test/**`，排除不了 `apps/desktop/test/e2e/`；而 WP5 §5 又明确规定 `group-compose.spec.ts` 与 `helpers/create-group.ts` 不改、留到 WP8 统一重写。二者叠加使该自检按字面永远非空（现行命中 16 处，全部在这两个文件）。
- 影响范围：仅验收自检的解读；renderer / store / i18n 源码（`apps/desktop/src`）对该模式为零命中，两个 e2e 文件本 WP 未触碰。
- 处理：自检按「`apps/desktop/src` 与其余非 e2e 路径无旧名残留」解读执行；e2e 两个文件的旧名属 WP5 §5 明令保留，WP8 重写时消除。
- 决定：（由人工确认）
- 已更新的文档：`todo/project/WP5-ui-create.md` §9 实施记录。

### DEV-035 WP7 步骤 6 的 `git mv group-members.* → project-members.*` 无从执行：文件已在前序 WP（WP4）改名（D92 T1a）

- 状态：已落实（审查补记）
- 阶段：群聊→项目组 WP7（`feat/project/migration`，`f6c747d`，2026-10-18）
- 是否阻塞：否
- 问题：WP7 §4 步骤 6 要求 `group-members.ts` / `group-members.test.ts` → `project-members.ts` / `project-members.test.ts` 以 `git mv` + 改名完成；但 WP4（`e7013fa`，见 DEV-033 处理段）已把这两个文件改名到位，只剩导出名 `groupMemberPlan` / `GroupMemberPlan` 是旧名，`git mv` 无从执行。
- 影响范围：仅步骤 6 的执行方式；§4 契约的最终命名（`projectMemberPlan` / `ProjectMemberPlan`、文件名、测试断言不变）全部达成。
- 处理：改为独立提交 `f6c747d` 完成**导出名纯改名**（无任何行为改动，符合 README §1.5「纯改名独立提交」）；WP7 §9 实施记录已登记该落地决定，本条补齐 §1.6 要求的 DEVIATIONS 登记。
- 决定：（由人工确认）
- 已更新的文档：`todo/project/WP7-ui-settings-page.md` §9 实施记录（提交列表与偏差段）。

### DEV-036 WP8 步骤 5 表 ① 要求断言路由阶段状态行，但 WP6 落地的可见性条件使该阶段永不显示：随断言修复了组件行为（审查补记）

- 状态：已落实（审查补记）
- 阶段：群聊→项目组 WP8（`feat/project/migration`，`c6b15b6`，2026-10-18）
- 是否阻塞：否
- 问题：WP8 §4 步骤 5 表 ① 要求断言 `project-turn-status` 在路由阶段可见且文案「正在确认由谁回复」；但 WP6 落地的 `ProjectTurnStatusLine` 可见性条件 `phase!=='idle' && (currentBotId!==null || queue.length>0)` 与 WP3 的 `project.turn` 载荷矛盾——路由阶段恰是 `currentBotId=null`、`queue=[]`（`dispatch/project-turn.ts` 载荷构造），状态行在路由阶段永不渲染。属 README §1.6「WP 假设与代码现实不成立」。
- 影响范围：仅该组件的可见性行为；无命名 / 契约 / 后端变化。
- 处理：`c6b15b6` 把条件改为「routing 阶段恒显示；运行阶段至少一个目标（当前或排队）才显示」，e2e 断言按 WP 表落实；WP8 §8 已登记该落地决定，本条补齐 §1.6 要求的 DEVIATIONS 登记。
- 决定：（由人工确认）
- 已更新的文档：`todo/project/WP8-ui-copy-e2e.md` §8 实施记录。

### DEV-037 设计 41 §6.3 的触发段属性 `routed_by` 未实现：路由留痕 = 触发原因 + 段末宿主说明 + 网关 `reason`（审查补记）

- 状态：已落实（审查补记：文档按现状修正，不补实现）
- 阶段：群聊→项目组 WP11 阶段审查（2026-10-18；分歧产生于 WP3 实现）
- 是否阻塞：否
- 问题：设计 41 §6.3（定稿时）写「路由留痕在执行记录里：触发原因 `routed`、`routed_by`、网关的 `reason`」，即 `routed` / `routed_also` 的 `<trigger>` 段带 `routed_by`（负责人 bot id）属性。实现（WP3，`dispatch/project-turn.ts`）的静默路由投递批只带 `{botId, reason}`（`routed_also` 另有段后纯文本 `afterNote`「在你之前，{名字}已经回复…」），触发段**没有**任何负责人属性；全仓无 `routed_by`。WP3 实施记录未登记该取舍，WP11 改写 `docs/dev/04-agent-runtime.md` 触发原因表时照抄了设计里的属性，审查对照代码发现。
- 影响范围：仅文档与审计口径；无契约 / 行为变化。负责人身份实际可从网关那次轻量调用的 run（`trigger_reason='routing_gate'`，其 bot 即负责人）与成员名片推得。
- 处理：不补实现——该属性对模型提示与用户界面均不可见，审计已可推得，后补属性会动 `TriggerBatch` / 触发段形状，收益为零。文档按现状修正：`docs/dev/04-agent-runtime.md` 触发原因表 `routed` / `routed_also` 行「附加属性」改 `—`（顺带补 `bot_mention` 实际带的 `hop`）、提示词段表 7.5 行按实现修正为 `<project_lead_rules>` / `<project_member_rules>`（成员段是 `agent/context/system-prompt.ts` 的函数 `projectMemberRules(leadName)`，不是常量）；`docs/design/41-project-team.md` §6.3 留痕句同步。
- 决定：（由人工确认）
- 已更新的文档：`docs/dev/04-agent-runtime.md`、`docs/design/41-project-team.md`（见「处理」）。

### DEV-038 设计 29 §8.3 的污点外发「逐次确认、只有允许一次」按用户决定放宽：egress 卡提供对话级放行时长（本功能迭代，2026-10-19）

- 状态：已落实
- 阶段：连接应用 P2 后续迭代（用户报告高频确认负担）
- 是否阻塞：否
- 问题：design 29 §8.3 规定污点期间外发「每次确认」、`egress` 卡只有「允许一次 / 拒绝」（`decide()` 把更长时长降为 once；`03-data-model.md` 同口径）。实际使用中重复的外发动作（如反复跑同一条测试命令）逐次弹卡，用户要求增加「始终允许」式的放宽。这与设计的防注入初衷（放行后的命令可能把污点数据带出去）相悖，属安全取舍，不能静默更改。
- 影响范围：`egress` 审批（payload 增 `durations`，`decide()` 接受 `conversation` / bash 的 `command`）、网关 `egressCheck`（出卡前查放行、批准后写放行）、`TaintService`（`egress_allows` 表与 `allowEgress` / `egressAllowed`，`mark` 与对话删除清行）、shared 类型、渲染端 `ApprovalCard` 的 egress 时长选择与文案；迁移 `0043_egress_allow.sql`。带污点标记的 `mcp_tool` / `command` / `git_remote` 卡与无人值守审计口径不变（被放行免卡的调用不再产生 `egress` 审批 / `egress_tainted` 审计）。
- 处理：按用户拍板「两个都要」落实——bash 通道三档（仅这一次 / 本对话内相同命令 / 本对话内一直允许）、其余通道两档；放行按对话计、有效期不超过批准时刻的污点窗口，污点被新的应用读取置位 / 续期时清空放行并重新出卡（一次「一直允许」至多放行一个污点窗口）。安全边界收窄为「用户逐窗口确认」，总开关 `taintGuard` 维持不变。
- 决定：（由人工确认）
- 已更新的文档：`docs/design/29-connected-apps.md` §8.3 后续修订注、`docs/dev/03-data-model.md`（`egress` payload 与 `egress_allows`）、`docs/dev/04-agent-runtime.md`（污点外发段）、`docs/dev/05-testing.md` 用例计数。

### DEV-039 中途权限卡通知改为内存态：不写 messages 表、不进 Bot 上下文（用户决定，2026-10-19）

- 状态：已落实
- 阶段：日常使用反馈（用户发现权限申请记录通知长期留在对话流里，既污染 Bot 预读上下文，切换对话 / 重启后仍然可见）
- 是否阻塞：否
- 问题：与既定设计相悖——ef2a565 与 2026-10-18 前的口径是：中途权限卡（access / unsandboxed / command / git_remote / mcp_tool / agent_tool / egress）的消息行**仍写入** `messages` 表（`record` 折叠记录随对话留痕），且「the message row still feeds the bot's context」（`packages/shared/src/domain/types.ts` 原注释）。用户拍板改为相反的产品决策：这类通知只是用户操作时留在当前界面的内存态提示，不持久化、不进 Bot 取数（listForBot / listShared / around），切换对话或重启应用后自然消失。
- 影响范围：`ApprovalsService.#insertCard`（ephemeral kinds 改走 `MessagesService.appendEphemeralCard`——只推进 `conversations.last_seq`、不发消息行，仍发 `message.created` 事件；`approvals.message_id` 不再回链，approval 行照旧持久化以支撑待确认流与审计）；`MessagesService`（`listVisible` / `isVisibleToUser` / `listForBot` / `listShared` / `around` 全部排除该类卡，旧版本存量的 `record` 行也一并从读取路径消失；`userVisibleFilter` 去掉 record 例外）；`#insertCard` 保持 record 标记计算，渲染端（`chat.svelte.ts` ingest、`transcript-visibility`）无需改动即保持「pending 在 dock、决定后当前会话折叠一行」的会话内行为。
- 处理：按上述落实。设计文档同步改写：`docs/design/12-ui-layout.md` 焦点三、`docs/design/13-permissions.md`（执行回执、无人值守、界面节）、`docs/dev/03-data-model.md` `approvals.message_id` 注释；`packages/shared/src/domain/types.ts` 类型注释与集成测试口径（`approvals.test.ts` 三处、`messages-visible.test.ts`）更新。
- 决定：（由人工确认）
- 已更新的文档：`docs/design/12-ui-layout.md`、`docs/design/13-permissions.md`、`docs/dev/03-data-model.md`。

### DEV-040 项目组进通讯录 + 「从对话列表移除」改为归档（可恢复），物理删除收口到危险区（用户决定，2026-10-21）

- 状态：已落实
- 阶段：日常使用反馈（用户发现应用内创建的项目组不在通讯录里，从对话列表移除时是物理删除——消息、执行记录、附件、workspace 与项目 wiki 目录一并删掉，无法恢复）
- 是否阻塞：否
- 问题：与既定设计相悖——`docs/design/01-conversation.md` 原口径是「删除对话是物理删除」，通讯录只是 `status='active'` 的 Bot 名册，项目组没有独立聚合（就是一行 `conversations`），因此天然不在通讯录里，移除即不可逆。用户拍板改为：项目组也进通讯录；从对话列表移除一律改为归档（软删，可恢复），物理删除只保留在项目详情页「危险区」；单聊同样归档化。
- 影响范围：`conversations` 新增 `archived_at` 列（迁移 0045）；`ConversationsService`（`listVisible` 列表口径、`setArchived` 归档/恢复、`openDirect` 命中已归档直聊时先恢复它——一个 Bot 仍只有一个对话，历史延续）；新增 RPC `conversations.archive / unarchive / all`（`all` = 通讯录名册，含归档会话）；渲染层 `contacts.svelte.ts` 增会话名册与项目组一栏、`ContactsSection.svelte` 改「Bot / 项目组」两栏（含「已从对话列表移除」标记与恢复入口）、侧栏右键改「从对话列表移除」（管家聊天例外：物理删除后即刻重开一个空的）；左栏分组归属与置顶在归档期间保留，恢复后回原位。
- 处理：按上述落实。归档不做任何级联：定时任务、监看与项目 wiki 继续存在（会话只是从列表里消失）；彻底删除仍是 `conversations.delete`，入口在项目详情页「危险区」。
- 决定：（由人工确认）
- 已更新的文档：`docs/design/01-conversation.md`、`docs/design/41-project-team.md`、`docs/dev/03-data-model.md`、`packages/shared/src/settings-catalog/coverage.ts`（`conversations.archive / unarchive` 登记为对象管理动作，不是设置）。

### DEV-041 Pi 1.4.0 升级把 `packages/app-validator` 的 `pi-mcp` 一并升到 1.4.0（超出任务书 §4.1 的四个包清单）

- 状态：已落实
- 阶段：Pi Agent 1.4.0 升级（2026-10-22）
- 是否阻塞：否
- 问题：[todo/pi-1.4-upgrade.md](../../todo/pi-1.4-upgrade.md) §4.1 只要求改 `packages/core/package.json` 的四个 pi 包，并写明「只改这四个依赖」；但该任务的验收标准同时要求 `pnpm-lock.yaml` 中无 `@earendil-works/pi-*@1.0.2` 残留。`packages/app-validator` 另有一条 `@earendil-works/pi-mcp: 1.0.2` 直连依赖，只改 core 会留下 1.0.2 实例，无法同时满足两条要求。
- 影响范围：`packages/app-validator/package.json`（`pi-mcp` 1.0.2 → 1.4.0）与 lockfile；校验器代码只使用 `McpFetch`、`McpClient`、OAuth 低层函数等 1.4.0 仍存在的导出，无代码改动。
- 处理：按验收标准把 app-validator 的 `pi-mcp` 同步到 1.4.0；`pnpm --filter @kepcup/app-validator run typecheck` 通过，全量测试通过。
- 决定：（由人工确认）
- 已更新的文档：`docs/dev/PROGRESS.md`「Pi Agent 1.4.0 升级」。

### DEV-042 Pi 1.4.0 的 `createModels()` identity 保持默认（未声明 KepCup 身份）

- 状态：待决定
- 阶段：Pi Agent 1.4.0 升级（2026-10-22）
- 是否阻塞：否
- 问题：pi-ai 1.4 的 `createModels()` 支持 `identity`（`userAgent` / `attribution`）；不设置时按上游默认以 pi 身份发送 User-Agent / attribution。任务书 §4.7 把它列为可选产品决定，不是升级阻塞项。
- 影响范围：`packages/core/src/agent/models.ts`；只影响模型请求的 User-Agent / attribution，不影响鉴权、路由与功能。
- 可选方案：
  1. 保持默认（当前实现）— 优点：升级范围最小、与上游行为一致；缺点：请求身份显示为 pi，而不是 KepCup。
  2. 显式声明 `identity: { attribution: { name: 'KepCup', url: 'https://kepcup.app' } }`（`userAgent` 是否用 `detailed` 另行决定）— 优点：身份清晰、便于供应商侧识别与审计；缺点：属于产品/隐私口径变更，需要单独评审并补请求头测试。
- 推荐：方案 2 作为后续产品决定；本次升级不扩大范围，保持现状。
- 决定：（由人工填写）
- 已更新的文档：`docs/dev/PROGRESS.md`。

### DEV-043 `wrapPiTool` 未向 pi 的 `read` 传 `ctx.model`：图片 resize / 非视觉提示使用上游 fallback（P2）

- 状态：待决定
- 阶段：Pi Agent 1.4.0 升级（2026-10-22）
- 是否阻塞：否
- 问题：pi-coding-agent 1.4 的 `read` 会使用 `ctx.model.inputLimits` 做图片 resize，并据此决定是否加 `getNonVisionImageNote`；本地 `wrapPiTool` 调用 `def.execute(..., { cwd })` 时没有传 `model`，因此走 fallback resize，非视觉提示可能不触发。任务书 §11.3 明确这不阻塞升级，先记录为 P2。
- 影响范围：`packages/core/src/tools/coding-tools.ts` 的 `WrapOptions` / 工具 `ctx`；当前引擎仍会按模型 `input` 能力决定是否发送 `ToolResult.images`，text-only 模型会收到 `SCREENSHOT_OMITTED_NOTE` 降级说明，功能不回退。
- 可选方案：
  1. 维持现状（fallback resize）— 优点：不改包装层接口；缺点：图片体积限制与非视觉提示不够精确。
  2. 扩展 `WrapOptions` / `PiToolLike.execute` 的 ctx 传入当前 `model`（含 `inputLimits`）— 优点：按模型精确 resize、提示准确；缺点：需要把模型信息从引擎贯通到每个编码工具，改动面扩大，需单独任务验证。
- 推荐：方案 2 作为后续 P2；本轮保持方案 1。
- 决定：（由人工填写）
- 已更新的文档：`docs/dev/PROGRESS.md`。

### DEV-044 本地 SSE 传输把「发送中取消」合并进 fetch signal，中断在途 POST（偏离 pi-mcp 上游）

- 状态：已落实
- 阶段：Pi Agent 1.4.0 升级 P3 加固（2026-10-22）
- 是否阻塞：否
- 问题：pi-mcp 1.4.0 的 `McpTransport.send` 增加可选 `signal`（「发送方不再等待回复时中止；传输不得在其后派发该消息，但不撤销已派发的消息」）。上游 `streamable-http` 传输的实现是：**fetch 只挂共享 `controller.signal`**，per-request `signal` 仅在每次派发（含授权刷新后的重试）前检查 `aborted`，**不中断在途 POST**。KepCup 自带的旧版「HTTP with SSE」传输（`packages/core/src/mcp/sse-transport.ts`，pi-mcp 未内置）把本次 dispatch 的 `signal` 与 `controller.signal` 经 `AbortSignal.any` 合并传给 fetch——取消或 `close()` 都会立刻掐断在途 POST。这是有意偏离：旧协议的响应经共享 SSE 流异步送达（POST 本身只拿 202），被放弃的在途 POST 继续占着连接没有任何收益；合并后 `close()` 也能收掉在途 dispatch。与上游相同点：中断不承诺撤回服务端可能已收到的消息（上层 ledger 按 uncertain 记账），取消只影响本次 dispatch、不关闭 transport（不误触发重连）。预派发检查顺序已对齐上游（连接态先于取消态：closed 优先抛 `McpConnectionClosedError`）。
- 影响范围：`packages/core/src/mcp/sse-transport.ts`（`send` 的 signal 合并与检查顺序，签名改用 pi-mcp 导出的 `McpTransportSendOptions`）、`packages/core/test/unit/sse-transport.test.ts`（in-flight 取消 / close() 中断两腿各有用例）。
- 可选方案：
  1. 维持合并（当前实现）— 优点：取消 / 关闭即时释放连接与资源，close() 收口完整；缺点：与上游 streamable-http 的行为不同，升级 pi-mcp 时需重读差异（代码注释已点名）。
  2. 完全对齐上游（fetch 只挂 controller.signal，signal 仅做派发前检查）— 优点：与上游零差异；缺点：被放弃的 POST 占连接到自然结束，close() 对在途 dispatch 无能为力，旧协议下无收益。
- 推荐：方案 1（当前实现）。
- 决定：（由人工确认）
- 已更新的文档：`docs/dev/PROGRESS.md`（Pi Agent 1.4.0 升级 P3 加固）。

### DEV-045 看板阶段一不登记 `board.cards.reject`

- 状态：已落实
- 阶段：项目看板 P1（D103）
- 是否阻塞：否
- 问题：设计 50 §10 的 RPC 表把 `board.cards.reject { cardId, note }` 标为 P1（退回追问）。阶段文件 [P1-board-skeleton.md](../../todo/project-board/P1-board-skeleton.md) 与 [README §4.2](../../todo/project-board/README.md) 明确它属于 backlog，本次不得加入 schema、`APP_METHODS` 或处理函数。阶段文件更晚、更具体，按其执行。
- 影响范围：`packages/shared/src/rpc/methods.ts` 的 `board.*` 清单不含 `reject`；P3 弹框的「退回追问」仍未接线。
- 可选方案：
  1. 按阶段文件，不定义、不注册 `board.cards.reject` — 优点：与任务书一致，避免半套执行接口；缺点：与设计 50 §10 的表差这一行。
  2. 只加 schema、不注册处理函数 — 优点：契约一次写全；缺点：阶段文件写明不要加。
- 推荐：方案 1（当前实现）。
- 决定：（由人工填写）
- 已更新的文档：`todo/project-board/P1-board-skeleton.md` 实施记录。

### DEV-046 看板事项的变更不广播 `todos.changed`

- 状态：已落实
- 阶段：项目看板 P1（D103）
- 是否阻塞：否
- 问题：设计 50 §10 写「复用 `todos.changed`、`message.created`、`run.status`、审批事件」刷新卡片投影。阶段文件步骤 4 要求看板事项的变更不再广播 `todos.changed`，改发 `board.changed`，避免工作台无意义重拉。阶段文件更晚、更具体。
- 影响范围：`TodoService.#changed`。存在 `board_cards` 行时发布 `board.changed`（`projectId` + `cardId` + `columnId`），不发布 `todos.changed`。`purge` 在删除前记下位置，避免侧表被外键带走后误发 `todos.changed`。`reconcile` 仍扫描看板事项；若它改了行，同样只发 `board.changed`。
- 可选方案：
  1. 只发 `board.changed`（当前实现）— 优点：工作台列表不因看板编辑重拉；缺点：设计 50 里「复用 todos.changed 刷新卡片」要等渲染层改订 `board.changed`（P1 渲染层尚未做）。
  2. 两种事件都发 — 优点：贴着设计 50 的「复用」一句；缺点：违反阶段步骤 4，工作台会空跑一次重拉。
- 推荐：方案 1（当前实现）。
- 决定：（由人工填写）
- 已更新的文档：`todo/project-board/P1-board-skeleton.md` 实施记录。

### DEV-047 看板排期不随移交带走，但移交本身不清空执行成员

- 状态：已落实
- 阶段：项目看板 P2（D103）
- 是否阻塞：否
- 问题：设计 50 §6.6 与 P2 B8 要求看板事项不随 D88 移交带走，被移交 Bot 的卡片按「执行成员离开」处理。`ScheduleAdapter` 只能决定一条排期移不移：它可以跳过带 `board_cards` 的事项，不能在盘点或套用时改事项的指派。移交完成后该 Bot 仍是项目成员，并没有离开。
- 影响范围：`handover/adapters/schedule.ts` 的 `inventory` / `validate` / `apply`。看板排期不出现在移交清单里，套用时拒绝。执行成员被移出项目或 Bot 被删除时，`#dropExecutor` 才清空指派、回草案、只读会话、取消排期。
- 可选方案：
  1. 适配器只跳过排期，离开语义留给移出成员 / 删除 Bot（当前实现）— 优点：不在资产盘点里做副作用，Bot 还在项目里时卡片仍可执行；缺点：只做移交、不删除 Bot 时，卡片仍指派给原执行成员。
  2. 移交结算时把该 Bot 的看板卡片一律按离开处理 — 优点：贴着「执行成员离开」的字面；缺点：Bot 仍是成员，卡片却变成无人执行，和「移交不自动删除 Bot」冲突。
- 推荐：方案 1。
- 决定：方案 1，并钉住移交后的卡片终态。看板排期不进移交清单，`validate` / `apply` 拒绝，**也不取消**。移交不把该 Bot 移出项目组，所以不能走 `#dropExecutor`：那会写「执行成员已移出项目组」或「执行成员已删除」，等于假装成员已经离开。移交结束后卡片仍指派给原执行成员，状态仍是 `scheduled`，`blocked_reason` 为空，卡片对话保持可写，排期仍挂在这条卡片对话上、`bot_id` 仍是该 Bot。这样「不随移交带走」和「Bot 还在项目里、仍执行这张卡」是同一件事，不会出现「排期没了、人还在、也没有原因」的半截卡片。真正清空指派仍只发生在移出成员和删除 Bot。
- 已更新的文档：`todo/project-board/P2-card-conversation.md` 实施记录。

### DEV-048 `mcpServerSourceSchema` 改联合后，`McpbInstaller` 三个私有/公共方法签名收窄到 mcpb 分支

- 状态：已落实
- 阶段：插件系统 P0a-1（D104）
- 是否阻塞：否
- 问题：P0a-1 任务书步骤 2.3 把 `mcpServerSourceSchema` 从单一 `kind:'mcpb'` 对象改为 `mcpb | plugin` 判别联合，并称「读 `kind === 'mcpb'` 的原有逻辑收窄后仍成立（不改 install.ts）」。核对发现 `McpbInstaller.verify(source: McpServerSource)`、`#releasePackage(source)`、`#audit(…, source, …)` 直接在整个联合类型上取 `name` / `version` / `sha256`（未先判 `kind`），联合化后 typecheck 报 9 个 TS2339/TS2345——「不改 install.ts」的前提在这三处不成立。
- 影响范围：`packages/core/src/apps/mcpb/install.ts`（仅类型层：新增 `type McpbPackageSource = Extract<McpServerSource, { kind: 'mcpb' }>`，`verify` / `#releasePackage` / `#audit` 参数与 `#installSnapshot` 里的局部 `source` 改用它）；行为零改动（三个方法的调用方本就都已先判 `kind === 'mcpb'`）。`McpbInstaller` 面向插件来源的完整改造仍在 P0a-2。
- 可选方案：
  1. 方法签名收窄到 mcpb 分支（当前实现）— 优点：最小、语义精确（该 installer 今天只管 mcpb 来源）；缺点：P0a-2 改造时要把 plugin 来源引入新的卸载 / 释放路径，届时再放宽。
  2. 在方法体里运行时判 `source.kind !== 'mcpb'` 提前返回 — 优点：签名不动；缺点：把「类型上不可能」变成死分支，掩盖联合的语义。
- 推荐：方案 1。
- 决定：（由人工填写）
- 已更新的文档：`todo/plugin-system/P0a-1-foundation.md` 实施记录。

### DEV-049 任务书称「`satisfiesRange` 不支持的写法会返回 false」，实际实现是忽略未知子句（返回 true）

- 状态：已登记（审查阶段发现，P0a-1 实现本身无需改动）
- 阶段：插件系统 P0a-1（D104）
- 是否阻塞：否
- 问题：P0a-1 步骤 6 写「`range` 含 `satisfiesRange` 不支持的写法时它会返回 false，这是预期（按不兼容处理）」。核对 `packages/core/src/apps/mcpb/manifest.ts` 的实际实现：未知子句形状走 `continue`（「unknown clause shape: ignore」），整串都是未知子句时返回 `true`（按兼容放行），与任务书的描述相反。
- 影响范围：`packages/core/src/plugins/manifest-loader.ts` 的 `checkPluginCompatibility` 按任务书的可操作指令直接复用 `satisfiesRange`（与 MCPB 兼容检查同一实现，不允许另写一份），因此未知写法的 `engines.kepcup`（如 `latest`、`||`）会被当作满足而不是不兼容。这是既有共享助手的语义，本阶段不改它。
- 可选方案：
  1. 保持复用 `satisfiesRange`（当前实现）— 优点：与 MCPB 同一语义、零重复实现；缺点：畸形 range 偏向放行，但清单 schema 已把 `engines.kepcup` 限为 1–100 字符字符串，畸形写法的实际风险低。
  2. 在 `manifest-loader.ts` 里加一层「未知子句视为不兼容」的预判 — 优点：更保守；缺点：与 `satisfiesRange` 语义分叉，两处规则会漂移。
- 推荐：方案 1。
- 决定：（由人工填写）
- 已更新的文档：`todo/plugin-system/P0a-1-foundation.md` 实施记录。

### DEV-050 `withRemoteSource` 包住进程内 `core.rpc.call` 不能让 handler 看到远程来源（MessagePort 不传播 AsyncLocalStorage）

- 状态：已落实
- 阶段：插件系统 P0a-2（D104）
- 是否阻塞：否
- 问题：P0a-2 步骤 11 的集成测试写「经 `withRemoteSource('dev_x', …)` 调 `plugins.inspect` 的 file 来源 → `INVALID_INPUT`」。核对 RPC 链路：测试里的 `core.rpc.call` 走 `createRpcChannel` 的 Node MessagePort（`create-core.ts` 的 `nodePortToTransport`），handler 在端口事件的宏任务里执行——AsyncLocalStorage 不跨 MessagePort 传播，测试侧包 `withRemoteSource` 到不了 `assertLocalSource` 的 `currentRemoteSource()` 读点（真实远程端点的来源标记是 `remote/hub.ts` 在 handler 外层包的，链路成立；只是进程内 rpc 通道不经过它）。
- 影响范围：仅测试（`packages/core/test/integration/plugins.test.ts`）：改为取 `bindPluginsMethods(core.services)` 的 `plugins.inspect` handler，按 hub 的方式 `withRemoteSource('dev_x', () => spec.handle(input))` 调用断言 `INVALID_INPUT`，并补同 handler 无远程来源时正常返回的对照。生产行为零改动。
- 可选方案：
  1. 按 hub 的调用形状直接测绑定 handler（当前实现）— 优点：不引入整套 remote hub 夹具就能覆盖 `assertLocalSource` 的两个分支；缺点：没有走过 hub 的包装点，依赖 hub 的包装（`remote/hub.ts:576`）保持不变。
  2. 起 fake relay + 远程端点全套夹具走真实 hub — 优点：链路最真；缺点：`remote-relay` e2e 已覆盖 hub 包装本身，这里再搭一套只为一个断言，成本不成比例。
- 推荐：方案 1。
- 决定：（由人工填写）
- 已更新的文档：`todo/plugin-system/P0a-2-projection.md` 实施记录。

### DEV-051 `chats.errorCode.PLUGIN_*` 四条已在 P0a-1 登记，P0a-3 步骤 8 要求的「追加到块末尾」位置不可用

- 状态：已落实
- 阶段：插件系统 P0a-3（D104）
- 是否阻塞：否
- 问题：P0a-3 步骤 8 写「`chats.errorCode.PLUGIN_*` 四条：放在各自 `chats.errorCode.*` 块的末尾」。核对现实：P0a-1 已经把这四条加进了两个语言文件（紧随 `BOARD_*` 组之后，`git log -S` 定位到 2a5853c3），且 `locales.test.ts` 强制两份词典键集合与顺序一致、对象字面量不允许重复键——再按任务书追加到 `chats.errorCode.*` 块末尾（`MAIL_PROVIDER_UNAVAILABLE` 之后）会产生重复键，typecheck 直接失败。
- 影响范围：仅 `apps/desktop/src/renderer/src/lib/i18n/locales/{zh-CN,en-US}.ts`：保留 P0a-1 的键位置（紧跟 `BOARD_LOCKED` 之后），把四条文案按 P0a-3 步骤 8 的文案表逐条改写（zh 与 en 同步、占位符一致，本组无占位符）。无代码路径受影响。
- 可选方案：
  1. 保留既有位置、只更新文案（当前实现）— 优点：不产生重复键，键序在两份文件里仍然一致；缺点：与任务书「放在块末尾」的字面位置不符。
  2. 把四条从块首移到块末尾 — 优点：贴合任务书字面；缺点：纯位置挪动要同时改两份文件并重跑校验，收益为零。
- 推荐：方案 1。
- 决定：（由人工填写）
- 已更新的文档：`todo/plugin-system/P0a-3-ui.md` 实施记录。

### DEV-052 步骤 9 称「其余规格不涉及」，但 `plugins.spec.ts` 的 `plugins-empty` 断言因 `plugins.list` 新增内置条目而失效

- 状态：已落实
- 阶段：插件系统 P0b（D104）
- 是否阻塞：否
- 问题：P0b 步骤 9 的 e2e 表只列 `skill-market` / `extension-center` / `connect-abort` 三份规格，并写「其余规格不涉及」。但同一任务书 §1 明确 `plugins.list` 「多出两条只读的内置插件」，于是 P0a-3 的 `plugins.spec.ts` 里两处「卸载后 / 安装前 `plugins-empty` 空态可见」的断言在仓库检出（未设 `KEPCUP_BUILTIN_PLUGINS`，向上查找命中真实随包资源）下失败——列表里恒有 2 张内置卡片，全列表空态不再出现。
- 影响范围：仅 `apps/desktop/test/e2e/plugins.spec.ts` 的 `launch()`：把 `KEPCUP_BUILTIN_PLUGINS` 指向 home 下一个空目录（与任务书给其它规格「env 指向临时目录」同一手法），全部既有断言原样保留。内置插件在「已安装」页签的展示由集成测试（`integration/plugins.test.ts` 新增用例）覆盖。
- 可选方案：
  1. 该规格指向空内置目录（当前实现）— 优点：规格继续只测本地插件生命周期，断言零改动；缺点：e2e 不再顺带覆盖「内置卡片在已安装页签出现」。
  2. 改写空态断言为「内置卡片恒在」— 优点：多一层 UI 覆盖；缺点：本规格断言语义被稀释，且内置展示另有集成测试。
- 推荐：方案 1。
- 决定：（由人工填写）
- 已更新的文档：`todo/plugin-system/P0b-builtin.md` 实施记录。
