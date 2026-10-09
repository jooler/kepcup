# P03 授权与确认体系

## 目标

建立统一的审批机制（对话中的确认卡片），并实现软隔离的访问授权、沙箱外执行、逐条确认模式（沙箱不可用时）、只读命令白名单、无人值守模式、系统通知。之后所有需要用户确认的功能（git 远程操作、环境安装、技能导入、Profile 修改建议）都复用本阶段的审批机制。

## 依赖

P02。

## 设计依据

- [design/13-permissions.md](../../design/13-permissions.md)（全文）
- [design/06-isolation-and-storage.md](../../design/06-isolation-and-storage.md#执行隔离)（降级规则）
- [design/12-ui-layout.md](../../design/12-ui-layout.md#焦点三待确认卡片)（卡片交互）
- [03-data-model.md](../03-data-model.md)（approvals、grants、command_allowlist）

## 范围

包含：

- 审批框架：创建审批 → 对话中插入卡片消息 → 执行进入 `waiting_approval` → 用户决定 → 恢复执行；审批持久化；执行取消或中断时审批自动取消。
- 访问授权：文件工具访问范围外路径时自动发起；`request_access` 工具；有效期“仅这一次 / 本对话内一直允许”；授权只属于申请的 Bot + 当前对话；右栏授权列表与撤销。
- 沙箱策略接入有效授权（每条命令重新生成）。
- 命令被沙箱拦截时，工具结果中给出被拦截的路径，提示 Bot 可以用 `request_access` 申请。
- `request_unsandboxed`：沙箱外执行一条命令，每次确认，没有“一直允许”。
- 逐条确认模式：沙箱不可用时，每条命令确认后在沙箱外执行；Windows 使用 PowerShell（优先 `pwsh`，否则 Windows PowerShell）；界面持续提示。
- 只读命令白名单：内置默认条目、严格匹配、设置页管理。
- 无人值守模式：全局开关（设置页与托盘菜单）、危险确认弹框、定时关闭、自动批准、底线、审计与汇总、横幅与托盘状态。
- 系统通知：非无人值守模式下，有待确认审批且窗口不在前台时通知；点击通知打开对应对话。
- 左栏对话列表“有待确认”标记。
- `<access>` 系统提示词段；平台规则 6。

不包含：

- git 远程操作（P04）、环境安装（P06）、技能导入（P08）等具体审批类型：本阶段只实现 `access`、`unsandboxed`、`command` 三种，但框架必须支持按 `kind` 扩展卡片。

## 任务

1. **审批框架**（`permissions/approvals.ts`）
   - `requestApproval(identity, { kind, payload })`：写 approvals 表 → 写卡片消息（`kind = 'card'`，`content_json.approvalId`）→ 执行状态改为 `waiting_approval` → 返回一个在用户决定后兑现的 Promise。
   - `approvals.decide(approvalId, decision)`（RPC）：校验状态为 `pending` → 写决定 → 兑现 Promise → 执行恢复为 `running` → 推送 `approval.resolved`。
   - 无人值守模式开启时：直接以自动批准兑现，`auto_approved = 1`，写审计，不等待。
   - 执行被取消 / 中断 / Bot 被删除 / 对话被删除时，相关 `pending` 审批改为 `cancelled`，卡片更新为“已取消”。
   - 卡片内容由 `kind` 对应的渲染器生成；决定后折叠为一行记录（design/12-ui-layout.md）。
2. **访问授权**（`permissions/grants.ts`）
   - 网关 `checkPath` 增加授权判断：路径位于某条有效授权之下（授权 `path` 是目标的祖先或相同）且访问类型满足时为 `allowed`；否则为 `needs_grant`；`~/.kepcup` 永远 `forbidden`。
   - 网关 `ensurePathAccess`：`needs_grant` 时发起 `access` 审批，载荷含路径、读 / 写、原因（文件工具自动发起时，原因为“执行 {工具名} 需要访问该路径”）、是否敏感位置（卡片醒目警告）、“命令对该目录的改动不保证可回退”的说明（写入授权时）。
   - 批准“仅这一次”：授权绑定当前 `run_id`，执行结束失效；“本对话内一直允许”：直到撤销。
   - `grants.list(conversationId)`、`grants.revoke(id)`（RPC）；右栏展示。
3. **沙箱策略接入**：`policy.ts` 把有效授权加入 `readOnly` / `readWrite`；敏感位置被授权时才从 `denyRead` 中移除该路径。
4. **命令路径拦截反馈**：bash 结果中列出违规路径，并附一句提示“可调用 request_access 申请访问”。
5. **沙箱外执行**（`request_unsandboxed`）：审批卡片显示完整命令、工作目录、原因、醒目风险提示；批准后在沙箱外执行（环境变量只保留必要项，不注入任何密钥）；写审计。
6. **逐条确认模式**（`sandbox/confirm-executor.ts`）
   - 条件：`probe()` 返回不可用。
   - 每条命令：先做白名单匹配 → 命中且路径参数都在可访问范围内则直接执行 → 否则发起 `command` 审批，批准后在沙箱外执行。
   - 文件工具不受影响。
   - 界面横幅：“当前处于逐条确认模式：{原因}”。
   - 系统提示词 `<access>` 段注明当前是逐条确认模式与所用 shell（Windows 为 PowerShell）。
7. **只读命令白名单**（`permissions/allowlist.ts`）
   - POSIX：用 shell 解析库把命令解析为语法树（**需验证**选型，例如 `shell-quote` 不足以识别所有结构，优先选能输出 AST 的解析器）；按 [design/13-permissions.md](../../design/13-permissions.md#只读命令白名单) 的规则判断；无法解析一律不豁免。
   - Windows：只豁免**单条命令**（不含管道 `|`、`;`、重定向、`&`、子表达式 `$(...)`），内置条目为 `dir`、`type`、`Get-ChildItem`、`Get-Content`、`Select-String`、`Get-Location`，以及 `git status`、`git diff`、`git log`、`git show`。
   - 路径参数检查：从语法树中提取疑似路径的参数（不以 `-` 开头的参数），逐个做 `checkPath(read)`；有任何一个不是 `allowed` 则不豁免。
   - 设置页：列表、启用 / 停用、添加自定义前缀（提示“自定义条目可能不是只读的，风险由你承担”）、恢复默认。
8. **无人值守模式**（`permissions/unattended.ts`）
   - 状态存于 `settings.unattended`：`{ enabled, until?, enabledAt }`。
   - 开启弹框：列出将自动批准的操作类型（本阶段已有的三种，以及后续阶段加入的类型，列表由审批渲染器注册表生成），勾选“我了解风险”后才能确认；可选“手动关闭”或“N 小时后自动关闭”。
   - 自动批准的 `access` 授权一律按“仅这一次”处理。
   - 横幅（全局、醒目、带“关闭”按钮）与托盘图标状态（经端口 B 通知主进程）。
   - 关闭时或用户回到窗口时（窗口获得焦点且模式期间有自动批准记录），弹出汇总：按对话列出自动批准的操作，可跳转。
9. **系统通知**：核心服务经端口 B 请求主进程发送通知；主进程在窗口处于前台时不发送；点击通知打开窗口并切换到对应对话。
10. **界面**：卡片组件（访问授权、沙箱外执行、命令确认）；键盘操作（卡片获得焦点时 Enter 批准、Esc 拒绝，访问授权卡片用 1 / 2 选择有效期）；多张卡片逐张聚焦；左栏“待确认”标记；右栏授权列表。

## 接口与数据

新增表：`audit_log`（若 P02 未建）、`approvals`、`grants`、`command_allowlist`。

RPC：`approvals.list`、`approvals.decide`、`grants.list`、`grants.revoke`、`allowlist.list`、`allowlist.add`、`allowlist.update`、`allowlist.reset`、`unattended.get`、`unattended.enable`、`unattended.disable`、`unattended.summary`。

事件：`approval.created`、`approval.resolved`、`grant.changed`、`unattended.changed`、`sandbox.status`。

## 测试要求

- 单元：白名单匹配（大量正反例：管道、重定向、`find -exec`、`sed -i`、`git -c`、命令替换、变量赋值前缀、引号内的特殊字符、Windows 单条规则）；授权祖先判断；无人值守的底线。
- 集成：
  - 文件工具访问范围外路径 → 出现 `access` 审批 → 批准“仅这一次”→ 本次执行可访问、下次执行需重新申请；批准“本对话内一直允许”→ 后续执行可访问；撤销后不可访问。
  - 拒绝 → 工具返回 `APPROVAL_DENIED`，执行继续。
  - 授权只对申请的 Bot 与对话生效（同一 Bot 在另一对话中不可访问）。
  - 审批等待期间取消执行 → 审批变为 `cancelled`。
  - 应用重启 → 待确认审批为 `cancelled`，执行为 `interrupted`。
  - 模拟沙箱不可用 → 命令需确认；白名单命令直接执行；带路径参数且路径不在范围内的白名单命令需要确认。
  - 无人值守模式：三类审批全部自动批准并写审计；访问 `~/.kepcup` 仍被拒绝；定时关闭生效；自动批准的授权在执行结束后失效。
- 安全用例：本阶段条目全部通过。
- 端到端：卡片出现在输入区上方并获得焦点；键盘批准；卡片折叠为一行记录；右栏撤销授权；无人值守开启流程与横幅；汇总弹窗。

## 验收标准

- [x] Bot 访问 workspace 以外的文件时，对话中出现授权卡片，执行暂停且不消耗 token；批准后继续，拒绝后 Bot 收到拒绝结果并自行调整。 — 证据：PROGRESS.md P03 第 1 条
- [x] 授权有效期与归属符合 design/13-permissions.md。 — 证据：PROGRESS.md P03 第 2 条
- [x] 右栏可以看到并撤销当前对话的授权，撤销后立即生效（下一条命令的沙箱策略中不再包含）。 — 证据：PROGRESS.md P03 第 3 条
- [x] 沙箱外执行每次都需确认，卡片显示完整命令与风险提示。 — 证据：PROGRESS.md P03 第 4 条
- [x] 沙箱不可用的机器上（含 Windows），Bot 可以在逐条确认下执行命令；白名单中的只读命令不需要确认；界面持续提示逐条确认模式。 — 证据：PROGRESS.md P03 第 5 条（Windows 执行体在跨系统清单）
- [x] 设置页可以管理白名单，自定义条目有风险提示。 — 证据：PROGRESS.md P03 第 6 条
- [x] 无人值守模式开启需勾选风险确认；开启期间所有审批自动通过、横幅与托盘状态可见；`~/.kepcup` 仍不可访问；关闭后显示汇总。 — 证据：PROGRESS.md P03 第 7 条（含 BR-P03-001 修复后的命令路径底线用例）
- [x] 窗口不在前台时出现待确认审批，收到系统通知，点击后跳转到对应对话。 — 证据：PROGRESS.md P03 第 8 条
- [x] 左栏显示有待确认操作的对话标记。 — 证据：PROGRESS.md P03 第 9 条
- [x] 本阶段测试全部通过（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）。 — 证据：PROGRESS.md P03 第 10 条

## 注意事项

- 审批 Promise 不能只存在内存中而不落库：界面刷新、核心服务重启都要能恢复卡片状态（重启后为 `cancelled`）。
- 白名单宁可漏判（需要确认）也不能误判（放行了写入命令）。
- 无人值守模式是全局状态，修改它的 RPC 只能由界面调用，工具不能调用。
