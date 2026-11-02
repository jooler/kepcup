import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, type TestStack } from '@kepcup/testkit';

/**
 * `im.*` RPC 绑定（D107）：方法全部挂上、空态形状正确、未知账号的动作报
 * NOT_FOUND。扫码两步（create / poll）依赖微信端点，不在绑定层测——
 * 落地语义（token 不出 core、级联清除）由 im-channel.test.ts 与验收清单覆盖。
 */

let stack: TestStack;

beforeAll(async () => {
  stack = await createTestStack();
}, 60_000);

afterAll(() => stack.cleanup());

async function call<T>(method: string, input: unknown): Promise<T> {
  return (await stack.core.rpc.call(method, input)) as T;
}

describe('im RPC', () => {
  it('binds every im method', () => {
    const methods = stack.core.services.appMethods;
    for (const name of [
      'im.accounts.list',
      'im.accounts.create',
      'im.accounts.reauthorize',
      'im.accounts.delete',
      'im.accounts.setBots',
      'im.bindings.setForward',
      'im.login.qrcode.create',
      'im.login.qrcode.poll',
    ]) {
      expect(methods[name]).toBeDefined();
    }
  });

  it('empty account list round-trips', async () => {
    const result = await call<{ accounts: unknown[] }>('im.accounts.list', undefined);
    expect(result.accounts).toEqual([]);
  });

  it('unknown accounts surface NOT_FOUND', async () => {
    await expect(call('im.accounts.setBots', { id: 'ima_none', botIds: [] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      call('im.bindings.setForward', { accountId: 'ima_none', botId: 'bot_x', forwardEnabled: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call('im.accounts.delete', { id: 'ima_none' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
