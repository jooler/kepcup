# 59 并行写任务与任务间协调（Parallel Task Write Domains & Peer Coordination）

D75 把「只读无限并行 + 写串行」做了扎实：同一 cwd 同时最多一个写任务（任务层预拦截 + 目录写租约，[30 §5](30-supervisor-and-tasks.md#5-并发与写互斥)）。这个默认是安全的，但代价是把「同一目录、互不相交的子树上工作」的任务也串起来了——前端一个任务改 `apps/renderer/`，后端一个任务改 `packages/core/`，测试一个任务补 `test/`，三者本可以同时跑，现在排在一条队里。决策：**D123**。

外部对照（2026-11 调研，结论只作取向参考、机制不照搬）：

- **Claude Code**（agent teams + cross-session messaging）：teammates 同目录并行，靠「文件所有权约定 + SendMessage 消息通报 + 共享任务列表」协调，官方明确**没有文件冲突仲裁**，同文件编辑会互相覆盖；隔离建议是手动 git worktree。它的经验：纯 prompt 约定不防冲突，机器可查的所有权才是硬保障。
- **pi 社区 pi-messenger**（非官方扩展）：`reserve(paths)` 声明文件占用，其他 agent 写入时在工具钩子里拦截并提示去找谁协调；消息作为 steering 注入对方下一轮。它的经验：**声明式认领 + 写路径拦截**可以在引擎之上做成。
- **KepCup 的位置**：两者都要的能力（声明式互斥、写拦截、任务间消息、等终态）在 KepCup 已有一半现成设施——TaskHost 注入管道、`task_event` 持久时间线、`ask_user` 等待原语、影子仓库 interleaved 冲突检测。本文把它们补成一套，且**默认行为不变**：不声明写域的写任务维持现状（整 cwd 串行），并行只对显式声明互不重叠写域的任务生效。

相关：D29（写入租约，本文细化其粒度）、D30（影子仓库检查点，本文论证其不变）、D75（任务模型，本文修订其 §5 / §9.3 两条红线）、D91（`start_task` 参数）、D93（任务 harness）、D115（任务注入，本文复用其管道）。

## 决策

- **D123 并行写任务与任务间协调**：
  1. **写互斥的粒度从「整个 cwd」细化到「声明的写域」**。`start_task.writes` 从布尔升级为「布尔 | glob 集合」：`writes: true` = 整 cwd（现状语义，逐字节保留）；`writes: ['apps/renderer/**', 'docs/**']` = 声明写域；`writes: false` = 只读（不变）。两个写任务的写域（解析为绝对 glob 集合后）**不相交即可并行，相交仍串行**。判定在两处生效：TaskHost 派发预拦截（不重叠即不排队）与写租约键（租约层仲裁跨对话 / 与宿主伪身份的冲突）。
  2. **判定保守化：宁可错杀（多余串行），不可漏杀（漏判冲突）**。glob 语言相交判定按保守实现（§3.3）；判定不了的一律视为冲突。
  3. **执行期强制（内置引擎）**：文件写工具（write / edit 及一切经网关 `mode='write'` 的路径）按本任务写域硬拒域外写入（`WRITE_OUT_OF_DOMAIN`），fail-closed；沙箱命令按写域收紧可写挂载（能静态收紧的部分），无法静态覆盖的命令写入由影子仓库的 interleaved 冲突检测兜底并如实告知（§3.6）。
  4. **任务间协调最小面**：同（Bot, 对话）的兄弟任务获得 `send_to_task`（定向消息，steer 投递）、`wait_for_task`（等兄弟任务终态）与 `<peer_tasks>` 只读视野段（§4）。**仍然深度 1**：任务不能派任务；协调 ≠ 委派，派活与取消仍只属对话轮。
  5. **运行期认领（claim）**：任务可对自己写域内的路径子集做互斥认领，其他任务的写工具撞上认领即被拦（`WRITE_CLAIMED`，§5）。这是 pi-messenger 的 reserve/拦截机制的原生实现，粒度到路径、机器可查。
  6. **冲突兜底不变**：影子仓库 per-run 窗口与 interleaved 冲突检测、`isStale` hash 检测原样生效——写域与 claim 是**事前**防线，影子仓库是**事后**防线；域外写入（命令等）落进事后防线时按既有冲突语义处理。
  7. **worktree 仍不做**（[30 §9.1](30-supervisor-and-tasks.md#91-git-worktree-任务隔离明确不做) 四条理由全部继续成立）；真·并行写同一目录仍以「声明互不重叠的写域」为唯一形式，无声明（`writes: true`）的写任务行为与今日逐字节一致。
  8. **零新增设置条目**：并行与否完全由 Bot 的 `start_task` 声明驱动，不设全局开关（设置目录不动，符合 [38](38-conversational-settings.md) 的约定）。

## 1 交互示例

```text
用户：把前端、后端、测试三块并行推进
  → 对话轮 #1
      start_task({ title:'前端重构', writes:true, … })                  → 整 cwd（现状）
      start_task({ title:'后端改造', writes:['packages/core/**'], … })   → 与前端相交（前端是全域）→ 排队
      （<tasks> 段：t_a 前端重构 running；t_b 后端改造 排队中（等写域：t_a 持有 **））
      最终回复：说明并行受限，建议分域派活
  → 对话轮 #2（用户同意分域）
      cancel_task(t_a)
      start_task({ title:'前端重构', writes:['apps/renderer/**'] })
      start_task({ title:'后端改造', writes:['packages/core/**'] })
      start_task({ title:'补测试',   writes:['test/**', 'e2e/**'] })
      → 三个写任务并行（域两两不相交）；provider 名额内同时跑
  → 任务内：前端任务要动共享的 shared 包
      send_to_task(t_backend, '我需要改 packages/shared/src/types.ts 的 A 接口，你们谁要动？')
      → 后端任务收到消息（steer 进下一轮）；它 claim(['packages/shared']) 后回复
        「我在动 shared，等我 10:40 完成」
      → 前端任务 wait_for_task(t_backend, { timeout_minutes: 30 })
        → 后端 settle 后返回其终态与结果摘要，前端再动 shared（此时写域检查放行？不——
           shared 不在前端域内，写入仍被拒；前端在结果里说明，由对话轮改派或扩域）
```

示例暴露两条边界，均是有意设计：**写域是终审**——claim 与消息都改不了域外写入被拒的事实，越域需求的出口是 ask_user（对话轮改派 / 用户扩域，见 §3.7）而非任务自行越界；**claim 只约束「域内互斥」，不约束「域外可写」**。

## 2 写域声明与存储

- **工具契约（D91 修订）**：`start_task.writes: boolean | string[]`（TypeBox `Type.Union`）：
  - `true`：整 cwd，域 = `['**']`（与今日 `task_writes=1` 语义逐字节一致，租约与排队行为不变）；
  - `string[]`：相对 `cwd` 的 glob 模式，非空、去重后 ≤ `TASK_WRITE_DOMAINS_MAX`（8）、单条 ≤ `TASK_WRITE_DOMAIN_PATTERN_MAX`（200）字符，禁止绝对路径与 `..`（校验失败 `INVALID_INPUT`，列出违规项）；
  - `false` / 省略：只读，不变。
- **存储**：runs 迁移 `0015_task_write_domains.sql` 增列 `task_write_domains TEXT`（JSON 数组；`NULL` = 未声明，按 `writes` 解释）。shared `runSchema` 增 `taskWriteDomains: z.array(z.string()).nullable().default(null)`。声明原样存相对模式（展示友好），比较时经 `task_cwd` 解析为绝对模式。
- **`continues_task_id` 接续**：写域随简报继承来源任务的声明，接续任务可用自己的 `writes` 覆盖（校验规则相同）；`runs.retry` 沿用行上声明。
- **解析**：`TaskHost.start` 解析 `cwd`（workspace / workdir → 绝对路径，现有逻辑）后一并落库；声明在启动前校验，校验失败不落行、直接返回错误（先落盘再启动的不变量不覆盖校验失败）。

## 3 写域互斥

### 3.1 表示

任务的写域 = `{ root: task_cwd 绝对路径, patterns: string[] }`，比较时把每条模式拼成绝对模式 `root + '/' + pattern`。root 含公共前缀（如 workdir 与其子目录上的 grant 路径）由绝对模式的相交判定统一覆盖，不再单独立规则。

### 3.2 冲突判定（保守语义）

`globsIntersect(a, b)`：按路径段比较，存在任何路径同时匹配两模式即为相交。规则：

- 逐段比较；某模式先耗尽而另一模式还能继续匹配（含 `**` 可匹配零段的情形），视为可能相交；
- `**` 段与其后任意内容视作「匹配任意深度」，与一切后续段相交；
- `*` / `?` / 字符类在段内视为「可能同段相交」（不做字面交叉分析）；
- 段数不齐、含转义或本实现不支持的字面时，**一律判相交**（保守侧）。

实现为独立纯函数模块（含单测表，覆盖 `src/**` vs `src/a.ts`、`**` vs 任意、`a/*` vs `a/b/c`、`a/**` vs `b/**` 等边界），glob 匹配器复用保护规则（`denyRead`）现用的依赖，不新增依赖。判定不了的判相交——**假阳性（多余串行）可接受，假阴性（漏判冲突）禁止**。

### 3.3 TaskHost 派发预拦截

`#blockedBy`（`dispatch/tasks.ts`）的同 cwd 检查升级：写任务与其余**全部已启动写任务**（跨对话、跨 Bot，与今日 cwd 检查同口径）两两做「root 重叠 ∧ 域相交」判定，相交 → 停在 `submitted`，排队原因「等写域（任务 {id} 持有 {patterns}）」；不相交 → 放行（仍受对话级 / 全局 / 引擎名额约束）。`LaunchedTask` 增 `domains` 字段。

### 3.4 租约键升级

- `LeaseService` 的冲突谓词从硬编码的路径前缀规则改为**可注入**（缺省仍为今日前缀规则，其余调用方零改动）；写入路径传入域感知比较器。
- 写任务的租约键升级为结构化键 `{ root, patterns }`（编码为稳定字符串）；冲突 = 两键的绝对模式集合相交（§3.2）。一个 run 仍至多一个租约（`#byRun` 不变量不变，多模式编码在同一个键里）。
- 与**非任务持有者**（宿主伪身份、对话轮的自动租约、外部智能体 run）的冲突：它们的键是整根路径（无模式），即域 `['**']`，与任何域相交——域任务照旧被它们串行化，对话轮写 workdir 时域任务排队，语义与今日一致。
- `waiting_lease` / `lease.waiting` / `SlotYieldingLeaseService` / 强制收回语义全部不变；强制收回仍 = 持有方任务失去写权限（[30 §5.1](30-supervisor-and-tasks.md#51-规则)）。

### 3.5 调度名额

并发常量不动（对话 3 / 全局 8 / 单轮 2）。并行写任务各自持租约、优先级 0；[30 §5.3](30-supervisor-and-tasks.md#53-调度名额实现期细化) 的「已持租约的写任务在占用 < N 且任务合计占用 < N−1 时启动」规则原样适用——N=4 时两个并行写任务可同时跑，回复名额保护不变。**真正的并发上限通常是 provider 名额（默认 4）**，不是任务名额；文档向用户如实说明。

### 3.6 执行期强制（内置引擎）

- **文件工具**：网关 `checkPath`（`gateway/index.ts`，`mode='write'`）在只读判定之后增写域判定——run 声明了写域且目标路径（realpath 后）不匹配任何绝对模式 → 拒绝，错误码 `WRITE_OUT_OF_DOMAIN`，消息说明本任务写域与越域路径（提示经 `ask_user` 申请调整）。`coding-tools.ts` 的 `assertMayWrite` 同步纳入（前置拒绝路径），生成产物类写入（媒体文件卡等）走同一判定。
- **沙箱命令**：声明写域的任务生成沙箱策略时，可写挂载收紧到「workspace/workdir 的声明子路径 + 既有授权」，其余只读；策略系统不支持按子路径收紧的部分按现状整目录放行，并在任务的简报与失败摘要中如实注明「命令写入不受写域强制，冲突由检查点兜底」。能做到多少记入实施偏差（DEV），不静默放行也不虚构强制。
- **fail-closed**：run 行缺失、域声明解析失败、路径 realpath 失败 → 按拒绝处理。
- **外部智能体（ACP）**：执行期 per-path 强制**不可用**（引擎只有整 run 档位，[28](28-external-agents-acp.md)），降级为：写域随任务触发段注入提示（「本任务只应写……」），越域依赖 Agent 遵守 + 事后影子仓库冲突检测；权限桥（`permission-bridge.ts`）在 'ask' 档权限请求携带路径时对域外路径附提示性说明。写域对**调度与租约**在外部引擎上照常生效——这部分是强保证。

### 3.7 越域的唯一出口

任务发现需要写域外路径时：`ask_user` 说明缘由 → 对话轮（自动唤醒的轮次收到问题转交或用户点卡）决定改派 / 换域重派（`cancel_task` + `start_task`）。**不提供运行期扩域**——改写自己的权限边界是特权升级，一律回到对话轮。

### 3.8 检查点与回退不变（论证）

影子仓库按 run 记窗口（首改前 / 末改后快照），per-workdir mutex 串行化提交，与并行窗口在时间上交错不矛盾：域强制保证两任务的改动文件集合不相交，整次回退按各自 `run_changes` 恢复自己的文件，互不触碰；域外写入（命令）造成的文件相交由既有 interleaved 冲突检测标记并要求确认。workspace（无影子仓库）上域并行照常可用，事后防线只剩 `isStale` hash 检测，取消卡「无整次回退」的说明不变。

## 4 任务间协调

**范围**：同（Bot, 对话）的兄弟任务（v1 不跨 Bot——跨 Bot 的消息可见性要动私有时间线归属，列入 §8 开放决策）。任务看 `<peer_tasks>` 段获得兄弟任务的存在，然后可发消息、可等终态。

### 4.1 `<peer_tasks>` 视野段

任务 loop 的上下文在拼装处（`orchestrator.ts`，今日 `isTask ? '' : buildTasksSegment(...)`）改为：任务注入 `<peer_tasks>` 段，对话轮维持 `<tasks>` 段。`<peer_tasks>` 确定性生成、零模型调用，每行：

```text
<peer_tasks>
  [t_backend] 后端改造    running   写域 packages/core/** 
  [t_tests] 补测试        running   写域 test/**, e2e/**   等待用户输入
  [t_docs] 写文档         submitted 排队中（等写域：t_backend 持有 packages/core/**）
</peer_tasks>
```

不含自己、不含结果与进度文本（进度属于状态行 / 任务卡），标题包 `<untrusted>`。兄弟任务里**其他对话轮派出的任务**也列（同对话内任务本来就在 `<tasks>`/任务卡对用户可见，对同 Bot 的任务无新增泄露面）。

### 4.2 `send_to_task`

| 项 | 规定 |
|---|---|
| 参数 | `task_id`、`text`（≤ `TASK_PEER_MESSAGE_MAX_CHARS` 4000）、`source_message_ids?`（限本对话共享行，带原文同 `inject_task`） |
| 校验 | 目标是同（Bot, 对话）的非本任务、非终态任务；每 run 发送 ≤ `TASK_PEER_SEND_MAX_PER_RUN`（10）条（防刷屏） |
| 投递 | 复用 `TaskHost.inject` 管道：目标 `running` → `handle.steer()` 进下一轮（引擎同步拒绝 → 条目落为 `queued`，发送方的工具结果如实说明「已排队，待对方收尾前送达」——**不阻塞发送方、不重试**，与 `inject_task` 的异步拒绝降级同一语义）；目标 `submitted`（attach 前）→ 并入其待注入缓冲；目标等待 `ask_user` → **不作为回答**（回答只来自用户 / 对话轮），按普通注入排队 |
| 落盘 | 接收方写私有 `task_event`，phase 增 `'peer_message'`，内容 `{ taskId（接收方）, fromTaskId, fromTitle?, text }`；发送方的本次工具结果带回执（送达 / 排队） |
| 终态目标 | 抛 `TASK_PEER_FINISHED`（同步工具调用，无 at-least-once 需求；要「稍后告知」由对话轮经 `start_task` 交代） |

`peer_message` 条目进接收方 owner Bot 的私有时间线（owner 过滤既有规则照常生效，无新泄露面）；消息文本与来源标题在一切上下文渲染中包 `<untrusted>`（任务输出可能被带偏，同问题卡规则，[30 §2.4.6](30-supervisor-and-tasks.md#246-任务向用户提问)）。

### 4.3 `wait_for_task`

| 项 | 规定 |
|---|---|
| 参数 | `task_id`、`timeout_minutes?`（缺省 `TASK_PEER_WAIT_TTL_MS` 30 分钟，上限 120） |
| 校验 | 目标是同（Bot, 对话）的非本任务；已在等它 → `INVALID_INPUT`；等待图成环（A 等 B、B 等 A）→ 抛 `TASK_WAIT_CYCLE` 并列出环 |
| 等待 | 复用 `ask_user` 的等待原语：TaskHost 登记等待项，任务阻塞在该工具调用上；经 `Scheduler.yieldSlotWhile` 让出 provider 名额；等待时间不计 `maxWallMinutes`；写租约**保留**（同问题卡的理由：改到一半不能换人） |
| 返回 | 目标终态 → `{ status, resultDigest }`（结果全文按 `TASK_PEER_WAIT_RESULT_MAX_CHARS` 4000 截断，注明全文在任务卡）；目标被取消 / 失败 → 对应 `status` + 错误摘要；超时 → `{ status: 'still_running' }` 与目标当前排队原因，任务自行决定继续等（可再调）或绕行 |
| 唤醒 | `TaskHost.settle` 终态写入后解析等待项（先于投递钩子亦可，两者独立） |

等待注册表纯内存；崩溃恢复时等待中的任务按 D49 中断（它本来就 ephemeral），不补等待。

### 4.4 工具面与深度

- 四个新工具 `send_to_task` / `wait_for_task` / `claim` / `release` **只注册进任务工具面**；对话轮不注册（对话轮已能经 `inject_task` 触达任何任务，不需要等）。`start_task` / `inject_task` / `cancel_task` 在任务内仍一律 `NOT_SUPPORTED`——**深度 1 不动**，协调不等于委派。
- 任务版 `<platform_rules>` 增一段：先看 `<peer_tasks>` 再动手；域外写入会被拒，需要越域用 `ask_user`；动共享区前先 `claim`；完成或改道记得 `release`。

## 5 运行期认领（claim）

- **工具**：`claim({ paths, reason })` / `release({ paths? })`（`release` 不带参数释放全部）。`paths` 为相对 cwd 的 glob，≤ `TASK_CLAIM_PATHS_MAX`（16）条，**必须落在本任务写域内**（校验失败 `INVALID_INPUT`）；`reason` ≤ 200 字符。
- **登记**：TaskHost 内存认领表 `{ taskId, patterns, reason, since }`；settle / cancel / interrupt 时自动释放；不持久化（崩溃后任务中断重启，重认领是任务自己的事——认领是短命的协调状态，不是事实来源）。
- **强制**：文件写工具在写域判定之后查认领——目标路径匹配**其他任务**在重叠 root 上的认领 → 拒绝 `WRITE_CLAIMED`，消息含持有方任务 id、标题与 reason（引导去 `send_to_task` 协商）。同任务重复认领同路径幂等放行。
- **定位**：claim 解决「两个域任务要动同一域内文件」（如都要动 `packages/shared/**` 且都声明了它——声明期判定放行了，因为域相交本可分域，但共享包常常真要两边都碰）。它是**协调原语不是锁**：持有方霸占不释放时，对方经 `send_to_task` / `ask_user` 升级，用户可取消持有方任务（认领随 settle 释放）。
- **展示**：`TaskView` 增 `writeDomains` 与 `claims`，任务详情页显示（任务卡本期不加行，避免卡片膨胀）。

## 6 消息、提示词与界面

- **对话轮提示词**：派写任务时**尽量声明互不重叠的写域**（举例：按包 / 按目录 / 按文件）；声明不了清晰边界就 `writes: true` 排队（安全默认）；并行多任务受单轮 2 个上限，更多任务在结算唤醒的后续轮次派出；提醒对话轮：域任务的排队原因会出现在 `<tasks>` 段。
- **`<tasks>` 段**：任务行增「写域 …」（`writes: true` 显示「写（全域）」，只读不变）；排队原因新变体「等写域」。
- **任务卡 / 状态行**：排队原因字符串透传，渲染端零改动；任务详情页增写域与认领显示、`peer_message` 条目行（「来自任务 t_x：…」）。
- **i18n**：新错误码（`WRITE_OUT_OF_DOMAIN` / `WRITE_CLAIMED` / `TASK_PEER_NOT_FOUND` / `TASK_PEER_FINISHED` / `TASK_WAIT_CYCLE`）与新文案两语言同步。

## 7 修订的既有决策

| 决策 | 修订 |
|---|---|
| D29（写入租约） | 粒度细化：租约键支持 `{root, patterns}` 结构化域键，冲突 = 域相交；强制收回、FIFO、让名额语义不变 |
| D75 §5（同 cwd 一个写任务） | 改为「写域相交的任务至多一个在跑」；无声明（`writes: true`）退化为整 cwd，行为不变 |
| D75 §9.3（任务间通信列为非目标） | 移除该条：任务间**最小协调面**（消息 / 等待 / 认领）由本文建立；任务依赖图、任务树面板仍非目标 |
| D75 §2.4.5（任务之间互不干扰） | 补充：文件层面互不干扰由写域与 claim 保证；私有时间线仍互不可见，任务协调经显式工具留痕 |
| D91（`start_task` 参数） | `writes` 类型扩为 `boolean \| string[]` |

## 8 开放决策点

1. **跨 Bot 的任务协调**（项目组里两个成员 Bot 的任务直接互发消息）：需要双侧写 `task_event`（各自的 owner 视角各一条）与跨 Bot 信任规则；等真实需求出现再立项，v1 用「各自对话轮转告」替代。
2. **认领是否持久化**（崩溃恢复后自动重建）：等出现「长任务崩溃后认领丢失造成重复劳动」的真实案例再做。
3. **沙箱按子路径收紧的覆盖度**：实施时按三平台策略系统能力摸底，能做到的收紧、做不到的记 DEV 并如实展示，不为覆盖率牺牲安全语义。
4. **写域的运行期校验粒度**：是否对「读后写」的 `isStale` 命中额外提示「可能是兄弟任务改的」——低成本高价值，实施期顺带评估。

## 9 实施顺序

| 阶段 | 内容 | 为什么在这个位置 |
|---|---|---|
| **T1 写域地基** | glob 相交纯函数 + 单测表、迁移 0015、shared 类型与常量、`start_task` schema 与校验 | 先有机器可查的判定原语 |
| **T2 调度与租约** | `#blockedBy` 域判定、租约键结构化 + 可注入冲突谓词、排队原因 | 并行开闸前先有互斥 |
| **T3 执行期强制** | 网关 / 文件工具域判定、沙箱策略收紧（摸底）、外部引擎降级路径 | 有了互斥才有强制 |
| **T4 任务间协调** | `<peer_tasks>` 段、`send_to_task` / `wait_for_task`、`peer_message` phase、等待注册表与环检测 | 依赖 T1 的任务身份与域信息 |
| **T5 认领** | claim / release + 写路径拦截 + TaskView | 依赖 T3 的写拦截点 |
| **T6 提示词与界面** | 两版提示词、`<tasks>` 段写域、任务详情页、i18n | 用户可见面收尾 |
| **T7 文档收口** | 02 / 08 / 30 / README 的 D123 修订落字复核、`docs/dev/*` 同步、全量回归一次 | 收口 |

验收口径、文件归属与逐波测试清单见 [todo/parallel-tasks-and-coordination.md](../../todo/parallel-tasks-and-coordination.md)。

## 修订记录

- 2026-11-11：定稿（D123）。外部对照调研与现有设施盘点结论折入背景；`writes` 布尔语义保留为并行 opt-in 的安全默认。
