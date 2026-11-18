import { describe, expect, it, vi } from 'vitest';
import { settingsSchema, TRIAGE_TIMEOUT_MS, type Bot, type Settings } from '@kepcup/shared';
import {
  builtinModelRef,
  LlmRouter,
  routeFor,
  routeStillCurrent,
} from '../../src/agent/llm-router.js';
import { judgeContinuation } from '../../src/dispatch/dispatcher.js';
import type { AgentEngine } from '../../src/agent/types.js';

/** `agent/llm-router.ts`（2026-11 修订）：后台调用恒内置，按用途解析内置模型链。 */

const builtin = { startRun: vi.fn(), complete: vi.fn() } as unknown as AgentEngine;

function bot(
  runtime: Partial<Bot['profile']['runtime']> = {},
  agent: Partial<Bot['profile']['runtime']['agent']> = {},
): Bot {
  return {
    id: 'bot_1',
    profile: {
      runtime: {
        model: '',
        light_model: '',
        background_model: '',
        ...runtime,
        agent: {
          id: '',
          model: '',
          effort: '',
          permission: 'workspace',
          capabilities: null,
          ...agent,
        },
      },
    },
  } as unknown as Bot;
}

function router(patch: Partial<Settings> = {}, options: { bot?: Bot } = {}) {
  const settings = settingsSchema.parse(patch);
  return new LlmRouter({
    settings: { get: () => settings },
    bots: {
      get: (id) => (options.bot !== undefined && id === options.bot.id ? options.bot : null),
    },
    builtin,
  });
}

describe('LlmRouter', () => {
  it('background upkeep follows the background-model chain; light purposes stay light', () => {
    const withModels = router({
      defaultMainModel: 'custom:m/main',
      defaultLightModel: 'custom:m/light',
      backgroundModel: 'custom:m/bg',
    });
    const b = bot({
      model: 'custom:b/main',
      light_model: 'custom:b/light',
      background_model: 'custom:b/bg',
    });
    // 整理类后台：Bot 后台任务模型 → 全局后台任务模型 → 轻量 → 主。
    expect(withModels.resolveForBot(b, 'summary')?.modelRef).toBe('custom:b/bg');
    expect(withModels.resolveForBot(b, 'reflection')?.modelRef).toBe('custom:b/bg');
    expect(withModels.resolveForBot(b, 'consolidation')?.modelRef).toBe('custom:b/bg');
    expect(withModels.resolveForBot(b, 'wiki_maintenance')?.modelRef).toBe('custom:b/bg');
    expect(withModels.resolveForBot(b, 'skill_authoring')?.modelRef).toBe('custom:b/bg');
    expect(
      router({ backgroundModel: 'custom:m/bg' }).resolveForBot(
        bot({ light_model: 'custom:b/light' }),
        'summary',
      )?.modelRef,
    ).toBe('custom:m/bg');
    expect(
      router({ defaultLightModel: 'custom:m/light' }).resolveForBot(bot(), 'summary')?.modelRef,
    ).toBe('custom:m/light');
    expect(router({ defaultMainModel: 'custom:m/main' }).resolveDefault('summary')?.modelRef).toBe(
      'custom:m/main',
    );
    // 摘要 / 反思 / 整理未设后台任务模型时落回轻量链；画像 / Wiki / 技能落回主模型链。
    expect(
      router({ defaultLightModel: 'custom:m/light' }).resolveForBot(bot(), 'wiki_maintenance'),
    ).toBeNull();
    expect(
      router({ defaultMainModel: 'custom:m/main' }).resolveForBot(
        bot({ model: 'custom:b/main' }),
        'profile_curation',
      )?.modelRef,
    ).toBe('custom:b/main');
    // 无所属 Bot 的整理任务（画像整理）：没有 Bot 级覆盖，直接走全局链。
    expect(withModels.resolveDefault('profile_curation')?.modelRef).toBe('custom:m/bg');
    // 分诊 / 压缩 / 微应用仍走轻量链，不走后台任务模型。
    expect(withModels.resolveForBot(b, 'triage')?.modelRef).toBe('custom:b/light');
    expect(withModels.resolveForBot(b, 'task_compaction')?.modelRef).toBe('custom:b/light');
    expect(withModels.resolveForBot(b, 'subagent_compaction')?.modelRef).toBe('custom:b/light');
    expect(withModels.resolveForBot(b, 'micro_app')?.modelRef).toBe('custom:b/light');
    // 组件制作与审查走主模型链。
    expect(withModels.resolveForBot(b, 'widget_authoring')?.modelRef).toBe('custom:b/main');
    expect(withModels.resolveForBot(b, 'widget_review')?.modelRef).toBe('custom:b/main');
  });

  it('no usable model → null (callers skip); every route is builtin', () => {
    expect(router({}).resolveDefault('reflection')).toBeNull();
    expect(router({}).resolveForBot(bot(), 'triage')).toBeNull();
    const r = router({ defaultMainModel: 'custom:m/main' });
    for (const purpose of ['summary', 'triage', 'wiki_maintenance'] as const) {
      const route = r.resolveDefault(purpose);
      expect(route, purpose).toMatchObject({ engine: builtin });
      expect(route?.provider).toBe('custom:m');
    }
  });

  it('routeFor without a router keeps the built-in-only behaviour', () => {
    const settings = settingsSchema.parse({});
    expect(
      routeFor({ engine: builtin, settings: { get: () => settings } }, 'reflection', null),
    ).toBeNull();
    const withModel = settingsSchema.parse({ defaultMainModel: 'custom:m/main' });
    expect(
      routeFor({ engine: builtin, settings: { get: () => withModel } }, 'reflection', 'bot_x'),
    ).toMatchObject({ engine: builtin, modelRef: 'custom:m/main' });
  });
});

