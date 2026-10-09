<script lang="ts">
  import type { BotProfile, SetupRequirement } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import ProviderSetupForm from '$lib/features/settings/ProviderSetupForm.svelte';
  import CapabilityModelSection from '$lib/features/settings/CapabilityModelSection.svelte';
  import WebSearchSection from '$lib/features/settings/WebSearchSection.svelte';
  import ModelSelectField from '$lib/features/settings/ModelSelectField.svelte';
  import AgentSetupBody from './AgentSetupBody.svelte';
  import ConnectAppSetupBody from './ConnectAppSetupBody.svelte';

  /**
   * 消息列表内的「缺设置」引导卡片（docs/design/18-inline-setup.md）：数据源
   * 是 chat.setupRequirement（发送门禁置起，或失败 run 携带的结构化 setup）。
   * main-model：两段式——无已配置厂商时先内嵌供应商表单（与设置页同一份
   * 保存逻辑），之后选默认主模型（可顺带指定 Bot 模型）确认；capability：
   * 内嵌对应能力模型配置；agent（D72 P4）：内嵌设置页的 Agent 卡片
   * （AgentSetupBody）；connect-app（D73）：内嵌 ConnectAppPanel
   * （ConnectAppSetupBody），连接完成后同一条「收起 + runs.retry」路径。确认 / 保存后 chat.continueAfterSetup() 自动续跑
   * （重试原 run 或冲掉保留的草稿）。
   * 两段切换只认「保存」点击：「测试连接」为完成探测会先落盘 key
   * （providers.test 只读已存 key），availableModelOptions 随之翻转为非空，
   * 直接以它派生切段会让测试失败也自动跳到第二段；故仅在挂载时已配置
   * （readyAtMount）或用户点过保存（savedFromForm）时展示第二段。
   */
  let { requirement }: { requirement: SetupRequirement } = $props();

  const isMainModel = $derived(requirement.kind === 'main-model');
  const capability = $derived(
    requirement.kind === 'capability-model' ? requirement.capability : null,
  );
  const hasModelOptions = $derived(settingsStore.availableModelOptions.length > 0);
  // 挂载时是否已配置（untrack：故意只取初值，不随后续 key 落盘翻转）。
  const readyAtMount = untrack(() => hasModelOptions);
  let savedFromForm = $state(false);
  const showModelStage = $derived(hasModelOptions && (readyAtMount || savedFromForm));
  const currentBot = $derived(chat.current?.conversation.bot ?? null);
  const botModelLocked = $derived(
    (currentBot?.profile.runtime.model ?? '').length > 0 || !isMainModel,
  );

  let defaultMain = $state('');
  let botModel = $state('');
  let confirming = $state(false);

  // 模型选项就绪后默认选中第一项（减少一步操作；用户可改选）。
  $effect(() => {
    const options = settingsStore.availableModelOptions;
    if (defaultMain === '' && options.length > 0) defaultMain = options[0]!.ref;
  });

  /** 供应商表单「保存」成功：用户显式放行，两段式进入第二段（无 toast）。 */
  function providerSaved(): void {
    savedFromForm = true;
  }

  async function confirmMainModel(): Promise<void> {
    if (defaultMain.length === 0 || confirming) return;
    confirming = true;
    try {
      await settingsStore.update({ defaultMainModel: defaultMain });
      if (botModel.length > 0 && currentBot !== null) {
        // profile 取自 chat.current（Svelte 深层代理）：浅拷贝的嵌套对象仍是
        // 代理，必须 $state.snapshot 深快照才能过 MessagePort 的结构化克隆
        //（与 settingsStore.update 内部的处理同理）。
        // bots.update 的输入 schema 要求 name 非空，而对话式新建的访谈期
        // Bot 是「顶层 name 占位、identity.name 空串」的设计——空名时用顶层
        // 占位名回落，不打断访谈期的命名语义（finish_setup 才真正生效）。
        const identityName =
          currentBot.profile.identity.name.trim().length > 0
            ? currentBot.profile.identity.name
            : currentBot.name.trim().length > 0
              ? currentBot.name
              : currentBot.id;
        const profile = $state.snapshot({
          ...currentBot.profile,
          identity: { ...currentBot.profile.identity, name: identityName },
          runtime: { ...currentBot.profile.runtime, model: botModel },
        } satisfies BotProfile);
        await core.call('bots.update', { id: currentBot.id, profile });
      }
      await chat.continueAfterSetup();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      confirming = false;
    }
  }
