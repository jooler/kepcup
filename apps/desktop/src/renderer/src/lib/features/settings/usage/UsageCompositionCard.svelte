<script lang="ts">
  import type { UsageBotTotal, UsageLoopTotal } from '@kepcup/shared';
  import { i18n, t } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { formatCompact, formatFull } from './usage-format';
  import { loopLabel } from './usage-labels';

  /** 使用构成：按任务类型 / Bot 的 Token 拆分，条内再分输入与输出。 */
  let {
    byLoop,
    byBot,
  }: {
    byLoop: UsageLoopTotal[];
    byBot: UsageBotTotal[];
  } = $props();

  type Mode = 'loop' | 'bot';
  let mode = $state<Mode>('loop');
  const locale = $derived(i18n.locale);

  interface Row {
    key: string;
    label: string;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    calls: number;
  }

  const rows = $derived.by<Row[]>(() => {
    if (mode === 'loop') {
      return byLoop
        .filter((row) => row.tokens > 0)
        .map((row) => ({
          key: row.loopType,
          label: loopLabel(row.loopType),
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          tokens: row.tokens,
          calls: row.calls,
        }));
    }
    return byBot
      .filter((row) => row.tokens > 0)
      .map((row) => ({
        key: row.botId ?? '__global__',
        label: botName(row.botId),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        tokens: row.tokens,
        calls: row.calls,
      }));
  });

  const maxTokens = $derived(Math.max(1, ...rows.map((row) => row.tokens)));

  function botName(botId: string | null): string {
    if (botId === null) return t('settings.usageGlobalBots');
    const known = contacts.bots.find((bot) => bot.id === botId);
    return known ? known.name || botId : botId;
  }
</script>

<section class="rounded-lg border bg-card p-4" data-testid="usage-composition">
  <div class="flex flex-wrap items-center gap-2">
    <div>
      <h4 class="text-sm font-medium">{t('settings.usageComposition')}</h4>
      <p class="mt-0.5 text-xs text-muted-foreground">
        {mode === 'loop' ? t('settings.usageByLoopHint') : t('settings.usageByBotHint')}
      </p>
    </div>
    <div class="ml-auto inline-flex rounded-md border p-0.5" role="group">
      <button
        type="button"
        class="rounded px-2 py-1 text-xs transition-colors {mode === 'loop'
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={mode === 'loop'}
        data-testid="usage-composition-loop"
        onclick={() => (mode = 'loop')}>{t('settings.usageByLoop')}</button
      >
      <button
        type="button"
        class="rounded px-2 py-1 text-xs transition-colors {mode === 'bot'
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={mode === 'bot'}
        data-testid="usage-composition-bot"
        onclick={() => (mode = 'bot')}>{t('settings.usageByBot')}</button
      >
    </div>
  </div>

  <div class="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
    <span class="inline-flex items-center gap-1"
      ><span class="size-2 rounded-sm bg-blue-500"></span>{t('settings.usageInput')}</span
    >
    <span class="inline-flex items-center gap-1"
      ><span class="size-2 rounded-sm bg-emerald-500"></span>{t('settings.usageOutput')}</span
    >
  </div>

  {#if rows.length === 0}
    <p class="py-8 text-center text-xs text-muted-foreground" data-testid="usage-composition-empty">
      {t('settings.usageNoData')}
    </p>
  {:else}
    <ul class="mt-3 space-y-2.5" data-testid="usage-composition-rows">
      {#each rows as row (row.key)}
        <li
          class="flex items-center gap-3 text-xs"
          title={`${row.label} · ${formatFull(row.tokens, locale)} Token · ${row.calls} ${t('settings.usageCallsUnit')}`}
        >
          <span class="w-24 shrink-0 truncate">{row.label}</span>
          <span class="flex h-2 min-w-0 flex-1 items-stretch overflow-hidden rounded-full bg-muted">
            <span class="h-full bg-blue-500" style={`width:${(row.inputTokens / maxTokens) * 100}%`}
            ></span>
            <span
              class="h-full bg-emerald-500"
              style={`width:${(row.outputTokens / maxTokens) * 100}%`}
            ></span>
          </span>
          <span class="w-16 shrink-0 text-right text-muted-foreground tabular-nums"
            >{formatCompact(row.tokens, locale)}</span
          >
          <span class="w-12 shrink-0 text-right text-muted-foreground tabular-nums"
            >{row.calls} {t('settings.usageCallsUnit')}</span
          >
        </li>
      {/each}
    </ul>
  {/if}
</section>
