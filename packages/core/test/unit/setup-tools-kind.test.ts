import { describe, expect, it } from 'vitest';
import type { RunIdentity } from '../../src/agent/types.js';
import { buildSetupTools, type SetupToolFacade } from '../../src/tools/setup-tools.js';

/**
 * save_profile 的 kind 参数：初始化访谈中由 LLM 设置 bot.kind。
 * 内置 id 归一大小写，自定义分类保留；可以只设分类（changes 为空）；
 * 非法 / 超长值直接拒绝，不落到 facade。
 */

const identity: RunIdentity = {
  runId: 'run',
  botId: 'bot',
  conversationId: 'conv',
  loopType: 'turn',
};

function callSaveProfile(
  setup: SetupToolFacade,
  args: { changes?: Array<{ field: string; value: string }>; kind?: string },
) {
  const tool = buildSetupTools({ identity, setup }).find((entry) => entry.name === 'save_profile')!;
  return tool.execute(args, { signal: new AbortController().signal } as never);
}

describe('save_profile kind', () => {
  it('passes a normalized built-in id through with the profile changes', async () => {
    const seen: Array<{
      changes: Array<{ field: string; value: string }>;
      kind?: string | undefined;
    }> = [];
    const setup: SetupToolFacade = {
      saveProfile: (_botId, changes, kind) => {
        seen.push({ changes, kind });
        return { ok: true, message: 'saved' };
      },
      finishSetup: () => ({ ok: true, message: 'done' }),
      askQuestion: () => ({ ok: true, message: 'asked' }),
    };

    const result = await callSaveProfile(setup, {
      changes: [{ field: 'role.responsibilities', value: '写代码与调试' }],
      kind: 'Coding',
    });
    expect(result).toMatchObject({ ok: true, content: 'saved' });
    expect(seen).toEqual([
      { changes: [{ field: 'role.responsibilities', value: '写代码与调试' }], kind: 'coding' },
    ]);
  });

  it('allows setting only the kind (empty changes)', async () => {
    const seen: string[] = [];
    const setup: SetupToolFacade = {
      saveProfile: (_botId, changes, kind) => {
        seen.push(`${changes.length}:${kind}`);
        return { ok: true, message: 'saved' };
      },
      finishSetup: () => ({ ok: true, message: 'done' }),
      askQuestion: () => ({ ok: true, message: 'asked' }),
    };
    const result = await callSaveProfile(setup, { changes: [], kind: '法务' });
    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual(['0:法务']);

    // changes 省略也能只设分类。
    const omitted = await callSaveProfile(setup, { kind: 'legal' });
    expect(omitted).toMatchObject({ ok: true });
    expect(seen).toEqual(['0:法务', '0:legal']);
  });

  it('rejects an empty call and an over-long kind before calling the facade', async () => {
    let calls = 0;
    const setup: SetupToolFacade = {
      saveProfile: () => {
        calls += 1;
        return { ok: true, message: 'saved' };
      },
      finishSetup: () => ({ ok: true, message: 'done' }),
      askQuestion: () => ({ ok: true, message: 'asked' }),
    };

    expect(await callSaveProfile(setup, { changes: [] })).toMatchObject({ ok: false });
    expect(await callSaveProfile(setup, { changes: [], kind: 'x'.repeat(33) })).toMatchObject({
      ok: false,
    });
    expect(calls).toBe(0);
  });

  it('keeps the field whitelist independent of kind', async () => {
    const setup: SetupToolFacade = {
      saveProfile: () => ({ ok: true, message: 'saved' }),
      finishSetup: () => ({ ok: true, message: 'done' }),
      askQuestion: () => ({ ok: true, message: 'asked' }),
    };
    const result = await callSaveProfile(setup, {
      changes: [{ field: 'runtime.model', value: 'evil/model' }],
      kind: 'coding',
    });
    expect(result).toMatchObject({ ok: false });
  });
});
