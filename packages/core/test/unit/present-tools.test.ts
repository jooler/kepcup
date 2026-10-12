import { describe, expect, it } from 'vitest';

import { PRESENT_CARDS_PER_RUN_MAX } from '@kepcup/shared';
import type { RunIdentity } from '../../src/agent/types.js';
import { buildPresentTools, type PresentToolFacade } from '../../src/tools/present-tools.js';

/** `present`（D87 P4 L1）：校验失败不发卡；每个 run 最多发 PRESENT_CARDS_PER_RUN_MAX 张（防循环刷屏）。 */

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_a',
  conversationId: 'conv_1',
  loopType: 'turn',
};

describe('present tool', () => {
  it('a bad payload is not emitted; the per-run cap refuses further cards', async () => {
    const emitted: string[] = [];
    const facade: PresentToolFacade = {
      emit: ({ kind }) => {
        emitted.push(kind);
        return { ok: true, messageId: `msg_${emitted.length}` };
      },
    };
    const [tool] = buildPresentTools({ identity, present: facade });
    const bad = await tool!.execute({ kind: 'pie', data: { slices: [] } }, {} as never);
    expect(bad.ok).toBe(false);
    expect(emitted).toEqual([]);

    const good = { kind: 'kpi', data: { items: [{ label: '收入', value: 1 }] } };
    for (let i = 0; i < PRESENT_CARDS_PER_RUN_MAX; i += 1) {
      expect((await tool!.execute(good, {} as never)).ok).toBe(true);
    }
    const over = await tool!.execute(good, {} as never);
    expect(over).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(over.content).toContain(`最多发 ${PRESENT_CARDS_PER_RUN_MAX} 张`);
    expect(emitted).toHaveLength(PRESENT_CARDS_PER_RUN_MAX);
  });
});
