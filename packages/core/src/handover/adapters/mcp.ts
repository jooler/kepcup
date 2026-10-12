import type { Bot, HandoverAction } from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId, type HandoverBotWriter, type RevokeMcp } from './common.js';

/**
 * MCP server（D88 §3）：默认共享，可选移交。只改两侧 `runtime.mcp_server_ids`；server
 * 是全局配置（`settings.mcpServers`），已不存在的不出现在盘点里，全局停用的置灰。移交时
 * A 侧撤除在阶段 5，中断 A 用到它的运行中任务（同 `bots.update`）。
 */

export interface McpAdapterDeps {
  bots: HandoverBotWriter;
  /** 全局 MCP server 列表（`settings.get().mcpServers`）。 */
  servers(): ReadonlyArray<{ id: string; name: string; enabled: boolean }>;
  revoke: RevokeMcp;
}

export class McpAdapter implements HandoverAdapter {
  readonly type = 'mcp' as const;
  readonly stage = 2;
  readonly #deps: McpAdapterDeps;

  constructor(deps: McpAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'mcp') !== null;
  }

  #server(id: string): { id: string; name: string; enabled: boolean } | null {
    return this.#deps.servers().find((server) => server.id === id) ?? null;
  }

  inventory(botId: string): HandoverEntry[] {
    const bot = this.#deps.bots.get(botId);
    if (bot === null) return [];
    const entries: HandoverEntry[] = [];
    for (const id of bot.profile.runtime.mcp_server_ids) {
      const server = this.#server(id);
      if (server === null) continue;
      entries.push({
        key: `mcp:${id}`,
        type: 'mcp',
        label: server.name || id,
        detail: '',
        actions: ['share', 'move'],
        defaultAction: 'share',
        blocked: server.enabled ? undefined : '这个 MCP 服务已在设置里全局停用',
        external: false,
      });
    }
    return entries;
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'share' && action !== 'move') return 'MCP 只能共享或移交';
    const id = keyId(key, 'mcp') ?? '';
    const server = this.#server(id);
    if (server === null) return '这个 MCP 服务已被删除';
    if (!server.enabled) return '这个 MCP 服务已在设置里全局停用';
    if (!ctx.fromBot.profile.runtime.mcp_server_ids.includes(id)) {
      return `${ctx.fromBot.name} 已不再使用这个 MCP 服务`;
    }
    return null;
  }

  async apply(ctx: HandoverContext & { toBot: Bot }, key: string): Promise<Record<string, never>> {
    const id = keyId(key, 'mcp') ?? '';
    this.#deps.bots.updateProfile(ctx.toBot.id, (profile) =>
      profile.runtime.mcp_server_ids.includes(id)
        ? profile
        : {
            ...profile,
            runtime: {
              ...profile.runtime,
              mcp_server_ids: [...profile.runtime.mcp_server_ids, id],
            },
          },
    );
    return {};
  }

  async release(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<Record<string, never>> {
    const id = keyId(key, 'mcp') ?? '';
    const current = this.#deps.bots.get(ctx.fromBot.id);
    if (current === null || !current.profile.runtime.mcp_server_ids.includes(id)) return {};
    this.#deps.bots.updateProfile(ctx.fromBot.id, (profile) => ({
      ...profile,
      runtime: {
        ...profile.runtime,
        mcp_server_ids: profile.runtime.mcp_server_ids.filter((candidate) => candidate !== id),
      },
    }));
    // W3: only a server in the tool surface (app-level enabled) is a revocation.
    if (this.#server(id)?.enabled === true) this.#deps.revoke(id, [ctx.fromBot.id]);
    return {};
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string, action: HandoverAction): boolean {
    const id = keyId(key, 'mcp') ?? '';
    const toHas =
      this.#deps.bots.get(ctx.toBot.id)?.profile.runtime.mcp_server_ids.includes(id) === true;
    if (action === 'share') return toHas;
    return (
      toHas &&
      this.#deps.bots.get(ctx.fromBot.id)?.profile.runtime.mcp_server_ids.includes(id) !== true
    );
  }

  describe(entry: HandoverEntry, action: HandoverAction, toName: string): string {
    return action === 'move'
      ? `把 MCP 服务 ${entry.label} 移交给 ${toName}`
      : `与 ${toName} 共享 MCP 服务 ${entry.label}`;
  }

  warnings(ctx: HandoverContext, _entry: HandoverEntry, action: HandoverAction): string[] {
    return action === 'move' ? [`${ctx.fromBot.name} 正在用它的任务会被中断`] : [];
  }
}
