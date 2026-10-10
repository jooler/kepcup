import type {
  AppConnection,
  AppConnectionStatusPayload,
  AppToolGrantView,
  AppToolView,
  McpToolPolicy,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { appsStore } from '$lib/stores/apps.svelte';

/** `apps.connections.tools` 的一份结果（按连接缓存）。 */
export interface ConnectionToolsView {
  tools: AppToolView[];
  pending: { added: number; changed: number };
}

/**
 * 设置「应用」分区（D73 §5.9）里按连接查看 / 管理的状态：工具清单（锁定状态、策略、
 * 新旧定义）与持续授权，按 connectionId 缓存；连接状态推送（`apps.connection_status`，
 * 含 `tools_changed`）到达时重拉已缓存的清单。连接列表 / 目录本身在 appsStore。
 * 自定义 server 的连接 id 为 `custom:{serverId}`，扩展中心「MCP」/ 开发者模式的 MCP 管理用同一份缓存读
 * 待批准数。
 */
class AppDetailState {
  tools = $state<Record<string, ConnectionToolsView>>({});
  grants = $state<Record<string, AppToolGrantView[]>>({});
  /** 正在拉取工具清单的连接。 */
  loadingTools = $state<Record<string, boolean>>({});
  loadingGrants = $state<Record<string, boolean>>({});
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('apps.connection_status', (payload) => {
      const { connectionId } = payload as AppConnectionStatusPayload;
      if (this.tools[connectionId] !== undefined) {
        void this.loadTools(connectionId).catch(() => undefined);
      }
    });
    // core 重启：缓存可能已过期，下次打开详情时重拉。
    core.onEvent('core.status', (payload) => {
      if ((payload as { status?: string }).status !== 'ready') return;
      this.tools = {};
      this.grants = {};
    });
  }

  toolsFor(connectionId: string): ConnectionToolsView | null {
    return this.tools[connectionId] ?? null;
  }

  grantsFor(connectionId: string): AppToolGrantView[] | null {
    return this.grants[connectionId] ?? null;
  }

  /** 待复核（新增 + 定义变化）的工具数；未加载为 0。 */
  pendingFor(connectionId: string): number {
    const view = this.tools[connectionId];
    return view === undefined ? 0 : view.pending.added + view.pending.changed;
  }

  async loadTools(connectionId: string): Promise<ConnectionToolsView> {
    this.loadingTools = { ...this.loadingTools, [connectionId]: true };
    try {
      const view = (await core.call('apps.connections.tools', {
        connectionId,
      })) as ConnectionToolsView;
      this.tools = { ...this.tools, [connectionId]: view };
      return view;
    } finally {
      const { [connectionId]: _done, ...rest } = this.loadingTools;
      void _done;
      this.loadingTools = rest;
    }
  }

  async loadGrants(connectionId: string): Promise<AppToolGrantView[]> {
    this.loadingGrants = { ...this.loadingGrants, [connectionId]: true };
    try {
      const { grants } = (await core.call('apps.connections.grants', { connectionId })) as {
        grants: AppToolGrantView[];
      };
      this.grants = { ...this.grants, [connectionId]: grants };
      return grants;
    } finally {
      const { [connectionId]: _done, ...rest } = this.loadingGrants;
      void _done;
      this.loadingGrants = rest;
    }
  }

  /** 打开详情时一次拉齐工具与授权。 */
  async load(connectionId: string): Promise<void> {
    await Promise.all([this.loadTools(connectionId), this.loadGrants(connectionId)]);
  }

  /** 断开 / 删除后丢弃缓存。 */
  forget(connectionId: string): void {
    const { [connectionId]: _tools, ...tools } = this.tools;
    void _tools;
    this.tools = tools;
    const { [connectionId]: _grants, ...grants } = this.grants;
    void _grants;
    this.grants = grants;
  }

  /** 逐工具策略（目录连接）；RPC 整体替换策略，空对象 = 清除。成功后重拉清单。 */
  async setToolPolicy(
    connectionId: string,
    toolName: string,
    policy: McpToolPolicy,
  ): Promise<void> {
    await core.call('apps.connections.setToolPolicy', { connectionId, toolName, policy });
    await this.loadTools(connectionId);
  }

  /** 复核通过 `accept` 里的工具；返回实际批准的工具名。 */
  async reviewTools(connectionId: string, accept: string[]): Promise<string[]> {
    const result = (await core.call('apps.connections.reviewTools', {
      connectionId,
      accept,
    })) as { approved: string[] } & ConnectionToolsView;
    this.tools = {
      ...this.tools,
      [connectionId]: { tools: result.tools, pending: result.pending },
    };
    return result.approved;
  }

  async revokeGrant(connectionId: string, grantId: string): Promise<void> {
    await core.call('apps.grants.revoke', { grantId });
    const current = this.grants[connectionId];
    if (current !== undefined) {
      this.grants = {
        ...this.grants,
        [connectionId]: current.filter((grant) => grant.id !== grantId),
      };
    }
  }

  /**
   * 账号名 / 停用开关。core 只推状态，不推 label，所以成功后重拉连接列表让新名字落到
   * appsStore。
   */
  async updateConnection(
    connectionId: string,
    patch: { label?: string; disabled?: boolean },
  ): Promise<AppConnection> {
    const { connection } = (await core.call('apps.connections.update', {
      connectionId,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    })) as { connection: AppConnection };
    await appsStore.refresh().catch(() => undefined);
    return connection;
  }

  /**
   * 自定义 server「测试 → 保存」后批准测试时看到的工具定义（§5.5）：`toolHashes` 来自
   * `mcp.test`。成功后重拉 `custom:{serverId}` 的清单。
   */
  async approveAfterTest(
    serverId: string,
    toolHashes: Record<string, string>,
  ): Promise<{ approved: string[]; pending: { added: number; changed: number } }> {
    const result = (await core.call('apps.tools.approveAfterTest', {
      serverId,
      toolHashes,
    })) as { approved: string[]; pending: { added: number; changed: number } };
    await this.loadTools(`custom:${serverId}`).catch(() => undefined);
    return result;
  }
}

export const appDetailStore = new AppDetailState();
