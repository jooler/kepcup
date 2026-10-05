<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Check, FolderOpen, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';

  /**
   * 对话内群创建的问题卡（docs/design/19 D60）：四问（名称 / 主要事务 /
   * 成员 / 工作目录）全部由 core 确定性下发、零模型调用。卡片按 content.step
   * 渲染对应表单；作答落 setupAnswer 消息（不渲染气泡），卡片收起为已答行；
   * 未答卡带「放弃创建」（级联删除该对话）。
   */
  let { message }: { message: Message } = $props();

  const question = $derived(
    message.kind === 'system_event' && 'text' in message.content ? message.content.text : '',
  );
  const step = $derived(
    message.kind === 'system_event' && 'step' in message.content
      ? (message.content.step ?? '')
      : '',
  );

  const conversationId = $derived(chat.current?.conversation.id);
  const creating = $derived(chat.current?.conversation.setupState === 'creating');

  // 已答判定与访谈卡一致：卡片之后的第一条用户文本消息。
  const answeredText = $derived.by(() => {
    for (const m of chat.current?.messages ?? []) {
      if (m.seq <= message.seq || m.senderType !== 'user' || m.kind !== 'text') continue;
      if (m.status === 'recalled') continue;
      return 'text' in m.content ? m.content.text : '';
    }
    return null;
  });
  const interactive = $derived(answeredText === null && creating && step.length > 0);

  let text = $state('');
  let selected = $state<string[]>([]);
  let submitting = $state(false);

  const textValid = $derived(
    (step === 'title' && text.trim().length > 0) || (step === 'purpose' && text.trim().length > 0),
  );
  const membersValid = $derived(step === 'members' && selected.length >= 2);

  function toggle(botId: string, checked: boolean): void {
    selected = checked ? [...selected, botId] : selected.filter((id) => id !== botId);
  }

  async function submit(value: string | string[] | null): Promise<void> {
    if (submitting || !interactive || conversationId === undefined) return;
    submitting = true;
    try {
      await chat.answerGroupSetup(
        conversationId,
        step as 'title' | 'purpose' | 'members' | 'project',
        value,
      );
    } finally {
      submitting = false;
    }
  }

  async function pickDirectory(): Promise<void> {
    if (submitting || !interactive) return;
    const path = await window.kepcup.platform.selectDirectory();
    if (path === null) return;
    await submit(path);
  }

  function cancel(): void {
    if (conversationId !== undefined) void chat.cancelGroupSetup(conversationId);
  }
</script>

<div
  class="flex w-full max-w-[50%] flex-col gap-2 rounded-[22px] bg-muted px-4 py-3"
  data-testid="group-setup-card"
  data-step={step}
  data-answered={answeredText === null ? 'false' : 'true'}
>
  <div class="text-sm font-medium" data-testid="group-setup-question">{question}</div>
  {#if answeredText !== null}
    <div
      class="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-background px-3 py-2 text-sm"
      data-testid="group-setup-answer"
    >
      <span class="min-w-0 truncate" title={answeredText}>{answeredText}</span>
      <Check class="size-4 shrink-0 text-primary" aria-hidden="true" />
    </div>
  {:else if step === 'title' || step === 'purpose'}
    <div class="flex items-center gap-2">
      <Input
        bind:value={text}
        placeholder={step === 'title'
          ? t('group.namePlaceholder')
          : t('groupSetup.purposePlaceholder')}
        disabled={submitting}
        class="h-9 bg-background"
        data-testid="group-setup-input"
        onkeydown={(event) => {
          if (event.key === 'Enter' && textValid) {
            event.preventDefault();
            void submit(text.trim());
          }
        }}
      />
      <Button
        size="sm"
        class="h-9 shrink-0"
        disabled={submitting || !textValid}
        onclick={() => void submit(text.trim())}
        data-testid="group-setup-submit"
      >
        {t('groupSetup.confirm')}
      </Button>
    </div>
  {:else if step === 'members'}
    <div
      class="max-h-56 space-y-1 overflow-y-auto rounded-lg border bg-background p-2"
      data-testid="group-setup-members"
    >
      {#each contacts.bots as bot (bot.id)}
        <label class="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
          <Checkbox
            checked={selected.includes(bot.id)}
            onCheckedChange={(checked) => toggle(bot.id, checked === true)}
            data-testid={`group-setup-member-${bot.id}`}
          />
          <span>{bot.name}</span>
          <span class="truncate text-xs text-muted-foreground">{bot.bio}</span>
        </label>
      {/each}
    </div>
    <Button
      size="sm"
      class="h-9"
      disabled={submitting || !membersValid}
      onclick={() => void submit([...selected])}
      data-testid="group-setup-submit"
    >
      {t('groupSetup.confirm')}
    </Button>
  {:else if step === 'project'}
    <div class="flex gap-2">
      <Button
        size="sm"
        class="h-9 gap-1.5"
        disabled={submitting}
        onclick={() => void pickDirectory()}
        data-testid="group-setup-pick"
      >
        <FolderOpen class="size-4" aria-hidden="true" />
        {t('chats.setupPathPick')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="h-9"
        disabled={submitting}
        onclick={() => void submit(null)}
        data-testid="group-setup-skip"
      >
        {t('chats.setupPathSkip')}
      </Button>
    </div>
  {/if}
  {#if creating && answeredText === null}
    <button
      type="button"
      class="flex items-center gap-1 self-start text-xs text-muted-foreground transition-colors hover:text-destructive"
      onclick={cancel}
      data-testid="group-setup-cancel"
    >
      <X class="size-3" aria-hidden="true" />
      {t('groupSetup.cancel')}
    </button>
  {/if}
</div>
