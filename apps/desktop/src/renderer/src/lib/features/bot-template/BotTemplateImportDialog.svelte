<script lang="ts">
  import type { BotsTemplateImportOutput, BotsTemplateInspectOutput } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
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
   * 「从模板导入」（docs/design/48-bot-template-export.md）：选 .kepcup-bot.json →
   * `bots.templateInspect` 出摘要（sha256 防确认后文件被替换）→ 确认后
   * `bots.templateImport` 从模板新建 Bot。已导入技能只列清单不自动安装
   *（内容在本机 git 技能库里），确认页直接提示。导入成功后 contacts
   * store 经 `bot.updated` 事件自动刷新。
   */

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let path = $state('');
  let inspecting = $state(false);
  let importing = $state(false);
  let info = $state<BotsTemplateInspectOutput | null>(null);
  let error = $state<string | null>(null);

  function reset(): void {
    info = null;
    error = null;
  }

  function close(): void {
    open = false;
    path = '';
    reset();
  }

  async function pick(): Promise<void> {
    const picked = await window.kepcup?.platform?.selectFile?.(['json']);
    if (picked !== null && picked !== undefined) {
      path = picked;
      await inspect();
    }
  }

  async function inspect(): Promise<void> {
    const target = path.trim();
    if (target.length === 0) return;
    inspecting = true;
    reset();
    try {
      info = (await core.call('bots.templateInspect', {
        path: target,
      })) as BotsTemplateInspectOutput;
    } catch (caught) {
      error = t('botTemplate.inspectFailed', {
        reason: String((caught as Error).message ?? caught),
      });
    } finally {
      inspecting = false;
    }
  }

  async function confirmImport(): Promise<void> {
    if (info === null) return;
    importing = true;
    try {
      const result = (await core.call('bots.templateImport', {
        path: path.trim(),
        sha256: info.sha256,
      })) as BotsTemplateImportOutput;
      toast.success(t('botTemplate.importDone', { name: info.name }));
      if (result.failedSkills.length > 0) {
        toast.warning(
          t('botTemplate.importSkillFailures', {
            count: result.failedSkills.length,
            names: result.failedSkills.map((skill) => skill.name).join('、'),
          }),
        );
      }
      if (result.skippedImportedSkills.length > 0) {
        // 已导入技能不随模板安装：确认页提示过一次，成功后再点名一次防漏看。
        const names = result.skippedImportedSkills
          .slice(0, 5)
          .map((skill) => skill.name)
          .join('、');
        const more = result.skippedImportedSkills.length > 5 ? '…' : '';
        toast.warning(
          t('botTemplate.importedSkillsSkipped', {
            count: result.skippedImportedSkills.length,
            names: `${names}${more}`,
          }),
        );
      }
      close();
    } catch (caught) {
      toast.error(
        t('botTemplate.importFailed', { reason: String((caught as Error).message ?? caught) }),
      );
    } finally {
      importing = false;
    }
  }
</script>

<Dialog
  bind:open
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <DialogContent class="max-w-md" data-testid="bot-import-template-dialog">
    <DialogHeader>
      <DialogTitle>{t('botTemplate.importTitle')}</DialogTitle>
      <DialogDescription>{t('botTemplate.importHint')}</DialogDescription>
    </DialogHeader>
    <div class="space-y-2 text-sm">
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => void pick()} disabled={importing}>
          {t('botTemplate.pickFile')}
        </Button>
        <span
          class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          data-testid="bot-import-template-path"
        >
          {path || t('botTemplate.noFilePicked')}
        </span>
      </div>
      {#if inspecting}
        <p class="text-muted-foreground">{t('botTemplate.loading')}</p>
      {:else if error !== null}
        <p class="text-destructive" data-testid="bot-import-template-error">{error}</p>
      {:else if info !== null}
        <div class="space-y-1 rounded-md border p-2" data-testid="bot-import-template-summary">
          <p class="font-medium">{info.name}</p>
          {#if info.bio.length > 0}
            <p class="text-xs text-muted-foreground">{info.bio}</p>
          {/if}
          <p class="text-xs text-muted-foreground">
            {info.model.length > 0
              ? t('botTemplate.includeModel', { model: info.model })
              : t('botTemplate.includeModelDefault')}
          </p>
          {#if info.authoredSkills.length > 0}
            <p class="text-xs text-muted-foreground">
              {t('botTemplate.includeSkills', { count: info.authoredSkills.length })}
            </p>
          {/if}
          {#if info.importedSkills.length > 0}
            <p class="text-xs text-amber-600 dark:text-amber-400">
              {t('botTemplate.importedSkillsNote', { count: info.importedSkills.length })}
            </p>
          {/if}
        </div>
      {/if}
    </div>
    <DialogFooter>
      <Button variant="outline" onclick={close} disabled={importing}>
        {t('contacts.cancel')}
      </Button>
      <Button
        onclick={() => void confirmImport()}
        disabled={info === null || inspecting || importing}
        data-testid="bot-import-template-confirm"
      >
        {t('botTemplate.importConfirm')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
