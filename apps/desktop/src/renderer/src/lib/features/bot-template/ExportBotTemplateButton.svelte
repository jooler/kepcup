<script lang="ts">
  import type { BotsTemplatePreviewOutput } from '@kepcup/shared';
  import { botTemplateFileName } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { endpointSupports } from '$lib/features/web-shell/endpoint';
  import { FileDown } from '@lucide/svelte';
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
   * 「导出为模板」（docs/design/48-bot-template-export.md）：预览将包含/剥离的
   * 内容 → 系统保存对话框（只拿路径）→ core 序列化并原子写文件。模板只含
   * 人设/职责/边界/模型与能力包/自写技能/头像；对话、记忆、知识库、任务、
   * 组件与密钥永不包含，本机引用（MCP/连接/浏览器资料/InkCop/域名白名单）
   * 在 core 侧剥离。
   */

  let { botId, botName }: { botId: string; botName: string } = $props();

  let open = $state(false);
  let loading = $state(false);
  let exporting = $state(false);
  let preview = $state<BotsTemplatePreviewOutput | null>(null);
  let error = $state<string | null>(null);

  const desktop = $derived(endpointSupports('local-file-dialog'));

  /** 剥离提示按实际有内容的项拼（全空则整段不显示）。 */
  const strippedNotes = $derived.by(() => {
    if (preview === null) return [] as string[];
    const notes: string[] = [];
    const s = preview.stripped;
    if (s.mcpServers > 0) notes.push(t('botTemplate.strippedMcp', { count: s.mcpServers }));
    if (s.appConnections > 0)
      notes.push(t('botTemplate.strippedApps', { count: s.appConnections }));
    if (s.browserProfile) notes.push(t('botTemplate.strippedBrowser'));
    if (s.inkcopAgents > 0) notes.push(t('botTemplate.strippedInkcop', { count: s.inkcopAgents }));
    if (s.networkAllowlist > 0)
      notes.push(t('botTemplate.strippedAllowlist', { count: s.networkAllowlist }));
    return notes;
  });

  async function askExport(): Promise<void> {
    open = true;
    loading = true;
    error = null;
    preview = null;
    try {
      preview = (await core.call('bots.templatePreview', { botId })) as BotsTemplatePreviewOutput;
    } catch (caught) {
      error = String((caught as Error).message ?? caught);
    } finally {
      loading = false;
    }
  }

  async function confirmExport(): Promise<void> {
    if (preview === null) return;
    const target = await window.kepcup?.platform?.saveFile?.({
      title: t('botTemplate.exportDialogTitle', { name: preview.name }),
      defaultFileName: botTemplateFileName(preview.name),
      extensions: ['json'],
    });
    if (target === null || target === undefined) return;
    exporting = true;
    try {
      const result = (await core.call('bots.templateExport', {
        botId,
        path: target,
      })) as { path: string; bytes: number };
      toast.success(t('botTemplate.exportDone', { path: result.path }));
      open = false;
    } catch (caught) {
      toast.error(
        t('botTemplate.exportFailed', { reason: String((caught as Error).message ?? caught) }),
      );
    } finally {
      exporting = false;
    }
  }
</script>

<Button
  variant="outline"
  size="sm"
  class="h-7 w-full gap-1"
  disabled={!desktop}
  title={desktop ? '' : t('botTemplate.desktopOnly')}
  onclick={() => void askExport()}
  data-testid="bot-export-template"
>
  <FileDown class="size-3.5" aria-hidden="true" />
  {t('botTemplate.exportButton', { name: botName })}
</Button>

<Dialog bind:open>
  <DialogContent class="max-w-md" data-testid="bot-export-template-dialog">
    <DialogHeader>
      <DialogTitle>{t('botTemplate.exportDialogTitle', { name: botName })}</DialogTitle>
      <DialogDescription>{t('botTemplate.exportDialogHint')}</DialogDescription>
    </DialogHeader>
    {#if loading}
      <p class="text-sm text-muted-foreground">{t('botTemplate.loading')}</p>
    {:else if error !== null}
      <p class="text-sm text-destructive" data-testid="bot-export-template-error">{error}</p>
    {:else if preview !== null}
      <div class="space-y-2 text-sm">
        <p class="font-medium">{t('botTemplate.includeTitle')}</p>
        <ul class="list-inside list-disc space-y-1 text-muted-foreground">
          <li>{t('botTemplate.includePersona')}</li>
          <li>{t('botTemplate.includeRole')}</li>
          {#if preview.boundariesCount > 0}
            <li>{t('botTemplate.includeBoundaries', { count: preview.boundariesCount })}</li>
          {/if}
          <li>
            {preview.model.length > 0
              ? t('botTemplate.includeModel', { model: preview.model })
              : t('botTemplate.includeModelDefault')}
          </li>
          {#if preview.authoredSkills.length > 0}
            <li>{t('botTemplate.includeSkills', { count: preview.authoredSkills.length })}</li>
          {/if}
          {#if preview.importedSkills.length > 0}
            <li>
              {t('botTemplate.includeImportedSkills', { count: preview.importedSkills.length })}
            </li>
          {/if}
          {#if preview.avatar !== 'none'}
            <li>{t('botTemplate.includeAvatar')}</li>
          {/if}
        </ul>
        <p class="pt-1 font-medium">{t('botTemplate.excludeTitle')}</p>
        <p class="text-muted-foreground">{t('botTemplate.excludeBody')}</p>
        {#if strippedNotes.length > 0}
          <p class="pt-1 font-medium">{t('botTemplate.strippedTitle')}</p>
          <ul class="list-inside list-disc space-y-1 text-muted-foreground">
            {#each strippedNotes as note (note)}
              <li>{note}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    <DialogFooter>
      <Button variant="outline" onclick={() => (open = false)} disabled={exporting}>
        {t('contacts.cancel')}
      </Button>
      <Button
        onclick={() => void confirmExport()}
        disabled={loading || error !== null || preview === null || exporting || !desktop}
        data-testid="bot-export-template-confirm"
      >
        {t('botTemplate.exportConfirm')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
