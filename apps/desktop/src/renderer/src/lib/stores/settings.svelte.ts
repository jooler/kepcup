import type {
  AppAuthReason,
  AppFlowLogEntry,
  OAuthClientView,
  McpToolRisksOutput,
  ModelCapability,
  OnboardingStatePatch,
  ProviderInfo,
  SandboxStatusOutput,
  Settings,
  SettingsChangedPayload,
} from '@kepcup/shared';
import { chatModelOptions } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

export interface ModelOption {
  ref: string;
  label: string;
}

/** `mcp.test` 的结果（shared `mcpTestOutputSchema`）。 */
export interface McpTestResult {
  tools: string[];
  missingSecrets: string[];
  /** D73：OAuth server 未连接 / 授权失效时 tools 为空并带原因。 */
  needsAuth?: AppAuthReason;
  message?: string;
  /** D73 P1：测试时看到的工具定义哈希，保存后交给 `apps.tools.approveAfterTest`。 */
  toolHashes?: Record<string, string>;
}

class SettingsState {
  settings = $state<Settings | null>(null);
  providers = $state<ProviderInfo[]>([]);
  sandboxStatus = $state<SandboxStatusOutput | null>(null);
  /**
   * 最近一次 `settings.changed` 的条目（todo/conversational-app-setup.md §4.1「广播」）与序号：
   * 对话内的 link 设置卡据此把自己标成 applied（同一批变化只认一次，见 `changeSeq`）。
   */
  lastChangedItemIds = $state<readonly string[]>([]);
  changeSeq = $state(0);
  #started = false;

  /**
   * 对话模型的选项（仅已配置 key 的厂商；无 key 的模型永远不会应答）。
   * 厂商 / 自定义条目只登记对话模型——其余能力在 capabilityModels 按能力
   * 各自配置，不产生这里的选择项。
   */
  get availableModelOptions(): ModelOption[] {
    // 与 core 的 D88 移交可用模型列表同源（shared chatModelOptions）。
    return chatModelOptions(this.providers);
  }

  /**
   * 订阅 `settings.changed`：条目被写入（设置卡应用、Bot 直改、撤销、设置页保存）后重新拉取
   * 快照——设置页各分区直接读 `settings` / `providers`，打开着的设置弹框随之刷新。
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('settings.changed', (payload) => {
      void this.handleChanged(payload as SettingsChangedPayload);
    });
  }

  /** `settings.changed` 的处理（单测直接调用）：记下变化条目，再刷新快照。 */
  async handleChanged(payload: SettingsChangedPayload): Promise<void> {
    this.lastChangedItemIds = [...payload.itemIds];
    this.changeSeq += 1;
    // 未加载过快照（启动早期）不抢先拉：App 启动流程会整体 refresh。
    if (this.settings === null) return;
    await this.refresh().catch(() => undefined);
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

  /**
   * 保存一份设置补丁。`base` 是补丁出发时的快照（缺省 = 调用这一刻的本地快照）：core 按补丁里的
   * 顶层键与最新设置三方合并——补丁没改的字段保留最新值，所以本地快照过期（Bot 刚直改了默认模型、
   * 设置卡刚写过、别处刚加了 MCP 服务）时，这次保存不会把它们覆盖回去（D89 审查修复）。表单若
   * 持有更早的草稿，应传入它自己出发时的快照。
   */
  async update(patch: Partial<Settings>, base: Settings | null = this.settings): Promise<Settings> {
    // 调用方常直接引用 settings $state 里的嵌套对象（如 customProviders），
    // Svelte 代理无法过 MessagePort 的结构化克隆——统一在此快照成纯对象。
    const plain = $state.snapshot(patch) as Record<string, unknown>;
    const from = base === null ? null : ($state.snapshot(base) as Record<string, unknown>);
    const baseKeys =
      from === null
        ? []
        : Object.keys(plain).filter((key) => Object.hasOwn(from, key) && key !== 'base');
    const next = (await core.call('settings.update', {
      ...plain,
      ...(from !== null && baseKeys.length > 0
        ? { base: Object.fromEntries(baseKeys.map((key) => [key, from[key]])) }
        : {}),
    })) as Settings;
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
   * key 非空时未保存先测（服务端只用入参探测、不落库）；缺省用已存 key。
   */
  async test(
    provider: string,
    model?: string,
    capability?: ModelCapability,
    key?: string,
  ): Promise<void> {
    await core.call('providers.test', {
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(capability !== undefined ? { capability } : {}),
      ...(key !== undefined && key.length > 0 ? { keyOverride: key } : {}),
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
   * D73：显式删除自定义 MCP server——core 一并删除 settings 条目并清理其
   * `mcp:{id}:*` 密钥、令牌与连接行（不再靠 `settings.update` 的整体差集，陈旧
   * 快照会误删，也不会泄漏密钥）。完成后刷新本地快照。
   */
  async removeMcpServer(serverId: string): Promise<void> {
    await core.call('mcp.removeServer', { serverId });
    await this.refresh();
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
  ): Promise<McpTestResult> {
    return core.call('mcp.test', {
      server,
      ...(secretValues !== undefined ? { secretValues } : {}),
    }) as Promise<McpTestResult>;
  }

  /**
   * W5：已保存 server 的工具风险档（设置页逐工具策略）。连接失败时 error 有值，
   * tools 里仍有已配置但当前未列出的工具（missing）。
   */
  async mcpToolRisks(serverId: string): Promise<McpToolRisksOutput> {
    return (await core.call('mcp.toolRisks', { serverId })) as McpToolRisksOutput;
  }

  // --- 连接应用 P2：开发者模式 / BYO OAuth 客户端（D73 §6.4 / §6.6）---------------

  get developerMode(): boolean {
    return this.settings?.apps.developerMode === true;
  }

  async setDeveloperMode(on: boolean): Promise<void> {
    await this.update({ apps: { developerMode: on } } as Partial<Settings>);
  }

  /** 原始工具定义（含 annotations / inputSchema）。 */
  async rawMcpTools(serverId: string): Promise<Array<Record<string, unknown>>> {
    const out = (await core.call('mcp.rawTools', { serverId })) as {
      tools: Array<Record<string, unknown>>;
    };
    return out.tools;
  }

  /** 手动刷新工具：丢弃缓存并重新列出（工具锁定照常生效，新增 / 变化的工具待复核）。 */
  async refreshMcpTools(serverId: string): Promise<Array<Record<string, unknown>>> {
    const out = (await core.call('mcp.refreshTools', { serverId })) as {
      tools: Array<Record<string, unknown>>;
    };
    return out.tools;
  }

  /** 授权流程事件日志（脱敏，进程内）。 */
  async flowLog(serverId: string): Promise<AppFlowLogEntry[]> {
    const out = (await core.call('apps.flowLog', { serverId })) as { entries: AppFlowLogEntry[] };
    return out.entries;
  }

  async listOauthClients(): Promise<OAuthClientView[]> {
    const out = (await core.call('apps.oauthClients.list')) as { clients: OAuthClientView[] };
    return out.clients;
  }

  /** secret 只写不读；调用后调用方应立刻清空输入。 */
  async setOauthClient(input: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<void> {
    await core.call('apps.oauthClients.set', input);
  }

  async removeOauthClient(issuer: string): Promise<void> {
    await core.call('apps.oauthClients.remove', { issuer });
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
