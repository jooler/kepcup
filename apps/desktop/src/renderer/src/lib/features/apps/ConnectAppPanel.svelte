<script lang="ts">
  import type { AppConnectTarget } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { ExternalLink, Loader2, ShieldAlert } from '@lucide/svelte';
  import { errorText, t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import {
    CONNECTION_STATUS_LABEL_KEYS,
    FLOW_PHASE_LABEL_KEYS,
    FLOW_STEP_COUNT,
    flowErrorKey,
    isTerminalPhase,
    needsClientCredentials,
    phaseStep,
    splitAuthorizationUrl,
    statusHasGrant,
    statusNeedsReconnect,
    targetKey,
  } from './connect-flow';

  /**
   * 连接应用面板（D73，docs/design/29-connected-apps.md §5 / §9）：设置页（MCP 服务
   * 器的 OAuth 连接）与对话内连接卡共用——连接状态 + 连接 / 重新连接 / 断开 +
   * 交互授权流程进度：
   * - `awaiting_consent`：自定义 / 未审核授权服务器——展示完整授权 URL 并突出域名，
   *   用户核对后点「在浏览器中继续」才由 core 经主进程打开系统浏览器；
   * - `OAUTH_CLIENT_REQUIRED`：无任何自动注册途径——显示 issuer、需登记的回调地址，
   *   client id / secret 输入（secret 只写不读，提交后立即清空，永不回显）；
   * - 失败 / 取消 / 超时：文案 + 重试；`done`：成功提示并回调 `onDone`。
   * 只呈现本面板发起（或挂载时已在进行）的流程，避免把别处残留的终态当成本次结果。
   */
  let {
    target,
    scopes,
    grantBotId,
    name,
    allowDisconnect = true,
    onDone,
    testid = 'connect-app',
  }: {
    target: AppConnectTarget;
    /** 追加授权时的完整 scope 集合（旧 ∪ 新）。 */
    scopes?: string[] | undefined;
    grantBotId?: string | undefined;
    /** 展示名；缺省按目标推断（自定义 server 取其名称）。 */
    name?: string | undefined;
    allowDisconnect?: boolean;
    /** 本面板观察到流程 `done` 时回调一次（对话卡据此 `continueAfterSetup`）。 */
    onDone?: ((connectionId: string | undefined) => void) | undefined;
    testid?: string;
  } = $props();

  $effect(() => {
    appsStore.start();
  });

  const displayName = $derived.by(() => {
    if (name !== undefined && name.length > 0) return name;
    if (target.kind === 'custom') {
      const server = settingsStore.settings?.mcpServers.find((s) => s.id === target.serverId);
      return server?.name ?? target.serverId;
    }
    return target.connectorId;
  });

  const connection = $derived(appsStore.connectionFor(target));
  const status = $derived(connection?.status ?? 'not_connected');
  const currentFlow = $derived(appsStore.flowFor(target));

  // 只呈现本面板发起 / 挂载时已在进行的流程。
  let watchedFlowId = $state<string | null>(null);
  $effect(() => {
    const flow = currentFlow;
    if (
      flow !== null &&
      !isTerminalPhase(flow.phase) &&
      flow.flowId !== untrack(() => watchedFlowId)
    ) {
      watchedFlowId = flow.flowId;
    }
  });
  const flow = $derived(
    currentFlow !== null && currentFlow.flowId === watchedFlowId ? currentFlow : null,
  );
  const active = $derived(flow !== null && !isTerminalPhase(flow.phase));

  let notifiedFlowId: string | null = null;
  $effect(() => {
    const done = flow?.phase === 'done' ? flow : null;
    if (done === null || notifiedFlowId === done.flowId) return;
    notifiedFlowId = done.flowId;
    untrack(() => onDone?.(done.connectionId));
  });

  let busy = $state(false);

  function rpcError(error: unknown): string {
    const code = (error as { code?: string } | undefined)?.code;
    const fallback = error instanceof Error ? error.message : String(error);
    return errorText(code, fallback);
  }

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      watchedFlowId = await appsStore.connect(target, {
        ...(scopes !== undefined ? { scopes } : {}),
        ...(grantBotId !== undefined ? { grantBotId } : {}),
      });
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busy = false;
    }
  }

  async function continueInBrowser(): Promise<void> {
    if (flow === null || busy) return;
    busy = true;
    try {
      await appsStore.continueFlow(flow.flowId);
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busy = false;
    }
  }

  async function cancel(): Promise<void> {
    if (flow === null || busy) return;
    busy = true;
    try {
      await appsStore.cancel(flow.flowId);
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busy = false;
    }
  }

  async function disconnect(): Promise<void> {
    if (connection === null || busy) return;
    busy = true;
    try {
      await appsStore.disconnect(connection.id);
      appsStore.clearFlow(target);
      watchedFlowId = null;
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busy = false;
    }
  }

  function dismissFlow(): void {
    appsStore.clearFlow(target);
    watchedFlowId = null;
  }

  // --- 手填客户端（OAUTH_CLIENT_REQUIRED） ---------------------------------------
  let clientId = $state('');
  let clientSecret = $state('');
  let savingClient = $state(false);

  async function submitClient(): Promise<void> {
    if (flow === null || savingClient || clientId.trim().length === 0) return;
    savingClient = true;
    const secret = clientSecret;
    // 先清空：secret 只写不读，无论成败都不保留在输入框里。
    clientSecret = '';
    try {
      const nextFlowId = await appsStore.setClientCredentials(
        flow.flowId,
        clientId.trim(),
        secret.length > 0 ? secret : undefined,
      );
      watchedFlowId = nextFlowId;
      clientId = '';
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      savingClient = false;
    }
  }

  const split = $derived(
    flow?.authorizationUrl !== undefined ? splitAuthorizationUrl(flow.authorizationUrl) : null,
  );
  const errorMessage = $derived.by(() => {
    const error = flow?.error;
    if (error === undefined) return '';
    const key = flowErrorKey(error.code);
    return key !== null ? t(key) : error.message;
  });
  /** 已本地化的错误码下，core 给的原始说明作为补充细节（如 issuer 不符时的具体值）。 */
  const errorDetail = $derived.by(() => {
    const error = flow?.error;
    if (error === undefined || flowErrorKey(error.code) === null) return '';
    return error.message === errorMessage ? '' : error.message;
  });
  const step = $derived(flow === null ? 0 : phaseStep(flow.phase));
  const hasGrant = $derived(statusHasGrant(status));
