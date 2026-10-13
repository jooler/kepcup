import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 对话内应用设置的三个工具（todo/conversational-app-setup.md §5.2）：概览 / 检索 → 详情 → 修改
 * 或出卡，逐层披露。对话轮与任务都注册（异步托管动作，D75：写入由宿主确定性执行，不走审批）。
 *
 * 工具本身很薄：目录读取、档位裁定（§5.3，Bot 不能自选）、条目级 CAS 写入、出卡都在宿主
 * `SettingsCatalogHost`（settings/host.ts）里，orchestrator 按 run 绑定好上下文后作为门面传入。
 * 工具名写成字面量（external-agent-engine 测试按 `name: '…'` 核对能力包里的工具名）；
 * 与 shared 的 `SETTINGS_*_TOOL` 常量一致。
 */
export interface SettingsToolFacade {
  /** 无 query：各组一行就绪概况；有 query：≤10 个条目（≤2KB）。 */
  search(query: string | undefined): string;
  /** 一个条目的详情（≤4KB）；未知 id 给最接近的候选（ok:false）。 */
  read(id: string, botId: string | undefined): ToolResult;
  /** 修改或出卡；任务里 required 且需要用户处理时返回 SETUP_REQUIRED（run 随即暂停）。 */
  change(input: {
    id: string;
    values?: Record<string, unknown> | undefined;
    reason: string;
    required?: boolean | undefined;
    botId?: string | undefined;
  }): Promise<ToolResult>;
}

const BOT_ID_DESCRIPTION =
  '只对「这个 Bot 的…」类设置项有意义：默认是你自己；管家可填别的 Bot 的 id';

export function buildSettingsTools(input: { settings: SettingsToolFacade }): ToolDefinition[] {
  const { settings } = input;

  const search: ToolDefinition<{ query?: string }> = {
    name: 'settings_search',
    description:
      '查 KepCup 自身的设置。不带 query：各类设置的就绪概况；带 query（关键词或需求描述，如「生成图片」「读我的邮件」）：最相关的设置项、当前状态与本次可用的修改方式。用户的需求可能要改设置、或你不确定应用现在能不能做时先查这里。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '关键词或需求描述；不填 = 概览' })),
    }),
    execute: async (params) => {
      const query = params.query?.trim();
      return {
        ok: true,
        content: settings.search(query !== undefined && query.length > 0 ? query : undefined),
      };
    },
  };

  const read: ToolDefinition<{ id: string; bot_id?: string }> = {
    name: 'settings_read',
    description:
      '看一个设置项的详情：字段、当前值（已脱敏，密钥只说是否已配置）、可选值，以及本次对话里实际能用的修改方式与原因。id 用 settings_search 返回的；有专门工具的项会告诉你改用哪个工具。',
    parameters: Type.Object({
      id: Type.String({ description: '设置项 id，如 models.default-main' }),
      bot_id: Type.Optional(Type.String({ description: BOT_ID_DESCRIPTION })),
    }),
    execute: async (params) => settings.read(params.id.trim(), params.bot_id?.trim() || undefined),
  };

  const change: ToolDefinition<{
    id: string;
    values?: Record<string, unknown>;
    reason: string;
    required?: boolean;
    bot_id?: string;
  }> = {
    name: 'settings_change',
    description:
      '修改一个设置项，或请用户在卡片里完成。修改方式由应用按设置项和当前情境决定，你不能自选：能直接改的立即生效并留下可撤销的回执卡；其余在对话里出设置卡，用户处理后你会收到通知，届时再接着做。values 只填非敏感字段（键用 settings_read 给的字段名）；密钥、密码与登录永远由用户在卡片里填，不要向用户索要。在任务里，缺了这项设置就做不下去时设 required:true（任务暂停，用户完成后自动续跑）；否则出卡后继续做别的。',
    parameters: Type.Object({
      id: Type.String({ description: '设置项 id' }),
      values: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: '想改成的值（只含非敏感字段），如 {"model":"厂商/模型"}',
        }),
      ),
      reason: Type.String({ description: '一句话理由，会显示在卡片上' }),
      required: Type.Optional(Type.Boolean({ description: '仅任务：没有这项设置任务就做不下去' })),
      bot_id: Type.Optional(Type.String({ description: BOT_ID_DESCRIPTION })),
    }),
    execute: async (params) =>
      settings.change({
        id: params.id.trim(),
        ...(params.values !== undefined ? { values: params.values } : {}),
        reason: params.reason,
        ...(params.required !== undefined ? { required: params.required } : {}),
        ...(params.bot_id !== undefined && params.bot_id.trim().length > 0
          ? { botId: params.bot_id.trim() }
          : {}),
      }),
  };

  return [search, read, change];
}
