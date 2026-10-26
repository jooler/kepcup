<script lang="ts">
  import { getSettingItem, type SetupRequirement } from '@kepcup/shared';
  import { ExternalLink } from '@lucide/svelte';
  import { settingItemText, t } from '$lib/i18n';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import SettingCardEmbed from './SettingCardEmbed.svelte';
  import { cardEmbeddable } from './card-components';
  import { openSettingDeepLink } from './open-deep-link';
  import { nonSensitiveValues } from './setting-card-model';
  import AgentSetupBody from '$lib/features/chats/AgentSetupBody.svelte';
  import ConnectAppSetupBody from '$lib/features/chats/ConnectAppSetupBody.svelte';
  import MainModelSetupBody from '$lib/features/chats/MainModelSetupBody.svelte';
  import ConfirmLocalConnectorBody from '$lib/features/chats/ConfirmLocalConnectorBody.svelte';
  import { setupAliasOf } from '$lib/features/chats/setup-alias';

  /**
   * 失败续跑卡（D58 SetupRequiredCard）的通用 body 与分发（todo/conversational-app-setup.md
   * §6.2 + P2 收拢，设计篇 38 §5.3）。`kind:'setting'` 与消息流设置卡同一套分发
   * （`SettingCardEmbed`，预填取 requirement.prefill）；没有内嵌组件的条目给「在设置中打开」+
   * 「已设置好，继续」。`mail.account` 在没有当前 Bot 时不嵌入表单，也不给出「已设置好，继续」，
   * 只提示找不到 Bot。完成后走既有的 `chat.continueAfterSetup`（收起 + `runs.retry`）。
   * `requirement.before` 是出卡时的当前值：按它定位目标的组件（连接工具策略、MCP 服务）和做
   * 条目级 CAS 的组件都从这里拿 `expected`。
   *
   * 旧 kind 的处理：
   * - capability-model / web-search / mail-account：`setupAliasOf` 转成 `kind:'setting'`
   *   走同一分发（这三个 kind 总能映射；旧 kind 在契约里保留为兼容别名）。
   * - agent / connect-app：分发到各自的别名 body。载荷里比目录条目多的字段
   *   （`agentId`/`reason`/`detail`；`target`/`connectionId`/`scopes`）与随附行为（Agent 的
   *   自动续跑基线与实验开关、连接的自定义目标 / 重连 / scope 并集 / 已在别处连好的一键继续）
   *   都由 body 消费，不塞进目录字段，也不压平成 `kind:'setting'`——通用分发只认 `onSaved`，
   *   表达不了这些。
   * - main-model 不是单条目录条目：两段式（`models.provider` 供应商表单 → 保存后才选
   *   `models.default-main`，可顺带 `bots.update` 写当前 Bot 的模型；切段只认「保存」），
   *   保留独立 kind（MainModelSetupBody）。放弃时 core 的 `notifySetupDismissed` 对
   *   main-model 不唤醒 Bot（对话轮本就跑不起来，通知只会原样失败并再弹同一张卡）。
   * - confirm-local-connector 不是设置目录条目：payload 是 core 探测生成的确认卡
   *   （proposalId + card），用户点 `apps.localConnectors.confirm` / `reject`，不走
   *   `settings.items.apply`——不并入 SettingCard，保持独立 kind 与独立 body。
   */
  let { requirement }: { requirement: SetupRequirement } = $props();
  const session = getChatSession();

  /** 旧 kind 的兼容别名（capability-model / web-search / mail-account → setting）。 */
  const alias = $derived(setupAliasOf(requirement, t));
  const setting = $derived(alias);
  const item = $derived(setting === null ? null : getSettingItem(setting.itemId));
  const prefill = $derived(
    item === null || setting === null ? null : nonSensitiveValues(item, setting.prefill),
  );
  /** 失败 run 的 Bot（bot 范围条目的作用对象）。 */
  const botId = $derived(
    session.view?.failedRun?.botId ?? session.view?.conversation.bot?.id ?? null,
  );
  const embeddable = $derived(
    item !== null &&
      cardEmbeddable(item, {
        botId,
        conversationId: session.conversationId,
        workdirId: session.view?.conversation.workdirId ?? null,
        prefill,
        agent: (id) => agentsStore.get(id),
        defaultAgentId: settingsStore.settings?.defaultAgentId ?? null,
      }),
  );

  let continued = false;
  function proceed(): void {
    if (continued) return;
    continued = true;
    void session.continueAfterSetup();
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
{:else if requirement.kind === 'main-model'}
  <!-- 两段式：无已配置厂商先嵌供应商表单，保存后才选默认主模型（可顺带写 Bot 模型） -->
  <MainModelSetupBody />
{:else if requirement.kind === 'confirm-local-connector'}
  <!-- 本机连接（设计 29 §17）：Bot 提议添加，core 探测后生成的确认卡，不并入设置卡 -->
  <ConfirmLocalConnectorBody {requirement} />
{:else if setting !== null}
  <div class="space-y-0.5 pr-6">
    <p class="text-sm font-medium" data-testid="setup-card-title">
      {t('settingCard.setupTitle', {
        title: item === null ? setting.itemId : settingItemText(item.id, 'title', item.title),
      })}
    </p>
    <p class="text-xs break-words text-muted-foreground" data-testid="setup-card-setting-reason">
      {setting.reason}
    </p>
  </div>
  {#if item !== null && embeddable}
    <SettingCardEmbed
      {item}
      {prefill}
      {botId}
      conversationId={session.conversationId}
      workdirId={session.view?.conversation.workdirId ?? null}
      expected={setting.before ?? null}
      testidPrefix="setup-card-setting"
      onSaved={proceed}
    />
  {:else if setting.itemId === 'mail.account' && botId === null}
    <!-- 没有 Bot 时不能嵌入邮箱表单，也不能「已设置好，继续」裸续跑。 -->
    <p class="text-xs text-muted-foreground" data-testid="setup-card-mail-no-bot">
      {t('setupCard.mailAccountNoBot')}
    </p>
  {:else}
    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if item !== null}
        <Button
          size="sm"
          variant="outline"
          onclick={() =>
            void openSettingDeepLink(item, botId !== null ? { botId } : {}, session.view?.conversation ?? null)}
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
