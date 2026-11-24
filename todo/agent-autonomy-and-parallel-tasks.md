# D140 Agent 自主性与任务并行（含 worktree 隔离）：执行方案

> 设计依据：[13-permissions](../docs/design/13-permissions.md)、[10-sandbox](../docs/design/10-sandbox.md)、[08-workdir](../docs/design/08-workdir.md)、[30-supervisor-and-tasks](../docs/design/30-supervisor-and-tasks.md) §5/§9.1、[59-parallel-tasks-and-coordination](../docs/design/59-parallel-tasks-and-coordination.md)、[28-external-agents-acp](../docs/design/28-external-agents-acp.md)。本文与设计冲突处，以本文 §1 的 D140 修订为准（§1.1 逐条列出被修订的既有决策）；其余仍以设计为准。
> 状态：**已执行**（2026-11-24，W0–W6 全部完成；提交与逐波记录见 §10）。
> 决策号：**D140**（公共决策表下一个空号；D139 属闭源团队服务器，不要复用）。

## 0. 给执行代理的规则（必读）

1. 开始前读：[AGENTS.md](../AGENTS.md)、[docs/dev/01-conventions.md](../docs/dev/01-conventions.md)、[docs/dev/02-architecture.md](../docs/dev/02-architecture.md)、[docs/dev/03-data-model.md](../docs/dev/03-data-model.md)、本文件全文、§1.1 列出的每个设计文档相关章节。
2. **一次性完成全部波次，中途不要停下来等确认**。遇到本文件未写明的决策点，按「长期收益最大化」自行选择，并在 §10 实施记录中写明选择与理由。
3. **主智能体只做调度，不写业务代码**。每一波：派 1–2 个开发子代理 → 完成后派 1–2 个**独立审查子代理**（只给它们本波的范围、改动文件与验收口径，不给开发过程）→ 审查子代理**直接修正**发现的所有问题（评审意见与修正都要回写 §10）→ 回写文档并提交 → 进入下一波。审查子代理的修正不需要再交回开发代理复核，但主代理要在提交前跑该波的定向测试。
4. 测试：迭代中只跑定向（`node scripts/run-tests.mjs run <文件或目录>`，可加 `-t "用例名"`；单包可 `pnpm --filter @kepcup/<包> test`）。全量 `pnpm test` 只在 **W6 收口时跑一次**。改动 shared 契约先 `pnpm --filter @kepcup/shared build`；类型检查按包 `pnpm --filter @kepcup/<包> typecheck`。
5. 设计冲突：若发现本文与代码现实冲突且无法按「长期收益最大化」就地解决，写 [docs/dev/DEVIATIONS.md](../docs/dev/DEVIATIONS.md)（下一条 **DEV-152**，之后顺延），继续不受影响的部分，不要停。
6. 提交：Conventional Commits（`feat(core):` / `feat(shared):` / `feat(desktop):` / `docs(design):` / `docs(dev):` / `test(...)`），中文摘要，一个提交可构建。文档回写单独 `docs(...)` 提交。
7. 代码与标识符英文；界面文案进 `apps/desktop/src/renderer/src/lib/i18n/locales/`，zh-CN 与 en-US 同步补齐。
8. 闭源目录 `apps/team-server/`：只读。**唯一**允许的改动是 `apps/team-server/server/src/policy/tool-policy.ts` 的 `KNOWN_TOOLS` 补一个工具名（W3），且该改动按 AGENTS.md「闭源目录」规则在私有仓内单独提交；不要复制私有仓内容进公开仓文件。
9. 红线（任何情况下不放宽）：
   - `~/.kepcup`（应用数据目录）永远不可访问；`paths.home` 的禁读在 W1 后仍然保留。
   - 只读 run（对话轮、`writes:false` 任务、只读子代理）不可写。
   - 显式写域任务的域外写入仍然硬拒（`WRITE_OUT_OF_DOMAIN`）。
   - 灾难命令守卫（`permissions/command-guard.ts`）与数据目录底线不因任何改动放宽。
   - 无人值守模式不得自动批准 `worktree_apply`（写用户主工作区）。

## 1. 决策与范围

### 1.1 本期四条决策（D140）

| 编号 | 决策 | 修订的既有决策 |
|---|---|---|
| **D140-1** | **写任务默认并行**：未声明写域的写任务不再按整目录互斥。所有内置引擎写任务改取**共享写租约**（可多任务同根并存），互斥下沉到**文件级自动认领**：任务首次写某路径时自动认领，其他任务写同一路径得到 `WRITE_CLAIMED`，用 `send_to_task` / `wait_for_task` 协调。只保留「外部智能体整根 run」与「宿主操作（revert / 应用）」的独占租约，它们与内置任务仍串行。**同时恢复 per-run 影子快照窗口**，用于结算改动摘要与并行任务改动交集检测（当前已退役，见 §2）。 | 修订 D123（设计 59 §3.1–3.4 的「域相交即排队」不再对内置任务生效；租约键与冲突谓词保留但语义改为共享/独占两态）、D75 §5（同 cwd 一个写任务 → 同 cwd 可多个共享写任务）、设计 08 §并发 |
| **D140-2** | **沙箱读宽写窄**：移除「整个用户主目录禁读」。沙箱内可读整机，仍禁读：应用数据目录 `~/.kepcup`、敏感位置清单（`sandbox/sensitive-paths.ts`）、workdir 保护规则 globs、worktree 副本上的同一套保护规则。**写范围逐字节不变**：显式 `denyWrite` 补回 srt 的默认可写便利路径（`~/.npm/_logs`、`~/.claude/debug`）。 | 修订设计 10「文件系统规则」、设计 13「默认可访问范围」的读侧表述、设计 06 执行隔离的读让渡描述 |
| **D140-3** | **污点 = 断网，不是逐命令弹卡**：对话处于污点期时，沙箱命令的**外网**被切断（保留 localhost / 开发服务器），不再为每条命令弹 `egress` 卡。模型需要联网时调用新工具 `request_network`，只弹**一张** `egress` 卡（时长：仅这一次 / 本任务内 / 本对话内），批准后允许外网（可限定主机）。污点窗口 24 小时 → **60 分钟滑动**。外部智能体（ACP）不受此机制影响，保持逐请求卡（宿主无法切断它自身的沙箱网络），文档如实说明。 | 修订 D73 P2 的「污点期间每条沙箱命令逐次确认」、设计 13 §授权/期、设计 29 §8.3 |
| **D140-4** | **worktree 隔离（opt-in，本期实现）**：`start_task({ isolation: 'worktree' })`。宿主在**工作目录的同级**创建 `.worktree/` 目录（即 `<workdir 父目录>/.worktree/`），每个任务一个 `git worktree`（detached HEAD，起点 = 用户当前工作区状态含未提交改动）。该 worktree 成为任务执行根（`task_cwd`），**默认对该 Bot 可读可写、不经授权卡**。任务结束后生成「应用到工作目录」卡，由宿主以三方合并方式应用回用户工作区；冲突则保留 worktree。 | **推翻**设计 30 §9.1「git worktree 任务隔离（明确不做）」的四条理由中的第 1、2、3 条（写用户 `.git` 改为宿主在沙箱外精确受控写入；路径门禁改为「一个 workdir + 可选 worktree 根」；检查点改为 worktree 用 git diff、主工作区应用前快照）；第 4 条（新 worktree 开箱即废）以 `.worktreeinclude` + 如实告知应对。同步修订设计 59 §7「worktree 仍不做」、设计 02 §执行、设计 41 §worktree 评估 |

### 1.2 本期纳入的配套（同属「减少弹卡」，与 D140-3 同批改审批管线）

- **`task` 审批时长**（「本任务内允许」）：`approvalDurationSchema` 与 `grantDurationSchema` 增 `task`；作用于 `access`、`agent_tool` 路径请求、`egress`（网络授权）。语义：有效期到**该 run 结束**（`runs` 行终态），跨该 run 的多次工具调用有效，不跨任务/接续/子 run（子 run 是新 run，需要自己的授权）。
- **多路径 access 卡**：一条命令被沙箱拦截多个路径时，合并成**一张**卡（`paths: [{path, access}]`），批准后逐路径建 grant。当前是每路径一张卡（`coding-tools.ts` 的 `for (const violation of blocked)`）。

### 1.3 明确不做（写进设计文档的「非目标」，不要顺手做）

- **per-workdir 持久化默认权限档**：`manual` 目前是「无 entry」，持久化需要三态 + 新的 `source` + 团队 ceiling 在读路径夹紧，属独立决策。本期不动 `permissions/mode.ts` 的持久化语义。
- **模型审核代理**（对升级请求用小模型审核）：大工程，后续独立决策。
- **自动授权档扩面**（`AUTO_APPROVED_KINDS` 增加命令/MCP）：安全姿态变更，不做。
- **worktree 的 setup 脚本**（如 `.cursor/worktrees.json` 那种自动安装依赖）：本期只支持 `.worktreeinclude` 复制忽略文件；任务可能需要在 worktree 里自行安装依赖，如实告知。
- **worktree 内 `git_remote`**：worktree 任务的 push/pull/fetch 一律拒绝（`INVALID_INPUT`，提示先应用到工作目录再推送）。原因：worktree 是 detached HEAD，推送语义不明且会与主检出交叉。
- **外部智能体在 worktree 中运行**：`isolation:'worktree'` 仅内置引擎支持；ACP 引擎派发时返回 `INVALID_INPUT`（引擎的 cwd/租约/权限桥耦合未验证，见 §8）。
- **对话轮并行**：对话轮仍只读、不取写许可。

## 2. 已核实的现状（改动依据，行号以当前工作树为准）

> 以下每条都经过代码核对；执行时如行号漂移，按语义定位。

### 2.1 权限与审批

- 三档 `manual` / `auto` / `bypass`，内存态；`auto` 只自动批准 `access` / `environment` / `skill_import` / `skill_preset`（`packages/core/src/permissions/tiers.ts:8-20`）。
- `access` payload 单路径：`accessApprovalPayloadSchema`（`packages/shared/src/domain/types.ts:2602-2610`）。卡片消息只带 `{cardType, approvalId, record}`，payload 在 `approvals.payload_json`，渲染端经 `approvals.list` / `approval.created` 读（`approvals.ts:1544-1576`）。
- **时长校验集中在 `decide()`**（`approvals.ts:690-727`）：`task` 不在现有分支里，会被静默接受；`access` 分支 `:720-727` 直接拒绝非 `once/conversation`。必须改这里。
- `#afterResolution` 不做副作用（`approvals.ts:809-819`）；建 grant / 写 egress 允许都在**调用方**（`gateway/index.ts:792-813`、`:884-891`、`:1261-1283`、`:1565-1583`；`permission-bridge.ts:1003-1038`）。
- `grants` 表 `duration TEXT CHECK (duration IN ('once','conversation'))`（`migrations/main/0004_p03_permissions.sql:21-33`）→ 加 `task` 必须重建表。
- `grants.listEffective` 只认 `conversation` 或 `once && runId 匹配`（`grants.ts:182-191`）；`expireForRun` 只删 `once`（`:332-345`）；`revokeByUser` 只对 `once` 带 `runId`（`:272-273`）；`noteOnceUse` 非 once 直接返回（`:228-242`）。
- access 卡时长按钮与键盘是**硬编码两个**（`ApprovalCard.svelte:739-760`、`:396-428`）；`agent_tool` 卡同（`:1156-1179`）；`mcp_tool` / `egress` / `git_remote` / `computer_control` 按 `payload.durations` 动态渲染。
- `APPROVAL_DURATION_LABEL_KEYS` 是 `Record<ApprovalDuration, MessageKey>`（`features/approvals/mcp-approval.ts:12-17`）→ 枚举扩了必须补，否则 typecheck 失败。
- 沙箱 bash 失败后每路径一张卡：`coding-tools.ts:550-585`；`ensurePathAccess` 单路径（`gateway/index.ts:722-815`）。
- `approvals` 表 kind CHECK 需重建才能加新 kind（最新重建 `migrations/main/0062_computer_control.sql:4-27`）；测试 `egress-migration.test.ts:82-93` 钉住全表 kind。

