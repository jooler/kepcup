<script lang="ts">
  import { t } from '$lib/i18n';
  import SettingsCatalogFields from './SettingsCatalogFields.svelte';
  import RemoteDevicesCard from './RemoteDevicesCard.svelte';
  import { Button } from '$lib/components/ui/button';
  import { remotePairing } from '$lib/features/remote/remote-pairing.svelte';

  /**
   * 设置页「远程遥控」分区（D96 §3.1）：总开关与中转地址走设置目录的标量条目
   *（`SettingsCatalogFields`，锚点由本页静态写），设备管理是专用卡；「连接手机…」
   * 拉起全局配对二维码小窗（`RemotePairDialog`，托盘入口共用同一实例）。
   */
</script>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h3 class="text-base font-medium">{t('settings.remoteSectionTitle')}</h3>
      <p class="mt-1 text-sm text-muted-foreground">{t('settings.remoteSectionHint')}</p>
    </div>
    <Button
      variant="outline"
      size="sm"
      data-testid="remote-pair-button"
      onclick={() => remotePairing.request()}
    >
      {t('settings.remotePairDevice')}
    </Button>
  </div>
  <div data-settings-anchor="remote-enabled">
    <SettingsCatalogFields itemIds={['remote.enabled']} />
  </div>
  <div data-settings-anchor="remote-relay">
    <SettingsCatalogFields itemIds={['remote.relay']} />
  </div>
  <div data-settings-anchor="remote-devices">
    <RemoteDevicesCard />
  </div>
</div>
