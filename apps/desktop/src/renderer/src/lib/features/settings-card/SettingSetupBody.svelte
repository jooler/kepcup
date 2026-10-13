<script lang="ts">
  import { getSettingItem, type SetupRequirement } from '@kepcup/shared';
  import { ExternalLink } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import SettingCardEmbed from './SettingCardEmbed.svelte';
  import { cardEmbeddable } from './card-components';
  import { openSettingDeepLink } from './open-deep-link';
  import { nonSensitiveValues } from './setting-card-model';

  /**
   * 失败续跑卡（D58 SetupRequiredCard）的通用 `setting` kind（todo/conversational-app-setup.md
   * §6.2）：任务里 `settings_change` 带 `required: true` 需要用户处理时出现。与消息流设置卡
   * 同一套分发（`SettingCardEmbed`，预填取 requirement.prefill）；没有内嵌组件的条目给
   * 「在设置中打开」+「已设置好，继续」。完成后走既有的 `chat.continueAfterSetup`（收起 +
   * `runs.retry`）。
   */
  let { requirement }: { requirement: Extract<SetupRequirement, { kind: 'setting' }> } = $props();

  const item = $derived(getSettingItem(requirement.itemId));
  const prefill = $derived(item === null ? null : nonSensitiveValues(item, requirement.prefill));
  /** 失败 run 的 Bot（bot 范围条目的作用对象）。 */
  const botId = $derived(
    chat.current?.failedRun?.botId ?? chat.current?.conversation.bot?.id ?? null,
  );
  const embeddable = $derived(
    item !== null &&
      cardEmbeddable(item, {
        botId,
        prefill,
        agent: (id) => agentsStore.get(id),
        defaultAgentId: settingsStore.settings?.defaultAgentId ?? null,
      }),
  );

  let continued = false;
  function proceed(): void {
    if (continued) return;
    continued = true;
    void chat.continueAfterSetup();
  }

  $effect(() => {
    void requirement;
    continued = false;
  });
</script>

<div class="space-y-0.5 pr-6">
  <p class="text-sm font-medium" data-testid="setup-card-title">
    {t('settingCard.setupTitle', { title: item?.title ?? requirement.itemId })}
  </p>
  <p class="text-xs break-words text-muted-foreground" data-testid="setup-card-setting-reason">
    {requirement.reason}
  </p>
</div>
{#if item !== null && embeddable}
  <SettingCardEmbed {item} {prefill} {botId} testidPrefix="setup-card-setting" onSaved={proceed} />
{:else}
  <div class="flex flex-wrap items-center justify-end gap-2">
    {#if item !== null}
      <Button
        size="sm"
        variant="outline"
        onclick={() => void openSettingDeepLink(item, botId !== null ? { botId } : {})}
        data-testid="setup-card-setting-open"
      >
        <ExternalLink class="size-3.5" aria-hidden="true" />
        {t('settingCard.openSettings')}
      </Button>
    {/if}
    <Button size="sm" onclick={proceed} data-testid="setup-card-setting-continue">
      {t('settingCard.setupContinue')}
    </Button>
  </div>
{/if}
