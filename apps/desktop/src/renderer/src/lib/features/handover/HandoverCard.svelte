<script lang="ts">
  import {
    HANDOVER_RESP_FROM_KEY,
    HANDOVER_RESP_TO_KEY,
    botHandoverPayloadSchema,
    defaultHandoverKeys,
    describeScheduleWhen,
    selectableHandoverKeys,
    type Approval,
    type HandoverCardItem,
    type HandoverItemStatus,
  } from '@kepcup/shared';
  import {
    ArrowRightLeft,
    CheckCircle2,
    CircleSlash,
    Loader2,
    AlertTriangle,
    XCircle,
  } from '@lucide/svelte';
  import { t, type MessageKey, listSeparator } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { handovers } from '$lib/stores/handovers.svelte';
  import { Button } from '$lib/components/ui/button';
  import { decisionBinding } from '../approvals/approval-effect';
  import RetireBotButton from './RetireBotButton.svelte';

  /**
   * 移交卡（D88，docs/design/37 §2.2）：头部「A → B」或「A → 新建 B」（新 Bot 的字段与
   * 模型折叠展示）；资产按类型分组、逐项勾选（动作标签、会发生什么、风险提示；不可执行的
   * 置灰并写明原因）；职责改写前后对照、可单独勾掉；交接要点只读。确认后卡片转为执行
   * 进度（`handover.updated` 逐项打勾），结束后显示完成 / 部分未完成与原因。
   * 待确认的交互卡在 dock 里（variant='card'），消息流里是折叠记录 / 进度。
   * P1：技能标「外部导入」（确认即授权）、记忆标「敏感」且默认不勾。
   * P2：Wiki（整本 / 目录 / 页）与 Bot 级组件在后台复制——完成前条目显示「后台复制中」、
   * 卡片保持「执行中」；完成后显示复制了多少、因同路径没覆盖的页；全部完成时给出「删除
   * {A}」（core 的 `view.retire`，走 D18 删除确认）。
   */
  let {
    approval,
    autofocus = false,
    variant = 'card',
  }: { approval: Approval; autofocus?: boolean; variant?: 'card' | 'folded' } = $props();

  const pending = $derived(approval.status === 'pending');
  const payload = $derived.by(() => {
    const parsed = botHandoverPayloadSchema.safeParse(approval.payload);
    return parsed.success ? parsed.data : null;
  });
  const toName = $derived(
    payload === null
      ? ''
      : payload.target.kind === 'new'
        ? payload.target.bot.name
        : payload.target.botName,
  );
  const direction = $derived(
    payload === null
      ? ''
      : t(payload.target.kind === 'new' ? 'handover.directionNew' : 'handover.direction', {
          from: payload.fromBotName,
          to: toName,
        }),
  );

  /**
   * Keys the user flipped away from the card's default (default: every selectable item
   * except the ones marked `defaultSelected: false` — sensitive memories).
   */
  let toggled = $state<string[]>([]);
  const selectable = $derived(payload !== null ? selectableHandoverKeys(payload) : []);
  const defaults = $derived(payload !== null ? defaultHandoverKeys(payload) : []);
  const kept = $derived(
    selectable.filter((key) => defaults.includes(key) !== toggled.includes(key)),
  );
  const createsBot = $derived(payload?.target.kind === 'new');

  function toggle(key: string): void {
    toggled = toggled.includes(key) ? toggled.filter((k) => k !== key) : [...toggled, key];
  }

  /** Assets grouped by type, in the card's order. */
  const groups = $derived.by(() => {
    const result: Array<[string, HandoverCardItem[]]> = [];
    for (const item of payload?.items ?? []) {
      const group = result.find(([type]) => type === item.assetType);
      if (group !== undefined) group[1].push(item);
      else result.push([item.assetType, [item]]);
    }
    return result;
  });

  // 执行进度：确认后按 approvalId 读执行视图，handover.updated 推送重绘。
  $effect(() => {
    if (!pending) void handovers.ensure(approval.id);
  });
  const view = $derived(handovers.byApproval[approval.id] ?? null);
  const status = $derived(
    view?.status ??
      (approval.status === 'pending'
        ? 'proposed'
        : approval.status === 'denied'
          ? 'denied'
          : approval.status === 'cancelled'
            ? 'cancelled'
            : approval.status === 'failed'
              ? 'partial'
              : 'applying'),
  );
  function itemStatus(key: string): HandoverItemStatus | 'notSelected' | null {
    if (pending) return null;
    if (view === null) return approval.status === 'approved' ? 'pending' : null;
    return view.items.find((item) => item.key === key)?.status ?? 'notSelected';
  }
  function itemError(key: string): string | null {
    return view?.items.find((item) => item.key === key)?.error ?? null;
  }
  /** P2 copy summary of a decided wiki / widget item. */
  function copySummary(key: string): { copied: number | null; skipped: string[] } {
    const item = view?.items.find((entry) => entry.key === key);
    return { copied: item?.copiedCount ?? null, skipped: item?.skippedPaths ?? [] };
  }
  function isBackground(key: string): boolean {
    return key.startsWith('wiki:') || key.startsWith('widget:');
  }
  const retire = $derived(!pending && view !== null ? (view.retire ?? null) : null);
  const newBotStatus = $derived(createsBot && !pending ? itemStatus('bot:new') : null);

  /** Pending: the local choice; decided: whether the item ran. */
  function checked(key: string): boolean {
    if (pending) return kept.includes(key);
    const state = itemStatus(key);
    return state !== null && state !== 'notSelected';
  }

  const boundHash = $derived(decisionBinding(approval).payloadHash);
  const canConfirm = $derived(kept.length > 0 || createsBot);

  function approve(): void {
    if (!canConfirm) return;
    void permissions.decide(approval.id, true, undefined, undefined, boundHash, undefined, kept);
  }

  function deny(): void {
    void permissions.decide(approval.id, false, undefined, undefined, boundHash);
  }

  let cardEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (autofocus && pending && cardEl) cardEl.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (!pending || event.target !== cardEl) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      approve();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      deny();
    }
  }

  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function routineWhen(routine: { when: string; timezone: string | null }): string {
    const iso = /^\d{4}-\d{2}-\d{2}/.test(routine.when) ? Date.parse(routine.when) : NaN;
    return Number.isNaN(iso)
      ? describeScheduleWhen(
          {
            kind: 'cron',
            cron: routine.when,
            runAt: null,
            timezone: routine.timezone ?? localTimeZone,
          },
          { localTimeZone },
        )
      : describeScheduleWhen(
          { kind: 'once', runAt: iso, cron: null, timezone: localTimeZone },
          { now: Date.now() },
        );
  }

  const statusTone = $derived(
    status === 'completed'
      ? 'text-emerald-700 dark:text-emerald-400'
      : status === 'partial' || status === 'failed'
        ? 'text-destructive'
        : 'text-muted-foreground',
  );
