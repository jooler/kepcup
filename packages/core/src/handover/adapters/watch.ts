import {
  WATCH_MAX_PER_BOT,
  type Bot,
  type Conversation,
  type HandoverAction,
  type Watch,
} from '@kepcup/shared';
import { describeCondition } from '../../watch/conditions.js';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId } from './common.js';

/**
 * 网页监看（D88 P1，设计 37 §3）：只能移交，规则同定时任务——A 私聊里的改到 B 的私聊，
 * 群里的留在原群（B 必须是成员，否则不可执行）。行就地改归属（`WatchService.transferTo`，
 * 同一个 id、一个事务）：last_hash / last_quiet_hash / 提醒序号原样保留，B 不会把 A 已经
 * 提醒过的变化再提醒一次；排队中的提醒作业一并改到 B 名下。暂停状态照搬。
 */

export interface WatchAdapterDeps {
  watches: {
    listLiveForBot(botId: string): Watch[];
    get(watchId: string): Watch | null;
    countLiveForBot(botId: string): number;
    transferTo(watchId: string, target: { botId: string; conversationId: string }): Watch;
    profileKeyFor(botId: string): string;
    /** 在这个对话里检查网页时能否访问本机地址（工作目录绑定决定）。 */
    allowsLoopback(conversationId: string): boolean;
  };
  conversations: {
    get(conversationId: string): Conversation | null;
    memberBotIds(conversationId: string): string[];
    /** The bot's direct chat id (opened when missing). */
    directIdFor(botId: string): string;
  };
}

/** 字面上就是本机的网址（localhost / 127.x / ::1 / 0.0.0.0 / *.localhost）。 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export class WatchAdapter implements HandoverAdapter {
  readonly type = 'watch' as const;
  readonly stage = 4;
  readonly #deps: WatchAdapterDeps;

  constructor(deps: WatchAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'watch') !== null;
  }

  #isDirectOf(conversationId: string, botId: string): boolean {
    const conversation = this.#deps.conversations.get(conversationId);
    return conversation?.type === 'direct' && conversation.directBotId === botId;
  }

  #where(row: Watch): string {
    if (this.#isDirectOf(row.conversationId, row.botId)) return '私聊';
    const conversation = this.#deps.conversations.get(row.conversationId);
    return `群「${conversation?.title ?? row.conversationId}」`;
  }

  #entry(row: Watch): HandoverEntry {
    const every = `每 ${Math.max(1, Math.round(row.intervalSec / 60))} 分钟`;
    return {
      key: `watch:${row.id}`,
      type: 'watch',
      label: row.source.url,
      detail: `${describeCondition(row.condition)}，${every}，${this.#where(row)}${
        row.status === 'paused' ? '，已暂停' : ''
      }`,
      actions: ['move'],
      defaultAction: 'move',
      // 网址、条件文字由模型 / 用户写；群名来自用户。
      external: true,
    };
  }

  inventory(botId: string): HandoverEntry[] {
    return this.#deps.watches.listLiveForBot(botId).map((row) => this.#entry(row));
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'move') return '网页监看只能移交';
    const row = this.#deps.watches.get(keyId(key, 'watch') ?? '');
    if (row === null) return '这个监看已被删除';
    if (row.status === 'stopped') return '这个监看已停止';
    if (row.botId !== ctx.fromBot.id) return `这个监看已不属于 ${ctx.fromBot.name}`;
    // 新建目标还没建：一个空白的新 Bot 没有任何监看，只在自己的私聊里。
    if (
      ctx.toBot !== null &&
      this.#deps.watches.countLiveForBot(ctx.toBot.id) >= WATCH_MAX_PER_BOT
    ) {
      return `${ctx.toName} 的监看已达上限（每个 Bot 最多 ${WATCH_MAX_PER_BOT} 个）`;
    }
    if (this.#isDirectOf(row.conversationId, row.botId)) {
      // 私聊的监看会改到 B 的私聊，能否访问本机地址随之改按 B 私聊的工作目录绑定。本机网址在
      // 两边规则不同时不移交（宁可不交，也不让它悄悄变得能 / 不能访问本机）。
      if (isLoopbackUrl(row.source.url) && this.#loopbackDiffers(ctx, row)) {
        return `这个监看看的是本机地址，${ctx.toName} 的私聊对本机地址的访问规则（工作目录绑定）与这边不同，不能移交`;
      }
      return null;
    }
    const conversation = this.#deps.conversations.get(row.conversationId);
    if (conversation === null || conversation.readOnly) return '这个监看所在的对话已不可用';
    const member =
      ctx.toBot !== null &&
      this.#deps.conversations.memberBotIds(row.conversationId).includes(ctx.toBot.id);
    return member ? null : `${ctx.toName} 不在群「${conversation.title ?? conversation.id}」里`;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const watchId = keyId(key, 'watch') ?? '';
    const row = this.#deps.watches.get(watchId);
    if (row === null) throw new Error('这个监看已被删除');
    const conversationId = this.#isDirectOf(row.conversationId, row.botId)
      ? this.#deps.conversations.directIdFor(ctx.toBot.id)
      : row.conversationId;
    const moved = this.#deps.watches.transferTo(watchId, { botId: ctx.toBot.id, conversationId });
    return { result: { watchId: moved.id, conversationId } };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string): boolean {
    const row = this.#deps.watches.get(keyId(key, 'watch') ?? '');
    return row !== null && row.status !== 'stopped' && row.botId === ctx.toBot.id;
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    return `把网页监看 ${entry.label}（${entry.detail}）移交给 ${toName}，接着上次的检查结果继续，不会重复提醒`;
  }

  /** B 私聊（新建目标 = 还没有工作目录绑定）与监看现在所在对话的本机访问规则是否不同。 */
  #loopbackDiffers(ctx: HandoverContext, row: Watch): boolean {
    const here = this.#deps.watches.allowsLoopback(row.conversationId);
    const there =
      ctx.toBot === null
        ? false
        : this.#deps.watches.allowsLoopback(this.#deps.conversations.directIdFor(ctx.toBot.id));
    return here !== there;
  }

  warnings(ctx: HandoverContext, entry: HandoverEntry): string[] {
    const out: string[] = [];
    // 登录态不随移交（§3「不移交」）：两边浏览器资料不同时，要登录的页面在 B 那边需重新登录；
    // 页面内容可能因此不同，所以 B 的第一次检查只重新记基线（WatchService.transferTo）。
    const differs =
      ctx.toBot === null ||
      this.#deps.watches.profileKeyFor(ctx.fromBot.id) !==
        this.#deps.watches.profileKeyFor(ctx.toBot.id);
    if (differs) {
      out.push(
        `之后用 ${ctx.toName} 的浏览器资料检查：需要登录才能看的页面，要在 ${ctx.toName} 那边重新登录；${ctx.toName} 的第一次检查只重新记下页面基线（不会因为换了浏览器资料误报），之后登录前后页面不同时可能提醒一次「页面变化」`,
      );
    }
    const row = this.#deps.watches.get(keyId(entry.key, 'watch') ?? '');
    if (
      row !== null &&
      this.#isDirectOf(row.conversationId, row.botId) &&
      !isLoopbackUrl(row.source.url) &&
      this.#loopbackDiffers(ctx, row)
    ) {
      out.push(`之后能否访问本机地址改按 ${ctx.toName} 私聊的工作目录绑定决定`);
    }
    return out;
  }
}
