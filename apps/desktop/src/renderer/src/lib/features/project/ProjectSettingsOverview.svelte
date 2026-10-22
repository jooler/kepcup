<script lang="ts">
  import { PROJECT_GOAL_MAX_CHARS, PROJECT_TITLE_MAX, type Conversation } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat, type ProjectMemberView } from '$lib/stores/chat.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import WorkdirSelector from '$lib/features/workdirs/WorkdirSelector.svelte';
  import { AutoSaveField } from './autosave-field.svelte';
  import { planGoalSave, planTitleSave } from './project-settings-model';

  /**
   * Overview card of the project details page (D92 41 §11.3): name / goal /
   * workdir / lead. Name and goal auto-save shortly after typing (Enter/blur
   * flush, Escape restores the name); there is no separate save button. The
   * pure save decisions live in `project-settings-model.ts`, the scheduling
   * (debounce, IME composition guard, rollback, teardown) in
   * `autosave-field.svelte.ts` — both unit-tested without this component.
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

  const titleField = new AutoSaveField({
    delayMs: SAVE_DELAY_MS,
    plan: (draft, current) => planTitleSave(draft, current ?? ''),
    save: (value) => chat.renameProject(conversationId, value ?? ''),
    current: () => conversation.title,
  });

  $effect(() => titleField.sync(conversation.title));

  function onTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      titleField.cancelAndRestore();
      event.currentTarget.blur();
    }
  }

  // --- Goal (auto-save after typing; emptying clears the goal) -------------------

  const goalField = new AutoSaveField({
    delayMs: SAVE_DELAY_MS,
    plan: (draft, current) => planGoalSave(draft, current),
    save: (value) => chat.updateProjectGoal(conversationId, value),
    current: () => conversation.goal ?? null,
  });

  $effect(() => goalField.sync(conversation.goal ?? null));

  // Unmount (switching section / conversation) cleans up pending debounce
  // timers; edits not yet saved get one final flush (see AutoSaveField.dispose).
  $effect(() => {
    return () => {
      titleField.dispose();
      goalField.dispose();
    };
  });
</script>

<div class="space-y-6">
  <div class="space-y-1.5">
    <label class="text-sm font-medium" for="project-title-input">
      {t('projectSettings.name')}
    </label>
    <Input
      id="project-title-input"
      bind:value={titleField.draft}
      maxlength={PROJECT_TITLE_MAX}
      data-testid="project-title-input"
      data-settings-anchor="project-title"
      oninput={(event) => titleField.onInput(event)}
      oncompositionstart={() => titleField.onCompositionStart()}
      oncompositionend={() => titleField.onCompositionEnd()}
      onkeydown={onTitleKeydown}
      onblur={() => titleField.flush(true)}
    />
  </div>

  <div class="space-y-1.5">
    <label class="text-sm font-medium" for="project-goal-input">
      {t('projectSettings.goal')}
    </label>
    <Textarea
      id="project-goal-input"
      bind:value={goalField.draft}
      maxlength={PROJECT_GOAL_MAX_CHARS}
      rows={4}
      class="min-h-0 resize-y"
      placeholder={t('projectSettings.goalPlaceholder')}
      data-testid="project-goal-input"
      data-settings-anchor="project-goal"
      oninput={(event) => goalField.onInput(event)}
      oncompositionstart={() => goalField.onCompositionStart()}
      oncompositionend={() => goalField.onCompositionEnd()}
      onblur={() => goalField.flush()}
    />
    <div class="flex items-start justify-between gap-2">
      <span class="text-xs text-muted-foreground">{t('projectSettings.goalHint')}</span>
      <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
        {t('projectSettings.goalCount', {
          count: goalField.draft.length,
          max: PROJECT_GOAL_MAX_CHARS,
        })}
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
