<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Check, FolderOpen } from '@lucide/svelte';
  import { t, errorText } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from './chat-session-context';
  import { teamContext } from '$lib/features/team/team-context.svelte';
  import { teamBots } from '$lib/features/team/team-bots.svelte';
  import TeamWorkdirPicker from '$lib/features/team/TeamWorkdirPicker.svelte';

  /**
   * 初始化访谈的工作目录卡（docs/design/19 D59）：首问作答后由 core 确定性
   * 插入（不经 LLM），闸门在它作答前扣下一切投递。未答态提供「选择目录…」
   * 与「暂不设置」两个出口；已答态与 SetupQuestionCard 同构——展示首条后续
   * 用户消息（setupAnswer 标记）为已答行。
   *
   * 来源路由（member-bots B4；2026-11 工作路径重构）：本机会话走原生目录选择器
   * （现行为不变）；团队来源改为 opaque key——TeamWorkdirPicker 选项集选择，
   * `team.bots.answerSetupPath` 服务端解析绑定（transcript 只落展示名，服务器
   * 真实路径不出服务端）。「暂不设置」仍走 core `bots.interview.answerPath
   * { path: null }`（member-guarded，path 空跳过校验）。团队判定含 web 团队
   * 端点（session.source 恒 'local'，但同源 core 就是团队服务器）。
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

  /** 「暂不设置」（本机 / 团队同链路：core answerPath { path: null }）。 */
  async function submitSkip(): Promise<void> {
    const conversationId = session.view?.conversation.id;
    if (submitting || !interactive || conversationId === undefined) return;
    submitting = true;
    try {
      await chat.answerSetupPath(conversationId, null);
    } finally {
      submitting = false;
    }
  }

  async function pickDirectory(): Promise<void> {
    if (submitting || !interactive) return;
    const path = await window.kepcup.platform.selectDirectory();
    if (path === null) return;
    const conversationId = session.view?.conversation.id;
    if (conversationId === undefined) return;
    submitting = true;
    try {
      await chat.answerSetupPath(conversationId, path);
    } finally {
      submitting = false;
    }
  }

  /** 团队来源：选项集 opaque key 作答（服务端解析 + 展示名入 transcript）。 */
  async function pickTeamKey(key: string): Promise<void> {
    const conversationId = session.view?.conversation.id;
    if (submitting || !interactive || conversationId === undefined) return;
    submitting = true;
    try {
      await teamBots.answerSetupPath(session.source, conversationId, key);
    } catch (error) {
      // 服务端拒绝（WORKDIR_NOT_ALLOWED / 会话资格）以 toast 呈现，卡片保持未答。
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('teamBot.workdirLoadFailed')),
      );
    } finally {
      submitting = false;
    }
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
      <!-- 团队来源：opaque key 选项集选择（服务端解析 + 展示名入 transcript），
           不做自由路径 / 原生选择器。 -->
      <div class="space-y-2" data-testid="setup-path-team-picker">
        <TeamWorkdirPicker source={session.source} compact onSelect={(key) => void pickTeamKey(key)} />
        <Button
          variant="outline"
          size="sm"
          class="h-9"
          disabled={submitting}
          onclick={() => void submitSkip()}
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
          onclick={() => void submitSkip()}
          data-testid="setup-path-skip"
        >
          {t('chats.setupPathSkip')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
