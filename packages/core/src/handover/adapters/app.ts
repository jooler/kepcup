import type { Bot, HandoverAction } from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId, type HandoverBotWriter, type RevokeMcp } from './common.js';

/**
 * 连接应用（D88 §3）：默认共享，可选移交。只改两侧 `runtime.app_connection_ids`；
 * **不带** `app_tool_grants`（B 首次写操作照常请求授权）。B 同一应用已连接另一个账号 →
 * 不可执行（每 Bot 每 Connector 至多一个连接，同 `bots.ts` 的规则）。移交时 A 侧撤除在
 * 阶段 5，并中断 A 用到该连接的运行中任务（同 `bots.update`）。
 */

export interface AppAdapterDeps {
  bots: HandoverBotWriter;
  /** 连接目录（`AppConnectionStore` 的子集）。 */
  connections: {
    get(connectionId: string): { id: string; connectorId: string; label: string } | null;
  };
  /** 目录应用名（`ConnectedApps.view(id).appName`）；不在目录里 = null（回退到 connector id）。 */
  appName(connectionId: string): string | null;
  revoke: RevokeMcp;
}

export class AppAdapter implements HandoverAdapter {
  readonly type = 'app' as const;
  readonly stage = 2;
  readonly #deps: AppAdapterDeps;

  constructor(deps: AppAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'app') !== null;
  }

  #label(connection: { id: string; connectorId: string; label: string }): string {
    const app = this.#deps.appName(connection.id) ?? connection.connectorId;
    return connection.label.length > 0 ? `${app}（${connection.label}）` : app;
  }

  inventory(botId: string): HandoverEntry[] {
    const bot = this.#deps.bots.get(botId);
    if (bot === null) return [];
    const entries: HandoverEntry[] = [];
    for (const id of bot.profile.runtime.app_connection_ids) {
      const connection = this.#deps.connections.get(id);
      if (connection === null) continue;
      entries.push({
        key: `app:${id}`,
        type: 'app',
        label: this.#label(connection),
        detail: '',
        actions: ['share', 'move'],
        defaultAction: 'share',
        // 账号显示名来自授权服务器 / 用户输入。
        external: true,
      });
    }
    return entries;
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'share' && action !== 'move') return '连接应用只能共享或移交';
    const id = keyId(key, 'app') ?? '';
    const connection = this.#deps.connections.get(id);
    if (connection === null) return '这个连接已被删除';
    if (!ctx.fromBot.profile.runtime.app_connection_ids.includes(id)) {
      return `${ctx.fromBot.name} 已不再使用这个连接`;
    }
    if (ctx.toBot === null) return null;
    const other = ctx.toBot.profile.runtime.app_connection_ids.find(
      (candidate) =>
        candidate !== id &&
        this.#deps.connections.get(candidate)?.connectorId === connection.connectorId,
    );
    if (other !== undefined) {
      const app = this.#deps.appName(id) ?? connection.connectorId;
      return `${ctx.toName} 已连接另一个 ${app} 账号（同一应用只能授权一个账号，需要的话到 ${ctx.toName} 的详情页切换）`;
    }
    return null;
  }

  async apply(ctx: HandoverContext & { toBot: Bot }, key: string): Promise<Record<string, never>> {
    const id = keyId(key, 'app') ?? '';
    this.#deps.bots.updateProfile(ctx.toBot.id, (profile) =>
      profile.runtime.app_connection_ids.includes(id)
        ? profile
        : {
            ...profile,
            runtime: {
              ...profile.runtime,
              app_connection_ids: [...profile.runtime.app_connection_ids, id],
            },
          },
    );
    return {};
  }

  async release(ctx: HandoverContext & { toBot: Bot }, key: string): Promise<{ notes?: string[] }> {
    const id = keyId(key, 'app') ?? '';
    const current = this.#deps.bots.get(ctx.fromBot.id);
    if (current === null || !current.profile.runtime.app_connection_ids.includes(id)) return {};
    this.#deps.bots.updateProfile(ctx.fromBot.id, (profile) => ({
      ...profile,
      runtime: {
        ...profile.runtime,
        app_connection_ids: profile.runtime.app_connection_ids.filter(
          (candidate) => candidate !== id,
        ),
      },
    }));
    // D73: the connection id is the synthetic server id; its tasks are interrupted.
    this.#deps.revoke(id, [ctx.fromBot.id]);
    return {};
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string, action: HandoverAction): boolean {
    const id = keyId(key, 'app') ?? '';
    const to = this.#deps.bots.get(ctx.toBot.id);
    const from = this.#deps.bots.get(ctx.fromBot.id);
    const toHas = to?.profile.runtime.app_connection_ids.includes(id) === true;
    if (action === 'share') return toHas;
    return toHas && from?.profile.runtime.app_connection_ids.includes(id) !== true;
  }

  describe(entry: HandoverEntry, action: HandoverAction, toName: string): string {
    return action === 'move'
      ? `把连接应用 ${entry.label} 移交给 ${toName}`
      : `与 ${toName} 共享连接应用 ${entry.label}`;
  }

  warnings(ctx: HandoverContext, _entry: HandoverEntry, action: HandoverAction): string[] {
    return [
      `不带写授权：${ctx.toName} 第一次用它做写操作时仍会请你确认`,
      ...(action === 'move' ? [`${ctx.fromBot.name} 正在用它的任务会被中断`] : []),
    ];
  }
}