### 2.2 污点与网络

- `APP_TAINT_TTL_MS = 24h`（`packages/shared/src/constants.ts:188`）；`TaintService.mark` 每次置位/续期都**清空该对话全部 `egress_allows`**（`apps/taint.ts:67-69`）；污点是对话级，来源除连接应用外还有邮件 / IM（`mail/service.ts:896` 等，`start.ts:1513-1524`）。
- `egress_allows` 表 `PRIMARY KEY(conversation_id, scope)`，`scope` 是 `'all'` 或 `'cmd:<sha256>'`（`migrations/main/0043_egress_allow.sql:8-14`）——`scope` 无 CHECK，可直接编码新语义，**不需要迁移**。
- `egressCheck` 当前只有 `once` / `command`（bash）/ `conversation` 三个时长（`gateway/index.ts:867-868`），且「本对话内」写 `all`、「相同命令」写 `cmd:`（`:884-891`）。
- 污点期间沙箱 bash 的拦截在 `gateway/index.ts:964-981`，条件 `req.network.mode === 'open'`；bypass 分支在 `:937-963`，**没有污点条件**（必须补）。
- srt 只有**全局**网络配置，文件系统规则按命令（`backend-srt.ts:132-152`、`:384-432`）；`none` 与 `allowlist+空域名` 等价（`strictAllowlist: true` + `allowedDomains: []`），`allowLocalhost` 会移除 loopback 拒绝并设 `allowLocalBinding`（`:58-78`）。
- 网络拦截可从 violation 行识别：`deny network-outbound <host>:<port> (...)` / `deny http-request ...`；现有解析只认文件路径（`coding-tools.ts:295-326`），网络行只出现在原始样本块（`:494-498`）。

### 2.3 沙箱读范围

- `denyRead = [userHome, paths.home, ...sensitivePaths]`（`sandbox/policy.ts:108-116`）；`.CFUserTextEncoding` 的重开只因为主目录被禁（`:110-116`）。
- srt 在 home 未被禁读时会自动允许写 `~/.npm/_logs`、`~/.claude/debug`（`node_modules/.pnpm/@anthropic-ai/sandbox-runtime@0.0.78/.../dist/sandbox/sandbox-utils.js` 的 `getDefaultWritePaths`）→ 读宽后必须显式 `denyWrite`。
- 增强后端：Lima 在 VM 内跑 srt（策略生效）；**Podman / WSL 是挂载式，读宽不适用**；confirm 模式无读限制。文档要写清。

### 2.4 任务、租约、认领

- 未声明写任务按 `['**']` 与一切写任务冲突：`tasks.ts:3160-3173`；队列原因「等写域」`:3140-3145`、`:3194-3200`。
- 写任务在 `orchestrator.ts:4064-4089` 取 **pinned 独占租约**（`domains: task.taskWriteDomains`，null = 整根）。
- 沙箱把 workdir 挂成读写**只看 `policyInfo.hasLease`**（`workdir/service.ts:310-325`、`sandbox/policy.ts:134-149`、`gateway/index.ts:1003-1019`）——这是并行改造的第一约束。
- `LeaseService` 一个 run 一个键（`workdir/lease.ts:35-45`），冲突谓词可注入（`:46-55`），`#holders` 是 `Map<string, Holder>`（单持有者）。
- 认领只对**同（Bot, 对话）**生效（`workdir/claims.ts:67-83`）；`#domainBlocker` 是跨对话全局的。并行后必须把认领扩到「同一根下所有任务」。
- 写入路径覆盖：文件工具 / mkdir / 生成产物 / 附件复制 / 输出落盘都过网关；**bash、浏览器下载、外部智能体写入不经网关**（`coding-tools.ts:470-590`、`tools/browser.ts:300,346`、`permission-bridge.ts:656-679`）→ 自动认领覆盖不到，如实说明。
- 影子仓库：`snapshot` 生产调用点只有 `revert`（`workdir/service.ts:736`）；正常任务不再快照、不写 `run_changes`（`:131-137`、`:447-454`）；`interleaved` 无写入方（只被读 `:694-696`）。**D140-1 要恢复**。
- `run_changes` 由 `WorkdirsService` 持有（`domain/workdirs.ts:207-233`），`run_id` 主键 + `workdir_id` 外键（`migrations/main/0005_p04_projects.sql:13-22`）。

### 2.5 worktree 的四个致命耦合

1. **命令 cwd 不在请求里**：`GatewayExecRequest` 无 cwd（`gateway/index.ts:231-239`），`exec` 用 `policyInfo` 的 workdir（`:920-925`），bash 工具丢弃自己的 cwd（`coding-tools.ts:470-479`）。
2. **保护规则按主 workdir 前缀匹配**（`workdir/service.ts:931-951`；`denyReadGlobs` `:328-345`）→ worktree 副本上的 `.env` 会变成可读（设计 30 §9.1 点名的问题）。
3. **租约目标选择不认识 worktree**（`workdir/service.ts:850-885`），会抛 `INVALID_INPUT`；沙箱只接受一个 workdir（`sandbox/policy.ts:11-18, 134-156`）；增强后端拒绝未注册挂载（`start.ts:1754-1766`、`backend-container.ts:151-159`）。
4. **worktree 内的 git 操作要写主仓 `.git/worktrees/<name>/`**（index/locks/HEAD/logs），同时 `.git/config`、`.git/hooks` 继续禁写（`gateway/index.ts:155-190` 的 `isGitControlPath` 已识别 `.git` 指针文件与 `worktrees/<n>/gitdir`）。

其他：`#untrustedRoots` 未含 worktree（`gateway/index.ts:1151-1159`）；上下文注入用绑定 workdir（`orchestrator.ts:5432`、`workdir/service.ts:816-836`）；`git_remote` cwd 固定 workdir（`service.ts:804-809`）；retry 盲拷 `taskCwd`（`tasks.ts:2480`）；continuation 重新 `resolveCwd`（`:1004`）；`cwdKind` 只有 `workdir|workspace`（`shared/domain/types.ts:3978-3979`）；C9 `assertInRoots` 只覆盖 select 与 ACP gate（`service.ts:520`、`orchestrator.ts:3909`）。

## 3. 契约（必须原样落成代码；与代码现实冲突时记 DEV 并停该部分）

### 3.1 shared 类型与常量

`packages/shared/src/domain/types.ts`：

```ts
// 1) 审批时长：增 task（「本任务内允许」）
export const approvalDurationSchema = z.enum(['once', 'task', 'conversation', 'bot', 'command']);
// 2) 授权时长：增 task。grantDurationSchema 的注释里「不要直接扩展它」改为说明 task 的 run 作用域
export const grantDurationSchema = z.enum(['once', 'task', 'conversation']);
// 3) access payload 支持多路径（保留单路径字段兼容历史行）
export const accessApprovalPayloadSchema = z.object({
  path: z.string().optional(),          // 历史行 / 单路径
  access: grantAccessSchema.optional(),
  paths: z.array(z.object({ path: z.string(), access: grantAccessSchema })).optional(),
  reason: z.string().default(''),
  sensitive: z.boolean().default(false),
  durations: z.array(approvalDurationSchema).optional(), // 新卡都带 ['once','task','conversation']
});
// 4) egress 新通道
export const egressChannelSchema = z.enum([...现有, 'network']);
// 5) agent_tool payload 的 durations 允许 task（原为 grantDurationSchema 数组）
//    改为 z.array(approvalDurationSchema).default(['once']) 会更宽松；保持 grantDurationSchema 即可（已含 task）
// 6) runs：隔离方式
//    runSchema 增：isolation: z.enum(['worktree']).nullable().default(null)
//                  worktreePath: z.string().nullable().default(null)
//                  worktreeBase: z.string().nullable().default(null)   // base commit oid
// 7) TaskView：cwdKind 增 'worktree'；增 worktreePath: z.string().nullable().default(null)；
//    增 applyState: z.enum(['none','pending','applied','conflict','kept']).default('none')
// 8) ApprovalKind 增 'worktree_apply'
```

`packages/shared/src/constants.ts`：

```ts
export const APP_TAINT_TTL_MS = 60 * 60_000;                 // 24h → 60min（滑动续期语义不变）
export const TASK_START_MAX_PER_TURN = 4;                    // 2 → 4
export const TASK_CONCURRENCY_PER_CONVERSATION = 6;          // 3 → 6（全局 8 不变）
export const WORKTREE_DIR_NAME = '.worktree';
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
export const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60_000;   // 孤儿回收
export const WORKTREE_PATH_MAX = 200;
export const TASK_AUTO_CLAIM_MAX = 5000;                     // 单 run 自动认领路径上限
```

`packages/shared/src/errors.ts` 新增：

```ts
'WORKTREE_CREATE_FAILED'   // worktree 创建失败（git 不可用 / 不是仓库 / 路径冲突）
'WORKTREE_APPLY_CONFLICT'  // 应用到工作目录时三方合并冲突
'WORKTREE_NOT_AVAILABLE'   // 任务没有 worktree / worktree 已被回收
'NETWORK_BLOCKED'          // 污点期外网被切断（工具结果用；对应 request_network）
```

### 3.2 迁移

**`packages/core/migrations/main/0083_d140_approvals_grants.sql`**（一个事务，三件事）：

```sql
-- 1) grants 重建：duration CHECK 增 task
CREATE TABLE grants_new (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','write')),
  duration TEXT NOT NULL CHECK (duration IN ('once','task','conversation')),
  run_id TEXT, approval_id TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER);
INSERT INTO grants_new SELECT id,bot_id,conversation_id,path,access,duration,run_id,approval_id,created_at,revoked_at FROM grants;
DROP TABLE grants; ALTER TABLE grants_new RENAME TO grants;
CREATE INDEX grants_active ON grants(conversation_id, bot_id) WHERE revoked_at IS NULL;

-- 2) approvals 重建：kind CHECK 增 worktree_apply（列出全部既有 kind，照抄 0062）
--    列与索引照 0062_computer_control.sql:4-27，仅 kind 列表加 'worktree_apply'
```

