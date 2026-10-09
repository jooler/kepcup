import { Type } from '@earendil-works/pi-ai';
import { WATCH_MIN_INTERVAL_SEC, type Watch } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import { untrustedBlock } from '../infra/data-boundary.js';
import { describeWatchLine } from '../watch/service.js';
import { describeCondition } from '../watch/conditions.js';

/**
 * 确定性监看工具（W7，D79）：`watch_create` / `watch_list` / `watch_stop`。
 * 创建监看与定时任务一样是「异步托管动作」（design 30 §2.1）：对话轮与任务
 * 都有这组工具；检查只读、由宿主确定性执行，不需要审批，创建即在对话里出一张
 * 用户可见的监看卡。一个 Bot 只能列出 / 停止自己的监看。
 */
export interface WatchToolFacade {
  create(input: {
    botId: string;
    conversationId: string;
    source: unknown;
    condition: unknown;
    intervalSec: number;
  }): Watch;
  listForBotInConversation(botId: string, conversationId: string): Watch[];
  /** Only the bot's own watch of this conversation is stopped. */
  stopOwn(botId: string, conversationId: string, watchId: string): { ok: boolean; message: string };
}

interface ConditionParams {
  kind: 'changed' | 'contains' | 'not_contains' | 'number_below' | 'number_above';
  text?: string;
  value?: number;
  selector?: string;
}

/** Tool params → the zod condition shape (validated by the service). */
function conditionFromParams(params: ConditionParams): Record<string, unknown> {
  switch (params.kind) {
    case 'contains':
    case 'not_contains':
      return { kind: params.kind, text: params.text };
    case 'number_below':
    case 'number_above':
      return {
        kind: params.kind,
        value: params.value,
        ...(params.selector !== undefined && params.selector.trim().length > 0
          ? { selector: params.selector }
          : {}),
      };
    default:
      return { kind: params.kind };
  }
}

export function buildWatchTools(input: {
  identity: RunIdentity;
  watch: WatchToolFacade;
}): ToolDefinition[] {
  const { identity, watch } = input;
  const requireContext = (): { botId: string; conversationId: string } | null => {
    if (identity.conversationId === null || identity.botId === null) return null;
    return { botId: identity.botId, conversationId: identity.conversationId };
  };
  const noContext = (): { ok: false; content: string; errorCode: string } => ({
    ok: false,
    content: '当前执行没有对话上下文，无法使用监看工具',
    errorCode: 'INVALID_INPUT',
  });

  const create: ToolDefinition<{
    url: string;
    selector?: string;
    condition: ConditionParams;
    interval_minutes: number;
  }> = {
    name: 'watch_create',
    description:
      `盯着一个网页，条件满足时才唤醒你（检查由宿主在后台确定性执行，不花模型调用；用你的浏览器资料，已登录的网站可用）。` +
      `适合「降价了 / 有货了 / 页面更新了告诉我」。条件边沿触发：上次不满足、这次满足才提醒一次；changed 是页面有实质变化（忽略「3 分钟前」之类的相对时间）。` +
      `检查间隔不短于 ${WATCH_MIN_INTERVAL_SEC / 60} 分钟。只访问用户给的网址；内网地址被拦截，本机地址仅在对话绑定了 project 时可访问。创建后对话里会出现监看卡，不需要用户确认。`,
    parameters: Type.Object({
      url: Type.String({ description: '要监看的 http(s) 网址' }),
      selector: Type.Optional(
        Type.String({
          description: '可选：只看页面上这个 CSS 选择器对应元素的文本（默认整页正文）',
        }),
      ),
      condition: Type.Object({
        kind: Type.Union(
          [
            Type.Literal('changed'),
            Type.Literal('contains'),
            Type.Literal('not_contains'),
            Type.Literal('number_below'),
            Type.Literal('number_above'),
          ],
          {
            description:
              'changed=页面有变化；contains=出现某段文字；not_contains=某段文字消失；number_below / number_above=数值（如价格）低于 / 高于 value',
          },
        ),
        text: Type.Optional(Type.String({ description: 'contains / not_contains 的文字' })),
        value: Type.Optional(Type.Number({ description: 'number_below / number_above 的阈值' })),
        selector: Type.Optional(
          Type.String({
            description:
              '数值条件可选：数值所在元素的 CSS 选择器（默认取正文里第一个带货币符号的数，没有则第一个数）',
          }),
        ),
      }),
      interval_minutes: Type.Number({
        description: `检查间隔（分钟），不小于 ${WATCH_MIN_INTERVAL_SEC / 60}`,
      }),
    }),
    execute: async (params) => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      try {
        const created = watch.create({
          botId: ctx.botId,
          conversationId: ctx.conversationId,
          source: {
            kind: 'web_page',
            url: params.url,
            ...(params.selector !== undefined && params.selector.trim().length > 0
              ? { selector: params.selector }
              : {}),
          },
          condition: conditionFromParams(params.condition),
          intervalSec: Math.round(Number(params.interval_minutes) * 60),
        });
        return {
          ok: true,
          content: `已创建网页监看（id：${created.id}）：${describeCondition(created.condition)}，每 ${Math.round(created.intervalSec / 60)} 分钟检查一次，马上做第一次检查。条件满足时你会被唤醒（触发原因 watch）；用户已经在对话里看到监看卡，回复里一句话确认即可。`,
        };
      } catch (error) {
        return {
          ok: false,
          content: `创建监看失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INVALID_INPUT',
        };
      }
    },
  };

  const list: ToolDefinition<Record<string, never>> = {
    name: 'watch_list',
    description: '列出你在当前对话中的网页监看（进行中与已暂停的）。',
    parameters: Type.Object({}),
    execute: async () => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      const rows = watch.listForBotInConversation(ctx.botId, ctx.conversationId);
      if (rows.length === 0) return { ok: true, content: '当前对话没有网页监看。' };
      // URLs / selectors / condition texts come from user or web material.
      return {
        ok: true,
        content: untrustedBlock(rows.map((row) => `- ${describeWatchLine(row)}`).join('\n')),
      };
    },
  };

  const stop: ToolDefinition<{ id: string }> = {
    name: 'watch_stop',
    description: '停止一个网页监看（停止后不再检查）。只能停止你自己创建的监看。',
    parameters: Type.Object({
      id: Type.String({ description: '监看 id（形如 wat_...）' }),
    }),
    execute: async (params) => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      const outcome = watch.stopOwn(ctx.botId, ctx.conversationId, params.id);
      return outcome.ok
        ? { ok: true, content: outcome.message }
        : { ok: false, content: outcome.message, errorCode: 'NOT_FOUND' };
    },
  };

  return [create, list, stop];
}
