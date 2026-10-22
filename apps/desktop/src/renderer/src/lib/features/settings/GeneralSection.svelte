<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { ArrowUpCircle } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import SettingsCatalogFields from './SettingsCatalogFields.svelte';

  /**
   * 设置页「通用」：开机自启（P13-B）+ 工作台侧栏入口（D90，默认关）+
   * 任务 Loop（D93：经 `SettingsCatalogFields` 渲染目录条目 `general.task-loop`，
   * 校验单一来源在 core 适配器）+ 版本与静默更新状态。
   */

  let autostart = $state(true);
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

  const updateStatus = $derived(updateStore.status);
  const updateDownloading = $derived(updateStatus.phase === 'downloading');
  const updateWaitingRuns = $derived(updateStatus.phase === 'waiting-runs');
  const updateReady = $derived(
    updateStatus.phase === 'ready-to-install' || updateStatus.phase === 'awaiting-user',
  );
  const updatePercent = $derived(Math.round(updateStatus.percent ?? 0));

  async function applyUpdate(): Promise<void> {
    const result = await updateStore.installNow();
    if (!result.ok) {
      toast.error(t('update.installFailed', { reason: result.message ?? '' }), {
        action: {
          label: t('update.viewLogs'),
          onClick: () => void window.kepcup.openLogsDir(),
        },
      });
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
  <!-- 锚点由页面静态写（覆盖率扫描只认字面量）；卡片内的保存走条目级 settings.items.apply。 -->
  <div
    class="rounded-md border p-3"
    data-settings-anchor="general-task-loop"
    data-testid="settings-task-loop"
  >
    <SettingsCatalogFields itemIds={['general.task-loop']} />
  </div>
  <div class="flex items-center gap-3 text-sm" data-testid="settings-update-row">
    <span class="text-xs text-muted-foreground">
      {t('settings.version')}: {core.platform?.version ?? '—'}
    </span>
    {#if updateDownloading}
      <span
        class="font-medium text-emerald-600 dark:text-emerald-400"
        data-testid="settings-update-downloading"
      >
        {t('update.downloadingProgress', {
          version: updateStatus.version ?? '',
          percent: updatePercent,
        })}
      </span>
    {:else if updateWaitingRuns}
      <span
        class="font-medium text-emerald-600 dark:text-emerald-400"
        data-testid="settings-update-waiting"
      >
        {t('update.downloadedWaiting', { version: updateStatus.version ?? '' })}
      </span>
    {:else if updateReady}
      <Button
        size="sm"
        class="bg-emerald-600 text-white hover:bg-emerald-700"
        onclick={() => void applyUpdate()}
        data-testid="settings-update-apply"
      >
        <ArrowUpCircle class="size-4" aria-hidden="true" />
        {t('update.applyNow')}
      </Button>
    {/if}
  </div>
</section>
