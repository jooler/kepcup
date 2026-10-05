import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '@kepcup/testkit';
import { runMigrations } from '../../src/infra/migrate.js';
import { RunsService } from '../../src/domain/runs.js';
import { UsageService } from '../../src/domain/usage.js';
import type { SqliteDatabase } from '../../src/infra/db.js';
import { createSubagentFacade, type SubagentFacadeInput } from '../../src/agent/subagent.js';
import type {
  EngineEvent,
  RunHandle,
  RunOutcome,
  RunSpec,
  ToolContext,
} from '../../src/agent/types.js';

/**
 * 宿主 SubAgent（D66）单元：预算/限次/回退/级联取消——用假引擎驱动 facade，
 * 落库走真实 RunsService / UsageService（内存 runs 库 + usage_ledger）。
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
  loopType: 'response' as const,
};

function makeInput(
  engine: FakeEngine,
  overrides?: Partial<SubagentFacadeInput>,
): SubagentFacadeInput {
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
});
