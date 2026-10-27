import { z } from 'zod';
import {
  AppError,
  mailAccountCreateInputSchema,
  mailAccountGetOutputSchema,
  mailAccountIdInputSchema,
  mailAccountSetBotsInputSchema,
  mailAccountTestInputSchema,
  mailAccountTestOutputSchema,
  mailAccountUpdateInputSchema,
  mailAccountsListOutputSchema,
  mailBindingResumeInputSchema,
  mailBotSetAccountsInputSchema,
  mailProviderTemplatesListOutputSchema,
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
 * `mail.*`（D84）：扩展中心的账号管理。返回值不含授权码。
 */
export function bindMailMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const mail = () => {
    if (services.mail === null) throw new AppError('NOT_IMPLEMENTED', '邮件模块未就绪');
    return services.mail;
  };
  const plugins = () => services.plugins;
  return {
    'mail.accounts.list': method(voidInput, mailAccountsListOutputSchema, async () => ({
      accounts: mail().list(),
    })),
    'mail.accounts.get': method(mailAccountIdInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: mail().get(input.id),
    })),
    'mail.accounts.test': method(mailAccountTestInputSchema, mailAccountTestOutputSchema, async (input) =>
      mail().test(input),
    ),
    'mail.accounts.create': method(mailAccountCreateInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: await mail().create(input),
    })),
    'mail.accounts.update': method(mailAccountUpdateInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: await mail().update(input),
    })),
    'mail.accounts.delete': method(mailAccountIdInputSchema, okOutputSchema, async (input) => {
      mail().delete(input.id);
      return { ok: true as const };
    }),
    'mail.accounts.setBots': method(mailAccountSetBotsInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: mail().setBots(input.id, input.botIds),
    })),
    'mail.bots.setAccounts': method(mailBotSetAccountsInputSchema, okOutputSchema, async (input) => {
      mail().setAccountsForBot(input.botId, input.accountIds);
      return { ok: true as const };
    }),
    'mail.accounts.pause': method(mailAccountIdInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: mail().pause(input.id),
    })),
    'mail.accounts.resume': method(mailAccountIdInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: mail().resume(input.id),
    })),
    'mail.bindings.resume': method(mailBindingResumeInputSchema, mailAccountGetOutputSchema, async (input) => ({
      account: mail().resumeAlerts(input.accountId, input.botId),
    })),
    // 插件贡献的预填模板 overlay（D104 P1-3）：不落库，读注册表清单；插件模块未就绪时为空。
    'mail.providerTemplates.list': method(
      voidInput,
      mailProviderTemplatesListOutputSchema,
      async () => ({ templates: (await plugins()?.mailTemplates()) ?? [] }),
    ),
  };
}
