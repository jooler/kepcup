import type {
  McpToolRisksOutput,
  ModelCapability,
  OnboardingStatePatch,
  ProviderInfo,
  SandboxStatusOutput,
  Settings,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

export interface ModelOption {
  ref: string;
  label: string;
}

class SettingsState {
  settings = $state<Settings | null>(null);
  providers = $state<ProviderInfo[]>([]);
  sandboxStatus = $state<SandboxStatusOutput | null>(null);
  #started = false;

  /**
   * 对话模型的选项（仅已配置 key 的厂商；无 key 的模型永远不会应答）。
   * 厂商 / 自定义条目只登记对话模型——其余能力在 capabilityModels 按能力
   * 各自配置，不产生这里的选择项。
   */
  get availableModelOptions(): ModelOption[] {
    const options: ModelOption[] = [];
    for (const provider of this.providers) {
      if (!provider.hasKey) continue;
      for (const model of provider.models) {
        options.push({
          ref: `${provider.id}/${model.id}`,
          label: `${provider.name} · ${model.name}`,
        });
      }
    }
    return options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  /**
   * 能力是否已配置（厂商 + 模型 + Key），输入组件语音按钮等入口的预检
   * （docs/design/26-voice-input.md）。settings 快照未加载时放行——core 侧
   * 的 CAPABILITY_NOT_CONFIGURED 错误兜底出设置卡。
   */
  isCapabilityReady(capability: Exclude<ModelCapability, 'chat'>): boolean {
    const settings = this.settings;
    if (!settings) return true;
    const config = settings.capabilityModels[capability];
    if (!config) return false;
    return this.providers.find((provider) => provider.id === config.vendor)?.hasKey ?? false;
  }

  async refresh(): Promise<void> {
    const [settings, providers] = await Promise.all([
      core.call('settings.get') as Promise<Settings>,
      core.call('providers.list') as Promise<{ providers: ProviderInfo[] }>,
    ]);
    this.settings = settings;
    this.providers = providers.providers;
  }

  async refreshSandbox(probe = false): Promise<void> {
    this.sandboxStatus = (await core.call('sandbox.status', { probe })) as SandboxStatusOutput;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    // 调用方常直接引用 settings $state 里的嵌套对象（如 customProviders），
    // Svelte 代理无法过 MessagePort 的结构化克隆——统一在此快照成纯对象。
    const next = (await core.call('settings.update', $state.snapshot(patch))) as Settings;
    this.settings = next;
    return next;
  }

  /**
   * P13 任务 4: partial onboarding patch — merged with the current state on
   * the renderer side so the RPC (which takes a partial patch too) never
   * carries a half-erased wizard state.
   */
  async updateOnboarding(patch: OnboardingStatePatch): Promise<Settings> {
    const base = this.settings?.onboarding ?? {
      completed: false,
      modelConfigured: false,
      modelSkipped: false,
    };
    return this.update({ onboarding: { ...base, ...patch } });
  }

  async setKey(provider: string, key: string): Promise<void> {
    await core.call('providers.setKey', { provider, key });
    await this.refresh();
  }

  async removeKey(provider: string): Promise<void> {
    await core.call('providers.removeKey', { provider });
    await this.refresh();
  }

  /**
   * Resolves through AppError.code on failure (PROVIDER_AUTH_FAILED etc.).
   * capability 缺省 = 对话探测；传入后路由到该能力的接口探测
   * （图片/语音一次最小生成，视频提交即取消，向量一次 embed）。
   */
  async test(provider: string, model?: string, capability?: ModelCapability): Promise<void> {
    await core.call('providers.test', {
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(capability !== undefined ? { capability } : {}),
    });
  }

  // --- 联网检索（docs/design/21-web-search.md） ------------------------------

  async setSearchKey(provider: string, key: string): Promise<void> {
    await core.call('websearch.setKey', { provider, key });
  }

  async removeSearchKey(provider: string): Promise<void> {
    await core.call('websearch.removeKey', { provider });
  }

  // --- MCP（D65）------------------------------------------------------------

  /** MCP 密钥只写不读：值落 secrets 表，settings 里只留占位符。 */
  async setMcpSecret(
    serverId: string,
    kind: 'env' | 'header',
    name: string,
    value: string,
  ): Promise<void> {
    await core.call('mcp.setSecret', { serverId, kind, name, value });
  }

  async removeMcpSecret(serverId: string, kind: 'env' | 'header', name: string): Promise<void> {
    await core.call('mcp.removeSecret', { serverId, kind, name });
  }

  /**
   * MCP server 连接测试（设置页「测试连接」）：连接并列出工具名。
   * secretValues 为表单草稿里新输入、尚未落 secrets 表的密钥值（仅本次测试生效）。
   */
  async testMcp(
    server: {
      id: string;
      name: string;
      transport: 'stdio' | 'http' | 'sse';
      command?: string | undefined;
      args?: string[] | undefined;
      env?: Record<string, string> | undefined;
      url?: string | undefined;
      headers?: Record<string, string> | undefined;
      enabled: boolean;
      autoApprove: boolean;
    },
    secretValues?: { env?: Record<string, string>; header?: Record<string, string> },
  ): Promise<{ tools: string[]; missingSecrets: string[] }> {
    return core.call('mcp.test', {
      server,
      ...(secretValues !== undefined ? { secretValues } : {}),
    }) as Promise<{
      tools: string[];
      missingSecrets: string[];
    }>;
  }

  /**
   * W5：已保存 server 的工具风险档（设置页逐工具策略）。连接失败时 error 有值，
   * tools 里仍有已配置但当前未列出的工具（missing）。
   */
  async mcpToolRisks(serverId: string): Promise<McpToolRisksOutput> {
    return (await core.call('mcp.toolRisks', { serverId })) as McpToolRisksOutput;
  }

  /** 检索供应商连通性测试：入参 key 优先（未保存前先测），失败返回错误说明。 */
  async testSearch(
    provider: string,
    key?: string,
  ): Promise<{ ok: boolean; resultCount?: number; elapsedMs?: number; error: string | null }> {
    return (await core.call('websearch.test', {
      provider,
      ...(key !== undefined && key.length > 0 ? { key } : {}),
    })) as { ok: boolean; resultCount?: number; elapsedMs?: number; error: string | null };
  }
}

export const settingsStore = new SettingsState();
