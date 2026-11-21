import { newId, type LoopType } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

export interface UsageRecordInput {
  runId: string;
  botId: string | null;
  conversationId: string | null;
  loopType: LoopType;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  /**
   * D124 能力模型条目维度（迁移 0075 两列，均 nullable）：插件条目调用记
   * `capability`（能力名）与 `model_entry_id`（'{pluginId}/{entryId}'）；全局
   * 槽位路径两列留空（NULL），旧行读出 NULL。
   */
  capability?: string | null;
  modelEntryId?: string | null;
  /**
   * 62.11 C7: the principal the usage row is attributed to. Resolved inside
   * `record` when omitted — via the injected runs-principal source (the run's
   * `principal_id`); no run reference = NULL. Explicit null skips the lookup.
   */
  principalId?: string | null;
}

/** One local-day bucket aggregated by SQLite (`localtime`, same zone as the app). */
export interface UsageDailyTotal {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output. */
  tokens: number;
  calls: number;
  costUsd: number | null;
}

export interface UsageModelTotalRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  calls: number;
  costUsd: number | null;
}

export interface UsageDailyModelRow {
  date: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
}

export interface UsageLoopTotalRow {
  loopType: LoopType;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  calls: number;
}

export interface UsageBotTotalRow {
  botId: string | null;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  calls: number;
}

/**
 * 62.11 C7（T6 team.usage.mine 口径）：一个主体按本地日的用量汇总（纯 SQL
 * 聚合，只读，不写库、不注册 RPC；团队层据此实现「我的用量」）。
 */
export interface PrincipalUsageDay {
  /** 'YYYY-MM-DD'（created_at 的服务器本地日期，同 usage.summary 的口径）。 */
  day: string;
  /** 行数。 */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** SUM；无 cost 的行按 0。 */
  costUsd: number;
}

/**
 * T9（62.03 D137）只读账行游标读取：`usage_ledger` 的一行（含 C7 主体归属）。
 * 宿主（团队层）以 `rowid` 为游标增量拉取、以 `id`（账行主键）做分摊幂等的
 * 去重键；core 不解释分摊口径，只保证按 rowid 升序增量可见。
 */
export interface UsageLedgerRow {
  /** SQLite rowid（游标键；单调递增，但删除空洞后不保证连续）。 */
  rowid: number;
  /** 账行主键（`use_…`）——宿主分摊幂等的去重键。 */
  id: string;
  runId: string;
  botId: string | null;
  conversationId: string | null;
  loopType: LoopType;
  /** C7 记账时写入的归属主体；null = 系统消耗（单用户形态）。 */
  principalId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  createdAt: number;
}

/** 按工具的任务上下文消耗（内容估算，仅内置任务；不是计费 token）。 */
export interface ToolUsageRecordInput {
  runId: string;
  botId: string | null;
  conversationId: string | null;
  loopType: LoopType;
  toolName: string;
  /** 工具调用参数（模型输出侧）。 */
  callTokens: number;
  /** 工具返回内容进入上下文的估算 token（输入侧）。 */
  resultTokens: number;
  calls?: number;
}

export interface UsageToolTotalRow {
  toolName: string;
  resultTokens: number;
  callTokens: number;
  tokens: number;
  calls: number;
}

export interface UsageChatSessionRow {
  conversationId: string;
  botId: string | null;
  minutes: number;
  startedAt: number;
  endedAt: number;
}

/** A chat session ends after this much silence between two text messages. */
export const CHAT_SESSION_GAP_MS = 30 * 60 * 1000;

/** Local-day expression shared by every usage aggregation (SQLite localtime). */
const LOCAL_DAY = "date(created_at / 1000, 'unixepoch', 'localtime')";

