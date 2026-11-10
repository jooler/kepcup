# 外部智能体：连接加固与新目标接入（D118）

> 状态：**已实现（2026-11-06）**——连接加固 4 项、小事项 2 项、新目标 7 个全部落地；剩余为需真实账号的人工项（§3.3）。来源：2026-11-06 对 OpenBot 0.62.0（`~/www/openbot`，ACP 驱动第三方 Agent 的同类桌面应用）的对比调研。设计契约见 `docs/design/28-external-agents-acp.md`（§9.2 适配矩阵、§10 Provider 架构已同步本方案）。
>
> **硬约束**：只改本地工作树；不改内置 pi 引擎行为；新增目标全部 `preview` 档 + `releaseGate` 且**不**进 `apps/desktop/agent-release-gates.json`（发行构建不收录，真机 spike + 合规确认后再放行）。
>
> 调研底稿（OpenBot 侧，文件行号在其仓库内）：
> - 预置目标全部为 stdio 子进程 + 官方 SDK `@agentclientprotocol/sdk` 1.9.0，无 HTTP/WS 传输；Claude / Codex 反而不走 ACP（私有客户端）。
> - 健壮性：stdout 行长上限（256 MiB，补 SDK `ndJsonStream` 无限制的缺口）、turn 停滞看门狗（5 分钟无 update 且无打开的 tool call / 等待中的权限 → cancel + abandon）、崩溃指数退避重启（≤3 次）+ 会话 `needsResume`、每家一套 sessionNotFound 错误形态匹配表、stderr 跨 chunk JSON 诊断流、进程沙箱（sandbox-exec）。
> - flavor 层：只为「观察到的 agent 版本」加 hook，缺省即协议默认行为。

## 0. 结论总览

| # | 事项 | 处置 |
| --- | --- | --- |
| A1 | stdout 行长上限（SDK 无限制 → agent 疯狂输出可 OOM 宿主） | **实现**：`acp/` 加限长 Transform，超限杀进程、run 失败 |
| A2 | turn 停滞看门狗（KepCup 只有 60 分钟 run deadline，僵死 agent 烧满整小时） | **实现**：prompting 期间 5 分钟无任何 `session/update` 且无等待中的权限请求 → cancel + run 失败 |
| A3 | run 中途进程崩溃的恢复（OpenBot 重启 + needsResume） | **实现**：无任何 agent 输出时一次透明重试（新进程 + resume/load + 重发 prompt）；已有输出则维持失败（避免输出重复） |
| A4 | session-not-found 识别（各Agent错误形态不同） | **实现**：`isSessionNotFound`（协议 `-32002`）+ Provider hook `sessionNotFound`；prompt 阶段命中并入 A3 重试路径 |
| B1 | SDK 1.7.0 → 1.9.0（OpenBot 已在 1.9） | **实现**：升级 + 定向测试回归；changelog 过一遍 |
| B2 | `AGENT_INIT_TIMEOUT_MS=60s` vs dsh 自记「npx 冷启动约 77s」 | **实现**：目录条目新增可选 `initTimeoutMs`（KepCup 扩展字段），dsh 设 120s；真机验证列为人工项 |
| C1 | 预置目标缺口（OpenBot 有 / KepCup 无） | **实现**：Registry 已收录的 7 个——cline 3.0.74、github-copilot-cli 1.0.105（`@github/copilot`）、goose 1.57.0、qwen-code 0.26.7、kimi 1.52.0、grok-build 1.0.77（`@xai-official/grok`）、devin 3000.11.234 |
| C2 | Registry 之外的目标（OpenBot 预置 / 预设） | **暂缓**：hermes（官方 install.sh 安装，无 Registry 条目）、omp / Oh My Pi、gemini（Google 同厂已有 antigravity，条款同源另评）——真机 spike 后按 §11 手册逐个补 |
| C3 | 版本跟进（KepCup 锁定版本已落后 Registry） | **人工项**：claude-acp 0.86.0→0.100.0、codex-acp 2.1.1→2.5.0、cursor 2026.10.01→2026.10.22、antigravity-acp 1.3.0→1.4.5、opencode 1.18.35→2.2.5——升版须重新过离线核对（Provider 注释里的源码行号） |
| C4 | 用户自定义 ACP agent 入口（OpenBot CustomAcpAgentDialog：command/args/env ≤16、env 主进程加密） | **不做**（本期）：与策展模式冲突（未经实测的 agent 不能进权限/沙箱模型），todo 只记设计要点 |

