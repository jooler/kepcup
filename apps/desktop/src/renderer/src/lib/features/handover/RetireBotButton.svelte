<script lang="ts">
  import { Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 移交「退役」（D88 P2，设计 37 §6）：这次移交的条目都已完成时，结果卡上的「删除 {A}」。
   * 只是 D18 删除的另一个入口——同一份删除确认（`bots.deletionPreview` 的统计 + 确认），
   * 走同一个 `bots.delete`；从不自动删除。管家与已删除的 Bot 不出按钮（core 的
   * `view.retire` 已排除管家；这里再按通讯录确认 Bot 仍在）。
   */
  let { botId, botName }: { botId: string; botName: string } = $props();

  const bot = $derived(contacts.bots.find((candidate) => candidate.id === botId) ?? null);
  let open = $state(false);
  let preview = $state({ conversations: 0, messages: 0 });
  let deleting = $state(false);

  async function ask(): Promise<void> {
    try {
      preview = await contacts.deletionPreview(botId);
      open = true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirm(): Promise<void> {
    deleting = true;
    try {
      await contacts.remove(botId);
      open = false;
      toast.success(t('contacts.deleteTitle', { name: botName }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      deleting = false;
    }
  }
</script>

{#if bot !== null && bot.systemRole !== 'butler'}
  <div class="mt-2 flex flex-wrap items-center gap-2" data-testid="handover-retire">
    <p class="min-w-0 flex-1 text-xs text-muted-foreground">
      {t('handover.retireHint', { name: bot.name })}
    </p>
    <Button
      size="sm"
      variant="outline"
      class="gap-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
      onclick={() => void ask()}
      data-testid="handover-retire-button"
    >
      <Trash2 class="size-3.5" />
      {t('handover.retire', { name: bot.name })}
    </Button>
  </div>

  <Dialog bind:open>
    <DialogContent class="max-w-md" data-testid="handover-retire-dialog">
      <DialogHeader>
        <DialogTitle>{t('contacts.deleteTitle', { name: bot.name })}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground" data-testid="handover-retire-body">
        {t('contacts.deleteBody', {
          conversations: preview.conversations,
          messages: preview.messages,
        })}
      </p>
      {#if bot.profile.runtime.agent.id.length > 0}
        <p class="text-xs text-muted-foreground">{t('contacts.deleteAgentNote')}</p>
      {/if}
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (open = false)}
          data-testid="handover-retire-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={confirm}
          disabled={deleting}
          data-testid="handover-retire-confirm"
        >
          {t('contacts.deleteConfirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
{/if}
