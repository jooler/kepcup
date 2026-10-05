import type {
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
