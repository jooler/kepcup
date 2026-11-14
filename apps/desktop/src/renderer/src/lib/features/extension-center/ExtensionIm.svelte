<script lang="ts">
  import { onMount } from 'svelte';
  import { MessageCircle } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { renderSVG } from 'uqr';
  import { AppError, type Bot, type ImAccount, type ImQrcodeStatus } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';

  /**
   * 扩展中心「IM 账号」（D107，54 号文档 §8）：账号列表 + 扫码添加 + 详情。
   * 首发 transport `ilink`（个人微信 iLink Bot API）：添加 = 扫码两步（创建二维码
   * → 轮询到 confirmed → core 落账号行，bot_token 不出 core）。绑定与「同步消息
   * 到此微信」开关在 Bot 详情的插件区（BotImBindings）；这里只管账号本身。
   */

  let accounts = $state<ImAccount[]>([]);
  let bots = $state<Bot[]>([]);
  let view = $state<'list' | 'add' | 'detail'>('list');
  /** 添加流程选中的 im 插件 id（多个 im 插件时先选）。 */
  let addPluginId = $state<string | null>(null);
  let selectedId = $state<string | null>(null);

  /**
   * `pluginId`：从某个插件的「管理」入口进来时只管理该插件的 IM 账号
   * （多个 im 插件并存时避免串台）；缺省 = 全局 IM 账号视图。
   */
  let { embedded = false, pluginId }: { embedded?: boolean; pluginId?: string | undefined } =
    $props();

  // --- 扫码添加状态（54 §2.3 qrcode 建号） -----------------------------------------
  let qrSvg = $state<string | null>(null);
  let qrSessionKey = $state<string | null>(null);
  let qrStatus = $state<'loading' | 'waiting' | 'scaned' | 'confirmed' | 'expired' | 'failed'>(
    'loading',
  );
  let qrBusy = $state(false);
  let qrError = $state('');

  const selected = $derived(accounts.find((account) => account.id === selectedId) ?? null);

  // detail 态的选中账号在别处被删（卸载级联等外部动作）时归位回列表，避免内容区空白无返回。
  $effect(() => {
    if (view === 'detail' && selected === null) view = 'list';
  });

  /** 提供 im 实例能力的已启用插件（添加入口的候选；按插件卡进入时只看该插件）。 */
  const imPlugins = $derived(
    plugins.plugins.filter(
      (plugin) =>
        plugin.enabled &&
        plugin.providesInstances.includes('im') &&
        (pluginId === undefined || plugin.id === pluginId),
    ),
  );

  /**
   * 圈定时的属主插件已停用：给「插件已停用」专用提示，而不是「没有 IM 插件」
   * 市场横幅（账号列表照常渲染，仍可管理已有账号）。插件不存在（已卸载的残留）
   * 仍走「没有 IM 插件」分支。
   */
  const scopedDisabled = $derived(
    pluginId !== undefined &&
      plugins.plugins.some((plugin) => plugin.id === pluginId && !plugin.enabled),
  );

  /** 按归属插件分组的账号（按插件卡进入时只列该插件）。 */
  const groups = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const map = new Map<string, ImAccount[]>();
    for (const account of accounts) {
      if (pluginId !== undefined && account.pluginId !== pluginId) continue;
      const list = map.get(account.pluginId) ?? [];
      list.push(account);
      map.set(account.pluginId, list);
    }
    return [...map.entries()];
  });

  /** 空态判定用：圈定后只数该插件的账号（聚合视图与全集一致）。 */
  const visibleAccounts = $derived(
    pluginId === undefined ? accounts : accounts.filter((account) => account.pluginId === pluginId),
  );

  function statusText(account: ImAccount): string {
    switch (account.status) {
      case 'connecting':
        return t('im.status.connecting');
      case 'ready':
        return t('im.status.ready');
      case 'paused':
        return t('im.status.paused');
      case 'auth_failed':
        return t('im.status.authFailed');
      case 'error':
        return t('im.status.error');
    }
  }

  async function reload(): Promise<void> {
    const [accountResult, botResult] = await Promise.all([
      core.call('im.accounts.list') as Promise<{ accounts: ImAccount[] }>,
      core.call('bots.list') as Promise<{ bots: Bot[] }>,
    ]);
    accounts = accountResult.accounts;
    bots = botResult.bots.filter((bot) => bot.status === 'active');
  }

  onMount(() => {
    void plugins.load().catch(() => undefined);
    void reload().catch((error: unknown) => {
      toast.error(error instanceof AppError ? errorText(error.code, error.message) : String(error));
    });
    return core.onEvent('im.account_updated', () => {
      void reload().catch(() => undefined);
    });
  });

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  // --- 扫码添加（两步：create → poll；confirmed 后 core 直接落地） -------------------

  async function startQrcode(): Promise<void> {
    if (addPluginId === null) return;
    qrBusy = true;
    qrError = '';
    qrStatus = 'loading';
    qrSvg = null;
    try {
      const result = (await core.call('im.login.qrcode.create', {
        pluginId: addPluginId,
      })) as { sessionKey: string; qrcodeContent: string };
      qrSessionKey = result.sessionKey;
      qrSvg = renderSVG(result.qrcodeContent);
      qrStatus = 'waiting';
      void pollQrcode(result.sessionKey);
    } catch (error) {
      qrStatus = 'failed';
      qrError = explain(error);
    } finally {
      qrBusy = false;
    }
  }

  async function pollQrcode(sessionKey: string): Promise<void> {
    for (let round = 0; round < 150; round++) {
      if (qrSessionKey !== sessionKey || qrStatus === 'confirmed') return;
      try {
        const result = (await core.call('im.login.qrcode.poll', { sessionKey })) as {
          status: ImQrcodeStatus;
        };
        if (result.status === 'confirmed') {
          qrStatus = 'confirmed';
          await landAccount(sessionKey);
          return;
        }
        if (result.status === 'expired') {
          qrStatus = 'expired';
          return;
        }
        if (result.status === 'scaned') qrStatus = 'scaned';
      } catch (error) {
        qrStatus = 'failed';
        qrError = explain(error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    qrStatus = 'expired';
  }

  /** 扫码确认后落地（im.accounts.create → 实例级联：secrets + 会话启动）。 */
  async function landAccount(sessionKey: string): Promise<void> {
    if (addPluginId === null) return;
    try {
      await core.call('im.accounts.create', { pluginId: addPluginId, sessionKey });
      toast.success(t('im.added'));
      qrSessionKey = null;
      await reload();
      view = 'list';
    } catch (error) {
      qrStatus = 'failed';
      qrError = explain(error);
    }
  }

  async function remove(account: ImAccount): Promise<void> {
    try {
      await core.call('im.accounts.delete', { id: account.id });
      selectedId = null;
      view = 'list';
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }

  /** token 失效重扫（54 §2.3 update）：旧账号行内直接走一遍扫码。 */
  async function startReauthorize(account: ImAccount): Promise<void> {
    addPluginId = account.pluginId;
    view = 'add';
    await startReauthorizeQrcode(account);
  }

  async function startReauthorizeQrcode(account: ImAccount): Promise<void> {
    qrBusy = true;
    qrError = '';
    qrStatus = 'loading';
    qrSvg = null;
    try {
      const result = (await core.call('im.login.qrcode.create', {
        pluginId: account.pluginId,
        accountId: account.id,
      })) as { sessionKey: string; qrcodeContent: string };
      qrSessionKey = result.sessionKey;
      qrSvg = renderSVG(result.qrcodeContent);
      qrStatus = 'waiting';
      void pollReauthorize(account, result.sessionKey);
    } catch (error) {
      qrStatus = 'failed';
      qrError = explain(error);
    } finally {
      qrBusy = false;
    }
  }

  async function pollReauthorize(account: ImAccount, sessionKey: string): Promise<void> {
    for (let round = 0; round < 150; round++) {
      if (qrSessionKey !== sessionKey || qrStatus === 'confirmed') return;
      try {
        const result = (await core.call('im.login.qrcode.poll', { sessionKey })) as {
          status: ImQrcodeStatus;
        };
        if (result.status === 'confirmed') {
          qrStatus = 'confirmed';
          await core.call('im.accounts.reauthorize', { id: account.id, sessionKey });
          toast.success(t('im.reauthorized'));
          qrSessionKey = null;
          await reload();
          view = 'list';
          return;
        }
        if (result.status === 'expired') {
          qrStatus = 'expired';
          return;
        }
        if (result.status === 'scaned') qrStatus = 'scaned';
      } catch (error) {
        qrStatus = 'failed';
        qrError = explain(error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    qrStatus = 'expired';
  }

  /** embedded：嵌进「已安装」的 im 筛选视图，去掉自带的滚动容器。 */
  function timeText(at: number | null): string {
    if (at === null) return '—';
    return new Date(at).toLocaleString();
  }
</script>

<div
  class={embedded ? 'min-w-0 pt-3' : 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pr-0.5'}
  data-testid="extension-im"
>
  {#if view === 'list'}
    <div class="mb-3 flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">{t('im.intro')}</p>
      <Button
        size="sm"
        onclick={() => {
          addPluginId = imPlugins.length === 1 ? (imPlugins[0]!.id ?? null) : null;
          qrSvg = null;
          qrSessionKey = null;
          qrStatus = 'loading';
          view = 'add';
          if (addPluginId !== null) void startQrcode();
        }}
        disabled={imPlugins.length === 0}
        data-testid="im-add"
      >
        {t('im.add')}
      </Button>
    </div>
    {#if scopedDisabled}
      <div
        class="mb-3 rounded-xl border border-dashed px-4 py-3 text-center text-sm text-muted-foreground"
        data-testid="im-plugin-disabled"
      >
        <p>{t('im.pluginDisabled')}</p>
      </div>
    {:else if imPlugins.length === 0}
      <div
        class="mb-3 rounded-xl border border-dashed px-4 py-3 text-center text-sm text-muted-foreground"
        data-testid="im-no-plugin"
      >
        <p>{t('im.noPlugin')}</p>
        <Button
          size="sm"
          variant="outline"
          class="mt-2"
          onclick={() => shell.openExtensionCenter('market')}
          data-testid="im-market-deeplink"
        >
          {t('im.openMarket')}
        </Button>
      </div>
    {/if}
    {#if visibleAccounts.length === 0}
      <div
        class="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="im-empty"
      >
        <MessageCircle class="mx-auto mb-2 size-5" aria-hidden="true" />
        <p>{t('im.empty')}</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each groups as [pluginKey, groupAccounts] (pluginKey)}
          <section>
            <p
              class="mb-1.5 text-xs font-medium text-muted-foreground"
              data-testid={`im-group-${pluginKey}`}
            >
              {plugins.nameOf(pluginKey)}
            </p>
            <ul class="space-y-2">
              {#each groupAccounts as account (account.id)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
                    onclick={() => {
                      selectedId = account.id;
                      view = 'detail';
                    }}
                    data-testid={`im-account-${account.id}`}
                  >
                    <span class="min-w-0">
                      <span class="block truncate font-medium">{account.label}</span>
                      <span class="block truncate text-xs text-muted-foreground"
                        >{account.apiBase}</span
                      >
                    </span>
                    <span class="shrink-0 text-xs text-muted-foreground">
                      {statusText(account)} ·
                      {t('im.botCount', { count: account.botIds.length })}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  {:else if view === 'add'}
    <div class="space-y-3" data-testid="im-add-view">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={() => {
          qrSessionKey = null;
          view = 'list';
        }}
      >
        {t('im.back')}
      </Button>
      {#if imPlugins.length === 0}
        <p class="text-sm text-muted-foreground">{t('im.noPlugin')}</p>
      {:else if imPlugins.length > 1 && addPluginId === null}
        <div class="space-y-2">
          <Label>{t('im.pickPlugin')}</Label>
          {#each imPlugins as plugin (plugin.id)}
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
              onclick={() => {
                addPluginId = plugin.id;
                void startQrcode();
              }}
              data-testid={`im-pick-${plugin.id}`}
            >
              <span class="min-w-0">
                <span class="block truncate font-medium">{plugin.name}</span>
                {#if plugin.description.length > 0}
                  <span class="block truncate text-xs text-muted-foreground"
                    >{plugin.description}</span
                  >
                {/if}
              </span>
              <span class="shrink-0 text-xs text-muted-foreground">
                {t('im.instanceCount', { count: plugin.instanceCounts.im })}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="mx-auto max-w-sm space-y-3 text-center" data-testid="im-qrcode-panel">
          <p class="text-sm text-muted-foreground">{t('im.qrcodeHint')}</p>
          {#if qrSvg !== null}
            <div
              class="mx-auto w-64 rounded-xl bg-muted p-4 [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
              data-testid="im-qr"
            >
              <!-- uqr 生成的二维码 SVG（宿主下发的扫码内容，非用户输入） -->
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html qrSvg}
            </div>
          {:else}
            <div
              class="mx-auto flex h-64 w-64 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground"
            >
              {t('im.qrcodeLoading')}
            </div>
          {/if}
          <p class="text-xs" data-testid="im-qr-status">
            {qrStatus === 'loading'
              ? t('im.qrcodeLoading')
              : qrStatus === 'scaned'
                ? t('im.qrcodeScaned')
                : qrStatus === 'confirmed'
                  ? t('im.qrcodeConfirmed')
                  : qrStatus === 'expired'
                    ? t('im.qrcodeExpired')
                    : qrStatus === 'failed'
                      ? t('im.qrcodeFailed')
                      : t('im.qrcodeWaiting')}
          </p>
          {#if qrError !== ''}
            <p class="text-xs text-destructive">{qrError}</p>
          {/if}
          {#if qrStatus === 'expired' || qrStatus === 'failed'}
            <Button size="sm" disabled={qrBusy} onclick={() => void startQrcode()}>
              {t('im.qrcodeRetry')}
            </Button>
          {/if}
        </div>
      {/if}
    </div>
  {:else if selected}
    <div class="space-y-4" data-testid="im-detail">
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('im.back')}
      </Button>
      <div>
        <h2 class="text-sm font-medium">{selected.label}</h2>
        <p class="text-xs text-muted-foreground">{selected.apiBase}</p>
        <p class="mt-1 text-xs" data-testid="im-detail-status">{statusText(selected)}</p>
        <p class="mt-1 text-xs text-muted-foreground" data-testid="im-detail-owner">
          {t('im.ownerOf', {
            plugin: selected.pluginName ?? plugins.nameOf(selected.pluginId),
          })}
        </p>
        {#if selected.lastError}
          <p class="mt-1 text-xs text-destructive">{selected.lastError}</p>
        {/if}
      </div>
      <div class="grid gap-1 text-sm text-muted-foreground" data-testid="im-detail-meta">
        <span>{t('im.lastInbound')}: {timeText(selected.lastInboundAt)}</span>
        <span>{t('im.lastOutbound')}: {timeText(selected.lastOutboundAt)}</span>
        {#if typeof selected.config.ilink_bot_id === 'string'}
          <span class="break-all">ilink_bot_id: {selected.config.ilink_bot_id}</span>
        {/if}
      </div>
      <div class="space-y-1" data-testid="im-detail-bots">
        <Label>{t('im.bots')}</Label>
        {#each bots as bot (bot.id)}
          <p class="text-xs text-muted-foreground">
            {bot.name}：
            {selected.botIds.includes(bot.id)
              ? selected.forwardBotIds.includes(bot.id)
                ? t('im.bindingForward')
                : t('im.bindingOn')
              : t('im.bindingOff')}
          </p>
        {/each}
        <p class="text-xs text-muted-foreground">{t('im.botsHint')}</p>
      </div>
      <div class="flex gap-2">
        {#if selected.status === 'auth_failed'}
          <Button
            variant="secondary"
            onclick={() => void startReauthorize(selected)}
            data-testid="im-rescan"
          >
            {t('im.rescan')}
          </Button>
        {/if}
        <Button variant="outline" onclick={() => void remove(selected)} data-testid="im-delete">
          {t('im.delete')}
        </Button>
      </div>
    </div>
  {/if}
</div>
