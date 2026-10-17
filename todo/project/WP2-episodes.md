# WP2 · 协作回合与熔断（`chain → episode`，后端）

> 依赖：WP1 已合入。后续：WP3（路由依赖本 WP 的回合绑定）。分支：`feat/project/wp2-episodes`。
> 先读 [README.md](README.md) §1、§4.3（`episodes` DDL）、§4.4–§4.8；设计依据 [41 §7](../../docs/design/41-project-team.md)。

## 1. 背景与目标

现状（已核实）：`ChainsService`（`dispatch/chains.ts`）管 Bot 之间 `@` 的深度（≤3）与 token 预算（200k）。缺口：**任务结算唤醒的对话轮不带 `chain`**——`orchestrator.ts` 里 TaskHost 的 `wake` 回调只投递 `{ reason: 'task', messages: [entry] }`，`#startTurn` 只在 `batch.chain` 存在时才给 run 绑 `chain_id`，任务 run 自身也不绑。结果：隔一个任务就会新开连锁，深度与预算被重置，D4 的防环在宿主层被绕过。

本 WP：
1. 把「连锁」重构为「**协作回合（episode）**」，**移除** token 预算与硬性深度上限；
2. **修复**任务结算唤醒不继承的缺口；
3. 新增**熔断**：一个回合里 Bot 发起的 `@` 超过阈值就暂停，**不丢弃**，等用户在对话里的「协作暂停卡」上点「继续 / 停止」；
4. 把触发原因 `chain` 改名为 `bot_mention`。

不做：路由行为（WP3）、暂停卡的界面（WP8）、提示词规则（WP4）。

## 2. 固定契约（本 WP 涉及的部分，名字不得改）

- 表 `episodes`、迁移 `main/0041_episodes.sql`、runs 迁移 `runs/0014_episode_columns.sql`：见 README §4.3。
- ID 前缀：删 `chn`、增 `epi: 'epi_'`。
- shared：`episodeStatusSchema`、`episodeSchema`（`{ id, conversationId, status, hops, pausedAt, pendingCount, createdAt }`）、`runSchema.episodeId / episodeHop`（替换 `chainId / chainDepth`）、`systemEventContentSchema.episodeId`（可选）。
- RPC：`episodes.get` / `episodes.resume` / `episodes.stop`（README §4.5）；事件 `episode.updated: { episode }`。
- 触发原因：`chain` → `bot_mention`（**本 WP 只改这一个**；其余新原因归 WP3）。
- 常量：新增 `EPISODE_HOP_BREAKER = 12`、`EPISODE_PINGPONG_BREAKER = 8`；删除 `BOT_CHAIN_MAX_DEPTH`、`BOT_CHAIN_TOKEN_BUDGET`。
- 系统消息事件：`episode_paused`（非 internal，带 `episodeId`）；`episode_stopped`（**internal**，加入 `INTERNAL_SYSTEM_EVENTS`）。
- 熔断语义（精确）：一个回合内，Bot 发起的触发**最多放行 `EPISODE_HOP_BREAKER` 次**，**第 13 次被暂停**；同一无序 Bot 对之间**最多放行 `EPISODE_PINGPONG_BREAKER` 次**，**第 9 次被暂停**。两个条件任一先到即暂停。

## 3. 开工前核对

```bash
ls packages/core/migrations/main | tail -2     # 应是 0039、0040
ls packages/core/migrations/runs | tail -2     # 应是 0012、0013
rg -n "ChainsService|chains\.mention|#chains" packages/core/src
rg -n "listIdsByChain|sumForRuns|tokensInFlightFor" packages --glob '*.ts'   # 调研：只有 chains.ts / runs.ts / usage.ts / orchestrator.ts 用
rg -n "'chain'" packages apps --glob '*.ts' --glob '*.svelte' -g '!**/dist/**'
```

