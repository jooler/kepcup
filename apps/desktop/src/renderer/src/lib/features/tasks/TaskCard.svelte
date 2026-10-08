<script lang="ts">
  import {
    CircleCheck,
    CircleSlash,
    CircleX,
    Clock,
    CornerDownRight,
    ListChecks,
    Loader2,
    MessageCircleQuestion,
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { Button } from '$lib/components/ui/button';
  import { taskCardModel } from './task-view';

  /**
   * 任务卡（D75，docs/design/30-supervisor-and-tasks.md §4.3）：对话轮
   * start_task 时出现，随 `task.updated` 重绘——标题、状态、排队原因、最近
   * 进度、追加的指令（含之后降级为未送达）、取消按钮；结算后转终态：取消卡
   * 附改动摘要（项目写任务可整次回退；工作区没有检查点，如实说明不能回退），
   * 失败卡可重试（新任务接续它）。结果本身由对话轮转述，不在卡上。
   */
  let { taskId }: { taskId: string } = $props();

  $effect(() => {
    void tasks.ensure(taskId);
  });

  const task = $derived(tasks.byId[taskId] ?? null);
  const model = $derived(task !== null ? taskCardModel(task) : null);
  const ownerName = $derived(
    task?.botId != null && chat.current?.conversation.type === 'group'
      ? chat.botName(task.botId)
      : '',
  );
  let busy = $state(false);
  let reverted = $state(false);

  function codeOf(error: unknown): string | undefined {
    return (error as { code?: string } | undefined)?.code;
  }

  async function cancel(): Promise<void> {
    busy = true;
    try {
      await tasks.cancel(taskId);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    } finally {
      busy = false;
    }
  }

  async function retry(): Promise<void> {
    busy = true;
    try {
      await tasks.retry(taskId);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    } finally {
      busy = false;
    }
  }

  async function revert(): Promise<void> {
    busy = true;
    try {
      const result = (await core.call('projects.revert', { runId: taskId, force: false })) as {
        ok: boolean;
        conflicts: string[];
      };
      if (!result.ok) {
        toast.error(t('task.revertConflicts', { count: result.conflicts.length }));
        return;
      }
      reverted = true;
      toast.success(t('changes.reverted'));
      void tasks.ensure(taskId);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    } finally {
      busy = false;
    }
  }
</script>

{#if task === null || model === null}
  <span class="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground"
    >{t('task.loading')}</span
  >
{:else}
  <div
    class="w-full max-w-[85%] rounded-lg border p-3 text-sm {model.tone === 'error'
      ? 'border-destructive/40 bg-destructive/5'
      : 'bg-background/80'}"
    data-testid={`task-card-${taskId}`}
    data-task-state={task.state}
  >
    <div class="flex items-center gap-2 font-medium">
      <ListChecks class="size-4 shrink-0 text-sky-600" aria-hidden="true" />
      <span class="min-w-0 truncate" data-testid="task-title"
        >{ownerName.length > 0
          ? t('task.titleWithOwner', { name: ownerName, title: task.title })
          : t('task.title', { title: task.title })}</span
      >
      <span
        class="ml-auto flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground"
        data-testid="task-state"
      >
        {#if task.state === 'running'}
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
        {:else if task.state === 'submitted'}
          <Clock class="size-3" aria-hidden="true" />
        {:else if task.state === 'completed'}
          <CircleCheck class="size-3 text-emerald-600" aria-hidden="true" />
        {:else if task.state === 'cancelled'}
          <CircleSlash class="size-3" aria-hidden="true" />
        {:else}
          <CircleX class="size-3 text-destructive" aria-hidden="true" />
        {/if}
        {t(`task.state.${task.state}`)}
      </span>
    </div>

    {#if model.queueReason !== null}
      <p class="mt-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="task-queue-reason">
        {model.queueReason.length > 0
          ? t('task.queued', { reason: model.queueReason })
          : t('task.waitingStart')}
      </p>
    {/if}
    {#if task.awaitingInput}
      <p class="mt-1.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
        <MessageCircleQuestion class="size-3.5" aria-hidden="true" />
        {t('task.awaitingInput')}
      </p>
    {/if}
    {#if model.progress !== null}
      <p class="mt-1.5 line-clamp-2 text-xs text-muted-foreground" data-testid="task-progress">
        {t('task.lastProgress', { text: model.progress })}
      </p>
    {/if}

    {#each task.injects as inject (inject.messageId)}
      <p
        class="mt-1.5 flex items-start gap-1 text-xs text-muted-foreground"
        data-testid="task-inject"
        data-delivery={inject.delivery}
      >
        <CornerDownRight class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span class="min-w-0">
          {t('task.injected', { text: model.clip(inject.text) })}
          {#if inject.delivery === 'queued'}
            <span class="text-amber-700 dark:text-amber-400">{t('task.injectNotDelivered')}</span>
          {/if}
        </span>
      </p>
    {/each}

    {#if model.cancelReason !== null}
      <p class="mt-1.5 text-xs text-muted-foreground" data-testid="task-cancel-reason">
        {model.cancelReason.length > 0
          ? t('task.cancelledBecause', { reason: model.cancelReason })
          : t('task.cancelledPlain')}
      </p>
    {/if}
    {#if model.errorLine !== null}
      <p class="mt-1.5 text-xs text-muted-foreground" data-testid="task-error">{model.errorLine}</p>
    {/if}

    {#if model.changes !== null}
      <div class="mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs" data-testid="task-changes">
        {#if model.changes.kind === 'project'}
          {#if model.changes.reverted || reverted}
            <span data-testid="task-changes-reverted">{t('task.changesReverted')}</span>
          {:else}
            <span
              >{t('task.changesProject', {
                added: model.changes.added,
                modified: model.changes.modified,
                deleted: model.changes.deleted,
              })}</span
            >
          {/if}
        {:else if model.changes.kind === 'workspace'}
          <p>{t('task.changesWorkspace')}</p>
          {#if model.changes.files.length > 0}
            <p class="mt-1 text-muted-foreground">{t('task.changesWorkspaceFiles')}</p>
            <ul class="mt-0.5 space-y-0.5" data-testid="task-changes-files">
              {#each model.changes.files as file (file)}
                <li><code class="break-all">{file}</code></li>
              {/each}
            </ul>
            {#if model.changes.more > 0}
              <p class="mt-0.5 text-muted-foreground">
                {t('task.changesMore', { count: model.changes.more })}
              </p>
            {/if}
          {/if}
        {:else}
          <span>{t('task.changesNone')}</span>
        {/if}
      </div>
    {/if}

    {#if model.setupHint}
      <p class="mt-1.5 text-xs text-muted-foreground">{t('task.setupHint')}</p>
    {/if}
    {#if task.continuedByTaskId !== null}
      <p class="mt-1.5 text-xs text-muted-foreground" data-testid="task-retried">
        {t('task.retried')}
      </p>
    {/if}

    {#if model.canCancel || model.canRetry || model.canRevert}
      <div class="mt-2 flex justify-end gap-2">
        {#if model.canRevert && !reverted}
          <Button
            size="sm"
            variant="outline"
            class="h-7"
            disabled={busy}
            onclick={() => void revert()}
            data-testid="task-revert">{t('changes.revert')}</Button
          >
        {/if}
        {#if model.canRetry}
          <Button
            size="sm"
            variant="outline"
            class="h-7"
            disabled={busy}
            onclick={() => void retry()}
            data-testid="task-retry">{t('task.retry')}</Button
          >
        {/if}
        {#if model.canCancel}
          <Button
            size="sm"
            variant="outline"
            class="h-7"
            disabled={busy}
            onclick={() => void cancel()}
            data-testid="task-cancel">{t('task.cancel')}</Button
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}
