<script lang="ts">
  import {
    BOT_TEMPLATE_LIMITS,
    botTemplateSchema,
    type BotTemplate,
    type TeamBotsTemplateImportOutput,
  } from '@kepcup/shared';
  import { t, errorText, listSeparator } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import { connections } from '$lib/rpc/connections.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { botCapabilitiesOf, loadTeamBots } from './team-bots.svelte';

  /**
   * 团队模板导入弹框（2026-11「+」菜单重构）：两步同一个框——先选 Bot 类型
   * （private 恒可 / public 仅 canCreatePublicBot，B-1），选定后切换为选文件步，
   * 用 web / 桌面通用的 `<input type="file">`（不走桌面专用 platform.selectFile）
   * 选 `*.kepcup-bot.json`，客户端预检（JSON 合法 + ≤4MB）后 `team.bots.
   * templateImport { mode, template }` 上行——服务端直接建 Bot（无访谈），失败
   * 内联错误码，成功 toast + 技能警告（复用 D48 文案）并刷新团队 Bot 切片。
   * 自包含：内部拉能力面 / 预检 / 提交 / 刷新，宿主只管挂载与开关。
   */
  let { source, onClose }: { source: SourceId; onClose: () => void } = $props();

  let step = $state<'mode' | 'file'>('mode');
  let mode = $state<'private' | 'public'>('private');
  let fileInput = $state<HTMLInputElement | null>(null);
  /** 客户端预检通过的模板（提交体）；null = 未选 / 预检未过。 */
  let template = $state<BotTemplate | null>(null);
  let fileName = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);

  // 能力面（配额 / public 权限）自拉：切片未就绪时私有卡不前置禁用，配额满会
  // 直到提交才被服务端 BOT_LIMIT_REACHED 拒——挂载即拉一次，未就绪窗口最小化。
  $effect(() => {
    void loadTeamBots(source);
  });

  const caps = $derived(botCapabilitiesOf(source));
  const quota = $derived(
    caps === null ? null : { used: caps.privateBotsUsed, limit: caps.privateBotsLimit },
  );
  const quotaFull = $derived(quota !== null && quota.limit <= quota.used);

  function resetFile(): void {
    template = null;
    fileName = '';
    error = null;
  }

  function close(): void {
    if (submitting) return;
    resetFile();
    onClose();
  }

  /** 步骤 1 点类型卡：记档并切到文件步（配额满的私有卡不可点，服务端仍兜底拒）。 */
  function pickMode(next: 'private' | 'public'): void {
    mode = next;
    resetFile();
    step = 'file';
  }

  function backToMode(): void {
    if (submitting) return;
    resetFile();
    step = 'mode';
  }

  async function onPick(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const selected = input.files?.[0] ?? null;
    // 允许重选同一文件：清掉 value 让 change 事件总触发。
    input.value = '';
    if (selected === null || submitting) return;
    resetFile();
    if (selected.size > BOT_TEMPLATE_LIMITS.jsonBytes) {
      error = t('botTemplate.teamFileTooLarge');
      return;
    }
    try {
      // 客户端预检与契约同一 schema：坏文件在这里就地报错，不上行。
      template = botTemplateSchema.parse(JSON.parse(await selected.text()));
      fileName = selected.name;
    } catch {
      error = t('botTemplate.teamFileInvalid');
    }
  }

  async function submit(): Promise<void> {
    if (template === null || submitting) return;
    submitting = true;
    error = null;
    try {
      const result = (await connections.get(source).callTeam('team.bots.templateImport', {
        mode,
        template,
      })) as TeamBotsTemplateImportOutput;
      toast.success(t('botTemplate.importDone', { name: result.bot.name }));
      if (result.failedSkills.length > 0) {
        toast.warning(
          t('botTemplate.importSkillFailures', {
            count: result.failedSkills.length,
            names: result.failedSkills.map((skill) => skill.name).join(listSeparator()),
          }),
        );
      }
      if (result.skippedImportedSkills.length > 0) {
        const names = result.skippedImportedSkills
          .slice(0, 5)
          .map((skill) => skill.name)
          .join(listSeparator());
        const more = result.skippedImportedSkills.length > 5 ? '…' : '';
        toast.warning(
          t('botTemplate.importedSkillsSkipped', {
            count: result.skippedImportedSkills.length,
            names: `${names}${more}`,
          }),
        );
      }
      // 通讯录以 core `bot.updated` 事件自愈；这里再拉一次成员面切片，双保险。
      void loadTeamBots(source);
      void contacts.refresh();
      onClose();
    } catch (caught) {
      error = errorText((caught as { code?: string }).code, t('botTemplate.importFailed'));
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog
  open={true}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <DialogContent class="sm:max-w-md" data-testid="team-template-import-dialog">
    {#if step === 'mode'}
      <DialogHeader>
        <DialogTitle>{t('botTemplate.importEntry')}</DialogTitle>
        <DialogDescription>{t('botTemplate.teamImportModeHint')}</DialogDescription>
      </DialogHeader>
      <div class="space-y-1.5" data-testid="team-template-import-mode">
        <button
          type="button"
          class="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40
            {quotaFull ? 'cursor-not-allowed opacity-60' : 'bg-background'}"
          disabled={quotaFull}
          onclick={() => pickMode('private')}
          data-testid="team-template-import-mode-private"
        >
          <span class="min-w-0 flex-1">
            <span class="block font-medium">{t('teamBot.modePrivate')}</span>
            <span class="block text-xs text-muted-foreground">{t('teamBot.modePrivateHint')}</span>
            {#if quota !== null}
              <span class="block text-xs text-muted-foreground" data-testid="team-template-import-quota">
                {t('teamBot.quotaLabel', { used: quota.used, limit: quota.limit })}
              </span>
            {/if}
            {#if quotaFull}
              <span class="block text-xs text-destructive">
                {t('teamBot.limitReached', { used: quota?.used ?? 0, limit: quota?.limit ?? 0 })}
              </span>
            {/if}
          </span>
        </button>
        {#if caps?.canCreatePublicBot === true}
          <button
            type="button"
            class="flex w-full items-start gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary/40"
            onclick={() => pickMode('public')}
            data-testid="team-template-import-mode-public"
          >
            <span class="min-w-0 flex-1">
              <span class="block font-medium">{t('teamBot.modePublic')}</span>
              <span class="block text-xs text-muted-foreground">{t('teamBot.modePublicHint')}</span>
            </span>
          </button>
        {:else if caps !== null}
          <p class="text-xs text-muted-foreground" data-testid="team-template-import-public-unavailable">
            {t('teamBot.publicUnavailable')}
          </p>
        {/if}
      </div>
      <DialogFooter>
        <Button variant="outline" onclick={close} data-testid="team-template-import-cancel">
          {t('common.cancel')}
        </Button>
      </DialogFooter>
    {:else}
      <DialogHeader>
        <DialogTitle>{t('botTemplate.importEntry')}</DialogTitle>
        <DialogDescription>{t('botTemplate.teamImportFileHint')}</DialogDescription>
      </DialogHeader>
      <div class="space-y-2 text-sm">
        <input
          type="file"
          accept=".json,application/json"
          class="hidden"
          bind:this={fileInput}
          onchange={(event) => void onPick(event)}
          data-testid="team-template-import-input"
        />
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onclick={() => fileInput?.click()}
            disabled={submitting}
            data-testid="team-template-import-pick"
          >
            {t('botTemplate.pickFile')}
          </Button>
          <span
            class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid="team-template-import-file"
          >
            {fileName || t('botTemplate.noFilePicked')}
          </span>
        </div>
        {#if error !== null}
          <p class="text-xs text-destructive" data-testid="team-template-import-error">{error}</p>
        {/if}
      </div>
      <DialogFooter>
        <Button variant="ghost" onclick={backToMode} disabled={submitting} data-testid="team-template-import-back">
          {t('common.back')}
        </Button>
        <Button variant="outline" onclick={close} disabled={submitting}>
          {t('common.cancel')}
        </Button>
        <Button
          onclick={() => void submit()}
          disabled={template === null || submitting}
          data-testid="team-template-import-confirm"
        >
          {submitting ? t('botTemplate.teamImporting') : t('botTemplate.importConfirm')}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
