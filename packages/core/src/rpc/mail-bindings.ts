import { z } from 'zod';
import {
  AppError,
  mailAccountGetOutputSchema,
  mailAccountIdInputSchema,
  mailAccountSetBotsInputSchema,
  mailAccountUpdateInputSchema,
  mailAccountsListOutputSchema,
  mailBindingResumeInputSchema,
  mailBotSetAccountsInputSchema,
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

/**
 * `mail.*`（D84；P3 收敛）：扩展中心的账号管理。返回值不含授权码。
 * 建号 / 测连已收敛到实例层（`plugins.instances.create` → mail materializer），
 * 这里只剩既有账号的管理动作；`mail.accounts.delete` 对实例账号由渲染端改走
 * `plugins.instances.delete`（core 拒绝直接删实例账号，防绕过级联）。
 */
export function bindMailMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const mail = () => {
    if (services.mail === null) throw new AppError('NOT_IMPLEMENTED', '邮件模块未就绪');
    return services.mail;
  };
  return {
    'mail.accounts.list': method(voidInput, mailAccountsListOutputSchema, async () => ({
      accounts: mail().list(),
    })),
    'mail.accounts.get': method(
      mailAccountIdInputSchema,
      mailAccountGetOutputSchema,
      async (input) => ({
        account: mail().get(input.id),
      }),
    ),
    'mail.accounts.update': method(
      mailAccountUpdateInputSchema,
      mailAccountGetOutputSchema,
      async (input) => ({
        account: await mail().update(input),
      }),
    ),
    'mail.accounts.delete': method(mailAccountIdInputSchema, okOutputSchema, async (input) => {
      const account = mail().get(input.id);
      if (account.instanceId !== null) {
        // 实例账号的删除 = 删除实例（级联拆账号）。直删会留下悬空的 plugin_instances 行。
        throw new AppError(
          'INVALID_INPUT',
          '该邮箱来自插件，请在所属插件的卡片上删除（会一并清除账号与绑定）',
        );
      }
      mail().delete(input.id);
      return { ok: true as const };
    }),
    'mail.accounts.setBots': method(
      mailAccountSetBotsInputSchema,
      mailAccountGetOutputSchema,
      async (input) => ({
        account: mail().setBots(input.id, input.botIds),
      }),
    ),
    'mail.bots.setAccounts': method(
      mailBotSetAccountsInputSchema,
      okOutputSchema,
      async (input) => {
        mail().setAccountsForBot(input.botId, input.accountIds);
        return { ok: true as const };
      },
    ),
    'mail.accounts.pause': method(
      mailAccountIdInputSchema,
      mailAccountGetOutputSchema,
      async (input) => ({
        account: mail().pause(input.id),
      }),
    ),
    'mail.accounts.resume': method(
      mailAccountIdInputSchema,
      mailAccountGetOutputSchema,
      async (input) => ({
        account: mail().resume(input.id),
      }),
    ),
    'mail.bindings.resume': method(
      mailBindingResumeInputSchema,
      mailAccountGetOutputSchema,
      async (input) => ({
        account: mail().resumeAlerts(input.accountId, input.botId),
      }),
    ),
  };
}
