<script lang="ts">
  import { onMount } from 'svelte';
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
  import type { PairedDevice, RemoteStatusOutput } from '@kepcup/shared';

  /**
   * 远程遥控设备管理卡（D96 §3.1 / §5.4）：中转连接状态 + 已配对设备列表
   *（名称 / 最后在线 / 在线徽标 / 撤销二次确认）。开关与中转地址是目录里的
   * 另两条标量条目（`field-editor`），不在这张卡里。配对二维码小窗在 WP4
   *（托盘 / 设置页入口），这里只展示状态与设备。
   */

  let {
    embedded = false,
    onSaved,
  }: {
    embedded?: boolean;
    onSaved?: () => void;
  } = $props();

  let status = $state<RemoteStatusOutput | null>(null);
  let devices = $state<PairedDevice[]>([]);
  let revokeTarget = $state<PairedDevice | null>(null);
  let revoking = $state(false);

  async function refresh(): Promise<void> {
    try {
      status = (await core.call('remote.status')) as RemoteStatusOutput;
      devices = ((await core.call('remote.devices')) as { devices: PairedDevice[] }).devices;
    } catch (error) {
      toast.error(
        errorText(
          (error as { code?: string } | null)?.code,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  onMount(() => {
    void refresh();
    const offState = core.onEvent('remote.anchorState', () => void refresh());
    const offDevice = core.onEvent('remote.deviceChanged', () => void refresh());
    return () => {
      offState();
      offDevice();
    };
  });

  async function revoke(): Promise<void> {
    if (revokeTarget === null) return;
    revoking = true;
    try {
      await core.call('remote.revokeDevice', { deviceId: revokeTarget.deviceId });
      toast.success(t('settings.remoteRevoked', { name: revokeTarget.name }));
      revokeTarget = null;
      await refresh();
      onSaved?.();
    } catch (error) {
      toast.error(
        errorText(
          (error as { code?: string } | null)?.code,
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      revoking = false;
    }
  }

  function lastSeenLabel(device: PairedDevice): string {
    if (device.online === true) return t('settings.remoteOnlineNow');
    if (device.lastSeenAt === null) return t('settings.remoteNeverSeen');
    return new Date(device.lastSeenAt).toLocaleString();
  }

  const anchorLabel = $derived(
    status === null
      ? ''
      : {
          off: t('settings.remoteAnchorOff'),
          idle: t('settings.remoteAnchorIdle'),
          connecting: t('settings.remoteAnchorConnecting'),
          online: t('settings.remoteAnchorOnline'),
          error: t('settings.remoteAnchorError'),
        }[status.anchor],
  );
</script>

<div data-settings-anchor="remote-devices" class="space-y-4">
  {#if status !== null}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <span>{anchorLabel}</span>
      {#if status.onlineDeviceIds.length > 0}
        <Badge variant="secondary">
          {t('settings.remoteOnlineCount', { count: status.onlineDeviceIds.length })}
        </Badge>
      {/if}
    </div>
  {/if}

  {#if devices.filter((device) => device.revokedAt === null).length === 0}
    <p class="text-sm text-muted-foreground">{t('settings.remoteNoDevices')}</p>
  {:else}
    <ul class="divide-y">
      {#each devices.filter((device) => device.revokedAt === null) as device (device.deviceId)}
        <li class="flex items-center justify-between gap-3 py-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">
              {device.name}
              {#if device.online === true}
                <Badge variant="secondary">{t('settings.remoteOnlineNow')}</Badge>
              {/if}
              {#if device.pskMode === 'psk'}
                <Badge variant="outline">{t('settings.remotePskDowngrade')}</Badge>
              {/if}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              {lastSeenLabel(device)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            class="text-destructive"
            data-testid="remote-revoke"
            onclick={() => (revokeTarget = device)}
          >
            {t('settings.remoteRevoke')}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if !embedded}
    <p class="text-xs text-muted-foreground">{t('settings.remoteTrustBoundaryHint')}</p>
  {/if}
</div>

<Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && (revokeTarget = null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle
        >{t('settings.remoteRevokeConfirmTitle', { name: revokeTarget?.name ?? '' })}</DialogTitle
      >
    </DialogHeader>
    <p class="text-sm text-muted-foreground">{t('settings.remoteRevokeConfirmBody')}</p>
    <DialogFooter>
      <Button variant="ghost" onclick={() => (revokeTarget = null)}>
        {t('common.cancel')}
      </Button>
      <Button
        variant="destructive"
        disabled={revoking}
        data-testid="remote-revoke-confirm"
        onclick={() => void revoke()}
      >
        {t('settings.remoteRevoke')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