**`packages/core/migrations/runs/0018_task_worktree.sql`**：

```sql
ALTER TABLE runs ADD COLUMN task_isolation TEXT;      -- NULL | 'worktree'
ALTER TABLE runs ADD COLUMN task_worktree_path TEXT;
ALTER TABLE runs ADD COLUMN task_worktree_base TEXT;
```

`egress_allows` **不加迁移**：`scope` 无 CHECK，新语义用字符串编码（见 §3.4）。

迁移测试：仿 `packages/core/test/unit/workdirs-rename-migration.test.ts` 的 `mainVersionsAfter(...)` 写法，不要写死「最新号」；补 `grants.duration` CHECK 接受 `task`、`approvals.kind` 接受 `worktree_apply` 的断言。同步 `docs/dev/03-data-model.md` 的 grants / approvals / runs 表。

### 3.3 共享写租约（D140-1 的核心契约）

`packages/core/src/workdir/lease.ts` 改造：

```ts
interface LeaseHolder { runId: string; botId: string; conversationId: string; shared: boolean }
// #holders 从 Map<string, LeaseHolder> 改为 Map<string, LeaseHolder[]>
acquire(identity, key, hooks: { shared?: boolean; ... })
```

冲突判定（唯一规则）：

- `#conflict(heldKey, key)` 为真，且 **不是**「双方都 shared」→ 冲突。
- 即：共享 × 共享 = 共存；共享 × 独占 = 冲突；独占 × 独占 = 冲突（现状）。
- `conflictingHolder(key)` 返回第一个冲突持有者（共享也可能被返回，用于等待与强制收回）。
- `release(runId)` 删除该 run 在该键下的持有者；键下无持有者则删除键并 promotion。
- `heldKey(runId, keys)` / `keyOf(runId)` 语义不变（一个 run 仍最多一个键）。
- `forceRevoke(key)` 删除该键下所有持有者（测试用）。

**谁取共享**：所有内置引擎写任务（`loopType==='task'` 且 `taskWrites===true`），无论是否声明写域。
**谁取独占**：外部智能体任务（`#agentWorkdirGate`）、宿主操作（legacy `revert`、worktree apply）、非任务的 `acquire_workdir_write`（保持独占，避免宿主动作与任务交错）。

`workdir/service.ts`：

- `ensureWriteLease(..., { shared, pin, domains })` 透传 `shared`。
- `holdsLease(identity, root)` 改为「该 run 在 root 上有共享或独占持有」。
- `revokeLease(conversationId)`（用户「强制收回」）→ 找到该对话内**内置写任务**的共享持有并释放 + 加入 `#revokedPinned`（后续写入 `RUN_READ_ONLY`）；若无内置任务持有则退回找 `conflictingHolder`。
- `policyInfo(identity)` 增 `cwd: string | null`（见 W5：worktree 任务返回 worktree 根）。
- `writeOutOfDomain` / `writeDomain` 不变（域任务仍硬拒域外）。

`dispatch/tasks.ts`：

- 删除 `#domainBlocker` 与「等写域」队列原因；`#blockedBy` 只保留并发额度与引擎名额。
- `LaunchedTask.domain` 保留（仅用于 `<peer_tasks>` 的写域展示），不再参与准入。
- `wait_for_task` 的「等自己的写域」守卫（`:1412-1419`）删除。
- `TaskView.queueReason` 不再出现「等写域」；`等写入租约` 保留（仅当独占持有者挡路，例如外部智能体任务）。

`orchestrator.ts` `#startTask`：`ensureWriteLease(..., { pin: true, shared: true, domains })`。

### 3.4 污点断网与网络授权（D140-3 契约）

`gateway.exec`：

```ts
const taint = this.taintOf(identity);
const networkAllowed = taint !== null && this.#deps.taint.networkAllowed(identity, workdir?.path ?? null);
const effectiveNetwork = networkAllowed || taint === null
  ? req.network
  : { mode: 'none', allowDomains: [], allowLocalhost: workdir !== null, allowedPorts: workdir?.allowedPorts };
```

- bypass 分支条件追加 `taint === null`（污点期不得脱离沙箱联网）。
- 删除 `:964-981` 的逐命令 `egressCheck`（含 `#builtinExempt` 的调用；`#builtinExempt` 若不再被用则删除）。
- 把 `effectiveNetwork` 传给 `buildSandboxPolicy`。

`apps/taint.ts` 新增：

```ts
type NetworkAllowScope = 'all' | { command: string } | { task: string } | { once: string };
allowNetwork(identity, scope: 'once'|'task'|'conversation', expiresAt: number): void
networkAllowed(identity, ...): { hosts?: string[] } | null   // null = 未允许
consumeOnceNetwork(identity): void                            // 命令实际使用一次后消费
expireNetworkForRun(runId: string): void                      // run 结束清理 task/once
```

`egress_allows.scope` 编码（不加迁移）：

- 本对话：`all`（沿用；`networkAllowed` 读它）。
- 本任务：`task:<runId>`。
- 仅这一次：`once:<runId>`（`networkAllowed` 命中后由 gateway 在命令启动前 `consumeOnceNetwork` 删除）。
- 有效期：所有 scope 的 `expires_at` 取 `min(now + 时长, taint.expiresAt)`；`mark()` 仍清空全部（重新读取应用数据后旧网络授权失效，符合 D73 语义）。

`request_network` 工具（`packages/core/src/tools/index.ts`，紧邻 `request_access`）：

```
name: 'request_network'
params: { hosts?: string[]; reason: string }
描述：当前对话处于污点保护期，沙箱命令的外部网络已被切断（本机端口不受影响）。需要联网时调用本工具申请：
批准后按所选时长（仅这一次 / 本任务内 / 本对话内）放开外网；hosts 填要访问的主机（省略 = 任意主机）。
任务里每张卡只弹一次；不要为绕过限制改用其他工具。
```

网关方法 `requestNetworkAccess(identity, { hosts, reason })`：

- 无污点 → `{ ok: true, already: true }`。
- 已有 `all` / `task:<runId>` / `once:<runId>` → `{ ok: true, already: true }`。
- 否则建 **一张** `egress` 卡：`channel: 'network'`、`target` = hosts 列表或「任意外部主机」（脱敏 + 截断）、`durations: ['once','task','conversation']`。
- 批准 → `allowNetwork`；拒绝 → 工具返回 `APPROVAL_DENIED` 文案。
- 对话轮 / 子代理 / 只读 run → 直接 `RUN_READ_ONLY`（不等待，与 `egressCheck` 现状一致）。

沙箱侧 host 限定（本期简化，写进文档）：`hosts` 非空时把 `effectiveNetwork` 设为 `{ mode: 'allowlist', allowDomains: hosts, allowLocalhost, allowedPorts }`；为空时 `{ mode: 'open', ... }`。注意 srt 网络配置是**全局**的（切换会 drained），这是已知限制，§8 如实记录。

`coding-tools.ts` 违规提示：新增

```ts
const NETWORK_VIOLATION_PATTERN = /\bdeny (?:network-outbound|http-request)\b/;
```

命中时在 notes 里追加：「外部网络被污点保护切断。需要联网请调用 request_network（仅这一次 / 本任务内 / 本对话内），批准后重试。」文件路径提示逻辑不变。

### 3.5 多路径卡与 `task` 时长（D140-3 配套契约）

`gateway/index.ts` 新增批量入口，`ensurePathAccess` 改为其单路径封装：

```ts
async ensurePathAccessBatch(identity, items: Array<{ path, mode, reason }>, options: { signal?, preauthorize? })
  : Promise<{ resolved: string[]; denied: Array<{ path, reason, expired }> }>
```

- 只对 `needs_grant` 的项建卡；`forbidden` / `needs_lease` 逐项按现有语义抛出或取租约（取租约仍逐项，不进卡）。
- 一张卡：payload `{ paths: [{path, access}], reason, sensitive: any(sensitive), durations: ['once','task','conversation'] }`。
- 批准后逐路径建 grant（同一 duration），逐路径 `noteOnceUse`（`once` 时）；一次 `grant.changed`。
- `coding-tools.ts:499-585` 改为：收集全部 `needs_grant` 路径 → 一次 `ensurePathAccessBatch` → 结果按路径分 `granted` / `refused` 提示。

`decide()` 时长校验（`approvals.ts:690-727`）改为：

```ts
const allowedFor: Partial<Record<ApprovalKind, ApprovalDuration[]>> = {
  access: ['once', 'task', 'conversation'],
  agent_tool: ['once', 'task', 'conversation'],
  egress: ['once', 'task', 'conversation', 'command'],
  mcp_tool: ['once', 'conversation', 'bot'],
  git_remote: ['once', 'conversation', 'bot'],
  computer_control: ['once', 'conversation', 'bot'],
};
// 不在表里或不在 payload.durations 里 → 降级 once；access 的 task 若不在 offered 里 → 降级 once
```

`grants.ts`：

- `Grant['duration']` 含 `task`；`create` 不为 `task` 排 TTL 定时器。
- `listEffective`：`g.duration === 'task' && g.runId === identity.runId`（不看 tool-call scope）。
- `expireForRun(runId)`：`duration IN ('once','task')`。
- `revokeByUser`：`once` **与** `task` 都带 `runId`（撤销 task 授权只中断该任务）。
- `noteOnceUse`：非 `once` 直接返回（现状已满足）。
- 右栏授权列表的时长文案增 `task`（`RightPanel.svelte:959-961`）。

`permission-bridge.ts`：

- `#decidePaths` 的 `durations`：非 `targetUncertain` 时为 `['once','task','conversation']`。
- `#grant`：接受 `task`（`duration='task'`，`runId: identity.runId`，逐 location 建 grant），同时回答本次 allow；`bot` / `command` 仍拒绝。

### 3.6 worktree（D140-4 契约）

**命名与位置**（用户已定）：

```
<workdir 父目录>/.worktree/<workdir basename>-<runId 后 8 位>/
例：workdir=/Users/x/www/kepcup → /Users/x/www/.worktree/kepcup-3f9a1c2d/
```

- `.worktree/` 首次创建时写一个 `.gitignore`（内容 `*`），目录权限 0700。
- 路径上限 `WORKTREE_PATH_MAX`；父目录必须存在且可写；同名残留 → 追加随机后缀，不覆盖。

**创建**（宿主、沙箱外、`start_task` 落库之后、调度之前）：

1. 校验：`isolation:'worktree'` 只允许 `cwd` 为 `workdir`（或省略且已绑定）、workdir `status==='available'`、`git rev-parse --git-dir` 成功、不是 bare。
2. `.worktree` 根加入 C9 允许根（`assertInRoots`），并把 worktree 根登记进增强后端的允许挂载（或本期强制走 srt，见 §8）。
3. 起点：`git -C <workdir> stash create` → 输出 oid（无改动则用 `HEAD`）；`git -C <workdir> worktree add --detach <path> <oid|HEAD>`。
4. 复制 `.worktreeinclude` 列出的忽略文件（gitignore 语法；只复制被忽略且存在的；不覆盖已有文件；跳过符号链接）。
5. 记录：`task_isolation='worktree'`、`task_worktree_path`、`task_worktree_base=<oid>`、`task_cwd=<path>`。
6. 任一步失败 → 清理半成品（`git worktree remove --force` + `prune`）→ 任务失败 `WORKTREE_CREATE_FAILED`，错误信息带 git 输出摘要。

