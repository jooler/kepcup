<script lang="ts">
  /**
   * D115 任务直注注入坞（docs/design/56 §1，设计 42「注入坞」小节）：任务详情页
   * 最底部的自由文本入口，经 `tasks.inject` 直达 `TaskHost.injectById`——与对话
   * 轮的 `inject_task` 同一机制，语义零改动。仅非终态任务渲染（调用方守卫）；
   * delivered / queued / 失败都以 toast 反馈，运行中的指令随即以「追加指令」
   * steer 气泡出现在时间线里。任务在等提问时注入即回答（core 内部转
   * #resolveQuestion），给出提示行与上方提问卡并存：结构化选项走卡，自由文本
   * 走这里。
   */
  import { Send } from '@lucide/svelte';
  import { TASK_INSTRUCTION_MAX_CHARS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { errorText } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { tasks } from '$lib/stores/tasks.svelte';

  let { taskId, awaitingInput = false }: { taskId: string; awaitingInput?: boolean } = $props();

  let text = $state('');
  let sending = $state(false);

  const canSend = $derived(text.trim().length > 0 && !sending);

  async function send(): Promise<void> {
    const instruction = text.trim();
    if (instruction.length === 0 || sending) return;
    sending = true;
    try {
      const delivery = await tasks.inject(taskId, instruction);
      text = '';
      if (delivery === 'queued') {
        // queued 有两种成因（外部智能体拒绝 steer / 任务已在收尾），条目只存
        // 二值 delivery，渲染端区分不了——用中性文案，两种成因下都准确。
        toast.warning(t('task.run.injectQueued'));
      } else {
        toast.success(t('task.run.injectSent'));
      }
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('task.run.injectFailed')),
      );
    } finally {
      sending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }
</script>

<div class="shrink-0 border-t px-4 py-2" data-testid="task-run-inject">
  <div class="mx-auto w-full max-w-3xl">
    {#if awaitingInput}
      <p class="mb-1 text-xs text-amber-700 dark:text-amber-400" data-testid="task-run-inject-hint">
        {t('task.run.injectHintAwaiting')}
      </p>
    {/if}
    <div class="flex items-end gap-2">
      <Textarea
        bind:value={text}
        class="max-h-40 min-h-9 flex-1 resize-none py-2"
        rows={1}
        maxlength={TASK_INSTRUCTION_MAX_CHARS}
        placeholder={t('task.run.injectPlaceholder')}
        onkeydown={onKeydown}
        disabled={sending}
        data-testid="task-run-inject-input"
      ></Textarea>
      <Button
        size="icon"
        class="size-9 shrink-0"
        onclick={() => void send()}
        disabled={!canSend}
        title={t('task.run.injectSend')}
        aria-label={t('task.run.injectSend')}
        data-testid="task-run-inject-send"
      >
        <Send class="size-4" aria-hidden="true" />
      </Button>
    </div>
  </div>
</div>
