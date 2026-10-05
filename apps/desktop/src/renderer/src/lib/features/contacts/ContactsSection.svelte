<script lang="ts">
  import { MessagesSquare, Trash2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import type { Bot } from '@kepcup/shared';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 设置弹框「通讯录」分组：只读的 Bot 名册（头像 + 名片 + 打开对话/删除）。
   * 新建不再在这里提供入口——只保留主界面左栏「+」一个入口。
   */
  let deleteTarget = $state<Bot | null>(null);
  let deletePreview = $state({ conversations: 0, messages: 0 });
  let deleting = $state(false);

  async function openChat(bot: Bot): Promise<void> {
    shell.closeSettings();
    await chat.openDirect(bot.id);
  }

  async function askDelete(bot: Bot): Promise<void> {
    deletePreview = await contacts.deletionPreview(bot.id);
    deleteTarget = bot;
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    deleting = true;
    try {
      await contacts.remove(deleteTarget.id);
      toast.success(t('contacts.deleteTitle', { name: deleteTarget.name }));
      deleteTarget = null;
    } finally {
      deleting = false;
    }
  }
</script>

<div class="space-y-4" data-testid="contacts-page-content">
  {#if contacts.bots.length === 0}
    <div
      class="flex h-40 items-center justify-center text-sm text-muted-foreground"
      data-testid="contacts-empty"
    >
      {t('contacts.empty')}
    </div>
  {:else}
    <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each contacts.bots as bot (bot.id)}
        <li
          class="flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40"
          data-testid={`bot-card-${bot.id}`}
        >
          <div class="flex items-center gap-3">
            <BotAvatar botId={bot.id} name={bot.name} avatar={bot.avatar} class="size-10" />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium" data-testid="bot-card-name">{bot.name}</p>
              <p class="truncate text-xs text-muted-foreground">{bot.bio}</p>
            </div>
          </div>
          <div class="flex gap-2">
            <Button
              size="sm"
              class="flex-1 gap-1"
              onclick={() => void openChat(bot)}
              data-testid={`bot-open-${bot.id}`}
            >
              <MessagesSquare class="size-3.5" />
              {t('contacts.openChat')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              class="gap-1"
              onclick={() => void askDelete(bot)}
              data-testid={`bot-delete-${bot.id}`}
            >
              <Trash2 class="size-3.5" />
              {t('contacts.delete')}
            </Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <Dialog
    open={deleteTarget !== null}
    onOpenChange={(open) => (deleteTarget = open ? deleteTarget : null)}
  >
    <DialogContent class="max-w-md" data-testid="bot-delete-dialog">
      <DialogHeader>
        <DialogTitle>{t('contacts.deleteTitle', { name: deleteTarget?.name ?? '' })}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground" data-testid="bot-delete-body">
        {t('contacts.deleteBody', {
          conversations: deletePreview.conversations,
          messages: deletePreview.messages,
        })}
      </p>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (deleteTarget = null)}
          data-testid="bot-delete-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={confirmDelete}
          disabled={deleting}
          data-testid="bot-delete-confirm"
        >
          {t('contacts.deleteConfirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</div>
