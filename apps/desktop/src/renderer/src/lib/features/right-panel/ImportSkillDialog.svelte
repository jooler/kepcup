<script lang="ts">
  import type { SkillCandidate } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { skillsStore } from '$lib/stores/skills.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  let { botId, open = $bindable(false) }: { botId: string; open?: boolean } = $props();

  let url = $state('');
  let ref = $state('');
  let subdirectory = $state('');
  /** Non-null while a multi-skill repository awaits the user's pick. */
  let candidates = $state<SkillCandidate[] | null>(null);
  let submitting = $state(false);

  $effect(() => {
    if (!open) {
      // Reset for the next import (candidates included).
      url = '';
      ref = '';
      subdirectory = '';
      candidates = null;
      submitting = false;
    }
  });

  async function submit(): Promise<void> {
    if (submitting) return;
    if (url.trim().length === 0) {
      toast.error(t('skills.requireUrl'));
      return;
    }
    submitting = true;
    try {
      const result = await skillsStore.import({
        botId,
        sourceUrl: url.trim(),
        ref: ref.trim(),
        subdirectory: subdirectory.trim(),
      });
      if (result.status === 'candidates') {
        candidates = result.candidates;
        return;
      }
      toast.success(t('skills.importSubmitted'));
      open = false;
    } catch (error) {
      // core 的 SKILL_IMPORT_FAILED 消息带具体原因（克隆失败 / 找不到分支 /
      // 无 SKILL.md…），优先原样展示；完整错误（code / details）进控制台。
      const code = (error as { code?: string } | undefined)?.code;
      const message = error instanceof Error && error.message.length > 0 ? error.message : null;
      console.error('[skills] import failed', {
        botId,
        sourceUrl: url.trim(),
        ref: ref.trim(),
        subdirectory: subdirectory.trim(),
        code,
        error,
      });
      toast.error(message ?? errorText(code, t('skills.importFailed')));
    } finally {
      submitting = false;
    }
  }

  function pick(candidate: SkillCandidate): void {
    subdirectory = candidate.subdirectory;
    void submit();
  }
</script>

<Dialog bind:open>
  <DialogContent class="max-w-lg" data-testid="skills-import-dialog">
    <DialogHeader>
      <DialogTitle>{t('skills.importTitle')}</DialogTitle>
      <DialogDescription>{t('skills.importDescription')}</DialogDescription>
    </DialogHeader>

    {#if candidates === null}
      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="skills-import-url">{t('skills.importUrl')}</Label>
          <Input
            id="skills-import-url"
            bind:value={url}
            placeholder={t('skills.importUrlPlaceholder')}
            data-testid="skills-import-url"
          />
        </div>
        <div class="space-y-1.5">
          <Label for="skills-import-subdirectory">{t('skills.importSubdirectory')}</Label>
          <Input
            id="skills-import-subdirectory"
            bind:value={subdirectory}
            placeholder="skills/my-skill"
            data-testid="skills-import-subdirectory"
          />
        </div>
        <div class="space-y-1.5">
          <Label for="skills-import-ref">{t('skills.importRef')}</Label>
          <Input
            id="skills-import-ref"
            bind:value={ref}
            placeholder="main / v1.2.0"
            data-testid="skills-import-ref"
          />
        </div>
      </div>
    {:else}
      <div class="space-y-2" data-testid="skills-import-candidates">
        <p class="text-sm text-muted-foreground">{t('skills.importCandidates')}</p>
        {#each candidates as candidate (candidate.subdirectory)}
          <div
            class="flex items-center gap-3 rounded-md border p-2"
            data-testid={`skills-import-candidate-${candidate.name}`}
          >
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{candidate.name}</p>
              {#if candidate.description.length > 0}
                <p class="truncate text-xs text-muted-foreground">{candidate.description}</p>
              {/if}
              <p class="truncate text-xs text-muted-foreground">{candidate.subdirectory}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onclick={() => pick(candidate)}
              data-testid={`skills-import-candidate-use-${candidate.name}`}
            >
              {t('skills.importCandidateUse')}
            </Button>
          </div>
        {/each}
      </div>
    {/if}

    <DialogFooter>
      <Button variant="outline" onclick={() => (open = false)}>{t('common.cancel')}</Button>
      {#if candidates === null}
        <Button disabled={submitting} onclick={() => void submit()} data-testid="skills-import-submit">
          {submitting ? t('skills.importSubmitting') : t('skills.importSubmit')}
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>
