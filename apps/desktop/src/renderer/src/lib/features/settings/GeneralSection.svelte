<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { applySettingItem } from '$lib/features/settings-card/apply';

  /**
   * 设置页「通用」：开机自启（P13-B）+ 工作台侧栏入口（D90，默认关）+
   * 任务 Loop（D93：空转检测与软预算）+ 版本与检查更新。
   */

  let autostart = $state(true);
  let checking = $state(false);
  let idleGuardEnabled = $state(true);
  let idleWarnAfter = $state('3');
  let idleStopAfter = $state('6');
  let idleWindowCalls = $state('12');
  let tokenSoftBudget = $state('0');
  let taskLoopSaving = $state(false);
  let taskLoopError = $state<string | null>(null);
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
      const taskLoop = settings.taskLoop;
      if (taskLoop) {
        idleGuardEnabled = taskLoop.idleGuardEnabled;
        idleWarnAfter = String(taskLoop.idleWarnAfter);
        idleStopAfter = String(taskLoop.idleStopAfter);
        idleWindowCalls = String(taskLoop.idleWindowCalls);
        tokenSoftBudget = String(taskLoop.tokenSoftBudget);
      }
    }
  });

  /** D93 任务 Loop：先做与 core 适配器一致的交叉校验，再走条目写入。 */
  async function saveTaskLoop(): Promise<void> {
    if (taskLoopSaving) return;
    const warn = Number(idleWarnAfter);
    const stop = Number(idleStopAfter);
    const windowCalls = Number(idleWindowCalls);
    const budget = Number(tokenSoftBudget);
    const isInt = (value: number, min: number, max: number): boolean =>
      Number.isInteger(value) && value >= min && value <= max;
    if (!isInt(warn, 2, 10)) {
      taskLoopError = t('settings.taskLoop.warnInvalid');
      return;
    }
    if (!isInt(stop, 3, 20) || stop <= warn) {
      taskLoopError = t('settings.taskLoop.stopInvalid');
      return;
    }
    if (!isInt(windowCalls, 3, 50) || windowCalls < stop) {
      taskLoopError = t('settings.taskLoop.windowInvalid');
      return;
    }
    if (!isInt(budget, 0, 10_000_000)) {
      taskLoopError = t('settings.taskLoop.budgetInvalid');
      return;
    }
    taskLoopSaving = true;
    taskLoopError = null;
    try {
      await applySettingItem({
        itemId: 'general.task-loop',
        values: {
          idleGuardEnabled,
          idleWarnAfter: warn,
          idleStopAfter: stop,
          idleWindowCalls: windowCalls,
          tokenSoftBudget: budget,
        },
        expected: null,
      });
      toast.success(t('settingCard.appliedToast'));
      await settingsStore.refresh().catch(() => undefined);
    } catch (error) {
      taskLoopError =
        error instanceof Error && error.message.length > 0
          ? error.message
          : t('settings.taskLoop.saveFailed');
    } finally {
      taskLoopSaving = false;
    }
  }

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
  <div class="space-y-2 rounded-md border p-3" data-settings-anchor="general-task-loop">
    <div class="grid gap-0.5">
      <span class="text-sm font-medium">{t('settings.taskLoop.title')}</span>
      <span class="text-xs text-muted-foreground">{t('settings.taskLoop.hint')}</span>
    </div>
    <label class="flex items-start gap-3">
      <Checkbox
        bind:checked={idleGuardEnabled}
        data-testid="settings-task-loop-enabled"
      />
      <span class="grid gap-0.5">
        <Label class="font-medium">{t('settings.taskLoop.enabled')}</Label>
        <span class="text-xs text-muted-foreground">{t('settings.taskLoop.enabledHint')}</span>
      </span>
    </label>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <label class="grid gap-1 text-xs">
        <span>{t('settings.taskLoop.warnAfter')}</span>
        <input
          type="number"
          min="2"
          max="10"
          step="1"
          class="h-8 rounded-md border border-input bg-background px-2 text-sm"
          bind:value={idleWarnAfter}
          data-testid="settings-task-loop-warn"
        />
      </label>
      <label class="grid gap-1 text-xs">
        <span>{t('settings.taskLoop.stopAfter')}</span>
        <input
          type="number"
          min="3"
          max="20"
          step="1"
          class="h-8 rounded-md border border-input bg-background px-2 text-sm"
          bind:value={idleStopAfter}
          data-testid="settings-task-loop-stop"
        />
      </label>
      <label class="grid gap-1 text-xs">
        <span>{t('settings.taskLoop.windowCalls')}</span>
        <input
          type="number"
          min="3"
          max="50"
          step="1"
          class="h-8 rounded-md border border-input bg-background px-2 text-sm"
          bind:value={idleWindowCalls}
          data-testid="settings-task-loop-window"
        />
      </label>
      <label class="grid gap-1 text-xs">
        <span>{t('settings.taskLoop.tokenSoftBudget')}</span>
        <input
          type="number"
          min="0"
          max="10000000"
          step="100000"
          class="h-8 rounded-md border border-input bg-background px-2 text-sm"
          bind:value={tokenSoftBudget}
          data-testid="settings-task-loop-budget"
        />
      </label>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        disabled={taskLoopSaving}
        onclick={() => void saveTaskLoop()}
        data-testid="settings-task-loop-save"
      >
        {taskLoopSaving ? t('settings.taskLoop.saving') : t('settings.taskLoop.save')}
      </Button>
      <span class="text-xs text-muted-foreground">{t('settings.taskLoop.valuesHint')}</span>
    </div>
    {#if taskLoopError !== null}
      <p class="text-xs text-destructive" data-testid="settings-task-loop-error">{taskLoopError}</p>
    {/if}
  </div>
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
