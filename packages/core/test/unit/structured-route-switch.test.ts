import { describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { ModelRouteChangedError } from '../../src/agent/model-retry.js';
import { completeStructured } from '../../src/agent/structured.js';
import type { CompletionRequest } from '../../src/agent/types.js';

const schema = z.object({ ok: z.boolean() });
const parametersSchema = Type.Object({ ok: Type.Boolean() });
const identity = { runId: 'r', botId: null, conversationId: null, loopType: 'reflection' } as never;

function reply(req: CompletionRequest) {
  void req;
  return Promise.resolve({
    text: '',
    toolCalls: [{ name: 'submit', arguments: { ok: true } }],
    usage: null,
  });
}

function base(complete: (req: CompletionRequest) => ReturnType<typeof reply>) {
  return {
    complete,
    identity,
    model: 'p/old',
    systemPrompt: 's',
    messages: [],
    parametersSchema,
    schema,
  };
}

describe('completeStructured route switching', () => {
  it('re-issues the call on the new route (its own engine) after a route change', async () => {
    const oldEngine = vi.fn(async (req: CompletionRequest) => {
      // PiEngine would throw this once isRouteCurrent() turns false.
      expect(req.model).toBe('p/old');
      expect(req.isRouteCurrent?.()).toBe(false);
      throw new ModelRouteChangedError();
    });
    const newEngine = vi.fn(reply);
    const result = await completeStructured({
      ...base(oldEngine),
      resolveRoute: () => ({ engine: { complete: newEngine }, modelRef: 'q/new' }),
    });
    expect(result).toEqual({ ok: true });
    expect(oldEngine).toHaveBeenCalledTimes(1);
    expect(newEngine).toHaveBeenCalledTimes(1);
    expect(newEngine.mock.calls[0]![0].model).toBe('q/new');
  });

  it('reports the route as current while the resolved model is unchanged', async () => {
    let seen: boolean | undefined;
    await completeStructured({
      ...base(async (req) => {
        seen = req.isRouteCurrent?.();
        return reply(req);
      }),
      resolveRoute: () => ({ engine: { complete: reply }, modelRef: 'p/old' }),
    });
    expect(seen).toBe(true);
  });

  it('does not follow a switch onto an external agent route', async () => {
    const newEngine = vi.fn(reply);
    const oldEngine = vi.fn(async () => {
      throw new ModelRouteChangedError();
    });
    await expect(
      completeStructured({
        ...base(oldEngine),
        resolveRoute: () => ({ engine: { complete: newEngine }, modelRef: 'agent:claude/default' }),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(newEngine).not.toHaveBeenCalled();
  });

  it('fails with a mapped error when no route resolves any more', async () => {
    await expect(
      completeStructured({
        ...base(async () => {
          throw new ModelRouteChangedError();
        }),
        resolveRoute: () => null,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
