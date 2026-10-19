<script lang="ts">
  import {
    PROJECT_DETAIL_SECTIONS,
    PROJECT_GOAL_MAX_CHARS,
    PROJECT_TITLE_MAX,
    type Grant,
    type ProjectSettingsSection,
  } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import WorkdirSelector from '$lib/features/workdirs/WorkdirSelector.svelte';
  import SchedulesPanel from '$lib/features/right-panel/SchedulesPanel.svelte';
  import WatchesPanel from '$lib/features/watches/WatchesPanel.svelte';
  import ProjectMembersEditor from './ProjectMembersEditor.svelte';
  import { planGoalSave, planTitleSave } from './project-settings-model';

  /**
   * Project details page (D92 41 §11.3, WP7): a content-area page, not a
   * dialog. Five sections — overview / members / grants / schedules & watches /
   * danger — replacing the old right-panel member info and the group settings
   * dialog. `shell.projectSettingsSection` drives scrolling (deep links, the
   * nav and the members menu's "manage members" all converge on it); revoking
   * access grants stays one step away (a security control).
   */
  let { conversationId }: { conversationId: string } = $props();

  const conversation = $derived(
    chat.current?.conversation.id === conversationId ? chat.current.conversation : null,
  );
  const valid = $derived(conversation !== null && conversation.type === 'project');
  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );
  const leadMember = $derived.by(() => {
    const leadBotId = conversation?.leadBotId ?? null;
    return leadBotId === null ? null : (members.find((m) => m.bot.id === leadBotId) ?? null);
  });

  // Conversation switched away / not a project: drop the empty page and fold
  // the content area back to the chat view.
  $effect(() => {
    if (!valid) shell.projectView = 'chat';
  });

  // --- Section navigation and scrolling -----------------------------------------

  const sectionEls: Partial<Record<ProjectSettingsSection, HTMLElement>> = {};

  /** Scroll to the section whenever it changes (mount included); nav clicks go through here too. */
  $effect(() => {
    const section = shell.projectSettingsSection;
    sectionEls[section]?.scrollIntoView({ block: 'start' });
  });

  function goToSection(section: ProjectSettingsSection): void {
    shell.projectSettingsSection = section;
    sectionEls[section]?.scrollIntoView({ block: 'start' });
  }

  // --- Title (save on blur / Enter; empty restores; the in-flight guard keeps
  // Enter-then-blur from submitting twice — same trick as the old right panel) ---

  let titleDraft = $state('');
  /** Last title synced into the input (comparison only, not reactive). */
  let syncedTitle: string | null = null;
  /** Save request in flight: the blur right after Enter must not resubmit. */
  let renaming = false;

  $effect(() => {
    const title = conversation?.title ?? '';
    if (title === syncedTitle) return;
    syncedTitle = title;
    titleDraft = title;
  });

  function savedTitle(): string {
    return conversation?.title ?? '';
  }

  async function saveTitle(): Promise<void> {
    if (renaming) return;
    const plan = planTitleSave(titleDraft, savedTitle());
    if (plan.kind === 'restore') {
      titleDraft = savedTitle();
      return;
    }
    if (plan.kind === 'skip') return;
    renaming = true;
    try {
      // On failure (already toasted) fall back to the saved title so the
      // input never sticks at a name that did not take effect.
      if (!(await chat.renameProject(conversationId, plan.value))) titleDraft = savedTitle();
    } finally {
      renaming = false;
    }
  }

  function onTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      // Leave the save to blur: Enter + blur submits exactly once.
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      titleDraft = savedTitle();
      event.currentTarget.blur();
    }
  }

  // --- Goal (save on blur; emptying clears the goal) ----------------------------

  let goalDraft = $state('');
  /** Last goal synced into the textarea (like syncedTitle, not reactive). */
  let syncedGoal: string | null = null;
  let savingGoal = false;

  $effect(() => {
    const goal = conversation?.goal ?? '';
    if (goal === syncedGoal) return;
    syncedGoal = goal;
    goalDraft = goal;
  });

  function savedGoal(): string {
    return conversation?.goal ?? '';
  }

  async function saveGoal(): Promise<void> {
    if (savingGoal) return;
    const plan = planGoalSave(goalDraft, conversation?.goal ?? null);
    if (plan.kind === 'skip') return;
    savingGoal = true;
    try {
      if (!(await chat.updateProjectGoal(conversationId, plan.value))) goalDraft = savedGoal();
    } finally {
      savingGoal = false;
    }
  }

  // --- Grants (grouped per bot like the old right panel; one step away) ----------

  const grants = $derived(permissions.grants);
  const grantGroups = $derived.by(() => {
    const groups: Array<{ botId: string; list: Grant[] }> = [];
    for (const grant of grants) {
      const entry = groups.find((group) => group.botId === grant.botId);
      if (entry) entry.list.push(grant);
      else groups.push({ botId: grant.botId, list: [grant] });
    }
    return groups;
  });

  function botName(botId: string): string {
    return members.find((m) => m.bot.id === botId)?.bot.name ?? chat.botName(botId);
  }

  // --- Danger zone (two-step delete confirmation) ---------------------------------

  let confirmDelete = $state(false);
  let deleting = $state(false);
  /** Wiki inventory of the project (null = not fetched / hidden). D92 T1b WP10. */
  let wikiCounts = $state<{ sources: number; pages: number } | null>(null);

  // Expanding the confirmation loads the counts in parallel; collapsing resets
  // them so reopening refetches (sources may have changed meanwhile).
  $effect(() => {
    if (!confirmDelete) {
      wikiCounts = null;
      return;
    }
    const id = conversationId;
    void (async () => {
      try {
        const [sourcesResult, treeResult] = await Promise.all([
          core.call('wiki.sources', { owner: { kind: 'project', id } }),
          core.call('wiki.tree', { owner: { kind: 'project', id } }),
        ]);
        wikiCounts = {
          sources: (sourcesResult as { sources: unknown[] }).sources.length,
          pages: (treeResult as { pages: unknown[] }).pages.length,
        };
      } catch {
        wikiCounts = null;
      }
    })();
  });

  async function deleteProject(): Promise<void> {
    if (deleting) return;
    deleting = true;
    try {
      // The store's close() clears current; the view invariant folds the
      // shell back to the conversation list.
      await chat.deleteConversation(conversationId);
    } finally {
      deleting = false;
    }
  }
