import { z } from 'zod';
import {
  AppError,
  imAccountGetOutputSchema,
  imAccountsListOutputSchema,
  imAccountIdInputSchema,
  imAccountSetBotsInputSchema,
  imBindingSetForwardInputSchema,
  imQrcodeCreateOutputSchema,
  imQrcodePollInputSchema,
  imQrcodePollOutputSchema,
  okOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';

const voidInput = z.void();

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

const qrcodeCreateInput = z.object({
  pluginId: z.string().min(1),
  /** 传入 = 既有账号的重扫（更新流程）；缺省 = 新建。 */
  accountId: z.string().min(1).optional(),
});

/**
 * `im.*`（D107，54 号文档）：扩展中心的 IM 账号管理与扫码登录。返回值永不含
 * bot_token——确认载荷只存在于 core 的内存 pending 表，由建号 / 重扫流程消费。
 * `im.accounts.delete` 走 `plugins.instances.delete` 同款级联（这里直接删实例，
 * 级联拆账号 / secrets / 会话）。
 */
export function bindImMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const im = () => {
    if (services.im === null) throw new AppError('NOT_IMPLEMENTED', 'IM 模块未就绪');
    return services.im;
  };
  return {
    'im.accounts.list': method(voidInput, imAccountsListOutputSchema, async () => ({
      accounts: im().listAccounts(),
    })),
    'im.accounts.delete': method(imAccountIdInputSchema, okOutputSchema, async (input) => {
      const account = im().store.get(input.id);
      if (account === null) throw new AppError('NOT_FOUND', '账号不存在');
      if (services.pluginInstances === null)
        throw new AppError('NOT_IMPLEMENTED', '插件实例模块未就绪');
      // 删账号会解除它和所有 Bot 的绑定：先记下受影响 Bot，再走实例级联删除。
      const before = im()
        .listAccounts()
        .find((candidate) => candidate.id === input.id);
      await services.pluginInstances.delete(account.instanceId);
      for (const botId of before?.botIds ?? []) services.pluginBotNotice?.note(botId);
      return { ok: true as const };
    }),
    'im.accounts.setBots': method(imAccountSetBotsInputSchema, okOutputSchema, async (input) => {
      const before = im()
        .listAccounts()
        .find((account) => account.id === input.id);
      im().setBots(input.id, input.botIds);
      // 微信等 IM 账号「勾选绑定」直接影响插件能否真正工作：30 秒合并后通报相关 Bot。
      const affected = new Set([...(before?.botIds ?? []), ...input.botIds]);
      for (const botId of affected) services.pluginBotNotice?.note(botId);
      return { ok: true as const };
    }),
    'im.bindings.setForward': method(
      imBindingSetForwardInputSchema,
      okOutputSchema,
      async (input) => {
        im().setForward(input.accountId, input.botId, input.forwardEnabled);
        return { ok: true as const };
      },
    ),
    'im.login.qrcode.create': method(
      qrcodeCreateInput,
      imQrcodeCreateOutputSchema,
      async (input) => {
        const account = input.accountId === undefined ? null : im().store.get(input.accountId);
        if (input.accountId !== undefined && account === null) {
          throw new AppError('NOT_FOUND', '账号不存在');
        }
        const result = await im().beginQrcodeLogin(
          input.pluginId,
          input.accountId === undefined ? null : account!.instanceId,
        );
        return { sessionKey: result.sessionKey, qrcodeContent: result.qrcodeContent };
      },
    ),
    'im.login.qrcode.poll': method(
      imQrcodePollInputSchema,
      imQrcodePollOutputSchema,
      async (input) => {
        const result = await im().pollQrcodeLogin(input.sessionKey);
        return { status: result.status, instanceId: null, label: result.label };
      },
    ),
    'im.accounts.create': method(
      z.object({ pluginId: z.string().min(1), sessionKey: z.string().min(1) }),
      imAccountGetOutputSchema,
      async (input) => {
        const account = await im().createFromQrcode(input.pluginId, input.sessionKey);
        return { account };
      },
    ),
    'im.accounts.reauthorize': method(
      z.object({ id: z.string().min(1), sessionKey: z.string().min(1) }),
      okOutputSchema,
      async (input) => {
        await im().reauthorize(input.id, input.sessionKey);
        return { ok: true as const };
      },
    ),
  };
}
