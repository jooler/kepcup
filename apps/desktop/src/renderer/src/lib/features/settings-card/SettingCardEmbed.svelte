<script lang="ts">
  import type { MailProvider, SettingItem, SettingValues } from '@kepcup/shared';
  import { mailProviderSchema } from '@kepcup/shared';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import ProviderSetupForm from '$lib/features/settings/ProviderSetupForm.svelte';
  import CapabilityModelSection from '$lib/features/settings/CapabilityModelSection.svelte';
  import WebSearchSection from '$lib/features/settings/WebSearchSection.svelte';
  import AgentCard from '$lib/features/settings/AgentCard.svelte';
  import SensorCard from '$lib/features/settings/SensorCard.svelte';
  import MailAccountAddForm from '$lib/features/mail/MailAccountAddForm.svelte';
  import ConnectAppPanel from '$lib/features/apps/ConnectAppPanel.svelte';
  import DefaultModelsCard from './DefaultModelsCard.svelte';
  import BotModelCard from './BotModelCard.svelte';
  import { embeddedAgentId } from './card-components';
  import { capabilityOfItem, prefillString, sensorOfItem } from './setting-card-model';

  /**
   * 设置卡的内嵌组件分发（`CardKey → 设置页组件`，todo/conversational-app-setup.md §4.1）：
   * 与设置页同一个组件、同一批保存服务，统一传 `embedded` / `prefill` / `onSaved`。
   * 调用方先用 `cardEmbeddable` 判过能嵌；`card-components.ts` 登记键 → 组件名（单测核对）。
   *
   * `onSaved` 的含义：组件自己的保存成功了。`default-models` / `bot-model` 自带
   * `settings.items.apply`（带 `expected` / `messageId`，core 直接把卡标 applied）；其余组件走
   * 各自原有的保存服务，宿主随后 `settings.cards.complete` 让 core 核对。
   */
  let {
    item,
    prefill,
    botId,
    expected = null,
    messageId,
    testidPrefix = 'setting-card',
    onSaved,
    onConflict,
  }: {
    item: SettingItem;
    /** 已过滤的非敏感预填（user-only 卡恒为 null）。 */
    prefill: SettingValues | null;
    /** bot 范围条目的作用 Bot（邮箱绑定 / 连接授权 / Bot 模型）。 */
    botId: string | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    testidPrefix?: string;
    onSaved: () => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  const capability = $derived(capabilityOfItem(item.id));
  const sensor = $derived(sensorOfItem(item.id));
  const agentId = $derived(
    embeddedAgentId({
      botId,
      prefill,
      agent: (id) => agentsStore.get(id),
      defaultAgentId: settingsStore.settings?.defaultAgentId ?? null,
    }),
  );
  const agent = $derived(agentId === null ? null : agentsStore.get(agentId));
  const mailProvider = $derived.by((): MailProvider => {
    const parsed = mailProviderSchema.safeParse(prefill?.provider);
    return parsed.success ? parsed.data : 'qq';
  });
  const connectorId = $derived(prefillString(prefill, 'app'));
  const grantBot = $derived.by(() => {
    if (botId === null) return undefined;
    const bot = contacts.bots.find((entry) => entry.id === botId);
    return { id: botId, name: bot !== undefined && bot.name.length > 0 ? bot.name : botId };
  });

  $effect(() => {
    if (item.card !== 'agent') return;
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });
</script>

{#if item.card === 'default-models'}
  <DefaultModelsCard
    itemId={item.id}
    {prefill}
    {expected}
    {messageId}
    testid={`${testidPrefix}-default-models`}
    onSaved={() => onSaved()}
    {onConflict}
  />
{:else if item.card === 'bot-model' && botId !== null}
  <BotModelCard
    itemId={item.id}
    {botId}
    {prefill}
    {expected}
    {messageId}
    testid={`${testidPrefix}-bot-model`}
    onSaved={() => onSaved()}
    {onConflict}
  />
{:else if item.card === 'provider-setup'}
  <ProviderSetupForm
    mode="add"
    target="dashscope"
    embedded
    {prefill}
    testidPrefix={`${testidPrefix}-provider`}
    blockSaveAfterFailedTest
    onSaved={() => onSaved()}
  />
{:else if item.card === 'capability-model' && capability !== null}
  <CapabilityModelSection
    {capability}
    testid={`${testidPrefix}-capability`}
    embedded
    {prefill}
    onSaved={() => onSaved()}
  />
{:else if item.card === 'web-search'}
  <WebSearchSection
    testid={`${testidPrefix}-web-search`}
    embedded
    {prefill}
    onSaved={() => onSaved()}
  />
{:else if item.card === 'agent' && agent !== null}
  <AgentCard {agent} embedded {prefill} onSaved={() => onSaved()} />
{:else if item.card === 'sensor' && sensor !== null}
  <SensorCard kind={sensor} embedded onSaved={() => onSaved()} />
{:else if item.card === 'mail-account' && botId !== null}
  <MailAccountAddForm
    initialProvider={mailProvider}
    bindBotId={botId}
    testidPrefix={`${testidPrefix}-mail`}
    onSaved={() => onSaved()}
  />
{:else if item.card === 'connect-app' && connectorId !== null}
  <ConnectAppPanel
    target={{ kind: 'catalog', connectorId }}
    {grantBot}
    allowDisconnect={false}
    testid={`${testidPrefix}-connect`}
    onSaved={() => onSaved()}
  />
{/if}
