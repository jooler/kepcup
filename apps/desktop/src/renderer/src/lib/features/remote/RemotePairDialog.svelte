<script lang="ts">
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { toast } from 'svelte-sonner';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { renderSVG } from 'uqr';
  import { remotePairing } from './remote-pairing.svelte';
  import type { PairingOffer, RemoteStatusOutput } from '@kepcup/shared';

  /**
   * 配对二维码小窗（D96 §3.1）：展示 `remote.createPairing` 产物（QR + 倒计时）
   * 与待确认的配对请求卡（设备名 + UA 摘要，允许 / 拒绝）。手机发来请求由
   * `remote.pairingRequested` 事件与打开期间的状态轮询共同驱动（事件丢不掉，
   * 轮询兜事件未送达的窗口）。
   */

  let open = $state(false);
  let status = $state<RemoteStatusOutput | null>(null);
  let offer = $state<PairingOffer | null>(null);
  let now = $state(Date.now());
  let confirming = $state<null | 'allow' | 'decline'>(null);
  let pairedName = $state<string | null>(null);
  let copied = $state(false);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const qrSvg = $derived(offer === null ? '' : renderSVG(offer.url));
  const expiresInSeconds = $derived(
    offer === null ? 0 : Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)),
  );
  const expired = $derived(offer !== null && expiresInSeconds === 0);
  const pending = $derived(status?.pendingPairing ?? []);
  const enabled = $derived(status?.enabled === true);

  export function show(): void {
    open = true;
  }

  // 设置页按钮入口：消费 store 的打开请求（托盘路径经 App.svelte 直接调 show()）。
  $effect(() => {
    if (remotePairing.pending) {
      remotePairing.consume();
      open = true;
    }
  });

  /** 打开期间轮询状态（待确认请求、在线数），事件只做加速。 */
  function startTimers(): void {
    stopTimers();
    countdownTimer = setInterval(() => (now = Date.now()), 1000);
    pollTimer = setInterval(() => void refresh(), 3000);
  }

  function stopTimers(): void {
    if (countdownTimer !== null) clearInterval(countdownTimer);
    if (pollTimer !== null) clearInterval(pollTimer);
    countdownTimer = null;
    pollTimer = null;
  }

  async function refresh(): Promise<void> {
    try {
      status = (await core.call('remote.status')) as RemoteStatusOutput;
    } catch {
      // 窗口打开期 core 重连：下一轮轮询恢复。
    }
  }

  async function createOffer(): Promise<void> {
    offer = null;
    pairedName = null;
    await refresh();
    if (!enabled) return;
    try {
      offer = (await core.call('remote.createPairing')) as PairingOffer;
      now = Date.now();
    } catch (error) {
      toast.error(
        errorText(
          (error as { code?: string } | null)?.code,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async function confirm(requestId: string, accept: boolean): Promise<void> {
    confirming = accept ? 'allow' : 'decline';
    try {
      const outcome = (await core.call('remote.confirmPairing', { requestId, accept })) as {
        status: 'paired' | 'declined' | 'gone';
        device?: { name: string };
      };
      if (outcome.status === 'paired' && outcome.device !== undefined) {
        pairedName = outcome.device.name;
        offer = null;
      }
      await refresh();
    } catch (error) {
      toast.error(
        errorText(
          (error as { code?: string } | null)?.code,
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      confirming = null;
    }
  }

  /**
   * 复制配对链接本体：web 端 unpaired 页有粘贴入口（WebShellGate），扫码不便时
   * （桌面在另一房间、屏幕反光）仍能把链接手动带到手机（审查修复：文案承诺了
   * 这条路，UI 此前没有给链接文本）。
   */
  async function copyLink(): Promise<void> {
    if (offer === null) return;
    try {
      await navigator.clipboard.writeText(offer.url);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error(t('settings.remotePairCopyFailed'));
    }
  }

  $effect(() => {
    if (open) {
      now = Date.now();
      void createOffer();
      startTimers();
      const off = core.onEvent('remote.pairingRequested', () => void refresh());
      return () => {
        off();
        stopTimers();
      };
    }
    offer = null;
    status = null;
    pairedName = null;
    return undefined;
  });
</script>

<Dialog
  bind:open
  onOpenChange={(next) => {
    if (!next) {
      offer = null;
      status = null;
      pairedName = null;
    }
  }}
>
  <DialogContent class="sm:max-w-md" data-testid="remote-pair-dialog">
    <DialogHeader>
      <DialogTitle>{t('settings.remotePairTitle')}</DialogTitle>
    </DialogHeader>

    {#if !enabled}
      <p class="text-sm text-muted-foreground" data-testid="remote-pair-unavailable">
        {t('settings.remotePairUnavailable')}
      </p>
      <DialogFooter>
        <Button variant="ghost" onclick={() => (open = false)}>{t('common.close')}</Button>
      </DialogFooter>
    {:else if pairedName !== null}
      <div class="space-y-2 py-4 text-center" data-testid="remote-pair-done">
        <Badge variant="secondary">{t('settings.remotePairDone', { name: pairedName })}</Badge>
      </div>
      <DialogFooter>
        <Button variant="ghost" onclick={() => (open = false)}>{t('common.close')}</Button>
      </DialogFooter>
    {:else}
      {#if offer === null}
        <p class="py-4 text-sm text-muted-foreground">{t('settings.remotePairWaitConfirm')}</p>
      {:else if expired}
        <div class="space-y-3 py-2 text-center" data-testid="remote-pair-expired">
          <p class="text-sm text-muted-foreground">{t('settings.remotePairExpired')}</p>
          <Button onclick={() => void createOffer()}>{t('settings.remotePairRegenerate')}</Button>
        </div>
      {:else}
        <div class="space-y-3">
          <p class="text-sm text-muted-foreground">{t('settings.remotePairHint')}</p>
          <div
            class="mx-auto w-56 rounded-lg bg-muted p-3 [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
            data-testid="remote-qr"
          >
            <!-- uqr 生成的二维码 SVG（无用户输入，非 XSS 面） -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html qrSvg}
          </div>
          <p class="text-center text-xs" data-testid="remote-pair-countdown">
            {Math.floor(expiresInSeconds / 60)}:{String(expiresInSeconds % 60).padStart(2, '0')}
          </p>
          <div class="flex items-center justify-center gap-2" data-testid="remote-pair-link">
            <code
              class="max-w-[15rem] truncate rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground"
            >
              {offer.url}
            </code>
            <Button variant="ghost" size="sm" onclick={() => void copyLink()}>
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        </div>
      {/if}

      {#each pending as request (request.requestId)}
        <div
          class="space-y-2 rounded-lg border border-border p-3"
          data-testid="remote-confirm-card"
        >
          <p class="text-sm font-medium">
            {t('settings.remoteConfirmTitle', { name: request.deviceName })}
          </p>
          <p class="truncate text-xs text-muted-foreground">{request.userAgent}</p>
          <p class="text-xs text-muted-foreground">{t('settings.remoteConfirmBody')}</p>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={confirming !== null}
              data-testid="remote-confirm-decline"
              onclick={() => void confirm(request.requestId, false)}
            >
              {t('settings.remoteConfirmDecline')}
            </Button>
            <Button
              size="sm"
              disabled={confirming !== null}
              data-testid="remote-confirm-allow"
              onclick={() => void confirm(request.requestId, true)}
            >
              {t('settings.remoteConfirmAllow')}
            </Button>
          </div>
        </div>
      {/each}
    {/if}
  </DialogContent>
</Dialog>
