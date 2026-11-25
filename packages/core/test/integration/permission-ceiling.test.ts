import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, type TestStack } from '@kepcup/testkit';

/**
 * 62.11 C14（CoreServicesOptions.permissionCeiling / principals）：授权级别超
 * 宿主上限拒绝设置（PERMISSION_CEILING）、上限内的照常；注入主体目录后全局
 * 无人值守失效（effective 恒关、enable FORBIDDEN）；都不传 = 现状。
 */

describe('62.11 C14 授权级别上限', () => {
  let stack: TestStack;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack({ permissionCeiling: 'auto' });
    const bot = await makeBot(stack.core, '上限甲');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('set bypass 超上限抛 PERMISSION_CEILING', async () => {
    await expect(
      stack.core.rpc.call('permissions.mode.set', {
        conversationId,
        mode: 'bypass',
        acknowledgeRisk: true,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_CEILING' });
  });

  it('set auto 在上限内照常生效（可再降回 manual）', async () => {
    const raised = (await stack.core.rpc.call('permissions.mode.set', {
      conversationId,
      mode: 'auto',
      acknowledgeRisk: true,
    })) as { mode: string };
    expect(raised.mode).toBe('auto');
    const cleared = (await stack.core.rpc.call('permissions.mode.set', {
      conversationId,
      mode: 'manual',
    })) as { mode: string };
    expect(cleared.mode).toBe('manual');
  });

  it('set manual（降级 / 清除）不受上限约束', async () => {
    const result = (await stack.core.rpc.call('permissions.mode.set', {
      conversationId,
      mode: 'manual',
    })) as { mode: string };
    expect(result.mode).toBe('manual');
  });
});

describe('62.11 C14 主体在场时全局无人值守失效', () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack({
      principals: { describe: (id) => ({ name: `成员 ${id}` }) },
    });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('enable 抛 FORBIDDEN；effective 恒为关闭', async () => {
    await expect(
      stack.core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const state = (await stack.core.rpc.call('unattended.get')) as { enabled: boolean };
    expect(state.enabled).toBe(false);
  });

  it('disable 不受影响（已存的开启态也能被清理）', async () => {
    const result = (await stack.core.rpc.call('unattended.disable')) as { enabled: boolean };
    expect(result.enabled).toBe(false);
  });
});

describe('62.11 C14 都不传 = 现状', () => {
  let stack: TestStack;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack();
    const bot = await makeBot(stack.core, '无上限丙');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('bypass 可设置（无上限）；无人值守 enable 正常', async () => {
    const raised = (await stack.core.rpc.call('permissions.mode.set', {
      conversationId,
      mode: 'bypass',
      acknowledgeRisk: true,
    })) as { mode: string };
    expect(raised.mode).toBe('bypass');
    await stack.core.rpc.call('permissions.mode.set', { conversationId, mode: 'manual' });

    const enabled = (await stack.core.rpc.call('unattended.enable', {
      hours: 1,
      acknowledgeRisk: true,
    })) as { enabled: boolean };
    expect(enabled.enabled).toBe(true);
    // 读侧带 time box 的口径也开启；测试结束前关掉，避免影响同栈其它用例。
    await stack.core.rpc.call('unattended.disable');
  });
});
