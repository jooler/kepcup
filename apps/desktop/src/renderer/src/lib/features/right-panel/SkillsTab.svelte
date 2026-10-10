<script lang="ts">
  import type { SkillEntry, SkillHistoryEntry } from '@kepcup/shared';
  import { errorText, t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { skillsStore } from '$lib/stores/skills.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import ImportSkillDialog from './ImportSkillDialog.svelte';

  let { botId, active }: { botId: string; active: boolean } = $props();

  const KIND_KEYS: Record<SkillEntry['kind'], MessageKey> = {
    builtin: 'skills.kind.builtin',
    imported: 'skills.kind.imported',
    authored: 'skills.kind.authored',
  };
  const STATUS_KEYS: Record<SkillEntry['status'], MessageKey> = {
    active: 'skills.status.active',
    disabled: 'skills.status.disabled',
    draft: 'skills.status.draft',
    incompatible: 'skills.status.incompatible',
  };
  const COMPAT_KEYS: Record<NonNullable<SkillEntry['compatibility']>, MessageKey> = {
    compatible: 'skills.compat.compatible',
    partial: 'skills.compat.partial',
    incompatible: 'skills.compat.incompatible',
  };

  let importOpen = $state(false);
  let uninstallTarget = $state<SkillEntry | null>(null);
  let uninstalling = $state(false);
  /** skills.read result of the viewed skill (null = dialog closed). */
  let reading = $state<{ name: string; content: string } | null>(null);
  let readLoading = $state(false);
  /** History of the inspected authored skill (null = dialog closed). */
  let historyFor = $state<string | null>(null);
  let history = $state<SkillHistoryEntry[]>([]);
  let historyLoading = $state(false);
  /** Two-step rollback: the entry awaiting confirmation. */
  let rollbackTarget = $state<SkillHistoryEntry | null>(null);
  let rollingBack = $state(false);

  // bits-ui keeps inactive tab content mounted (hidden): fetch only while the
  // tab is visible, and refetch on every activation (same as MemoryTab).
  $effect(() => {
    skillsStore.start();
    if (active) void skillsStore.load(botId, true);
  });

  const skills = $derived(skillsStore.skills);

  async function setEnabled(skill: SkillEntry, enabled: boolean): Promise<void> {
    try {
      await skillsStore.setEnabled(botId, skill.name, enabled);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')));
    }
  }

  async function uninstall(): Promise<void> {
    const target = uninstallTarget;
    if (target === null) return;
    uninstalling = true;
    try {
      await skillsStore.uninstall(botId, target.name);
      toast.success(t('skills.uninstalled'));
      uninstallTarget = null;
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')));
    } finally {
      uninstalling = false;
    }
  }

  async function view(skill: SkillEntry): Promise<void> {
    readLoading = true;
    reading = { name: skill.name, content: '' };
    try {
      const result = await skillsStore.read(botId, skill.name);
      reading = { name: result.name, content: result.content };
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')));
      reading = null;
    } finally {
      readLoading = false;
    }
  }

  async function openHistory(skill: SkillEntry): Promise<void> {
    historyFor = skill.name;
    historyLoading = true;
    rollbackTarget = null;
    try {
      history = await skillsStore.history(botId, skill.name);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')));
      history = [];
    } finally {
      historyLoading = false;
    }
  }

  async function rollback(): Promise<void> {
    const target = rollbackTarget;
    if (target === null || historyFor === null) return;
    rollingBack = true;
    try {
      await skillsStore.rollback(botId, historyFor, target.oid);
      toast.success(t('skills.rollbackDone'));
      rollbackTarget = null;
      history = await skillsStore.history(botId, historyFor);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')));
    } finally {
      rollingBack = false;
    }
  }

  function shortOid(oid: string): string {
    return oid.slice(0, 10);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="skills-tab">
  <div class="flex items-center justify-between gap-1">
    <p class="text-xs text-muted-foreground">{t('skills.tabHint')}</p>
  </div>
  <div class="flex items-center gap-1.5">
    <Button size="sm" variant="outline" onclick={() => (importOpen = true)} data-testid="skills-import">
      {t('skills.import')}
    </Button>
    <Button
      size="sm"
      variant="ghost"
      class="text-xs text-muted-foreground"
      onclick={() => shell.openExtensionCenter('skills')}
      data-testid="skills-open-market"
    >
      {t('skills.openMarket')}
    </Button>
  </div>

  {#if skillsStore.loading && skills.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="skills-loading">…</p>
  {:else if skills.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="skills-empty">{t('skills.empty')}</p>
  {:else}
    <ul class="space-y-2" data-testid="skills-list">
      {#each skills as skill (skill.name)}
        <li
          class="rounded-md border p-2 text-sm {skill.status === 'active' ? '' : 'opacity-70'}"
          data-testid={`skill-item-${skill.name}`}
          data-skill-kind={skill.kind}
          data-skill-scope={skill.scope}
          data-skill-status={skill.status}
          data-skill-compat={skill.compatibility ?? ''}
        >
          <p class="font-medium" data-testid="skill-name">
            {skill.name}
            {#if skill.scope === 'public'}
              <Badge
                variant="secondary"
                class="ml-1 align-middle text-[10px]"
                data-testid="skill-scope"
              >
                {t('skills.scope.public')}
              </Badge>
            {/if}
          </p>
          {#if skill.description.length > 0}
            <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
          {/if}
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary" data-testid="skill-kind">{t(KIND_KEYS[skill.kind])}</Badge>
            <Badge
              variant="outline"
              class={skill.status === 'active' ? 'text-emerald-700' : ''}
              data-testid="skill-status"
            >
              {t(STATUS_KEYS[skill.status])}
            </Badge>
            {#if skill.compatibility !== null}
              <Badge
                variant={skill.compatibility === 'compatible' ? 'secondary' : 'destructive'}
                data-testid="skill-compat"
              >
                {t(COMPAT_KEYS[skill.compatibility])}
              </Badge>
            {/if}
          </div>
          {#if skill.missingDeps.length > 0}
            <p class="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="skill-missing-deps">
              {t('skills.missingDeps', { deps: skill.missingDeps.join('、') })}
            </p>
          {/if}
          {#if skill.enhancedRequired && skill.compatibility === 'incompatible'}
            <!-- P12: 增强级未安装 → 不兼容 + 可安装提示（enhancedInstallHint 契约） -->
            <p class="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="skill-enhanced-hint">
              {t('skills.enhancedHint', { hint: skill.enhancedInstallHint ?? skill.statusReason ?? '' })}
            </p>
          {/if}
          {#if skill.status === 'draft' && skill.statusReason !== null}
            <p class="mt-1 text-xs text-muted-foreground" data-testid="skill-status-reason">
              {skill.statusReason}
            </p>
          {/if}
          <div class="mt-2 flex flex-wrap items-center gap-1">
            {#if skill.status === 'active'}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => void setEnabled(skill, false)}
                data-testid={`skill-disable-${skill.name}`}
              >
                {t('skills.disable')}
              </Button>
            {:else if skill.status === 'disabled'}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => void setEnabled(skill, true)}
                data-testid={`skill-enable-${skill.name}`}
              >
                {t('skills.enable')}
              </Button>
            {/if}
            <Button
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs"
              onclick={() => void view(skill)}
              data-testid={`skill-view-${skill.name}`}
            >
              {t('skills.view')}
            </Button>
            {#if skill.kind === 'authored'}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => void openHistory(skill)}
                data-testid={`skill-history-${skill.name}`}
              >
                {t('skills.history')}
              </Button>
            {/if}
            {#if skill.status !== 'draft'}
              <Button
                size="sm"
                variant="ghost"
                class="ml-auto h-6 px-2 text-xs text-destructive"
                onclick={() => (uninstallTarget = skill)}
                data-testid={`skill-uninstall-${skill.name}`}
              >
                {t('skills.uninstall')}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<ImportSkillDialog bind:open={importOpen} {botId} />

<!-- 查看 SKILL.md 全文（原文渲染，渐进式加载的“需要时读取全文”入口） -->
<Dialog
  open={reading !== null}
  onOpenChange={(value) => {
    if (!value) reading = null;
  }}
>
  <DialogContent class="flex max-h-[80vh] max-w-2xl flex-col" data-testid="skills-read-dialog">
    <DialogHeader>
      <DialogTitle>{t('skills.readTitle', { name: reading?.name ?? '' })}</DialogTitle>
      <DialogDescription>{t('skills.readHint')}</DialogDescription>
    </DialogHeader>
    <div class="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3" data-testid="skills-read-body">
      {#if readLoading}
        <p class="text-sm text-muted-foreground">…</p>
      {:else}
        <pre class="whitespace-pre-wrap break-words font-mono text-xs" data-testid="skills-read-content">{reading?.content}</pre>
      {/if}
    </div>
    <DialogFooter>
      <Button variant="outline" onclick={() => (reading = null)} data-testid="skills-read-close">
        {t('common.close')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- 自建技能版本历史 + 回滚（回滚为新提交，不改写历史） -->
<Dialog
  open={historyFor !== null}
  onOpenChange={(value) => {
    if (!value) {
      historyFor = null;
      rollbackTarget = null;
    }
  }}
>
  <DialogContent class="flex max-h-[80vh] max-w-lg flex-col" data-testid="skills-history-dialog">
    <DialogHeader>
      <DialogTitle>{t('skills.historyTitle', { name: historyFor ?? '' })}</DialogTitle>
      <DialogDescription>{t('skills.historyHint')}</DialogDescription>
    </DialogHeader>
    <div class="min-h-0 flex-1 overflow-auto" data-testid="skills-history-body">
      {#if historyLoading}
        <p class="text-sm text-muted-foreground">…</p>
      {:else if history.length === 0}
        <p class="text-sm text-muted-foreground" data-testid="skills-history-empty">
          {t('skills.historyEmpty')}
        </p>
      {:else}
        <ul class="space-y-2">
          {#each history as entry (entry.oid)}
            <li class="rounded-md border p-2 text-sm" data-testid={`skills-history-item-${entry.oid}`}>
              <p class="break-words" data-testid="skills-history-message">{entry.message}</p>
              <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <code data-testid="skills-history-oid">{shortOid(entry.oid)}</code>
                <span>{new Date(entry.createdAt).toLocaleString()}</span>
                {#if rollbackTarget?.oid === entry.oid}
                  <span class="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-6 px-2 text-xs"
                      onclick={() => (rollbackTarget = null)}
                      data-testid="skills-rollback-cancel"
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      class="h-6 px-2 text-xs"
                      disabled={rollingBack}
                      onclick={() => void rollback()}
                      data-testid="skills-rollback-confirm"
                    >
                      {t('skills.rollbackConfirm')}
                    </Button>
                  </span>
                {:else}
                  <Button
                    size="sm"
                    variant="ghost"
                    class="ml-auto h-6 px-2 text-xs"
                    onclick={() => (rollbackTarget = entry)}
                    data-testid={`skills-rollback-${entry.oid}`}
                  >
                    {t('skills.rollback')}
                  </Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <DialogFooter>
      <Button variant="outline" onclick={() => (historyFor = null)} data-testid="skills-history-close">
        {t('common.close')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- 卸载两步确认 -->
<Dialog
  open={uninstallTarget !== null}
  onOpenChange={(value) => {
    if (!value) uninstallTarget = null;
  }}
>
  <DialogContent data-testid="skills-uninstall-dialog">
    <DialogHeader>
      <DialogTitle>{t('skills.uninstallTitle', { name: uninstallTarget?.name ?? '' })}</DialogTitle>
      <DialogDescription>{t('skills.uninstallBody')}</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={() => (uninstallTarget = null)}>
        {t('common.cancel')}
      </Button>
      <Button
        variant="destructive"
        disabled={uninstalling}
        onclick={() => void uninstall()}
        data-testid="skills-uninstall-confirm"
      >
        {t('skills.uninstall')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