必读源码：`dispatch/chains.ts`（全文，约 140 行）、`dispatch/orchestrator.ts`（搜 `#chains`、`onMentionBots`、`#startTurn`、`#absorbIntoTurn`、`wake:`、`downgradeLabel`）、`scheduler/mailbox.ts`（`TriggerBatch`、`canShareTurn`、`mergeTriggerBatches`、`refreshTriggerBatch`）、`domain/runs.ts`（`create`、`setTrigger`、`update`、`listIdsByChain`）、`dispatch/tasks.ts`（任务 run 创建处，约 l.703–716，`originRunId: identity.runId`）、`tools/index.ts`（`send_message` 里调 `onMentionBots` 处，约 l.409–432）。

## 4. 步骤

### 步骤 1：迁移

`packages/core/migrations/main/0041_episodes.sql`：

```sql
-- D92 T1a: Bot-to-Bot @ chains become collaboration episodes (no token budget, no hard depth; circuit breaker instead).
DROP TABLE chains;

CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,                       -- epi_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  hops            INTEGER NOT NULL DEFAULT 0,
  pair_hops_json  TEXT NOT NULL DEFAULT '{}',
  pending_json    TEXT NOT NULL DEFAULT '[]',
  paused_at       INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX episodes_by_conversation ON episodes(conversation_id, created_at);
```

`packages/core/migrations/runs/0014_episode_columns.sql`：

```sql
-- D92 T1a: chain_id / chain_depth -> episode_id / episode_hop.
ALTER TABLE runs RENAME COLUMN chain_id TO episode_id;
ALTER TABLE runs RENAME COLUMN chain_depth TO episode_hop;
```

- `runs.db` 没有 `chain_id` 的索引（核对：`rg -n chain packages/core/migrations/runs`，调研时只有列定义与一条注释）。旧开发库里 `chain_id` 的值（`chn_…`）会原样成为 `episode_id`，无对应 `episodes` 行——**无害**，代码对找不到行的 `episode_id` 一律按「无回合」处理（见步骤 3 的 `bindingOfRun`）。
- 更新写死的版本号：`create-core.test.ts` main `40 → 41`、runs `13 → 14`；`workbench-migration.test.ts` 等按实况（用 `mainVersionsAfter` / `runsVersionsAfter` 的不用改）。
- 新增迁移测试 `test/unit/episodes-migration.test.ts`：建到 main 40 / runs 13 → 插 `chains` 行与带 `chain_id` / `chain_depth` 的 run → 应用后断言：`chains` 表不存在、`episodes` 存在且约束生效（`status` CHECK、`conversation_id` FK 级联）、`runs.episode_id / episode_hop` 保留旧值、旧列名不存在。

### 步骤 2：shared

1. `ids.ts`：删 `chn`，加 `epi: 'epi_'`。
2. `domain/types.ts`：`runSchema` 的 `chainId / chainDepth` → `episodeId / episodeHop`（`nullable`，约 l.1423）；新增 `episodeStatusSchema`、`episodeSchema`、类型 `Episode`；`systemEventContentSchema` 增 `episodeId: z.string().optional()`；`triggerReasonSchema` 的 `'chain'` → `'bot_mention'`。
3. `constants.ts`：删 `BOT_CHAIN_MAX_DEPTH`、`BOT_CHAIN_TOKEN_BUDGET`；加 `EPISODE_HOP_BREAKER = 12`、`EPISODE_PINGPONG_BREAKER = 8`；`INTERNAL_SYSTEM_EVENTS` 加 `'episode_stopped'`；`AGENT_TURN_BUDGET_TOKENS` 的注释（提到「chain budget」「约 20 轮」）改写成它现在的唯一用途（Agent 引擎零用量行的记账值）。
4. `rpc/methods.ts`：加 `episodes.get`、`episodes.resume`、`episodes.stop`（input `{ id: z.string().min(1) }`，output `{ episode: episodeSchema }`）；`rpc/events.ts`：加 `episode.updated`（`{ episode: episodeSchema }`），并登记到 `rpcEventSchemas`。
5. `settings-catalog/mode.ts`：`SETTING_DIRECT_TRIGGERS` 若含 `'chain'` 的话改名（调研时 `workbench-tools.test.ts` 有 `'chain'` 作为「非本人触发」的例子，应改 `'bot_mention'`；**逻辑不变**：Bot `@` 触发的轮不算用户本人触发）。

