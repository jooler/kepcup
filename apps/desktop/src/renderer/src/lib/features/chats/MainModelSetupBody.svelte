<script lang="ts">
  import type { BotProfile } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import { getChatSession } from './chat-session-context';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import ProviderSetupForm from '$lib/features/settings/ProviderSetupForm.svelte';
  import ModelSelectField from '$lib/features/settings/ModelSelectField.svelte';

  /**
   * 「缺默认主模型」的两段式设置卡（P2 收拢任务 3 从 SetupRequiredCard 原样拆出）：
   * main-model 不是单条目录条目——第一段对应 `models.provider`（没有任何已配置厂商时
   * 内嵌供应商表单，与设置页同一份保存逻辑），保存后才进第二段选默认主模型
   * （`models.default-main`），可顺带用 `bots.update` 写当前 Bot 的模型。
   * 两段切换只认「保存」点击：「测试连接」为完成探测会先落盘 key（providers.test
   * 只读已存 key），availableModelOptions 随之翻转为非空，直接以它派生切段会让测试
   * 失败也自动跳到第二段；故仅在挂载时已配置（readyAtMount）或用户点过保存
   * （savedFromForm）时展示第二段。
   */
  const hasModelOptions = $derived(settingsStore.availableModelOptions.length > 0);
  // 挂载时是否已配置（untrack：故意只取初值，不随后续 key 落盘翻转）。
  const readyAtMount = untrack(() => hasModelOptions);
  let savedFromForm = $state(false);
  const showModelStage = $derived(hasModelOptions && (readyAtMount || savedFromForm));
  const session = getChatSession();
  const currentBot = $derived(session.view?.conversation.bot ?? null);

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
        // base = 写入前的 profile：core 三方合并，只落模型（与占位名回落），不盖回别处刚改的字段。
        const base = $state.snapshot(currentBot.profile) as BotProfile;
        const profile = {
          ...base,
          identity: { ...base.identity, name: identityName },
          runtime: { ...base.runtime, model: botModel },
        } satisfies BotProfile;
        await contacts.update(currentBot.id, profile, base);
      }
      await session.continueAfterSetup();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      confirming = false;
    }
  }
</script>

<div class="space-y-0.5 pr-6" data-ready-at-mount={String(readyAtMount)}>
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
    {#if (currentBot?.profile.runtime.model ?? '').length === 0}
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
