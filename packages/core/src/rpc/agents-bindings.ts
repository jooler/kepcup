import { z } from 'zod';
import {
  AppError,
  agentIdInputSchema,
  agentOutputSchema,
  agentsAffectingOutputSchema,
  agentsCatalogOutputSchema,
  agentsConfigureInputSchema,
  agentsConfirmInputSchema,
  agentsEnableInputSchema,
  agentsListOutputSchema,
  agentsLoginInputSchema,
  agentsLogoutInputSchema,
  agentsOptionsInputSchema,
  agentsOptionsOutputSchema,
  agentsTestOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { AgentsService } from '../domain/agents.js';
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
 * `agents.*`（D72 P4，docs/design/28-external-agents-acp.md §2.2）：设置页
 * 「智能体」与 Bot 运行配置选择器的后端。业务规则在 `AgentsService`。
 */
export function bindAgentMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const agents = (): AgentsService => {
    if (services.agentsService === null) {
      throw new AppError('NOT_IMPLEMENTED', '智能体模块未就绪');
    }
    return services.agentsService;
  };
  return {
    'agents.catalog': method(voidInput, agentsCatalogOutputSchema, async () => ({
      entries: [...agents().catalog()],
    })),
    'agents.list': method(voidInput, agentsListOutputSchema, async () => agents().list()),
    'agents.enable': method(agentsEnableInputSchema, agentOutputSchema, async (input) => ({
      agent: await agents().enable(input.id, input.source),
    })),
    'agents.disable': method(agentsConfirmInputSchema, agentsAffectingOutputSchema, async (input) =>
      agents().disable(input.id, input.confirm),
    ),
    'agents.uninstall': method(
      agentsConfirmInputSchema,
      agentsAffectingOutputSchema,
      async (input) => agents().uninstall(input.id, input.confirm),
    ),
    'agents.login': method(agentsLoginInputSchema, agentOutputSchema, async (input) => ({
      agent: await agents().login(input),
    })),
    'agents.logout': method(agentsLogoutInputSchema, agentOutputSchema, async (input) => ({
      agent: await agents().logout(input.id),
    })),
    'agents.test': method(agentIdInputSchema, agentsTestOutputSchema, async (input) =>
      agents().test(input.id),
    ),
    'agents.options': method(
      agentsOptionsInputSchema,
      agentsOptionsOutputSchema,
      async (input) => ({
        options: await agents().options(input.id, input.refresh === true),
      }),
    ),
    'agents.configure': method(agentsConfigureInputSchema, agentOutputSchema, async (input) => ({
      agent: agents().configure(input),
    })),
  };
}