**执行期**：

- 租约：`ensureWriteLease(identity, <?> , { pin:true, shared:false })`——worktree 任务取**独占**租约，键为 worktree 根（`#leaseTarget` 新增：若 `task.taskCwd` 是 worktree 根或在其中 → 返回 `task.taskCwd`）。独占只影响同一 worktree（一个任务一个），与主 workdir 的共享租约不冲突 → 天然并行。
- 调度 `#blockedBy`：`domain = { root: worktreePath, patterns:['**'] }`，与主目录任务根不重叠 → 不排队。
- 沙箱（新增 `buildSandboxPolicy` 入参 `taskWorktree`）：

```ts
taskWorktree?: { path: string; gitCommonDir: string /* <workdir>/.git */; gitWorktreeMeta: string /* .git/worktrees/<name> */; denyReadGlobs: string[] }
```

  - `readWrite` 增 `taskWorktree.path` 与 `taskWorktree.gitWorktreeMeta`（精确子目录；**不**放行 `.git` 其余部分）。
  - `readOnly` 增主 `workdir.path`（只读参考）。
  - `denyRead` 增 worktree 根的 protect-rule 绝对 globs（用 `denyReadGlobs({...workdir, path: worktreePath})`）。
- 网关 `checkPath`：在 workspace 分支之后、数据目录之前插入 worktree 分支：`isInsidePath(resolved, worktreePath)` → protect 规则（以 worktree 为根）→ `holdsLease(identity, worktreePath)` → allowed / `needs_lease`；`.git` 指针文件与 `worktrees/<n>/gitdir` 仍走 `#gitControlDecision`。
- 相对路径基准：`boundWorkdir(...)?.path ?? workspace` 改为 `taskWorktreePath(identity) ?? boundWorkdir(...)?.path ?? workspace`（`gateway/index.ts:490-495`、`orchestrator.ts:4686`、`coding-tools.ts:359-361`）。
- 命令 cwd：`policyInfo` 增 `cwd`；`gateway.exec` 用 `policyInfo.cwd ?? workdir?.path ?? workspace`。
- 上下文注入：`workdir/service.ts` 的 `promptSection` 增可选 `root` 参数；任务上下文用 worktree 根（列出目录 / git status / AGENTS.md）。
- `git_remote`：`isolation==='worktree'` 的任务调用 → `INVALID_INPUT`「worktree 任务不支持远程操作，请先把改动应用到工作目录」。
- `#untrustedRoots` 增 worktree 根。
- 认领根：`task.taskCwd` 已是 worktree，自动认领自然只作用于 worktree 根，与主目录任务互不影响。

**结算与应用**：

1. `TaskHost.settle` 后由 orchestrator `onSettled`：若 `isolation==='worktree'` 且 worktree 存在且 `git -C <path> status --porcelain` 非空 → 生成摘要（文件数、增删行、前 20 个文件）→ `approvals.submitNonBlocking(identity, 'worktree_apply', payload, onDecided)`。
2. 卡（新 kind `worktree_apply`，非阻塞、留对话）payload：`{ runId, worktreePath, workdirPath, baseOid, files: string[], insertions, deletions }`。文案要说明「应用会用三方合并写入你的工作目录；冲突时保留 worktree」。
3. 批准回调：
   - 取主 workdir **独占**租约（`loopType:'host'`）；被内置任务占用 → 卡上提示「工作目录正被任务写入，请稍后重试」，不应用、不中断任务。
   - `git -C <workdir> apply --3way --binary <(git -C <worktree> diff <baseOid> --binary)`（diff 含未跟踪文件：先 `git -C <worktree> add -A -N` 再 diff）。
   - 成功：删 worktree（`git -C <workdir> worktree remove --force <path>` + `prune`）、`applyState='applied'`、发 `task.updated`。
   - 冲突：保留 worktree、`applyState='conflict'`、把冲突文件列表写进审批的 `decision` 附注与任务事件（`WORKTREE_APPLY_CONFLICT`），不再自动重试。
4. 拒绝 / 卡超时：保留 worktree、`applyState='kept'`；任务卡显示路径。
5. `NEVER_AUTO_DECIDED` 增 `worktree_apply`（无人值守不自动应用）；`SURVIVES_RUN` 增它（任务结束后仍可决定）。

**清理**：

- 启动 sweep：`runs` 中 `task_isolation='worktree'` 且非终态 → 现有崩溃恢复把任务标 `interrupted`；worktree 保留，`applyState='kept'`。
- 每日 reaper：扫 `.worktree/` 下目录，无对应非终态任务、且 `mtime` 超过 `WORKTREE_RETENTION_MS` → 先确认不是任何 workdir 的已注册挂载 → `git worktree remove --force` + `prune`，写审计 `worktree_reaped`。
- 删除对话 / Bot 不删 worktree（改动是用户资产）。

**retry / continuation**：

- `runs.retry`：`isolation==='worktree'` 的任务重试时**重新创建** worktree（旧路径已回收或内容过期），新 `task_worktree_base` 取当时的 HEAD。
- `start_task({continues_task_id})`：**不继承** isolation（`worktreePath` 不随简报复制），由对话轮显式声明。

## 4. 波次、依赖与并行

| 波次 | 内容 | 依赖 | 可并行 |
|---|---|---|---|
| **W0** | shared 契约（§3.1）、迁移（§3.2）、错误码、常量 | — | 与勘察无关，最先做 |
| **W1** | 沙箱读宽写窄（§3 无，见 §6 W1） | W0 | 与 W2 并行 |
| **W2** | 多路径卡 + `task` 时长（§3.5） | W0 | 与 W1 并行 |
| **W3** | 污点断网 + `request_network`（§3.4） | W2（task 时长） | 与 W4 并行（文件交集见 §5） |
| **W4** | 写任务默认并行（§3.3、§6 W4） | W0 | 与 W3 并行（需先协调 gateway 段） |
| **W5** | worktree 隔离（§3.6） | W1（沙箱两根）、W4（tasks.ts 同一文件） | 串行，必须在 W4 之后 |
| **W6** | 文档回写、i18n 收尾、全量回归、真实沙箱验证 | 全部 | — |

推荐执行顺序：`W0 → (W1 ∥ W2) → (W3 ∥ W4) → W5 → W6`。若只有一个开发代理，按 W0→W1→W2→W3→W4→W5→W6 顺序做，不要跳。

每波结束后：定向测试 → 派审查子代理 → 审查代理直接修 → 主代理跑该波定向测试 → 回写 §10 → 提交。

## 5. 文件归属（避免并行冲突）

| 波次 | 主改文件 |
|---|---|
| W0 | `packages/shared/src/domain/types.ts`、`packages/shared/src/constants.ts`、`packages/shared/src/errors.ts`、`packages/core/migrations/main/0083_*.sql`、`packages/core/migrations/runs/0018_*.sql`、`packages/core/src/domain/runs.ts`（映射）、`docs/dev/03-data-model.md` |
| W1 | `packages/core/src/sandbox/policy.ts`、`backend-srt.ts`、`sensitive-paths.ts`、`packages/core/test/unit/policy.test.ts`、`packages/core/test/sandbox/sandbox-isolation.test.ts` |
| W2 | `packages/core/src/permissions/approvals.ts`、`grants.ts`、`gateway/index.ts`（access 段 722-815）、`tools/coding-tools.ts`（violation 段 499-585）、`agent/external/permission-bridge.ts`、`apps/desktop/.../ApprovalCard.svelte`、`features/approvals/mcp-approval.ts`、`RightPanel.svelte`、i18n |
| W3 | `packages/core/src/gateway/index.ts`（exec 段 900-1050）、`apps/taint.ts`、`tools/index.ts`（新工具 + 注册清单）、`tools/coding-tools.ts`（网络提示段）、`agent/effects/classify.ts`、`settings/context.ts`、`apps/team-server/server/src/policy/tool-policy.ts`（仅 KNOWN_TOOLS） |
| W4 | `packages/core/src/workdir/lease.ts`、`service.ts`、`claims.ts`、`checkpoints.ts`、`dispatch/tasks.ts`、`dispatch/orchestrator.ts`、`agent/context/tasks-segment.ts`、`system-prompt.ts`、`tools/task-tools.ts`、`apps/desktop/.../TaskRunView.svelte`、`TaskStatusLine.svelte`、i18n |
| W5 | `packages/core/src/workdir/worktree.ts`（新）、`service.ts`、`dispatch/tasks.ts`、`dispatch/orchestrator.ts`、`gateway/index.ts`（worktree 分支 + exec cwd）、`sandbox/policy.ts`、`tools/task-tools.ts`、`migrations` 无（W0 已加列）、`apps/desktop/.../TaskCard.svelte`、`TaskRunView.svelte`、i18n |

**冲突热点与处理**：`gateway/index.ts`（W2/W3/W5）、`coding-tools.ts`（W2/W3）、`dispatch/tasks.ts`（W4/W5）、`workdir/service.ts`（W4/W5）。W3 与 W4 并行时，W3 先改 `gateway/index.ts` 的 exec 段（900-1050）并提交，W4 再改 write 段（479-655）——**不要在同一个工作树里并行改同一个文件**；若两个开发代理必须并行，用 `git worktree` 或分先后。

## 6. 各波次范围与验收

### W0 契约与迁移

**范围**：§3.1 全部类型/常量/错误码；§3.2 两个迁移；`domain/runs.ts` 的行映射与 `create` 入参；`taskViewSchema` 新字段；`runSchema` 新字段。**不写业务逻辑**。

**验收**：
- `pnpm --filter @kepcup/shared build` 通过。
- `node scripts/run-tests.mjs run packages/shared/test/unit packages/core/test/unit/runs-tasks.test.ts packages/core/test/unit/egress-migration.test.ts packages/core/test/unit/task-cwd-migration.test.ts` 全绿（按实际需要更新 schema 断言：`app-approval-schemas.test.ts`、`connected-apps.test.ts` 的 enum options）。
- 迁移测试：新库跑全量迁移成功；旧库（含 grants/approvals 数据）升级后行不丢、CHECK 生效。
- `pnpm --filter @kepcup/core typecheck` 通过。

### W1 沙箱读宽写窄

