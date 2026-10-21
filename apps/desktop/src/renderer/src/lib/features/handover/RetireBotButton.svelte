<script lang="ts">
  import { Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, listSeparator } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
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
  let {
    botId,
    botName,
    toBotId,
    remaining,
  }: {
    botId: string;
    botName: string;
    toBotId: string;
    remaining: { memory: number; wikiPages: number; skills: number; widgets: number };
  } = $props();

  const bot = $derived(contacts.bots.find((candidate) => candidate.id === botId) ?? null);
  /** The receiving bot must still exist too (its deletion took the handed-over assets). */
  const target = $derived(contacts.bots.find((candidate) => candidate.id === toBotId) ?? null);
  /** What the source still holds that was not copied (deleting it destroys these). */
  const remainingText = $derived(
    (
      [
        ['memory', remaining.memory],
        ['wikiPages', remaining.wikiPages],
        ['skills', remaining.skills],
        ['widgets', remaining.widgets],
      ] as const
    )
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => t(`handover.remaining.${kind}`, { count }))
      .join(listSeparator()),
  );
  let open = $state(false);
  let preview = $state({
    conversations: 0,
    messages: 0,
    ledProjects: [] as Array<{ id: string; title: string | null }>,
  });
  let deleting = $state(false);

  async function ask(): Promise<void> {
    try {
      preview = await contacts.deletionPreview(botId);
      open = true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The bot leads projects: deletion is blocked (the backend would reject
   * with PROJECT_LEAD_REQUIRED). Jump to that project's members section so
   * the user can hand the lead over first.
   */
  async function goReplaceLead(conversationId: string): Promise<void> {
    open = false;
    await chat.select(conversationId);
    shell.openProjectSettings('members');
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

{#if bot !== null && target !== null && bot.systemRole !== 'butler'}
  <div class="mt-2 flex flex-wrap items-center gap-2" data-testid="handover-retire">
    <p class="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="handover-retire-hint">
      {remainingText.length > 0
        ? t('handover.retireHintRemaining', {
            name: bot.name,
            to: target.name,
            items: remainingText,
          })
        : t('handover.retireHint', { name: bot.name })}
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
      {#if preview.ledProjects.length > 0}
        <!-- Leading projects block the delete: no confirm button, offer the
             "go replace" jump into each project's members section instead. -->
        <div class="space-y-1.5" data-testid="handover-retire-lead-blocked">
          <p class="text-sm text-muted-foreground">
            {t('contacts.deleteBlockedLead', { count: preview.ledProjects.length })}
          </p>
          <ul class="space-y-1.5">
            {#each preview.ledProjects as project (project.id)}
              <li class="flex items-center gap-2 rounded-md border p-2 text-sm">
                <span class="min-w-0 flex-1 truncate">
                  {project.title ?? t('project.untitled')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onclick={() => void goReplaceLead(project.id)}
                  data-testid={`handover-retire-go-replace-${project.id}`}
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
          onclick={() => (open = false)}
          data-testid="handover-retire-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        {#if preview.ledProjects.length === 0}
          <Button
            variant="destructive"
            onclick={confirm}
            disabled={deleting}
            data-testid="handover-retire-confirm"
          >
            {t('contacts.deleteConfirm')}
          </Button>
        {/if}
      </DialogFooter>
    </DialogContent>
  </Dialog>
{/if}