/** One usage ledger row rolled up per run (任务详情页的上下文用量). */
export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  /** 最近一次主循环调用的 prompt 总量（input + cacheRead + cacheWrite），上下文占用的近似值。 */
  contextTokens: number | null;
  /** 最近一次主循环所用模型的上下文窗口，由调用方解析；查不到为 null。 */
  contextWindow: number | null;
  /** 加权命中率 = ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite)；分母为 0 时为 null。 */
  cacheHitRate: number | null;
}

/** Append-only usage ledger (docs/design/14-models-and-browser.md). */
export class UsageService {
  /**
   * Runs-principal source (62.11 C7): `RunsService.principalOf`, attached by
   * the composition root once both services exist. Usage rows live in main.db
   * and runs in runs.db, so attribution is resolved at write time instead of
   * joining across databases. Absent (stripped test setups) = NULL.
   */
  #principalSource: ((runId: string) => string | null) | null = null;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    principalSource?: (runId: string) => string | null,
  ) {
    this.#principalSource = principalSource ?? null;
  }

  /** Late attachment for compositions that build the runs service after this one. */
  attachPrincipalSource(source: (runId: string) => string | null): void {
    this.#principalSource = source;
  }

  record(input: UsageRecordInput): void {
    // 62.11 C7: attribution defaults to the run's principal (explicit null
    // skips the lookup; no source / no match = NULL, the single-user shape).
    const principalId =
      input.principalId !== undefined
        ? input.principalId
        : (this.#principalSource?.(input.runId) ?? null);
    this.db
      .prepare(
        'insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, capability, model_entry_id, principal_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId('use'),
        input.runId,
        input.botId,
        input.conversationId,
        input.loopType,
        input.provider,
        input.model,
        Math.max(0, Math.round(input.inputTokens)),
        Math.max(0, Math.round(input.outputTokens)),
        Math.max(0, Math.round(input.cacheReadTokens ?? 0)),
        Math.max(0, Math.round(input.cacheWriteTokens ?? 0)),
        input.costUsd ?? null,
        input.capability ?? null,
        input.modelEntryId ?? null,
        principalId,
        this.clock.now(),
      );
  }

  /** 按工具的内置任务上下文消耗：一次工具调用一行（仅 task loop）。 */
  recordTool(input: ToolUsageRecordInput): void {
    this.db
      .prepare(
        'insert into tool_usage_ledger (id, run_id, bot_id, conversation_id, loop_type, tool_name, call_tokens, result_tokens, calls, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId('tus'),
        input.runId,
        input.botId,
        input.conversationId,
        input.loopType,
        input.toolName,
        Math.max(0, Math.round(input.callTokens)),
        Math.max(0, Math.round(input.resultTokens)),
        Math.max(1, Math.round(input.calls ?? 1)),
        this.clock.now(),
      );
  }

  totalByRun(runId: string): { input: number; output: number } {
    const row = this.db
      .prepare(
        'select coalesce(sum(input_tokens), 0) as i, coalesce(sum(output_tokens), 0) as o from usage_ledger where run_id = ?',
      )
      .get(runId) as { i: number; o: number };
    return { input: row.i, output: row.o };
  }

  /**
   * 任务详情页的上下文用量（`tasks.usage`）：按 run_id 聚合账本行；没有行时 null。
   *
   * - `contextTokens` 是「当前上下文占用」的**近似值**：最近一次主循环调用的
   *   prompt 总量（input + cache_read + cache_write）。主循环行优先
   *   loop_type='task'（后台任务经 TaskHost 记账即为此值；同一 run 的压缩调用
   *   也记在 'task' 下、无法区分，取最新一行已是最接近的口径）；没有 'task' 行
   *   时退回该 run 的最新一行（如轻判定 / 子能力直接挂在 run 上记账）。
   * - `cacheHitRate` 用**加权**口径：prompt token 中命中缓存的比例
   *   = ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite)，与 `contextTokens`
   *   的 prompt 总量口径一致，不是各次命中率求平均；分母为 0 时 null。
   * - `contextWindow` 由调用方按该行的 provider+model 解析（UsageService 不依赖
   *   模型注册表）；查不到留 null，不猜默认窗口。
   */
  usageForRun(
    runId: string,
    resolveContextWindow?: (provider: string, model: string) => number | null,
  ): RunUsageTotals | null {
    const totals = this.db
      .prepare(
        `select coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                coalesce(sum(cache_read_tokens), 0) as cr,
                coalesce(sum(cache_write_tokens), 0) as cw,
                count(*) as calls
           from usage_ledger
          where run_id = ?`,
      )
      .get(runId) as { i: number; o: number; cr: number; cw: number; calls: number };
    if (totals.calls === 0) return null;
    const latest = this.db
      .prepare(
        `select provider, model, input_tokens, cache_read_tokens, cache_write_tokens
           from usage_ledger
          where run_id = ?
          order by case when loop_type = 'task' then 0 else 1 end, created_at desc, rowid desc
          limit 1`,
      )
      .get(runId) as
      | {
          provider: string;
          model: string;
          input_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
        }
      | undefined;
    if (latest === undefined) return null;
    const contextTokens =
      latest.input_tokens + latest.cache_read_tokens + latest.cache_write_tokens;
    const resolvedWindow = resolveContextWindow?.(latest.provider, latest.model) ?? null;
    // prompt 总量口径与 contextTokens 一致：input + cacheRead + cacheWrite。
    // 漏掉 cacheWrite 会把「写了缓存但还没读」的轮次当成全额命中，命中率虚高。
    const promptTokens = totals.i + totals.cr + totals.cw;
    return {
      inputTokens: totals.i,
      outputTokens: totals.o,
      cacheReadTokens: totals.cr,
      cacheWriteTokens: totals.cw,
      calls: totals.calls,
      contextTokens,
      contextWindow: resolvedWindow !== null && resolvedWindow > 0 ? resolvedWindow : null,
      cacheHitRate: promptTokens > 0 ? totals.cr / promptTokens : null,
    };
  }

  /**
   * 62.11 C13（T6 步骤 7.3）：按主体的只读日汇总——`usage_ledger.principal_id =
   * principalId` 且 `created_at ∈ [from, to)`，按本地日聚合。`filter.conversationTypes`
   * 传入时 inner join `conversations` 按 type 过滤（`conversation_id` 为 NULL 的行
   * 在带 filter 时被排除——它们不属于任何会话域）。纯 SQL 聚合，不写库。
   */
  sumByPrincipal(
    principalId: string,
    range: { from: number; to: number },
    filter?: { conversationTypes?: readonly string[] },
  ): PrincipalUsageDay[] {
    const hasTypes = filter?.conversationTypes !== undefined && filter.conversationTypes.length > 0;
    const types = hasTypes ? (filter!.conversationTypes as readonly string[]) : [];
    // join conversations 时 created_at 两表都有：一律用 u. 限定（本地日口径与
    // LOCAL_DAY 相同，见 62.11 C7 注释）。
    const sql = `
      select date(u.created_at / 1000, 'unixepoch', 'localtime') as day,
             count(*) as calls,
             coalesce(sum(u.input_tokens), 0) as inputTokens,
             coalesce(sum(u.output_tokens), 0) as outputTokens,
             coalesce(sum(u.cache_read_tokens), 0) as cacheReadTokens,
             coalesce(sum(u.cache_write_tokens), 0) as cacheWriteTokens,
             coalesce(sum(u.cost_usd), 0) as costUsd
        from usage_ledger u
        ${hasTypes ? 'join conversations c on c.id = u.conversation_id' : ''}
       where u.principal_id = ? and u.created_at >= ? and u.created_at < ?
        ${hasTypes ? `and c.type in (${types.map(() => '?').join(', ')})` : ''}
       group by day
       order by day`;
    const rows = this.db
      .prepare(sql)
      .all(
        ...(hasTypes
          ? [principalId, range.from, range.to, ...types]
          : [principalId, range.from, range.to]),
      ) as Array<{
      day: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    }>;
    return rows;
  }

  /**
   * T9（62.03 D137）只读游标读取：`where rowid > ? order by rowid limit ?`。
   * 团队层分摊 job 以此增量拉新账行（每批 limit 行，循环到不足一批）；纯
   * SELECT，不写库、不注册 RPC（APP_METHODS 计数不变）。
   */
  ledgerSince(afterRowid: number, limit: number): UsageLedgerRow[] {
    const rows = this.db
      .prepare(
        `select rowid as rowid, id, run_id, bot_id, conversation_id, loop_type, principal_id,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at
           from usage_ledger
          where rowid > ?
          order by rowid
          limit ?`,
      )
      .all(afterRowid, limit) as Array<{
      rowid: number;
      id: string;
      run_id: string;
      bot_id: string | null;
      conversation_id: string | null;
      loop_type: LoopType;
      principal_id: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      rowid: row.rowid,
      id: row.id,
      runId: row.run_id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      loopType: row.loop_type,
      principalId: row.principal_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
    }));
  }

  /** Raw entries since a point in time (usage.summary aggregation, P07). */
  entriesSince(since: number): Array<{
    botId: string | null;
    loopType: LoopType;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        'select bot_id, loop_type, provider, input_tokens, output_tokens, cost_usd, created_at from usage_ledger where created_at >= ? order by created_at',
      )
      .all(since) as Array<{
      bot_id: string | null;
      loop_type: LoopType;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      botId: row.bot_id,
      loopType: row.loop_type,
      provider: row.provider,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
    }));
  }

  /**
   * Daily totals for the whole ledger (usage.stats KPI / heatmap / streak).
   * One row per local day — no token row ever leaves SQLite.
   */
  dailyTotals(): UsageDailyTotal[] {
    const rows = this.db
      .prepare(
        `select ${LOCAL_DAY} as day,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                coalesce(sum(cache_read_tokens), 0) as cr,
                coalesce(sum(cache_write_tokens), 0) as cw,
                count(*) as calls,
                sum(cost_usd) as cost
           from usage_ledger
          group by day
          order by day`,
      )
      .all() as Array<{
      day: string;
      i: number;
      o: number;
      cr: number;
      cw: number;
      calls: number;
      cost: number | null;
    }>;
    return rows.map((row) => ({
      date: row.day,
      inputTokens: row.i,
      outputTokens: row.o,
      cacheReadTokens: row.cr,
      cacheWriteTokens: row.cw,
      tokens: row.i + row.o,
      calls: row.calls,
      costUsd: row.cost,
    }));
  }

  /** Per-model totals since `since` (range trend / donut). */
  modelTotals(since: number): UsageModelTotalRow[] {
    const rows = this.db
      .prepare(
        `select provider,
                model,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                count(*) as calls,
                sum(cost_usd) as cost
           from usage_ledger
          where created_at >= ?
          group by provider, model
          order by (sum(input_tokens) + sum(output_tokens)) desc, provider, model`,
      )
      .all(since) as Array<{
      provider: string;
      model: string;
      i: number;
      o: number;
      calls: number;
      cost: number | null;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
      calls: row.calls,
      costUsd: row.cost,
    }));
  }

  /** Per-model daily tokens since `since` (multi-line trend chart). */
  dailyByModel(since: number): UsageDailyModelRow[] {
    const rows = this.db
      .prepare(
        `select ${LOCAL_DAY} as day,
                provider,
                model,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o
           from usage_ledger
          where created_at >= ?
          group by day, provider, model
          order by day`,
      )
      .all(since) as Array<{
      day: string;
      provider: string;
      model: string;
      i: number;
      o: number;
    }>;
    return rows.map((row) => ({
      date: row.day,
      provider: row.provider,
      model: row.model,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
    }));
  }

  /** Per loop type totals since `since` (composition card). */
  loopTotals(since: number): UsageLoopTotalRow[] {
    const rows = this.db
      .prepare(
        `select loop_type,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                count(*) as calls
           from usage_ledger
          where created_at >= ?
          group by loop_type
          order by (sum(input_tokens) + sum(output_tokens)) desc, loop_type`,
      )
      .all(since) as Array<{ loop_type: LoopType; i: number; o: number; calls: number }>;
    return rows.map((row) => ({
      loopType: row.loop_type,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
      calls: row.calls,
    }));
  }

  /** Per bot totals since `since` (composition card). */
  botTotals(since: number): UsageBotTotalRow[] {
    const rows = this.db
      .prepare(
        `select bot_id,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                count(*) as calls
           from usage_ledger
          where created_at >= ?
          group by bot_id
          order by (sum(input_tokens) + sum(output_tokens)) desc, bot_id`,
      )
      .all(since) as Array<{ bot_id: string | null; i: number; o: number; calls: number }>;
    return rows.map((row) => ({
      botId: row.bot_id,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
      calls: row.calls,
    }));
  }

  /**
   * 按工具的上下文消耗（内容估算，仅内置任务）。`tokens` 是调用参数与返回
   * 内容的估算之和，不是 usage_ledger 的计费 token，也不按重发次数放大。
   * 外部 Agent 的工具内容只是宿主侧渲染，不记账；查询仍显式限定
   * `loop_type='task'`，防止其他调用方写进来的行混进页签。
   */
  toolTotals(since: number): UsageToolTotalRow[] {
    const rows = this.db
      .prepare(
        `select tool_name,
                coalesce(sum(result_tokens), 0) as r,
                coalesce(sum(call_tokens), 0) as c,
                coalesce(sum(calls), 0) as n
           from tool_usage_ledger
          where created_at >= ? and loop_type = 'task'
          group by tool_name
          order by (sum(result_tokens) + sum(call_tokens)) desc, tool_name`,
      )
      .all(since) as Array<{ tool_name: string; r: number; c: number; n: number }>;
    return rows.map((row) => ({
      toolName: row.tool_name,
      resultTokens: row.r,
      callTokens: row.c,
      tokens: row.r + row.c,
      calls: row.n,
    }));
  }

  /**
   * Longest continuous chat session in the ledger's lifetime: text messages
   * grouped per conversation, split whenever two messages are more than
   * `CHAT_SESSION_GAP_MS` apart. The session span (last − first message) is the
   * "chat duration"; single-message sessions (span 0) are ignored.
   */
  longestChatSession(): UsageChatSessionRow | null {
    const row = this.db
      .prepare(
        `with marked as (
           select conversation_id,
                  seq,
                  created_at,
                  case when created_at - lag(created_at) over (
                         partition by conversation_id order by seq
                       ) > ? then 1 else 0 end as is_start
             from messages
            where kind = 'text' and sender_type <> 'system'
         ),
         sessions as (
           select conversation_id,
                  seq,
                  created_at,
                  sum(is_start) over (
                    partition by conversation_id order by seq
                  ) as session_no
             from marked
         ),
         spans as (
           select conversation_id,
                  session_no,
                  min(created_at) as started_at,
                  max(created_at) as ended_at
             from sessions
            group by conversation_id, session_no
           having max(created_at) > min(created_at)
         )
         select spans.conversation_id as conversation_id,
                spans.started_at as started_at,
                spans.ended_at as ended_at,
                coalesce(conversations.direct_bot_id, conversations.lead_bot_id) as bot_id
           from spans
           left join conversations on conversations.id = spans.conversation_id
          order by (spans.ended_at - spans.started_at) desc
          limit 1`,
      )
      .get(CHAT_SESSION_GAP_MS) as
      | { conversation_id: string; started_at: number; ended_at: number; bot_id: string | null }
      | undefined;
    if (row === undefined) return null;
    return {
      conversationId: row.conversation_id,
      botId: row.bot_id,
      minutes: Math.round((row.ended_at - row.started_at) / 60_000),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}