</script>

{#if !(conversation !== null && conversation.type === 'project')}
  <!-- Transitional frame while the conversation switches away: the effect
       above folds the view back to chat; render nothing here. -->
  <div class="h-full" data-testid="project-settings-page"></div>
{:else}
  <div class="flex h-full min-h-0 flex-col" data-testid="project-settings-page">
    <p class="shrink-0 border-b px-4 pt-3 pb-2 text-sm font-medium">{t('projectSettings.title')}</p>
    <div class="flex min-h-0 flex-1">
      <nav class="hidden w-44 shrink-0 space-y-0.5 overflow-y-auto border-r p-2 md:block">
        {#each PROJECT_DETAIL_SECTIONS as section (section)}
          <button
            type="button"
            class="w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent {shell.projectSettingsSection === section
              ? 'bg-accent font-medium'
              : 'text-muted-foreground'}"
            onclick={() => goToSection(section)}
            data-testid={`project-settings-nav-${section}`}
          >
            {t(`projectSettings.nav.${section}`)}
          </button>
        {/each}
      </nav>

      <div class="min-h-0 flex-1 space-y-8 overflow-y-auto p-4 text-sm">
        <!-- Overview -->
        <section
          class="space-y-6"
          data-testid="project-settings-section-overview"
          bind:this={sectionEls.overview}
        >
          <div class="space-y-1.5">
            <label class="text-sm font-medium" for="project-title-input">
              {t('projectSettings.name')}
            </label>
            <div class="flex items-end gap-2">
              <Input
                id="project-title-input"
                bind:value={titleDraft}
                maxlength={PROJECT_TITLE_MAX}
                data-testid="project-title-input"
                data-settings-anchor="project-title"
                onkeydown={onTitleKeydown}
                onblur={() => void saveTitle()}
              />
              <Button
                variant="outline"
                onclick={() => void saveTitle()}
                data-testid="project-title-save"
              >
                {t('projectSettings.save')}
              </Button>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-sm font-medium" for="project-goal-input">
              {t('projectSettings.goal')}
            </label>
            <Textarea
              id="project-goal-input"
              bind:value={goalDraft}
              maxlength={PROJECT_GOAL_MAX_CHARS}
              rows={4}
              class="min-h-0 resize-y"
              placeholder={t('projectSettings.goalPlaceholder')}
              data-testid="project-goal-input"
              data-settings-anchor="project-goal"
              onblur={() => void saveGoal()}
            />
            <div class="flex items-start justify-between gap-2">
              <span class="text-xs text-muted-foreground">{t('projectSettings.goalHint')}</span>
              <span class="shrink-0 text-xs tabular-nums text-muted-foreground">
                {t('projectSettings.goalCount', { count: goalDraft.length, max: PROJECT_GOAL_MAX_CHARS })}
              </span>
            </div>
            <div class="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onclick={() => void saveGoal()}
                data-testid="project-goal-save"
              >
                {t('projectSettings.save')}
              </Button>
            </div>
          </div>

          <div class="space-y-1.5" data-testid="project-workdir">
            <WorkdirSelector
              {conversationId}
              workdirId={conversation.workdirId}
              disabled={conversation.readOnly}
            />
          </div>

          <div class="space-y-1.5">
            <p class="text-sm font-medium">{t('projectSettings.lead')}</p>
            {#if leadMember}
              <div class="flex items-center gap-2 rounded-md border p-2">
                <BotAvatar
                  botId={leadMember.bot.id}
                  name={leadMember.bot.name}
                  avatar={leadMember.bot.avatar}
                  class="size-8"
                />
                <span class="min-w-0 flex-1 truncate">{leadMember.bot.name}</span>
                <span
                  class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                  data-testid="project-lead-badge"
                >
                  {t('projectSettings.leadBadge')}
                </span>
                <button
                  type="button"
                  class="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onclick={() => goToSection('members')}
                >
                  {t('projectSettings.changeLead')}
                </button>
              </div>
            {/if}
          </div>
        </section>

        <!-- Members -->
        <section
          data-testid="project-settings-section-members"
          bind:this={sectionEls.members}
        >
          <ProjectMembersEditor {conversationId} />
        </section>

        <!-- Grants (security control: one step from the header gear) -->
        <section class="space-y-2" data-testid="project-settings-section-grants" bind:this={sectionEls.grants}>
          <p class="text-sm font-medium">{t('projectSettings.grantsTitle')}</p>
          {#if grants.length === 0}
            <p class="text-muted-foreground" data-testid="project-grants-empty">
              {t('projectSettings.grantsEmpty')}
            </p>
          {:else}
            <ul class="space-y-2" data-testid="project-grants-list">
              {#each grantGroups as group (group.botId)}
                <li class="rounded-md border p-2">
                  <p class="text-xs font-medium">{botName(group.botId)}</p>
                  {#each group.list as grant (grant.id)}
                    <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <code class="min-w-0 flex-1 truncate">{grant.path}</code>
                      <span>
                        {t(grant.access === 'write' ? 'projectSettings.grantWrite' : 'projectSettings.grantRead')}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-5 px-1.5 text-xs text-destructive"
                        onclick={() => void permissions.revokeGrant(grant.id)}
                        data-testid={`project-grant-revoke-${grant.id}`}
                      >
                        {t('projectSettings.revoke')}
                      </Button>
                    </div>
                  {/each}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Schedules & watches -->
        <section
          class="space-y-2"
          data-testid="project-settings-section-schedules"
          bind:this={sectionEls.schedules}
        >
          <p class="text-sm font-medium">{t('projectSettings.schedulesTitle')}</p>
          <SchedulesPanel {conversationId} testid="project-schedules" />
          <p class="pt-2 text-sm font-medium">{t('watches.title')}</p>
          <WatchesPanel {conversationId} testid="project-watches" />
        </section>

        <!-- Danger zone -->
        <section
          class="space-y-2"
          data-testid="project-settings-section-danger"
          bind:this={sectionEls.danger}
        >
          <p class="text-sm font-medium text-destructive">{t('projectSettings.dangerTitle')}</p>
          {#if !confirmDelete}
            <Button
              variant="ghost"
              class="text-destructive hover:bg-destructive/10"
              onclick={() => (confirmDelete = true)}
              data-testid="project-delete-begin"
            >
              {t('projectSettings.delete')}
            </Button>
          {:else}
            <div
              class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
              data-testid="project-delete-confirm-box"
            >
              <p class="text-xs text-muted-foreground">{t('projectSettings.deleteBody')}</p>
              {#if wikiCounts !== null && (wikiCounts.sources > 0 || wikiCounts.pages > 0)}
                <p class="text-xs text-muted-foreground" data-testid="project-delete-wiki-count">
                  {t('projectSettings.deleteWikiCount', {
                    sources: wikiCounts.sources,
                    pages: wikiCounts.pages,
                  })}
                </p>
              {/if}
              <div class="flex justify-end gap-2">
                <Button variant="outline" size="sm" onclick={() => (confirmDelete = false)}>
                  {t('projectSettings.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleting}
                  onclick={() => void deleteProject()}
                  data-testid="project-delete-confirm"
                >
                  {t('projectSettings.deleteConfirm')}
                </Button>
              </div>
            </div>
          {/if}
        </section>
      </div>
    </div>
  </div>
{/if}
