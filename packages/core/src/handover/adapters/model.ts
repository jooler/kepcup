import {
  BUILTIN_AGENT_RUNTIME,
  type AgentPermissionTier,
  type Bot,
  type ChatModelOption,
  type HandoverAction,
} from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId, type HandoverBotWriter } from './common.js';

/**
 * 模型（D88 §3）：复制。key 是取值本身——`model:inherit`（与来源 Bot 当下相同：主模型、
 * 轻量模型与驱动引擎）/ `model:default`（设置里的默认主模型，内置引擎）/ `model:<ref>`
 * （可用模型列表里的 ref，与 Bot 详情模型下拉同源，内置引擎）。盘点只给 `model:inherit`；另两种经 `resolve` 认。
 * 新建目标的模型走提议里的 `new_bot.model`，不用这个条目。
 */

export const MODEL_INHERIT = 'inherit';
export const MODEL_DEFAULT = 'default';

/** 外部智能体的可选性与默认权限档（与 `bots.update` / 新建 Bot 的规则同源）。 */
export interface HandoverAgentPolicy {
  /** null = 可以选用（实验开关打开且在目录中）；否则是不能用的原因。'' 恒可用。 */
  selectable(agentId: string): string | null;
  /** 新用上这个 Agent 时的默认权限档（预览档为 ask）。 */
  defaultPermission(agentId: string): AgentPermissionTier;
}

export interface ModelAdapterDeps {
  bots: HandoverBotWriter;
  /** 可用对话模型（`chatModelOptions(providers.list())`）。 */
  modelOptions(): ChatModelOption[];
  agents: HandoverAgentPolicy;
}

type ModelRuntime = Pick<Bot['profile']['runtime'], 'model' | 'light_model' | 'agent'>;

/**
 * 「与 A 相同」：A 当下的模型配置值——主模型、轻量模型与驱动它的引擎（外部智能体的
 * id / model / effort）。权限档与能力包是接手方自己的设置，不复制：沿用接手方原来的；
 * 接手方原先是内置引擎（或是新建的）时取该 Agent 的目录默认权限档、能力包跟随默认。
 * 这里只复制 Profile 的配置值，不做选取（选取仍走 llm-router）。
 */
export function inheritedModelRuntime(
  from: Bot,
  targetAgent: ModelRuntime['agent'] | null,
  defaultPermission: (agentId: string) => AgentPermissionTier,
): ModelRuntime {
  const source = from.profile.runtime;
  const base =
    targetAgent !== null && targetAgent.id.length > 0
      ? targetAgent
      : {
          ...BUILTIN_AGENT_RUNTIME,
          ...(source.agent.id.length > 0 ? { permission: defaultPermission(source.agent.id) } : {}),
        };
  return {
    model: source.model,
    light_model: source.light_model,
    agent: { ...base, id: source.agent.id, model: source.agent.model, effort: source.agent.effort },
  };
}

/**
 * 新建目标「与 A 相同」时写进新 Bot 的模型配置值。A 的外部智能体现在不能选用时退回内置
 * 引擎（`refusal` 说明原因）；结果是「空模型 + 内置引擎」时 `skipDefaultAgent`：新 Bot 与
 * A 一样跟随设置默认，不套用 onboarding 的默认外部 Agent。
 */
export function newTargetInheritedRuntime(
  from: Bot,
  agents: HandoverAgentPolicy,
): { runtime: Partial<ModelRuntime>; refusal: string | null; skipDefaultAgent: boolean } {
  let runtime: Partial<ModelRuntime> = inheritedModelRuntime(from, null, (id) =>
    agents.defaultPermission(id),
  );
  const agentId = runtime.agent?.id ?? '';
  const refused = agentId.length > 0 ? agents.selectable(agentId) : null;
  if (refused !== null)
    runtime = { model: runtime.model ?? '', light_model: runtime.light_model ?? '' };
  return {
    runtime,
    refusal: refused === null ? null : `${engineLabel(agentId)}现在不能用（${refused}）`,
    skipDefaultAgent: (runtime.model ?? '') === '' && (runtime.agent?.id ?? '') === '',
  };
}

/** 驱动 Bot 的引擎（卡片提示用）。 */
export function engineLabel(agentId: string): string {
  return agentId.length > 0 ? `外部智能体 ${agentId}` : '内置引擎';
}

