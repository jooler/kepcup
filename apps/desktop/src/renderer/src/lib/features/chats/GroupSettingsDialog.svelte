<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Separator } from '$lib/components/ui/separator';
  import * as Dialog from '$lib/components/ui/dialog';
  let { conversationId, open = $bindable(false) }: { conversationId: string; open?: boolean } =
    $props();

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
    if (!open) return;
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
    await chat.renameGroup(conversationId, title.trim());
  }

  async function addMember(): Promise<void> {
    if (addBotId.length === 0) return;
    await chat.addGroupMembers(conversationId, [addBotId]);
    addBotId = '';
  }

  async function removeMember(botId: string): Promise<void> {
    await chat.removeGroupMember(conversationId, botId);
  }

  async function deleteGroup(): Promise<void> {
    await chat.deleteConversation(conversationId);
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md" data-testid="group-settings-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('group.settingsTitle')}</Dialog.Title>
    </Dialog.Header>

    <div class="space-y-4">
      <div class="flex items-end gap-2">
        <div class="flex-1 space-y-1.5">
          <label class="text-sm font-medium" for="group-rename">{t('group.renameLabel')}</label>
          <Input id="group-rename" bind:value={title} data-testid="group-rename-input" />
        </div>
        <Button variant="outline" onclick={saveTitle} data-testid="group-rename-save">
          {t('group.renameSave')}
        </Button>
      </div>

      <Separator />

      <div class="space-y-1.5">
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
