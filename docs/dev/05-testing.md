# 05 测试策略

## 测试分层

| 层 | 范围 | 工具 | 位置 |
|---|---|---|---|
| 单元测试 | 纯函数、解析器、策略生成、上下文组装、白名单匹配、租约冲突判定 | vitest | 各包 `test/unit/` |
| 集成测试 | 核心服务的服务层 + 真实数据库（临时目录）+ 模拟模型服务 | vitest | `packages/core/test/integration/` |
| 沙箱测试 | 真实沙箱中的逃逸用例与网络用例 | vitest（按平台条件执行） | `packages/core/test/sandbox/` |
| 端到端测试 | 启动打包前的 Electron 应用，模拟用户操作界面 | Playwright（`_electron`） | `apps/desktop/test/e2e/` |
| 手工冒烟 | 使用真实模型厂商 | 检查清单（下文） | — |

每个阶段的“测试要求”说明该阶段必须新增哪些测试；阶段收口时全部测试必须通过（全量跑一次即可）。开发与修复迭代中先跑定向测试，见下文[开发中如何跑测试](#开发中如何跑测试)。

## 开发中如何跑测试

**先定向、后全量**。开发与修复迭代中只跑与改动相关的测试；全量只在收口时跑一次。

定向命令（根目录执行；容器里同样只用 `node scripts/run-tests.mjs run …`，见下文[本机容器运行](#本机容器运行linux-开发机)）：

| 范围 | 命令 |
|---|---|
| 单个文件或目录 | `node scripts/run-tests.mjs run packages/core/test/unit/xxx.test.ts` |
| 文件内按用例名 | `node scripts/run-tests.mjs run <测试文件> -t "用例名片段"` |
| 单个包 | `pnpm --filter @kepcup/core test`（`shared` / `testkit` 同理）；desktop 单测用 `node scripts/run-tests.mjs run --project desktop` |
| 单个 e2e spec | `pnpm build` 后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/xxx.spec.ts` |
| 单包类型检查 | `pnpm --filter @kepcup/core typecheck`（`shared` / `desktop` 同理） |

- 顺序：先跑改动文件对应的测试与新增测试 → 需要时再跑改动所在包 → 收口时全量。
- **全量 `pnpm test` 只在以下情况跑**：
  1. 阶段收口或最终交付前，跑**一次**；
  2. 改了跨包公共部分（`packages/shared` 契约、`packages/testkit`、数据库迁移、`vitest.config.ts` / `scripts/run-tests.mjs`）；
  3. 用户或调度会话明确要求。
- 不做「连续多轮全量」。全量里出现偶发失败时，只单跑失败的那个文件复核。
- 改动前不重跑全量建基线：直接引用下文已记录的基线（及 PROGRESS.md / todo 中最近一次全量结果）。
- 不推荐 `vitest related` / `--changed`：各包测试经 `@kepcup/shared`、`@kepcup/core` 的入口别名导入，依赖图几乎覆盖全部测试文件。实测 `node scripts/run-tests.mjs related --run packages/shared/src/browser/net-rules.ts` 选中了 148/148 个文件，等同全量。
- `pnpm typecheck` / `pnpm lint` 较快，可在交付前整体跑；迭代中可用单包 typecheck。

## 模拟模型服务（packages/testkit）

测试中不调用真实模型。`testkit` 提供一个本地 HTTP 服务，实现 **OpenAI 兼容的 Chat Completions 接口**（流式 SSE，支持 tool calls），通过 pi 的自定义 `baseUrl` 接入。

### 场景脚本

```ts
const llm = await startMockLlm();
llm.script('mock-main', [
  step().expect(req => req.lastUserText().includes('帮我'))
        .replyToolCall('send_message', { text: '收到' }),
  step().replyText('完成了'),
]);
llm.script('mock-light', [
  step().replySubmit({ decision: 'respond', confidence: 0.9, reason: '...' }),
]);
```

能力要求：

- **按模型 id 分别编排**：`mock-main`、`mock-light` 等，互不干扰，便于同时测试响应 loop 与后台 loop。
- **断言请求内容**：每个步骤可以检查收到的请求（系统提示词、消息、工具列表），不匹配时测试失败并打印差异。
- **记录全部请求**：测试结束后可以检查“某段内容是否出现在发给模型的请求中”（例如 API key 绝不出现）。
- **可控延迟与闸门**：`step().hold()` 让响应挂起，直到测试调用 `release()`；用于测试执行中注入、取消、租约等待。
- **错误注入**：返回 401、429、500、中途断流。
  `failWith` 默认带 `x-should-retry: false`，引擎的模型请求重试（`packages/core/src/agent/model-retry.ts`）不会重试，脚本失败即失败；要测重试路径传 `{ retryable: true }`（可带 `Retry-After` 等 headers），并用 `KEPCUP_MODEL_RETRY_BASE_DELAY_MS` 压短退避。
- **usage**：每个响应返回可配置的 token 用量，用于测试用量账本。
- 未编排的请求直接失败，避免测试静默通过。

### 对话轮与任务的剧本（D75）

D75 后一条用户消息先跑**对话轮**（只读、工具面小），需要动手的工作在对话轮派出的**任务**里跑；两者共用同一个模型脚本时按请求区分：

- `step().inTurn()` / `step().inTask()`：步骤只匹配对话轮 / 任务的请求（`isTaskRequest`：请求消息里含 `<task_brief` 即任务）；两条 lane 可在同一个脚本上任意交错，`expect(...)` 与 lane 条件叠加。
- `viaTask({ taskSteps, title?, instruction?, writes?, sourceMessageIds?, ack?, relay? })`（`packages/testkit/src/helpers.ts`）：把旧的「回复 run 里干活」改写为「对话轮 `start_task` + 确认 → 任务跑 `taskSteps` → 结果唤醒对话轮转述（`relay`）」。任务以空结果结束（`skip_reply` / 失败不跟进）或测试自己编排唤醒轮时省略 `relay`。e2e 同样用它迁移（`browser` / `projects` / `environment` / `sandbox` / `approvals` 等 spec；`approvals.spec` 的访问审批由只读任务的 `read` 发起——对话轮越界读当场失败、不等审批，修复批 D M4：原先在回复 run 里做的工作改在任务里做；只读浏览器任务除下载用例外都设 `writes:false`；改动摘要卡来自写任务）；`projects.spec` 的租约用例改为「排在另一对话的写任务之后、在其任务卡上取消后执行」（DEV-015）。
- 迁移旧用例的判断：写文件、命令、浏览器、媒体、MCP、审批 / 授权、环境安装都必须在任务里断言（对话轮会被网关拒为 `RUN_READ_ONLY` 或根本没有该工具）；「执行中追加消息」改为断言下一个对话轮收到合并批，或断言 `inject_task` 进了任务。
- D75 主要用例：`supervisor-turns`、`supervisor-review-fixes`、`tasks`、`tasks-review-fixes`、`tasks-agent-review-fixes`、`tasks-review-fixes-e`、`tasks-review-fixes-f`（最终审查：等用户时被取消的写任务立即放租约、投递计数与持有）、`task-cards`、`task-subagent-read-only`、`task-timeline-visibility`（多 Bot 泄露契约）、`workspace-lease`、`external-agent-tasks`（集成）；`supervisor-turn`、`scheduler`、`gateway-read-only`、`turn-tools-review-fixes`、`messages-task-events`、`runs-tasks`、`task-timeline-render`、`agent-sessions-per-task`、`task-events-migration`、`usage-turn-migration`、`untrusted-lines`（`<untrusted>` 中和与归属）（单元）；e2e `tasks.spec.ts`。

### 测试夹具

- `createTestHome()`：创建临时数据目录，设置 `KEPCUP_HOME`，测试结束删除。
- 钥匙串：`NODE_ENV=test` 且 `KEPCUP_KEYSTORE=memory` 时使用内存实现；**非测试环境下该变量无效**，启动时检测到则拒绝启动。
- `createCore(options)`：在测试进程内启动核心服务（不经过 Electron 主进程），返回可直接调用的 RPC 客户端与事件监听器。
- 工厂函数：`makeBot()`、`makeGroup()`、`sendBatch()`、`waitForRun()`、`waitForEvent()`。

## 原生模块

better-sqlite3-multiple-ciphers、`@napi-rs/keyring`、es-git 等原生模块需要同时在 Electron（核心服务运行于 `utilityProcess`）与测试中加载。

- 原生模块按 **Electron 的 ABI** 编译（`electron-builder install-app-deps` 或 `@electron/rebuild`，在 `postinstall` 中执行）。
- 需要加载原生模块的测试，**用 Electron 作为 Node 运行 vitest**：`ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`。根目录提供 `pnpm test` 脚本封装。
- 不依赖原生模块的纯单元测试（例如 `packages/shared`）可以用普通 Node 运行。
- P00 必须验证以上方案在三个平台上可行；不可行时按 [README.md](README.md#偏差与问题) 记录。

## 安全用例集

`packages/core/test/security/` 维护一组**每个阶段都必须继续通过**的用例，随阶段补充：

| 用例 | 引入阶段 |
|---|---|
| API key 明文不出现在：日志文件、runs.db（解密后检索）、发给界面的任何 RPC 返回与事件、发给模型的请求 | P01 |
| 数据库文件无法用不带密钥的 SQLite 打开 | P00 |
| 沙箱内读取 `~/.ssh`、`~/.aws`、`~/.kepcup/main.db` 失败 | P02 |
| 沙箱内写入 workspace 以外的路径失败 | P02 |
| workspace 中指向外部的符号链接，经文件工具读取被拒绝 | P02 |
| 沙箱内访问内网地址与 `169.254.169.254` 失败（所有网络模式） | P02 |
| 同一 Bot 的两个对话，workspace 互相不可访问 | P02 |
| 沙箱初始化失败时命令不会在沙箱外执行（除非经逐条确认） | P02 / P03 |
| 未授权路径经文件工具访问时触发审批，拒绝后不可访问 | P03 |
| 授权只对申请的 Bot 与对话生效 | P03 |
| 无人值守模式下 `~/.kepcup` 仍不可访问 | P03 |
| 其他 Bot 的发言、工具输出中的“指令”不会导致记忆或画像写入（画像证据必须来自用户消息） | P07 |
| 已删除 Bot 的数据目录不存在，id 未被新 Bot 复用 | P01 |

## 本机容器运行（Linux 开发机）

开发机 glibc 2.35 加载不了 es-git 预编译绑定（需 ≥ 2.38），大部分集成测试在宿主上直接失败。单元 / 集成测试在 Debian 13 镜像 `kepcup-test:trixie` 里跑，e2e 用派生镜像 `kepcup-test:trixie-xvfb`：

```bash
docker run --rm -v "$WT:$WT" -v "$NODE_DIR:$NODE_DIR:ro" -w "$WT" --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home -e CI=1 -e PATH="$NODE_DIR/bin:/usr/bin:/bin" \
  kepcup-test:trixie bash -c "mkdir -p /tmp/home && node scripts/run-tests.mjs run [文件或目录]"
```

- 容器里**只用** `node scripts/run-tests.mjs run …`；不要在容器里跑 `pnpm test` / `pnpm install`（会触发依赖检查、重装并破坏 worktree 的 `node_modules`）。typecheck / lint 在宿主跑（`pnpm -r typecheck`、`pnpm lint`），Node 24 需先放进 `PATH`（系统默认 node 版本过旧）。
- `packages/core/test/integration/projects.test.ts` 已按 D75 重写，容器里约 18 s；其中「allows localhost ports … (OS sandbox)」一条依赖系统沙箱，容器里按基线失败。
- 宿主 `timeout` 只杀 docker 客户端、杀不掉容器：需要硬超时就给容器起名（`--name`），另起一个 `sleep N; docker kill <名>` 的看门狗。
- vitest `--outputFile`（如 `--reporter=json --outputFile=…`）必须写在 worktree 内：容器里的 `/tmp` 不挂载到宿主。
- **基线**（`d75@7138daf`，2026-10-08）：全量 1559 例中 33 条失败，全部是容器环境原因（沙箱自检 / bwrap / socat / 外网：`sandbox-isolation` 10、`projects` 6、`skills-authoring` 4、`env-distro-toolchain` 3、`skills` 3、`workspace-tools` 3、`toolchain-sandbox` 2、`wiki-url` 2），逐条清单见 `todo/supervisor-and-tasks.md` §6。判定标准是「失败集合不超出基线」，不是全绿；偶发负载超时（`web-tools`、`memory`「两个 Bot 同时产生画像提案」、`agents-service` 登录状态）单跑复核。D75 收口时（W3 后）全量 1755 例、33 条失败，除 `approvals` 一条（已由 `26e15f2` 修正）外均在基线集合内；`projects` 的「blocks switching projects while a bot is executing」已转为通过。
- **e2e**：在 `kepcup-test:trixie-xvfb` 中先 `npx electron-vite build`（产出 `apps/desktop/out`），再在 `apps/desktop` 下 `xvfb-run node ../../node_modules/@playwright/test/cli.js test …`（容器加 `--shm-size=1g`）。D75 W3 后全量 70 例、3 例失败（`browser.spec`「删除 Bot 后其浏览器分区数据不存在」、`sandbox.spec`「run status line shows the command description while a command executes」、`wiki.spec`「wiki tab: browse the page tree …」），与 main 上的失败一致。

## CI 矩阵

| 任务 | macOS（arm64） | Ubuntu 24.04（x64） | Windows（x64） |
|---|---|---|---|
| lint、类型检查、svelte-check | — | ✓ | — |
| 单元与集成测试 | ✓ | ✓ | ✓ |
| 沙箱测试 | ✓ | ✓（需先执行 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`） | P12 起（WSL2 需自建运行器，否则手工验证） |
| 端到端测试 | ✓ | ✓（`xvfb-run`） | ✓ |
| 打包冒烟 | P13 | P13 | P13 |

- CI 配置写在 `.github/workflows/`；仓库托管在其他平台时按同等内容改写。
- 端到端测试从 P01 开始加入 CI。

## 端到端测试约定

- 启动应用时设置：`KEPCUP_HOME`（临时目录）、`NODE_ENV=test`、`KEPCUP_KEYSTORE=memory`、`KEPCUP_MOCK_LLM_URL`（模拟模型服务地址，启动时自动配置为一个厂商）。
- 界面元素使用 `data-testid` 定位，命名形如 `composer-input`、`draft-queue-item`、`approval-card-approve`。
- 每个阶段的验收标准中凡是界面行为的，都要有对应的端到端测试。
- 外部智能体（D72 P6，`external-agents.spec.ts`）：设置 `KEPCUP_FAKE_ACP_AGENT_BIN`（testkit `FAKE_ACP_AGENT_BIN`）+ `KEPCUP_FAKE_ACP_AGENT_SCRIPT`（`writeFakeAgentScript` 写的剧本）[+ `KEPCUP_FAKE_ACP_AGENT_RECORD`（`readFakeAgentRecord` 读）]，core 让目录的 `fake` 与额外的 `fake-sub`（订阅登录，onboarding 分支用）条目以 Electron 的 Node 运行 testkit 假 Agent（仅测试构建，打包产物剔除）；不设 `KEPCUP_MOCK_LLM_URL`（置空）即「只有智能体」的新用户。剧本的回合按 prompt 依次消耗：对话以外的后台任务会占用回合，用例先在设置「后台任务」里关闭。

### 外部智能体的真机项（D72）

- Provider 契约测试（`packages/core/test/contract/`）用假 Agent 剧本覆盖各家差异；真实 Agent 的行为由 `packages/core/scripts/agent-spike/` 的 spike 脚本在**用户登录后**手动执行（README「需要用户登录后再跑的步骤」），开发会话不代为登录、不读取任何凭据文件。
- 原生优先遵守度回归（P6）：`node packages/core/scripts/agent-spike/adherence.mjs --runs 10`，结果表贴进设计 28 §9.2。措辞 fixture 由 `native-first-wording.test.ts` 守护（产品措辞变动即失败，`KEPCUP_UPDATE_WORDING=1` 重新生成，之后须重跑真机遵守度）。

## 手工冒烟清单（真实模型）

每个阶段结束时，用至少一个真实厂商（建议 Anthropic 或 OpenAI 各一个）执行本阶段新增的冒烟步骤，结果写入 PROGRESS.md。通用步骤：

1. 在设置中配置 API key，重启应用后仍有效。
2. 新建 Bot，发送消息，收到符合人设的回复。
3. 让 Bot 做一件耗时的事（派出任务、出现任务卡），任务进行中追加消息：Bot 立即在新的对话轮里回应，并把追加的要求转给任务（任务卡出现追加行）或另起任务；任务结束后 Bot 转述结果。
4. 在任务卡上取消任务，界面状态正确（卡片转「已取消」、附改动摘要，不再唤醒 Bot）。
