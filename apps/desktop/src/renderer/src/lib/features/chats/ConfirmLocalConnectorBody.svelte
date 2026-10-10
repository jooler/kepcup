<script lang="ts">
  import type { SetupRequirement } from '@kepcup/shared';
  import { ShieldAlert } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    REGISTRATION_LABEL_KEYS,
    canAddLocal,
    cardConnectorId,
    localCardPhase,
    localConnectorError,
    minutesLeft,
    msUntilExpiry,
  } from '$lib/features/apps/local-connectors';
  import ConnectAppSetupBody from './ConnectAppSetupBody.svelte';

  /**
   * 对话内「本机连接」确认卡（设计 29 §17，todo/local-connector-authoring.md L4）：Bot 调
   * `app_propose_local_connector` 且 core 探测通过后，run 失败并携带
   * `setup.kind === 'confirm-local-connector'`。卡上的**全部字段由 core 生成**（探测结果 + 清洗后的
   * 展示文本），不是 Bot 原文：MCP 域名（大字）与完整地址、认证方式与授权服务器、将请求的范围、
   * 风险说明；文档链接只作为纯文本显示——渲染端没有打开任意 URL 的通道，也从不抓取它。
   *
   * 「添加」→ `apps.localConnectors.confirm`（一次性提案）→ 条目进目录 → 接上既有的连接链路
   * （ConnectAppSetupBody：`apps.connect` 带 `grantBotId`、授权前核对完整授权地址、首连工具复核、
   * 完成后 `continueAfterSetup`），不另起一套。「取消」→ `apps.localConnectors.reject` 并收起卡片。
   * 提案只存在于 core 内存（30 分钟 TTL、重启即失）：过期 / 失效时「添加」禁用并说明；重启后
   * 卡片重现但条目其实已添加时，直接进入连接步骤。
   */
  let {
    requirement,
  }: { requirement: Extract<SetupRequirement, { kind: 'confirm-local-connector' }> } = $props();

  const card = $derived(requirement.card);

  let now = $state(Date.now());
  let busy = $state(false);
  let rejected = $state(false);
  let staleReported = $state(false);
  let addedId = $state<string | null>(null);
  /** 授权服务器跨站（评审 A1）时必须勾选的确认。 */
  let crossSiteAck = $state(false);
  let errorMessage = $state('');

  $effect(() => {
    appsStore.start();
  });

  // 到期那一刻刷新界面（并让「x 分钟内有效」随时间变化）；已过期不再计时。
  $effect(() => {
    const current = now;
    if (msUntilExpiry(card, current) === 0) return;
    const wait = Math.min(msUntilExpiry(card, current) + 20, 15_000);
    const handle = setTimeout(() => (now = Date.now()), wait);
    return () => clearTimeout(handle);
  });

  // 新的 requirement（同一张卡位换了提案）：重置本地状态。
  $effect(() => {
    void card.proposalId;
    busy = false;
    rejected = false;
    staleReported = false;
    addedId = null;
    crossSiteAck = false;
    errorMessage = '';
  });

  const derivedConnectorId = $derived(cardConnectorId(card));
  const connectorId = $derived(addedId ?? derivedConnectorId);
  const alreadyAdded = $derived(
    addedId !== null ||
      (derivedConnectorId !== null &&
        appsStore.localConnectors.some((item) => item.connectorId === derivedConnectorId)),
  );
  const phase = $derived(localCardPhase({ card, now, alreadyAdded, staleReported, rejected }));

  const canAdd = $derived(canAddLocal({ phase, card, acknowledged: crossSiteAck, busy }));

  async function add(): Promise<void> {
    if (!canAdd) return;
    busy = true;
    errorMessage = '';
    try {
      const result = await appsStore.confirmLocal(card.proposalId, {
        acknowledgeCrossSiteIssuer: card.issuerCrossSite && crossSiteAck,
      });
      addedId = result.connectorId;
    } catch (error) {
      const view = localConnectorError(error);
      if (view === null) {
        errorMessage = error instanceof Error ? error.message : String(error);
      } else {
        if (view.stale) staleReported = true;
        errorMessage = t(view.key) + (view.detail !== undefined ? `：${view.detail}` : '');
      }
    } finally {
      busy = false;
    }
  }

  async function cancel(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      // 幂等：提案已过期 / 已处理也无妨，卡片照常收起。
      await appsStore.rejectLocal(card.proposalId).catch(() => undefined);
      rejected = true;
      chat.dismissSetupCard();
    } finally {
      busy = false;
    }
  }
</script>

