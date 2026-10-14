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
  import AgentSetupBody from '$lib/features/chats/AgentSetupBody.svelte';
  import ConnectAppSetupBody from '$lib/features/chats/ConnectAppSetupBody.svelte';

  /**
   * 失败续跑卡（D58 SetupRequiredCard）的通用 body 与分发（todo/conversational-app-setup.md
   * §6.2 + P2 收拢）：`kind:'setting'` 与消息流设置卡同一套分发（`SettingCardEmbed`，预填取
   * requirement.prefill）；没有内嵌组件的条目给「在设置中打开」+「已设置好，继续」。完成后走
   * 既有的 `chat.continueAfterSetup`（收起 + `runs.retry`）。`requirement.before` 是出卡时的
   * 当前值：按它定位目标的组件（连接工具策略、MCP 服务）和做条目级 CAS 的组件都从这里拿
   * `expected`。
   *
   * `agent` / `connect-app` 旧 kind（P2 收拢任务 2）在这里分发到各自的别名 body：载荷里比目录
   * 条目多的字段（`agentId`/`reason`/`detail`；`target`/`connectionId`/`scopes`）与随附行为
   * （Agent 的自动续跑基线与实验开关、连接的自定义目标 / 重连 / scope 并集 / 已在别处连好的
   * 一键继续）都由 body 消费，不塞进目录字段，也不再压平成 `kind:'setting'`——通用分发只认
   * `onSaved`，表达不了这些（设计篇 38 §5.3）。
   */
  let {
    requirement,
  }: {
    requirement: Extract<SetupRequirement, { kind: 'setting' | 'agent' | 'connect-app' }>;
  } = $props();

  const setting = $derived(requirement.kind === 'setting' ? requirement : null);
  const item = $derived(setting === null ? null : getSettingItem(setting.itemId));
  const prefill = $derived(
    item === null || setting === null ? null : nonSensitiveValues(item, setting.prefill),
  );
  /** 失败 run 的 Bot（bot 范围条目的作用对象）。 */
  const botId = $derived(
    chat.current?.failedRun?.botId ?? chat.current?.conversation.bot?.id ?? null,
  );
  const embeddable = $derived(
    item !== null &&
      cardEmbeddable(item, {
        botId,
        conversationId: chat.currentId,
        projectId: chat.current?.conversation.projectId ?? null,
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

{#if requirement.kind === 'agent'}
  <!-- 别名 body：agentId / reason / detail 与自动续跑基线、实验开关都由它消费（§5.3） -->
  <AgentSetupBody {requirement} />
{:else if requirement.kind === 'connect-app'}
  <!-- 别名 body：target / connectionId / scopes、重连与候选继续都由它消费（§5.3） -->
  <ConnectAppSetupBody {requirement} />
{:else}
  <div class="space-y-0.5 pr-6">
    <p class="text-sm font-medium" data-testid="setup-card-title">
      {t('settingCard.setupTitle', { title: item?.title ?? setting?.itemId ?? '' })}
    </p>
    <p class="text-xs break-words text-muted-foreground" data-testid="setup-card-setting-reason">
      {setting?.reason}
    </p>
  </div>
  {#if item !== null && embeddable && setting !== null}
    <SettingCardEmbed
      {item}
      {prefill}
      {botId}
      conversationId={chat.currentId}
      projectId={chat.current?.conversation.projectId ?? null}
      expected={setting.before ?? null}
      testidPrefix="setup-card-setting"
      onSaved={proceed}
    />
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
{/if}