</script>

<div
  class="relative mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-primary/25 bg-background px-4 py-3.5 shadow-sm"
  data-testid="setup-card"
  data-ready-at-mount={String(readyAtMount)}
>
  <Button
    variant="ghost"
    size="icon"
    class="absolute top-1.5 right-1.5 size-6 text-muted-foreground"
    aria-label={t('setupCard.dismiss')}
    title={t('setupCard.dismiss')}
    onclick={() => chat.dismissSetupCard()}
    data-testid="setup-card-dismiss"
  >
    <X class="size-3.5" aria-hidden="true" />
  </Button>

  {#if requirement.kind === 'agent'}
    <AgentSetupBody {requirement} />
  {:else if requirement.kind === 'connect-app'}
    <ConnectAppSetupBody {requirement} />
  {:else if requirement.kind === 'web-search'}
    <div class="space-y-0.5 pr-6">
      <p class="text-sm font-medium" data-testid="setup-card-title">
        {t('setupCard.webSearchTitle')}
      </p>
      <p class="text-xs text-muted-foreground">{t('setupCard.webSearchHint')}</p>
    </div>
    <WebSearchSection
      testid="setup-card-web-search"
      embedded
      onSaved={() => void chat.continueAfterSetup()}
    />
  {:else if isMainModel}
    <div class="space-y-0.5 pr-6">
      <p class="text-sm font-medium" data-testid="setup-card-title">
        {t('setupCard.mainModelTitle')}
      </p>
      <p class="text-xs text-muted-foreground">{t('setupCard.mainModelHint')}</p>
    </div>
    {#if !showModelStage}
      <!-- 第一段：没有任何已配置厂商——内嵌供应商表单（与设置页同源） -->
      <ProviderSetupForm
        mode="add"
        target="dashscope"
        testidPrefix="setup-card"
        blockSaveAfterFailedTest
        onSaved={providerSaved}
      />
    {:else}
      <!-- 第二段：选默认主模型（+ 可选 Bot 模型）确认 -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="setup-card-default">{t('settings.defaultMainModel')}</Label>
          <ModelSelectField
            bind:value={defaultMain}
            id="setup-card-default"
            testid="setup-card-default-model"
          />
        </div>
        {#if !botModelLocked}
          <div class="grid gap-1.5">
            <Label for="setup-card-bot-model">{t('setupCard.botModelLabel')}</Label>
            <select
              id="setup-card-bot-model"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              bind:value={botModel}
              data-testid="setup-card-bot-model"
            >
              <option value="">{t('setupCard.botModelFollowDefault')}</option>
              {#each settingsStore.availableModelOptions as option (option.ref)}
                <option value={option.ref}>{option.label}</option>
              {/each}
            </select>
          </div>
        {/if}
      </div>
      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={confirming || defaultMain.length === 0}
          onclick={() => void confirmMainModel()}
          data-testid="setup-card-confirm"
        >
          {t('setupCard.confirm')}
        </Button>
      </div>
    {/if}
  {:else if capability !== null}
    <div class="space-y-0.5 pr-6">
      <p class="text-sm font-medium" data-testid="setup-card-title">
        {t('setupCard.capabilityTitle', {
          capability: t(`settings.capabilityTitle.${capability}`),
        })}
      </p>
      <p class="text-xs text-muted-foreground">{t('setupCard.capabilityHint')}</p>
    </div>
    <CapabilityModelSection
      {capability}
      testid="setup-card-capability"
      embedded
      onSaved={() => void chat.continueAfterSetup()}
    />
  {/if}
</div>
