import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '@kepcup/testkit';
import { runMigrations } from '../../src/infra/migrate.js';
import { RunsService } from '../../src/domain/runs.js';
import { UsageService } from '../../src/domain/usage.js';
import type { SqliteDatabase } from '../../src/infra/db.js';
import {
  createSubagentFacade,
  type SubagentFacadeInput,
} from '../../src/agent/subagent.js';
import type {
  EngineEvent,
  RunHandle,
  RunOutcome,
  RunSpec,
  ToolContext,
} from '../../src/agent/types.js';

/**
 * 宿主 SubAgent（D66）单元：预算/限次/回退/级联取消/后台分支/fan-out——用假
 * 引擎驱动 facade，落库走真实 RunsService / UsageService（内存 runs 库 +
 * usage_ledger）。D75 §1.2 降级后后台分支属于父 run：结论经
 * collect_delegate_results 回到父 run，父 run abort / 结束（close）中止分支，
 * 并发封顶按父 run 计（对话级计数归任务层）。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const runsMigrations = fileURLToPath(new URL('../../migrations/runs/', import.meta.url));
const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function openRunsDb(): SqliteDatabase {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, runsMigrations);
  openDbs.push(db);
  return db;
}

function openMainDb(): SqliteDatabase {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  return db;
}

const secrets = { redact: (text: string) => text } as never;

interface FakeRunScript {
  outcome: RunOutcome;
  events?: EngineEvent[];
  tokensSoFar?: number;
  /** true = 不自动结算，只有 abort()（预算轮询 / 级联取消）能结束 run。 */
  holdUntilAbort?: boolean;
}

/** abort() 立即按 scripted outcome 结算（真实引擎 abort → agent_end → done）。 */
class FakeEngine {
  readonly specs: RunSpec[] = [];
  completed: FakeRunScript[] = [];
  maxConcurrent = 0;
  completeShouldFail = false;
  /** Settles of held (holdUntilAbort) runs, in start order: release() completes one normally. */
  readonly #held: Array<() => void> = [];
  #active = 0;

  /** Lets the oldest held run finish with its scripted outcome (not an abort). */
  release(): void {
    this.#held.shift()?.();
  }