</script>

<div
  class="space-y-2.5"
  data-testid={testid}
  data-target={targetKey(target)}
  data-status={status}
  data-phase={flow?.phase ?? ''}
>
  <!-- 连接状态 + 操作 -->
  <div class="flex flex-wrap items-center gap-2">
    <Badge
      variant={status === 'connected' ? 'default' : 'outline'}
      class={statusNeedsReconnect(status) || status === 'error'
        ? 'border-amber-500/60 text-amber-700 dark:text-amber-400'
        : ''}
      data-testid={`${testid}-status`}
    >
      {t(CONNECTION_STATUS_LABEL_KEYS[status])}
    </Badge>
    {#if connection !== null && connection.label.length > 0 && hasGrant}
      <span class="text-xs text-muted-foreground" data-testid={`${testid}-account`}>
        {t('apps.account', { label: connection.label })}
      </span>
    {/if}
    <div class="ml-auto flex items-center gap-2">
      {#if !active}
        <Button
          size="sm"
          variant={hasGrant && !statusNeedsReconnect(status) ? 'secondary' : 'default'}
          disabled={busy}
          onclick={() => void start()}
          data-testid={`${testid}-connect`}
        >
          {hasGrant ? t('apps.reconnect') : t('apps.connect')}
        </Button>
        {#if hasGrant && allowDisconnect}
          <Button
            size="sm"
            variant="ghost"
            class="text-destructive hover:text-destructive"
            disabled={busy}
            onclick={() => void disconnect()}
            data-testid={`${testid}-disconnect`}
          >
            {t('apps.disconnect')}
          </Button>
        {/if}
      {/if}
    </div>
  </div>

  {#if flow !== null}
    {#if active}
      <!-- 阶段进度 -->
      <div class="space-y-1" data-testid={`${testid}-progress`}>
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
          <span data-testid={`${testid}-phase`}>
            {t('apps.connecting', { name: displayName })} · {t(FLOW_PHASE_LABEL_KEYS[flow.phase])}
          </span>
        </div>
        <div
          class="h-1 w-full overflow-hidden rounded bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={FLOW_STEP_COUNT}
          aria-valuenow={step}
        >
          <div
            class="h-full bg-primary transition-[width]"
            style:width={`${(step / FLOW_STEP_COUNT) * 100}%`}
          ></div>
        </div>
      </div>

      {#if flow.phase === 'awaiting_consent' && split !== null}
        <!-- 授权域名核对：突出域名，用户确认后才打开浏览器 -->
        <div
          class="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5"
          data-testid={`${testid}-consent`}
        >
          <p class="flex items-center gap-1.5 text-xs font-medium">
            <ShieldAlert class="size-3.5 text-amber-600" aria-hidden="true" />
            {t('apps.consentTitle')}
          </p>
          <p class="text-xs text-muted-foreground">
            {t('apps.consentHint', { host: flow.authorizationHost ?? split.host })}
          </p>
          <p
            class="rounded bg-muted px-2 py-1.5 font-mono text-xs break-all"
            data-testid={`${testid}-url`}
          >
            <span class="text-muted-foreground">{split.prefix}</span><strong
              class="text-sm text-foreground"
              data-testid={`${testid}-host`}>{split.host}</strong
            ><span class="text-muted-foreground">{split.rest}</span>
          </p>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onclick={() => void continueInBrowser()}
              data-testid={`${testid}-continue`}
            >
              <ExternalLink class="size-3.5" aria-hidden="true" />
              {t('apps.continueInBrowser')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onclick={() => void cancel()}
              data-testid={`${testid}-cancel`}
            >
              {t('apps.cancel')}
            </Button>
          </div>
        </div>
      {:else}
        <div class="flex items-center gap-2">
          {#if flow.phase === 'awaiting_browser'}
            <p class="text-xs text-muted-foreground">{t('apps.awaitingBrowserHint')}</p>
          {/if}
          <Button
            size="sm"
            variant="ghost"
            class="ml-auto"
            disabled={busy}
            onclick={() => void cancel()}
            data-testid={`${testid}-cancel`}
          >
            {t('apps.cancel')}
          </Button>
        </div>
      {/if}
    {:else if flow.phase === 'done'}
      <p class="text-xs text-emerald-600 dark:text-emerald-400" data-testid={`${testid}-done`}>
        {t('apps.doneHint', { name: displayName })}
      </p>
    {:else if flow.phase === 'cancelled'}
      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <span data-testid={`${testid}-cancelled`}>{t('apps.cancelledHint')}</span>
        <Button size="sm" variant="ghost" class="ml-auto" onclick={dismissFlow}>
          {t('apps.dismiss')}
        </Button>
      </div>
    {:else if needsClientCredentials(flow)}
      <!-- 无 CIMD / DCR / 预注册：让用户手填自己的 OAuth 客户端 -->
      <div
        class="space-y-2.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5"
        data-testid={`${testid}-client-required`}
      >
        <p class="text-xs font-medium">{t('apps.clientRequiredTitle')}</p>
        <p class="text-xs text-muted-foreground">{t('apps.clientRequiredHint')}</p>
        {#if flow.error?.issuer !== undefined}
          <div class="grid gap-0.5">
            <span class="text-xs text-muted-foreground">{t('apps.issuer')}</span>
            <code
              class="rounded bg-muted px-1.5 py-0.5 text-xs break-all"
              data-testid={`${testid}-issuer`}>{flow.error.issuer}</code
            >
          </div>
        {/if}
        {#if (flow.error?.redirectUris ?? []).length > 0}
          <div class="grid gap-0.5">
            <span class="text-xs text-muted-foreground">{t('apps.redirectUris')}</span>
            <ul class="space-y-0.5" data-testid={`${testid}-redirects`}>
              {#each flow.error?.redirectUris ?? [] as uri (uri)}
                <li>
                  <code class="rounded bg-muted px-1.5 py-0.5 text-xs break-all">{uri}</code>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <div class="grid gap-1.5">
          <Label for={`${testid}-client-id`}>{t('apps.clientId')}</Label>
          <Input
            id={`${testid}-client-id`}
            class="h-8"
            autocomplete="off"
            spellcheck={false}
            bind:value={clientId}
            data-testid={`${testid}-client-id`}
          />
        </div>
        <div class="grid gap-1.5">
          <Label for={`${testid}-client-secret`}>{t('apps.clientSecret')}</Label>
          <Input
            id={`${testid}-client-secret`}
            class="h-8"
            type="password"
            autocomplete="off"
            placeholder={t('apps.clientSecretPlaceholder')}
            bind:value={clientSecret}
            data-testid={`${testid}-client-secret`}
          />
        </div>
        <div class="flex items-center gap-2">
          <Button
            size="sm"
            disabled={savingClient || clientId.trim().length === 0}
            onclick={() => void submitClient()}
            data-testid={`${testid}-client-save`}
          >
            {t('apps.clientSaveAndRetry')}
          </Button>
          <Button size="sm" variant="ghost" onclick={dismissFlow}>{t('apps.dismiss')}</Button>
        </div>
      </div>
    {:else}
      <!-- 失败 / 超时 -->
      <div class="flex items-start gap-2" data-testid={`${testid}-error`}>
        <div class="space-y-0.5" data-code={flow.error?.code ?? ''}>
          <p class="text-xs text-destructive">
            {errorMessage.length > 0 ? errorMessage : t('apps.error.OAUTH_FLOW_FAILED')}
          </p>
          {#if errorDetail.length > 0}
            <p
              class="text-xs break-all text-muted-foreground"
              data-testid={`${testid}-error-detail`}
            >
              {errorDetail}
            </p>
          {/if}
        </div>
        <Button size="sm" variant="ghost" class="ml-auto shrink-0" onclick={dismissFlow}>
          {t('apps.dismiss')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