## 1. A — 连接层加固（`packages/core/src/agent/external/`）

### 1.1 A1 stdout 行长上限

- `shared/src/constants.ts`：`AGENT_STDOUT_LINE_MAX_BYTES = 256 MiB`（对齐 OpenBot `jsonl.ts` 的值）。
- 新文件 `acp/line-limit.ts`：`limitAgentLines(readable, maxBytes, onLimit)`——透传字节、按 `\n` 计数，单行超限 → `onLimit()` 并 error 掉 readable（连接随之关闭，宿主按进程退出处理，活跃 run 失败）。只计数不缓存整行，内存常数。
- `host.ts` `#start`：仅对子进程通道（非 shim）包一层；`onLimit` 记 error 日志。shim 通道为进程内内存管道，不包。

### 1.2 A2 turn 停滞看门狗

- `shared/src/constants.ts`：`AGENT_TURN_STALL_MS = 5 * 60_000`。
- `engine.ts` `ExternalRunHandle`：
  - `#noteAgentActivity()`：sink `onUpdate` 收到任何 update 时刷新；prompting 期间重置看门狗计时。
  - 权限请求等待期间**暂停**计时（`#pendingPermissions` 计数，sink 的 `requestPermission` 包装增减）——等用户审批不算停滞。
  - `#prompt` 进入时武装、返回 / 抛出时解除；触发 → 记 warn、`session/cancel`（best effort）、run 以 `TIMEOUT`（文案「N 分钟无任何更新」）失败。不 poison 会话（agent 可能只是慢；下一次 run 自行 resume）。
  - 跨 prompt 的间隙（`#awaitDetached` 等后台工具）不看门狗：已有 run deadline 兜底。

### 1.3 A3 崩溃后一次透明重试 + 1.4 A4 sessionNotFound

- `acp/client.ts`：`isSessionNotFound(error, provider?)`——SDK `RequestError` 协议码 `-32002`（`session/not_found`），外加 Provider hook `sessionNotFound?(error): boolean`（各家私有形态，如 `-32602 + data.sessionId`、`-32016 + errorKind: session_not_found`，在各自 Provider 模块实现）。
- `engine.ts` `start()`：主体提取为可重入的尝试函数；catch 中判定**可重试**：
  - 进程已消失（`#hostGone()`）且 agent 未产生任何输出（无 message / thought / tool 事件，`#agentProduced` 追踪）；
  - 或 prompt 阶段错误命中 `isSessionNotFound`（会话在 agent 侧丢失，turn 未运行，无输出）；
  - 且未 abort / 未 terminated / 未 settled，且本次 run 尚未重试过（`#recovered` 一次性）。
- 重试动作：释放当前租约（`#release()` 的会话处置路径已按「进程死了不 poison」处理）、复位 run 状态（sessionId / bridge / mapper / phase / prompted 等），重跑尝试——`#openSession` 自然走到 resume/load（agent 侧会话若在盘上则恢复，否则新建），`external.onSession` 以新 sessionId 再次回调。
- 已有输出时的崩溃维持现状（failed + `AGENT_PROCESS_EXITED`）：透明重试会重复已流式输出的内容，不做。

### 1.4 验收（定向测试 `packages/core/test/unit/agent-hardening-d118.test.ts`）

- 限长：假 agent 发出超限行 → 连接关闭、run 失败；正常大小行不受影响。
- 看门狗：prompt 在途、无 update 超过 `stallMs`（测试注入小值）→ run 失败 TIMEOUT、收到 `session/cancel`；有权限请求等待时不触发；update 持续到达时不触发。
- 重试：第一次进程启动即崩（无输出）→ 第二次成功、`onSession` 回调新 sessionId；已输出后崩溃 → 直接失败不重试；prompt 报 `-32002` → 重试后成功；重试只发生一次。
- `isSessionNotFound`：协议码、Provider hook、无关错误三分。

## 2. B — 两个小事项

