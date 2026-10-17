<script lang="ts">
  import type { BotProfile } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { isButlerConversation } from './butler';
  import { sidebarDialogs as ui } from './sidebar-dialogs.svelte';

  /**
   * 侧栏触发的模态对话框（重命名 / 删除会话），挂在 App 根；状态在
   * sidebar-dialogs store（宽窄切换时 AppSidebar 整个重挂载，状态不能放在它里面）。
   * Tooltip.Provider 自带：宽屏由 Sidebar.Provider 隐式提供、窄屏由 NarrowShell 提供，
   * 挂在 App 根这两者都不覆盖。
   */
  const deleteTargetName = $derived.by(() => {
    const conversation = chat.conversations.find((c) => c.id === ui.deleteTargetId);
    if (conversation === undefined) return ui.deleteTargetId ?? '';
    return conversation.type === 'project'
      ? (conversation.title ?? ui.deleteTargetId ?? '')
      : (conversation.bot?.name ?? conversation.directBotId ?? '');
  });

  // D72 P5: the bot runs an external agent whose own history KepCup does not manage.
  const deleteTargetUsesAgent = $derived.by(() => {
    const conversation = chat.conversations.find((c) => c.id === ui.deleteTargetId);
    return (conversation?.bot?.profile.runtime.agent.id ?? '').length > 0;
  });

  async function confirmDelete(): Promise<void> {
    const id = ui.deleteTargetId;
    ui.deleteTargetId = null;
    if (!id) return;
    const wasButlerChat = isButlerConversation(chat.conversations.find((c) => c.id === id));
    await chat.deleteConversation(id);
    // 管家（D70）置顶入口不能消失：删的只是聊天记录，随即重开一个空私聊。
    if (wasButlerChat) await core.call('butler.ensure', {});
  }

  async function saveRename(): Promise<void> {
    const bot = ui.renameBot;
    const name = ui.renameName.trim();
    if (!bot || name.length === 0) return;
    // base = 打开对话框时这份 profile：core 三方合并，没改的字段不会被盖回去。
    const base = structuredClone($state.snapshot(bot.profile)) as BotProfile;
    const profile: BotProfile = {
      ...base,
      identity: { ...base.identity, name },
    };
    try {
      await contacts.update(bot.id, profile, base);
      ui.renameOpen = false;
      toast.success(t('settings.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }
</script>

<Tooltip.Provider delayDuration={0}>
  <Dialog
    open={ui.deleteTargetId !== null}
    onOpenChange={(open) => (ui.deleteTargetId = open ? ui.deleteTargetId : null)}
  >
    <DialogContent class="max-w-sm" data-testid="conversation-delete-dialog">
      <DialogHeader>
        <DialogTitle>{t('chats.deleteConversationTitle', { name: deleteTargetName })}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{t('chats.deleteConversationBody')}</p>
      {#if deleteTargetUsesAgent}
        <p class="text-xs text-muted-foreground" data-testid="conversation-delete-agent-note">
          {t('contacts.deleteAgentNote')}
        </p>
      {/if}
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (ui.deleteTargetId = null)}
          data-testid="conversation-delete-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={confirmDelete}
          data-testid="conversation-delete-confirm"
        >
          {t('chats.deleteConversation')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog bind:open={ui.renameOpen}>
    <DialogContent class="max-w-sm" data-testid="bot-rename-dialog">
      <DialogHeader>
        <DialogTitle>{t('sidebar.renameBot')}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-1.5">
        <label class="text-sm" for="bot-rename-input">{t('contacts.name')}</label>
        <Input
          id="bot-rename-input"
          bind:value={ui.renameName}
          placeholder={t('contacts.namePlaceholder')}
          data-testid="bot-rename-input"
        />
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (ui.renameOpen = false)}
          data-testid="bot-rename-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        <Button
          onclick={() => void saveRename()}
          disabled={ui.renameName.trim().length === 0}
          data-testid="bot-rename-save"
        >
          {t('settings.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</Tooltip.Provider>
