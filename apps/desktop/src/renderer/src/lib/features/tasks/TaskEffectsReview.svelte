<script lang="ts">
  import type { ToolEffect } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { effectBadge } from './task-view';

  /**
   * W3「检查后重试」面板（D78，todo/borrowings-from-personal-agents.md W3）：
   * 中断的任务沿续接链的外部副作用台账（effects.list）——每行的摘要与状态
   * （已完成 / 结果未知 / 失败 / 已拒绝），并说明沙箱内执行的命令不在清单里。
   * 用户勾「我已核实」后「重试」才可点（runs.retry reviewed:true）。
   */
  let {
    taskId,
    busy,
    onRetry,
    onClose,
  }: {
    taskId: string;
    busy: boolean;
    onRetry: () => void;
    onClose: () => void;
  } = $props();

  let effects = $state<ToolEffect[] | null>(null);
  let failed = $state(false);
  let confirmed = $state(false);

  $effect(() => {
    const id = taskId;
    let cancelled = false;
    effects = null;
    failed = false;
    void (core.call('effects.list', { taskId: id }) as Promise<{ effects: ToolEffect[] }>)
      .then((result) => {
        if (!cancelled) effects = result.effects;
      })
      .catch(() => {
        if (!cancelled) failed = true;
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<div class="mt-2 rounded-md border bg-muted/40 p-2 text-xs" data-testid="task-effects-review">
  <p class="font-medium">{t('task.review.title')}</p>
  <p class="mt-1 text-muted-foreground">{t('task.review.hint')}</p>

  {#if failed}
    <p class="mt-1.5 text-destructive">{t('task.review.loadFailed')}</p>
  {:else if effects === null}
    <p class="mt-1.5 text-muted-foreground">{t('task.review.loading')}</p>
  {:else if effects.length === 0}
    <p class="mt-1.5 text-muted-foreground">{t('task.review.empty')}</p>
  {:else}
    <ul class="mt-1.5 space-y-1" data-testid="task-effects-list">
      {#each effects as effect (effect.id)}
        {@const badge = effectBadge(effect.status)}
        <li class="flex items-start gap-2" data-testid="task-effect" data-status={badge}>
          {#if badge === 'uncertain'}
            <Badge
              variant="outline"
              class="shrink-0 border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-400"
              >{t(`task.effect.${badge}`)}</Badge
            >
          {:else if badge === 'completed'}
            <Badge
              variant="outline"
              class="shrink-0 text-[10px] text-emerald-700 dark:text-emerald-400"
              >{t(`task.effect.${badge}`)}</Badge
            >
          {:else}
            <Badge variant="outline" class="shrink-0 text-[10px] text-muted-foreground"
              >{t(`task.effect.${badge}`)}</Badge
            >
          {/if}
          <span class="min-w-0 break-all">{effect.summary}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="mt-1.5 text-muted-foreground" data-testid="task-effects-sandbox-note">
    {t('task.review.sandboxNote')}
  </p>

  <div class="mt-2 flex items-center justify-end gap-2">
    <label class="mr-auto flex items-center gap-1.5">
      <Checkbox
        checked={confirmed}
        disabled={busy}
        onCheckedChange={(checked) => (confirmed = checked === true)}
        data-testid="task-review-confirm"
      />
      {t('task.review.confirm')}
    </label>
    <Button size="sm" variant="ghost" class="h-7" disabled={busy} onclick={onClose}
      >{t('task.review.close')}</Button
    >
    <Button
      size="sm"
      variant="outline"
      class="h-7"
      disabled={busy || !confirmed}
      onclick={onRetry}
      data-testid="task-review-retry">{t('task.review.retry')}</Button
    >
  </div>
</div>
