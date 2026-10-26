<script lang="ts">
  /**
   * 技能 Tab：列表态 + 详情态两级。列表每行 = 名称（左）+ 标签（右），整行
   * 可点进详情；草稿（生成未通过校验的中间态，内容在 _drafts/ 未转正）不入
   * 正式清单，统一收进底部折叠区。详情复述原卡片内容但不带卡片边框，操作
   * 按钮都在详情里。草稿没有启用入口：core 的 enable 对草稿行 fail-closed
   * （行翻 active 而内容不可达 = 幽灵启用），详情只展示失败原因。
   */
  import type { SkillEntry, SkillHistoryEntry } from '@kepcup/shared';
  import { errorText, t, listSeparator, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { ChevronLeft, ChevronRight, Check, X, Minus } from '@lucide/svelte';
  import { skillsStore } from '$lib/stores/skills.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { parseSkillDraftChecks } from './skill-draft-checks';
  import { skillNav } from './skills-nav.svelte';
  import { pluginIdOfSkillSource } from '../plugins/plugin-install';
  import { plugins } from '../plugins/plugins.svelte';
  import PluginSourceBadge from '../plugins/PluginSourceBadge.svelte';
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
  let draftsOpen = $state(false);
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

  // 离开技能 Tab 即回落列表态（与 MemoryTab 的面包屑归位同理，不跨打开残留）。
  $effect(() => {
    return () => {
      skillNav.reset();
      draftsOpen = false;
    };
  });

  const skills = $derived(skillsStore.skills);
  const mainSkills = $derived(skills.filter((skill) => skill.status !== 'draft'));
  const draftSkills = $derived(skills.filter((skill) => skill.status === 'draft'));
  const selected = $derived(
    skillNav.selectedName === null
      ? null
      : (skills.find((skill) => skill.name === skillNav.selectedName) ?? null),
  );

  async function setEnabled(skill: SkillEntry, enabled: boolean): Promise<void> {
    try {
      await skillsStore.setEnabled(botId, skill.name, enabled);
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')),
      );
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
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')),
      );
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
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')),
      );
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
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')),
      );
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
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('skills.actionFailed')),
      );
    } finally {
      rollingBack = false;
    }
  }

  function shortOid(oid: string): string {
    return oid.slice(0, 10);
  }
</script>