### 步骤 3：core

1. **`domain/runs.ts`**：行类型 / 映射 / `create` 入参 / `update` patch / `setTrigger` 参数里的 `chainId / chainDepth / chain` 全部改名 `episodeId / episodeHop / episode`；SQL 列名同步；**删除** `listIdsByChain`。**`domain/usage.ts` 删除 `sumForRuns`**（调研：只被 chains 使用）及其测试。
2. **`dispatch/chains.ts` → `dispatch/episodes.ts`**（`git mv`），类 `EpisodesService`。依赖：

```ts
export interface EpisodesDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  runs: RunsService;
  /** Hands a trigger batch to the target bot's mailbox. */
  deliver(batch: TriggerBatch): void;
  /** Appends + publishes a system event message (visible unless `internal`). */
  appendSystemEvent(input: { conversationId: string; event: string; text: string; episodeId?: string; internal?: boolean }): void;
  publishEpisode(episode: Episode): void;           // emits 'episode.updated'
  /** Test override of the breaker thresholds (defaults come from shared constants). */
  limits?: { hops?: number; pair?: number };
}
```

   公开方法：

```ts
mention(identity: RunIdentity, mentionBotIds: string[], message: Message): string; // send_message hook; returns a suffix for the tool result
get(id: string): Episode | null;
resume(id: string): Episode;   // INVALID_INPUT if not paused
stop(id: string): Episode;     // INVALID_INPUT if not paused/active? -> see below
bindingOfRun(runId: string): { id: string; hop: number } | null;  // for task-wake inheritance
```

   **`mention` 算法**（在 `ChainsService.mention` 现有校验基础上改，保留对成员 / 自己 / 非 active 的过滤与提示文案风格）：
   1. `identity.botId` / `conversationId` 为空 → 返回 `''`；会话不是 `type === 'project'` → 返回 `'（仅项目组中可以 @ 其他 Bot，本次 @ 未触发任何人）'`。
   2. 过滤目标：去重；不能是自己；必须是 active 成员；`valid` 为空 → `'（@ 未触发：目标不是当前项目组的成员）'`；`skipped` 列表用于结尾提示 `（未触发：{名字} 不是项目成员）`。
   3. 取当前 run：`episodeId = run.episodeId`、`hop = (run.episodeHop ?? 0) + 1`。**`episodeId` 非空但 `episodes` 表里没有这一行**（旧库遗留）→ 视为无回合。
   4. 没有回合 → 新建一行（`status='active'`，`root_batch_id` 取触发消息的 `batchId`，没有则 `run:${runId}`，同旧实现），并把**发起 run** 绑为根：`runs.update(identity.runId, { episodeId, episodeHop: 0 })`。
   5. 回合 `status === 'stopped'` → 返回 `'（协作已被用户停止，@ 未触发）'`，不投递。
   6. 回合 `status === 'paused'` → 把本次所有 `valid` 目标追加到 `pending_json`（项：`{ toBotId, fromBotId, messageId, hop }`），**不再发第二张暂停卡**，返回 `'（协作已暂停，等待用户确认是否继续）'`。
   7. 计算新计数：`newHops = hops + valid.length`；对每个目标，无序对键 `[fromBotId, toBotId].sort().join('|')` 的计数 +1。若 `newHops > limits.hops`（默认 `EPISODE_HOP_BREAKER`）或任一对计数 `> limits.pair`（默认 `EPISODE_PINGPONG_BREAKER`）→ **熔断**：同一事务里置 `status='paused'`、`paused_at=now`、把本次 `valid` 目标写入 `pending_json`（**计数不增加**）；追加系统消息 `appendSystemEvent({ event: 'episode_paused', text: '协作已自动往返 {n} 次，已暂停', episodeId })`（`n` = 当前 `hops`）；`publishEpisode`；返回 `'（协作已暂停，等待用户确认是否继续）'`。
   8. 否则放行：事务里更新 `hops`、`pair_hops_json`；对每个 `valid` 目标 `deliver({ conversationId, botId, messages: [message], reason: 'bot_mention', extraAttributes: { from_bot: fromName, hop }, episode: { id: episodeId, hop } })`；`publishEpisode`；返回 `（已通知 {n} 个 Bot，协作第 {newHops} 次）` + skipped 提示。
   - 所有对 `episodes` 的读改写都在 `db.transaction(...).immediate()` 内（`runs` 在另一个库，**不要**把 `runs.update` 放进 main 事务，按旧实现的顺序先后调用即可）。

   **`resume(id)`**：`status` 必须是 `'paused'`（否则 `INVALID_INPUT`「协作不在暂停状态」）；取 `pending`，置 `status='active'`、`paused_at=NULL`、`hops=0`、`pair_hops_json='{}'`、`pending_json='[]'`（事务内）；然后按顺序逐项 `messages.getById(item.messageId)`，已不存在或 `status==='recalled'` 的跳过，其余 `deliver({ …reason:'bot_mention', extraAttributes:{ from_bot: <fromBot 名>, hop: item.hop }, episode:{ id, hop: item.hop } })`；`publishEpisode`；返回回合。**待投递项不计入新一轮计数**。
   **`stop(id)`**：`status` 必须是 `'paused'` 或 `'active'`（已 `stopped` → 原样返回，幂等）；置 `status='stopped'`、`paused_at=NULL`、`pending_json='[]'`；追加 **internal** 系统消息 `episode_stopped`（text：`用户已停止本次协作（不再继续 Bot 之间的往返）`），`publishEpisode`；返回回合。停止后同一回合内的 `mention` 一律返回 stopped 文案（步骤 5）。
   **`bindingOfRun(runId)`**：读 run 的 `episodeId / episodeHop`；`episodeId` 空，或 `episodes` 无此行 → `null`；否则 `{ id, hop: episodeHop ?? 0 }`。
   `episodes` 行 ↔ `Episode`：`pendingCount = JSON.parse(pending_json).length`；`pausedAt`、`hops` 直接映射。
