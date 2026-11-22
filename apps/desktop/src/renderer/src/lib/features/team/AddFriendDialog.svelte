<script lang="ts">
  import { ChevronLeft, Search, UserPlus } from '@lucide/svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import type { TeamMember } from '@kepcup/shared';
  import { teamContext } from './team-context.svelte';
  import { canRequestFriend, friends as friendsStore } from './friends.svelte';
  import MemberAvatar from './MemberAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 「添加好友」弹框（2026-11，+ 面板入口；62.04 D129v2 好友层的加好友快捷
   * 入口——通讯录好友栏的搜索行之外，左栏 + 面板直达）：
   *  - 搜索态：输入用户名 / 显示名关键字，主体返回结果列表，行内「加好友」；
   *  - 申请态：点「加好友」后主体切换为申请消息编辑（≤200 字，服务端契约同
   *    限）+「发送申请」。发送成功 toast 后收框；重复申请幂等（服务端复用
   *    既有 pending）。
   * 非团队上下文（active=false）不渲染——好友层只存在于团队服务器。
   */

  /** 宿主用 bind:open 控制开关（AppSidebar 的 + 面板「添加好友」入口）。 */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  // --- 搜索态 -------------------------------------------------------------------
  let query = $state('');
  let searching = $state(false);
  let results = $state<TeamMember[]>([]);
  let searched = $state(false);
  /** 「加好友」按钮禁用态（2026-11）：判定与通讯录搜索行共用，见 canRequestFriend。 */
  function requestDisabled(member: TeamMember): boolean {
    return !canRequestFriend(friendsStore.sliceOf('local'), member.id);
  }

  async function search(): Promise<void> {
    const keyword = query.trim();
    if (keyword.length === 0) {
      results = [];
      searched = false;
      return;
    }
    searching = true;
    try {
      results = await friendsStore.search('local', keyword);
      searched = true;
    } finally {
      searching = false;
    }
  }

  // --- 申请态 -------------------------------------------------------------------
  let composeTarget = $state<TeamMember | null>(null);
  /** 申请消息；契约上限 200 字（team.friends.request message max 200）。 */
  const MESSAGE_MAX = 200;
  let message = $state('');
  let sending = $state(false);

  function startCompose(member: TeamMember): void {
    composeTarget = member;
    message = '';
  }

  function backToSearch(): void {
    composeTarget = null;
    message = '';
  }

  async function sendRequest(): Promise<void> {
    const target = composeTarget;
    if (target === null || sending) return;
    sending = true;
    try {
      const trimmed = message.trim();
      await friendsStore.request(
        'local',
        target.username ?? target.id,
        trimmed.length > 0 ? trimmed : undefined,
      );
      toast.success(t('friends.requestSent', { name: target.displayName }));
      open = false;
      backToSearch();
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.requestFailed')));
    } finally {
      sending = false;
    }
  }

  function reset(): void {
    query = '';
    results = [];
    searched = false;
    composeTarget = null;
    message = '';
    sending = false;
  }
</script>

{#if teamContext.active}
  <Dialog
    bind:open
    onOpenChange={(next) => {
      if (!next) reset();
    }}
  >
    <DialogContent class="max-w-md" data-testid="add-friend-dialog">
      <DialogHeader>
        {#if composeTarget !== null}
          <!-- 申请态：标题带目标成员，返回按钮回搜索态。 -->
          <div class="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              onclick={backToSearch}
              aria-label={t('friends.backToSearch')}
              title={t('friends.backToSearch')}
              data-testid="add-friend-back"
            >
              <ChevronLeft class="size-4" aria-hidden="true" />
            </Button>
            <DialogTitle class="truncate">
              {t('friends.requestTo', { name: composeTarget.displayName })}
            </DialogTitle>
          </div>
        {:else}
          <DialogTitle>{t('friends.addFriend')}</DialogTitle>
        {/if}
      </DialogHeader>

      {#if composeTarget === null}
        <!-- 搜索态：关键字 + 结果列表（行内「加好友」）。 -->
        <div class="flex items-center gap-2" data-testid="add-friend-search">
          <input
            class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
            type="text"
            placeholder={t('friends.searchPlaceholder')}
            bind:value={query}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
            data-testid="add-friend-search-input"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={searching || query.trim().length === 0}
            onclick={() => void search()}
            data-testid="add-friend-search-submit"
          >
            <Search class="size-4" aria-hidden="true" />
            {t('friends.searchAction')}
          </Button>
        </div>
        {#if results.length > 0}
          <ul class="max-h-72 space-y-1.5 overflow-y-auto" data-testid="add-friend-results">
            {#each results as member (member.id)}
              <li class="flex items-center gap-3 rounded-lg border p-2">
                <MemberAvatar
                  name={member.displayName}
                  avatar={member.avatar ?? null}
                  state={member.state}
                  class="size-8"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm">{member.displayName}</p>
                  {#if member.username !== undefined}
                    <p class="truncate text-xs text-muted-foreground">{member.username}</p>
                  {/if}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={requestDisabled(member)}
                  onclick={() => startCompose(member)}
                  data-testid={`add-friend-request-${member.id}`}
                >
                  <UserPlus class="size-4" aria-hidden="true" />
                  {t('friends.requestAction')}
                </Button>
              </li>
            {/each}
          </ul>
        {:else if searched && !searching}
          <p class="text-sm text-muted-foreground" data-testid="add-friend-empty">
            {t('friends.searchEmpty')}
          </p>
        {/if}
      {:else}
        <!-- 申请态：上方申请消息（≤200 字，字数随手数显示），下方发送申请。 -->
        <div class="space-y-2">
          <label class="grid gap-1.5">
            <span class="text-sm">{t('friends.requestMessageLabel')}</span>
            <textarea
              class="min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring"
              maxlength={MESSAGE_MAX}
              placeholder={t('friends.requestMessagePlaceholder')}
              bind:value={message}
              data-testid="add-friend-message"
            ></textarea>
          </label>
          <p class="text-right text-xs text-muted-foreground" data-testid="add-friend-message-count">
            {message.length}/{MESSAGE_MAX}
          </p>
        </div>
        <div class="flex justify-end">
          <Button
            disabled={sending}
            onclick={() => void sendRequest()}
            data-testid="add-friend-send"
          >
            <UserPlus class="size-4" aria-hidden="true" />
            {t('friends.sendRequest')}
          </Button>
        </div>
      {/if}
    </DialogContent>
  </Dialog>
{/if}
