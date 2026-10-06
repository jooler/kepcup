<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import ApprovalCard from '$lib/features/approvals/ApprovalCard.svelte';
  import RunChangesCard from '$lib/features/projects/RunChangesCard.svelte';
  import DelegationCard from '$lib/features/delegations/DelegationCard.svelte';
  import RouteCard from '$lib/features/delegations/RouteCard.svelte';
  import SetupQuestionCard from './SetupQuestionCard.svelte';
  import SetupPathCard from './SetupPathCard.svelte';
  import GroupSetupCard from './GroupSetupCard.svelte';
  import ChatMessageRow from './ChatMessageRow.svelte';

  /**
   * 消息渲染调度层：按消息种类分发——改动摘要卡 / 审批卡 / 初始化访谈
   * 问题卡 / 系统事件各自成形态；普通用户与 Bot 消息交给 ChatMessageRow
   * （布局交互）→ MessageBody（气泡内容）+ MessageAttachments（附件）。
   * merge 是连排信息（列表里上/下相邻条目是否同一发送者，由 MessageList
   * 计算），气泡与问题卡据此缩小对齐侧圆角。后续追加内容形态时：卡片类
   * 在调度层加分支；气泡内新内容（多模态等）扩展 MessageBody /
   * MessageAttachments，互不影响。
   */
  let {
    message,
    editing = false,
    merge = { above: false, below: false },
  }: { message: Message; editing?: boolean; merge?: { above: boolean; below: boolean } } = $props();

  const isCard = $derived(message.kind === 'card');
  const isChangesCard = $derived(
    isCard && 'cardType' in message.content && message.content.cardType === 'run_changes',
  );
  // 跨 Bot 委派卡（D71）：发出卡 / 结果卡，按委派行实时重绘。
  const delegationCard = $derived(
    isCard &&
      'cardType' in message.content &&
      (message.content.cardType === 'delegation_sent' ||
        message.content.cardType === 'delegation_result')
      ? {
          cardType: message.content.cardType,
          delegationId: String(message.content.delegationId ?? ''),
        }
      : null,
  );
  const cardRunId = $derived(
    isChangesCard && 'runId' in message.content ? String(message.content.runId ?? '') : '',
  );
  const cardApproval = $derived(
    isCard && !isChangesCard && delegationCard === null && 'approvalId' in message.content
      ? (permissions.approvals[message.content.approvalId] ?? null)
      : null,
  );
  const isSystem = $derived(message.senderType === 'system');
  /** Structured bot candidates of the no-claim system message (P05). */
  const noClaimBotIds = $derived(
    isSystem && message.kind === 'system_event' && 'botIds' in message.content
      ? (message.content.botIds ?? [])
      : [],
  );
  const noClaimBatchId = $derived(
    isSystem && message.kind === 'system_event' && 'batchId' in message.content
      ? (message.content.batchId ?? null)
      : null,
  );
  // 初始化访谈的问题卡片（bot_setup_question + 候选答案）：独立于灰色 pill 的专用交互卡。
  const isSetupQuestion = $derived(
    isSystem &&
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === 'bot_setup_question' &&
      'options' in message.content &&
      (message.content.options?.length ?? 0) > 0,
  );
  // 访谈的工作目录卡（19/D59）：core 确定性插入，选择目录 / 暂不设置。
  const isSetupPath = $derived(
    isSystem &&
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === 'bot_setup_path_question',
  );
  // 对话内群创建的问题卡（19/D60）：按 content.step 渲染四问表单。
  const isGroupSetup = $derived(
    isSystem &&
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === 'group_setup_question',
  );

  // 管家路由卡（D70 §2.4）：建议去哪，一键跳转 / 交给管家转交。
  const isRouteCard = $derived(
    isSystem &&
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === 'route_suggestion',
  );

  function assign(botId: string): void {
    if (noClaimBatchId !== null) void chat.redistribute(noClaimBatchId, botId);
  }
</script>

{#if isChangesCard}
  <!-- 改动摘要卡片（docs/design/12-ui-layout.md 卡片表）：信息展示，不进 dock -->
  <div class="flex justify-center py-1" data-testid="card-message">
    <RunChangesCard runId={cardRunId} />
  </div>
{:else if delegationCard !== null}
  <!-- 跨 Bot 委派卡（D71）：信息卡，居中；发出卡可取消，结果卡可跳到 B 的原文 -->
  <div class="flex justify-center py-1" data-testid="card-message">
    <DelegationCard cardType={delegationCard.cardType} delegationId={delegationCard.delegationId} />
  </div>
{:else if isCard}
  <!-- 审批卡片：消息流里显示折叠记录，交互卡片在输入区上方的 dock 中 -->
  <div class="flex justify-center py-1" data-testid="card-message">
    {#if cardApproval}
      <div class="w-full max-w-[85%]">
        <ApprovalCard approval={cardApproval} variant="folded" />
      </div>
    {:else}
      <span class="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground"
        >（审批消息）</span
      >
    {/if}
  </div>
{:else if isSetupQuestion}
  <!-- 初始化访谈问题卡：与 bot 消息同一左缘（单聊无头像列） -->
  <div class="flex w-full py-1">
    <SetupQuestionCard {message} {merge} />
  </div>
{:else if isSetupPath}
  <!-- 访谈工作目录卡（19/D59）：与访谈卡同形同左缘 -->
  <div class="flex w-full py-1">
    <SetupPathCard {message} />
  </div>
{:else if isGroupSetup}
  <!-- 对话内群创建问题卡（19/D60）：居中卡片形态（群无 bot 左缘） -->
  <div class="flex w-full justify-center py-1">
    <GroupSetupCard {message} />
  </div>
{:else if isRouteCard}
  <div class="flex w-full justify-center py-1">
    <RouteCard {message} />
  </div>
{:else if isSystem}
  <div class="flex flex-col items-center gap-1 py-1" data-testid="system-message">
    <span class="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">
      {'text' in message.content ? message.content.text : ''}
    </span>
    {#if noClaimBotIds.length > 0 && noClaimBatchId !== null}
      <div class="flex max-w-[85%] flex-wrap justify-center gap-1" data-testid="no-claim-bots">
        {#each noClaimBotIds as botId (botId)}
          <button
            type="button"
            class="rounded-full border bg-background px-2.5 py-0.5 text-xs transition-colors hover:bg-accent"
            onclick={() => assign(botId)}
            data-testid={`no-claim-bot-${botId}`}
          >
            @{chat.botName(botId)}
          </button>
        {/each}
      </div>
      <span class="text-[11px] text-muted-foreground">{t('group.noClaimHint')}</span>
    {/if}
  </div>
{:else}
  <ChatMessageRow {message} {editing} {merge} />
{/if}