describe('judgeContinuation through the router (D92 T1a routing)', () => {
  function triageDeps(engine: AgentEngine, timeoutMs?: number) {
    const runs = { create: vi.fn(() => ({ id: 'run_t' })), update: vi.fn() };
    const usage = { record: vi.fn() };
    const scheduler = {
      submit: vi.fn((task: { run: () => Promise<void> }) => void task.run()),
    };
    return {
      runs,
      usage,
      scheduler,
      input: {
        engine,
        router: new LlmRouter({
          settings: {
            get: () =>
              settingsSchema.parse({
                defaultMainModel: 'custom:m/main',
                defaultLightModel: 'custom:m/light',
              }),
          },
          bots: { get: () => null },
          builtin: engine,
        }),
        scheduler: scheduler as never,
        runs: runs as never,
        usage: usage as never,
        settings: { get: () => settingsSchema.parse({}) } as never,
        bots: {
          get: () => {
            const base = bot();
            return {
              ...base,
              name: 'B',
              profile: {
                ...base.profile,
                identity: { name: 'B' },
                role: { expertise: '', responsibilities: '' },
              },
            };
          },
          listActive: () => [],
        } as never,
        messages: { listForBot: () => [] } as never,
        botId: 'bot_1',
        conversationId: 'conv_1',
        batchId: 'b1',
        batchMessages: [],
        goal: null,
        timeZone: 'UTC',
        logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
    };
  }

  it('runs on the built-in light model (JSON only, usage under the model provider)', async () => {
    const complete = vi.fn(async () => ({
      text: '{"decision":"respond","confidence":0.9,"reason":"被点名"}',
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
      stopReason: 'stop',
    }));
    const engine = { startRun: vi.fn(), complete } as unknown as AgentEngine;
    const { input, scheduler, usage } = triageDeps(engine);
    const decision = await judgeContinuation(input);
    expect(decision).toEqual({
      botId: 'bot_1',
      decision: 'respond',
      confidence: 0.9,
      reason: '被点名',
    });
    expect(scheduler.submit.mock.calls[0]![0].provider).toBe('custom:m');
    const [req] = complete.mock.calls[0]! as unknown as [
      { model: string; tools?: unknown; systemPrompt: string },
    ];
    expect(req.model).toBe('custom:m/light');
    // 内置结构化调用带 submit 工具（外部 Agent 时代是 tools: [] 的文本 JSON 约定）。
    expect(req.tools).toBeDefined();
    expect(req.systemPrompt).toContain('Call the submit tool exactly once');
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'custom:m', model: 'light', loopType: 'triage' }),
    );
  });

  it('a slow judgement times out into no_action within the default window', async () => {
    const complete = vi.fn(() => new Promise(() => {}));
    const engine = { startRun: vi.fn(), complete } as unknown as AgentEngine;
    const { input } = triageDeps(engine, 30);
    expect(await judgeContinuation(input)).toEqual({
      botId: 'bot_1',
      decision: 'no_action',
      confidence: 0,
      reason: 'judgement failed',
    });
  });
});

describe('builtinModelRef / routeStillCurrent: the single model-selection entry', () => {
  const settingsOf = (patch: Partial<Settings>) => settingsSchema.parse(patch);

  it('conversation = bot main → default main, whatever the light settings are', () => {
    const s = settingsOf({
      defaultMainModel: 'custom:m/main',
      defaultLightModel: 'custom:m/light',
    });
    expect(builtinModelRef('conversation', s, null)).toBe('custom:m/main');
    expect(builtinModelRef('conversation', s, bot({ model: 'custom:b/main' }))).toBe(
      'custom:b/main',
    );
    expect(builtinModelRef('conversation', settingsOf({}), bot())).toBe('');
  });

  it('widget_review (D87 P3c): the review model setting, else the bot main; a bot-pinned model wins', () => {
    const plain = settingsOf({ defaultMainModel: 'custom:m/main' });
    expect(builtinModelRef('widget_review', plain, bot())).toBe('custom:m/main');
    const withReview = settingsOf({
      defaultMainModel: 'custom:m/main',
      widgetReviewModel: 'custom:r/review',
    });
    expect(builtinModelRef('widget_review', withReview, bot())).toBe('custom:r/review');
    expect(builtinModelRef('widget_review', withReview, null)).toBe('custom:r/review');
    // 固定了自己主模型的 Bot（数据去向）：审查也用它，不把源码发给另一家。
    expect(builtinModelRef('widget_review', withReview, bot({ model: 'custom:b/local' }))).toBe(
      'custom:b/local',
    );
    // 只影响审查，不影响制作。
    expect(builtinModelRef('widget_authoring', withReview, bot())).toBe('custom:m/main');
  });

  it('reads settings on every call, so a default change applies to the next call', () => {
    let current = settingsOf({
      defaultMainModel: 'custom:old/main',
      defaultLightModel: 'custom:old/light',
    });
    const deps = {
      engine: builtin,
      settings: { get: () => current },
      bots: { get: () => bot() },
    };
    expect(routeFor(deps, 'summary', null)?.modelRef).toBe('custom:old/light');
    expect(routeStillCurrent(deps, 'summary', null, 'custom:old/light')).toBe(true);
    current = settingsOf({
      defaultMainModel: 'custom:new/main',
      defaultLightModel: 'custom:new/light',
    });
    expect(routeFor(deps, 'summary', null)?.modelRef).toBe('custom:new/light');
    expect(routeStillCurrent(deps, 'summary', null, 'custom:old/light')).toBe(false);
  });
});
