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
  let deletePreview = $state({
    conversations: 0,
    messages: 0,
    ledProjects: [] as Array<{ id: string; title: string | null }>,
  });
  let deleting = $state(false);

  async function openChat(bot: Bot): Promise<void> {
    shell.closeSettings();
    await chat.openDirect(bot.id);
  }

  async function askDelete(bot: Bot): Promise<void> {
    deletePreview = await contacts.deletionPreview(bot.id);
    deleteTarget = bot;
  }

  /**
   * The bot leads projects: deletion is blocked (the backend would reject it
   * with PROJECT_LEAD_REQUIRED anyway). Jump to the members section of that
   * project so the user can hand the lead over first.
   */
  async function goReplaceLead(conversationId: string): Promise<void> {
    deleteTarget = null;
    shell.closeSettings();
    await chat.select(conversationId);
    shell.openProjectSettings('members');
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
    <!-- 显式 grid-cols-1（minmax(0,1fr)，轨道可收缩）：裸 grid 的 auto 轨道按
         内容 min-content 取宽，简介 truncate 的不换行文本会把轨道撑到超出
         窄屏视口、出现横向滚动条（33-narrow-layout）。 -->
    <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            <!-- 管家（D70）不可删除：不给删除入口。 -->
            {#if bot.systemRole !== 'butler'}
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
            {/if}
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
      {#if (deleteTarget?.profile.runtime.agent.id ?? '').length > 0}
        <p class="text-xs text-muted-foreground" data-testid="bot-delete-body-agent-note">
          {t('contacts.deleteAgentNote')}
        </p>
      {/if}
      {#if deletePreview.ledProjects.length > 0}
        <!-- Leading projects block the delete: no confirm button, offer the
             "go replace" jump into each project's members section instead. -->
        <div class="space-y-1.5" data-testid="bot-delete-lead-blocked">
          <p class="text-sm text-muted-foreground">
            {t('contacts.deleteBlockedLead', { count: deletePreview.ledProjects.length })}
          </p>
          <ul class="space-y-1.5">
            {#each deletePreview.ledProjects as project (project.id)}
              <li class="flex items-center gap-2 rounded-md border p-2 text-sm">
                <span class="min-w-0 flex-1 truncate">
                  {project.title ?? t('project.untitled')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onclick={() => void goReplaceLead(project.id)}
                  data-testid={`bot-delete-go-replace-${project.id}`}
                >
                  {t('contacts.deleteGoReplace')}
                </Button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (deleteTarget = null)}
          data-testid="bot-delete-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        {#if deletePreview.ledProjects.length === 0}
          <Button
            variant="destructive"
            onclick={confirmDelete}
            disabled={deleting}
            data-testid="bot-delete-confirm"
          >
            {t('contacts.deleteConfirm')}
          </Button>
        {/if}
      </DialogFooter>
    </DialogContent>
  </Dialog>
</div>