**范围**：
- `sandbox/policy.ts:108-116`：`denyRead = [paths.home, ...sensitivePaths(platform)]`（去掉 `userHome`）；删除 `.CFUserTextEncoding` 重开与不再使用的 import；改写 `:188-194` 的注释。
- `backend-srt.ts` `srtFilesystemFor`：`denyWrite` 显式包含 `~/.npm/_logs`、`~/.claude/debug`（照 srt `getDefaultWritePaths` 的实际列表；若还有其他默认写路径一并锁死）。
- `sensitive-paths.ts`：保留 `existsSync` 过滤但补注释说明「列表是主目录读保护的唯一防线」；补 `~/.config/gh/hosts.yml`、`~/.docker/config.json` 等缺失凭证路径（按平台）。
- 文档：设计 10「文件系统规则」、设计 13「默认可访问范围」、设计 06 读让渡表述、`docs/dev/phases/P02-sandbox-and-tools.md:49`、`docs/dev/02-architecture.md:240`。

**验收**：
- `node scripts/run-tests.mjs run packages/core/test/unit/policy.test.ts packages/core/test/unit/workdir-rules.test.ts packages/core/test/unit/container-backend.test.ts`：主目录不再出现在 `denyRead`；`paths.home`、每个 `sensitivePaths()` 项、workdir globs 仍在；`denyWrite` 含两条默认写路径。
- 真沙箱：`node scripts/run-tests.mjs run packages/core/test/sandbox/sandbox-isolation.test.ts`——`~/.zshrc` / 同级其他仓库可读；`~/.ssh/*`、`<dataHome>/main.db`、workdir 内 `.env` 仍不可读；工作区外写入仍失败；`~/.npm/_logs` 写入仍失败。
- WSL/Podman 行为不变（挂载式），在测试注释与文档中写明。

### W2 多路径卡 + `task` 时长

**范围**：§3.5 全部；`ApprovalCard.svelte` 的 access 与 agent_tool 时长行改为三档（`1` 仅这一次 / `2` 本任务内 / `3` 本对话内），键盘同步；`mcp-approval.ts` 标签表与 folded key；`describe()` / `renderContextLine()` 支持 `paths` 与 `task`；i18n（`approvals.task`、`approvals.foldedApprovedTask`、`rightPanel.grantTask`、`durationHint`）。

**验收**：
- `node scripts/run-tests.mjs run packages/core/test/unit/permissions.test.ts packages/core/test/unit/bash-violation-approval.test.ts packages/core/test/unit/gateway-check-path.test.ts packages/core/test/unit/permission-bridge.test.ts packages/core/test/integration/approvals.test.ts packages/core/test/integration/external-agent-p3.test.ts packages/shared/test/unit/app-approval-schemas.test.ts packages/shared/test/unit/connected-apps.test.ts`。
- 新增用例：一条命令拦 3 个路径 → 只建 1 张卡、批准后 3 条 grant；`task` grant 在同一 run 的第二次工具调用仍有效、run 结束即失效；`task` grant 不覆盖子 run；`revokeByUser` 撤销 task grant 只中断该任务；`access` 卡的 `task` 不在 offered 时降级 `once`。
- 渲染端：`node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/approvals`；`pnpm --filter @kepcup/desktop typecheck`。
- e2e `apps/desktop/test/e2e/approvals.spec.ts` 的键盘序号同步（若改为 3 档）。

### W3 污点断网 + request_network

**范围**：§3.4 全部；`apps/team-server` 的 `KNOWN_TOOLS` 补 `request_network`（私有仓单独提交）；文档修订 D73 P2 相关段落、设计 13 §授权/污点、设计 29 §8.3。

**验收**：
- `node scripts/run-tests.mjs run packages/core/test/unit/taint-egress.test.ts packages/core/test/unit/permission-bridge-taint.test.ts packages/core/test/integration/connected-apps-p2-egress.test.ts packages/core/test/unit/settings-catalog-host.test.ts`。
- 新增用例：污点 + `network_policy:'open'` 的 bash → `policy.network.mode==='none'` 且**不**建审批卡；`allowLocalhost` 保留；bypass + 污点不脱离沙箱；`request_network` 建一张卡、三档时长、批准后下一条命令外网可用、`once` 用后失效、`mark()` 重新置污点后失效；网络 violation 行触发 `request_network` 提示；TTL 60 分钟滑动。
- ACP 回归：`permission-bridge-taint.test.ts` 仍按逐请求卡（不动）。

### W4 写任务默认并行

**范围**：§3.3 全部；恢复 per-run 影子窗口（`beginTaskWindow` / `endTaskWindow`：启动快照、结算快照、`run_changes` 写入、并行任务改动交集标 `interleaved`）；自动认领（文件工具写入成功后登记，`TASK_AUTO_CLAIM_MAX` 上限）；认领跨对话；提示词改写（`system-prompt.ts` 任务版 415-417 / 对话版 568、`task-tools.ts` 的 `start_task` 描述、`claim` 描述）；`<peer_tasks>` / `<tasks>` 文案；任务详情显示改动文件与冲突；队列原因清理。

**验收**：
- `node scripts/run-tests.mjs run packages/core/test/unit/workdir-lease.test.ts packages/core/test/unit/workdir-domains.test.ts packages/core/test/integration/tasks.test.ts packages/core/test/integration/tasks-write-domains.test.ts packages/core/test/integration/tasks-claims.test.ts packages/core/test/integration/tasks-peer-coordination.test.ts packages/core/test/integration/workspace-lease.test.ts packages/core/test/integration/tasks-startup-queue.test.ts packages/core/test/unit/tasks-peer-segment.test.ts packages/core/test/unit/task-brief-write-domains.test.ts`。
- 必须改写的既有断言：`tasks.test.ts:297-344`（两个 `writes:true` 现在**并行**，不再「等写域」）、`workspace-lease.test.ts:60-102`（两个写任务共享 → 并行）、`tasks-write-domains.test.ts:224-249`。
- 新增用例：两个未声明写任务同 workdir 并行启动、各自沙箱 `hasLease===true`；A 写 `a.ts` 后 B 写 `a.ts` 得 `WRITE_CLAIMED` 且提示 `send_to_task`；B 写 `b.ts` 成功；两个任务结算后各自的 `run_changes` 文件集合正确，交集文件标 `interleaved`；外部智能体任务独占租约时内置任务排队「等写入租约」；用户「强制收回」作用于共享写任务后其后续写入 `RUN_READ_ONLY`；只读任务不受影响。
- 类型检查：`pnpm --filter @kepcup/core typecheck`、`pnpm --filter @kepcup/desktop typecheck`。

### W5 worktree 隔离

**范围**：§3.6 全部。分三个提交便于审查：① 创建/删除/租约/沙箱/网关/exec cwd；② 上下文注入/任务面/retry/continuation；③ apply 卡与应用、reaper。

**验收**：
- `node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts packages/core/test/integration/workdirs.test.ts packages/core/test/unit/gateway-check-path.test.ts packages/core/test/unit/policy.test.ts packages/core/test/unit/gateway-read-only.test.ts`。
- 新增集成用例（真 git 仓库 fixture）：
  1. `start_task({writes:true, isolation:'worktree'})` → worktree 创建在同级 `.worktree/<name>-<short>/`、detached HEAD、`task_cwd` 指向它、原工作区未提交改动被带入；
  2. 任务的 bash 在 worktree 内执行（`pwd` 断言），写文件只落在 worktree；
  3. 沙箱内 `git status` / `git diff` / `git commit` 成功（`.git/worktrees/<name>/` 可写），`echo x >> .git/config` 失败；
  4. worktree 内 `.env` 仍不可读（protect 规则随根）；
  5. 主 workdir 任务与 worktree 任务**并行**（互不排队）；
  6. 任务结束 → 一张 `worktree_apply` 卡；批准 → 改动出现在主工作区、worktree 被删除；冲突场景 → 保留 worktree、`applyState='conflict'`、冲突文件列出；
  7. 拒绝 → 保留、`kept`；无人值守 → 不自动应用；
  8. retry → 新 worktree；continuation → 回到主 workdir；
  9. 非 git workdir / `cwd:'workspace'` / ACP 引擎 → `INVALID_INPUT`；
  10. reaper 删除超期孤儿，不删有活动任务的。
- `pnpm --filter @kepcup/core typecheck`。

### W6 收口

- 回写设计：`docs/design/README.md` 决策表加 D140 行与索引说明；`13-permissions.md`（时长/多路径/断网/`request_network`/worktree 默认可写）；`10-sandbox.md`（读宽写窄、worktree 双根、`.git/worktrees` 精确放行）；`08-workdir.md`（共享写租约与认领、worktree 位置）；`30-supervisor-and-tasks.md` §5/§9.1（D140-1/4 修订，四条理由逐条标注处置）；`59-parallel-tasks-and-coordination.md` §3/§7（域排队改为共享+认领）；`02-execution.md`、`06-isolation-and-storage.md`、`28-external-agents-acp.md`（ACP 不参与断网与 worktree）的对应段落。
- `docs/dev/PROGRESS.md` 追加 D140 章节（格式照最近一节）；`docs/dev/03-data-model.md` 表结构。
- 一次全量 `pnpm test`；记录基线失败集合（若有）与本次差异。
- 真实沙箱手工验证（macOS srt）：读宽、`denyWrite`、污点断网 + `request_network`、worktree 全流程。

## 7. 测试矩阵（汇总）

| 区域 | 文件 |
|---|---|
| shared schema | `packages/shared/test/unit/app-approval-schemas.test.ts`、`connected-apps.test.ts`、`settings-catalog.test.ts` |
| 审批/授权 | `packages/core/test/unit/permissions.test.ts`、`approvals` 集成 `packages/core/test/integration/approvals.test.ts`、`approval-timeout.test.ts`、`permission-revocations.test.ts`、`permission-modes.test.ts` |
| 网关 | `gateway-check-path.test.ts`、`gateway-read-only.test.ts`、`gateway-allowlist-hardening.test.ts` |
| 沙箱 | `policy.test.ts`、`workdir-rules.test.ts`、`sandbox/sandbox-isolation.test.ts`、`container-backend.test.ts`、`wsl-mounts.test.ts`、`sandbox/toolchain-sandbox.test.ts` |
| 污点/外发 | `taint-egress.test.ts`、`permission-bridge-taint.test.ts`、`connected-apps-p2-egress.test.ts`、`egress-migration.test.ts` |
| 租约/认领/域 | `workdir-lease.test.ts`、`workdir-domains.test.ts`、`tasks-claims.test.ts`、`workspace-lease.test.ts`、`workdir-lease-windows.test.ts` |
| 任务 | `tasks.test.ts`、`tasks-write-domains.test.ts`、`tasks-peer-coordination.test.ts`、`tasks-startup-queue.test.ts`、`tasks-auto-retry.test.ts`、`tasks-interrupt.test.ts`、`task-cards.test.ts`、`task-subagent-read-only.test.ts`、`task-tools-write-domains.test.ts`、`task-brief-write-domains.test.ts`、`tasks-peer-segment.test.ts`、`runs-tasks.test.ts`、`task-cwd-migration.test.ts` |
| workdir | `workdirs.test.ts`、`workdir-roots.test.ts`、`projects-service.test.ts`、`workdirs-rename-migration.test.ts`、`projects-rpc.test.ts` |
| ACP | `permission-bridge.test.ts`、`external-agent-tasks.test.ts`、`external-agent-p3.test.ts`、`external-agent-engine.test.ts` |
| 渲染端 | `features/approvals/*.test.ts`、`features/tasks/task-view.test.ts`、`task-run-view.test.ts`、`stores/workdirs.svelte.test.ts`、`settings-card/card-components.test.ts` |
| e2e | `apps/desktop/test/e2e/approvals.spec.ts`、`tasks.spec.ts` |

