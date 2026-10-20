import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WIDGET_CRAFT_FIX_ROUNDS_MAX,
  WIDGET_CRAFT_RESULT_MAX_CHARS,
  type WidgetCraftManifest,
  type WidgetQueryDef,
} from '@kepcup/shared';
import { TestClock } from '@kepcup/testkit';
import { runMigrations } from '../../src/infra/migrate.js';
import { RunsService } from '../../src/domain/runs.js';
import { UsageService } from '../../src/domain/usage.js';
import type { SqliteDatabase } from '../../src/infra/db.js';
import type { AppPaths } from '../../src/infra/paths.js';
import { botWidgetDraftDir } from '../../src/infra/paths.js';
import type {
  RunHandle,
  RunIdentity,
  RunOutcome,
  RunSpec,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/agent/types.js';
import {
  WidgetCraftService,
  type WidgetCraftParams,
  type WidgetCraftTarget,
} from '../../src/widgets/craft/service.js';
import { WIDGET_TEMPLATES } from '../../src/widgets/templates/index.js';
import type { WidgetPreviewRunner } from '../../src/widgets/check/index.js';

/**
 * D87 制作 loop 状态机（设计 32 §11.6）：假引擎按阶段脚本直接调用阶段工具（write / edit /
 * stage_done…），落库走真实 RunsService / UsageService（内存库），交付走假 WidgetService。
 * 覆盖：一次写对、GATE → FIX → 通过、回归回滚、防震荡收缩、轮数用尽不交付、续做、只剩警告、
 * 时限 / 预算 / 父取消、回执关卡、守卫、每 run 次数、无模型。
 */

const runsMigrations = fileURLToPath(new URL('../../migrations/runs/', import.meta.url));
const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));
const logger = { info() {}, warn() {} };

const GOOD = WIDGET_TEMPLATES.find((t) => t.name === 'blank')!.html;
/** 一个阻断项（sandbox.storage）。 */
const BAD = GOOD.replace('  init();', "  localStorage.setItem('x', '1');\n  init();");
/** 两个阻断项（再加 sandbox.modals）——比 BAD 更差。 */
const WORSE = BAD.replace('  init();', "  if (confirm('ok?')) state.count = 0;\n  init();");
/** 只有警告（sandbox.alert）。 */
const WARN_ONLY = GOOD.replace('  init();', "  alert('hi');\n  init();");

const SPEC_MD = '> 一个点击计数器\n\n# 规格\n- #action 按钮计数\n';
const ACCEPTANCE = JSON.stringify([
  {
    id: 'click',
    desc: '点击后计数',
    must: true,
    steps: [{ click: '#action' }],
    expect: [{ selector: '#status', textContains: '1' }],
  },
  { id: 'nobad', desc: '无坏文本', must: true, expect: [{ noBadText: true }] },
]);

type Stage = 'SPEC' | 'BUILD' | 'FIX' | 'REVIEW';

/** 一个阶段 run 的脚本：拿到阶段工具后要做的事。 */
type StageScript = (tools: Tools, spec: RunSpec) => Promise<void>;

interface Tools {
  call(name: string, params: unknown): Promise<ToolResult>;
}

interface Harness {
  service: WidgetCraftService;
  runs: RunsService;
  mainDb: SqliteDatabase;
  paths: AppPaths;
  engine: CraftEngine;
  deliveries: Array<{ kind: 'create' | 'update'; input: Record<string, unknown> }>;
  target: WidgetCraftTarget;
  clock: TestClock;
}