{#if phase === 'added' && connectorId !== null}
  <!-- 已添加：接上既有的目录连接链路（授权前核对完整授权地址 → 工具复核 → 自动继续对话） -->
  <p class="pr-6 text-xs text-muted-foreground" data-testid="local-connector-added">
    {t('apps.local.card.added', { name: card.title })}
  </p>
  <ConnectAppSetupBody
    requirement={{
      kind: 'connect-app',
      target: { kind: 'catalog', connectorId },
      reason: 'not_connected',
    }}
  />
{:else}
  <div
    class="space-y-3"
    data-testid="local-connector-card"
    data-phase={phase}
    data-proposal-id={card.proposalId}
  >
    <div class="space-y-0.5 pr-6">
      <p class="flex items-center gap-1.5 text-sm font-medium" data-testid="setup-card-title">
        <ShieldAlert class="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        {t('apps.local.card.title')}
      </p>
      <p class="text-xs text-muted-foreground">{t('apps.local.card.intro')}</p>
    </div>

    <div class="space-y-1 rounded-lg border bg-muted/30 px-3 py-2.5">
      <p class="text-[11px] text-muted-foreground">{t('apps.local.card.host')}</p>
      <p
        class="font-mono text-lg font-semibold break-all select-all"
        data-testid="local-connector-host"
      >
        {card.mcpHost}
      </p>
      <p class="text-[11px] text-muted-foreground">{t('apps.local.card.url')}</p>
      <p class="font-mono text-xs break-all select-all" data-testid="local-connector-url">
        {card.mcpUrl}
      </p>
    </div>

    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
      <dt class="text-muted-foreground">{t('apps.local.card.name')}</dt>
      <dd class="min-w-0 break-words" data-testid="local-connector-name">
        <span class="font-medium">{card.title}</span>
        {#if card.description.length > 0}
          <span class="block text-muted-foreground">{card.description}</span>
        {/if}
      </dd>
      <dt class="text-muted-foreground">{t('apps.local.card.auth')}</dt>
      <dd data-testid="local-connector-auth">
        {t('apps.local.card.authValue', {
          registration: t(REGISTRATION_LABEL_KEYS[card.registration]),
        })}
      </dd>
      <dt class="text-muted-foreground">{t('apps.local.card.issuer')}</dt>
      <dd class="font-mono break-all" data-testid="local-connector-issuer">{card.issuerHost}</dd>
      <dt class="text-muted-foreground">{t('apps.local.card.scopes')}</dt>
      <dd data-testid="local-connector-scopes">
        {#if card.scopes.length === 0}
          <span class="text-muted-foreground">{t('apps.local.card.scopesNone')}</span>
        {:else}
          {#each card.scopes as scope (scope)}
            <code class="mr-1 rounded bg-muted px-1 py-0.5 text-[11px]">{scope}</code>
          {/each}
        {/if}
      </dd>
      {#if card.docUrl !== undefined}
        <dt class="text-muted-foreground">{t('apps.local.card.doc')}</dt>
        <!-- 纯文本：不是链接，不会被打开或抓取 -->
        <dd class="font-mono break-all select-all" data-testid="local-connector-doc">
          {card.docUrl}
        </dd>
      {/if}
    </dl>

    {#if card.issuerCrossSite}
      <!-- 评审 A1：授权服务器属于另一个站点——醒目的红色警告，点名两个域名，需显式勾选才可添加 -->
      <div
        class="space-y-2 rounded-lg border border-destructive/60 bg-destructive/10 px-3 py-2.5"
        role="alert"
        data-testid="local-connector-cross-site"
      >
        <p class="text-xs font-semibold text-destructive">
          {t('apps.local.card.crossSiteTitle')}
        </p>
        <p class="text-xs text-destructive">
          {t('apps.local.card.crossSiteBody', { mcp: card.mcpHost, issuer: card.issuerHost })}
        </p>
        <label class="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            class="mt-0.5"
            bind:checked={crossSiteAck}
            disabled={busy || phase !== 'ready'}
            data-testid="local-connector-cross-site-ack"
          />
          <span>{t('apps.local.card.crossSiteAck')}</span>
        </label>
      </div>
    {/if}

    <div class="space-y-1" data-testid="local-connector-warnings">
      <p class="text-xs font-medium">{t('apps.local.card.risks')}</p>
      <ul class="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        {#each card.warnings as warning (warning)}
          <li>{warning}</li>
        {/each}
      </ul>
    </div>

    {#if phase === 'expired'}
      <p class="text-xs text-amber-700 dark:text-amber-400" data-testid="local-connector-expired">
        {t('apps.local.card.expired')}
      </p>
    {:else if phase === 'ready'}
      <p class="text-[11px] text-muted-foreground" data-testid="local-connector-ttl">
        {t('apps.local.card.expiresIn', { minutes: minutesLeft(card, now) })}
      </p>
    {/if}
    {#if errorMessage.length > 0}
      <p class="text-xs text-destructive" role="alert" data-testid="local-connector-error">
        {errorMessage}
      </p>
    {/if}

    <div class="flex justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onclick={() => void cancel()}
        data-testid="local-connector-cancel"
      >
        {t('apps.local.card.cancel')}
      </Button>
      <Button
        size="sm"
        disabled={!canAdd}
        onclick={() => void add()}
        data-testid="local-connector-add"
      >
        {busy ? t('apps.local.card.adding') : t('apps.local.card.add')}
      </Button>
    </div>
  </div>
{/if}