  startRun(spec: RunSpec): RunHandle {
    this.specs.push(spec);
    this.maxConcurrent = Math.max(this.maxConcurrent, ++this.#active);
    const script = this.completed.shift() ?? {
      outcome: { status: 'completed', finalText: '子任务结论', skipReply: false, usage: [] },
    };
    const listeners = new Set<(e: EngineEvent) => void>();
    let settled = false;
    let resolveDone!: (outcome: RunOutcome) => void;
    const done = new Promise<RunOutcome>((resolve) => {
      resolveDone = resolve;
    }).finally(() => {
      this.#active -= 1;
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      for (const event of script.events ?? []) {
        for (const listener of [...listeners]) listener(event);
      }
      resolveDone(script.outcome);
    };
    if (script.holdUntilAbort !== true) queueMicrotask(settle);
    else this.#held.push(settle);
    return {
      steer: () => false,
      abort: () => settle(),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      tokensSoFar: () => script.tokensSoFar ?? 0,
      done,
    };
  }

  async complete(): Promise<{ text: string; usage: null }> {
    if (this.completeShouldFail) throw new Error('light model unavailable');
    return { text: '压缩后的结论', usage: null };
  }
}

function makeDeps(engine: FakeEngine, overrides?: Record<string, unknown>) {
  return {
    engine: engine as never,
    runs: new RunsService(openRunsDb(), new TestClock(1_000)),
    usage: new UsageService(openMainDb(), new TestClock(1_000)),
    secrets,
    logger,
    clock: new TestClock(1_000),
    timeZone: 'Asia/Shanghai',
    providerForRef: (ref: string) => ref.split('/')[0] ?? ref,
    publishRunStatus: () => {},
    ...overrides,
  };
}

const parentIdentity = {
  runId: 'run_parent',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'task' as const,
};

function makeInput(engine: FakeEngine, overrides?: Partial<SubagentFacadeInput>): SubagentFacadeInput {
  void engine;
  return {
    parent: parentIdentity,
    modelRef: 'mock/main',
    lightModelRef: 'mock/light',
    buildTools: () => [],
    buildSystemPrompt: async () => '子代理提示',
    ...overrides,
  };
}

function makeCtx(): { ctx: ToolContext; signal: AbortController } {
  const signal = new AbortController();
  return {
    signal,
    ctx: {
      identity: parentIdentity,
      signal: signal.signal,
      terminate: () => {},
      progress: () => {},
    },
  };
}

describe('subagent facade', () => {
  it('runs a nested subagent run and returns the compressed conclusion', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();

    engine.completed.push({
      outcome: { status: 'completed', finalText: '子任务原始长文本', skipReply: false, usage: [] },
      events: [{ type: 'assistant', payload: { text: '过程输出', stopReason: 'stop' } }],
    });

    const result = await facade.delegate({ task: '扫目录给结论' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('压缩后的结论');
    expect(result.content.startsWith('<untrusted>')).toBe(true);

    // 子 run 落 runs 行：loopType=subagent、completed；过程事件落 run_steps。
    const [run] = deps.runs.listByConversation('conv_1', 10);
    expect(run?.loopType).toBe('subagent');
    expect(run?.status).toBe('completed');
    expect(deps.runs.stepsFor(run!.id).map((s) => s.type)).toContain('assistant');
    // 引擎收到的 spec：loopType=subagent、单条任务消息。
    const spec = engine.specs[0]!;
    expect(spec.identity.loopType).toBe('subagent');
    expect(spec.messages).toHaveLength(1);
    expect(spec.messages[0]!.content).toBe('扫目录给结论');
  });

  it('falls back to truncated final text when the light model fails', async () => {
    const engine = new FakeEngine();
    engine.completeShouldFail = true;
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();

    engine.completed.push({
      outcome: {
        status: 'completed',
        finalText: `长结论${'x'.repeat(6_000)}`,
        skipReply: false,
        usage: [],
      },
    });

    const result = await facade.delegate({ task: '任务' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('长结论');
    // ≤ 4000 字符结论 + <untrusted> 包裹与换行。
    expect(result.content.length).toBeLessThan(4_100);
  });

  it('returns the partial result with a note when the token budget aborts the sub run', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine, { tokenPollMs: 5 });
    const facade = createSubagentFacade(deps, makeInput(engine, { lightModelRef: '' }));
    const { ctx } = makeCtx();

    engine.completed.push({
      outcome: { status: 'cancelled', finalText: '已完成部分的结论', skipReply: false, usage: [] },
      tokensSoFar: 1_000_000_000,
      holdUntilAbort: true,
    });

    const result = await facade.delegate({ task: '任务' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已完成部分的结论');
    expect(result.content).toContain('上限');
    const [run] = deps.runs.listByConversation('conv_1', 10);
    expect(run?.status).toBe('cancelled');
  });

  it('cascades parent cancellation into the sub run', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine, { lightModelRef: '' }));
    const { ctx, signal } = makeCtx();

    engine.completed.push({
      outcome: { status: 'cancelled', finalText: '', skipReply: false, usage: [] },
      holdUntilAbort: true,
    });

    const pending = facade.delegate({ task: '任务' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    signal.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('CANCELLED');
    const [run] = deps.runs.listByConversation('conv_1', 10);
    expect(run?.status).toBe('cancelled');
  });

  it('caps delegations per parent run and serializes sub runs', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();

    for (let i = 0; i < 3; i += 1) {
      engine.completed.push({
        outcome: { status: 'completed', finalText: `结论${i}`, skipReply: false, usage: [] },
      });
    }
    const results = await Promise.all([
      facade.delegate({ task: '一' }, ctx),
      facade.delegate({ task: '二' }, ctx),
      facade.delegate({ task: '三' }, ctx),
      facade.delegate({ task: '四' }, ctx),
    ]);
    expect(engine.maxConcurrent).toBe(1); // 串行
    expect(results[3]!.ok).toBe(false);
    expect(results[3]!.errorCode).toBe('SUBAGENT_LIMIT_REACHED');
    expect(deps.runs.listByConversation('conv_1', 10)).toHaveLength(3);
  });

  it('records sub run usage under loopType=subagent', async () => {
    const engine = new FakeEngine();
    const runs = new RunsService(openRunsDb(), new TestClock(1_000));
    const mainDb = openMainDb();
    const usage = new UsageService(mainDb, new TestClock(1_000));
    const facade = createSubagentFacade({ ...makeDeps(engine), runs, usage }, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push({
      outcome: {
        status: 'completed',
        finalText: '结论',
        skipReply: false,
        usage: [{ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: null }],
      },
    });
    await facade.delegate({ task: '任务' }, ctx);
    const [row] = mainDb
      .prepare('select run_id, bot_id, conversation_id, loop_type, input_tokens from usage_ledger')
      .all() as Array<{
      run_id: string;
      bot_id: string;
      conversation_id: string;
      loop_type: string;
      input_tokens: number;
    }>;
    expect(row.loop_type).toBe('subagent');
    expect(row.input_tokens).toBe(100);
    const [run] = runs.listByConversation('conv_1', 10);
    expect(row.run_id).toBe(run!.id);
  });

  it('a failed external agent compaction is charged as a zero-token row; built-in failures are not', async () => {
    const rowsFor = async (lightModelRef: string) => {
      const engine = new FakeEngine();
      engine.completeShouldFail = true;
      const mainDb = openMainDb();
      const usage = new UsageService(mainDb, new TestClock(1_000));
      const facade = createSubagentFacade(
        { ...makeDeps(engine), usage },
        makeInput(engine, { lightModelRef }),
      );
      // A process record to compress (an empty digest skips the light call).
      engine.completed.push({
        outcome: { status: 'completed', finalText: '结论', skipReply: false, usage: [] },
        events: [{ type: 'assistant', payload: { text: '过程输出', stopReason: 'stop' } }],
      });
      await facade.delegate({ task: '任务' }, makeCtx().ctx);
      return mainDb
        .prepare('select provider, loop_type, input_tokens, output_tokens from usage_ledger')
        .all();
    };
    expect(await rowsFor('agent:codex-acp/default')).toEqual([
      { provider: 'agent:codex-acp', loop_type: 'subagent', input_tokens: 0, output_tokens: 0 },
    ]);
    expect(await rowsFor('mock/light')).toEqual([]);
  });
});

/** 让后台分支的异步链跑到 settle。 */
async function flushAsync(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface BranchSlot {
  child_run_id: string;
  ok: boolean;
  conclusion?: string;
  partial?: boolean;
  error?: string;
}

function branchSlots(content: string): BranchSlot[] {
  const json = content.slice(content.indexOf('<untrusted>') + 11, content.indexOf('</untrusted>'));
  return JSON.parse(json) as BranchSlot[];
}

function childRunIds(content: string): string[] {
  const payload = JSON.parse(content.split('\n')[0]!) as {
    child_run_id?: string;
    child_run_ids?: string[];
  };
  return payload.child_run_ids ?? [payload.child_run_id!];
}

const completedScript = (text: string, hold = false): FakeRunScript => ({
  outcome: { status: 'completed', finalText: text, skipReply: false, usage: [] },
  events: [{ type: 'assistant', payload: { text, stopReason: 'stop' } }],
  ...(hold ? { holdUntilAbort: true } : {}),
});

const heldCancelled = (): FakeRunScript => ({
  outcome: { status: 'cancelled', finalText: '', skipReply: false, usage: [] },
  holdUntilAbort: true,
});

describe('subagent background branches (D66 mode B, D75 §1.2)', () => {
  it('returns child_run_id immediately; collect waits for the branch and hands its conclusion back once', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push(completedScript('子任务原始结论', true));

    const ack = await facade.delegate({ task: '长调研', mode: 'background' }, ctx);
    // 立即返回，不阻塞：带 child_run_id + running，并告诉父 loop 如何取回。
    expect(ack.ok).toBe(true);
    expect(ack.content).toContain('"status":"running"');
    expect(ack.content).toContain('collect_delegate_results');
    const [childId] = childRunIds(ack.content);

    const [run] = deps.runs.listByConversation('conv_1', 10);
    expect(run?.id).toBe(childId);
    expect(run?.loopType).toBe('subagent');
    expect(run?.triggerReason).toBe('background');
    expect(run?.parentRunId).toBe('run_parent');
    expect(run?.status).toBe('running');

    // collect 等待未结束的分支。
    let collected = false;
    const pending = facade.collect({}, ctx).then((result) => {
      collected = true;
      return result;
    });
    await flushAsync();
    expect(collected).toBe(false);

    engine.release();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(branchSlots(result.content)).toEqual([
      { child_run_id: childId, ok: true, conclusion: '压缩后的结论' },
    ]);
    expect(deps.runs.getOrThrow(childId!).status).toBe('completed');

    // 每条结论只交一次：再取回报错，不重复交付。
    const again = await facade.collect({ child_run_ids: [childId!] }, ctx);
    expect(again.ok).toBe(false);
    expect(again.errorCode).toBe('INVALID_INPUT');
    const none = await facade.collect({}, ctx);
    expect(none.ok).toBe(false);
    expect(none.errorCode).toBe('INVALID_INPUT');
  });

  it('cascades a parent abort into its background branches', async () => {
    // 旧语义（D66 mode B）：后台子 run 挂对话级锚点，主 turn abort 不影响它。
    // D75 §1.2：分支属于父 run——父 run 被中止，分支一并中止。
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx, signal } = makeCtx();
    engine.completed.push(heldCancelled());

    await facade.delegate({ task: '任务', mode: 'background' }, ctx);
    const collecting = facade.collect({}, ctx);
    signal.abort('parent cancelled');
    // collect 随父 run 的 signal 返回，不等分支。
    const result = await collecting;
    expect(result.errorCode).toBe('CANCELLED');
    await flushAsync();
    expect(deps.runs.listByConversation('conv_1', 10)[0]?.status).toBe('cancelled');
  });

  it('abortSubRun cancels one branch (runs.cancel); collect reports it as a failed slot', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push(heldCancelled(), completedScript('另一路结论'));

    const ack = await facade.delegate(
      {
        tasks: [
          { task: '会被取消', mode: 'background' },
          { task: '正常完成', mode: 'background' },
        ],
      },
      ctx,
    );
    const [cancelledId, okId] = childRunIds(ack.content);
    expect(facade.abortSubRun(cancelledId!, 'user cancelled')).toBe(true);
    expect(facade.abortSubRun('run_not_mine', 'user cancelled')).toBe(false);

    const result = await facade.collect({ child_run_ids: [cancelledId!, okId!] }, ctx);
    expect(result.ok).toBe(true);
    const slots = branchSlots(result.content);
    expect(slots.map((slot) => slot.child_run_id)).toEqual([cancelledId, okId]);
    expect(slots[0]).toMatchObject({ ok: false, error: '执行已取消，子任务中止' });
    expect(slots[1]).toMatchObject({ ok: true, conclusion: '压缩后的结论' });
    expect(deps.runs.getOrThrow(cancelledId!).status).toBe('cancelled');
    // 已结束的分支不能再取消。
    expect(facade.abortSubRun(okId!, 'late')).toBe(false);
  });

  it('marks a budget-aborted branch as partial', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine, { tokenPollMs: 5 });
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push({
      outcome: { status: 'cancelled', finalText: '已完成部分', skipReply: false, usage: [] },
      tokensSoFar: 1_000_000_000,
      holdUntilAbort: true,
      events: [{ type: 'assistant', payload: { text: '过程输出', stopReason: 'stop' } }],
    });

    await facade.delegate({ task: '任务', mode: 'background' }, ctx);
    const result = await facade.collect({}, ctx);
    expect(result.ok).toBe(true);
    expect(branchSlots(result.content)[0]).toMatchObject({
      ok: true,
      conclusion: '压缩后的结论',
      partial: true,
    });
    expect(result.content).toContain('预算上限');
  });

  it('reports a failed branch as an error slot', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push({
      outcome: {
        status: 'failed',
        finalText: '',
        skipReply: false,
        usage: [],
        error: { code: 'PROVIDER_ERROR', message: '模型不可用' },
      },
    });

    await facade.delegate({ task: '任务', mode: 'background' }, ctx);
    const result = await facade.collect({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SUBAGENT_FAILED');
    expect(branchSlots(result.content)[0]).toMatchObject({
      ok: false,
      error: '子任务执行失败：模型不可用',
    });
  });

  it('fans out background lanes in parallel and collects them in request order', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    for (const text of ['结论一', '结论二', '结论三']) engine.completed.push(completedScript(text));

    const ack = await facade.delegate(
      {
        tasks: [
          { task: '查天气', mode: 'background' },
          { task: '查场馆', mode: 'background' },
          { task: '查交通', mode: 'background' },
        ],
      },
      ctx,
    );
    expect(ack.ok).toBe(true);
    expect(ack.content).toContain('"child_run_ids"');
    expect(engine.maxConcurrent).toBe(3); // 并行
    const ids = childRunIds(ack.content);

    const result = await facade.collect({}, ctx);
    expect(branchSlots(result.content).map((slot) => slot.child_run_id)).toEqual(ids);
    for (const run of deps.runs.listByConversation('conv_1', 10)) {
      expect(run.parentRunId).toBe('run_parent');
      expect(run.triggerReason).toBe('background');
      expect(run.status).toBe('completed');
    }
  });

  it('caps running branches per parent run, not per conversation', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    for (let i = 0; i < 6; i += 1) engine.completed.push(heldCancelled());

    for (const task of ['一', '二', '三', '四']) {
      expect((await facade.delegate({ task, mode: 'background' }, ctx)).ok).toBe(true);
    }
    const fifth = await facade.delegate({ task: '五', mode: 'background' }, ctx);
    expect(fifth.ok).toBe(false);
    expect(fifth.errorCode).toBe('SUBAGENT_LIMIT_REACHED');

    // 前台 fan-out 的 N 路也必须放得下（与后台分支共用封顶）。
    const fanOut = await facade.delegate(
      { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }] },
      ctx,
    );
    expect(fanOut.ok).toBe(false);
    expect(fanOut.errorCode).toBe('SUBAGENT_LIMIT_REACHED');

