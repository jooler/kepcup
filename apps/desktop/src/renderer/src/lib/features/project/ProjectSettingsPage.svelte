<script lang="ts">
  import { PROJECT_DETAIL_SECTIONS, type ProjectSettingsSection } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import ProjectSettingsDanger from './ProjectSettingsDanger.svelte';
  import ProjectSettingsGrants from './ProjectSettingsGrants.svelte';
  import ProjectSettingsMembers from './ProjectSettingsMembers.svelte';
  import ProjectSettingsOverview from './ProjectSettingsOverview.svelte';
  import ProjectSettingsSchedules from './ProjectSettingsSchedules.svelte';

  /**
   * Project details page (D92 41 §11.3, WP7): a content-area page, not a
   * dialog. Master-detail: the left nav picks one section and only that
   * section's card is rendered. `shell.projectSettingsSection` is the single
   * source of truth (deep links, the nav and the members menu's "manage
   * members" all converge on it), and revoking access grants stays one step
   * away (a security control).
   */
  let { conversationId }: { conversationId: string } = $props();

  const conversation = $derived(
    chat.current?.conversation.id === conversationId ? chat.current.conversation : null,
  );
  const valid = $derived(conversation !== null && conversation.type === 'project');
  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );

  // Conversation switched away / not a project: drop the empty page and fold
  // the content area back to the chat view.
  $effect(() => {
    if (!valid) shell.projectView = 'chat';
  });

  // --- Section navigation -------------------------------------------------------

  const section = $derived(shell.projectSettingsSection);
  let scrollEl = $state<HTMLElement>();

  /** Switching cards starts at the top of the detail pane. */
  $effect(() => {
    void section;
    scrollEl?.scrollTo({ top: 0 });
  });

  function goToSection(next: ProjectSettingsSection): void {
    shell.projectSettingsSection = next;
  }
</script>

{#if !(conversation !== null && conversation.type === 'project')}
  <!-- Transitional frame while the conversation switches away: the effect
       above folds the view back to chat; render nothing here. -->
  <div class="h-full" data-testid="project-settings-page"></div>
{:else}
  <div
    class="h-full min-h-0 overflow-y-auto"
    data-testid="project-settings-page"
    bind:this={scrollEl}
  >
    <div class="mx-auto w-full max-w-4xl px-6 pt-8 pb-12">
      <p class="text-base font-semibold">{t('projectSettings.title')}</p>

      <div class="mt-6 flex items-start gap-8">
        <nav class="sticky top-6 hidden w-40 shrink-0 space-y-0.5 md:block">
          {#each PROJECT_DETAIL_SECTIONS as navSection (navSection)}
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent {section ===
              navSection
                ? 'bg-accent font-medium'
                : 'text-muted-foreground'}"
              onclick={() => goToSection(navSection)}
              data-testid={`project-settings-nav-${navSection}`}
            >
              {t(`projectSettings.nav.${navSection}`)}
            </button>
          {/each}
        </nav>

        <div class="min-w-0 flex-1 text-sm">
          {#if section === 'overview'}
            <section data-testid="project-settings-section-overview">
              <ProjectSettingsOverview
                {conversationId}
                {conversation}
                {members}
                onManageMembers={() => goToSection('members')}
              />
            </section>
          {:else if section === 'members'}
            <section data-testid="project-settings-section-members">
              <ProjectSettingsMembers {conversationId} />
            </section>
          {:else if section === 'grants'}
            <section data-testid="project-settings-section-grants">
              <ProjectSettingsGrants {members} />
            </section>
          {:else if section === 'schedules'}
            <section data-testid="project-settings-section-schedules">
              <ProjectSettingsSchedules {conversationId} />
            </section>
          {:else if section === 'danger'}
            <section data-testid="project-settings-section-danger">
              <ProjectSettingsDanger {conversationId} />
            </section>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