3. **`scheduler/mailbox.ts`**：`TriggerBatch.chain?: { id; depth }` → `episode?: { id: string; hop: number }`；联合类型里的 `'chain'` → `'bot_mention'`；`canShareTurn` 里的 chain 规则整体改名为 episode（语义**不变**：两个绑定同一回合的批可合并；绑定回合的批与「带用户消息的未绑定批」不合并；理由注释改写：把用户消息并进一个回合绑定的轮，会让回答用户的 `@` 受该回合暂停状态影响）；`mergeTriggerBatches` 取**最深**（`hop` 最大）的绑定；`refreshTriggerBatch` 保留 `episode`。`USER_FACING_REASONS` 不含 `bot_mention`（保持优先级 1）。
4. **`dispatch/orchestrator.ts`**：
   - 构造处（约 l.899–915）：`new ChainsService({ … tokensInFlightFor … })` → `new EpisodesService({ …, appendSystemEvent, publishEpisode })`（删除 `tokensInFlightFor`、`usage` 依赖）。`appendSystemEvent` 复用 `start.ts` 里 WP1 建的助手（给它加可选 `episodeId` / `internal`；internal 的写法参照 `schedule_fired` / `watch_alert` 的追加处，`rg -n "internal: true" packages/core/src`）。
   - `buildResponseTools` 的 `onMentionBots`（约 l.4095–4102）改调 `#episodes.mention`。
   - `#startTurn`（约 l.2642–2656）：`batch.episode` → `{ episodeId: batch.episode.id, episodeHop: batch.episode.hop }`。**新增**：`batch.retryOf` 非空且 `batch.episode` 缺省时，取被重试 run 的 `episodeId / episodeHop` 绑定（重试不应丢回合）。
   - `#absorbIntoTurn`（约 l.4789–4802）：同步改名。
   - **任务结算唤醒继承**（修复缺口，核心）：TaskHost 的 `wake` 回调（约 l.719–728）：

