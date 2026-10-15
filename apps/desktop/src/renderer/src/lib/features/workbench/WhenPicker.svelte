<script lang="ts">
  import { t } from '$lib/i18n';
  import * as Select from '$lib/components/ui/select';
  import {
    DEFAULT_TIME,
    WEEK_DAY_ORDER,
    type RepeatKind,
    type RepeatPreset,
    type WhenDraft,
    type WhenMode,
    skipsShortMonths,
    toLocalInput,
  } from './when-presets';

  /**
   * 事项时间选择器（D90 §5.2）：不定 / 立即 / 某时 / 重复。重复只做预设（每天、工作日、
   * 每周几、每月几号 + 时刻），转 cron 与回显识别在 when-presets.ts；认不出的现有 cron
   * 只读显示（自定义 cron 属 P1）。「下次：…」由父组件算好传入。
   */
  let {
    draft = $bindable(),
    disabled = false,
    hasAssignee,
    next,
  }: { draft: WhenDraft; disabled?: boolean; hasAssignee: boolean; next: string } = $props();

  // 「某时」不能早于当前这一分钟；切换模式时刷新，免得抽屉开很久后下限过期。
  const minOnce = $derived.by(() => {
    void draft.mode;
    return toLocalInput(Date.now());
  });

  const MODES: WhenMode[] = ['none', 'now', 'once', 'repeat'];
  const MODE_LABEL = {
    none: 'workbench.drawer.whenNone',
    now: 'workbench.drawer.whenNow',
    once: 'workbench.drawer.whenOnce',
    repeat: 'workbench.drawer.whenRepeat',
  } as const;
  const KINDS: RepeatKind[] = ['daily', 'weekdays', 'weekly', 'monthly'];
  const KIND_LABEL = {
    daily: 'workbench.drawer.repeatDaily',
    weekdays: 'workbench.drawer.repeatWeekdays',
    weekly: 'workbench.drawer.repeatWeekly',
    monthly: 'workbench.drawer.repeatMonthly',
  } as const;
  const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

  function setMode(mode: WhenMode): void {
    draft = { ...draft, mode };
  }

  function setKind(value: string): void {
    const kind = value as RepeatKind;
    const time = draft.preset.time || DEFAULT_TIME;
    const preset: RepeatPreset =
      kind === 'weekly'
        ? { kind, days: draft.preset.kind === 'weekly' ? draft.preset.days : [1], time }
        : kind === 'monthly'
          ? { kind, day: draft.preset.kind === 'monthly' ? draft.preset.day : 1, time }
          : { kind, time };
    draft = { ...draft, preset };
  }

  function setTime(time: string): void {
    draft = { ...draft, preset: { ...draft.preset, time } as RepeatPreset };
  }

  function toggleDay(day: number): void {
    if (draft.preset.kind !== 'weekly') return;
    const days = draft.preset.days.includes(day)
      ? draft.preset.days.filter((item) => item !== day)
      : [...draft.preset.days, day];
    draft = { ...draft, preset: { kind: 'weekly', days, time: draft.preset.time } };
  }

  function setMonthDay(value: string): void {
    if (draft.preset.kind !== 'monthly') return;
    draft = { ...draft, preset: { kind: 'monthly', day: Number(value), time: draft.preset.time } };
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

  {#if draft.mode === 'once'}
    <input
      type="datetime-local"
      class="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
      bind:value={draft.onceLocal}
      min={minOnce}
      {disabled}
      aria-label={t('workbench.drawer.whenOnce')}
      data-testid="todo-when-once-input"
    />
  {:else if draft.mode === 'repeat'}
    {#if draft.customCron !== null}
      <p class="text-xs text-muted-foreground" data-testid="todo-when-custom">
        {t('workbench.drawer.customCron', { cron: draft.customCron })}
      </p>
    {:else}
      <div class="flex flex-wrap items-center gap-2">
        <Select.Root type="single" value={draft.preset.kind} onValueChange={setKind} {disabled}>
          <Select.Trigger
            class="w-32"
            aria-label={`${t('workbench.drawer.whenRepeat')}：${t(KIND_LABEL[draft.preset.kind])}`}
            data-testid="todo-when-repeat-kind"
          >
            {t(KIND_LABEL[draft.preset.kind])}
          </Select.Trigger>
          <Select.Content>
            {#each KINDS as kind (kind)}
              <Select.Item value={kind}>{t(KIND_LABEL[kind])}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        {#if draft.preset.kind === 'monthly'}
          <Select.Root
            type="single"
            value={String(draft.preset.day)}
            onValueChange={setMonthDay}
            {disabled}
          >
            <Select.Trigger
              class="w-24"
              aria-label={`${t('workbench.drawer.repeatMonthDay')}：${t('workbench.drawer.repeatDayOption', { n: draft.preset.day })}`}
              data-testid="todo-when-month-day"
            >
              {t('workbench.drawer.repeatDayOption', { n: draft.preset.day })}
            </Select.Trigger>
            <Select.Content>
              {#each MONTH_DAYS as day (day)}
                <Select.Item value={String(day)}>
                  {t('workbench.drawer.repeatDayOption', { n: day })}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        {/if}
        <input
          type="time"
          class="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
          value={draft.preset.time}
          oninput={(event) => setTime(event.currentTarget.value)}
          {disabled}
          aria-label={t('workbench.drawer.repeatTime')}
          data-testid="todo-when-time"
        />
      </div>
      {#if draft.preset.kind === 'weekly'}
        <div class="flex flex-wrap gap-1" data-testid="todo-when-weekdays">
          {#each WEEK_DAY_ORDER as day (day)}
            {@const on = draft.preset.days.includes(day)}
            <button
              type="button"
              aria-pressed={on}
              {disabled}
              class="cursor-pointer rounded-md border px-2 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 {on
                ? 'border-primary bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'}"
              onclick={() => toggleDay(day)}
              data-testid={`todo-when-day-${day}`}
            >
              {t(`workbench.weekday.${day}` as 'workbench.weekday.0')}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}

  {#if skipsShortMonths(draft)}
    <p class="text-xs text-muted-foreground" data-testid="todo-when-short-month">
      {t('workbench.drawer.monthShort')}
    </p>
  {/if}
  {#if !hasAssignee}
    <p class="text-xs text-muted-foreground" data-testid="todo-when-need-assignee">
      {t('workbench.drawer.needAssignee')}
    </p>
  {/if}
  <p class="text-xs text-muted-foreground" data-testid="todo-when-next">{next}</p>
</div>
