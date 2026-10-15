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
   * 工作台引导（D90）：Bot 自排定时任务（非 workbench origin）超过 3 个、且侧栏工作台仍关闭、
   * 且用户未永久关闭引导时，弹出「启用 / 暂不启用」；暂不启用后再说明可到设置打开，点「知道了」
   * 写入 workbenchNudgeDismissed，两层引导都不再出现。
   */
  const THRESHOLD = 3;

  let selfCount = $state(0);
  let phase = $state<'idle' | 'offer' | 'dismissed-hint'>('idle');
  let busy = $state(false);

  const enabled = $derived(settingsStore.settings?.workbenchEnabled === true);
  const dismissed = $derived(settingsStore.settings?.workbenchNudgeDismissed === true);

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

  // 条件满足时进入 offer；已启用 / 已永久关闭 / 数量不够则收起。
  $effect(() => {
    if (enabled || dismissed || selfCount <= THRESHOLD) {
      if (phase !== 'idle') phase = 'idle';
      return;
    }
    if (phase === 'idle') phase = 'offer';
  });

  async function enable(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
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
