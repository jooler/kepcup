import {
  BUILTIN_AGENT_RUNTIME,
  type Bot,
  type ChatModelOption,
  type HandoverAction,
} from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId, type HandoverBotWriter } from './common.js';

/**
 * 模型（D88 §3）：复制。key 是取值本身——`model:inherit`（与来源 Bot 当下相同，含轻量模型
 * 与外部智能体设置）/ `model:default`（跟随设置默认）/ `model:<ref>`（可用模型列表里的
 * ref，与 Bot 详情模型下拉同源）。盘点只给 `model:inherit`；另两种经 `resolve` 认。
 * 新建目标的模型走提议里的 `new_bot.model`，不用这个条目。
 */

export const MODEL_INHERIT = 'inherit';
export const MODEL_DEFAULT = 'default';

export interface ModelAdapterDeps {
  bots: HandoverBotWriter;
  /** 可用对话模型（`chatModelOptions(providers.list())`）。 */
  modelOptions(): ChatModelOption[];
}

/** 一个 Bot 当下模型的显示名。 */
export function botModelLabel(bot: Bot, options: readonly ChatModelOption[]): string {
  const runtime = bot.profile.runtime;
  if (runtime.model.length > 0) {
    return options.find((option) => option.ref === runtime.model)?.label ?? runtime.model;
  }
  if (runtime.agent.id.length > 0) return `外部智能体 ${runtime.agent.id}`;
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
    if (value === MODEL_INHERIT || value === MODEL_DEFAULT) return null;
    return this.#deps.modelOptions().some((option) => option.ref === value)
      ? null
      : `模型「${value}」已不在可用模型列表里`;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const value = keyId(key, 'model') ?? '';
    const from = ctx.fromBot.profile.runtime;
    const updated = this.#deps.bots.updateProfile(ctx.toBot.id, (profile) => {
      const runtime = { ...profile.runtime };
      if (value === MODEL_INHERIT) {
        runtime.model = from.model;
        runtime.light_model = from.light_model;
        runtime.agent = { ...from.agent };
      } else if (value === MODEL_DEFAULT) {
        runtime.model = '';
        runtime.light_model = '';
      } else {
        // 指定内置模型：由内置引擎驱动（外部智能体不认这里的 ref）。
        runtime.model = value;
        runtime.agent = { ...BUILTIN_AGENT_RUNTIME };
      }
      return { ...profile, runtime };
    });
    return { result: { model: updated.profile.runtime.model } };
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    const value = keyId(entry.key, 'model') ?? '';
    if (value === MODEL_INHERIT) return `${toName} 改用相同的模型（${entry.label}）`;
    if (value === MODEL_DEFAULT) return `${toName} 的模型改为跟随设置默认`;
    return `${toName} 改用模型 ${entry.label}`;
  }
}
