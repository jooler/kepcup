import type { Bot, HandoverAction, MailAccount } from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId } from './common.js';

/**
 * 邮箱（D88 §3）：默认移交，可选共享。**先绑 B、再解 A**（不留空窗）；B 的绑定唤醒状态
 * 从零开始。移交时 A 名下排队中的 `mail_alert` 作业（如免打扰停放的）先改投 B，再解 A
 * 的绑定——否则 `runAlertJob` 遇到绑定已不存在的作业会静默丢弃，那些信两边都收不到提醒。
 */

export interface MailAdapterDeps {
  mail: {
    accountsForBot(botId: string): MailAccount[];
    /** 账号当前绑定的 Bot；账号不存在 / 已删除 = null。 */
    boundBotIds(accountId: string): string[] | null;
    addBinding(accountId: string, botId: string): unknown;
    removeBinding(accountId: string, botId: string): unknown;
    retargetPendingAlerts(accountId: string, fromBotId: string, toBotId: string): number;
  };
}

export class MailAdapter implements HandoverAdapter {
  readonly type = 'mail' as const;
  readonly stage = 4;
  readonly #deps: MailAdapterDeps;

  constructor(deps: MailAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'mail') !== null;
  }

  inventory(botId: string): HandoverEntry[] {
    return this.#deps.mail.accountsForBot(botId).map((account) => ({
      key: `mail:${account.id}`,
      type: 'mail' as const,
      label:
        account.label.length > 0 && account.label !== account.address
          ? `${account.label} <${account.address}>`
          : account.address,
      detail: '',
      actions: ['move', 'share'],
      defaultAction: 'move',
      external: true,
    }));
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'move' && action !== 'share') return '邮箱只能移交或共享';
    const bound = this.#deps.mail.boundBotIds(keyId(key, 'mail') ?? '');
    if (bound === null) return '这个邮箱已被删除';
    if (!bound.includes(ctx.fromBot.id)) return `${ctx.fromBot.name} 已不再负责这个邮箱`;
    return null;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
    action: HandoverAction,
  ): Promise<{ result: Record<string, unknown> }> {
    const accountId = keyId(key, 'mail') ?? '';
    // 先绑 B（已绑定则保留原有唤醒状态）……
    this.#deps.mail.addBinding(accountId, ctx.toBot.id);
    if (action !== 'move') return { result: { action } };
    // ……A 名下排队中的提醒改投 B，再解 A。
    const retargeted = this.#deps.mail.retargetPendingAlerts(
      accountId,
      ctx.fromBot.id,
      ctx.toBot.id,
    );
    this.#deps.mail.removeBinding(accountId, ctx.fromBot.id);
    return { result: { action, retargetedAlerts: retargeted } };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string, action: HandoverAction): boolean {
    const bound = this.#deps.mail.boundBotIds(keyId(key, 'mail') ?? '');
    if (bound === null || !bound.includes(ctx.toBot.id)) return false;
    return action === 'share' || !bound.includes(ctx.fromBot.id);
  }

  describe(entry: HandoverEntry, action: HandoverAction, toName: string): string {
    return action === 'move'
      ? `把邮箱 ${entry.label} 移交给 ${toName}（之后新信只提醒 ${toName}）`
      : `与 ${toName} 共享邮箱 ${entry.label}（两边都会收到新信提醒）`;
  }

  warnings(ctx: HandoverContext, _entry: HandoverEntry, action: HandoverAction): string[] {
    return action === 'move'
      ? [`${ctx.fromBot.name} 之后收不到这个邮箱的提醒，也不能再读写它`]
      : [];
  }
}
