<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { ClipboardList } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { Button } from '$lib/components/ui/button';
  import { parseDispatchText } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 派发卡（D90 §4.4）：工作台代用户发出的事项派发消息（`origin = 'workbench'` 的 user 消息）。
   * 标题、说明（最多 6 行）、「在工作台查看」→ 切到工作台并打开该事项。正文格式
   * `【工作台】标题` + 空行 + 说明，管家建的事项标题行末尾有「（管家代你安排）」，补发迟到时末尾有
   * 「（原定 X，延迟派发）」，见 parseDispatchText；管家徽标优先用 `content.viaButler`（触发这次派发的是管家），`butlerDrafted` 只作弱标注。
   */
  let { message }: { message: Message } = $props();

  const text = $derived('text' in message.content ? message.content.text : '');
  const parsed = $derived(parseDispatchText(text));
  // 管家徽标优先看 content.viaButler（core 写入），没有该字段再用正文里的标注兜底。
  const viaButler = $derived(
    'viaButler' in message.content && typeof message.content.viaButler === 'boolean'
      ? message.content.viaButler
      : parsed.byButler,
  );
  // 事项由管家起草过（但这次派发不是管家触发的）：次要标注，比「管家代你安排」弱。
  const butlerDrafted = $derived(
    !viaButler && 'butlerDrafted' in message.content && message.content.butlerDrafted === true,
  );
  const todoId = $derived(
    'todoId' in message.content && typeof message.content.todoId === 'string'
      ? message.content.todoId
      : null,
  );
</script>

<div
  class="w-full max-w-[85%] rounded-lg border bg-background/80 p-3 text-sm"
  data-testid="dispatch-card"
  data-todo-id={todoId ?? ''}
>
  <div class="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
    <ClipboardList class="size-3.5" aria-hidden="true" />
    <span data-testid="dispatch-card-label">{t('workbench.dispatch.label')}</span>
    {#if butlerDrafted}
      <span class="opacity-70" data-testid="dispatch-card-drafted"
        >· {t('workbench.dispatch.drafted')}</span
      >
    {/if}
    {#if viaButler}
      <span data-testid="dispatch-card-butler">· {t('workbench.dispatch.byButler')}</span>
    {/if}
  </div>
  <p class="font-medium break-words" data-testid="dispatch-card-title">
    {parsed.title.length > 0 ? parsed.title : t('workbench.dispatch.untitled')}
  </p>
  {#if parsed.notes.length > 0}
    <p
      class="mt-1 line-clamp-6 text-xs break-words whitespace-pre-wrap text-muted-foreground"
      data-testid="dispatch-card-notes"
    >
      {parsed.notes}
    </p>
  {/if}
  {#if parsed.lateNote !== null}
    <p class="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="dispatch-card-late">
      {parsed.lateNote}
    </p>
  {/if}
  {#if todoId !== null && !narrowLayout.narrow}
    <div class="mt-2 flex justify-end">
      <Button
        size="xs"
        variant="ghost"
        onclick={() => workbench.focusTodo(todoId)}
        data-testid="dispatch-card-view"
      >
        {t('workbench.dispatch.view')}
      </Button>
    </div>
  {/if}
</div>
