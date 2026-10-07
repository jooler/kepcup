import type { AgentBotRef, AgentOptions, AgentTestResult, AgentView } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';

/**
 * 外部智能体（D72，docs/design/28-external-agents-acp.md §2.2 / §3）的客户端
 * 状态：目录 + 本机状态视图（`agents.list`），随 `agent.status` 事件更新；
 * 模型 / 推理强度选项按 Agent 缓存（Bot 运行配置的下拉）。安装与登录在
 * core 后台进行，RPC 立即返回当前视图。
 */
class AgentsState {
  experimental = $state(false);
  agents = $state<AgentView[]>([]);
  options = $state<Record<string, AgentOptions>>({});
  loaded = $state(false);
  #started = false;
  #settingsTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('agent.status', (payload) => {
      this.#upsert((payload as { agent: AgentView }).agent);
      this.#refreshSettingsSoon();
    });
  }

  #upsert(agent: AgentView): void {
    const index = this.agents.findIndex((item) => item.id === agent.id);
    if (index === -1) this.agents = [...this.agents, agent];
    else this.agents = this.agents.map((item, i) => (i === index ? agent : item));
  }

  get(id: string): AgentView | null {
    return this.agents.find((agent) => agent.id === id) ?? null;
  }

  /** Bot 运行配置可选的 Agent：已启用且可用（ready / needs_auth / update_available）。 */
  get selectable(): AgentView[] {
    return this.agents.filter(
      (agent) =>
        agent.enabled &&
        (agent.status === 'ready' ||
          agent.status === 'needs_auth' ||
          agent.status === 'update_available'),
    );
  }

  async refresh(): Promise<void> {
    const result = (await core.call('agents.list')) as {
      experimental: boolean;
      agents: AgentView[];
    };
    this.experimental = result.experimental;
    this.agents = result.agents;
    this.loaded = true;
  }

  async setExperimental(enabled: boolean): Promise<void> {
    await settingsStore.update({ experimental: { externalAgents: enabled } });
    await this.refresh();
  }

  async enable(id: string, source?: 'managed' | 'system'): Promise<AgentView> {
    const { agent } = (await core.call('agents.enable', {
      id,
      ...(source !== undefined ? { source } : {}),
    })) as { agent: AgentView };
    this.#upsert(agent);
    return agent;
  }

  async disable(
    id: string,
    confirm = false,
  ): Promise<{ applied: boolean; affectedBots: AgentBotRef[] }> {
    const result = (await core.call('agents.disable', { id, confirm })) as {
      agent: AgentView;
      affectedBots: AgentBotRef[];
      applied: boolean;
    };
    this.#upsert(result.agent);
    return result;
  }

  async uninstall(
    id: string,
    confirm = false,
  ): Promise<{ applied: boolean; affectedBots: AgentBotRef[] }> {
    const result = (await core.call('agents.uninstall', { id, confirm })) as {
      agent: AgentView;
      affectedBots: AgentBotRef[];
      applied: boolean;
    };
    this.#upsert(result.agent);
    return result;
  }

  async login(
    id: string,
    input: { methodId?: string; apiKey?: string; input?: string } = {},
  ): Promise<AgentView> {
    const { agent } = (await core.call('agents.login', { id, ...input })) as { agent: AgentView };
    this.#upsert(agent);
    return agent;
  }

  async logout(id: string): Promise<AgentView> {
    const { agent } = (await core.call('agents.logout', { id })) as { agent: AgentView };
    this.#upsert(agent);
    return agent;
  }

  async test(id: string): Promise<AgentTestResult> {
    const { agent, result } = (await core.call('agents.test', { id })) as {
      agent: AgentView;
      result: AgentTestResult;
    };
    this.#upsert(agent);
    return result;
  }

  async loadOptions(id: string, refresh = false): Promise<AgentOptions> {
    const { options } = (await core.call('agents.options', { id, refresh })) as {
      options: AgentOptions;
    };
    this.options = { ...this.options, [id]: options };
    return options;
  }

  /**
   * 高级设置（加载个人配置 / 并发上限）：逐 Agent 交给 core 合并写入——不在
   * 渲染端拿可能过期的 settings.agents 整表回写。
   */
  async configure(
    id: string,
    patch: { loadUserConfig?: boolean; concurrency?: number },
  ): Promise<void> {
    const { agent } = (await core.call('agents.configure', { id, ...patch })) as {
      agent: AgentView;
    };
    this.#upsert(agent);
    this.#refreshSettingsSoon();
  }

  /** core 改了 settings.agents（安装完成、启停、来源）：刷新渲染端的 settings 快照。 */
  #refreshSettingsSoon(): void {
    if (this.#settingsTimer !== null) return;
    this.#settingsTimer = setTimeout(() => {
      this.#settingsTimer = null;
      if (settingsStore.settings !== null) void settingsStore.refresh().catch(() => undefined);
    }, 300);
  }
}

export const agentsStore = new AgentsState();