/** 一个 Bot 当下模型的显示名。 */
export function botModelLabel(bot: Bot, options: readonly ChatModelOption[]): string {
  const runtime = bot.profile.runtime;
  if (runtime.model.length > 0) {
    return options.find((option) => option.ref === runtime.model)?.label ?? runtime.model;
  }
  if (runtime.agent.id.length > 0) return engineLabel(runtime.agent.id);
  return '跟随设置默认';
}

export class ModelAdapter implements HandoverAdapter {
  readonly type = 'model' as const;
  readonly stage = 2;
  readonly #deps: ModelAdapterDeps;

  constructor(deps: ModelAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'model') !== null;
  }

  inventory(botId: string): HandoverEntry[] {
    const bot = this.#deps.bots.get(botId);
    if (bot === null) return [];
    return [
      {
        key: `model:${MODEL_INHERIT}`,
        type: 'model',
        label: botModelLabel(bot, this.#deps.modelOptions()),
        detail: '让对方使用与它相同的模型',
        actions: ['copy'],
        defaultAction: 'copy',
        external: false,
      },
    ];
  }

  resolve(_fromBotId: string, key: string): HandoverEntry | null {
    const value = keyId(key, 'model');
    if (value === null || value.length === 0) return null;
    if (value === MODEL_DEFAULT) {
      return {
        key,
        type: 'model',
        label: '跟随设置默认',
        detail: '',
        actions: ['copy'],
        defaultAction: 'copy',
        external: false,
      };
    }
    const option = this.#deps.modelOptions().find((candidate) => candidate.ref === value);
    if (option === undefined) return null;
    return {
      key,
      type: 'model',
      label: option.label,
      detail: option.ref,
      actions: ['copy'],
      defaultAction: 'copy',
      external: false,
    };
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'copy') return '模型只能复制';
    if (ctx.toBot === null) return '新建目标的模型在 new_bot.model 里指定';
    const value = keyId(key, 'model') ?? '';
    if (value === MODEL_DEFAULT) return null;
    if (value === MODEL_INHERIT) {
      // 同 bots.update：换成另一个外部智能体时它必须可选（实验开关、在目录中）。
      const agentId = ctx.fromBot.profile.runtime.agent.id;
      if (agentId === ctx.toBot.profile.runtime.agent.id) return null;
      const refusal = this.#deps.agents.selectable(agentId);
      return refusal === null ? null : `不能改用${engineLabel(agentId)}：${refusal}`;
    }
    return this.#deps.modelOptions().some((option) => option.ref === value)
      ? null
      : `模型「${value}」已不在可用模型列表里`;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const value = keyId(key, 'model') ?? '';
    const updated = this.#deps.bots.updateProfile(ctx.toBot.id, (profile) => {
      const runtime = { ...profile.runtime };
      if (value === MODEL_INHERIT) {
        Object.assign(
          runtime,
          inheritedModelRuntime(ctx.fromBot, profile.runtime.agent, (id) =>
            this.#deps.agents.defaultPermission(id),
          ),
        );
      } else {
        // 跟随设置默认 / 指定内置模型：都由内置引擎驱动（外部智能体不认这里的 ref，
        // 「设置默认」指设置里的默认主模型）。卡片上对此有提示。
        runtime.model = value === MODEL_DEFAULT ? '' : value;
        if (value === MODEL_DEFAULT) runtime.light_model = '';
        runtime.agent = { ...BUILTIN_AGENT_RUNTIME };
      }
      return { ...profile, runtime };
    });
    return { result: { model: updated.profile.runtime.model } };
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    const value = keyId(entry.key, 'model') ?? '';
    if (value === MODEL_INHERIT) return `${toName} 改用相同的模型（${entry.label}）`;
    if (value === MODEL_DEFAULT) return `${toName} 的模型改为跟随设置默认（内置引擎）`;
    return `${toName} 改用模型 ${entry.label}（内置引擎）`;
  }

  /** 引擎会变的时候在卡上说清楚（内置 ↔ 外部智能体，或换一个外部智能体）。 */
  warnings(ctx: HandoverContext, entry: HandoverEntry): string[] {
    if (ctx.toBot === null) return [];
    const value = keyId(entry.key, 'model') ?? '';
    const current = ctx.toBot.profile.runtime.agent.id;
    const next = value === MODEL_INHERIT ? ctx.fromBot.profile.runtime.agent.id : '';
    if (current === next) return [];
    return [
      `${ctx.toName} 目前由「${engineLabel(current)}」驱动，之后改由「${engineLabel(next)}」驱动`,
    ];
  }
}
