<script lang="ts">
  import { t } from '$lib/i18n';
  import SettingsCatalogFields from './SettingsCatalogFields.svelte';

  /**
   * 设置 →「插件」分区（D104 UI 修正）：插件的供应链与更新设置从扩展中心「已安装」页
   * 迁到这里，成为与其他类别平级的设置分区。两项都是目录条目（Bot 可以出卡）：
   * 自动检查更新走通用 FieldEditorCard；市场地址与签名公钥是供应链信任根，
   * 卡片只做跳转、值由用户在页面上亲自填（write: user-only）。
   */
</script>

<h2 class="text-sm font-medium">{t('plugins.settings.title')}</h2>
<p class="text-xs text-muted-foreground">{t('plugins.settings.hint')}</p>

<div data-settings-anchor="plugins-updates">
  <SettingsCatalogFields itemIds={['plugins.updates']} />
</div>
<div data-settings-anchor="plugins-marketplace">
  <SettingsCatalogFields itemIds={['plugins.marketplace']} />
</div>
