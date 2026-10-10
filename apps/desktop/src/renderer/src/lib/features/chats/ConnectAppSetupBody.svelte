<script lang="ts">
  import type { Bot, BotProfile, SetupRequirement } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, type MessageKey } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import ConnectAppPanel from '$lib/features/apps/ConnectAppPanel.svelte';
  import {
    botConnectionForConnector,
    continueCandidate,
    panelConnection,
  } from '$lib/features/apps/connect-flow';
  import { profileWithAppConnection } from '$lib/features/bot-panel/bot-apps';

  /**
   * 对话内「连接应用」卡（D73，docs/design/29-connected-apps.md §9，§5.8）：MCP /
   * 应用工具调用遇到未连接 / 授权失效 / 需追加权限（或 Bot 调用
   * `app_request_connection`），run 失败并携带 `setup.kind === 'connect-app'` 时出现。
   * 内嵌设置页同一个 ConnectAppPanel；目录目标时带上发起该 run 的 Bot（「连接后授权
   * 给当前 Bot」默认勾选）；授权完成后走既有「收起 + runs.retry」路径
   * （chat.continueAfterSetup）。授权流程**只在用户点「连接」后**才会打开浏览器——
   * run 内部从不弹浏览器。
   *
   * 群聊多个 Bot 同时请求同一应用：store 按目标键流程，后到的卡片加入同一流程；core 只认
   * 第一个 `apps.connect` 的 `grantBotId`，所以 `done` 后若本卡的 Bot 仍未持有该连接，
   * 这里经 `bots.update` 自行补写 `app_connection_ids`（core 在 `done` 前已推 `bot.updated`，
   * 第一张卡据此判定无需再写）。
   */
  let { requirement }: { requirement: Extract<SetupRequirement, { kind: 'connect-app' }> } =
    $props();

  const REASON_KEYS: Record<typeof requirement.reason, MessageKey> = {
    not_connected: 'apps.setupReason.not_connected',
    expired: 'apps.setupReason.expired',
    scope: 'apps.setupReason.scope',
  };

  $effect(() => {
    contacts.start();
    if (contacts.bots.length === 0) void contacts.refresh().catch(() => undefined);
  });

  const entry = $derived(
    requirement.target.kind === 'catalog'
      ? appsStore.entryFor(requirement.target.connectorId)
      : null,
  );
  const name = $derived.by(() => {
    const target = requirement.target;
    if (target.kind === 'custom') {
      return (
        settingsStore.settings?.mcpServers.find((server) => server.id === target.serverId)?.name ??
        target.serverId
      );
    }
    return entry?.title ?? target.connectorId;
  });

  /** 发起失败 run 的 Bot（群聊取成员，单聊取对话 Bot，兜底通讯录）。 */
  const runBot = $derived.by((): Bot | null => {
    const current = chat.current;
    if (current === null) return null;
    const botId = current.failedRun?.botId ?? current.conversation.bot?.id ?? null;
    if (botId === null) return null;
    return (
      current.members.find((member) => member.bot.id === botId)?.bot ??
      (current.conversation.bot?.id === botId ? current.conversation.bot : null) ??
      contacts.bots.find((bot) => bot.id === botId) ??
      null
    );
  });
  /** 通讯录里的最新 Profile（core 授权后推 `bot.updated`，比会话快照新）。 */
  const liveBot = $derived(
    runBot === null ? null : (contacts.bots.find((bot) => bot.id === runBot.id) ?? runBot),
  );
  const grantBot = $derived.by(() => {
    if (requirement.target.kind !== 'catalog' || liveBot === null) return undefined;
    const current = botConnectionForConnector(
      liveBot.profile.runtime.app_connection_ids,
      appsStore.connections,
      requirement.target.connectorId,
    );
    const replacing = current !== null && current.id !== requirement.connectionId;
    return {
      id: liveBot.id,
      name: liveBot.name.length > 0 ? liveBot.name : liveBot.id,
      ...(replacing ? { currentConnectionIdForApp: current.id } : {}),
    };
  });

  // 重连 / 追加权限针对的具体连接（requirement 指明的那一行；多账号时不是「该应用的第一个」）。
  // 目录目标没指明连接 = 未连接 → 新建账号，面板按未连接呈现。
  const connection = $derived(
    panelConnection(appsStore.connections, requirement.target, requirement.connectionId),
  );
  const reconnectConnectionId = $derived(
    requirement.target.kind === 'catalog' && requirement.reason !== 'not_connected'
      ? requirement.connectionId
      : undefined,
  );
  // 追加授权：scope 取「已授予 ∪ 需追加」的完整集合。
  const scopes = $derived.by(() => {
    const extra = requirement.scopes ?? [];
    if (requirement.reason !== 'scope' || extra.length === 0) return undefined;
    return [...new Set([...(connection?.scopes ?? []), ...extra])];
  });

  /**
   * 不走授权流程就能继续的连接：requirement 指明的行已在别处重连好；或未连接的目录应用在
   * 设置页已有连接好的账号（优先 Bot 已持有的）。后者尚未授权给 Bot 时「继续」要先写
   * Profile（needsGrant），否则 `runs.retry` 又会出同一张卡。无 Bot 可授权时不显示按钮。
   */
  const candidate = $derived(
    continueCandidate(
      appsStore.connections,
      requirement.target,
      requirement.connectionId,
      liveBot?.profile.runtime.app_connection_ids ?? [],
    ),
  );
  const canContinue = $derived(
    candidate !== null &&
      (!candidate.needsGrant || grantBot !== undefined) &&
      !appsStore.hasActiveFlow(requirement.target),
  );
  let continuing = $state(false);

  let continued = false;
  function proceed(): void {
    if (continued) return;
    continued = true;
    void chat.continueAfterSetup();
  }

  /** 「已连接，继续」：需要时先把该账号授权给当前 Bot，再续跑。 */
  async function continueWithExisting(): Promise<void> {
    if (continued || continuing || candidate === null) return;
    continuing = true;
    try {
      if (candidate.needsGrant && grantBot !== undefined) {
        await ensureGrant(candidate.connection.id, grantBot.id);
      }
      proceed();
    } finally {
      continuing = false;
    }
  }

  /** `done` 后的授权兜底（见顶部说明）：失败只提示，不阻断续跑。 */
  async function ensureGrant(connectionId: string | undefined, botId: string): Promise<void> {
    if (connectionId === undefined) return;
    const bot = contacts.bots.find((item) => item.id === botId) ?? liveBot;
    if (bot === null || bot.id !== botId) return;
    if (!appsStore.connections.some((item) => item.id === connectionId)) {
      await appsStore.refresh().catch(() => undefined);
    }
    const next = profileWithAppConnection(
      $state.snapshot(bot.profile) as BotProfile,
      appsStore.connections,
      connectionId,
    );
    if (next === null) return;
    try {
      await contacts.update(bot.id, next);
    } catch (error) {
      toast.error(
        t('apps.card.grantFailed', {
          name: bot.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function onDone(connectionId: string | undefined, grant: { botId: string } | null): void {
    if (grant === null) {
      proceed();
      return;
    }
    void ensureGrant(connectionId, grant.botId).finally(proceed);
  }

  // 新的 requirement（续跑后又一次失败）：允许再次自动续跑。
  $effect(() => {
    void requirement;
    continued = false;
  });
</script>

<div class="space-y-0.5 pr-6">
  <p class="text-sm font-medium" data-testid="setup-card-title">
    {t('apps.setupTitle', { name })}
  </p>
  <p class="text-xs text-muted-foreground">{t(REASON_KEYS[requirement.reason])}</p>
</div>
<ConnectAppPanel
  target={requirement.target}
  {scopes}
  {name}
  {grantBot}
  {reconnectConnectionId}
  allowDisconnect={false}
  testid="setup-card-connect"
  {onDone}
/>
{#if canContinue && candidate !== null}
  <!-- 已在别处连接好（或该应用已有可授权的账号）：手动继续；需要时先授权给当前 Bot -->
  <div class="flex justify-end">
    <Button
      size="sm"
      disabled={continuing}
      onclick={() => void continueWithExisting()}
      data-testid="setup-card-connect-continue"
      data-grant={candidate.needsGrant}
    >
      {candidate.needsGrant
        ? t('apps.setupGrantContinue', {
            label:
              candidate.connection.label.length > 0
                ? candidate.connection.label
                : candidate.connection.id,
            name: grantBot?.name ?? '',
          })
        : t('apps.setupConnectedContinue')}
    </Button>
  </div>
{/if}