- **B1 SDK 升级**：`packages/core/package.json` `@agentclientprotocol/sdk` 1.7.0 → 1.9.0；`pnpm install`；`pnpm --filter @kepcup/shared build` 后跑外部智能体定向测试 + typecheck。SDK 只在 `acp/` 下引用（D21），升级面收敛。
- **B2 init 超时**：`agentCatalogEntrySchema` 新增可选 `initTimeoutMs`（`>=1000`）；`host.ts` 取 `entry.initTimeoutMs ?? deps.initTimeoutMs ?? AGENT_INIT_TIMEOUT_MS`；dsh 条目设 120_000（安装器预装后启动不应触发，冷 npx 场景兜底）。**人工项**：真机验证 dsh 首启耗时。

## 3. C — 新目标接入（D118 C1）

### 3.1 条目（`shared/src/domain/agent-catalog.ts`，骨架由 `scripts/import-acp-registry.mjs --registry <file>` 生成后人工补扩展字段）

| id（=Registry id） | 版本 / 分发 | 启动 args | 认证（catalog `auth`） | provider |
| --- | --- | --- | --- | --- |
| `cline` | 3.0.74，npx `cline@3.0.74` | `--acp` | Cline 账号（ACP authenticate `cline`）或设备码；各家 API key | `generic-acp`（暂无差异） |
| `github-copilot-cli` | 1.0.105，npx `@github/copilot@1.0.105` | `--acp` | Copilot 订阅（`copilot login`，浏览器 / 设备码）；登出走 ACP `logout` 方法 | `generic-acp` |
| `goose` | 1.57.0，binary（5 平台，Registry 自带 sha256） | `acp` | goose 配置内各家 provider key（goose 自管） | `generic-acp` |
| `qwen-code` | 0.26.7，npx `@qwen-code/qwen-code@0.26.7` | `--acp --experimental-skills` | Qwen OAuth 免费档或各家 API key | `generic-acp` |
| `kimi` | 1.52.0，binary（5 平台，Registry 自带 sha256；**无 darwin-x86_64**） | `acp` | Kimi 会员 / API key（`kimi login`） | `kimi`（sessionNotFound：`-32602 + data.session_id`） |
| `grok-build` | 1.0.77，npx `@xai-official/grok@1.0.77` | `--no-auto-update agent stdio`（`--no-auto-update` 取自 OpenBot `grok-client.ts` 的实跑参数，spike 复核） | grok.com 登录（OAuth / 设备码）或 xAI API key | `generic-acp` |
| `devin` | 3000.11.234，binary（6 平台，Registry 无 sha256 → 导入脚本 `--hash` 下载计算） | `acp` | Devin 账号（ACP authenticate `devin-browser`） | `devin`（sessionNotFound：`-32016 + cognition.ai/errorKind: session_not_found`） |

共同项：`transport:'acp'`、`tier:'preview'`、`releaseGate:<id>`（**不**进 `agent-release-gates.json`）、图标从 Registry CDN 下载到 `apps/desktop/resources/agents/`、`nativeCapabilities: {}`（spike 实测后补）、i18n 补 `agents.terms.<id>`（zh-CN + en-US）。

### 3.2 Provider 模块（`providers/`）

- `kimi.ts` / `devin.ts`：只覆盖 `sessionNotFound` hook（错误形态来自 OpenBot flavor 表 `acp-flavor.ts:213-234`，**未真机复核**，注释标注来源与待验证）；其余继承 `genericAcpProvider`。
- cline / copilot / goose / qwen / grok-build：暂用 `generic-acp`，差异（认证方式过滤、权限 optionId、厂商扩展请求）等 spike 报告后再加模块。

### 3.3 人工项（真机 spike，逐个）

1. 安装 → `initialize` → 未登录 `session/new` 的错误形态（补 `classifyError` / auth 判定）。
2. 登录后：modes / config options、权限 optionId 实值、MCP 工具名形态、原生工具清单（补 `nativeCapabilities`）、`session/load` / `resume` 支持、并行会话判定。
3. 合规确认（登录 / 计费方式的第三方使用条款）后，才把 `releaseGate` 加进 `agent-release-gates.json`。
4. kimi 在 Intel Mac 不可用（Registry 无该平台归档）——设置卡文案披露。

## 4. 实施记录

### 4.1 连接层加固 + 小事项（2026-11-06）

