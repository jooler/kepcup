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
  createSubagentHost,
  type SubagentFacadeInput,
  type SubagentFollowUp,
} from '../../src/agent/subagent.js';
import type {
  EngineEvent,
  RunHandle,
  RunOutcome,
  RunSpec,
  ToolContext,
} from '../../src/agent/types.js';

/**
 * 宿主 SubAgent（D66）单元：预算/限次/回退/级联取消/后台委派/fan-out——用假
 * 引擎驱动 facade，落库走真实 RunsService / UsageService（内存 runs 库 +
 * usage_ledger）。
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
  #active = 0;

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
  loopType: 'turn' as const,
};

function makeInput(
  engine: FakeEngine,
  overrides?: Partial<SubagentFacadeInput>,
): SubagentFacadeInput & { followUps: SubagentFollowUp[] } {
  const followUps: SubagentFollowUp[] = [];
  return {
    parent: parentIdentity,
    modelRef: 'mock/main',
    lightModelRef: 'mock/light',
    buildTools: () => [],
    buildSystemPrompt: async () => '子代理提示',
    host: createSubagentHost(),
    onFollowUp: (followUp) => followUps.push(followUp),
    followUps,
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

/** 让 startBackground 的 void 异步链跑到 settle。 */
async function flushAsync(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('subagent background delegation (D66 mode B)', () => {
  it('returns child_run_id immediately, settles independently and reports via onFollowUp', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx } = makeCtx();

    engine.completed.push({
      outcome: { status: 'completed', finalText: '子任务原始结论', skipReply: false, usage: [] },
      events: [{ type: 'assistant', payload: { text: '过程输出', stopReason: 'stop' } }],
    });

    const result = await facade.delegate({ task: '长调研', mode: 'background' }, ctx);
    // 立即返回，不阻塞：结果带 child_run_id + running；子 run 不消费 FakeEngine 脚本也无关。
    expect(result.ok).toBe(true);
    expect(result.content).toContain('"status":"running"');
    expect(result.content).toMatch(/"child_run_id":"run_/);
    expect(input.host.runningCount('conv_1')).toBe(1);

    const [run] = deps.runs.listByConversation('conv_1', 10);
    expect(run?.loopType).toBe('subagent');
    expect(run?.triggerReason).toBe('background');
    expect(run?.parentRunId).toBe('run_parent');

    await flushAsync();
    expect(input.host.runningCount('conv_1')).toBe(0);
    // 后台子 run 的结论经 onFollowUp 上报（orchestrator 负责注入），压缩后 ≤4000 字符。
    expect(input.followUps).toHaveLength(1);
    expect(input.followUps[0]).toMatchObject({
      childRunId: run!.id,
      botId: 'bot_1',
      conversationId: 'conv_1',
      status: 'completed',
      hitLimit: false,
      conclusion: '压缩后的结论',
    });
  });

  it('does not consume the parent signal: main-turn abort leaves the background run alone', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx, signal } = makeCtx();

    engine.completed.push({
      // abort() 后 FakeEngine 按 scripted outcome 结算：真实引擎 abort → cancelled。
      outcome: { status: 'cancelled', finalText: '', skipReply: false, usage: [] },
      holdUntilAbort: true,
    });

    await facade.delegate({ task: '任务', mode: 'background' }, ctx);
    signal.abort('main turn ended');
    await flushAsync();
    expect(deps.runs.listByConversation('conv_1', 10)[0]?.status).toBe('running');
    expect(input.followUps).toHaveLength(0);

    // 显式取消委派（对话级锚点）才中止；取消不产生 follow-up。
    expect(input.host.abortOne(
      deps.runs.listByConversation('conv_1', 10)[0]!.id,
      'user cancelled',
    )).toBe(true);
    await flushAsync();
    expect(deps.runs.listByConversation('conv_1', 10)[0]?.status).toBe('cancelled');
    expect(input.followUps).toHaveLength(0);
  });

  it('reports the partial conclusion with hitLimit when the budget aborts a background run', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine, { tokenPollMs: 5 });
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx } = makeCtx();

    engine.completed.push({
      outcome: { status: 'cancelled', finalText: '已完成部分', skipReply: false, usage: [] },
      tokensSoFar: 1_000_000_000,
      holdUntilAbort: true,
      events: [{ type: 'assistant', payload: { text: '过程输出', stopReason: 'stop' } }],
    });

    await facade.delegate({ task: '任务', mode: 'background' }, ctx);
    await flushAsync();
    expect(input.followUps).toHaveLength(1);
    expect(input.followUps[0]).toMatchObject({
      status: 'cancelled',
      hitLimit: true,
      conclusion: '压缩后的结论',
    });
  });

  it('reports failure via onFollowUp when the sub run fails', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
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
    await flushAsync();
    expect(input.followUps).toHaveLength(1);
    expect(input.followUps[0]).toMatchObject({
      status: 'failed',
      conclusion: null,
      failure: '子任务执行失败：模型不可用',
    });
  });

  it('fans out background lanes in parallel and reports each lane separately', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx } = makeCtx();

    for (const text of ['结论一', '结论二', '结论三']) {
      engine.completed.push({
        outcome: { status: 'completed', finalText: text, skipReply: false, usage: [] },
        events: [{ type: 'assistant', payload: { text, stopReason: 'stop' } }],
      });
    }

    const result = await facade.delegate(
      {
        tasks: [
          { task: '查天气', mode: 'background' },
          { task: '查场馆', mode: 'background' },
          { task: '查交通', mode: 'background' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('"child_run_ids"');
    expect(result.content).toContain('"status":"running"');
    expect(engine.maxConcurrent).toBe(3); // 并行
    expect(input.host.runningCount('conv_1')).toBe(3);

    await flushAsync();
    expect(input.followUps).toHaveLength(3);
    expect(new Set(input.followUps.map((f) => f.conclusion))).toEqual(
      new Set(['压缩后的结论', '压缩后的结论', '压缩后的结论']),
    );
    const runs = deps.runs.listByConversation('conv_1', 10);
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.parentRunId).toBe('run_parent');
      expect(run.triggerReason).toBe('background');
    }
  });

  it('rejects lanes beyond the shared background concurrency cap', async () => {
    const engine = new FakeEngine();
    const deps = makeDeps(engine);
    const input = makeInput(engine);
    const facade = createSubagentFacade(deps, input);
    const { ctx } = makeCtx();

    for (let i = 0; i < 4; i += 1) {
      engine.completed.push({
        outcome: { status: 'completed', finalText: 'x', skipReply: false, usage: [] },
        holdUntilAbort: true,
      });
    }
    await facade.delegate({ task: '一', mode: 'background' }, ctx);
    await facade.delegate({ task: '二', mode: 'background' }, ctx);
    await facade.delegate({ task: '三', mode: 'background' }, ctx);
    await facade.delegate({ task: '四', mode: 'background' }, ctx);
    expect(input.host.runningCount('conv_1')).toBe(4);

    const fifth = await facade.delegate({ task: '五', mode: 'background' }, ctx);
    expect(fifth.ok).toBe(false);
    expect(fifth.errorCode).toBe('SUBAGENT_LIMIT_REACHED');

    // 前台 fan-out 的 N 路也必须放得下（与后台共用封顶）。
    const fanOut = await facade.delegate(
      { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }] },
      ctx,
    );
    expect(fanOut.ok).toBe(false);
    expect(fanOut.errorCode).toBe('SUBAGENT_LIMIT_REACHED');
    // 前台串行委派不受后台并发封顶约束（mode A 契约不变）：不被拒，仅受次数上限。
    const foreground = await facade.delegate({ task: '前台单路' }, ctx);
    expect(foreground.errorCode).not.toBe('SUBAGENT_LIMIT_REACHED');
    expect(deps.runs.listByConversation('conv_1', 10)).toHaveLength(5);
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
    expect(input.followUps).toHaveLength(0); // 前台不注入
    void input;
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
    expect(input.followUps).toHaveLength(0);
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