## 8. 已知限制（如实呈现，不静默）

1. **命令写入的冲突检测是事后的**：自动认领只覆盖经网关的文件工具（write/edit/mkdir/生成产物/附件/落盘）。`bash` 里的 `sed -i`、`npm install`、构建产物、浏览器下载、外部智能体写入**不认领**，只能靠 per-run 快照的改动交集在结算时标 `interleaved`。两个并行任务的命令同时改同一文件仍可能互相覆盖——文档与任务详情要如实展示。
2. **srt 网络配置是全局单例**：不同网络策略的命令不能并发（切换会先 drain 在途命令）。`request_network` 的 host 白名单会加剧切换。跨对话并行任务如果网络策略不同，仍会互相等。
3. **共享写租约让「强制收回」语义变宽**：收回一个共享持有者只影响它自己；同一 workdir 其他写任务继续。UI 文案要改为「停止该任务的写入」而不是「收回整目录」。
4. **worktree 开箱仍缺依赖**：只复制 `.worktreeinclude` 列出的忽略文件；`node_modules` 不复制（除非显式列出，代价大且可能破坏隔离）。任务可能需要在 worktree 里安装依赖。
5. **worktree 会写用户 `.git`**：`git worktree add` 在 `<workdir>/.git/worktrees/` 建元数据，宿主在沙箱外执行且只放行该子目录的写；这是 D140-4 明确接受的让渡。用户仓库的 `git worktree list` 会看到这些临时树，删除后 `prune` 清理。
6. **worktree 只支持内置引擎与 srt**：ACP 引擎与增强后端（Lima 外的 Podman/WSL 挂载式）本期不支持；`isolation:'worktree'` + 这些组合返回 `INVALID_INPUT` 或强制走 srt（实施时二选一，记 §10）。
7. **ACP 不受断网影响**：外部智能体的沙箱网络由它自己控制，宿主只能逐请求批准；污点期 ACP 任务仍会看到逐请求卡。文档在 Bot 详情标注。
8. **`task` 授权不覆盖子代理**：子 run 是新 run，需要自己的授权（与 `once` 现状一致）。子代理因此可能重复弹卡。
9. **读宽后沙箱能看到整机**（敏感清单除外）：这是 D140-2 的明确取舍，与文件工具现状一致；Bot 详情与设计文档要写清。
10. **worktree 任务没有 `run_changes`**：影子快照窗口要求 `task_cwd` 在主 workdir 内，隔离任务必然跳过（DEV-153 ①）。改动记录以「应用到工作目录」卡的 `files` / 增删行与 `task.applyState` 为准，任务详情页的改动列表对它为空。
11. **「应用」只回流 tracked 与未忽略的未跟踪文件**：补丁经 `git add -A -N` 生成并尊重 `.gitignore`，隔离目录里产出的忽略文件（构建产物、`node_modules` 等）不会回到工作目录，树被删除 / 回收时一并丢弃（DEV-153 ②）。
12. **`applyState` 是进程内推导**：重启后 surviving 树 = `kept`（冲突也退化为 kept），缺失树 = `applied`（因此被 reaper 回收的树会误显示 applied）；结算卡是事实来源。重启时未决定的卡按「待确认审批 → cancelled」取消、树保留，可在终端里手动合并；不做「重启后重新出卡」（DEV-153 ③④）。
13. **自动重试复用原树、建树不取主 workdir 租约**：任务失败自动重试是同一个 run 重新入队，`#startTask` 复用仍有效的树（保留半成品）；只有用户 `runs.retry`（新 run）建新树并把 `task_cwd` 重算为主 workdir。建树（`stash create`）不取主目录租约（共享租约不排除写任务，独占会违背并行契约），同一时刻有主目录写任务时起点快照可能含它写到一半的内容（DEV-153 ⑤⑥）。

## 9. 文档回写清单

见 §6 W6。另外：
- `docs/design/README.md` 决策表新增 D140 一行（四个子决策合并成一行描述）。
- `docs/dev/DEVIATIONS.md`：本次预期可能需要的偏差（实施时按实际写）：`es-git` 是否跳过 worktree 根下的 `.git` **文件**（需实测）、增强后端 worktree 支持范围、srt 全局网络策略的并发影响。
- `apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts` / `en-US.ts`：新增 key 一次列全（approvals.task / foldedApprovedTask / grantTask / network channel / worktree_apply 卡 / worktree 任务详情 / 队列原因删除项 / 强制收回文案）。

## 10. 实施记录

> 每波完成后追加：分支与提交、逐波验证证据（定向测试命令与结果）、审查子代理发现与修正、偏差（DEV 编号）、未做/遗留。

### W0

- **提交**：`feat(core): D140 W0——shared 契约（task 时长/多路径 access payload/worktree 字段）与 grants·approvals·runs 迁移` + `docs(dev): D140 W0——数据模型表结构同步与实施记录`（分支 `feat/d140-autonomy-parallel`）。
- **改动**：§3.1 全部（审批/授权时长增 `task`、access payload 多路径 + `durations`、`egressChannelSchema` 增 `network`、run 三字段、TaskView 三处、`worktree_apply` kind）；§3.2 两个迁移（main 0083 grants/approvals 重建、runs 0018 三列）；`domain/runs.ts` 行映射与 create；常量（60min / 4 / 6 / 5 个 worktree 常量 / TASK_AUTO_CLAIM_MAX）；4 个错误码；`docs/dev/03-data-model.md` 同步。
- **验证**：`pnpm --filter @kepcup/shared build` 通过；`node scripts/run-tests.mjs run packages/shared/test/unit packages/core/test/unit/{runs-tasks,egress-migration,task-cwd-migration,d140-migrations}.test.ts packages/core/test/integration/tasks.test.ts` → 59 文件 / 709 用例全绿；core 与 shared typecheck 通过。
- **审查**：独立审查子代理逐条核对契约与迁移（grants 列/索引对照 0004、approvals kind 全表对照 0062 并 grep 0062–0082 无遗漏修改者），无契约级缺陷；修正两处注释（`apps/taint.ts` 的 24h 表述改为 60min、runs.ts TODO 理由失实）。
- **自选决策**：① TaskView `worktreePath`/`applyState` 用 `.optional()` 而非契约的 `.default(...)`——构造点在 `dispatch/tasks.ts`（W4/W5 接线），default 输出类型必填会击穿 apps/desktop 六处 fixture（该目录属另一 feature 工作区，本波禁改）；schema 全仓无 parse 调用点，运行时语义等价，消费方 `?? null` / `?? 'none'` 兜底。② `integration/tasks.test.ts` quota 测试按新常量 4/6 重写（连带把 mock 厂商并发提到 8 才能观测 6/6，照 `episodes-rpc.test.ts` 先例）。③ `egress-migration.test.ts` 的 ALL_KINDS 顺带补齐历史缺失的 `mail_send`/`bot_handover`/`computer_control`。④ `worktreePath/worktreeBase` 仅在 `isolation==='worktree'` 时落库（防脏数据）。
- **遗留**：渲染端 `APPROVAL_DURATION_LABEL_KEYS` 缺 `task` 键 → desktop typecheck 预期破坏，W2 修复；TaskView 字段填充与 `runs.update` 写点留 W4/W5。

### W1

- **提交**：`feat(core): D140 W1——沙箱读宽写窄（D140-2）：去整主目录禁读 + 显式 denyWrite 锁死 srt 默认便利写路径`（含 5 个设计/dev 文档修订，单独并入本提交）。
- **改动**：`sandbox/policy.ts` denyRead 去 `userHome`（`paths.home` 保留，红线）；删 `.CFUserTextEncoding` 重开；`backend-srt.ts` denyWrite 显式 `~/.npm/_logs`、`~/.claude/debug`（对照 srt 0.0.78 `HOME_CONVENIENCE_WRITE_DIRS` 恰两条，无第三条）；`backend-container.ts` 删同源 carve-out；`sensitive-paths.ts` 补 4+1 个纯凭证文件（`~/.pypirc`、`~/.pgpass`、`~/.gem/credentials`、`~/.cargo/credentials` + 审查补的现代拼写 `~/.cargo/credentials.toml`）；测试断言全部换新语义；文档五处（设计 10/13/06、P02、02-architecture）。
- **验证**：定向 66 用例 + 真沙箱 `sandbox-isolation.test.ts` 12 用例全绿（`~/.zshrc` 可读、`~/.ssh/*` 与 `<dataHome>/main.db` 与 workdir `.env` 禁读、区外写与 `~/.npm/_logs` 写失败）；排雷 gateway/wsl 等额外 7 文件全绿；core typecheck 通过。
- **审查**：独立审查代理独立推演 srt `generateReadRules`/`lateReadDenyFilters`（deny→allow→嵌套 deny 重发射）确认 workdir 保护 globs 与嵌套凭证 deny 仍生效；修正 3 处（中：补 `~/.cargo/credentials.toml`——现代 cargo 凭证拼写，只加 legacy 会漏；低：真沙箱探针 finally 清理防回归污染宿主 home；低：P02 文档 51 行旧读模型残留表述）。
- **自选决策**：① denyWrite home 展开用 `canonicalPath(homedir())`（与原 userHome 同拼写，srt 双侧归一收敛）。② 增强后端删 `.CFUserTextEncoding` carve-out（读宽后为死代码）。③ 敏感清单只收纯凭证文件，配置类（`.gitconfig`、`.m2/settings.xml` 等）不加、列入报告备查。④ Podman/WSL 挂载式读宽不适用（guest 内自有 home 前后一致），注释与文档写明。
- **遗留**：Linux 分支（bwrap）新用例已写好但本机只验 macOS；W6 全量时 CI 矩阵复核。

### W2

