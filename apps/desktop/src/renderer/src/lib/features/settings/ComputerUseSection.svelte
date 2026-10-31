<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SettingsCatalogFields from './SettingsCatalogFields.svelte';
  import { Button } from '$lib/components/ui/button';
  import { endpointSupports } from '$lib/features/web-shell/endpoint';

  /**
   * 设置页「计算机操控」独立分区（D105，docs/design/52 §6）：开关走设置目录
   * 的标量条目（`computer.control`）；下方是 helper 的状态与 TCC 权限引导——
   * 可用性行（`computer:capabilities-status`，重新握手并把结果落盘 userData，
   * 「本次能不能用」与 TCC 分开呈现，2026-10-31 冒烟反馈）+ TCC 权限三态
   * （已授权 / 未授权 / 未知，`computer:permissions-status`，检测会拉起 helper 注册
   * TCC）与「打开系统设置」深链（`computer:permissions-open`，首次拉起 helper 的
   * --permissions 引导窗口）。远程端点按 desktop-only 能力置灰（'computer-use'）。
   */

  type PermissionState = 'granted' | 'not-granted' | 'unknown';
  type Availability = 'checking' | 'available' | 'unavailable';

  let accessibility = $state<PermissionState>('unknown');
  let screenRecording = $state<PermissionState>('unknown');
  let availability = $state<Availability>('checking');
  let availabilityError = $state<string | null>(null);
  let refreshing = $state(false);
  let opening = $state<'accessibility' | 'screen-recording' | null>(null);

  const canUseHelper = $derived(endpointSupports('computer-use'));

  async function refresh(): Promise<void> {
    if (!canUseHelper || !window.kepcup?.computerPermissionStatus) return;
    refreshing = true;
    try {
      const [status, caps] = await Promise.all([
        window.kepcup.computerPermissionStatus(),
        window.kepcup.computerCapabilitiesStatus().catch(() => null),
      ]);
      accessibility = status.accessibility;
      screenRecording = status.screenRecording;
      availability = caps !== null && caps.available ? 'available' : 'unavailable';
      availabilityError = caps?.error ?? null;
    } finally {
      refreshing = false;
    }
  }

  async function open(permission: 'accessibility' | 'screen-recording'): Promise<void> {
    if (!canUseHelper || !window.kepcup?.computerPermissionOpen) return;
    opening = permission;
    try {
      await window.kepcup.computerPermissionOpen(permission);
    } finally {
      opening = null;
      // 用户从系统设置回来后手动刷新（TCC 变更没有回调）。
      void refresh();
    }
  }

  onMount(() => {
    void refresh();
  });

  function stateLabel(state: PermissionState): string {
    if (state === 'granted') return t('settings.computerUseGranted');
    if (state === 'not-granted') return t('settings.computerUseNotGranted');
    return t('settings.computerUseUnknown');
  }

  function availabilityLabel(state: Availability): string {
    if (state === 'available') return t('settings.computerUseAvailable');
    if (state === 'unavailable') return t('settings.computerUseUnavailable');
    return t('settings.computerUseChecking');
  }
</script>

<div class="space-y-3">
  <div>
    <h3 class="text-base font-medium">{t('settings.computerUseSectionTitle')}</h3>
    <p class="mt-1 text-sm text-muted-foreground">{t('settings.computerUseSectionHint')}</p>
  </div>
  <SettingsCatalogFields itemIds={['computer.control']} />

  <div class="space-y-2 rounded-lg border p-3" data-testid="computer-use-permissions">
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm">{t('settings.computerUseAvailability')}</span>
      <span
        class="text-xs {availability === 'available'
          ? 'text-emerald-600'
          : availability === 'unavailable'
            ? 'text-destructive'
            : 'text-muted-foreground'}"
        data-testid="computer-use-availability-state"
      >
        {availabilityLabel(availability)}
      </span>
    </div>
    {#if availability === 'unavailable' && availabilityError}
      <p class="text-xs text-muted-foreground" data-testid="computer-use-availability-error">
        {availabilityError}
      </p>
    {/if}
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm">{t('settings.computerUseAccessibility')}</span>
      <div class="flex items-center gap-2">
        <span
          class="text-xs {accessibility === 'granted'
            ? 'text-emerald-600'
            : accessibility === 'not-granted'
              ? 'text-destructive'
              : 'text-muted-foreground'}"
          data-testid="computer-use-accessibility-state"
        >
          {stateLabel(accessibility)}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!canUseHelper || opening !== null}
          onclick={() => open('accessibility')}
        >
          {opening === 'accessibility'
            ? t('settings.computerUseOpening')
            : t('settings.computerUseOpenSettings')}
        </Button>
      </div>
    </div>
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm">{t('settings.computerUseScreenRecording')}</span>
      <div class="flex items-center gap-2">
        <span
          class="text-xs {screenRecording === 'granted'
            ? 'text-emerald-600'
            : screenRecording === 'not-granted'
              ? 'text-destructive'
              : 'text-muted-foreground'}"
          data-testid="computer-use-screen-state"
        >
          {stateLabel(screenRecording)}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!canUseHelper || opening !== null}
          onclick={() => open('screen-recording')}
        >
          {opening === 'screen-recording'
            ? t('settings.computerUseOpening')
            : t('settings.computerUseOpenSettings')}
        </Button>
      </div>
    </div>
    <div class="flex items-center justify-between">
      <p class="text-xs text-muted-foreground">
        {canUseHelper ? t('settings.computerUsePermissionHint') : t('botTemplate.desktopOnly')}
      </p>
      <Button
        variant="ghost"
        size="sm"
        disabled={!canUseHelper || refreshing}
        onclick={() => refresh()}
      >
        {refreshing ? '…' : t('settings.computerUseRefresh')}
      </Button>
    </div>
  </div>
</div>