全部落地，既有外部智能体套件 + 新增测试全绿（`external-agent-p5` 57、`external-agent-engine`、`agent-providers-p5`、`agent-review-p5-1`、`agent-parallel-sessions`、新增 `agent-hardening-d118` 12、`agent-targets-d118` 7）。

- **A1 行长上限**：`shared/constants.ts` 新增 `AGENT_STDOUT_LINE_MAX_BYTES = 256 MiB` 与 `AGENT_TURN_STALL_MS = 5 min`；新文件 `acp/line-limit.ts`（`limitAgentLines` / `limitChannelLines`：透传字节、按 `\n` 计数，超限 error 掉流）；`host.ts #start` 仅对子进程通道包一层（shim 内存管道不包）。
- **A2 看门狗**：`engine.ts` `ExternalRunHandle` 新增 `#stallTimer` / `#pendingPermissions` / `#stalled` / `#stallMessage`；`#prompt` 进入武装、返回解除；sink `onUpdate` 任何 update 刷新；权限请求等待期间暂停（`decide` 包装增减计数，**答复后重新武装**——否则答复后静默的 agent 漏盯）；触发 → `session/cancel` + 宽限后以 `TIMEOUT`（「N 分钟没有任何更新」）失败，`#outcomeOf` 把看门狗取消的 `cancelled` 应答也归为 failed（不是用户取消）。不 poison 会话。
- **A3+A4 重试**：`start()` 主体提取为 `#attempt()`（可重入）；`#retryWorthy`（**仅 prompt 阶段**：进程死 / `isSessionNotFound`，且无任何 agent 输出、未 abort / terminated、每 run 一次）；`#resetForRetry` 释放旧租约（按 host-gone 语义：行保留待 resume）、吊销桥 token、复位 per-attempt 状态、**强制新会话**（`external.session = undefined`——崩溃的 prompt 根本没送达，resume 旧会话会丢上下文）、把已消费进丢失 prompt 的 steer 还原队列。
  - **关键时序**：`#release()` 必须留在 `#attempt` 自己的 finally（结算与释放同一微任务，`done` 的续延在释放之后才能观察到——挪到 `start()` 会让 6 个 P5 测试时序失败），重试路径用 `retrying` 局部标记跳过；
  - **关键修正**：sink `onClosed` 对 `prompting` / `before` 阶段**延迟结算**（让 prompt / 会话设置的 promise 拒绝把失败带进 catch，重试才有机会判定），其余阶段照旧立即结算；宿主自己的失败报告（`AGENT_PROCESS_EXITED` + stderr 详情）存 `#hostClosedError`，非重试路径的结算优先用它（不然会退化成模糊的 `AGENT_FAILED`）；
  - `acp/client.ts` 新增 `isSessionNotFound(error, provider?)`（协议 `-32002`）与 `ACP_SESSION_NOT_FOUND`；`AgentProvider` 新增 `sessionNotFound?` hook（design 28 §10 已同步）。
- **B1 SDK 1.7.0 → 1.9.0**：`packages/core/package.json` 升版 + `pnpm install`，typecheck 与全部套件直接通过，无 API 变化需要适配。npm 上 latest 已是 2.4.0（v2 草案方向）——按 design 28 §12「不做 v2 草案」维持 1.9.0（OpenBot 实跑版本）。
- **B2 init 超时**：`agentCatalogEntrySchema` 新增可选 `initTimeoutMs`（≥1000）；`host.ts` 取 `entry.initTimeoutMs ?? deps.initTimeoutMs ?? AGENT_INIT_TIMEOUT_MS`；dsh 条目设 120_000（离线 spike 记录 npx 冷启动约 77 s > 缺省 60 s）。真机首启验证仍是人工项（§3.3）。

### 4.2 新目标接入（2026-11-06）

