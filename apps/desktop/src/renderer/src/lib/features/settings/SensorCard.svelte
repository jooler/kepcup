<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import type { SensorKind, SensorPermissionStatus } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, type MessageKey } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { isSelectedDeviceMissing } from '$lib/sensors/hub';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import MicrophoneTest from './MicrophoneTest.svelte';
  import CameraPreview from './CameraPreview.svelte';

  /**
   * 设置页「硬件」分区的单个传感器卡片（docs/design/31-sensors.md §2.3，D76）：
   * 头部（名称 + 启用开关）、设备选择、系统权限、测试区。按 kind 数据驱动——
   * 新增传感器只需在注册表加一行并在这里挂一个测试插槽。
   */

  let { kind }: { kind: SensorKind } = $props();

  // 文案 key 显式登记（i18n 键为字面量联合类型，不能由 kind 拼接）；新增 kind 时
  // Record 的穷尽检查会逼出这里。
  const TEXT: Record<SensorKind, { name: MessageKey; description: MessageKey; empty: MessageKey }> =
    {
      microphone: {
        name: 'sensors.microphone.name',
        description: 'sensors.microphone.description',
        empty: 'sensors.microphone.empty',
      },
      camera: {
        name: 'sensors.camera.name',
        description: 'sensors.camera.description',
        empty: 'sensors.camera.empty',
      },
    };
  const text = $derived(TEXT[kind]);
  const snap = $derived(sensors.state[kind]);
  const missing = $derived(isSelectedDeviceMissing(snap));
  const hasNamedDevice = $derived(snap.devices.some((device) => device.label.length > 0));
  let loading = $state(false);

  async function refresh(): Promise<void> {
    loading = true;
    try {
      await sensors.refresh(kind);
    } finally {
      loading = false;
    }
  }

  async function authorize(): Promise<void> {
    try {
      await sensors.ensureAccess(kind);
      await refresh();
    } catch {
      toast.error(t('sensors.testAccessFailed'));
    }
  }

  function deviceLabel(label: string, index: number): string {
    return label.length > 0 ? label : t('sensors.deviceUnnamed', { index: index + 1 });
  }

  const PERMISSION_TEXT: Record<SensorPermissionStatus, MessageKey> = {
    granted: 'sensors.permissionStatus.granted',
    'not-determined': 'sensors.permissionStatus.not-determined',
    denied: 'sensors.permissionStatus.denied',
    restricted: 'sensors.permissionStatus.restricted',
    unknown: 'sensors.permissionStatus.unknown',
  };
  const permissionKey = $derived<SensorPermissionStatus>(snap.permission ?? 'unknown');
</script>

<section class="space-y-3" data-testid="sensor-card-{kind}">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-medium">{t(text.name)}</h3>
    <div class="flex items-center gap-2">
      <Checkbox
        id="sensor-enabled-{kind}"
        checked={snap.enabled}
        onCheckedChange={(checked) => sensors.setEnabled(kind, checked === true)}
        data-testid="sensor-enabled-{kind}"
      />
      <Label for="sensor-enabled-{kind}" class="text-xs text-muted-foreground">
        {t('sensors.enable')}
      </Label>
    </div>
  </div>
  <p class="text-xs text-muted-foreground">{t(text.description)}</p>

  <div class="grid max-w-xl gap-1.5">
    <div class="flex items-center justify-between">
      <Label for="sensor-device-{kind}">{t('sensors.device')}</Label>
      <Button
        variant="ghost"
        size="icon"
        class="size-6 text-muted-foreground"
        onclick={() => void refresh()}
        disabled={loading}
        aria-label={t('sensors.refresh')}
        title={t('sensors.refresh')}
        data-testid="sensor-refresh-{kind}"
      >
        <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
    <select
      id="sensor-device-{kind}"
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:opacity-50"
      value={snap.deviceId}
      disabled={!snap.enabled}
      onchange={(event) => sensors.setDeviceId(kind, event.currentTarget.value)}
      data-testid="sensor-device-{kind}"
    >
      <option value="">{t('sensors.deviceDefault')}</option>
      {#if missing}
        <option value={snap.deviceId}>{t('sensors.deviceMissingOption')}</option>
      {/if}
      {#each snap.devices.filter((device) => device.deviceId.length > 0) as device, index (device.deviceId)}
        <option value={device.deviceId}>{deviceLabel(device.label, index)}</option>
      {/each}
    </select>
    {#if missing}
      <p class="text-xs text-amber-600 dark:text-amber-400" data-testid="sensor-missing-{kind}">
        {t('sensors.deviceMissing')}
      </p>
    {:else if snap.fellBack}
      <p class="text-xs text-amber-600 dark:text-amber-400" data-testid="sensor-fellback-{kind}">
        {t('sensors.deviceFellBack')}
      </p>
    {:else if snap.devices.length === 0}
      <p class="text-xs text-muted-foreground">{t(text.empty)}</p>
    {:else if !hasNamedDevice}
      <p class="text-xs text-muted-foreground">{t('sensors.deviceNeedPermission')}</p>
    {/if}
  </div>

  <div class="flex max-w-xl items-center justify-between gap-3 text-sm">
    <span class="text-muted-foreground">
      {t('sensors.permission')}：
      <span data-testid="sensor-permission-{kind}" data-status={permissionKey}>
        {t(PERMISSION_TEXT[permissionKey])}
      </span>
    </span>
    {#if snap.permission === 'not-determined'}
      <Button
        variant="outline"
        size="sm"
        onclick={() => void authorize()}
        data-testid="sensor-authorize-{kind}"
      >
        {t('sensors.authorize')}
      </Button>
    {:else if snap.permission === 'denied' || snap.permission === 'restricted'}
      <Button
        variant="outline"
        size="sm"
        onclick={() => sensors.openSettings(kind)}
        data-testid="sensor-open-settings-{kind}"
      >
        {t('sensors.openSystemSettings')}
      </Button>
    {/if}
  </div>

  <div class="max-w-xl">
    {#if kind === 'microphone'}
      <MicrophoneTest />
    {:else if kind === 'camera'}
      <CameraPreview />
    {/if}
  </div>
</section>
