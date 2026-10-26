<script lang="ts">
  import { t } from '$lib/i18n';
  import WhenFields from './WhenFields.svelte';
  import { type WhenDraft, type WhenMode } from './when-presets';

  /**
   * 事项时间选择器（D90 §5.2）：不定 / 立即 / 某时 / 重复。重复只做预设（每天、工作日、
   * 每周几、每月几号 + 时刻），转 cron 与回显识别在 when-presets.ts；认不出的现有 cron
   * 只读显示（自定义 cron 属 P1）。「下次：…」由父组件算好传入。字段体在 WhenFields。
   */
  let {
    draft = $bindable(),
    disabled = false,
    hasAssignee,
    next,
  }: { draft: WhenDraft; disabled?: boolean; hasAssignee: boolean; next: string } = $props();

  const MODES: WhenMode[] = ['none', 'now', 'once', 'repeat'];
  const MODE_LABEL = {
    none: 'workbench.drawer.whenNone',
    now: 'workbench.drawer.whenNow',
    once: 'workbench.drawer.whenOnce',
    repeat: 'workbench.drawer.whenRepeat',
  } as const;

  function setMode(mode: WhenMode): void {
    draft = { ...draft, mode };
  }
</script>

<div class="space-y-2" data-testid="todo-when">
  <div
    class="inline-flex rounded-lg border bg-muted/40 p-0.5"
    role="radiogroup"
    aria-label={t('workbench.drawer.fieldWhen')}
  >
    {#each MODES as mode (mode)}
      <button
        type="button"
        role="radio"
        aria-checked={draft.mode === mode}
        disabled={disabled || (mode !== 'none' && !hasAssignee)}
        class="cursor-pointer rounded-md px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 {draft.mode ===
        mode
          ? 'bg-background font-medium shadow-sm'
          : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => setMode(mode)}
        data-testid={`todo-when-${mode}`}
      >
        {t(MODE_LABEL[mode])}
      </button>
    {/each}
  </div>

  {#if draft.mode === 'once' || draft.mode === 'repeat'}
    <WhenFields bind:draft mode={draft.mode} {disabled} />
  {/if}

  {#if !hasAssignee}
    <p class="text-xs text-muted-foreground" data-testid="todo-when-need-assignee">
      {t('workbench.drawer.needAssignee')}
    </p>
  {/if}
  <p class="text-xs text-muted-foreground" data-testid="todo-when-next">{next}</p>
</div>