</script>

{#snippet statusIcon(state: HandoverItemStatus | 'notSelected' | null)}
  {#if state === 'done'}
    <CheckCircle2 class="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
  {:else if state === 'failed'}
    <XCircle class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
  {:else if state === 'skipped'}
    <AlertTriangle class="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
  {:else if state === 'notSelected'}
    <CircleSlash class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  {:else if state === 'pending'}
    <Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
  {/if}
{/snippet}

{#snippet itemRow(
  key: string,
  title: string,
  detail: string,
  blocked: string | undefined,
  extra: string[],
  marks: string[],
)}
  {@const state = itemStatus(key)}
  <li>
    <label
      class="flex items-start gap-2 rounded-md border bg-background/60 p-2 {blocked !== undefined
        ? 'opacity-60'
        : pending
          ? 'cursor-pointer'
          : ''}"
      data-testid={`handover-item-${key}`}
      data-blocked={blocked !== undefined ? 'true' : undefined}
    >
      {#if pending}
        <input
          type="checkbox"
          class="mt-0.5"
          checked={blocked === undefined && checked(key)}
          disabled={blocked !== undefined}
          onchange={() => toggle(key)}
          data-testid={`handover-item-check-${key}`}
        />
      {:else}
        <span class="mt-0.5" data-testid={`handover-item-status-${key}`} data-status={state ?? ''}>
          {@render statusIcon(blocked !== undefined ? 'notSelected' : state)}
        </span>
      {/if}
      <span class="grid min-w-0 gap-0.5">
        <span class="break-all"
          >{title}{#each marks as mark (mark)}<span
              class="ml-1.5 inline-block rounded px-1 py-px align-middle text-[10px] {mark ===
              'sensitive'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-sky-500/10 text-sky-700 dark:text-sky-400'}"
              data-testid={`handover-mark-${mark}`}>{t(`handover.mark.${mark}` as MessageKey)}</span
            >{/each}</span
        >
        {#if detail.length > 0}<span class="text-xs whitespace-pre-wrap text-muted-foreground"
            >{detail}</span
          >{/if}
        {#each extra as line, index (index)}
          <span class="text-xs text-amber-700 dark:text-amber-400">{line}</span>
        {/each}
        {#if blocked !== undefined}
          <span class="text-xs text-muted-foreground" data-testid="handover-item-blocked"
            >{t('handover.blocked', { reason: blocked })}</span
          >
        {:else if !pending && state === 'pending' && isBackground(key) && status === 'applying'}
          <span class="text-xs text-muted-foreground" data-testid="handover-item-background"
            >{t('handover.item.background')}</span
          >
        {:else if !pending && state !== null && state !== 'done' && state !== 'pending'}
          <span
            class="text-xs {state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}"
            data-testid="handover-item-error"
            >{state === 'notSelected'
              ? t('handover.item.notSelected')
              : itemError(key) === null
                ? t(`handover.item.${state}` as MessageKey)
                : t('common.labelValue', {
                    label: t(`handover.item.${state}` as MessageKey),
                    value: itemError(key)!,
                  })}</span
          >
        {/if}
        {#if !pending && state === 'done' && isBackground(key)}
          {@const summary = copySummary(key)}
          {#if summary.copied !== null}
            <span class="text-xs text-muted-foreground" data-testid="handover-item-copied"
              >{t(
                key.startsWith('wiki:')
                  ? 'handover.item.copiedPages'
                  : 'handover.item.copiedVersions',
                { count: summary.copied },
              )}</span
            >
          {/if}
          {#if summary.skipped.length > 0}
            <span
              class="text-xs break-all text-amber-700 dark:text-amber-400"
              data-testid="handover-item-skipped-paths"
              >{t('handover.item.skippedPaths', {
                paths: summary.skipped.join(listSeparator()),
              })}</span
            >
          {/if}
        {/if}
      </span>
    </label>
  </li>
{/snippet}

{#if payload === null}
  <div class="mx-auto w-full max-w-3xl px-3 py-1 text-xs text-muted-foreground">
    {t('handover.title')}
  </div>
{:else if variant === 'folded' && (pending || status === 'denied' || status === 'cancelled')}
  <!-- 消息流里的折叠记录：待确认的交互卡在 dock 里 -->
  <div
    class="mx-auto flex w-full max-w-3xl items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
    data-testid={`approval-record-${approval.id}`}
    data-approval-status={approval.status}
    data-approval-kind="bot_handover"
  >
    <ArrowRightLeft class="size-3.5 shrink-0" aria-hidden="true" />
    <span>{t('handover.title')} · {direction}</span>
    <span class="shrink-0" data-testid="handover-status" data-status={status}
      >{t(`handover.status.${status}` as MessageKey)}</span
    >
  </div>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={cardEl}
    onkeydown={onKeydown}
    tabindex={pending ? 0 : -1}
    role="group"
    class="mx-auto w-full max-w-3xl rounded-lg border-2 p-3 text-sm shadow-sm outline-none {pending
      ? 'border-amber-500/70 bg-amber-50/60 focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-amber-950/30'
      : 'border-border bg-background/80'}"
    data-testid={pending ? `approval-card-${approval.id}` : `handover-progress-${approval.id}`}
    data-approval-kind="bot_handover"
    data-approval-status={approval.status}
  >
    <div class="mb-2 flex items-center gap-2 font-medium">
      <ArrowRightLeft class="size-4 text-amber-600" aria-hidden="true" />
      <span>{t('handover.title')}</span>
      <span class="min-w-0 truncate font-normal" data-testid="handover-direction">{direction}</span>
      {#if !pending}
        <span
          class="ml-auto shrink-0 text-xs {statusTone}"
          data-testid="handover-status"
          data-status={status}>{t(`handover.status.${status}` as MessageKey)}</span
        >
      {/if}
    </div>
    {#if payload.note.length > 0}
      <p class="mb-2 text-xs text-muted-foreground">{payload.note}</p>
    {/if}

    {#if payload.target.kind === 'new'}
      {@const bot = payload.target.bot}
      <details class="mb-2 rounded-md border bg-background/60 p-2" data-testid="handover-new-bot">
        <summary class="flex cursor-pointer items-center gap-2">
          {#if newBotStatus !== null}{@render statusIcon(newBotStatus)}{/if}
          <span class="font-medium">{t('handover.newBotItem', { name: bot.name })}</span>
          <span class="text-xs text-muted-foreground">{t('handover.newBotDetails')}</span>
        </summary>
        <div class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {#if bot.bio.length > 0}
            <span class="text-muted-foreground">{t('handover.bio')}</span>
            <span>{bot.bio}</span>
          {/if}
          <span class="text-muted-foreground">{t('approvals.butlerResponsibilities')}</span>
          <span class="break-all">{bot.responsibilities}</span>
          <span class="text-muted-foreground">{t('handover.model')}</span>
          <span data-testid="handover-new-bot-model">{bot.modelLabel || bot.model}</span>
          {#if bot.routines.length > 0}
            <span class="text-muted-foreground">{t('handover.routines')}</span>
            <span class="grid gap-0.5">
              {#each bot.routines as routine, index (index)}
                <span
                  >{t('approvals.butlerRoutine', {
                    when: routineWhen(routine),
                    title: routine.title,
                  })}</span
                >
              {/each}
            </span>
          {/if}
        </div>
        {#if newBotStatus === 'failed' && itemError('bot:new') !== null}
          <p class="mt-1 text-xs text-destructive">{itemError('bot:new')}</p>
        {/if}
      </details>
    {/if}

    {#each groups as [type, items] (type)}
      <div class="mb-2" data-testid={`handover-group-${type}`}>
        <p class="mb-1 text-xs font-medium text-muted-foreground">
          {t(`handover.group.${type}` as MessageKey)}
        </p>
        <ul class="grid gap-1.5 {items.length > 8 ? 'max-h-80 overflow-y-auto pr-1' : ''}">
          {#each items as item (item.key)}
            {@render itemRow(
              item.key,
              item.label,
              item.detail,
              item.blocked,
              item.blocked === undefined ? item.warnings : [],
              item.marks,
            )}
          {/each}
        </ul>
      </div>
    {/each}

    {#if payload.responsibilities?.to !== undefined || payload.responsibilities?.from !== undefined}
      {@const resp = payload.responsibilities}
      <div class="mb-2" data-testid="handover-responsibilities">
        <p class="mb-1 text-xs font-medium text-muted-foreground">
          {t('handover.responsibilities')}
        </p>
        <ul class="grid gap-1.5">
          {#if resp?.to !== undefined}
            {@render itemRow(
              HANDOVER_RESP_TO_KEY,
              t('handover.respTo', { name: toName }),
              `${t('common.labelValue', { label: t('handover.before'), value: resp.toBefore || t('handover.emptyText') })}\n${t('common.labelValue', { label: t('handover.after'), value: resp.to })}`,
              undefined,
              [],
              [],
            )}
          {/if}
          {#if resp?.from !== undefined}
            {@render itemRow(
              HANDOVER_RESP_FROM_KEY,
              t('handover.respFrom', { name: payload.fromBotName }),
              `${t('common.labelValue', { label: t('handover.before'), value: resp.fromBefore || t('handover.emptyText') })}\n${t('common.labelValue', { label: t('handover.after'), value: resp.from })}`,
              undefined,
              [],
              [],
            )}
          {/if}
        </ul>
      </div>
    {/if}

    {#if payload.handoverNote.length > 0}
      <div class="mb-2 rounded-md bg-muted/60 p-2 text-xs" data-testid="handover-note">
        <p class="mb-0.5 font-medium text-muted-foreground">
          {t('handover.note', { name: toName })}
        </p>
        <p class="break-all whitespace-pre-wrap">{payload.handoverNote}</p>
      </div>
    {/if}

    <p class="text-[11px] text-muted-foreground">{t('handover.notTransferred')}</p>

    {#if retire !== null}
      <RetireBotButton
        botId={retire.botId}
        botName={retire.botName}
        toBotId={view?.toBotId ?? ''}
        remaining={retire.remaining ?? { memory: 0, wikiPages: 0, skills: 0, widgets: 0 }}
      />
    {/if}

    {#if pending}
      <p class="mt-1 text-xs text-muted-foreground">{t('handover.hint')}</p>
      <div class="mt-3 flex items-center gap-2">
        <Button size="sm" onclick={approve} disabled={!canConfirm} data-testid="approval-approve"
          >{t('handover.confirm')}</Button
        >
        <Button size="sm" variant="outline" onclick={deny} data-testid="approval-deny"
          >{t('approvals.deny')}</Button
        >
      </div>
    {/if}
  </div>
{/if}