    // 旧语义（对话级封顶）：同对话另一个父 run 也会被挡。D75：对话级并发归
    // 任务层，另一个父 run（另一个任务）有自己的封顶。
    const otherParent = createSubagentFacade(
      deps,
      makeInput(engine, { parent: { ...parentIdentity, runId: 'run_parent_2' } }),
    );
    const otherCtx = makeCtx();
    expect((await otherParent.delegate({ task: '别的任务的分支', mode: 'background' }, otherCtx.ctx)).ok).toBe(true);

    // 前台串行委派不受后台并发封顶约束（mode A 契约不变）。
    engine.completed.unshift(completedScript('前台结论'));
    const foreground = await facade.delegate({ task: '前台单路' }, ctx);
    expect(foreground.ok).toBe(true);
    await facade.close('test end');
    await otherParent.close('test end');
  });

  it('close() (parent run ended) aborts branches still running, waits for them and drops uncollected results', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push(heldCancelled(), completedScript('已完成但没取回'));

    const ack = await facade.delegate(
      {
        tasks: [
          { task: '还在跑', mode: 'background' },
          { task: '已结束', mode: 'background' },
        ],
      },
      ctx,
    );
    const [runningId, doneId] = childRunIds(ack.content);
    await flushAsync();
    expect(deps.runs.getOrThrow(doneId!).status).toBe('completed');
    expect(deps.runs.getOrThrow(runningId!).status).toBe('running');

    await facade.close('parent run ended');
    // close 返回时分支已 settle（不留悬挂的子 run）。
    expect(deps.runs.getOrThrow(runningId!).status).toBe('cancelled');
    // 之后既不能再委派，也取不回任何结论。
    const late = await facade.delegate({ task: '迟到', mode: 'background' }, ctx);
    expect(late.ok).toBe(false);
    expect(late.errorCode).toBe('CANCELLED');
    expect((await facade.collect({}, ctx)).errorCode).toBe('INVALID_INPUT');
    expect(deps.runs.listByConversation('conv_1', 10)).toHaveLength(2);
  });

  it('abortSubRun and close also stop foreground lanes', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const facade = createSubagentFacade(deps, makeInput(engine));
    const { ctx } = makeCtx();
    engine.completed.push(heldCancelled());

    const pending = facade.delegate({ task: '前台长任务' }, ctx);
    await flushAsync();
    const [run] = deps.runs.listByConversation('conv_1', 10);
    expect(facade.abortSubRun(run!.id, 'user cancelled')).toBe(true);
    const result = await pending;
    expect(result.errorCode).toBe('CANCELLED');
    expect(deps.runs.getOrThrow(run!.id).status).toBe('cancelled');
  });

  it('refuses delegation from a supervisor turn or a subagent (D75 depth / role)', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    for (const loopType of ['turn', 'subagent'] as const) {
      const facade = createSubagentFacade(
        deps,
        makeInput(engine, { parent: { ...parentIdentity, loopType } }),
      );
      const result = await facade.delegate({ task: '任务' }, makeCtx().ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('NOT_SUPPORTED');
    }
    expect(deps.runs.listByConversation('conv_1', 10)).toHaveLength(0);
    expect(engine.specs).toHaveLength(0);
  });

  it('rejects collecting ids that are not this run\'s branches', async () => {
    const engine = new FakeEngine();
    const facade = createSubagentFacade(makeDeps(engine), makeInput(engine));
    const { ctx } = makeCtx();
    const unknown = await facade.collect({ child_run_ids: ['run_elsewhere'] }, ctx);
    expect(unknown.errorCode).toBe('INVALID_INPUT');
    expect(unknown.content).toContain('run_elsewhere');
    const empty = await facade.collect({ child_run_ids: [] }, ctx);
    expect(empty.errorCode).toBe('INVALID_INPUT');
  });
});

