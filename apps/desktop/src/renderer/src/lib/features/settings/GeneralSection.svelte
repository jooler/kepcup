<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';

  /**
   * P13-B 任务 3 设置页「通用」分区: 开机自启开关（写 settings.launchAtLogin，
   * 变更经 platform.autostart 事件由主进程应用到 OS；应用结果经
   * autostart:result 推回，失败以 toast 说明原因、成功提示已应用）+ 版本与
   * 手动检查更新（消费 P13-A 的 preload 契约；结果事件驱动判定——
   * update-not-available → 「已是最新」，失败给出原因，有更新由横幅接管）。
   */

  let autostart = $state(true);
  let checking = $state(false);

  $effect(() => {
    const settings = settingsStore.settings;
    if (settings) autostart = settings.launchAtLogin;
  });

  // 打包后的应用：主进程应用登录项后推送结果；失败给出原因，成功也提示
  // （BR-P13-008：消费 settings.autostartApplied，开关的 OS 侧结果可见）。
  $effect(() => {
    const off = window.kepcup.onAutostartResult((result) => {
      if (result.outcome === 'failed') {
        toast.error(t('settings.launchAtLoginFailed', { reason: result.reason ?? '' }));
      } else {
        toast.success(
          t('settings.autostartApplied', { state: result.enabled ? '开启' : '关闭' }),
        );
      }
    });
    return off;
  });

  function toggleAutostart(checked: boolean): void {
    void settingsStore.update({ launchAtLogin: checked });
  }

  async function checkUpdate(): Promise<void> {
    checking = true;
    updateStore.lastCheckError = null;
    try {
      const result = await updateStore.checkNow();
      if (!result.ok) {
        toast.error(t('update.checkFailed', { reason: result.message ?? '' }));
        return;
      }
      // 事件驱动（BR-P13-008，无墙钟启发）：update:status 推送与 invoke 响应
      // 经同一 ipc 队列有序送达，checkNow() resolve 时本次检查的结果推送已经
      // 在渲染层生效——update-not-available → idle（已是最新）；有更新 → 横幅
      // 接管（downloading/waiting/ready，无需额外提示）；失败 → error 推送已
      // 记入 lastCheckError 后回 idle。
      if (updateStore.lastCheckError !== null) {
        toast.error(t('update.checkFailed', { reason: updateStore.lastCheckError }));
      } else if (updateStore.status.phase === 'idle') {
        toast.success(t('update.upToDate'));
      }
    } catch (error) {
      toast.error(t('update.checkFailed', { reason: String((error as Error).message ?? '') }));
    } finally {
      checking = false;
    }
  }
</script>

<section class="space-y-3" data-testid="settings-general">
  <h3 class="text-sm font-medium">{t('settings.generalSection')}</h3>
  <label class="flex items-start gap-3">
    <Checkbox bind:checked={autostart} onCheckedChange={(checked) => toggleAutostart(checked === true)} data-testid="settings-launch-at-login" />
    <span class="grid gap-0.5">
      <Label class="font-medium">{t('settings.launchAtLogin')}</Label>
      <span class="text-xs text-muted-foreground">{t('settings.launchAtLoginHint')}</span>
    </span>
  </label>
  <div class="flex items-center gap-3 text-sm">
    <span class="text-xs text-muted-foreground">
      {t('settings.version')}: {core.platform?.version ?? '—'}
    </span>
    <Button size="sm" variant="outline" disabled={checking} onclick={() => void checkUpdate()} data-testid="settings-check-update">
      {checking ? t('update.checking') : t('update.checkNow')}
    </Button>
  </div>
</section>
