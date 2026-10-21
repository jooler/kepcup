import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agentsStore` 的线上格式：core 与渲染层版本不一致时，`agents.list` /
 * `agent.status` 的载荷可能缺新增的次要字段（契约里 `defaultModel` 是可选的
 * `z.string().default('')`）。store 必须补齐后再进 UI 状态——否则设置页会因
 * 一个 `undefined.length` 整页崩掉。
 */

const { handlers, listPayload } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  listPayload: { experimental: true, agents: [] as unknown[] },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    call: async (method: string) => {
      if (method === 'agents.list') return listPayload;
      return { ok: true };
    },
  },
}));

const { agentsStore } = await import('./agents.svelte');

/** 一个合法的智能体视图（`defaultModel` 由各用例决定要不要带上）。 */
function agentPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fake',
    name: 'Fake Agent',
    version: '1.0.0',
    description: 'desc',
    license: 'MIT',
    icon: '',
    tier: 'preview',
    website: null,
    repository: null,
    authKinds: ['api-key'],
    authNote: 'note',
    apiKeyEnv: 'FAKE_API_KEY',
    termsNoticeKey: null,
    nativeCapabilities: {},
    status: 'available',
    statusDetail: null,
    enabled: false,
    installedVersion: null,
    source: 'managed',
    loadUserConfig: false,
    concurrency: 1,
    hasApiKey: false,
    install: {
      item: 'agent:fake',
      kind: 'none',
      version: '1.0.0',
      sizeBytes: 0,
      source: 'catalog',
      license: 'MIT',
      termsNoticeKey: '',
      prerequisites: [],
    },
    progress: null,
    systemCli: null,
    authMethods: [],
    login: null,
    usedBy: [],
    ...extra,
  };
}

describe('agentsStore 的载荷归一化', () => {
  beforeEach(() => {
    listPayload.agents = [];
    agentsStore.agents = [];
  });

  it('core 载荷缺 defaultModel → 补成空串（不崩 UI）', async () => {
    listPayload.agents = [agentPayload()];
    await agentsStore.refresh();
    expect(agentsStore.agents[0]?.defaultModel).toBe('');
    expect(agentsStore.agents[0]?.name).toBe('Fake Agent');
  });

  it('core 载荷带 defaultModel → 原样保留', async () => {
    listPayload.agents = [agentPayload({ defaultModel: 'smart' })];
    await agentsStore.refresh();
    expect(agentsStore.agents[0]?.defaultModel).toBe('smart');
  });

  it('agent.status 事件缺 defaultModel → 补成空串', () => {
    agentsStore.start();
    handlers.get('agent.status')?.({ agent: agentPayload() });
    expect(agentsStore.get('fake')?.defaultModel).toBe('');
  });
});