describe('subagent foreground fan-out (D66 mode C)', () => {
  it('runs lanes in parallel and returns the ordered conclusion array', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx } = makeCtx();

    engine.completed.push(
      {
        outcome: { status: 'completed', finalText: '天气结论', skipReply: false, usage: [] },
        events: [{ type: 'assistant', payload: { text: '天气过程', stopReason: 'stop' } }],
      },
      {
        outcome: { status: 'completed', finalText: '交通结论', skipReply: false, usage: [] },
        events: [{ type: 'assistant', payload: { text: '交通过程', stopReason: 'stop' } }],
      },
      // 第三路失败：该槽位带 error，其余照常返回。
      {
        outcome: {
          status: 'failed',
          finalText: '',
          skipReply: false,
          usage: [],
          error: { code: 'PROVIDER_ERROR', message: '上游挂了' },
        },
      },
    );

    const result = await facade.delegate(
      { tasks: [{ task: '查天气' }, { task: '查交通' }, { task: '查酒店' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(engine.maxConcurrent).toBe(3); // 三路并行，非串行
    const payload = JSON.parse(result.content.replace(/<\/?untrusted>/g, '')) as Array<{
      index: number;
      ok: boolean;
      conclusion?: string;
      error?: string;
    }>;
    expect(payload.map((slot) => slot.index)).toEqual([0, 1, 2]);
    expect(payload[0]).toMatchObject({ ok: true, conclusion: '压缩后的结论' });
    expect(payload[1]).toMatchObject({ ok: true });
    expect(payload[2]).toMatchObject({ ok: false, error: '子任务执行失败：上游挂了' });
    // fan-out 不占前台串行委派次数（SUBAGENT_MAX_PER_RUN 只限 mode A）。
    const runs = deps.runs.listByConversation('conv_1', 10);
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run.triggerReason).toBeNull();
  });

  it('cascades parent cancellation into every foreground lane', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx, signal } = makeCtx();

    engine.completed.push(
      {
        outcome: { status: 'cancelled', finalText: '', skipReply: false, usage: [] },
        holdUntilAbort: true,
      },
      {
        outcome: { status: 'cancelled', finalText: '', skipReply: false, usage: [] },
        holdUntilAbort: true,
      },
    );

    const pending = facade.delegate({ tasks: [{ task: '一' }, { task: '二' }] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    signal.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SUBAGENT_FAILED'); // 全部槽位失败
    for (const run of deps.runs.listByConversation('conv_1', 10)) {
      expect(run.status).toBe('cancelled');
    }
  });

  it('rejects mixed modes, oversized fan-outs and empty tasks', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx } = makeCtx();

    const mixed = await facade.delegate(
      { tasks: [{ task: '一' }, { task: '二', mode: 'background' }] },
      ctx,
    );
    expect(mixed.ok).toBe(false);
    expect(mixed.errorCode).toBe('INVALID_INPUT');

    const oversized = await facade.delegate(
      {
        tasks: [1, 2, 3, 4, 5].map((i) => ({ task: `任务${i}` })),
      },
      ctx,
    );
    expect(oversized.ok).toBe(false);
    expect(oversized.errorCode).toBe('SUBAGENT_LIMIT_REACHED');

    const both = await facade.delegate({ task: '一', tasks: [{ task: '二' }] }, ctx);
    expect(both.ok).toBe(false);
    expect(both.errorCode).toBe('INVALID_INPUT');

    const empty = await facade.delegate({ tasks: [] }, ctx);
    expect(empty.ok).toBe(false);
    expect(empty.errorCode).toBe('INVALID_INPUT');

    const blank = await facade.delegate({ tasks: [{ task: '  ' }] }, ctx);
    expect(blank.ok).toBe(false);
    expect(blank.errorCode).toBe('INVALID_INPUT');
    expect(deps.runs.listByConversation('conv_1', 10)).toHaveLength(0);
  });
});
