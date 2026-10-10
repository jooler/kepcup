<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { skillsStore } from '$lib/stores/skills.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 技能目录在应用外被删除（core 发 skills.missing）：全局弹框告知，只能点
   * 「知道了」关闭——点击后调 skills.purgeMissing 清理 DB 记录。队列里有多个
   * 时逐个弹。挂在 AppSidebar（常驻），所以 skillsStore 在应用启动时就订阅。
   */

  $effect(() => {
    skillsStore.start();
  });

  const current = $derived(skillsStore.missing[0] ?? null);
  let busy = $state(false);

  async function acknowledge(): Promise<void> {
    if (current === null || busy) return;
    busy = true;
    try {
      await skillsStore.acknowledgeMissing(current.name);
      toast.success(t('skills.missingPurged', { name: current.name }));
    } catch (error) {
      console.error('[skills] purge missing failed', { name: current.name, error });
      toast.error(
        error instanceof Error && error.message.length > 0 ? error.message : t('skills.actionFailed'),
      );
    } finally {
      busy = false;
    }
  }
</script>

<Dialog open={current !== null}>
  <DialogContent
    showCloseButton={false}
    escapeKeydownBehavior="ignore"
    interactOutsideBehavior="ignore"
    data-testid="skill-missing-dialog"
  >
    {#if current !== null}
      <DialogHeader>
        <DialogTitle>{t('skills.missingTitle')}</DialogTitle>
        <DialogDescription>{t('skills.missingBody', { name: current.name })}</DialogDescription>
      </DialogHeader>
      <p class="break-all text-xs text-muted-foreground" data-testid="skill-missing-path">
        {current.dirPath}
      </p>
      <DialogFooter>
        <Button disabled={busy} onclick={() => void acknowledge()} data-testid="skill-missing-ack">
          {t('skills.missingAck')}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
