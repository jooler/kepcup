<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Check, FolderOpen } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from './chat-session-context';
  import { teamContext } from '$lib/features/team/team-context.svelte';
  import TeamWorkdirPicker from '$lib/features/team/TeamWorkdirPicker.svelte';

  /**
   * 初始化访谈的工作目录卡（docs/design/19 D59）：首问作答后由 core 确定性
   * 插入（不经 LLM），闸门在它作答前扣下一切投递。未答态提供「选择目录…」
   * 与「暂不设置」两个出口；已答态与 SetupQuestionCard 同构——展示首条后续
   * 用户消息（setupAnswer 标记）为已答行。
   *
   * 来源路由（member-bots B4）：本机会话走原生目录选择器（现行为不变）；团队
   * 来源的路径必须落在服务端允许集合内（B-10），改为 TeamWorkdirPicker 的
   * 选项集选择（answerPath 经 chat 按来源路由，服务端校验越界）。团队判定
   * 含 web 团队端点（session.source 恒 'local'，但同源 core 就是团队服务器，
   * 审查修正）——成员本机原生选择器选出的任意路径必被服务端拒。
   */
  let { message }: { message: Message } = $props();
  const session = getChatSession();

  const question = $derived(
    message.kind === 'system_event' && 'text' in message.content ? message.content.text : '',
  );
  const isTeamSource = $derived(session.source !== 'local' || teamContext.active);

  // 已答判定：目录卡之后的第一条用户文本消息（answerSetupPath 落的
  // setupAnswer 消息 / 用户自由输入都算）。
  const answeredText = $derived.by(() => {
    for (const m of session.view?.messages ?? []) {
      if (m.seq <= message.seq || m.senderType !== 'user' || m.kind !== 'text') continue;
      if (m.status === 'recalled') continue;
      return 'text' in m.content ? m.content.text : '';
    }
    return null;
  });
  const interactive = $derived(
    answeredText === null && session.view?.conversation.bot?.setupState === 'interviewing',
  );

  let submitting = $state(false);

  async function submit(path: string | null): Promise<void> {
    const conversationId = session.view?.conversation.id;
    if (submitting || !interactive || conversationId === undefined) return;
    submitting = true;
    try {
      await chat.answerSetupPath(conversationId, path);
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

  /** 团队来源：选项集选择（TeamWorkdirPicker 内部拉取 / mkdir / 越界提示）。 */
  async function pickTeamPath(path: string): Promise<void> {
    if (submitting || !interactive) return;
    await submit(path);
  }
</script>

<div
  class="flex w-full max-w-[50%] flex-col gap-2 rounded-[22px] rounded-tl-[7px] rounded-bl-[7px] bg-muted px-4 py-3"
  data-testid="setup-path-card"
  data-answered={answeredText === null ? 'false' : 'true'}
>
  <!-- 访谈提问是确定性文案，仍兜底长 token：放不下时横向滚动，不撑破气泡 -->
  <div class="overflow-x-auto text-sm font-medium" data-testid="setup-path-question">
    {question}
  </div>
  {#if answeredText !== null}
    <div
      class="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-background px-3 py-2 text-sm"
      data-testid="setup-path-answer"
    >
      <span class="min-w-0 truncate" title={answeredText}>{answeredText}</span>
      <Check class="size-4 shrink-0 text-primary" aria-hidden="true" />
    </div>
  {:else if interactive}
    {#if isTeamSource}
      <!-- 团队来源：服务端允许集合内选择（B-10），不做自由路径 / 原生选择器。 -->
      <div class="space-y-2" data-testid="setup-path-team-picker">
        <TeamWorkdirPicker source={session.source} compact onSelect={(path) => void pickTeamPath(path)} />
        <Button
          variant="outline"
          size="sm"
          class="h-9"
          disabled={submitting}
          onclick={() => void submit(null)}
          data-testid="setup-path-skip"
        >
          {t('chats.setupPathSkip')}
        </Button>
      </div>
    {:else}
      <div class="flex gap-2">
        <Button
          size="sm"
          class="h-9 gap-1.5"
          disabled={submitting}
          onclick={() => void pickDirectory()}
          data-testid="setup-path-pick"
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
          data-testid="setup-path-skip"
        >
          {t('chats.setupPathSkip')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