const dbs: SqliteDatabase[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 按阶段排队的脚本；每个 startRun 取下一条与其阶段相符的脚本。 */
class CraftEngine {
  readonly specs: RunSpec[] = [];
  readonly scripts: Array<{ stage: Stage; run: StageScript; hold?: boolean; tokens?: number }> = [];
  /** startRun 被调用时（测试里用来在阶段中途取消等）。 */
  onStart: ((stage: Stage) => void) | null = null;

  add(stage: Stage, run: StageScript, options: { hold?: boolean; tokens?: number } = {}): this {
    this.scripts.push({ stage, run, ...options });
    return this;
  }

  startRun(spec: RunSpec): RunHandle {
    this.specs.push(spec);
    const stage = (/<stage>(SPEC|BUILD|FIX|REVIEW)<\/stage>/.exec(spec.messages[0]!.content)?.[1] ??
      'SPEC') as Stage;
    const index = this.scripts.findIndex((s) => s.stage === stage);
    const script = index >= 0 ? this.scripts.splice(index, 1)[0]! : null;
    let resolveDone!: (outcome: RunOutcome) => void;
    const done = new Promise<RunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    let settled = false;
    const settle = (status: RunOutcome['status']) => {
      if (settled) return;
      settled = true;
      resolveDone({
        status,
        finalText: '',
        skipReply: false,
        usage: [{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: null }],
      });
    };
    const controller = new AbortController();
    const tools: Tools = {
      call: async (name, params) => {
        const tool = spec.tools.find((t) => t.name === name) as ToolDefinition | undefined;
        if (tool === undefined)
          return { ok: false, content: `no tool ${name}`, errorCode: 'NO_TOOL' };
        const ctx: ToolContext = {
          identity: spec.identity,
          signal: controller.signal,
          terminate: () => undefined,
          progress: () => undefined,
        };
        return tool.execute(params, ctx);
      },
    };
    this.onStart?.(stage);
    void (async () => {
      if (script === null) {
        settle('completed');
        return;
      }
      await script.run(tools, spec);
      if (script.hold !== true) settle('completed');
    })();
    return {
      steer: () => false,
      abort: () => {
        controller.abort();
        settle('cancelled');
      },
      onEvent: () => () => undefined,
      tokensSoFar: () => script?.tokens ?? 15,
      done,
    };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

function harness(
  options: {
    model?: string;
    preview?: WidgetPreviewRunner | null;
    timeoutMs?: number;
    checkTimeoutMs?: number;
    deliverFails?: string;
    reviewModel?: string;
    modelUsable?: (ref: string) => boolean;
  } = {},
): Harness {
  const runsDb = new Database(':memory:') as SqliteDatabase;
  runMigrations(runsDb, runsMigrations);
  const mainDb = new Database(':memory:') as SqliteDatabase;
  runMigrations(mainDb, mainMigrations);
  dbs.push(runsDb, mainDb);
  const home = mkdtempSync(path.join(tmpdir(), 'widget-craft-'));
  homes.push(home);
  const paths = { home } as AppPaths;
  const clock = new TestClock();
  const runs = new RunsService(runsDb, clock, logger as never);
  const engine = new CraftEngine();
  const deliveries: Harness['deliveries'] = [];
  let version = 1;
  const target: WidgetCraftTarget = {
    create: (input) => {
      deliveries.push({ kind: 'create', input: input as never });
      if (options.deliverFails !== undefined)
        return { ok: false, message: options.deliverFails, code: 'WIDGET_LIMIT' };
      return {
        ok: true,
        widgetId: 'wgt_new',
        title: input.title,
        version: 1,
        message: '',
        cardMessageId: 'msg_1',
      };
    },
    update: (input) => {
      deliveries.push({ kind: 'update', input: input as never });
      version += 1;
      return {
        ok: true,
        widgetId: input.widgetId,
        title: '计数器',
        version,
        message: '',
        cardMessageId: 'msg_2',
      };
    },
    validateQueries: (defs: WidgetQueryDef[]) =>
      defs.some((d) => /delete/i.test(d.sql)) ? '查询只能是 SELECT' : null,
    craftSource: (botId, widgetId) =>
      widgetId === 'wgt_old' && botId === 'bot_a'
        ? {
            ok: true,
            title: '计数器',
            description: '',
            scope: 'conversation',
            version: 1,
            html: GOOD,
            queries: [{ name: 'all', sql: 'select key from widget_kv' }],
          }
        : { ok: false, message: '找不到这个组件', code: 'NOT_FOUND' },
  };
  const service = new WidgetCraftService({
    engine: engine as never,
    settings: {
      get: () =>
        ({
          defaultMainModel: options.model ?? 'mock/main',
          defaultLightModel: '',
          widgetReviewModel: options.reviewModel ?? '',
        }) as never,
    },
    bots: { get: () => null },
    runs,
    usage: new UsageService(mainDb, clock),
    secrets: { redact: (text: string) => text } as never,
    widgets: target,
    paths,
    logger,
    clock,
    publishRunStatus: () => undefined,
    ...(options.preview !== undefined ? { preview: () => options.preview } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.checkTimeoutMs !== undefined ? { checkTimeoutMs: options.checkTimeoutMs } : {}),
    ...(options.modelUsable !== undefined ? { modelUsable: options.modelUsable } : {}),
  });
  return { service, runs, mainDb, paths, engine, deliveries, target, clock };
}

const identity: RunIdentity = {
  runId: 'run_task',
  botId: 'bot_a',
  conversationId: 'conv_1',
  loopType: 'task',
};

function craft(
  h: Harness,
  params: WidgetCraftParams,
  options: { signal?: AbortSignal; progress?: string[]; runId?: string } = {},
): Promise<ToolResult> {
  return h.service.craft({
    identity: { ...identity, runId: options.runId ?? identity.runId },
    params,
    signal: options.signal ?? new AbortController().signal,
    progress: (text) => options.progress?.push(text),
  });
}

const specScript: StageScript = async (tools) => {
  await tools.call('write', { path: 'spec.md', content: SPEC_MD });
  await tools.call('write', { path: 'acceptance.json', content: ACCEPTANCE });
  await tools.call('stage_done', { summary: '规格已写' });
};
const buildScript =
  (html: string): StageScript =>
  async (tools) => {
    await tools.call('write', { path: 'index.html', content: html });
    await tools.call('stage_done', { summary: '已写' });
  };
const editScript =
  (oldText: string, newText: string): StageScript =>
  async (tools) => {
    await tools.call('edit', { path: 'index.html', edits: [{ oldText, newText }] });
    await tools.call('stage_done', { summary: '已修' });
  };
const noop: StageScript = async (tools) => {
  await tools.call('stage_done', { summary: '没改' });
};

function stageRuns(h: Harness) {
  return h.runs.listByConversation('conv_1', 100).filter((r) => r.loopType === 'widget_authoring');
}

function draftManifest(h: Harness, craftId: string): WidgetCraftManifest {
  return JSON.parse(
    readFileSync(path.join(botWidgetDraftDir(h.paths, 'bot_a', craftId), 'manifest.json'), 'utf8'),
  ) as WidgetCraftManifest;
}

const craftIdOf = (text: string): string => /craftId: (wcf_[A-Za-z0-9_-]+)/.exec(text)![1]!;

describe('widget craft loop (D87)', () => {
  it('一次写对：SPEC → BUILD → GATE 通过 → 交付 unverified（无 S2），草稿删除，阶段 run 落库', async () => {
    const h = harness();
    h.engine.add('SPEC', specScript).add('BUILD', buildScript(GOOD));
    const progress: string[] = [];
    const result = await craft(
      h,
      { brief: '做个点击计数器', title: '计数器', acceptance: ['刷新后计数还在'] },
      { progress },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('v1 已交付');
    expect(result.content).toContain('未经运行验证');
    expect(result.content).toContain('widgetId: wgt_new');
    expect(result.content.length).toBeLessThanOrEqual(WIDGET_CRAFT_RESULT_MAX_CHARS);
    expect(result.content).not.toMatch(/<html|<script|<!DOCTYPE/i);

    expect(h.deliveries).toHaveLength(1);
    const delivered = h.deliveries[0]!.input as Record<string, unknown> & {
      check: {
        status: string;
        summary: { gateRounds: number; craftId: string; previewed: boolean };
      };
    };
    expect(delivered['html']).toBe(GOOD);
    expect(delivered['title']).toBe('计数器');
    expect(delivered['description']).toBe('一个点击计数器');
    expect(delivered['runId']).toBe('run_task');
    expect(delivered.check.status).toBe('unverified');
    expect(delivered.check.summary).toMatchObject({ gateRounds: 1, previewed: false });
    expect(existsSync(botWidgetDraftDir(h.paths, 'bot_a', delivered.check.summary.craftId))).toBe(
      false,
    );

    const runs = stageRuns(h);
    // SPEC、BUILD + 审查（脚本里没有审查结论 → 记 skipped，不阻断交付）。
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.parentRunId).toBe('run_task');
      expect(run.status).toBe('completed');
    }
    const usage = h.mainDb
      .prepare("select count(*) as n from usage_ledger where loop_type = 'widget_authoring'")
      .get() as { n: number };
    expect(usage.n).toBe(3);
    // SPEC 的输入带 brief 与用户验收要求；任务面拿不到这些阶段的任何内容（只有回执）。
    expect(h.engine.specs[0]!.messages[0]!.content).toContain('刷新后计数还在');
    expect(progress.some((p) => p.includes('已交付 v1'))).toBe(true);
  });

  it('GATE 不合格 → FIX（只能 edit，整份覆盖被拒）→ 通过后交付', async () => {
    const h = harness();
    let overwrite: ToolResult | null = null;
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(BAD))
      .add('FIX', async (tools, spec) => {
        expect(spec.messages[0]!.content).toContain('sandbox.storage');
        overwrite = await tools.call('write', { path: 'index.html', content: GOOD });
        await editScript("  localStorage.setItem('x', '1');\n", '')(tools, spec);
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(overwrite).toMatchObject({ ok: false, errorCode: 'WRITE_DENIED' });
    expect(h.deliveries[0]!.input['html']).toBe(GOOD);
    expect(
      (h.deliveries[0]!.input['check'] as { summary: { gateRounds: number } }).summary.gateRounds,
    ).toBe(2);
    expect(stageRuns(h)).toHaveLength(4);
  });

  it('FIX 引入回归 → 回滚到最佳快照，下一轮输入写明回归', async () => {
    const h = harness();
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(BAD))
      // 第 1 轮修复反而多加了一个阻断项。
      .add('FIX', editScript('  init();', "  if (confirm('ok?')) state.count = 0;\n  init();"))
      .add('FIX', async (tools, spec) => {
        const input = spec.messages[0]!.content;
        expect(input).toContain('<rollback>');
        expect(input).toContain('sandbox.modals');
        // 文件已被回滚到 BAD（没有 confirm）。
        const read = await tools.call('read', { path: 'index.html' });
        expect(read.content).not.toContain('confirm(');
        await editScript("  localStorage.setItem('x', '1');\n", '')(tools, spec);
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(h.deliveries[0]!.input['html']).toBe(GOOD);
    expect(WORSE).toContain('confirm(');
  });

  it('同一组问题连续两轮 → 收缩模式；轮数用尽仍有阻断项 → 不交付，回执带原因与 craftId，草稿保留；续做后交付', async () => {
    const h = harness();
    h.engine.add('SPEC', specScript).add('BUILD', buildScript(BAD));
    for (let i = 0; i < WIDGET_CRAFT_FIX_ROUNDS_MAX; i++) h.engine.add('FIX', noop);
    const failed = await craft(h, { brief: '计数器', title: '计数器' });
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe('WIDGET_CRAFT_FAILED');
    expect(failed.content).toContain('组件未交付');
    expect(failed.content).toContain('①');
    expect(failed.content).not.toMatch(/<html|<script/i);
    expect(h.deliveries).toHaveLength(0);
    const fixInputs = h.engine.specs.filter((s) =>
      s.messages[0]!.content.includes('<stage>FIX</stage>'),
    );
    expect(fixInputs).toHaveLength(WIDGET_CRAFT_FIX_ROUNDS_MAX);
    expect(fixInputs[0]!.messages[0]!.content).not.toContain('<shrink>');
    expect(fixInputs[1]!.messages[0]!.content).toContain('<shrink>');

    const craftId = craftIdOf(failed.content);
    const manifest = draftManifest(h, craftId);
    expect(manifest.status).toBe('failed');
    expect(manifest.rounds.gate).toBe(WIDGET_CRAFT_FIX_ROUNDS_MAX + 1);

    // 续做：从检查开始（不重写规格），新的修复预算。
    h.engine.add('FIX', editScript("  localStorage.setItem('x', '1');\n", ''));
    const resumed = await craft(
      h,
      { brief: '计数器（换个改法）', resume_craft_id: craftId },
      { runId: 'run_task2' },
    );
    expect(resumed.ok).toBe(true);
    expect(h.deliveries[0]!.input['runId']).toBe('run_task2');
    const lastFix = h.engine.specs
      .filter((spec) => spec.messages[0]!.content.includes('<stage>FIX</stage>'))
      .at(-1)!;
    expect(lastFix.messages[0]!.content).toContain('<resume_note>');
    expect(
      h.engine.specs.filter((s) => s.messages[0]!.content.includes('<stage>SPEC</stage>')),
    ).toHaveLength(1);
  });

  it('只剩警告：修一轮，仍有警告就带已知问题交付（无 S2 时状态 unverified）', async () => {
    const h = harness();
    h.engine.add('SPEC', specScript).add('BUILD', buildScript(WARN_ONLY)).add('FIX', noop);
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已知问题');
    const check = h.deliveries[0]!.input['check'] as {
      status: string;
      summary: { knownIssues: string[] };
    };
    expect(check.status).toBe('unverified');
    expect(check.summary.knownIssues.length).toBeGreaterThan(0);
    expect(
      h.engine.specs.filter((s) => s.messages[0]!.content.includes('<stage>FIX</stage>')),
    ).toHaveLength(1);
  });

  it('修改已有组件：草稿以最新版初始化，交付走 update', async () => {
    const h = harness();
    h.engine
      .add('SPEC', async (tools, spec) => {
        expect(spec.messages[0]!.content).toContain('<existing_outline>');
        expect((await tools.call('read', { path: 'queries.json' })).content).toContain('widget_kv');
        await specScript(tools, spec);
      })
      .add('BUILD', editScript('标题', '计数器'));
    const result = await craft(h, { brief: '把标题改成计数器', widget_id: 'wgt_old' });
    expect(result.ok).toBe(true);
    expect(h.deliveries[0]!.kind).toBe('update');
    expect(h.deliveries[0]!.input['widgetId']).toBe('wgt_old');
    expect(h.deliveries[0]!.input['queries']).toEqual([
      { name: 'all', sql: 'select key from widget_kv' },
    ]);
    expect(String(h.deliveries[0]!.input['html'])).toContain('<h3 id="title">计数器</h3>');

    const missing = await craft(h, { brief: 'x', widget_id: 'wgt_nope' });
    expect(missing).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  it('父 run 取消 → 当前阶段 run cancelled、不交付、草稿保留（status cancelled）', async () => {
    const h = harness();
    const parent = new AbortController();
    h.engine.add('SPEC', specScript).add('BUILD', async () => undefined, { hold: true });
    h.engine.onStart = (stage) => {
      if (stage === 'BUILD') queueMicrotask(() => parent.abort());
    };
    const result = await craft(h, { brief: '计数器', title: '计数器' }, { signal: parent.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(h.deliveries).toHaveLength(0);
    const build = stageRuns(h).find((r) => r.status === 'cancelled');
    expect(build).toBeDefined();
    expect(draftManifest(h, craftIdOf(result.content)).status).toBe('cancelled');
  });

  it('runs.cancel 落到阶段 run（cancelStageRun）= 取消整次制作', async () => {
    const h = harness();
    h.engine.add('SPEC', async () => undefined, { hold: true });
    h.engine.onStart = () =>
      queueMicrotask(() => {
        const running = stageRuns(h).find((r) => r.status === 'running')!;
        expect(h.service.cancelStageRun(running.id)).toBe(true);
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(h.service.cancelStageRun('run_unknown')).toBe(false);
  });

  it('时限：停在 BUILD → 对已写的文件补一次检查，合格就交付最佳版本并注明', async () => {
    // 时限只负责把 hold 的 BUILD 阶段停下来，语义与数值无关；给足余量，
    // 让前两个阶段（真实的草稿写入 + run/usage 落库）在满载的 CI 上先走完、
    // index.html 落盘（50ms 会和阶段启动竞速，Windows CI 上停在了写文件之前）。
    const h = harness({ timeoutMs: 2_000 });
    h.engine.add('SPEC', specScript).add(
      'BUILD',
      async (tools) => {
        await tools.call('write', { path: 'index.html', content: GOOD });
      },
      { hold: true },
    );
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('超过时限');
  });

  it('回执关卡：检查之后文件被改动（快照也被改）→ 宿主拒绝交付', async () => {
    let tampered = false;
    const preview: WidgetPreviewRunner = {
      run: async () => {
        if (!tampered) {
          tampered = true;
          // 模拟检查之后、交付之前文件被改动（连快照一起改，回滚也救不回来）。
          const dir = path.dirname(findDraftHtml());
          writeFileSync(path.join(dir, 'index.html'), `${GOOD}<!-- changed -->`);
          writeFileSync(
            path.join(dir, 'snapshots', 'round-1', 'index.html'),
            `${GOOD}<!-- changed -->`,
          );
        }
        return { skipped: '测试' };
      },
    };
    const h = harness({ preview });
    const findDraftHtml = (): string => {
      const root = path.join(h.paths.home, 'bots', 'bot_a', 'widget-drafts');
      const craftDir = readdirSync(root)[0]!;
      return path.join(root, craftDir, 'index.html');
    };
    h.engine.add('SPEC', specScript).add('BUILD', buildScript(GOOD));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('交付被拒');
    expect(h.deliveries).toHaveLength(0);
  });

  it('交付失败（如组件数上限）→ 如实失败、草稿保留', async () => {
    const h = harness({ deliverFails: '你已有 100 个组件' });
    h.engine.add('SPEC', specScript).add('BUILD', buildScript(GOOD));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result).toMatchObject({ ok: false, errorCode: 'WIDGET_CRAFT_FAILED' });
    expect(result.content).toContain('你已有 100 个组件');
    expect(existsSync(botWidgetDraftDir(h.paths, 'bot_a', craftIdOf(result.content)))).toBe(true);
  });

  it('验收点不合格：SPEC 收到报错重写一次', async () => {
    const h = harness();
    h.engine
      .add('SPEC', async (tools) => {
        await tools.call('write', { path: 'spec.md', content: SPEC_MD });
        await tools.call('write', { path: 'acceptance.json', content: '[{"id": "x"}]' });
      })
      .add('SPEC', async (tools, spec) => {
        expect(spec.messages[0]!.content).toContain('acceptance.json 不合格');
        await specScript(tools, spec);
      })
      .add('BUILD', buildScript(GOOD));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
  });

  it('入参与前置条件：brief / title 缺失、每 run 次数上限、无模型', async () => {
    const h = harness();
    expect(await craft(h, { brief: '' })).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(await craft(h, { brief: '做个计数器' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });
    for (let i = 0; i < 3; i++) {
      h.engine.add('SPEC', specScript).add('BUILD', buildScript(GOOD));
      expect((await craft(h, { brief: '计数器', title: `计数器${i}` })).ok).toBe(true);
    }
    expect(await craft(h, { brief: '计数器', title: '第四个' })).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_CRAFT_FAILED',
    });

    const none = harness({ model: '' });
    expect(await craft(none, { brief: '计数器', title: '计数器' })).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_CRAFT_UNAVAILABLE',
    });
  });
});

describe('review fixes (D87 P3a)', () => {
  it('BUILD 没写出 index.html → html.missing 走正常 FIX（FIX 可新建 index.html）→ 交付', async () => {
    const h = harness();
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', noop)
      .add('FIX', async (tools, spec) => {
        expect(spec.messages[0]!.content).toContain('html.missing');
        await buildScript(GOOD)(tools, spec);
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(h.deliveries[0]!.input['html']).toBe(GOOD);
  });

  it('没有源码的草稿续做 → 回到 BUILD（不卡在检查上）', async () => {
    const h = harness();
    const parent = new AbortController();
    h.engine.add('SPEC', specScript).add('BUILD', async () => undefined, { hold: true });
    h.engine.onStart = (stage) => {
      if (stage === 'BUILD') queueMicrotask(() => parent.abort());
    };
    const cancelled = await craft(
      h,
      { brief: '计数器', title: '计数器' },
      { signal: parent.signal },
    );
    h.engine.onStart = null;
    h.engine.add('BUILD', buildScript(GOOD));
    const resumed = await craft(
      h,
      { brief: '计数器', resume_craft_id: craftIdOf(cancelled.content) },
      { runId: 'run_task2' },
    );
    expect(resumed.ok).toBe(true);
  });

  it('修改已有组件时 BUILD 不提供 widget_template（会整份覆盖现有源码）', async () => {
    const h = harness();
    h.engine.add('SPEC', specScript).add('BUILD', editScript('标题', '计数器'));
    await craft(h, { brief: '改标题', widget_id: 'wgt_old' });
    const build = h.engine.specs.find((s) =>
      s.messages[0]!.content.includes('<stage>BUILD</stage>'),
    )!;
    expect(build.tools.map((t) => t.name)).not.toContain('widget_template');
  });

  it('制作期间组件已有新版本 → 不覆盖，如实失败', async () => {
    const h = harness();
    let version = 1;
    const original = h.target.craftSource;
    h.target.craftSource = (botId, widgetId) => {
      const found = original(botId, widgetId);
      return found.ok ? { ...found, version } : found;
    };
    h.engine.add('SPEC', specScript).add('BUILD', async (tools, spec) => {
      version = 2; // 另一路交付抢先落了 v2
      await editScript('标题', '计数器')(tools, spec);
    });
    const result = await craft(h, { brief: '改标题', widget_id: 'wgt_old' });
    expect(result).toMatchObject({ ok: false, errorCode: 'WIDGET_CRAFT_FAILED' });
    expect(result.content).toContain('新版本 v2');
    expect(h.deliveries).toHaveLength(0);
  });

  it('只为警告修一轮却修出了错误 → 不再修，交付那个只剩警告的版本', async () => {
    const h = harness();
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(WARN_ONLY))
      .add('FIX', editScript('  init();', "  localStorage.setItem('x', '1');\n  init();"));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(h.deliveries[0]!.input['html']).toBe(WARN_ONLY);
    expect(
      h.engine.specs.filter((s) => s.messages[0]!.content.includes('<stage>FIX</stage>')),
    ).toHaveLength(1);
  });

  it('引擎启动就抛错 → 阶段 run 结算为 failed，制作如实失败', async () => {
    const h = harness();
    h.engine.startRun = () => {
      throw new Error('engine exploded');
    };
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result).toMatchObject({ ok: false, errorCode: 'WIDGET_CRAFT_FAILED' });
    expect(result.content).toContain('engine exploded');
    expect(stageRuns(h).map((r) => r.status)).toEqual(['failed']);
  });
});

describe('S2 接入（D87 P3b）', () => {
  it('预览宿主没按时回应 → 这一轮 S2 记 skipped（不冤枉组件），交付为 unverified', async () => {
    const preview: WidgetPreviewRunner = { run: () => new Promise(() => undefined) };
    const h = harness({ preview, checkTimeoutMs: 50 });
    h.engine.add('SPEC', specScript).add('BUILD', buildScript(GOOD));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    const check = h.deliveries[0]!.input['check'] as { status: string };
    expect(check.status).toBe('unverified');
  });

  it('预览跑通且无问题 → passed；模型自查拿到截图（ToolResult.images）', async () => {
    let selfCheck: ToolResult | null = null;
    const preview = {
      run: async () => ({ issues: [], acceptance: [], outline: 'h3 标题' }),
      screenshots: () => [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
    };
    const h = harness({ preview });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', async (tools) => {
        await tools.call('write', { path: 'index.html', content: GOOD });
        selfCheck = await tools.call('widget_check', {});
        await tools.call('stage_done', { summary: '已写' });
      })
      .add('REVIEW', async (tools) => {
        await tools.call('submit_review', { verdict: 'pass', findings: [] });
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已通过自检');
    expect((h.deliveries[0]!.input['check'] as { status: string }).status).toBe('passed');
    expect(selfCheck!.images).toEqual([{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }]);
  });
});

describe('独立审查 REVIEW（D87 P3c）', () => {
  const passing = {
    run: async () => ({ issues: [], acceptance: [], outline: 'h3 标题' }),
  };
  const submit =
    (result: unknown): StageScript =>
    async (tools) => {
      await tools.call('submit_review', result);
    };
  const p1 = {
    severity: 'P1',
    line: 44,
    problem: '计数没有上限检查',
    scenario: '连点 1000 次 → 数字溢出显示科学计数法',
    fixHint: '限制最大值',
  };

  it('审查通过 → passed，回执写明审查轮数；审查 run 只有只读工具与 submit_review', async () => {
    const h = harness({ preview: passing });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', async (tools, spec) => {
        expect(spec.tools.map((t) => t.name).sort()).toEqual(['ls', 'read', 'submit_review']);
        expect(spec.messages[0]!.content).toContain('<machine_check>');
        await submit({ verdict: 'pass', findings: [] })(tools, spec);
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('审查 1 轮');
    expect(result.content).not.toContain('审查未完成');
    const check = h.deliveries[0]!.input['check'] as {
      status: string;
      summary: { reviewRounds: number; reviewSkipped: boolean };
    };
    expect(check.status).toBe('passed');
    expect(check.summary).toMatchObject({ reviewRounds: 1, reviewSkipped: false });
  });

  it('审查提出 P1 → FIX（输入是审查意见）→ GATE → 第二轮审查只核对上一轮 → 通过', async () => {
    const h = harness({ preview: passing });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add(
        'REVIEW',
        submit({ verdict: 'fix', findings: [p1, { ...p1, severity: 'P2', problem: '按钮太小' }] }),
      )
      .add('FIX', async (tools, spec) => {
        const input = spec.messages[0]!.content;
        expect(input).toContain('独立审查提出 1 个要修的问题');
        expect(input).toContain('计数没有上限检查');
        expect(input).not.toContain('按钮太小');
        await editScript('state.count += 1;', 'state.count = Math.min(state.count + 1, 999);')(
          tools,
          spec,
        );
      })
      .add('REVIEW', async (tools, spec) => {
        expect(spec.messages[0]!.content).toContain('<previous_findings>');
        await submit({ verdict: 'pass', findings: [] })(tools, spec);
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect((h.deliveries[0]!.input['check'] as { status: string }).status).toBe('passed');
    expect(String(h.deliveries[0]!.input['html'])).toContain('Math.min');
  });

  it('两轮审查后仍有 P1 → 照常交付但状态 issues，问题列入已知问题', async () => {
    const h = harness({ preview: passing });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', submit({ verdict: 'fix', findings: [p1] }))
      .add('FIX', editScript('state.count += 1;', 'state.count += 1; /* 试图修 */'))
      .add('REVIEW', submit({ verdict: 'fix', findings: [p1] }));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已知问题');
    const check = h.deliveries[0]!.input['check'] as {
      status: string;
      summary: { knownIssues: string[] };
    };
    expect(check.status).toBe('issues');
    expect(check.summary.knownIssues[0]).toBe('审查：计数没有上限检查');
    expect(
      h.engine.specs.filter((s) => s.messages[0]!.content.includes('<stage>FIX</stage>')),
    ).toHaveLength(1);
  });

  it('审查没交结论 → 记 skipped，不阻断交付，回执写明「审查未完成」', async () => {
    const h = harness({ preview: passing });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', async () => undefined);
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('审查未完成');
    const check = h.deliveries[0]!.input['check'] as {
      status: string;
      summary: { reviewSkipped: boolean; knownIssues: string[] };
    };
    // 没审过的文件不是「已通过自检」（审查修复 #1）。
    expect(check.status).toBe('issues');
    expect(check.summary.reviewSkipped).toBe(true);
    expect(check.summary.knownIssues).toContain('未完成独立审查');
  });

  it('审查修好了 P1 但多了一个警告：不回滚到被审查出问题的版本（审查意见计入最佳版本的分数）', async () => {
    const h = harness({ preview: passing });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', submit({ verdict: 'fix', findings: [p1] }))
      // 修好了 P1，顺带多了一个警告（alert）。
      .add(
        'FIX',
        editScript(
          'state.count += 1;',
          "state.count = Math.min(state.count + 1, 999); alert('满了');",
        ),
      )
      // 只剩警告的那一轮修复：什么都没改。
      .add('FIX', async (tools, spec) => {
        expect(spec.messages[0]!.content).not.toContain('<rollback>');
        await tools.call('stage_done', { summary: '没改' });
      })
      .add('REVIEW', submit({ verdict: 'pass', findings: [] }));
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(String(h.deliveries[0]!.input['html'])).toContain('Math.min');
    const check = h.deliveries[0]!.input['check'] as { summary: { knownIssues: string[] } };
    expect(check.summary.knownIssues.some((issue) => issue.includes('计数没有上限检查'))).toBe(
      false,
    );
  });

  it('审查模型不可用（换了厂商 / 删了 key）→ 退回制作的模型审查', async () => {
    const h = harness({
      preview: passing,
      reviewModel: 'gone/reviewer',
      modelUsable: (ref) => ref !== 'gone/reviewer',
    });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', submit({ verdict: 'pass', findings: [] }));
    await craft(h, { brief: '计数器', title: '计数器' });
    const review = h.engine.specs.find((spec) =>
      spec.messages[0]!.content.includes('<stage>REVIEW</stage>'),
    )!;
    expect(review.model).toBe('mock/main');
  });

  it('submit_review：格式不对要求重交；没有失败场景的条目丢弃', async () => {
    const h = harness({ preview: passing });
    const replies: ToolResult[] = [];
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', async (tools) => {
        replies.push(await tools.call('submit_review', { verdict: 'maybe', findings: [] }));
        replies.push(
          await tools.call('submit_review', {
            verdict: 'fix',
            findings: [{ severity: 'P1', problem: '感觉不好', scenario: '  ' }],
          }),
        );
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(replies[0]).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(replies[1]).toMatchObject({ ok: true, terminate: true });
    expect(replies[1]!.content).toContain('1 条没有失败场景已丢弃');
    // 唯一的条目被丢弃 → 没有要修的问题 → 通过。
    expect(result.ok).toBe(true);
    expect((h.deliveries[0]!.input['check'] as { status: string }).status).toBe('passed');
  });

  it('设置了「组件审查模型」→ 审查 run 用它，制作阶段仍用 Bot 主模型', async () => {
    const h = harness({ preview: passing, reviewModel: 'mock/reviewer' });
    h.engine
      .add('SPEC', specScript)
      .add('BUILD', buildScript(GOOD))
      .add('REVIEW', submit({ verdict: 'pass', findings: [] }));
    await craft(h, { brief: '计数器', title: '计数器' });
    const models = Object.fromEntries(
      h.engine.specs.map((spec) => [
        /<stage>(\w+)<\/stage>/.exec(spec.messages[0]!.content)![1],
        spec.model,
      ]),
    );
    expect(models).toEqual({ SPEC: 'mock/main', BUILD: 'mock/main', REVIEW: 'mock/reviewer' });
    expect(stageRuns(h).find((r) => r.model === 'mock/reviewer')).toBeDefined();
  });
});

describe('widget craft stage tools (guards)', () => {
  it('越界路径、写 manifest、阶段白名单、FIX 不能覆盖', async () => {
    const h = harness();
    const results: Record<string, ToolResult> = {};
    h.engine
      .add('SPEC', async (tools) => {
        results['outside'] = await tools.call('write', { path: '../escape.txt', content: 'x' });
        results['manifest'] = await tools.call('write', { path: 'manifest.json', content: '{}' });
        results['specHtml'] = await tools.call('write', { path: 'index.html', content: GOOD });
        results['readOutside'] = await tools.call('read', { path: '/etc/hostname' });
        await specScript(tools, {} as never);
      })
      .add('BUILD', async (tools, spec) => {
        results['buildSpec'] = await tools.call('write', { path: 'spec.md', content: 'x' });
        results['template'] = await tools.call('widget_template', { name: 'blank' });
        results['check'] = await tools.call('widget_check', {});
        await tools.call('stage_done', { summary: 'ok' });
        expect(spec.tools.map((t) => t.name)).toEqual(
          expect.arrayContaining([
            'read',
            'ls',
            'write',
            'edit',
            'widget_check',
            'widget_template',
            'stage_done',
          ]),
        );
      });
    const result = await craft(h, { brief: '计数器', title: '计数器' });
    expect(result.ok).toBe(true);
    expect(results['outside']).toMatchObject({ ok: false, errorCode: 'PATH_OUT_OF_SCOPE' });
    expect(results['manifest']).toMatchObject({ ok: false, errorCode: 'WRITE_DENIED' });
    expect(results['specHtml']).toMatchObject({ ok: false, errorCode: 'WRITE_DENIED' });
    expect(results['readOutside']).toMatchObject({ ok: false, errorCode: 'PATH_OUT_OF_SCOPE' });
    expect(results['buildSpec']).toMatchObject({ ok: false, errorCode: 'WRITE_DENIED' });
    expect(results['template']!.ok).toBe(true);
    expect(results['check']!.ok).toBe(true);
    const specTools = h.engine.specs[0]!.tools.map((t) => t.name);
    expect(specTools).not.toContain('edit');
    expect(specTools).not.toContain('widget_check');
    expect(h.deliveries[0]!.input['html']).toBe(GOOD);
  });
});