- **提交**：`feat(core): D140 W2——多路径 access 卡 + task 审批时长（ensurePathAccessBatch、decide 时长表、grants/桥接 task 语义、渲染端三档）`。
- **改动**：§3.5 全部——网关 `ensurePathAccessBatch`（一张卡、逐路径 grant、一次 grant.changed，`ensurePathAccess` 改单路径封装）；`decide()` 的 `DURATION_ALLOWED_FOR` 表 + 降级规则；`grants.ts` task 语义（listEffective 看 runId、expireForRun 含 task、revokeByUser 带 runId）；permission-bridge 三档 + task 落 grant；coding-tools 收集全部 needs_grant 一次批量；渲染端 access/agent_tool 三档按钮+键盘、多路径显示、折叠摘要、RightPanel 时长文案、i18n 双语；e2e approvals.spec 键盘序号同步。
- **验证**：core/shared 十文件 143 用例 + 渲染端 approvals/i18n 45 用例全绿（主代理复跑合并 188 用例全绿）；core/desktop typecheck 通过（desktop 0 错误，4 个 svelte-check 警告为另一 feature 既有）；e2e approvals.spec 3/3 passed（需先重建 core/desktop 产物——run-tests.mjs 跑不到 Playwright spec，用 `pnpm --filter @kepcup/desktop exec playwright test` 直跑）。
- **审查**：修正 2 处（中：旧 access 卡（无 durations）渲染端回退两档 `['once','conversation']`，否则历史 conversation 批准的折叠记录会错显「仅这一次」；低：durationHint 改通用文案，避免对两档旧卡的错误键盘指引）。逐条核对契约无其他缺陷；确认无 kind 放宽、egress 弹卡未动（W3）、单路径封装调用点全不破坏。
- **自选决策**：① batch 返回值附 `approvalId`/`duration`（封装还原旧错误 details、coding-tools 生成准确时长提示）。② access 的 `conversation` 不校验 offered（旧卡兼容，spec 只要求 task 校验）。③ 表外 kind 非 once 时长从静默接受改为降级 once（收紧）。④ 多路径卡 reason 去重 `；` 连接。⑤ 拒绝文案内嵌路径（单路径封装抛错与旧格式同构）。
- **遗留**：computer_control 卡键盘按 3（bot）无响应为 W2 之前既有缺口，未顺手修（记入备查）。

### W3

- **提交**：`feat(core): D140 W3——污点=断网：沙箱命令外网切断、request_network 一张卡三档、TTL 60min`（`70142fe5`）+ 审查修正 `fix(core): D140 W3 审查修正——requestNetworkAccess 的轮/子代理拒绝分支先于只读分支`（`d3959256`）；闭源私有仓 `feat(server): D140——KNOWN_TOOLS 补 request_network`（`2b4a2f0`，apps/team-server 内单独提交）。
- **改动**：§3.4 全部——gateway.exec 的 `effectiveNetwork`（污点未放行 → `mode:'none'` + 保留 allowLocalhost/allowedPorts）、bypass 追加 `taint===null`、删除逐命令 egressCheck 与 `#builtinExempt`、once 命令启动前消费；`TaintService` 新增 `allowNetwork`/`networkAllowed`/`consumeOnceNetwork`/`expireNetworkForRun`（scope 编码 `all`/`task:<runId>`/`once:<runId>`，hosts 编码进 scope，有效期夹紧污点窗口，mark 仍清空全部）；`request_network` 工具 + 网关 `requestNetworkAccess`（一张 egress 卡三档、hosts 校验防注入、轮/子代理/只读不等待）；`NETWORK_VIOLATION_PATTERN` 提示；effects/classify 与 settings/context 登记；orchestrator 三处 expireNetworkForRun 接线；设计 13/29 修订。
- **验证**：定向四文件 105 用例 + 相邻回归 92 用例 + 额外 5 组回归全绿；core/team-server typecheck 通过。
- **审查**：独立审查核对 srt 源码确认 violation 行格式与正则匹配、once 消费无 await 竞态、`all|hosts` 行不会被其他 egress 通道误读、expireNetworkForRun 三处接线齐全；修正 1 处低危（轮/子代理专用拒绝分支被 `writeDenial` 前置遮蔽会给出误导性 ask_user 指引，已移到只读分支之前）。
- **自选决策**：① hosts 编码进 scope（表无列，`cmd:` 前缀不受影响）；② 无 hosts 放开 = 恢复 Bot 自身 `req.network`（不越过用户显式收紧，Bot 策略 none 时批准也不放开）；③ 无人值守按 once 写入、审计沿用 egress_tainted、AUTO_APPROVED_KINDS 不扩；④ `networkAllowed` 去掉契约骨架里无消费方的 workdir 参数；⑤ 旧 `cmd:` 读路径保留兼容（ACP 桥仍可见），不删死代码。
- **遗留**：真沙箱断网验证留 W6；srt 全局网络单例的串行化影响写入设计文档已知限制。

### W4

- **提交**：`feat(core): D140 W4——写任务默认并行：共享写租约 + 文件级自动认领 + per-run 影子快照`（`a2cfa5d3`）+ 实施记录 `5205fc5e`。混合文件的既有 team 改动经逐 hunk 分离，提交内零泄漏（`git show a2cfa5d3` 无 team 标识）；D140-only 树经 core typecheck 与 65 用例验证可独立构建。
- **改动**：§3.3 全部——`LeaseService` 多持有者 + shared 两态冲突规则（共享×共享=并存）、promotion 重写（稳定 seq、waiter 占位到 grant/cancel、cancel 后补 promote，顺带修复 release 漏删 `#byRun` 与同键双 waiter 死锁）；`WorkdirRuntime` ensureWriteLease shared 透传、revokeLease 新语义（优先停本对话内置共享任务、回退仅独占）、`beginTaskWindow`/`releaseRun`（先快照后释放、按 run/workdir 串行、重试合并窗口）；`claims.ts` 跨对话 denial + `autoClaim`（5000 封顶）；tasks.ts 删 `#domainBlocker` 与「等写域」、wait_for_task 守卫删除；orchestrator 内置写任务 `shared:true`；gateway write 段 `writeClaimDenial` 跨对话 + `noteFileWritten`；coding-tools/tools 写入成功后自动认领；system-prompt/tasks-segment/task-tools 文案；TaskRunView 改动文件区（+/~/-、interleaved、reverted）；i18n 双语；共享 `taskChangesSchema` files 变体。
- **验证**：core 15 文件 158 用例全绿（含新增 `tasks-parallel-writes.test.ts` 8 例、`task-claims-registry.test.ts` 3 例）；渲染端 5 文件 76 用例全绿；core/desktop typecheck 通过。
- **审查**：独立审查修正 11 处，其中 3 个高危并发缺陷——① 影子窗口并发 release 会在他人 after-snapshot 前释放租约（改按 run 串行 + 窗口关闭 promise 化 + try/finally）；② auto-retry 重入拿到「即将被释放」的租约（ensureWriteLease 等在设计中的 release、窗口身份校验）；③ 已结束并行任务的写入被后来任务冒领（窗口 otherFiles 交接 + workdir 串行关闭，删 `WorkdirsService.listChanges`）。另有中危：auto-retry 覆盖首轮文件清单（改合并 upsert）、revokeLease 可能停掉其他对话的共享任务（回退仅独占）、promotion/FIFO 重写；低危：interleaved 跨 workdir 误标、claimedPaths「等」误报、测试前缀串匹配导致的偶发超时、过时注释与死代码、e2e workdirs.spec 的「等写域」旧断言重写为并行场景。
- **自选决策**：① promotion 不由持有者直接授权，改唤醒 + waiter 自身复核（保 FIFO 与批量共享）；② 认领 root 前缀预过滤用 `leaseKeysConflict`（带 `/` 边界）；③ 快照窗口每写任务一窗、end 先快照后释放；④ claim 工具次数上限改「单次新增 ≤16」（自动认领不占额度）；⑤ 视图侧 claims 截 12/4 条；⑥ 附件副本（get_attachment → workspace `.attachments/`）不自动认领（会话级共享缓存，认领会误拦同对话并行任务；偏差已在此记录）。
- **遗留**：bash/浏览器下载/外部智能体写入不认领（已知限制 1，结算 span-diff 兜底）；denial 逐条 glob 最坏 5000 条约 10ms（未做索引，常态无感）；e2e workdirs.spec 重写后未在本机执行（需 Electron 打包产物，逻辑与 158 例集成覆盖同构）。

### W5
- **提交**：`feat(core): D140 W5——worktree 隔离：start_task isolation、双根沙箱、worktree_apply 应用卡、孤儿回收`（`d9baf9fa`）。**偏差**：§6 建议「分三个提交便于审查」，实际按「A 段（创建/沙箱/网关/exec cwd）/ B 段（上下文/任务面/retry/continuation）/ C 段（结算/应用卡/reaper）」**三段独立审查、单提交**——三段的改动在同一批文件内交织，按文件切分无法得到各自可构建的提交；D140-only 树经 core typecheck 与 18 用例验证可独立构建。
- **改动**：§3.6 全部——新 `workdir/worktree.ts`（位置 `<workdir 父>/.worktree/<basename>-<runId 后 8 位>/`、`.gitignore`(`*`)+0700、`stash create` 起点含未提交改动、`.worktreeinclude` 走 git 的 gitignore 引擎、失败清理 + `WORKTREE_CREATE_FAILED`；摘要 / `--no-renames` 补丁 / 私有索引副本三方合并 / 还原点 / 孤儿回收）；`sandbox/policy.ts` 双根（树根 + `<common>/worktrees/<name>` + `<common>/objects` 可写、主 workdir 只读、protect globs 随树根重锚、`.worktree` home 对绑定 workdir 的所有 run 读禁、read-only 子代理可读树）；`gateway/index.ts` worktree 分支（数据目录硬拒 → protect → 租约 → git 控制文件）、相对路径基准、exec cwd、`#untrustedRoots`；`workdir/service.ts` `#leaseTarget`（树根独占）/`policyInfo.cwd`/`promptSection({root})`/`gitRemote` 拒绝/C9 收窄到本 root 的树；`dispatch/tasks.ts` isolation 校验与落库/view 填充/retry 重建/续接不继承；`dispatch/orchestrator.ts` 建树 + 独占租约 + 结算卡 + 批准回调 + 崩溃恢复；`approvals.ts` `NEVER_AUTO_DECIDED`+`SURVIVES_RUN`；`start.ts` 装配 + 启动 sweep + 每日 reaper（`worktree_reaped` 审计）；`task-tools.ts` 参数与描述；渲染端 ApprovalCard/TaskCard/TaskRunView + i18n 双语；shared `worktreeApplyApprovalPayloadSchema`。
- **验证（主代理复跑）**：core 10 文件 176 用例全绿（含 4 个新增 worktree 测试文件与真 srt 用例）；渲染端/回归 15 文件 161 用例全绿；core/desktop typecheck 通过；D140-only 树 core typecheck + 18 用例全绿。
- **审查（A 段：创建/租约/沙箱双根/网关 path/exec cwd）**：修正 14 处，**高危 2**：① `.git` 指针文件位于沙箱可写的树内，任务可改写 `gitdir:` 把任意目录（含 `~/.kepcup`）顶进沙箱 readWrite——改为结构化校验（meta 必须 `<common>/worktrees/<name>`、`gitdir` 回指本树），无效即失去写挂载；② worktree 任务写主 workdir 会走 `needs_lease` 取租约、顶掉树租约并破坏「主目录只读」——改为网关直接 forbidden + `#leaseTarget` 拒绝。中危：worktree 分支先做数据目录硬拒（否则树落在数据目录内会先放行）；`.worktreeinclude` 复制的符号链接可写到树外（目标 lstat 检测 + realpath 校验）；还原点「备份失败却记不存在」会在回滚时删用户文件（改 restore/delete/skip 三态）；已存在 `.worktree` 目录不再 chmod/写 ignore；reaper 不跟随符号链接；`.worktree` home 对其他 run 读禁（否则树内 `.env` 副本绕过 protect）；C9 只放行本 root 的树（兄弟 root 不可选）；复用旧树前校验指针；默认挂载式后端（WSL/Podman/Lima）`WORKTREE_NOT_AVAILABLE`；路径 canonical 化；DEV-152 表述如实化（`objects/info/alternates` 残余风险）。
- **自选决策**：① 增强后端选「强制走 srt」；② applyState = 进程内 Map（512 上限）+ 推导兜底，跨重启退化如实记 DEV-153；③ 建树时机在 `#startTask`（落库后、取租约前），失败以 `WORKTREE_CREATE_FAILED` 结算；④ `.worktreeinclude` 完全交给 git 的 gitignore 引擎；⑤ 「有改动」判定用 `git diff <base> --numstat`（base 已含用户改动，`status --porcelain` 会把用户既有改动算成任务产出）。
- **遗留 / 偏差**：`DEV-152`（worktree 沙箱需放行共享对象库）、`DEV-153`（worktree 无 run_changes / 忽略文件不回流 / applyState 进程内推导 / 自动重试复用原树 / 建树不取主 workdir 租约 / 「有改动」判定口径）；worktree 只支持内置引擎 + srt；应用卡无 TTL；reaper 依赖命名形态、未注册 workdir 的 home 不扫描。