```ts
wake: (botId, conversationId, entry) => {
  const task = entry.taskId !== null ? deps.runs.get(entry.taskId) : null;
  const origin = task?.originRunId ? deps.runs.get(task.originRunId) : null;
  const episode = origin !== null ? this.#episodes.bindingOfRun(origin.id) : null;   // resolved at wake time, not at task start
  this.#mailboxes.for(botId, conversationId).deliver({
    conversationId, botId, messages: [entry], reason: 'task',
    ...(episode !== null ? { episode } : {}),
  });
},
```

     **在唤醒时解析**（而不是任务启动时）是有意的：发起任务的那一轮可能在任务启动**之后**才第一次 `@`、才建立回合。任务 run 自身**不绑**回合（没有 token 预算要统计）。
   - `downgradeLabel`（约 l.570）：`case 'chain'` → `case 'bot_mention'`，文案改「项目里其他 Bot @ 了你」。
5. **`agent/types.ts`**：`RunIdentity` 上从未被填充的 `chainId? / chainDepth?` 字段**删除**。`agent/subagent.ts` 里关于「子 run 不继承 chainId」的注释改写为「子 run 不绑定协作回合」。
6. **`rpc/bindings.ts`**：新增 `episodes.get`（找不到 → `NOT_FOUND`）、`episodes.resume`、`episodes.stop`。
7. **`start.ts`**：装配 `EpisodesService`；`publishEpisode` → `events.emit('episode.updated', { episode })`。
8. **删除**：`dispatch/chains.ts`（已改名）里所有旧逻辑；`runs.listIdsByChain`；`usage.sumForRuns`；`ChainsService` 的所有引用与测试。

### 步骤 4：renderer 最小编译修复

`rg -n "chainId|chainDepth|'chain'" apps/desktop/src` ；`Run` 类型字段改名即可（界面不显示它们）。**暂停卡的界面不在本 WP**（WP8）。

## 5. 测试

**重写 / 删除**（`packages/core/test/integration/project-chat.test.ts`，WP1 由 `group-chat.test.ts` 改名而来）：
- 删除：`chains stop after 3 levels`、`chain token budget…`、`chain budget counts the root run…`（深度与预算已不存在）。
- 保留并改名：`send_message @ B triggers…`（断言 `triggerReason === 'bot_mention'`，约 l.385、l.896 的 `'chain'` 断言）、`a chain run holding the mailbox…`（改用 episode 措辞）。
- `test/unit/supervisor-turn.test.ts`：所有 `chain: { id: 'chn_…', depth }` → `episode: { id: 'epi_…', hop }`，`batch('chain', …)` → `batch('bot_mention', …)`；用例名里的 chain 改 episode；断言不变（合并 / 不合并规则不变，取最深）。
- `test/integration/tasks-review-fixes-e.test.ts` 的 `describe('M1: an absorbed @-chain batch keeps its chain binding'` → 改为 episode 措辞，断言改成 `episodeId / episodeHop`。
- `test/unit/workbench-tools.test.ts` 约 l.907 的 `'chain'` → `'bot_mention'`。

