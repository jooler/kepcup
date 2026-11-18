<script lang="ts">
  import type { SandboxStatusOutput, SandboxWslStatusOutput } from '@kepcup/shared';
  import { AppError } from '@kepcup/shared';
  import { i18n, localeOptions, sandboxReasonText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { sandboxWizard } from '$lib/stores/sandbox-wizard.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Bell } from '@lucide/svelte';

  /**
   * P13 任务 4 首次启动引导（docs/dev/phases/P13-release.md 任务 4）：
   * 欢迎/数据位置 → 模型厂商（必须配置：保存 key 时一并选择默认主模型与默认
   * 轻量模型写入 settings——新建 Bot 的 runtime.model/light_model 为空即分别
   * 回退到它们）→ 权限（自启/系统通知）→ 沙箱（macOS 自动检测；
   * Windows 复用 P12-B 准备向导，可跳过）→ 认识管家（D70：建立唯一管家并
   * 进入组队访谈，由管家提议 3~5 个领域 Bot；快速单 Bot 仍走侧栏「新建」）。
   * 状态机双向：每一步都可「上一步」。完成状态写既有 settings 行
   * （onboarding.*），无新迁移。
   *
   * 外部智能体（D72）不在向导里配置：任务执行引擎由用户此后在设置页自己开
   * 启（2026-11 修订，design 28 §3）。
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

  // --- 权限步骤 ---
  let launchAtLogin = $state(true);

  // --- 沙箱步骤 ---
  let sandboxStatus = $state<SandboxStatusOutput | null>(null);
  let wslStatus = $state<SandboxWslStatusOutput | null>(null);

  // --- 管家步骤（D70） ---
  let creating = $state(false);

  // --- 推荐插件（P2 注入模型）：末步多选，默认全不选；写管家的 plugin_ids ---
  $effect(() => {
    if (step !== 'bot') return;
    plugins.start();
    void plugins.load().catch(() => undefined);
  });
  let chosenPluginIds = $state<string[]>([]);

  function toggleWizardPlugin(pluginId: string, checked: boolean): void {
    chosenPluginIds = checked
      ? [...chosenPluginIds.filter((id) => id !== pluginId), pluginId]
      : chosenPluginIds.filter((id) => id !== pluginId);
  }

  function openPluginStore(): void {
    shell.openExtensionCenter('market');
  }

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
    } = {};
    if (defaultModel.length > 0 && defaultModel !== (settings?.defaultMainModel ?? '')) {
      patch.defaultMainModel = defaultModel;
    }
    if (lightModel !== (settings?.defaultLightModel ?? '')) {
      patch.defaultLightModel = lightModel;
    }
    if (Object.keys(patch).length > 0) await settingsStore.update(patch);
    goto('permissions');
  }

  /** Writes the onboarding patch; steps stay navigable either way. */
  async function persist(patch: {
    onboarding?: { completed?: boolean; modelConfigured?: boolean };
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

  /** 桌面语义控件（自启 / 系统通知）在 web 端点置灰（审查 P3）：垫片是空实现，可点但不做任何事，比假按钮诚实的做法是禁用。 */
  const isDesktop = ENDPOINT_KIND === 'desktop';

  async function finish(): Promise<void> {
    // 跳过路径也先建管家（无访谈）：headless 7×24 常驻不等「下次重启」的启动
    // 兜底（审查 P2——server 可能几周不重启）；ensure 幂等，桌面端只是把兜底
    // 提前。失败不阻塞完成：下次启动的 core 兜底仍会补建。
    try {
      await core.call('butler.ensure', { interview: false });
    } catch {
      // 补建失败留给启动兜底；跳过流程本身不应被卡住。
    }
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
      // 先把语言同步给 core：管家 Profile、问候语与访谈提示词都按它生成。
      await settingsStore.update({
        appLanguage: i18n.locale === 'en-US' ? 'en-US' : 'zh-CN',
      });
      // 组队访谈恒在内置引擎上跑（外部智能体只驱动任务，2026-11 修订）。
      const result = (await core.call('butler.ensure', { interview: true })) as {
        bot: { id: string };
        conversationId: string;
      };
      // 末步勾选的推荐插件：写入管家的启用集（显式添加制，默认不启用任何插件）。
      // 失败不阻塞完成：管家已建好，插件可在其详情里随时启用。
      if (chosenPluginIds.length > 0) {
        try {
          await core.call('plugins.setBotPlugins', {
            botId: result.bot.id,
            pluginIds: chosenPluginIds,
          });
        } catch {
          // 留给管家详情的「插件」区块补启。
        }
      }
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

<!-- data-window-overlay:接入全局弹层拖拽带(window-drag-band.ts),向导开着时窗口仍可拖;
     卡片垂直居中,不会伸进顶部 40px 拖拽带。 -->
<div
  class="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-background/95"
  data-testid="onboarding"
  data-window-overlay
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
      <div
        class="mt-4 flex items-center justify-between gap-4 rounded-xl border px-3.5 py-3"
        data-testid="onboarding-language"
      >
        <div class="min-w-0">
          <p class="text-sm">{t('onboarding.language')}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{t('onboarding.languageHint')}</p>
        </div>
        <select
          class="h-9 w-40 shrink-0 rounded-md border border-input bg-background px-2 text-sm"
          value={i18n.locale}
          onchange={(event) => (i18n.locale = event.currentTarget.value)}
          aria-label={t('onboarding.language')}
        >
          {#each localeOptions as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </select>
      </div>
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
    {:else if step === 'model'}
      <p class="text-sm text-muted-foreground">{t('onboarding.modelBody')}</p>
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
            disabled={!isDesktop}
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
              disabled={!isDesktop}
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
              {t('diagnostics.reason', {
                reason: sandboxReasonText(sandboxStatus.reason) ?? sandboxStatus.reason,
              })}
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
        <li>· {t('onboarding.butlerPoint.team')}</li>
        <li>· {t('onboarding.butlerPoint.route')}</li>
        <li>· {t('onboarding.butlerPoint.quick')}</li>
      </ul>
      <!-- P2 注入模型：推荐插件多选（默认全不选；无已装插件时给商店引导）。 -->
      <div class="mt-4 grid gap-1.5" data-testid="onboarding-plugins">
        <p class="text-sm font-medium">{t('onboarding.pluginsTitle')}</p>
        <p class="text-xs text-muted-foreground">{t('onboarding.pluginsHint')}</p>
        {#if plugins.plugins.length === 0}
          <div class="flex items-center gap-2">
            <p class="text-xs text-muted-foreground" data-testid="onboarding-plugins-empty">
              {t('onboarding.pluginsEmpty')}
            </p>
            <Button
              size="sm"
              variant="ghost"
              class="h-7 px-2 text-xs"
              onclick={openPluginStore}
              data-testid="onboarding-plugins-open-store"
            >
              {t('onboarding.pluginsOpenStore')}
            </Button>
          </div>
        {:else}
          <div class="max-h-40 space-y-1 overflow-y-auto" data-testid="onboarding-plugins-list">
            {#each plugins.plugins as plugin (plugin.id)}
              <label class="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={chosenPluginIds.includes(plugin.id)}
                  onCheckedChange={(checked) => toggleWizardPlugin(plugin.id, checked === true)}
                  data-testid={`onboarding-plugin-${plugin.id}`}
                />
                <span class="truncate">{plugin.name}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
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