- **条目**（`shared/src/domain/agent-catalog.ts`，骨架经 `scripts/import-acp-registry.mjs --registry <file>` 生成后人工补扩展字段）：`cline` 3.0.74、`github-copilot-cli` 1.0.105（`@github/copilot`）、`goose` 1.57.0（binary，Registry sha256）、`qwen-code` 0.26.7、`kimi` 1.52.0（binary，Registry sha256；无 darwin-x86_64）、`grok-build` 1.0.77（`@xai-official/grok`，args `--no-auto-update agent stdio`）、`devin` 3000.11.234（binary，Registry 无 sha256 → 6 平台归档下载计算并锁定，导入脚本 `--hash` 因连接重置不稳，改 curl 断点续传后 `shasum` 完成，大小与 S3 content-length 逐一核对）。全部 `preview` + `releaseGate:<id>` 且**不**进 `apps/desktop/agent-release-gates.json`。
- **Provider**：新模块 `providers/kimi.ts`（sessionNotFound：`-32602 + data.session_id`）与 `providers/devin.ts`（`-32016 + cognition.ai/errorKind`）——形态取自 OpenBot flavor 表，**未真机复核**；其余 5 个用 `generic-acp`（差异待 spike）。`PROVIDERS` 登记表加两行。
- **图标**：7 个 SVG 从 Registry CDN 下载进 `apps/desktop/resources/agents/`（`agent-icons.ts` 的 glob 自动收录）。
- **i18n**：`agents.terms.{cline,copilot,goose,qwen-code,kimi,grok-build,devin}` 补进 zh-CN 与 en-US；kimi 的条款披露 Intel Mac 无官方构建。
- **测试**：`agent-targets-d118.test.ts`（条目结构 / 门禁 fail-closed / provider 登记 / grok args / 两个 sessionNotFound 形态）；`agent-hardening-d118.test.ts`（12 个：限长、看门狗〔含权限等待〕、重试〔崩溃无输出、有输出不重试、-32002、只重试一次、会话设置阶段不重试〕、dsh initTimeoutMs）。既有「provider registry」用例自动覆盖新条目的 provider 解析；npx 锁文件重生成（4 个新包）；parallel-sessions 的 EXPECTED 表补 kimi/devin false；shared 目录测试的 id 清单扩为 15 条。
- **全量收口（shared 契约变更，跑一次）**：748 文件 **7910 过 / 2 失败**——两处失败均为集成测试 `external-agent-p5.test.ts` 的「第三轮 #9」用例：其第一问脚本是**无输出即崩**（`agentTurn().crash()`），触发了新的透明重试（多起一个进程、行指向重试新会话），后续进程映射漂移。修复：崩溃前加一段输出（「已有输出后崩溃」不重试），用例本意（#9 删除竞态）不受影响，单文件复核 11/11 绿。未再重跑全量（AGENTS.md：偶发失败单跑该文件复核）。
- **待真机**（§3.3）：7 个新目标逐个 spike；合规确认后才把 `releaseGate` 加进 `agent-release-gates.json`；kimi Intel Mac 无官方构建（条款已披露）；dsh 真机首启验证 `initTimeoutMs: 120s`。

### 4.3 独立审查轮与修复（2026-11-06）

三路独立只读子代理审查（连接加固核心 / 测试质量 / 新目标+文档同步），结论：目标接入与文档无 P0-P2（7 条 P3）；核心实现 2 P1 + 5 P2；测试 2 P1 覆盖缺口 + 4 P2。核实后全部属实，已修复：