**新增**：
- `test/unit/episodes-service.test.ts`（用内存库 + 假 `deliver` / `appendSystemEvent` / `publishEpisode` 记录器；`limits` 传小值如 `{ hops: 3, pair: 2 }`）：
  1. 首次 `mention` 建回合并把发起 run 绑为 `hop 0`；`deliver` 收到的批 `reason==='bot_mention'`、`episode.hop===1`、`extraAttributes.from_bot`；返回文案含 `协作第 1 次`；
  2. 由被投递的 run 再次 `mention` → `hop===2`，同一回合 id；
  3. 非项目会话 / 目标不是成员 / 自己 → 对应文案且不投递；
  4. **总数熔断**：放行恰好 `limits.hops` 次，第 `limits.hops + 1` 次**不投递**、回合 `status==='paused'`、`pending_json` 含该次目标、追加**恰好一条** `episode_paused` 系统消息（带 `episodeId`）、`publishEpisode` 被调用；
  5. **成对熔断**：A→B、B→A 混合累计到 `limits.pair` 后下一次触发被暂停，且比总数熔断先发生；
  6. 暂停期间再 `mention`：追加到 `pending_json`、**不再**追加第二条暂停消息、返回暂停文案；
  7. `resume`：按顺序投递 pending（`recalled` / 已删除的消息跳过）、`hops` 与 `pair_hops_json` 清零、`status==='active'`、`pending_json` 为空；对非暂停回合 → `INVALID_INPUT`；
  8. `stop`：`status==='stopped'`、pending 清空、追加 **internal** `episode_stopped`；之后 `mention` 返回 stopped 文案且不投递；对已 stopped 幂等；
  9. `episode_id` 指向不存在的 `episodes` 行（旧库遗留）→ 视为无回合，新建；
  10. `bindingOfRun`：有 / 无 / 行不存在三种情形。
- `test/integration/episodes-inheritance.test.ts`（**修复缺口的回归测试，必须有**）：用 mock LLM 脚本：项目组里 A（负责人）`send_message @B` → B 的轮里 `start_task`（参照 `tasks-review-fixes-e.test.ts` 的 mock 写法）→ 任务完成后**唤醒 B 的下一个对话轮**：断言该轮的 run 行 `episode_id` 等于 A→B 那条回合的 id（**不是新回合**），`episode_hop` = B 那轮的 hop；B 该轮再 `@A` 时，`episodes.hops` 在原计数上继续增加（没有新建回合行：`select count(*) from episodes where conversation_id = ?` 仍为 1）。再加一个反例：发起任务的轮此前**从未 `@` 过任何人**时，唤醒的轮不绑回合（`episode_id` 为 NULL）。
- `test/integration/episodes-breaker.test.ts`：经 `EpisodesDeps.limits` 的测试注入（或在 `start` 的测试夹具里传入），两个 Bot 脚本化来回 `@` 到熔断：对话里出现一条 `episode_paused` 系统消息；`episodes.get` 状态为 `paused`；经 RPC `episodes.resume` 后被暂停的触发被投递、Bot 继续响应；`episodes.stop` 路径：状态 `stopped`、不再投递。
- `test/integration/episodes-rpc.test.ts`：`episodes.get`（含找不到 → `NOT_FOUND`）、`resume`、`stop`、`episode.updated` 事件被推送。
- 迁移测试（步骤 1）。

