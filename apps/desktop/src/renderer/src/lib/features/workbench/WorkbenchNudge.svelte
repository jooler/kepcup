<script lang="ts">
  import type { ScheduleEntry } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { selfSchedulesOf } from './workbench-model';

  /**
   * 工作台引导（D90）：**仅**在「Bot 自排定时任务（非 workbench origin）数量 > 3」且
   * 「侧栏工作台仍关」且「未永久关闭引导」时弹出「启用 / 暂不启用」。
   *
   * 不变式：自排数量**绝不**写回 / 强关 / 拦截 `workbenchEnabled`。设置页「显示工作台」
   * 可随时手动开关；本组件只在用户点「启用」时写成 true，点「知道了」时只写
   * `workbenchNudgeDismissed`。
   */
  const THRESHOLD = 3;

  let selfCount = $state(0);
  let phase = $state<'idle' | 'offer' | 'dismissed-hint'>('idle');
  let busy = $state(false);

  const enabled = $derived(settingsStore.settings?.workbenchEnabled === true);
  const dismissed = $derived(settingsStore.settings?.workbenchNudgeDismissed === true);
  /** 只有数量真正超过阈值才具备弹引导资格（不含等于）。 */
  const overThreshold = $derived(selfCount > THRESHOLD);

  async function refreshCount(): Promise<void> {
    try {
      const result = (await core.call('schedules.list', {})) as { schedules: ScheduleEntry[] };
      selfCount = selfSchedulesOf(result.schedules).length;
    } catch {
      // 列表失败不弹引导。
    }
  }

  $effect(() => {
    void refreshCount();
    const off = core.onEvent('schedules.changed', () => {
      void refreshCount();
    });
    return off;
  });

  // 只驱动引导相位：已启用 / 已永久关闭 / 未超阈值 → 收起；否则进入 offer。
  // 这里不得调用 settingsStore.update，也不得把 workbenchEnabled 打成 false。
  $effect(() => {
    if (enabled || dismissed || !overThreshold) {
      if (phase !== 'idle') phase = 'idle';
      return;
    }
    if (phase === 'idle') phase = 'offer';
  });

  async function enable(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      // 唯一会打开工作台开关的引导路径；设置页开关是另一条独立路径。
      await settingsStore.update({ workbenchEnabled: true });
      phase = 'idle';
      shell.openWorkbench();
    } finally {
      busy = false;
    }
  }

  function decline(): void {
    phase = 'dismissed-hint';
  }

  async function acknowledge(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      // 只持久化「不再引导」；不改 workbenchEnabled。
      await settingsStore.update({ workbenchNudgeDismissed: true });
      phase = 'idle';
    } finally {
      busy = false;
    }
  }
</script>

<Dialog open={phase === 'offer'}>
  <DialogContent
    showCloseButton={false}
    escapeKeydownBehavior="ignore"
    interactOutsideBehavior="ignore"
    data-testid="workbench-nudge-offer"
  >
    <DialogHeader>
      <DialogTitle>{t('workbench.nudge.title')}</DialogTitle>
      <DialogDescription>{t('workbench.nudge.body')}</DialogDescription>
    </DialogHeader>
    <DialogFooter class="gap-2 sm:justify-end">
      <Button
        variant="outline"
        disabled={busy}
        onclick={decline}
        data-testid="workbench-nudge-later"
      >
        {t('workbench.nudge.later')}
      </Button>
      <Button disabled={busy} onclick={() => void enable()} data-testid="workbench-nudge-enable">
        {t('workbench.nudge.enable')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<Dialog open={phase === 'dismissed-hint'}>
  <DialogContent
    showCloseButton={false}
    escapeKeydownBehavior="ignore"
    interactOutsideBehavior="ignore"
    data-testid="workbench-nudge-dismiss"
  >
    <DialogHeader>
      <DialogTitle>{t('workbench.nudge.dismissTitle')}</DialogTitle>
      <DialogDescription>{t('workbench.nudge.dismissBody')}</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button
        disabled={busy}
        onclick={() => void acknowledge()}
        data-testid="workbench-nudge-got-it"
      >
        {t('workbench.nudge.gotIt')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
