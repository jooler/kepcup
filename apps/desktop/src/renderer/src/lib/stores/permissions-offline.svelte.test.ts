import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '@kepcup/shared';

/**
 * T8 离线只读（62.10 §2）的写禁用面：团队来源的审批卡在来源断线时置灰
 * （ApprovalCard 的 approve / deny / allowlist 按钮 disabled=
 * permissions.approvalSourceOffline(id)；横幅与输入坞置灰由 ChatBanners /
 * ChatView 的 teamOffline 分支承担——仓库无 DOM 测试环境，此处对决策逻辑
 * 断言，Svelte 分支断言见组件内 data-testid）。
 */

const h = vi.hoisted(() => ({
  connStatus: 'offline' as 'offline' | 'connected' | 'reconnecting' | 'connecting',
  memberId: 'mbr_a' as string | null,
  storage: new Map<string, string>(),
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    connection: 'connected',
    onEvent: () => () => undefined,
    onConnected: () => () => undefined,
    call: async () => ({ approvals: [], grants: [], mode: { conversationId: 'c1', mode: 'default', available: [] } }),
    callTeam: async () => {
      throw new Error('no team context');
    },
  },
}));

vi.mock('$lib/rpc/connections.svelte', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 测试 mock 的模块类型标注。
  const actual = (await importOriginal()) as typeof import('$lib/rpc/connections.svelte');
  return {
    ...actual,
    connections: {
      sources: () => ['local', 'team:h1'],
      onSourcesChanged: () => () => undefined,
      get: (source: string) =>
        source === 'local'
          ? { status: 'connected', memberId: null }
          : { status: h.connStatus, memberId: h.memberId },
    },
  };
});

vi.stubGlobal('window', { kepcup: { isWeb: false } });
vi.stubGlobal(
  'localStorage',
  {
    getItem: (key: string) => h.storage.get(key) ?? null,
    setItem: (key: string, value: string) => void h.storage.set(key, value),
    removeItem: (key: string) => void h.storage.delete(key),
    clear: () => void h.storage.clear(),
  },
);

const { permissions } = await import('./permissions.svelte');

function approvalFixture(id: string): Approval {
  return {
    id,
    conversationId: 'c1',
    kind: 'command',
    status: 'pending',
    createdAt: 1000,
    payload: { command: 'ls' },
    botId: 'bot1',
    botName: 'X',
    duration: 'once',
  } as unknown as Approval;
}

beforeEach(() => {
  h.connStatus = 'offline';
  h.memberId = 'mbr_a';
  h.storage.clear();
});

describe('审批决定的离线只读置灰（T8）', () => {
  it('团队来源断线 → approvalSourceOffline true；恢复连接 → false', () => {
    permissions.ingestSourceEvent('team:h1', 'approval.created', { approval: approvalFixture('appr_1') });
    expect(permissions.approvalSourceOffline('appr_1')).toBe(true);
    h.connStatus = 'connected';
    expect(permissions.approvalSourceOffline('appr_1')).toBe(false);
    h.connStatus = 'reconnecting';
    expect(permissions.approvalSourceOffline('appr_1')).toBe(true);
  });

  it('本机来源的审批恒可决定（离线只读只作用于团队来源）', () => {
    permissions.ingestSourceEvent('local', 'approval.created', { approval: approvalFixture('appr_2') });
    expect(permissions.approvalSourceOffline('appr_2')).toBe(false);
    // 未知来源按本机兜底（与 decide 的路由兜底一致）。
    expect(permissions.approvalSourceOffline('appr_missing')).toBe(false);
  });
});
