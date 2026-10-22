<script lang="ts">
  import { PROJECT_GOAL_MAX_CHARS, PROJECT_TITLE_MAX, type Conversation } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat, type ProjectMemberView } from '$lib/stores/chat.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import WorkdirSelector from '$lib/features/workdirs/WorkdirSelector.svelte';
  import { planGoalSave, planTitleSave } from './project-settings-model';

  /**
   * Overview card of the project details page (D92 41 §11.3): name / goal /
   * workdir / lead. Name and goal auto-save shortly after typing (Enter/blur
   * flush, Escape restores the name); there is no separate save button. The
   * pure save decisions live in `project-settings-model.ts`.
   */
  let {
    conversationId,
    conversation,
    members,
    onManageMembers,
  }: {
    conversationId: string;
    conversation: Conversation;
    members: ProjectMemberView[];
    onManageMembers: () => void;
  } = $props();

  const leadMember = $derived(
    conversation.leadBotId == null
      ? null
      : (members.find((m) => m.bot.id === conversation.leadBotId) ?? null),
  );

  /** Typing pause before an auto-save request is sent. */
  const SAVE_DELAY_MS = 400;

  // --- Title (auto-save after typing; Enter/blur flush, Escape restores; an
  // emptied title is restored instead of submitted) ---

  let titleDraft = $state('');
  /** Last title synced into the input (comparison only, not reactive). */
  let syncedTitle: string | null = null;
  /** Save request in flight: later flushes wait for it to finish. */
  let renaming = false;
  let titleTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const title = conversation.title ?? '';
    if (title === syncedTitle) return;
    // Do not overwrite an edit that has not been saved yet.
    const clean = titleDraft === (syncedTitle ?? '');
    syncedTitle = title;
    if (clean) titleDraft = title;
  });

  function savedTitle(): string {
    return conversation.title ?? '';
  }

  function scheduleTitleSave(): void {
    if (titleTimer !== null) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      titleTimer = null;
      void saveTitle();
    }, SAVE_DELAY_MS);
  }

  function flushTitleSave(restoreEmpty: boolean): void {
    if (titleTimer !== null) {
      clearTimeout(titleTimer);
      titleTimer = null;
    }
    void saveTitle(restoreEmpty);
  }

  async function saveTitle(restoreEmpty = false): Promise<void> {
    if (renaming) return;
    const plan = planTitleSave(titleDraft, savedTitle());
    if (plan.kind === 'restore') {
      // While typing an empty field is just an intermediate state; only a
      // flush (blur) brings the saved name back.
      if (restoreEmpty) titleDraft = savedTitle();
      return;
    }
    if (plan.kind === 'skip') return;
    renaming = true;
    try {
      // On failure (already toasted) fall back to the saved title so the
      // input never sticks at a name that did not take effect.
      if (!(await chat.renameProject(conversationId, plan.value))) {
        titleDraft = savedTitle();
        return;
      }
    } finally {
      renaming = false;
    }
    // Edits made while the request was in flight need another round.
    if (planTitleSave(titleDraft, savedTitle()).kind === 'save') scheduleTitleSave();
  }

  function onTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (titleTimer !== null) {
        clearTimeout(titleTimer);
        titleTimer = null;
      }
      titleDraft = savedTitle();
      event.currentTarget.blur();
    }
  }

  // --- Goal (auto-save after typing; emptying clears the goal) -------------------

  let goalDraft = $state('');
  /** Last goal synced into the textarea (like syncedTitle, not reactive). */
  let syncedGoal: string | null = null;
  let savingGoal = false;
  let goalTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const goal = conversation.goal ?? '';
    if (goal === syncedGoal) return;
    const clean = goalDraft === (syncedGoal ?? '');
    syncedGoal = goal;
    if (clean) goalDraft = goal;
  });

  function savedGoal(): string {
    return conversation.goal ?? '';
  }

  function scheduleGoalSave(): void {
    if (goalTimer !== null) clearTimeout(goalTimer);
    goalTimer = setTimeout(() => {
      goalTimer = null;
      void saveGoal();
    }, SAVE_DELAY_MS);
  }

  function flushGoalSave(): void {
    if (goalTimer !== null) {
      clearTimeout(goalTimer);
      goalTimer = null;
    }
    void saveGoal();
  }

  async function saveGoal(): Promise<void> {
    if (savingGoal) return;
    const plan = planGoalSave(goalDraft, conversation.goal ?? null);
    if (plan.kind === 'skip') return;
    savingGoal = true;
    try {
      if (!(await chat.updateProjectGoal(conversationId, plan.value))) {
        goalDraft = savedGoal();
        return;
      }
    } finally {
      savingGoal = false;
    }
    // Edits made while the request was in flight need another round.
    if (planGoalSave(goalDraft, conversation.goal ?? null).kind === 'save') scheduleGoalSave();
  }
</script>

<div class="space-y-6">
  <div class="space-y-1.5">
    <label class="text-sm font-medium" for="project-title-input">
      {t('projectSettings.name')}
    </label>
    <Input
      id="project-title-input"
      bind:value={titleDraft}
      maxlength={PROJECT_TITLE_MAX}
      data-testid="project-title-input"
      data-settings-anchor="project-title"
      oninput={scheduleTitleSave}
      onkeydown={onTitleKeydown}
      onblur={() => flushTitleSave(true)}
    />
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
      oninput={scheduleGoalSave}
      onblur={flushGoalSave}
    />
    <div class="flex items-start justify-between gap-2">
      <span class="text-xs text-muted-foreground">{t('projectSettings.goalHint')}</span>
      <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
        {t('projectSettings.goalCount', { count: goalDraft.length, max: PROJECT_GOAL_MAX_CHARS })}
      </span>
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
          onclick={onManageMembers}
        >
          {t('projectSettings.changeLead')}
        </button>
      </div>
    {/if}
  </div>
</div>
