import { agentViewSchema } from '@kepcup/shared';
import type {
  AgentBotRef,
  AgentOptionChoice,
  AgentOptions,
  AgentTestResult,
  AgentView,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';

/**
 * 归一化 core 送来的智能体视图。
 *
 * 契约里 `defaultModel` 等次要字段是可选的（`z.string().default('')`），core
 * 与渲染层版本不一致时载荷可能缺这些字段——直接进 UI 状态会让整页因一个
 * `undefined.length` 崩掉。这里按契约 schema 过一遍补齐默认值；schema 校验
 * 不过（字段确实不认识）时保留原载荷，不吞掉问题。
 */
function normalizeAgent(payload: AgentView): AgentView {
  const parsed = agentViewSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  // schema 校验不过（core 送了不认识的字段）：仍补齐可选字段，别让 UI 崩。
  return { ...payload, defaultModel: payload.defaultModel ?? '' };
}

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
  /** `${agentId}\0${model}` → 该模型下的推理强度选项（模型切换后按需探测）。 */
  efforts = $state<Record<string, AgentOptionChoice[]>>({});
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

  #upsert(agent: AgentView): AgentView {
    const next = normalizeAgent(agent);
    const index = this.agents.findIndex((item) => item.id === next.id);
    if (index === -1) this.agents = [...this.agents, next];
    else this.agents = this.agents.map((item, i) => (i === index ? next : item));
    return next;
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
    this.agents = result.agents.map((agent) => normalizeAgent(agent));
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
    return this.#upsert(agent);
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
    return { applied: result.applied, affectedBots: result.affectedBots };
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
    return { applied: result.applied, affectedBots: result.affectedBots };
  }

  async login(
    id: string,
    input: { methodId?: string; apiKey?: string; input?: string } = {},
  ): Promise<AgentView> {
    const { agent } = (await core.call('agents.login', { id, ...input })) as { agent: AgentView };
    return this.#upsert(agent);
  }

  async logout(id: string): Promise<AgentView> {
    const { agent } = (await core.call('agents.logout', { id })) as { agent: AgentView };
    return this.#upsert(agent);
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

  async loadEfforts(
    id: string,
    model: string,
    refresh = false,
  ): Promise<AgentOptionChoice[]> {
    const key = `${id}\u0000${model}`;
    const cached = this.efforts[key];
    if (!refresh && cached !== undefined) return cached;
    const { efforts } = (await core.call('agents.efforts', {
      id,
      model,
      refresh,
    })) as { efforts: AgentOptionChoice[] };
    this.efforts = { ...this.efforts, [key]: efforts };
    return efforts;
  }

  /**
   * 高级设置（加载个人配置 / 并发上限）：逐 Agent 交给 core 合并写入——不在
   * 渲染端拿可能过期的 settings.agents 整表回写。
   */
  async configure(
    id: string,
    patch: { loadUserConfig?: boolean; concurrency?: number; model?: string },
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