## 6. 验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck
node scripts/run-tests.mjs run packages/core/test/unit/episodes-migration.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/episodes-service.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/episodes-inheritance.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/episodes-breaker.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/episodes-rpc.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/project-chat.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/supervisor-turn.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/tasks-review-fixes-e.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/create-core.test.ts
```

收口不跑全量（WP3 之后再跑），但因为改了 shared 契约与迁移，**本 WP 结束前跑一次全量**，失败集合不得超出基线。

## 7. 验收清单

- [ ] `chains` 表、`ChainsService`、`BOT_CHAIN_*`、`listIdsByChain`、`sumForRuns`、`tokensInFlightFor`、`RunIdentity.chainId` 全部消失；自检：

```bash
rg -n "ChainsService|BOT_CHAIN|listIdsByChain|sumForRuns|tokensInFlightFor|chainId|chainDepth|chain_id|chain_depth|'chain'|\.chain\b|ID_PREFIXES\.chn|newId\('chn'\)" packages apps -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
```

  应为空（历史迁移 SQL 与 `0014` 里的旧列名除外）。
- [ ] 任务结算唤醒的对话轮**继承**发起轮的回合（`episodes-inheritance` 通过），且在唤醒时解析。
- [ ] 熔断：放行 12 / 第 13 次暂停；成对 8 / 第 9 次暂停；暂停不丢触发；`resume` 投递、`stop` 清空；暂停卡系统消息只出现一次；无人值守模式不影响（它不是审批，没有自动继续的代码路径）。
- [ ] 触发原因 `bot_mention` 全仓一致；`downgradeLabel` 文案已改。
- [ ] 三个迁移相关版本断言已更新；全量失败集合不超出基线。
- [ ] 实施记录已填。

## 8. 陷阱

- **不要**把「任务 run 绑回合」当作修复方式：修复点是**唤醒时**按发起 run 解析（见步骤 3.4）。任务 run 不绑，是有意的。
- `episodes` 在 main 库、`runs` 在 runs 库，**不能同事务**；先后顺序按旧 `ChainsService` 的做法（建回合行 → `runs.update`），崩溃窗口里最多留一个没绑 run 的回合行，无害。
- 熔断是**保险丝，不是审批**：不要往 `approvals` 加 kind（`kind` 有表级 CHECK，要重建表）；不要被无人值守的「自动批准一切」逻辑覆盖。
- `bot_mention` **不进** `SETTING_DIRECT_TRIGGERS`（Bot `@` 触发的轮不是用户本人触发）。
- 不要改 `TASK_TOKEN_BUDGET` / `SUBAGENT_TOKEN_BUDGET` / 后台每日预算：它们是单次运行的成本保险，与本 WP 无关。
- 不要提前做 WP3 的 `continuation / routed / lead_fallback` 等新触发原因。

## 9. 实施记录

（执行智能体在此填写：分支、提交列表、测试结果、偏差编号。）

**分支 / 提交**（`feat/project/migration`，未 push；2026-10-17）：

- `d724a07` feat(shared,core)!: turn bot-to-bot chains into collaboration episodes (D92 T1a WP2)：迁移 `main/0041_episodes.sql` + `runs/0014_episode_columns.sql`、shared 契约（`episodeSchema` / `runSchema.episodeId/episodeHop` / `systemEventContentSchema.episodeId` / 触发原因 `bot_mention` / 常量 / RPC / 事件）、`EpisodesService`（`dispatch/episodes.ts`，`git mv` 自 `chains.ts`）、任务唤醒继承（wake 时按 origin run 解析）、重试继承、`episodes.get/resume/stop` RPC、`episode.updated` 事件、`episode_paused` / internal `episode_stopped` 系统消息、全部测试（重写 + 新增）。
- 文档提交：本文件实施记录、todo/project/README §7 进度表、`docs/dev/01-conventions.md` ID 表 `chn_` 行 → `epi_`（§4.2 允许 WP 内顺手做；常量表按 §4.8 留给 WP11）。

**迁移编号**：开工时 main 最新 `0040`、runs 最新 `0013`，按任务书编号使用 `0041` / `0014`，无顺延。写死版本号的断言同步：`create-core` main 40 → 41、runs 13 → 14（并把 0013 行补进注释）；`workbench-migration` `[37…40]` → `[37…41]`；`workdirs-rename-migration` `[38…40]` → `[38…41]`；`project-conversations-migration` `[39, 40]` → `[39, 40, 41]`（其余用 `mainVersionsAfter` / `runsVersionsAfter` 的不用改）。

**全量暴露的两处迁移形态测试（已修，属任务书「写死版本号的测试同步更新」范畴）**：

- `public-skills-migration`：它的回拨流程先全量迁移到最新（此时 `chains` 已被 0041 删掉、`episodes` 已建出），再回 `user_version = 12` 原样重放——0041 的 `DROP TABLE chains` 因此扑空。修法与该测试既有模式一致：回拨段里 `drop table episodes` + 按 0006 原形态重建 `chains`（其它新表是「摘除以重建」，0041 反过来要求旧表**存在**）。
- `tool-effects-migration`：run 行保留断言的键映射补上 0014（`chain_id/chain_depth` → `episode_id/episode_hop`），写法照 0013 的 `task_workdir → task_cwd` 先例。

**测试结果**（2026-10-17，macOS arm64 宿主）：

- typecheck 三包（shared build → core build → desktop tsc + svelte-check）与 `pnpm lint` 通过。
- 定向全绿：`episodes-migration`（2）、`episodes-service`（12）、`supervisor-turn`（22）、`episodes-inheritance`（2）、`create-core`（9）、`project-chat`（20 过 1 skip，skip 为 WP1 登记的 WP3 项）、`tasks-review-fixes-e`（M1 改为成对熔断 + 暂停卡断言）、`episodes-breaker`（2）、`episodes-rpc`（3）、shared 全部（337）、其余受改动影响的单测 / 安全测试（external-agent-p5、continuation、my-state、workbench-*、workdirs-rename、project-conversations-migration、memory、memory-pollution 等 8 文件 134 例）。
- 全量 `pnpm test`（收口跑一次）：5371 通过 / 2 失败 / 24 skip；2 个失败即上述两处迁移形态测试，修复后各自单跑通过（按 AGENTS.md 不做连续全量）。失败集合不含沙箱 / skills / wiki-url / workspace-tools 环境基线项，不超基线。

**rg 自检（验收清单第 1 条）**：命令输出仅剩三类，均为例外——

1. `Composer.svelte:424` 的 `.chain()`：TipTap 编辑器命令链，与 Bot 连锁无关（「别的含义」）。
2. `episodes-migration.test.ts` 里的 `chain_id / chain_depth / 'chn_legacy'`：迁移测试的对象就是旧列名（建旧形态 → 断言改名后旧列不存在），属「0014 里的旧列名」例外。
3. `tool-effects-migration.test.ts` 键映射里的 `chain_id / chain_depth`：同上，断言旧值在改名后存活。

**实现取舍（由我判断，依据如下）**：

- WP 步骤 3.4 说 `appendSystemEvent` 复用 start.ts 里 WP1 建的同名助手：实际复用的是 orchestrator 自己的 `#appendSystemMessage`（WP1 的 start.ts 助手服务 ProjectsService 生命周期、不支持 `internal` / `episodeId`，且 orchestrator 内已有同一写法、同一发布路径的私有助手，直接给它加了可选 `episodeId` / `internal`）。行为与任务书要求一致（追加 + 发布、internal 不推 `message.created` 且读取侧过滤）。
- `EpisodesDeps.limits` 的测试注入另有两条通道：`OrchestratorDeps.episodeLimits`（单测直构）与 `start.ts` 的 `KEPCUP_EPISODE_HOP_BREAKER` / `KEPCUP_EPISODE_PAIR_BREAKER` 环境变量（集成测试 / `createTestStack({ env })`，§4 没写到的名字按相邻 `KEPCUP_TRIAGE_TIMEOUT_MS` 风格取，在此登记）。
- 熔断暂停卡的 `{n}` 取当前 `hops`（不含被暂停的这一次），与 §4.9 文案「协作已自动往返 {n} 次，已暂停」一致；成对熔断先于总数熔断发生时同样按当前 `hops` 计。
- `resume` 对 pending 项逐条 `messages.getById`，消息已删除（`null`）或 `recalled` 跳过；补投沿用 pending 里记录的 `hop`（不重新计数），与任务书「待投递项不计入新一轮计数」一致。
- `orchestrator` 新增 `episodes` 只读暴露（getter）供 `rpc/bindings.ts` 使用，与 `taskHost` 的暴露方式相同。
- 同步点实况：`agent/context/conversation.ts` 的 `<trigger>` 段对 reason 是通用渲染（无 chain 专属文案），无需改动；`SETTING_DIRECT_TRIGGERS` 本就不含 `'chain'`（只有 `workbench-tools.test.ts` 把 `'chain'` 当「非本人触发」例子，已改 `'bot_mention'`），`bot_mention` 未加入该集合——两者任务书均已预见。
- renderer 无需改动：`rg "chainId|chainDepth|'chain'" apps/desktop/src` 为空（`Run` 新字段名界面不读）。

**偏差**：无（未新增 DEVIATIONS 条目；WP 与代码现实无冲突）。
