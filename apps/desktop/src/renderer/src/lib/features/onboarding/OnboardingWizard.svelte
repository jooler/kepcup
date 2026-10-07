<script lang="ts">
  import type { SandboxStatusOutput, SandboxWslStatusOutput } from '@kepcup/shared';
  import { AppError } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { sandboxWizard } from '$lib/stores/sandbox-wizard.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import AgentCard from '$lib/features/settings/AgentCard.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Bell } from '@lucide/svelte';

  /**
   * P13 任务 4 首次启动引导（docs/dev/phases/P13-release.md 任务 4）：
   * 欢迎/数据位置 → 模型厂商（可跳过，跳过后主界面持续提示；保存 key 时
   * 一并选择默认主模型与默认轻量模型写入 settings——新建 Bot 的
   * runtime.model/light_model 为空即分别回退到它们，主模型不选则首对话报
   * 「未配置模型」）→ 权限（自启/系统通知）→ 沙箱（macOS 自动检测；
   * Windows 复用 P12-B 准备向导，可跳过）→ 认识管家（D70：建立唯一管家并
   * 进入组队访谈，由管家提议 3~5 个领域 Bot；快速单 Bot 仍走侧栏「新建」）。
   * 状态机双向：每一步都可「上一步」。完成状态写既有 settings 行
   * （onboarding.*），无新迁移。
   *
   * 模型步骤的「我有订阅」分支（D72 P4，design 28 §3 / §9.1）：打开实验开关
   * 「外部智能体」→ 列出支持订阅登录的目录 Agent（设置页同一张卡片：条款
   * 提示、启用 = 安装确认、登录、测试连接）→ 选用后写 settings.defaultAgentId
   * ——没有内置模型时，管家与之后新建的 Bot 默认由它驱动。管家的组队访谈
   * 只在内置引擎上跑，订阅分支下管家直接以欢迎语开场（不访谈）。
   */

  type Step = 'welcome' | 'model' | 'permissions' | 'sandbox' | 'bot' | 'done';
  const STEPS: Step[] = ['welcome', 'model', 'permissions', 'sandbox', 'bot'];

  let step = $state<Step>('welcome');

  // --- 模型步骤 ---
  let providerId = $state('');
  let keyDraft = $state('');
  let defaultModel = $state('');
  let lightModel = $state('');
  let lightTouched = $state(false);
  let savingKey = $state(false);
  const providers = $derived(settingsStore.providers);

  // --- 订阅分支（外部智能体） ---
  /** 首次切到外部 Agent 的告知（与 Bot 运行配置的切换弹框同一记录）。 */
  const SWITCH_ACK_KEY = 'kepcup.agentSwitchAcknowledged';
  let modelMode = $state<'key' | 'subscription'>('key');
  let subscriptionLoading = $state(false);
  /** 实验开关已开（本流程确认打开或原本就开），可以列目录。 */
  let subscriptionStarted = $state(false);
  /** 实验开关是本流程打开的（离开订阅分支时关回）。 */
  let experimentalByFlow = false;
  /** 进入订阅分支时已启用的 Agent（离开时据此判断用户是否在分支内启用过）。 */
  let enabledAtStart: string[] = [];
  let chosenAgentId = $state('');
  let savingAgent = $state(false);
  /** 支持订阅登录的目录 Agent（`auth.kinds` 含 subscription）。 */
  const subscriptionAgents = $derived(
    agentsStore.agents.filter((agent) => agent.authKinds.includes('subscription')),
  );
  const chosenAgent = $derived(chosenAgentId.length > 0 ? agentsStore.get(chosenAgentId) : null);
  const agentPathName = $derived(
    agentsStore.get(settingsStore.settings?.defaultAgentId ?? '')?.name ??
      settingsStore.settings?.defaultAgentId ??
      '',
  );

  // --- 权限步骤 ---
  let launchAtLogin = $state(true);

  // --- 沙箱步骤 ---
  let sandboxStatus = $state<SandboxStatusOutput | null>(null);
  let wslStatus = $state<SandboxWslStatusOutput | null>(null);

  // --- 管家步骤（D70） ---
  let creating = $state(false);

  const stepIndex = $derived(STEPS.indexOf(step));

  function goto(next: Step): void {
    step = next;
  }

  function back(): void {
    if (stepIndex > 0) step = STEPS[stepIndex - 1]!;
  }

  // 沙箱检测进入该步时执行一次（macOS 自动检测；Windows 额外查准备状态）。
  $effect(() => {
    if (step !== 'sandbox') return;
    void detectSandbox();
  });

  async function detectSandbox(): Promise<void> {
    try {
      sandboxStatus = (await core.call('sandbox.status', { probe: false })) as SandboxStatusOutput;
    } catch {
      sandboxStatus = null;
    }
    try {
      wslStatus = (await core.call('sandbox.wslStatus')) as SandboxWslStatusOutput;
    } catch {
      wslStatus = null;
    }
  }

  const providerReady = $derived(providers.some((p) => p.hasKey));
  /** 订阅分支已选用 Agent 且没有内置模型：管家不访谈，由 Agent 驱动。 */
  // 与 core 的默认 Agent 解析同一判定（start.ts：defaultAgentId 非空且没有
  // 默认主模型），审查 #8。
  const agentPath = $derived(
    (settingsStore.settings?.defaultAgentId ?? '').length > 0 &&
      (settingsStore.settings?.defaultMainModel ?? '').length === 0,
  );

  /**
   * 默认模型候选（主/轻量同一份）：已存 key 时列全部已配置 key 的厂商（与
   * 设置页/bot 表单同一过滤）；正在录入 key 时列该厂商的模型——key 就在本次
   * 保存，无需等 hasKey 翻转。保存时与 key 一起写入 settings 的
   * defaultMainModel/defaultLightModel，新建 Bot（runtime.model/light_model
   * 为空）即默认使用它们。
   */
  const defaultModelOptions = $derived.by(() => {
    if (providerReady) return settingsStore.availableModelOptions;
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return [];
    return provider.models.map((model) => ({
      ref: `${provider.id}/${model.id}`,
      label: model.name,
    }));
  });

  // 保持两个选择有效（选项集随厂商切换而变）：主模型必须有值——已存设置
  // 有效则回填，否则取第一项；轻量模型允许留空（主模型兼任）——未被用户
  // 改过时同样回填已存设置，改过后仅在其因切换厂商而失效时重置为留空，
  // 不抢用户的显式「留空」。
  $effect(() => {
    const options = defaultModelOptions;
    if (options.length === 0) return;
    if (!options.some((option) => option.ref === defaultModel)) {
      const stored = settingsStore.settings?.defaultMainModel ?? '';
      defaultModel = options.some((option) => option.ref === stored) ? stored : options[0]!.ref;
    }
    if (!lightTouched) {
      if (!options.some((option) => option.ref === lightModel)) {
        const stored = settingsStore.settings?.defaultLightModel ?? '';
        lightModel = options.some((option) => option.ref === stored) ? stored : '';
      }
    } else if (lightModel.length > 0 && !options.some((option) => option.ref === lightModel)) {
      lightModel = '';
    }
  });

  async function saveKey(): Promise<void> {
    if (providerId.length === 0 || keyDraft.length === 0 || defaultModel.length === 0) return;
    savingKey = true;
    try {
      await settingsStore.setKey(providerId, keyDraft);
      keyDraft = '';
      await settingsStore.update({
        defaultMainModel: defaultModel,
        defaultLightModel: lightModel,
        // 走了 API key 路径：此前订阅分支选过的默认 Agent 清掉（审查 #8）。
        ...((settingsStore.settings?.defaultAgentId ?? '').length > 0
          ? { defaultAgentId: '' }
          : {}),
      });
      await persist({ onboarding: { modelConfigured: true } });
      goto('permissions');
    } catch (error) {
      toast.error(
        t('settings.testFailed', {
          reason: error instanceof AppError ? error.code : String((error as Error).message ?? ''),
        }),
      );
    } finally {
      savingKey = false;
    }
  }

  /** providerReady 分支：默认主/轻量模型有改动则保存，随后进入下一步。 */
  async function saveDefaultAndNext(): Promise<void> {
    const settings = settingsStore.settings;
    const patch: {
      defaultMainModel?: string;
      defaultLightModel?: string;
      defaultAgentId?: string;
    } = {};
    if ((settings?.defaultAgentId ?? '').length > 0) patch.defaultAgentId = '';
    if (defaultModel.length > 0 && defaultModel !== (settings?.defaultMainModel ?? '')) {
      patch.defaultMainModel = defaultModel;
    }
    if (lightModel !== (settings?.defaultLightModel ?? '')) {
      patch.defaultLightModel = lightModel;
    }
    if (Object.keys(patch).length > 0) await settingsStore.update(patch);
    goto('permissions');
  }

  /**
   * 「我有订阅」：先只显示说明（含「这是实验功能」）；实验开关已开时直接
   * 加载目录，否则等用户点「开启并继续」才打开（审查 #5）。
   */
  function openSubscription(): void {
    modelMode = 'subscription';
    subscriptionStarted = settingsStore.settings?.experimental.externalAgents === true;
    if (subscriptionStarted) void loadSubscriptionAgents();
  }

  /** 显式确认后打开实验开关；由本流程打开的，返回 API key 时关回。 */
  async function confirmSubscription(): Promise<void> {
    subscriptionLoading = true;
    try {
      await agentsStore.setExperimental(true);
      experimentalByFlow = true;
      subscriptionStarted = true;
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      subscriptionLoading = false;
    }
    if (subscriptionStarted) await loadSubscriptionAgents();
  }

  async function loadSubscriptionAgents(): Promise<void> {
    subscriptionLoading = true;
    try {
      agentsStore.start();
      await agentsStore.refresh();
      enabledAtStart = agentsStore.agents.filter((agent) => agent.enabled).map((agent) => agent.id);
      const current = settingsStore.settings?.defaultAgentId ?? '';
      if (chosenAgentId.length === 0 && current.length > 0) chosenAgentId = current;
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      subscriptionLoading = false;
    }
  }

  /**
   * 回到 API key：本流程打开的实验开关关回去——除非用户已在分支内启用（安装）
   * 了某个 Agent（那是他自己的选择，保留，设置页可见）。
   */
  async function leaveSubscription(): Promise<void> {
    modelMode = 'key';
    subscriptionStarted = false;
    if (!experimentalByFlow) return;
    experimentalByFlow = false;
    const enabledInFlow = agentsStore.agents.some(
      (agent) => agent.enabled && !enabledAtStart.includes(agent.id),
    );
    if (enabledInFlow) return;
    try {
      await agentsStore.setExperimental(false);
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  /** 选用的 Agent 写为新建 Bot（含管家）的默认引擎，进入下一步。 */
  async function saveAgentAndNext(): Promise<void> {
    if (chosenAgent === null || !chosenAgent.enabled) return;
    savingAgent = true;
    try {
      await settingsStore.update({ defaultAgentId: chosenAgent.id });
      // 选用即保留实验开关（不再随返回关回）。
      experimentalByFlow = false;
      await persist({ onboarding: { modelConfigured: true, modelSkipped: false } });
      try {
        localStorage.setItem(SWITCH_ACK_KEY, '1');
      } catch {
        // per-device notice record only
      }
      goto('permissions');
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      savingAgent = false;
    }
  }

  async function skipModel(): Promise<void> {
    await persist({ onboarding: { modelSkipped: true } });
    goto('permissions');
  }

  /** Writes the onboarding patch; steps stay navigable either way. */
  async function persist(patch: {
    onboarding?: { completed?: boolean; modelConfigured?: boolean; modelSkipped?: boolean };
    launchAtLogin?: boolean;
  }): Promise<void> {
    const { onboarding: onboardingPatch, ...rest } = patch;
    if (onboardingPatch !== undefined) {
      await settingsStore.updateOnboarding(onboardingPatch);
    }
    if (Object.keys(rest).length > 0) {
      await settingsStore.update(rest);
    }
  }

  function toggleAutostart(checked: boolean): void {
    launchAtLogin = checked;
    void persist({ launchAtLogin: checked });
  }

  async function finish(): Promise<void> {
    await persist({ onboarding: { completed: true } });
    onboarding.close();
  }

  /**
   * 认识管家（D70）：建立唯一管家并进入组队访谈（问候 + 固定首问卡由 core
   * 确定性下发），随后进入管家私聊。butler.ensure 必须先于 completed 落盘：
   * 否则中途重启时启动补建会建出一个不访谈的管家。
   */
  async function startButler(): Promise<void> {
    creating = true;
    try {
      // 订阅分支：管家由外部 Agent 驱动，组队访谈（内置引擎）不开启。
      const result = (await core.call('butler.ensure', { interview: !agentPath })) as {
        conversationId: string;
      };
      await persist({ onboarding: { completed: true } });
      onboarding.close();
      void chat.select(result.conversationId);
    } catch (error) {
      toast.error(
        t('onboarding.createFailed', {
          reason: error instanceof AppError ? error.code : String((error as Error).message ?? ''),
        }),
      );
    } finally {
      creating = false;
    }
  }
</script>

<div
  class="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-background/95"
  data-testid="onboarding"
  data-step={step}
>
  <div class="w-full max-w-xl rounded-lg border bg-background p-6 shadow-sm">
    <header class="mb-4 flex items-center justify-between">
      <!-- 条件为 false 的 {expr} 在 Svelte 里会把 "false" 渲染成文本，
          不能用 {cond && t(...)} 并列——按 step 取标题键。 -->
      <h2 class="text-base font-medium">{t(`onboarding.${step}Title`)}</h2>
      <Badge variant="outline">{stepIndex + 1} / {STEPS.length}</Badge>
    </header>

    {#if step === 'welcome'}
      <p class="text-sm text-muted-foreground">{t('onboarding.welcomeBody')}</p>
      <p
        class="mt-3 rounded-md bg-muted/50 px-3 py-2 font-mono text-xs break-all"
        data-testid="onboarding-data-dir"
      >
        {t('onboarding.dataDir', { dataDir: core.info?.dataDir ?? '…' })}
      </p>
      <p class="mt-3 text-xs text-muted-foreground">{t('onboarding.localBadges')}</p>
      <footer class="mt-6 flex items-center justify-between">
        <Button
          size="sm"
          variant="ghost"
          onclick={() => void finish()}
          data-testid="onboarding-skip-all"
        >
          {t('onboarding.skipAll')}
        </Button>
        <Button size="sm" onclick={() => goto('model')} data-testid="onboarding-start">
          {t('onboarding.start')}
        </Button>
      </footer>
    {:else if step === 'model' && modelMode === 'subscription'}
      <div data-testid="onboarding-subscription">
        <p class="text-sm text-muted-foreground">{t('onboarding.subscriptionBody')}</p>
        <p class="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {t('onboarding.subscriptionExperimental')}
        </p>
        {#if !subscriptionStarted}
          <Button
            size="sm"
            class="mt-3"
            disabled={subscriptionLoading}
            onclick={() => void confirmSubscription()}
            data-testid="onboarding-subscription-enable"
          >
            {t('onboarding.subscriptionEnable')}
          </Button>
        {:else}
          <div class="mt-3 max-h-[46vh] space-y-3 overflow-y-auto pr-1">
            {#if subscriptionLoading}
              <p class="text-xs text-muted-foreground">{t('setupCard.agentLoading')}</p>
            {:else if subscriptionAgents.length === 0}
              <p class="text-xs text-muted-foreground">{t('onboarding.subscriptionEmpty')}</p>
            {/if}
            {#each subscriptionAgents as agent (agent.id)}
              <div class="space-y-1.5">
                <AgentCard {agent} embedded />
                <label class="flex items-center gap-2 pl-1 text-sm">
                  <input
                    type="radio"
                    name="onboarding-agent"
                    value={agent.id}
                    bind:group={chosenAgentId}
                    data-testid={`onboarding-agent-choose-${agent.id}`}
                  />
                  {t('onboarding.subscriptionChoose', { name: agent.name })}
                </label>
              </div>
            {/each}
          </div>
          {#if chosenAgent !== null}
            <details class="mt-3 text-xs" data-testid="onboarding-agent-notice">
              <summary class="cursor-pointer text-muted-foreground">
                {t('contacts.agentSwitchTitle', { name: chosenAgent.name })}
              </summary>
              <ul class="mt-1.5 space-y-1 text-muted-foreground">
                <li>· {t('contacts.agentSwitchTools')}</li>
                <li>· {t('contacts.agentSwitchReads')}</li>
                <li>· {t('contacts.agentSwitchPrompt')}</li>
                <li>· {t('contacts.agentSwitchFeatures')}</li>
                <li>· {t('contacts.agentSwitchHistory')}</li>
              </ul>
            </details>
            {#if !chosenAgent.enabled}
              <p class="mt-2 text-xs text-muted-foreground">
                {t('onboarding.subscriptionEnableFirst')}
              </p>
            {/if}
          {/if}
        {/if}
      </div>
      <footer class="mt-6 flex items-center justify-between">
        <Button
          size="sm"
          variant="ghost"
          onclick={() => void leaveSubscription()}
          data-testid="onboarding-subscription-back"
        >
          {t('onboarding.subscriptionBack')}
        </Button>
        <Button
          size="sm"
          disabled={savingAgent || chosenAgent === null || !chosenAgent.enabled}
          onclick={() => void saveAgentAndNext()}
          data-testid="onboarding-subscription-save"
        >
          {t('onboarding.modelSave')}
        </Button>
      </footer>
    {:else if step === 'model'}
      <p class="text-sm text-muted-foreground">{t('onboarding.modelBody')}</p>
      {#if !providerReady}
        <Button
          size="sm"
          variant="outline"
          class="mt-3 w-full"
          onclick={openSubscription}
          data-testid="onboarding-subscription-open"
        >
          {t('onboarding.subscriptionOpen')}
        </Button>
      {/if}
      {#if providers.length === 0}
        <p class="mt-3 text-sm text-amber-600">{t('onboarding.modelNoProvider')}</p>
      {:else}
        {#if providerReady}
          <p class="mt-3 text-sm" data-testid="onboarding-model-ready">
            {t('settings.providerKeySet')}
          </p>
        {:else}
          <div class="mt-4 grid gap-3">
            <div class="grid gap-1.5">
              <Label for="onboarding-provider">{t('onboarding.modelProvider')}</Label>
              <select
                id="onboarding-provider"
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                bind:value={providerId}
                data-testid="onboarding-provider-select"
              >
                <option value="">—</option>
                {#each providers as provider (provider.id)}
                  <option value={provider.id}>{provider.name}</option>
                {/each}
              </select>
            </div>
            <div class="grid gap-1.5">
              <Label for="onboarding-key">{t('onboarding.modelKey')}</Label>
              <Input
                id="onboarding-key"
                type="password"
                placeholder={t('onboarding.modelKeyPlaceholder')}
                bind:value={keyDraft}
                data-testid="onboarding-key-input"
              />
            </div>
          </div>
        {/if}
        {#if defaultModelOptions.length > 0}
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div class="grid gap-1.5">
              <Label for="onboarding-default-model">{t('settings.defaultMainModel')}</Label>
              <select
                id="onboarding-default-model"
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                bind:value={defaultModel}
                data-testid="onboarding-default-model"
              >
                {#each defaultModelOptions as option (option.ref)}
                  <option value={option.ref}>{option.label}</option>
                {/each}
              </select>
            </div>
            <div class="grid gap-1.5">
              <Label for="onboarding-light-model">{t('settings.defaultLightModel')}</Label>
              <select
                id="onboarding-light-model"
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                bind:value={lightModel}
                onchange={() => (lightTouched = true)}
                data-testid="onboarding-light-model"
              >
                <option value="">{t('onboarding.modelLightPlaceholder')}</option>
                {#each defaultModelOptions as option (option.ref)}
                  <option value={option.ref}>{option.label}</option>
                {/each}
              </select>
            </div>
          </div>
          <p class="mt-1.5 text-xs text-muted-foreground">{t('onboarding.modelDefaultHint')}</p>
        {/if}
      {/if}
      <footer class="mt-6 flex items-center justify-between">
        <Button size="sm" variant="ghost" onclick={back} data-testid="onboarding-back"
          >{t('onboarding.back')}</Button
        >
        <div class="flex items-center gap-2">
          {#if providerReady}
            <!-- 已配置过 key：本步保存默认主模型（有改动时）后进入下一步；
                换厂商/换 key 在设置页操作。 -->
            <Button
              size="sm"
              onclick={() => void saveDefaultAndNext()}
              data-testid="onboarding-next"
            >
              {t('onboarding.modelSave')}
            </Button>
          {:else}
            <Button
              size="sm"
              variant="outline"
              onclick={() => void skipModel()}
              data-testid="onboarding-model-skip"
            >
              {t('onboarding.modelSkip')}
            </Button>
            <Button
              size="sm"
              disabled={savingKey ||
                providerId.length === 0 ||
                keyDraft.length === 0 ||
                defaultModel.length === 0}
              onclick={() => void saveKey()}
              data-testid="onboarding-model-save"
            >
              {t('onboarding.modelSave')}
            </Button>
          {/if}
        </div>
      </footer>
    {:else if step === 'permissions'}
      <p class="text-sm text-muted-foreground">{t('onboarding.permissionsBody')}</p>
      <div class="mt-4 grid gap-4">
        <label class="flex items-start gap-3">
          <Checkbox
            bind:checked={launchAtLogin}
            onCheckedChange={(checked) => toggleAutostart(checked === true)}
            data-testid="onboarding-autostart"
          />
          <span class="grid gap-0.5">
            <span class="text-sm leading-none font-medium">{t('settings.launchAtLogin')}</span>
            <span class="text-xs text-muted-foreground"
              >{t('onboarding.permissionsAutostartHint')}</span
            >
          </span>
        </label>
        <!-- 系统通知由 macOS 系统设置控制，这里不是开关：用信息图标，
            不要渲染成复选框样式（会被当成可点但点不动的假控件）。 -->
        <div class="flex items-start gap-3">
          <Bell class="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
          <span class="grid flex-1 gap-0.5">
            <span class="text-sm leading-none font-medium">{t('onboarding.permissionsNotify')}</span
            >
            <span class="text-xs text-muted-foreground"
              >{t('onboarding.permissionsNotifyHint')}</span
            >
            <Button
              size="sm"
              variant="outline"
              class="mt-1 w-fit"
              onclick={() =>
                void window.kepcup.sendTestNotification(
                  t('app.title'),
                  t('onboarding.notifyTestBody'),
                )}
              data-testid="onboarding-notify-test"
            >
              {t('onboarding.notifyTest')}
            </Button>
          </span>
        </div>
      </div>
      <footer class="mt-6 flex items-center justify-between">
        <Button size="sm" variant="ghost" onclick={back} data-testid="onboarding-back"
          >{t('onboarding.back')}</Button
        >
        <Button size="sm" onclick={() => goto('sandbox')} data-testid="onboarding-next"
          >{t('onboarding.next')}</Button
        >
      </footer>
    {:else if step === 'sandbox'}
      <p class="text-sm text-muted-foreground">{t('onboarding.sandboxBody')}</p>
      <div class="mt-4 grid gap-2 text-sm" data-testid="onboarding-sandbox-state">
        {#if sandboxStatus !== null}
          <p>
            {t('onboarding.sandboxDetected', {
              backend: sandboxStatus.backend,
              state: sandboxStatus.available
                ? t('settings.sandboxAvailable')
                : t('settings.sandboxUnavailable'),
            })}
          </p>
          {#if sandboxStatus.reason !== undefined && !sandboxStatus.available}
            <p class="text-xs text-muted-foreground">
              {t('diagnostics.reason', { reason: sandboxStatus.reason })}
            </p>
          {/if}
        {/if}
        {#if wslStatus?.applicable}
          <Button
            size="sm"
            variant="outline"
            class="w-fit"
            onclick={() => sandboxWizard.show()}
            data-testid="onboarding-sandbox-wizard"
          >
            {t('onboarding.sandboxWizard')}
          </Button>
        {/if}
      </div>
      <footer class="mt-6 flex items-center justify-between">
        <Button size="sm" variant="ghost" onclick={back} data-testid="onboarding-back"
          >{t('onboarding.back')}</Button
        >
        <Button size="sm" onclick={() => goto('bot')} data-testid="onboarding-next"
          >{t('onboarding.next')}</Button
        >
      </footer>
    {:else if step === 'bot'}
      <p class="text-sm text-muted-foreground">{t('onboarding.botBody')}</p>
      <ul class="mt-4 grid gap-1.5 text-sm" data-testid="onboarding-butler-points">
        {#if !agentPath}
          <li>· {t('onboarding.butlerPoint.team')}</li>
        {/if}
        <li>· {t('onboarding.butlerPoint.route')}</li>
        <li>· {t('onboarding.butlerPoint.quick')}</li>
      </ul>
      {#if agentPath}
        <p class="mt-3 text-xs text-muted-foreground" data-testid="onboarding-butler-agent-note">
          {t('onboarding.butlerAgentNote', { name: agentPathName })}
        </p>
      {/if}
      <footer class="mt-6 flex items-center justify-between">
        <Button size="sm" variant="ghost" onclick={back} data-testid="onboarding-back"
          >{t('onboarding.back')}</Button
        >
        <Button
          size="sm"
          disabled={creating}
          onclick={() => void startButler()}
          data-testid="onboarding-butler-start"
        >
          {t('onboarding.botCreate')}
        </Button>
      </footer>
    {:else}
      <p class="text-sm text-muted-foreground">{t('onboarding.doneBody')}</p>
      <footer class="mt-6 flex justify-end">
        <Button size="sm" onclick={() => void finish()} data-testid="onboarding-finish"
          >{t('onboarding.finish')}</Button
        >
      </footer>
    {/if}
  </div>
</div>
