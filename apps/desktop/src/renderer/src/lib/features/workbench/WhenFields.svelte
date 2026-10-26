<script lang="ts">
  import { t } from '$lib/i18n';
  import * as Select from '$lib/components/ui/select';
  import {
    DEFAULT_TIME,
    WEEK_DAY_ORDER,
    type RepeatKind,
    type RepeatPreset,
    type WhenDraft,
    skipsShortMonths,
    toLocalInput,
  } from './when-presets';

  /**
   * 「某时 / 重复」的字段体，供工作台抽屉（WhenPicker）与看板改期气泡共用；
   * 模式切换按钮由各自的容器负责，这里只渲染当前模式需要的输入控件。
   */
  let {
    draft = $bindable(),
    mode,
    disabled = false,
  }: { draft: WhenDraft; mode: 'once' | 'repeat'; disabled?: boolean } = $props();

  // 「某时」不能早于当前这一分钟；切换模式时刷新，免得抽屉开很久后下限过期。
  const minOnce = $derived.by(() => {
    void mode;
    return toLocalInput(Date.now());
  });

  const KINDS: RepeatKind[] = ['daily', 'weekdays', 'weekly', 'monthly'];
  const KIND_LABEL = {
    daily: 'workbench.drawer.repeatDaily',
    weekdays: 'workbench.drawer.repeatWeekdays',
    weekly: 'workbench.drawer.repeatWeekly',
    monthly: 'workbench.drawer.repeatMonthly',
  } as const;
  const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

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

{#if mode === 'once'}
  <input
    type="datetime-local"
    class="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
    bind:value={draft.onceLocal}
    min={minOnce}
    {disabled}
    aria-label={t('workbench.drawer.whenOnce')}
    data-testid="todo-when-once-input"
  />
{:else}
  {#if draft.customCron !== null}
    <p class="text-xs text-muted-foreground" data-testid="todo-when-custom">
      {t('workbench.drawer.customCron', { cron: draft.customCron })}
    </p>
  {:else}
    <div class="flex flex-wrap items-center gap-2">
      <Select.Root type="single" value={draft.preset.kind} onValueChange={setKind} {disabled}>
        <Select.Trigger
          class="w-32"
          aria-label={t('common.labelValue', {
            label: t('workbench.drawer.whenRepeat'),
            value: t(KIND_LABEL[draft.preset.kind]),
          })}
          data-testid="todo-when-repeat-kind"
        >
          {t(KIND_LABEL[draft.preset.kind])}
        </Select.Trigger>
        <Select.Content class="z-[80]">
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
            aria-label={t('common.labelValue', {
              label: t('workbench.drawer.repeatMonthDay'),
              value: t('workbench.drawer.repeatDayOption', { n: draft.preset.day }),
            })}
            data-testid="todo-when-month-day"
          >
            {t('workbench.drawer.repeatDayOption', { n: draft.preset.day })}
          </Select.Trigger>
          <Select.Content class="z-[80]">
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

  {#if skipsShortMonths(draft)}
    <p class="text-xs text-muted-foreground" data-testid="todo-when-short-month">
      {t('workbench.drawer.monthShort')}
    </p>
  {/if}
{/if}