- **P1 `#resetForRetry` 漏清 `#graceTimer`**：停滞取消武装的宽限计时器会跨重试边界触发——停滞取消后进程死亡（停滞常是进程垂死的表征）会走进透明重试，而残留计时器约 10s 后以 `#stallMessage` 已复位为 null 的空文案 settle、并释放重试刚拿到的租约。修复：reset 清计时器；`#onStall` 把文案**按值捕获**进 grace 闭包（不再惰性读字段），双保险。
- **P1 A1 的 256 MiB 行长上限实际不可达**：SDK 1.9.0 `ndJsonStream` 默认单行 32 MiB 上限且在前，`AcpConnection` 未传 `maxMessageBytes` → 限长层与 `onLimit` 专属日志永不触发（保护目标由 SDK 侧达成，但口径与可观测性落空）。修复：`ndJsonStream(..., { maxMessageBytes: AGENT_STDOUT_LINE_MAX_BYTES + 1 MiB })`，`limitAgentLines` 保持唯一权威口径。
- **P2 `isSessionNotFound` 的 Provider hook 无防御**：hook 抛错会从 `#attempt` 的 catch 里逃逸 → run 永不结算 + unhandled rejection。修复：hook 调用包 try/catch，抛错回落协议码 `-32002`。
- **P2 重试丢弃旧 mapper 前不 `abandon()`**：已发 `tool_call` 永无配对 `tool_result`（run_steps 断链）。修复：`#resetForRetry` 替换 mapper 前 `for (const event of this.#mapper.abandon()) this.emit(event)`（与 `#settle` 同一模式，补失败结果）。
- **P2 `onClosed` 对 `before` 阶段延迟结算过宽**：`before` 覆盖整个会话建立期，其中 `buildSystemPrompt` / `applyPermissionTier` 不因连接关闭而 reject、也无上界 → 宿主在这些窗口死亡 run 会挂死；且延迟对重试无意义（局部 phase 在建立期是 `initialize` / `session_new`，本就不重试）。修复：延迟收窄到 `prompting`，`before` 恢复立即结算（即 P5 原语义）。
- **测试修补**：权限等待用例改**判别形**（decide 独占超过 stallMs 后放行、agent 随即完成 → 期望 completed；删掉 `#pendingPermissions` 守卫必 TIMEOUT 失败），原「silent agent 看门狗恢复」拆为独立用例；`isSessionNotFound` 测试注释纠正（hook 是加法语义：拒绝后回落协议码，并非 hook 独裁）；删幽灵导出 `_Tier`；`agent-targets-d118` 新增**读真实 `apps/desktop/agent-release-gates.json`** 的 fail-closed 用例（原用手抄列表，把新 gate 加进文件不会有任何测试变红）。
- **文档修补（design 28）**：§9.2.1 交叉引用 §11 → §10（接入手册实际在 §10）；§10 providers 文件清单补 `kimi.ts` / `devin.ts`；§2.1 `auth.kinds` 补 `'anonymous'`（opencode 在用，预存在 drift 顺路修）。
- **testkit**：SDK 1.7.0 → 1.9.0（与 core 对齐消除双版本并存；fake agent 走真实 SDK 帧，互操作由全部 ACP 套件验证）。

记录在案（不修，留待后续 / 真机）：

- 重试后新会话的 `reusable` 语义：`external.session` 强制 undefined 保留到 release → 重试成功建立的会话在 release 时被 close/forget，下次 run 走 resume/load（agent 不支持则全新会话 + 全量上下文）。功能闭环，但对 P5 复用是静默降级；修法（`#retryOpenedSession` 标记让 release 判 reusable）待与 orchestrator 语义一起定。
- 已注入未应答的 steer（`_session/steering` 返回 injected）在重试中丢失——并入重发 prompt 有理论重复风险、交还 `onSteerRejected` 更保守，取舍待定。
- B2 行为链无测：testkit 假 agent 无 `initDelayMs` 旋钮，`initTimeoutMs` 优先级链端到端测不了（现仅锁目录数据）。
- 7 个新 binary 条目缺 `sizeBytes`（既有 binary 条目都有）——安装审批卡显示体积未知，spike 时从归档实测回填。
- copilot `auth.kinds` 含 `api-key` 但 note / 条款只写订阅——spike 确认有无 API key 登录路径后二选一。
- 预存在（非 D118 引入）：`agent-parallel-sessions.test.ts` 两处 `catalogEntry('antigravity')` 查不到条目（实际 id `antigravity-acp`）断言空转——行为由 EXPECTED 表钉住不失控，顺路修或另开小项。
- 低风险 nit 不处理：line-limit 逐字节循环可 `indexOf(0x0a)` 提速、host init 超时文案裸毫秒、`#settleDisposed` 不清 stall watch、重试不复位 `#detachedAbort`（需首 turn 零 update + 60 分钟 deadline 才可达）。

验证：`agent-hardening-d118` 13 + `agent-targets-d118` 8 + `external-agent-engine` 36 = 57 单测全绿；P5 集成 + parallel-sessions 19/19；core typecheck 0 错；testkit / core dist 重建。

## 5. 与设计文档的同步

- `docs/design/28-external-agents-acp.md` §10：架构图与 Provider 接口补 `sessionNotFound?` hook、`limitAgentLines`（stdout 行长上限）、stall 看门狗与崩溃重试的引擎行为、`initTimeoutMs` 目录字段。
- `docs/design/28-external-agents-acp.md` §9.2：追加「候选接入清单（D118 调研）」小节。
- `docs/design/README.md`：D118 行。
