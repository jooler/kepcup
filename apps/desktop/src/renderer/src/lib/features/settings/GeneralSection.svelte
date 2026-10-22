<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { AlertTriangle, ArrowUpCircle } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import SettingsCatalogFields from './SettingsCatalogFields.svelte';

  /**
   * 设置页「通用」：开机自启（P13-B）+ 工作台侧栏入口（D90，默认关）+
   * 任务 Loop（D93：经 `SettingsCatalogFields` 渲染目录条目 `general.task-loop`，
   * 校验单一来源在 core 适配器）+ 版本、静默更新状态与手动检查更新。
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
  /** ready：门控已确认无在途执行，普通按钮直接应用（BR-P13-005 安全相位）。 */
  const updateReadyToInstall = $derived(updateStatus.phase === 'ready-to-install');
  /**
   * awaiting-user：执行未在预算内排空。中断执行必须经 destructive 二次确认，
   * 绝不能是普通样式按钮一键触发（BR-P13-005 红线）；「继续等待」重臂门控
   * 排空轮询（BR-P13-002）。
   */
  const updateAwaitingUser = $derived(updateStatus.phase === 'awaiting-user');
  /** 手动检查入口在无更新流程时可见：idle / error / checking（checking 置灰）。 */
  const updateCanCheck = $derived(
    updateStatus.phase === 'idle' ||
      updateStatus.phase === 'error' ||
      updateStatus.phase === 'checking',
  );
  const updatePercent = $derived(Math.round(updateStatus.percent ?? 0));
  const awaitingRuns = $derived(updateStatus.activeRuns ?? 0);
  let confirmInterrupt = $state(false);

  // 门控离开 awaiting-user（继续等待后排空成功 / 安装中）→ 确认框随之收起。
  $effect(() => {
    if (!updateAwaitingUser) confirmInterrupt = false;
  });

  async function checkUpdate(): Promise<void> {
    updateStore.lastCheckError = null;
    try {
      const result = await updateStore.checkNow();
      if (!result.ok) {
        toast.error(t('update.checkFailed', { reason: result.message ?? '' }));
        return;
      }
      // 事件驱动（BR-P13-008，无墙钟启发）：update:status 推送与 invoke 响应
      // 经同一 ipc 队列有序送达，checkNow() resolve 时本次检查的结果推送已经
      // 在渲染层生效——update-not-available → idle（已是最新）；有更新 →
      // 设置行接管（downloading/waiting/ready）；失败 → error 推送已记入
      // lastCheckError 后回 idle。
      if (updateStore.lastCheckError !== null) {
        toast.error(t('update.checkFailed', { reason: updateStore.lastCheckError }));
      } else if (updateStore.status.phase === 'idle') {
        toast.success(t('update.upToDate'));
      }
    } catch (error) {
      toast.error(t('update.checkFailed', { reason: String((error as Error).message ?? '') }));
    }
  }

  /** awaiting-user 的二次确认通过：才允许中断在途执行并安装。 */
  function confirmedInterruptInstall(): void {
    confirmInterrupt = false;
    void updateStore.applyWithFeedback();
  }

  /** 「继续等待」：收起确认框并重臂门控的排空轮询（不中断任何执行）。 */
  function keepWaiting(): void {
    confirmInterrupt = false;
    void updateStore.keepWaiting();
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
  <div class="flex flex-wrap items-center gap-3 text-sm" data-testid="settings-update-row">
    <span class="text-xs text-muted-foreground">
      {t('settings.version')}: {core.platform?.version ?? '—'}
    </span>
    {#if updateDownloading}
      <!-- percent 未到（下载刚开始）时不显示误导性的 0%，退回无百分比文案。 -->
      <span
        class="font-medium text-emerald-600 dark:text-emerald-400"
        data-testid="settings-update-downloading"
      >
        {updateStatus.percent === undefined
          ? t('update.downloading', { version: updateStatus.version ?? '' })
          : t('update.downloadingProgress', {
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
    {:else if updateReadyToInstall}
      <Button
        size="sm"
        class="bg-emerald-600 text-white hover:bg-emerald-700"
        onclick={() => void updateStore.applyWithFeedback()}
        data-testid="settings-update-apply"
      >
        <ArrowUpCircle class="size-4" aria-hidden="true" />
        {t('update.applyNow')}
      </Button>
    {:else if updateAwaitingUser}
      {#if !confirmInterrupt}
        <Button
          size="sm"
          variant="destructive"
          onclick={() => (confirmInterrupt = true)}
          title={t('update.awaitingUser', { count: awaitingRuns })}
          data-testid="settings-update-apply"
        >
          <AlertTriangle class="size-4" aria-hidden="true" />
          {t('update.installAnyway')}
        </Button>
      {:else}
        <div
          class="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-md border border-destructive/40
            bg-destructive/5 p-2"
          role="alertdialog"
          aria-label={t('update.installAnyway')}
          data-testid="settings-update-confirm-box"
        >
          <span class="min-w-0 flex-1 text-xs text-muted-foreground">
            {t('update.awaitingUser', { count: awaitingRuns })}
          </span>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" onclick={() => (confirmInterrupt = false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onclick={keepWaiting}
              data-testid="settings-update-keep-waiting"
            >
              {t('update.keepWaiting')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onclick={confirmedInterruptInstall}
              data-testid="settings-update-install-anyway"
            >
              {t('update.installAnyway')}
            </Button>
          </div>
        </div>
      {/if}
    {:else if updateCanCheck}
      <Button
        size="sm"
        variant="outline"
        disabled={updateStatus.phase === 'checking'}
        onclick={() => void checkUpdate()}
        data-testid="settings-check-update"
      >
        {updateStatus.phase === 'checking' ? t('update.checking') : t('update.checkNow')}
      </Button>
    {/if}
  </div>
</section>
