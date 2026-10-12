<script lang="ts">
  import { BOT_HANDOVER_EVENT, type HandoverEventContent, type Message } from '@kepcup/shared';
  import { ArrowRightLeft } from '@lucide/svelte';
  import { t } from '$lib/i18n';

  /**
   * 交接记录（D88）：接手方私聊里的「从 {A} 接手了」（含交接要点）与移交方私聊里的
   * 「已移交给 {B}」。只读信息卡；同样的内容也进各自 Bot 的上下文。
   */
  let { message }: { message: Message } = $props();

  const content = $derived(
    message.content as { event?: string; text?: string; handover?: HandoverEventContent },
  );
  const received = $derived(content.event === BOT_HANDOVER_EVENT);
  const data = $derived(content.handover ?? null);
</script>

<div
  class="w-full max-w-[85%] rounded-lg border bg-background/80 p-3 text-sm"
  data-testid={received ? 'handover-received' : 'handover-handed-over'}
>
  {#if data === null}
    <p class="text-xs text-muted-foreground">{content.text ?? ''}</p>
  {:else}
    <div class="flex items-start gap-2">
      <ArrowRightLeft class="mt-0.5 size-4 shrink-0 text-sky-600" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="font-medium">
          {received
            ? t('handover.received', { from: data.fromBotName })
            : data.items.length > 0
              ? t('handover.handedOver', { to: data.toBotName })
              : t('handover.sharedWith', { to: data.toBotName })}
        </p>
        <ul class="mt-1 grid gap-0.5 text-xs text-muted-foreground">
          {#each data.items as line, index (index)}
            <li class="break-all">· {line}</li>
          {/each}
        </ul>
        {#if (data.kept ?? []).length > 0}
          <!-- 共享 / 复制的条目：移交方仍保留 -->
          <p class="mt-1 text-xs font-medium text-muted-foreground">
            {t('handover.keptTitle', { from: data.fromBotName })}
          </p>
          <ul class="grid gap-0.5 text-xs text-muted-foreground" data-testid="handover-kept">
            {#each data.kept ?? [] as line, index (index)}
              <li class="break-all">· {line}</li>
            {/each}
          </ul>
        {/if}
        {#if received && data.note.length > 0}
          <div class="mt-2 rounded-md bg-muted/60 p-2 text-xs" data-testid="handover-received-note">
            <p class="mb-0.5 font-medium text-muted-foreground">
              {t('handover.noteFrom', { from: data.fromBotName })}
            </p>
            <p class="break-all whitespace-pre-wrap">{data.note}</p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