{#snippet skillRow(skill: SkillEntry)}
  <button
    type="button"
    class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent/50 {skill.status ===
    'draft'
      ? 'opacity-60'
      : ''}"
    data-testid={`skill-item-${skill.name}`}
    data-skill-kind={skill.kind}
    data-skill-scope={skill.scope}
    data-skill-status={skill.status}
    data-skill-compat={skill.compatibility ?? ''}
    onclick={() => (skillNav.selectedName = skill.name)}
  >
    <span class="min-w-0 truncate font-medium" data-testid="skill-name">{skill.name}</span>
    <span class="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {#if skill.scope === 'public'}
        <Badge variant="secondary" class="text-[10px]" data-testid="skill-scope">
          {t('skills.scope.public')}
        </Badge>
      {/if}
      {#if pluginIdOfSkillSource(skill.sourceUrl ?? '') !== null}
        <PluginSourceBadge
          pluginId={pluginIdOfSkillSource(skill.sourceUrl ?? '')!}
          testid={`skill-plugin-badge-${skill.name}`}
        />
      {/if}
      <Badge variant="secondary" class="text-[10px]" data-testid="skill-kind">
        {t(KIND_KEYS[skill.kind])}
      </Badge>
      <Badge
        variant="outline"
        class="text-[10px] {skill.status === 'active' ? 'text-emerald-700' : ''}"
        data-testid="skill-status"
      >
        {t(STATUS_KEYS[skill.status])}
      </Badge>
      {#if skill.compatibility !== null}
        <Badge
          variant={skill.compatibility === 'compatible' ? 'secondary' : 'destructive'}
          class="text-[10px]"
          data-testid="skill-compat"
        >
          {t(COMPAT_KEYS[skill.compatibility])}
        </Badge>
      {/if}
    </span>
  </button>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="skills-tab">
  {#if selected}
    <!-- 详情态：复述原卡片内容，不带卡片边框；操作按钮集中在这里。 -->
    {@const skill = selected}
    <div class="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="skill-detail">
      <Button
        variant="ghost"
        size="sm"
        class="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
        onclick={() => (skillNav.selectedName = null)}
        data-testid="skills-back"
      >
        <ChevronLeft class="size-3.5" aria-hidden="true" />
        {t('common.back')}
      </Button>
      <p class="mt-1 text-base font-medium" data-testid="skill-detail-name">
        {skill.name}
        {#if skill.scope === 'public'}
          <Badge
            variant="secondary"
            class="ml-1 align-middle text-[10px]"
            data-testid="skill-detail-scope"
          >
            {t('skills.scope.public')}
          </Badge>
        {/if}
        {#if pluginIdOfSkillSource(skill.sourceUrl ?? '') !== null}
          <span class="ml-1 inline-flex align-middle">
            <PluginSourceBadge
              pluginId={pluginIdOfSkillSource(skill.sourceUrl ?? '')!}
              testid={`skill-plugin-badge-${skill.name}`}
            />
          </span>
        {/if}
      </p>
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="secondary" data-testid="skill-detail-kind">
          {t(KIND_KEYS[skill.kind])}
        </Badge>
        <Badge
          variant="outline"
          class={skill.status === 'active' ? 'text-emerald-700' : ''}
          data-testid="skill-detail-status"
        >
          {t(STATUS_KEYS[skill.status])}
        </Badge>
        {#if skill.compatibility !== null}
          <Badge
            variant={skill.compatibility === 'compatible' ? 'secondary' : 'destructive'}
            data-testid="skill-detail-compat"
          >
            {t(COMPAT_KEYS[skill.compatibility])}
          </Badge>
        {/if}
      </div>
      {#if skill.description.length > 0}
        <p
          class="mt-2 text-sm break-words text-muted-foreground"
          data-testid="skill-detail-description"
        >
          {skill.description}
        </p>
      {/if}
      {#if skill.missingDeps.length > 0}
        <p
          class="mt-2 text-xs break-words text-amber-700 dark:text-amber-400"
          data-testid="skill-missing-deps"
        >
          {t('skills.missingDeps', { deps: skill.missingDeps.join(listSeparator()) })}
        </p>
      {/if}
      {#if skill.enhancedRequired && skill.compatibility === 'incompatible'}
        <!-- P12: 增强级未安装 → 不兼容 + 可安装提示（enhancedInstallHint 契约） -->
        <p
          class="mt-2 text-xs break-words text-amber-700 dark:text-amber-400"
          data-testid="skill-enhanced-hint"
        >
          {t('skills.enhancedHint', {
            hint: skill.enhancedInstallHint ?? skill.statusReason ?? '',
          })}
        </p>
      {/if}
      {#if (skill.status === 'draft' || skill.status === 'disabled') && skill.statusReason !== null}
        <!-- draft = 生成失败原因（TAP 风格逐条还原：绿勾/红叉/无图标行）；disabled = 未启用原因 -->
        {@const draftChecks =
          skill.status === 'draft' ? parseSkillDraftChecks(skill.statusReason) : null}
        {#if draftChecks !== null}
          <ul class="mt-2 space-y-1" data-testid="skill-check-list">
            {#each draftChecks as check, index (index)}
              <li
                class="flex items-start gap-1.5 text-xs"
                data-testid={`skill-check-item-${index}`}
                data-check-kind={check.kind}
              >
                {#if check.kind === 'pass'}
                  <Check
                    class="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    aria-hidden="true"
                  />
                {:else if check.kind === 'fail'}
                  <X class="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                {:else}
                  <Minus
                    class="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50"
                    aria-hidden="true"
                  />
                {/if}
                <span
                  class="min-w-0 break-words {check.kind === 'fail'
                    ? 'font-medium'
                    : check.kind === 'info'
                      ? 'text-muted-foreground'
                      : ''}"
                >
                  {check.label}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p
            class="mt-2 text-xs break-words whitespace-pre-line text-muted-foreground"
            data-testid="skill-status-reason"
          >
            {skill.statusReason}
          </p>
        {/if}
      {/if}
      <div class="mt-3 flex flex-wrap items-center gap-1">
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
        {#if skill.kind === 'authored' && skill.status !== 'draft'}
          <!-- 草稿没有版本历史：转正（git 首次提交）发生在校验通过之后。 -->
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
          {#if pluginIdOfSkillSource(skill.sourceUrl ?? '') === null}
            <Button
              size="sm"
              variant="ghost"
              class="ml-auto h-6 px-2 text-xs text-destructive"
              onclick={() => (uninstallTarget = skill)}
              data-testid={`skill-uninstall-${skill.name}`}
            >
              {t('skills.uninstall')}
            </Button>
          {:else}
            <!-- 插件投影的技能由插件整体管理（core 的 PLUGIN_MANAGED 是权威）。
                用 min-w-0 占住 ml-auto 的右端，文案不挤压左侧按钮。 -->
            <span
              class="ml-auto max-w-[60%] min-w-0 text-right text-[10px] text-muted-foreground"
              data-testid={`skill-managed-${skill.name}`}
            >
              {t('plugins.managedBy', {
                name: plugins.nameOf(pluginIdOfSkillSource(skill.sourceUrl ?? '')!),
              })}
              · {t('plugins.managedHint')}
            </span>
          {/if}
        {/if}
      </div>
    </div>
  {:else}
    <!-- 列表态：名称在左、标签在右的行；草稿统一收进底部折叠区。 -->
    <div class="flex items-center justify-between gap-1">
      <p class="text-xs text-muted-foreground">{t('skills.tabHint')}</p>
    </div>
    <div class="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        onclick={() => (importOpen = true)}
        data-testid="skills-import"
      >
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
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        <ul class="space-y-1" data-testid="skills-list">
          {#each mainSkills as skill (skill.name)}
            <li>{@render skillRow(skill)}</li>
          {/each}
        </ul>
        {#if draftSkills.length > 0}
          <div class="space-y-1">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              onclick={() => (draftsOpen = !draftsOpen)}
              data-testid="skills-drafts-toggle"
            >
              <ChevronRight
                class="size-3.5 shrink-0 transition-transform {draftsOpen ? 'rotate-90' : ''}"
                aria-hidden="true"
              />
              {t('skills.status.draft')}
              <span class="tabular-nums">({draftSkills.length})</span>
            </button>
            {#if draftsOpen}
              <ul class="space-y-1" data-testid="skills-drafts-list">
                {#each draftSkills as skill (skill.name)}
                  <li>{@render skillRow(skill)}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
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
    <div
      class="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3"
      data-testid="skills-read-body"
    >
      {#if readLoading}
        <p class="text-sm text-muted-foreground">…</p>
      {:else}
        <pre
          class="font-mono text-xs break-words whitespace-pre-wrap"
          data-testid="skills-read-content">{reading?.content}</pre>
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
            <li
              class="rounded-md border p-2 text-sm"
              data-testid={`skills-history-item-${entry.oid}`}
            >
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
      <Button
        variant="outline"
        onclick={() => (historyFor = null)}
        data-testid="skills-history-close"
      >
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
