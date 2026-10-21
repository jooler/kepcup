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
   * 设置页「通用」：开机自启（P13-B）+ 工作台侧栏入口（D90，默认关）+ 版本与检查更新。
   */

  let autostart = $state(true);
  let checking = $state(false);
  /** 点击后的乐观值；与 store 一致后清掉，避免往返期间被旧快照打回。 */
  let workbenchOverride = $state<boolean | null>(null);
  const workbench = $derived(
    workbenchOverride !== null
      ? workbenchOverride
      : settingsStore.settings?.workbenchEnabled === true,
  );

  $effect(() => {
    const settings = settingsStore.settings;
    if (settings) {
      autostart = settings.launchAtLogin;
      // store 已跟上乐观值 → 放下 override，侧栏与其它订阅直接读 store。
      if (workbenchOverride !== null && settings.workbenchEnabled === workbenchOverride) {
        workbenchOverride = null;
      }
    }
  });

  // 打包后的应用：主进程应用登录项后推送结果；失败给出原因，成功也提示
  // （BR-P13-008：消费 settings.autostartApplied，开关的 OS 侧结果可见）。
  $effect(() => {
    const off = window.kepcup.onAutostartResult((result) => {
      if (result.outcome === 'failed') {
        toast.error(t('settings.launchAtLoginFailed', { reason: result.reason ?? '' }));
      } else {
        toast.success(
          t('settings.autostartApplied', {
            state: result.enabled
              ? t('settings.autostartStateOn')
              : t('settings.autostartStateOff'),
          }),
        );
      }
    });
    return off;
  });

  function toggleAutostart(checked: boolean): void {
    void settingsStore.update({ launchAtLogin: checked });
  }

  /**
   * 设置页手动开关：与定时任务数量 / 引导弹窗无关，随时可开可关。
   * 自排任务 >3 且仍关闭时只由 WorkbenchNudge 弹引导，绝不在此按数量强关或拦截。
   * 写入后核对回读：若 core 未落库（例如进程仍跑着旧 schema），立刻提示并回滚乐观态。
   */
  async function toggleWorkbench(checked: boolean): Promise<void> {
    workbenchOverride = checked;
    try {
      const next = await settingsStore.update({ workbenchEnabled: checked });
      if (next.workbenchEnabled !== checked) {
        workbenchOverride = null;
        toast.error(t('settings.workbenchEnabledPersistFailed'));
      }
    } catch (error) {
      workbenchOverride = null;
      toast.error(
        t('settings.workbenchEnabledPersistFailed') +
          (error instanceof Error && error.message ? `（${error.message}）` : ''),
      );
    }
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
    <Checkbox
      bind:checked={autostart}
      onCheckedChange={(checked) => toggleAutostart(checked === true)}
      data-testid="settings-launch-at-login"
    />
    <span class="grid gap-0.5">
      <Label class="font-medium">{t('settings.launchAtLogin')}</Label>
      <span class="text-xs text-muted-foreground">{t('settings.launchAtLoginHint')}</span>
    </span>
  </label>
  <label class="flex items-start gap-3" data-settings-anchor="general-workbench">
    <Checkbox
      checked={workbench}
      onCheckedChange={(checked) => void toggleWorkbench(checked === true)}
      data-testid="settings-workbench-enabled"
    />
    <span class="grid gap-0.5">
      <Label class="font-medium">{t('settings.workbenchEnabled')}</Label>
      <span class="text-xs text-muted-foreground">{t('settings.workbenchEnabledHint')}</span>
    </span>
  </label>
  <div class="flex items-center gap-3 text-sm">
    <span class="text-xs text-muted-foreground">
      {t('settings.version')}: {core.platform?.version ?? '—'}
    </span>
    <Button
      size="sm"
      variant="outline"
      disabled={checking}
      onclick={() => void checkUpdate()}
      data-testid="settings-check-update"
    >
      {checking ? t('update.checking') : t('update.checkNow')}
    </Button>
  </div>
</section>
