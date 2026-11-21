<script lang="ts">
  import { t } from '$lib/i18n';
  import { errorText } from '$lib/i18n/state.svelte';
  import type { Message } from '@kepcup/shared';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import { Check, CircleAlert, Link2, ShieldCheck } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import MemberAvatar from '$lib/features/team/MemberAvatar.svelte';
  import {
    ResolutionCardState,
    resolutionCardDataOf,
    signatureStateOf,
  } from '$lib/features/team/resolution-card.svelte';

  /**
   * 决议卡（T9，62.09 §5）：cardType 'resolution' 的宿主卡消息——标题 / 正文 /
   * 版本号（讨论中）或通过时间（锁定）/ 快照逐人签署状态（头像 + 勾，签旧版本
   * 显示「待重签」）/ 本人「通过决议」「撤回签署」（带版本号调用）/ 项目负责人
   * 「作废」/ 作废与通过置灰 / 替代关系链接。卡片本体随 `message.updated` 就地
   * 收敛（team.db 是事实来源，卡片是投影）。
   */
  let { message }: { message: Message } = $props();

  const session = getChatSession();
  const isTeam = $derived(session.source !== 'local' && session.conversationId === message.conversationId);
  const state = $derived(
    isTeam
      ? stateOf(session.source, message.conversationId)
      : null,
  );

  // Plain Map: (来源, 会话) 维度的卡片动作状态缓存——跨卡片重渲染不丢 leadMemberId。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const states = new Map<string, ResolutionCardState>();
  function stateOf(source: SourceId, conversationId: string): ResolutionCardState {
    const key = `${source}::${conversationId}`;
    let entry = states.get(key);
    if (entry === undefined) {
      entry = new ResolutionCardState({ source, conversationId });
      states.set(key, entry);
    }
    return entry;
  }

  const data = $derived(resolutionCardDataOf(message.content));
  // 新消息内容（message.updated）喂进状态（签署状态就地刷新）。
  $effect(() => {
    if (state === null) return;
    state.applyMessage(message.content);
    void state.loadLead();
  });

  const withdrawn = $derived(data?.state === 'withdrawn');
  const passed = $derived(data?.state === 'passed');
  const locked = $derived(passed || withdrawn);

  const stateLabel = $derived(
    passed
      ? t('team.resolutionStatePassed')
      : withdrawn
        ? t('team.resolutionStateWithdrawn')
        : t('team.resolutionStateOpen'),
  );
  const timeLabel = $derived(
    passed && data?.passedAt !== undefined
      ? t('team.resolutionPassedAt').replace(
          '{time}',
          new Date(data.passedAt).toLocaleString(),
        )
      : withdrawn && data?.withdrawnAt !== undefined
        ? t('team.resolutionWithdrawnAt').replace(
            '{time}',
            new Date(data.withdrawnAt).toLocaleString(),
          )
        : t('team.resolutionVersion').replace('{version}', String(data?.version ?? 1)),
  );
  const errorLabel = $derived(
    state?.lastError === null || state?.lastError === undefined
      ? null
      : errorText(state.lastError, t('team.resolutionActionFailed')),
  );
</script>

{#if data !== null}
  <div
    class="w-full max-w-[85%] rounded-lg border bg-card p-3 {withdrawn ? 'opacity-60' : ''}"
    data-testid="resolution-card"
    data-resolution-state={data.state}
    data-resolution-id={data.resolutionId}
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="flex items-center gap-1.5 text-sm font-medium" data-testid="resolution-title">
          <ShieldCheck class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="truncate">{data.title}</span>
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground" data-testid="resolution-time">
          {timeLabel}
          ·
          <span data-testid="resolution-state">{stateLabel}</span>
        </p>
      </div>
      {#if state?.canWithdraw === true}
        <Button
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 px-2 text-xs"
          disabled={state.busy}
          onclick={() => void state?.withdraw()}
          data-testid="resolution-withdraw"
        >
          {t('team.resolutionWithdraw')}
        </Button>
      {/if}
    </div>

    <p class="mt-2 whitespace-pre-wrap text-sm" data-testid="resolution-body">{data.body}</p>

    {#if data.supersedes !== undefined}
      <p
        class="mt-2 flex items-center gap-1 text-xs text-muted-foreground"
        data-testid="resolution-supersedes"
      >
        <Link2 class="size-3" aria-hidden="true" />
        {t('team.resolutionSupersedes').replace('{id}', data.supersedes)}
      </p>
    {/if}

    <div class="mt-3 border-t pt-2">
      <p class="text-xs text-muted-foreground">{t('team.resolutionSnapshot')}</p>
      <ul class="mt-1 space-y-1">
        {#each data.snapshot as member (member.memberId)}
          <li class="flex items-center gap-2 text-sm" data-testid={`resolution-signer-${member.memberId}`}>
            <MemberAvatar name={member.name} avatar={null} class="size-5" />
            <span class="min-w-0 flex-1 truncate">{member.name}</span>
            {#if signatureStateOf(member, data.version) === 'signed'}
              <span
                class="flex items-center gap-0.5 text-xs text-emerald-600"
                data-testid={`resolution-signed-${member.memberId}`}
              >
                <Check class="size-3.5" aria-hidden="true" />
                {t('team.resolutionSigned')}
              </span>
            {:else if signatureStateOf(member, data.version) === 'stale'}
              <span
                class="text-xs text-amber-600"
                data-testid={`resolution-stale-${member.memberId}`}
              >{t('team.resolutionStale')}</span>
            {:else}
              <span
                class="text-xs text-muted-foreground"
                data-testid={`resolution-unsigned-${member.memberId}`}
              >{t('team.resolutionUnsigned')}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>

    {#if errorLabel !== null}
      <p class="mt-2 flex items-center gap-1 text-xs text-destructive" data-testid="resolution-error">
        <CircleAlert class="size-3.5" aria-hidden="true" />
        {errorLabel}
      </p>
    {/if}

    {#if !locked && state !== null}
      <div class="mt-2 flex gap-2">
        {#if state.canApprove}
          <Button
            size="sm"
            class="h-7 px-2 text-xs"
            disabled={state.busy}
            onclick={() => void state?.approve()}
            data-testid="resolution-approve"
          >
            {t('team.resolutionApprove').replace('{version}', String(data.version))}
          </Button>
        {/if}
        {#if state.canRevoke}
          <Button
            variant="outline"
            size="sm"
            class="h-7 px-2 text-xs"
            disabled={state.busy}
            onclick={() => void state?.revoke()}
            data-testid="resolution-revoke"
          >
            {t('team.resolutionRevoke')}
          </Button>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <!-- 载荷缺失 / 非团队来源：按信息卡兜底（不伪造签署状态） -->
  <span class="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">
    {t('team.resolutionFallback')}
  </span>
{/if}
