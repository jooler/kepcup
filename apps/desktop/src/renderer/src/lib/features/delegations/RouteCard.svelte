<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Compass } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 管家路由卡（D70 §2.4，event = route_suggestion）：建议这件事交给谁。
   * 「去聊 / 打开群」一键跳转；「交给它处理」（delegate）以一条用户消息
   * 让管家去委派——早期产品「先卡后办」，用户不点就不会在后台代办。
   */
  let { message }: { message: Message } = $props();

  const content = $derived(
    message.content as {
      text?: string;
      route?: { kind: 'bot' | 'group' | 'delegate'; botId?: string; conversationId?: string };
    },
  );
  const route = $derived(content.route ?? null);
  const botName = $derived(route?.botId ? chat.botName(route.botId) : '');
  const groupTitle = $derived(
    route?.conversationId
      ? (chat.conversations.find((c) => c.id === route.conversationId)?.title ?? '')
      : '',
  );
  let accepting = $state(false);
  let accepted = $state(false);

  async function openBot(): Promise<void> {
    if (route?.botId) await chat.openDirect(route.botId);
  }

  async function openGroup(): Promise<void> {
    if (route?.conversationId) await chat.select(route.conversationId);
  }

  async function accept(): Promise<void> {
    accepting = true;
    try {
      await core.call('butler.acceptRoute', { messageId: message.id });
      accepted = true;
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('chats.errorCode.INTERNAL')));
    } finally {
      accepting = false;
    }
  }
</script>

<div
  class="w-full max-w-[85%] rounded-lg border bg-background/80 p-3 text-sm"
  data-testid={`route-card-${message.id}`}
  data-route-kind={route?.kind ?? ''}
>
  <div class="flex items-start gap-2">
    <Compass class="mt-0.5 size-4 shrink-0 text-violet-600" aria-hidden="true" />
    <p class="whitespace-pre-wrap">{content.text ?? ''}</p>
  </div>
  {#if route !== null}
    <div class="mt-2 flex flex-wrap justify-end gap-2">
      {#if route.kind === 'group'}
        <Button size="sm" class="h-7" onclick={() => void openGroup()} data-testid="route-open-group"
          >{t('route.openGroup', { name: groupTitle })}</Button
        >
      {:else if route.kind === 'bot'}
        <Button size="sm" class="h-7" onclick={() => void openBot()} data-testid="route-open-bot"
          >{t('route.openBot', { name: botName })}</Button
        >
      {:else}
        <Button
          size="sm"
          variant="outline"
          class="h-7"
          onclick={() => void openBot()}
          data-testid="route-open-bot">{t('route.chatMyself', { name: botName })}</Button
        >
        <Button
          size="sm"
          class="h-7"
          disabled={accepting || accepted}
          onclick={() => void accept()}
          data-testid="route-accept"
          >{accepted ? t('route.accepted') : t('route.delegate', { name: botName })}</Button
        >
      {/if}
    </div>
  {/if}
</div>
