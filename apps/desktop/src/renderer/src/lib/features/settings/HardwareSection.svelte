<script lang="ts">
  import { onMount } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import {
    listMicrophones,
    loadMicDeviceId,
    saveMicDeviceId,
    type MicDeviceInfo,
  } from '$lib/features/chats/mic-access';

  /**
   * 设置页「硬件」分区（docs/design/26-voice-input.md）：麦克风输入设备选择。
   * 语音输入（按录转文字 / 语音消息）按这里选定的设备采集，空 = 跟随系统默认。
   * 设备名是渲染层本机偏好（localStorage），不进 core 用户数据。
   * 未授权过麦克风时浏览器不给设备名（label 为空）——用语音按钮授权一次后
   * 刷新即可看到；拔插设备后点刷新按钮重新枚举。
   */

  let selected = $state('');
  let devices = $state<MicDeviceInfo[]>([]);
  let loading = $state(false);

  const hasNamedDevice = $derived(devices.some((device) => device.label.length > 0));

  onMount(() => {
    selected = loadMicDeviceId();
    void refresh();
  });

  async function refresh(): Promise<void> {
    loading = true;
    try {
      devices = await listMicrophones();
    } finally {
      loading = false;
    }
  }

  function pick(deviceId: string): void {
    selected = deviceId;
    saveMicDeviceId(deviceId);
  }

  function deviceLabel(device: MicDeviceInfo, index: number): string {
    return device.label.length > 0 ? device.label : t('settings.micDeviceUnnamed', { index: index + 1 });
  }
</script>

<section class="space-y-3" data-testid="settings-hardware">
  <h3 class="text-sm font-medium">{t('settings.hardwareSection')}</h3>

  <div class="grid max-w-xl gap-1.5">
    <div class="flex items-center justify-between">
      <Label for="settings-mic-device">{t('settings.micDevice')}</Label>
      <Button
        variant="ghost"
        size="icon"
        class="size-6 text-muted-foreground"
        onclick={() => void refresh()}
        disabled={loading}
        aria-label={t('settings.micRefresh')}
        title={t('settings.micRefresh')}
        data-testid="settings-mic-refresh"
      >
        <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
    <select
      id="settings-mic-device"
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={selected}
      onchange={() => pick(selected)}
      data-testid="settings-mic-device"
    >
      <option value="">{t('settings.micDeviceDefault')}</option>
      {#each devices as device, index (device.deviceId)}
        <option value={device.deviceId}>{deviceLabel(device, index)}</option>
      {/each}
    </select>
    <p class="text-xs text-muted-foreground">
      {#if devices.length === 0}
        {t('settings.micDeviceEmpty')}
      {:else if !hasNamedDevice}
        {t('settings.micDevicePermissionHint')}
      {:else}
        {t('settings.micDeviceHint')}
      {/if}
    </p>
  </div>
</section>
