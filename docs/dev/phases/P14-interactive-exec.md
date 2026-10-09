# P14 命令行交互执行

## 目标

让需要人介入的命令不再静默失败或盲等超时：默认引导模型走非交互等价形式（L1）；确需凭据时经审批卡片输入并注入 stdin（凭据注入，L2a）；确需人工选择时以交互模式执行，用户在界面输入直达进程 stdin（交互输入，L2b）。全程守住红线：**凭据值与敏感输入内容不进模型上下文、不落任何持久化**。

## 依赖

P02（沙箱与编码工具）、P03（授权与确认体系）。

## 设计依据

- [design/15-interactive-execution.md](../../design/15-interactive-execution.md)（全文）
- [design/13-permissions.md](../../design/13-permissions.md)（审批框架、无人值守模式）
- [design/10-sandbox.md](../../design/10-sandbox.md)（srt 执行路径）
- [design/12-ui-layout.md](../../design/12-ui-layout.md#焦点二消息流末尾)（焦点二、卡片表）
- [03-data-model.md](../03-data-model.md)（approvals、audit_log、删除级联）
- [04-agent-runtime.md](../04-agent-runtime.md)（工具规范与提示词）

## 背景（现状，实现前必读）

- 三条执行路径全部 `stdio: ['ignore', 'pipe', 'pipe']`，stdin 为 `/dev/null`：`sandbox/backend-srt.ts` `#spawnWrapped`、`sandbox/confirm-executor.ts`（沙箱外）、Windows PowerShell 确认模式。全仓库无 PTY。
- bash 工具（`tools/coding-tools.ts`）由 pi 的 `createBashToolDefinition` 创建，`operations.exec` 已被替换为 `gateway.exec`；pi 的 bash schema 固定为 `command` + `timeout`（`pi-coding-agent/dist/core/tools/bash.d.ts`）。
- 容器/WSL 路径（`sandbox/backend-container.ts`）的 stdin 承载 shim 控制协议，spawn 后立即 `end()`。
- 审批框架：`permissions/approvals.ts`（阻塞等待 `waiting_approval`、卡片消息、`#autoDecideSync` 无人值守自动裁决、`cancelPendingForRun` 取消联动）；approvals 表 kind 列有 CHECK 约束（`migrations/main/0004`，0010 有重建表先例）。
- 超时：`BASH_TIMEOUT_DEFAULT_MS`（600s）到期 `killTree` 杀进程树；工具结果已有超时与沙箱违规两类附注文案先例。

## 范围

包含：

- bash 工具定义改造：`interactive`、`secret` 参数；工具描述声明「无 TTY、stdin 默认关闭」。
- 非交互优先引导（L1）：交互特征检测、工具结果引导文案、`<access>` 系统提示词补充。
- 交互模式执行（L2b）：srt 沙箱路径与沙箱外/逐条确认路径 stdin 常开；空闲超时；输出实时事件 `exec.output`（含服务端疑似交互特征标记）；`runs.sendInput` RPC；输入可见性分层（普通回注 / 敏感回执）；审计。
- 凭据注入（L2a）：`secret` 审批 kind（schema + 迁移）、卡片掩码输入、会话级钥匙串缓存、spawn 后 stdin 预注入、无人值守分支。
- 无人值守开启弹框：自动批准清单与警告文案更新。
- 平台边界：WSL2 / 容器增强后端 / Windows PowerShell 确认模式降级为非交互并如实注明。

不包含：

- PTY 与全屏 TUI 程序（vim、htop 等）。
- 模型直接写 stdin（`request_stdin` 类工具）。
- 凭据的跨对话持久化与凭据管理界面（仅有会话级缓存；对话删除即清理）。
- 容器 / WSL 后端的交互 stdin 协议扩展。
- 群聊特有逻辑（交互会话归属 run，群成员可见可输入为自然继承）。

## 任务

1. **bash 工具定义改造**（`packages/core/src/tools/coding-tools.ts`）（**需验证**）
   - 验证以自有 ToolDefinition 替换 pi 的 bash 定义（保持工具名 `bash` 与渲染兼容，`operations.exec` 替换方式不变），或以 pi 的 tool-definition-wrapper 扩展参数；取干扰最小、渲染不受影响的方案，结论记入 PROGRESS.md。
   - schema 增加 `interactive?: boolean`、`secret?: { purpose: string }`；描述写明：无 TTY、stdin 默认关闭、不支持交互命令；预期交互输入或凭据时分别用 `interactive` / `secret`，优先考虑非交互等价形式。
2. **交互模式执行**
   - `gateway/index.ts` exec 请求增加 `interactive`；`sandbox/backend-srt.ts` 与 `sandbox/confirm-executor.ts` 在交互模式下 stdin 用 `'pipe'` 且不主动关闭。**默认路径保持 `'ignore'` 不变**（不引入非交互命令挂起回归）。
   - 空闲超时：交互模式将 `timeout` 的总时长语义改为空闲超时（上限复用 `BASH_TIMEOUT_DEFAULT_MS`），每次输出与每次用户输入重置计时；到期仍 `killTree`。abort / 取消 run 照常终止。
   - 降级：`sandbox/backend-container.ts`（含 WSL shim）与 Windows PowerShell 路径不支持交互——请求交互时按非交互执行，并在工具结果注明「当前执行路径不支持交互输入」。降级判断在 exec 前按后端类型做出。
3. **输出实时事件**
   - 交互模式下经 `onOutput` 发布节流事件 `exec.output`：`{ runId, toolCallId, text, suspectedPrompt }`，`text` 为输出尾部片段；`suspectedPrompt` 由服务端特征匹配得出（`password`、`passphrase`、`[y/n]`、`选择`、`确认`、行尾 `?` 等，正反例落单测）。非交互模式不发该事件。
4. **用户输入通道**
   - RPC `runs.sendInput { runId, text, sensitive }`（`shared/src/rpc/methods.ts` + `core/src/rpc/bindings.ts`）：路由到该 run 当前活动的交互 exec（一个 loop 同一时刻至多一个活动命令；无活动交互 exec 时报错）。
   - 写入 `child.stdin`（`\n` 结尾），并向输出流注入回执行，随工具结果进入模型上下文与执行记录：
     - 普通输入：`[用户输入] {text}`；
     - 敏感输入：`[用户输入了敏感内容（已隐藏）]`，内容不进任何持久化。
   - 审计 `audit_log`：action `exec_input`；敏感输入的 detail 不含值。
5. **凭据注入**
   - shared：`approvalKindSchema` 增加 `'secret'`；新增 `secretApprovalPayloadSchema`（`purpose` 等，不含值）；`approvals.decide` 输入增加可选 `secretValue`——只在内存中经 resolver 流转，**不写 `decision_json`**。
   - 迁移 `migrations/main/0013_p14_secret_approval.sql`：重建 approvals 表扩展 kind CHECK（沿用 0010 的 `approvals_new` 先例）。
   - 会话级缓存（`infra/keystore.ts`）：独立命名空间（服务 `kepcup`，账号 `secret:{conversationId}:{purpose 哈希}`）；卡片勾选「记住到本对话结束」时写入；**对话删除时清理**（接入删除级联）。
   - bash `secret` 参数执行流：exec 前查缓存 → 命中直接注入；未命中发起 `secret` 审批（无人值守走 `#autoDecideSync`，见任务 6）→ 批准后 spawn 并向 stdin 写入一行值；拒绝 / 自动拒绝 → 命令不执行，工具结果说明原因并引导非交互等价形式。审计 action `secret_granted`（不含值）。
6. **无人值守模式接入**（`permissions/approvals.ts` `#autoDecideSync`）
   - `secret` 分支：缓存命中 → 自动批准注入（记 `approval_auto` 审计）；未命中 → **同步**自动 denied（绝不 park loop）。
   - 开启弹框（`renderer/.../settings/UnattendedSection.svelte` + `i18n/locales/zh-CN.ts`）：自动批准清单加入凭据注入；新增警告行——无人值守期间凭据仅在已记住时可用；交互输入可能无人在场，命令将按空闲超时结束。
7. **非交互优先引导（L1）**
   - 工具结果引导：命令以非零退出或超时结束且输出尾部命中交互特征时，附加引导段——非交互等价形式清单（`--yes`、`DEBIAN_FRONTEND=noninteractive`、`sudo -S`、`ssh -o BatchMode=yes`、heredoc、`expect`）+「可用 interactive 重新执行 / secret 申请凭据」。疑似交互提示可不等到超时提前终止。
   - 系统提示词 `<access>` 段（`agent/context/system-prompt.ts`）补充：交互执行的可用性、红线（模型不可写 stdin；凭据用 `secret`）、降级路径提示。
8. **界面**
   - 步骤面板（`RunStatusLine.svelte` 展开区）：交互模式命令显示实时输出尾部（订阅 `exec.output`，节流渲染）与单行输入框；`suspectedPrompt` 时徽标提醒；Enter 发送、「敏感内容」开关（默认值跟随输出特征，用户可改）。
   - 凭据卡片（`ApprovalCard.svelte` 新变体）：掩码输入、「记住到本对话结束」开关、醒目风险提示；决定后折叠为一行记录（不含值）；ApprovalDock 键盘操作沿用。
   - 左栏「待确认」标记与系统通知：凭据申请按 pending 审批自然纳入（复用，不另做）。

## 接口与数据

- 迁移：`main/0013_p14_secret_approval.sql`（approvals kind 增加 `'secret'`；无新表）。
- shared：`approvalKindSchema`、`secretApprovalPayloadSchema`、`execOutputPayloadSchema`（事件）、`runsSendInputInputSchema`；bash 工具参数 schema（core 侧）。
- RPC：`runs.sendInput`。
- 事件：`exec.output`。
- 审计 action：`exec_input`、`secret_granted`。
- 删除级联：对话删除 → 清理该对话的钥匙串凭据缓存（approvals、run_steps 级联已有）。

## 测试要求

- 单元：
  - 疑似交互特征匹配正反例（`password`、`passphrase`、`[y/n]`、中文菜单、行尾 `?`；误报如 URL 中的 `?`、含 `选择` 的普通输出）。
  - 空闲超时：输出重置计时、用户输入重置计时、无输入到期 `killTree`。
  - 无人值守 `secret` 分支：缓存命中自动批准、未命中自动拒绝，均同步返回。
  - **敏感值零落地**：`sendInput(sensitive)` 与 `secret` 全流程后，messages、run_steps、approvals 行、audit_log、日志中均无值（DB 级内容断言）。
  - 凭据缓存命名空间、对话删除清理。
- 集成：
  - 交互模式：以 `read x && echo "got:$x"` 类脚本验证 stdin 直达与回执行；模型上下文含普通输入内容、不含敏感内容。
  - `secret` 全流程：卡片输入 → 注入成功（模拟 `sudo -S` 读 stdin 的脚本）→ 会话内第二次不再弹卡；拒绝 → 命令不执行且工具结果含引导。
  - 交互等待期间取消 run → 进程树终止、会话清理；应用重启 → 遗留交互会话消失、无挂起 `secret` 审批。
  - 降级：容器 / WSL / Windows 路径请求交互 → 非交互执行 + 结果注明。
  - 默认路径回归：非交互命令行为与 P02 一致（stdin 仍 ignore、EOF 快速失败不挂起）。
- 安全用例：本阶段条目全部通过（敏感值零落地为主线）。
- 端到端：步骤面板实时输出与输入流程；疑似提示徽标；凭据卡片输入、记住、折叠记录；无人值守开启弹框新警告。

## 验收标准

- [ ] 交互式命令不再静默失败或盲等超时：模型获得明确引导，并能以非交互等价形式或交互模式完成需要人介入的操作。 — 证据：PROGRESS.md P14 第 1 条
- [ ] 交互模式命令输出实时可见，用户输入直达进程 stdin；普通输入内容进入模型上下文与执行记录。 — 证据：PROGRESS.md P14 第 2 条
- [ ] 敏感输入与凭据值零落地：模型上下文、消息表、执行记录、审批行、审计、日志均无值（DB 级断言）。 — 证据：PROGRESS.md P14 第 3 条
- [ ] 凭据注入全流程：卡片掩码输入、会话级记住生效、批准后 stdin 注入成功、拒绝时命令不执行。 — 证据：PROGRESS.md P14 第 4 条
- [ ] 无人值守：有缓存自动注入、无缓存自动拒绝（同步返回）；开启弹框包含新增警告。 — 证据：PROGRESS.md P14 第 5 条
- [ ] 平台降级如实：WSL2 / 容器 / Windows 确认模式请求交互时降级并注明；默认非交互路径行为与 P02 一致。 — 证据：PROGRESS.md P14 第 6 条
- [ ] 取消与重启清理：交互等待中取消 run 终止进程树；应用重启后无遗留交互会话与挂起凭据审批。 — 证据：PROGRESS.md P14 第 7 条
- [ ] 本阶段测试全部通过（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）。 — 证据：PROGRESS.md P14 第 8 条

## 注意事项

- 敏感值零落地是本阶段的验收主线：任何持久化路径（消息、run_steps、审批行、审计、日志）不得出现值；既有 redact 管线与本阶段新增路径都要有断言。
- stdin 从 `'ignore'` 改 `'pipe'` **只发生在交互模式**：默认路径的 EOF 快速失败行为不得变化。
- 交互会话是内存态：与「重启即取消 pending」一致，不持久化、不恢复。
- 无人值守的 `secret` 自动拒绝必须同步完成（`#autoDecideSync` 语义），不得 park loop。
- 凭据缓存用独立 keychain 命名空间；Linux 沿用 Secret Service 限制（`keystore.ts` 现状），测试用 memory keystore。
- 引导文案要区分两种失败形态：能加 flag 的引导非交互化，必须人介入的才引导 `interactive` / `secret`，避免模型滥用交互模式规避非交互化。