- **审查（B/C 段：上下文注入 / 任务面 / retry · continuation / 结算卡 / 批准回调 / reaper / 渲染端）**：逐条核对 §3.6 与 §6 W5 验收 6–10、§0.9 红线，direct 修正 15 处。**高危 1**：`git apply --3way` 隐含 `--index`，用户工作区只要有未暂存改动就报 `does not match index`——树的起点本就含用户的未提交改动，合同里「三方合并」按字面实现在最常见的 dirty 工作区里必然退化成假冲突（任务改了 A 处、用户改了 B 处也拒绝）。改法：把用户工作区当前 dirty / 未跟踪 / 已删除的**被触路径**物化进一份**私有索引副本**（`hash-object --no-filters` + `update-index --cacheinfo` + `--refresh`），`GIT_INDEX_FILE=<副本> git apply --3way`（「ours」= 磁盘真实内容，用户真实索引从不被改写）；补丁改 `--no-renames`（rename = delete+add，使补丁路径集 = 还原点路径集 = 合并路径集，用户改过一侧时如实冲突而非半写）。**中危**：① `summary()` / `apply()` 的 `git add -A -N` 返回值未检查——失败（索引锁 / 树索引损坏）会静默把未跟踪文件从摘要与补丁里丢掉；改为摘要返回 null（kept、不出卡）、应用直接失败。② 合并成功但 `worktrees.remove` 失败被当成应用失败（卡片 failed、状态 kept，改动其实已落地）；拆开清理与合并，清理失败只记日志并按 applied 收尾（reaper 兜底）。③ `runs.retry` 把旧树的路径原样写进新 run 的 `task_cwd`（新树是 `#startTask` 才建的）；改为 worktree 任务重试时把 `task_cwd` 重算为主 workdir（无可用 workdir 则 null），并补测试钉住「新树 base = 重试时的 HEAD」。**低危**：① `void this.#applyWorktree(...)` 无 `.catch`（回调内异常会成未处理 rejection，卡片停在 approved）；② 结算卡在 `submitNonBlocking` 前就置 `pending`（提交失败会永久 pending 且无卡）；③ 租约获取失败一律按「工作目录忙」提示（workdir 消失 / 对话已删被误报）；④ reaper 审计用 `record()` + 伪造 run id（改 `recordSystem`，并让启动 sweep 的 catch 走 `warnQuietly` 防关库后日志抛错）；⑤ `CoreServices.worktrees` 声明并初始化为 null 但**从未赋值**（永远 null；改在 `services.workdirRuntime` 旁赋值，重启/审计用例由此可测）；⑥ patch / restore-point 临时文件用可预测名字（`writeFileSync` 跟随预先埋好的符号链接），改 `mkdtempSync` 私有目录；⑦ 结算态 `TaskCard` 对已结束任务仍显示「需要你确认后，这个任务才能继续」（SURVIVES_RUN 的后置卡），改为只在活动任务上显示；⑧ 冲突决策把 git 的 `reason` 丢掉（非冲突型拒绝也报「三方合并冲突」）；⑨ 死代码 `RunsService.listWorktreeTasks()`、`runs.create` 的 W4/W5 TODO 注释、`task-tools` 的 isolation 描述语病；⑩ 抵抗「排队中把 Bot 切成外部智能体」的绕过：`#startTask` 的 worktree 段复查当前引擎（执行器读的是 Bot 当前引擎而非行上的 `engine`），不再让 ACP 进树；⑪ 结算后换绑工作目录再批准旧卡：`#applyWorktree` 先核对当前绑定与卡上的目标，不一致即如实拒绝（原实现会在租约解析里报「该路径不涉及 workdir 或 workspace」）。
- **审查验证**：`tasks-worktree.test.ts` 新增 3 例（workdir 被写占用时批准 → 卡 failed 含「稍后重试」、工作区无改动、树保留、写任务不中断；结算后换绑工作目录再批准 → 如实拒绝且树保留；同 home 重启 → 崩溃任务 interrupted + applyState kept + 无卡、超期孤儿被启动 sweep 回收且写 `worktree_reaped` 审计、非孤儿树保留）；`worktree-service.test.ts` 新增 2 例（未暂存编辑的三方合并成功且真实索引零改动、用户删除被任务修改的文件 → 冲突且保持删除）；retry 用例加「新树 base = 当时 HEAD、重试行 `task_cwd` = 主 workdir」。定向：core 7 文件 87 用例 + worktree 单测 18 例 + 相邻 tasks/workdirs/claims/auto-retry/parallel-writes 51 例全绿；渲染端 10 文件 111 例全绿；core / desktop typecheck 通过。
- **审查结论**：无人值守三条自动决策路径（`request` / `submitNonBlocking` / TTL）全部被 `NEVER_AUTO_DECIDED` 挡住（后置卡无 TTL，实测无人值守下 `autoApproved=false` 且保持 pending）；冲突恢复经「用户删除/任务修改」「同文件同行」「新建文件 + 冲突」三例验证工作区逐字节还原、真实索引零改动；`applyState` 重启推导为 kept/`applied` 兜底（已记 DEV-153 与 §8.12）。偏差与实现事实见 DEV-153、§8 第 10–13 条。

### W6

- **设计回写**：9 篇设计文档（`docs/design/` 的 README 决策表 + 02 / 06 / 08 / 10 / 13 / 28 / 30 / 59）。README 决策表新增 D140 一行（四条决策 + 配套 + 非目标 + 已知限制）并同步各篇索引摘要；30 §9.1 标题与正文改为「D140-4 修订：worktree 隔离作为 opt-in 实施」、四条理由逐条标注处置（①部分推翻并接受 ②双根/重锚已改造 ③git diff + 私有索引三方合并替换检查点 ④`.worktreeinclude` + 如实告知），保留「仍非默认方案」；59 §3/§5/§6/§7 改为共享两态 + 认领跨对话 + 并行默认；13 补 `task` 时长、多路径卡、worktree 默认可写与 `worktree_apply` 永不自动批准；10 补 worktree 双根与 DEV-152 残余风险；08 补共享租约/认领/worktree 位置与 apply；28 标明 ACP 不参与断网与 worktree；02 / 06 同步。
- **全量回归（两次，2026-11-24）**：
  - 第一次 912 文件 / 9899 用例：**5 文件 / 6 例失败**。逐个定性均为 D140 语义变更后的测试侧问题（无实现缺陷）：① `taint-egress` 的 bound-workdir 用例 fixture 缺 `worktree` 字段（生产实现必返回 `null`，只有测试 `as` 绕过类型）；② `gateway-allowlist-hardening` 的 taint stub 缺 `networkAllowed` 等新方法（且断言仍是旧「逐命令弹卡」语义，已按无沙箱降级路径写明）；③ `capability-mounting-tasks` 靠「等写域」制造排队，D140-1 已删除该排队——改用 `providerConcurrency:1` 的真实排队；④ `project-chat` 的 group-bound workdir 互斥断言按 D140-1 改写为「并行 + 跨对话文件认领 `WRITE_CLAIMED`」；⑤ 同文件 removing-member 用例等 `approval.created`，W2 后 access 卡 payload 变 `{paths:[…]}`，事件谓词兼容 `paths` 与历史单路径；⑥ `create-core` 的 runs 迁移计数硬编码 17，改为从迁移目录推导（runs 0018 / main 0083）。
  - 第二次 912 文件 / 9899 用例：**908 文件通过 / 9854 例通过 / 44 skipped / 1 例失败**——`permission-bridge.test.ts` 的一条**纯同步断言**用例在满载并发下 5s 超时（无 await、无可阻塞路径）；单跑 3 次均 30/30 绿，判定为负载抖动而非回归（按 AGENTS.md 只单跑复核，不再连续全量）。基线（2026-11-22）895 文件 / 9616 例全绿；本次 +17 文件 / +238 用例均为 D140 新增。
- **真实沙箱验证（macOS srt）**：`sandbox-isolation` 12 例（读宽：dotfile / 同级仓库可读，`~/.ssh`、`main.db`、workdir `.env` 禁读，区外写与 `~/.npm/_logs` 写失败；网络 none/allowlist 切断、open 可达、loopback 按设置保留）、`worktree-sandbox` 1 例（树内 `git status/diff/commit` 成功、`.git/config` 与树内 `.env` 仍禁写、主检出 HEAD 不变）、`toolchain-sandbox` 全绿。污点断网的策略面由 `taint-egress` 的 `policy.network.mode==='none'` 断言覆盖，与上面的真 srt 网络模式共同构成证据。
- **偏差 / 实现事实（如实记录）**：
  1. **worktree 与增强后端**：执行方案 §8 第 6 条括注「Lima 外的 Podman/WSL 挂载式」易被读成 Lima 可用；实现对所有挂载式后端（WSL / Podman / Lima）一律 `WORKTREE_NOT_AVAILABLE` 或强制默认 srt，设计文档按代码事实写。
  2. **多路径 access 卡范围**：批量合卡只发生在沙箱 bash 的多路径违规（`coding-tools`）；`request_access` 与文件工具仍单路径（契约如此，文档不宣称可批量）。
  3. **worktree 在 srt 不可用**：代码允许退回逐条确认模式（只拒绝挂载式后端），「强制 srt」的简写已在设计文档注明该降级路径。
  4. **`worktree` 任务不写 `run_changes`**（影子窗口要求 taskCwd 在主 workdir 内）→ DEV-153。
  5. **单提交**：W5 未按 §6 建议拆三个提交（三段改动在文件内交织），改为三段独立审查 + 单提交，D140-only 树已验证可独立构建。
- **遗留**：W1 的 Linux bwrap 分支真沙箱用例本机只验 macOS；`permission-bridge` 全量下的负载抖动如需可加测试超时或减少并行 worker（未做，非 D140 引入）；`packages/core/dist` 为本机未跟踪旧产物，与本次无关。
