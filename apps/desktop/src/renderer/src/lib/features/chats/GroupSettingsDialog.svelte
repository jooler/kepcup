<script lang="ts">
  import { untrack } from 'svelte';
  import type { SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Separator } from '$lib/components/ui/separator';
  import * as Dialog from '$lib/components/ui/dialog';
  import { revealDialogAnchor } from '$lib/features/settings/anchor-scroll';
  import { applySettingItem } from '$lib/features/settings-card/apply';
  import {
    groupMemberPlan,
    proposedMemberIds,
  } from '$lib/features/settings-card/group-members';
  let {
    conversationId,
    open = $bindable(false),
    anchor = $bindable(null),
    embedded = false,
    focus = 'all' as 'all' | 'title' | 'members',
    prefill = null as SettingValues | null,
    expected = null as SettingValues | null,
    messageId = undefined as string | undefined,
    onSaved,
    onConflict,
  }: {
    conversationId: string;
    open?: boolean;
    /** 打开后要聚焦的锚点（对话内设置卡深链：group-title / group-members）；消费后复位。 */
    anchor?: string | null;
    /** 对话内设置卡：只显示改名或成员，不包对话框、不提供解散群。 */
    embedded?: boolean;
    focus?: 'all' | 'title' | 'members';
    prefill?: SettingValues | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    onSaved?: () => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  $effect(() => {
    const target = anchor;
    if (!open || target === null) return;
    anchor = null;
    void revealDialogAnchor(document, target);
  });

  let title = $state('');
  let addBotId = $state('');
  let confirmDelete = $state(false);

  const conversation = $derived(chat.conversations.find((c) => c.id === conversationId) ?? null);
  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );

  // 表单重置只订阅 open 的跳变：conversation/currentId 是高噪声响应源
  // （任何 run 事件都会替换 conversations 数组，打开时的后台 select 完成
  // 也会改写 currentId），直接订阅会让 effect 在对话框开着时反复重跑，
  // 清空用户已选的成员与正在编辑的标题。
  $effect(() => {
    if (embedded || !open) return;
    untrack(() => {
      title = conversation?.title ?? '';
      addBotId = '';
      confirmDelete = false;
      if (chat.currentId !== conversationId) void chat.select(conversationId);
    });
  });

  const addableBots = $derived(
    contacts.bots.filter((bot) => !members.some((m) => m.bot.id === bot.id)),
  );

  async function saveTitle(): Promise<void> {
    if (title.trim().length === 0) return;
    await chat.renameProject(conversationId, title.trim());
  }

  async function addMember(): Promise<void> {
    if (addBotId.length === 0) return;
    await chat.addProjectMembers(conversationId, [addBotId]);
    addBotId = '';
  }

  async function removeMember(botId: string): Promise<void> {
    await chat.removeProjectMember(conversationId, botId);
  }

  async function deleteGroup(): Promise<void> {
    await chat.deleteConversation(conversationId);
    open = false;
  }

  let cardTitle = $state('');
  let cardTitleReady = false;
  /** 用户在卡上亲手勾 / 不勾的 Bot（没碰过的跟随当前成员与 Bot 的建议，见 group-members.ts）。 */
  let memberChoices = $state<Record<string, boolean>>({});
  let cardBusy = $state(false);

  const showTitle = $derived(!embedded || focus === 'all' || focus === 'title');
  const showMembers = $derived(!embedded || focus === 'all' || focus === 'members');

  $effect(() => {
    if (!embedded || focus === 'members' || cardTitleReady) return;
    const wanted = prefill?.title;
    if (typeof wanted === 'string' && wanted.trim().length > 0) {
      cardTitle = wanted.trim();
      cardTitleReady = true;
      return;
    }
    if (conversation === null) return;
    cardTitle = conversation.title ?? '';
    cardTitleReady = true;
  });

  // Bot 的预填只表示「建议拉进群的 Bot」：现有成员默认勾选，预填只会多勾、不会预先取消勾选谁。
  const proposedIds = $derived(proposedMemberIds(prefill));
  const memberIds = $derived(members.map((member) => member.bot.id));
  const memberPlan = $derived(groupMemberPlan(memberIds, proposedIds, memberChoices));

  const roster = $derived.by(() => {
    const rows = contacts.bots.map((bot) => ({ id: bot.id, name: bot.name }));
    for (const member of members) {
      if (!rows.some((row) => row.id === member.bot.id)) {
        rows.push({ id: member.bot.id, name: member.bot.name });
      }
    }
    return rows;
  });

  function rosterNames(ids: readonly string[]): string {
    return ids.map((id) => roster.find((row) => row.id === id)?.name ?? id).join('、');
  }

  function toggleMember(id: string, on: boolean): void {
    memberChoices = { ...memberChoices, [id]: on };
  }

  async function applyCardTitle(): Promise<void> {
    const next = cardTitle.trim();
    if (next.length === 0 || cardBusy) return;
    cardBusy = true;
    try {
      const out = await applySettingItem({
        itemId: 'group.title',
        values: { title: next },
        expected,
        target: { conversationId },
        messageId,
      });
      if (out.status === 'conflict') {
        onConflict?.(out.current);
        return;
      }
      toast.success(t('settingCard.appliedToast'));
      onSaved?.();
    } catch (error) {
      toast.error(
        t('settingCard.actionFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      cardBusy = false;
    }
  }

  async function applyCardMembers(): Promise<void> {
    if (cardBusy) return;
    cardBusy = true;
    try {
      // 按当前成员重新算：卡片挂着期间别处拉进群的 Bot 不会被移出，移出只来自用户亲手取消勾选。
      const { toAdd, toRemove } = memberPlan;
      if (toAdd.length > 0 && !(await chat.addProjectMembers(conversationId, toAdd))) return;
      for (const id of toRemove) {
        if (!(await chat.removeProjectMember(conversationId, id))) return;
      }
      onSaved?.();
    } finally {
      cardBusy = false;
    }
  }
</script>

{#if embedded}
  <div class="grid gap-2" data-testid="group-settings-embedded">
    {#if showTitle}
      <label class="grid gap-1.5 text-sm" for="group-card-rename">
        {t('group.renameLabel')}
        <Input id="group-card-rename" bind:value={cardTitle} data-testid="group-card-rename" />
      </label>
      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={cardBusy || cardTitle.trim().length === 0}
          onclick={() => void applyCardTitle()}
          data-testid="group-card-rename-save"
        >
          {t('settingCard.apply')}
        </Button>
      </div>
    {/if}
    {#if showMembers}
      <p class="text-sm font-medium">{t('group.memberCount', { count: memberPlan.count })}</p>
      {#if roster.length === 0}
        <p class="text-xs text-muted-foreground">{t('settingCard.group.noBots')}</p>
      {:else}
        <div class="max-h-44 space-y-1.5 overflow-y-auto">
          {#each roster as bot (bot.id)}
            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                checked={memberPlan.checked(bot.id)}
                onCheckedChange={(checked) => toggleMember(bot.id, checked === true)}
                data-testid={`group-card-member-${bot.id}`}
              />
              <span class="min-w-0 truncate">{bot.name}</span>
            </label>
          {/each}
        </div>
      {/if}
      {#if memberPlan.toAdd.length > 0}
        <p class="text-xs text-muted-foreground" data-testid="group-card-will-add">
          {t('settingCard.group.willAdd', { names: rosterNames(memberPlan.toAdd) })}
        </p>
      {/if}
      {#if memberPlan.toRemove.length > 0}
        <p class="text-xs text-destructive" data-testid="group-card-will-remove">
          {t('settingCard.group.willRemove', { names: rosterNames(memberPlan.toRemove) })}
        </p>
      {/if}
      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={cardBusy || (memberPlan.toAdd.length === 0 && memberPlan.toRemove.length === 0)}
          onclick={() => void applyCardMembers()}
          data-testid="group-card-members-save"
        >
          {t('settingCard.apply')}
        </Button>
      </div>
    {/if}
  </div>
{:else}
<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md" data-testid="group-settings-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('group.settingsTitle')}</Dialog.Title>
    </Dialog.Header>

    <div class="space-y-4">
      <!-- data-settings-anchor：对话内设置卡「在设置中打开」的落点（settings-catalog 深链）。 -->
      <div class="flex items-end gap-2" data-settings-anchor="group-title">
        <div class="flex-1 space-y-1.5">
          <label class="text-sm font-medium" for="group-rename">{t('group.renameLabel')}</label>
          <Input id="group-rename" bind:value={title} data-testid="group-rename-input" />
        </div>
        <Button variant="outline" onclick={saveTitle} data-testid="group-rename-save">
          {t('group.renameSave')}
        </Button>
      </div>

      <Separator />

      <div class="space-y-1.5" data-settings-anchor="group-members">
        <p class="text-sm font-medium">
          {t('group.memberCount', { count: members.length })}
        </p>
        <ul
          class="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2"
          data-testid="group-member-list"
        >
          {#each members as member (member.bot.id)}
            <li class="flex items-center gap-2 rounded px-1 py-1 text-sm">
              <span class="flex-1 truncate">{member.bot.name}</span>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-xs text-destructive"
                onclick={() => void removeMember(member.bot.id)}
                data-testid={`group-member-remove-${member.bot.id}`}
              >
                {t('group.removeMember')}
              </Button>
            </li>
          {/each}
        </ul>
      </div>

      <div class="flex items-end gap-2">
        <div class="flex-1 space-y-1.5">
          <label class="text-sm font-medium" for="group-add-member"
            >{t('group.addMembersLabel')}</label
          >
          <select
            id="group-add-member"
            bind:value={addBotId}
            class="flex h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm"
            data-testid="group-add-member-select"
          >
            <option value="" disabled>—</option>
            {#each addableBots as bot (bot.id)}
              <option value={bot.id}>{bot.name}</option>
            {/each}
          </select>
        </div>
        <Button
          variant="outline"
          onclick={addMember}
          disabled={addBotId.length === 0}
          data-testid="group-add-member-confirm"
        >
          {t('group.addMembersButton')}
        </Button>
      </div>

      <Separator />

      {#if !confirmDelete}
        <Button
          variant="ghost"
          class="w-full text-destructive"
          onclick={() => (confirmDelete = true)}
          data-testid="group-delete-begin"
        >
          {t('group.deleteGroup')}
        </Button>
      {:else}
        <div
          class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-testid="group-delete-confirm-box"
        >
          <p class="text-xs text-muted-foreground">
            {t('group.deleteBody')}
          </p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" size="sm" onclick={() => (confirmDelete = false)}>
              {t('chats.cancelEdit')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onclick={deleteGroup}
              data-testid="group-delete-confirm"
            >
              {t('group.deleteGroup')}
            </Button>
          </div>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
{/if}
