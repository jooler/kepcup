import type { z } from 'zod';
import {
  AppError,
  appsSkillsInstallInputSchema,
  appsSkillsInstallOutputSchema,
  appsSkillsOffersInputSchema,
  appsSkillsOffersOutputSchema,
} from '@kepcup/shared';
import type { AppSkillsOffers } from '../apps/skills-offer.js';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/** `apps.skills.*`（D73 P3 §7.6）：连接应用的随附技能——查询缺口 / 发起安装（走 skill_import 审批）。 */
export function bindAppsSkillsMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const offers = (): AppSkillsOffers => {
    if (services.appSkills === null) {
      throw new AppError('NOT_IMPLEMENTED', '随附技能模块未就绪');
    }
    return services.appSkills;
  };
  return {
    'apps.skills.offers': method(
      appsSkillsOffersInputSchema,
      appsSkillsOffersOutputSchema,
      async (input) => offers().offersFor(input.connectionId),
    ),
    'apps.skills.install': method(
      appsSkillsInstallInputSchema,
      appsSkillsInstallOutputSchema,
      async (input) => offers().install(input),
    ),
  };
}
