<script lang="ts">
  import {
    PROJECT_DETAIL_SECTIONS,
    PROJECT_GOAL_MAX_CHARS,
    PROJECT_TITLE_MAX,
    type Grant,
    type ProjectSettingsSection,
  } from '@kepcup/shared';
  import { t } from '$lib/i18n';
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
   * 项目详情页（D92 41 §11.3，WP7）：内容区页面（不是对话框）。五个分区——概览 /
   * 成员 / 授权 / 定时与监看 / 危险区——取代旧右栏 GroupInfo 与群设置弹框。
   * `shell.projectSettingsSection` 驱动滚动（深链 / 导航 / 成员弹层的「管理成员…」
   * 都汇到它）；访问授权的撤销保持一步可达（安全控制）。
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

  // 会话已切走 / 不是项目组：不留空详情页，内容区收回到沟通。
  $effect(() => {
    if (!valid) shell.projectView = 'chat';
  });

  // --- 分区导航与滚动 -------------------------------------------------------------

  const sectionEls: Partial<Record<ProjectSettingsSection, HTMLElement>> = {};

  /** 分区变化（含首次挂载）滚到对应分区；点导航也走这里。 */
  $effect(() => {
    const section = shell.projectSettingsSection;
    sectionEls[section]?.scrollIntoView({ block: 'start' });
  });

  function goToSection(section: ProjectSettingsSection): void {
    shell.projectSettingsSection = section;
    sectionEls[section]?.scrollIntoView({ block: 'start' });
  }

  // --- 项目名称（失焦 / 回车保存；空串还原；沿用 GroupInfo 的 renaming 防抖） -------

  let titleDraft = $state('');
  /** 上次同步进输入框的标题（只给同步 effect 比对用，不需要响应式）。 */
  let syncedTitle: string | null = null;
  /** 保存请求在途：回车后紧跟的 blur 不再重复提交。 */
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
      // 失败（已 toast）时退回已保存的标题，不让输入框停在没生效的名字上。
      if (!(await chat.renameProject(conversationId, plan.value))) titleDraft = savedTitle();
    } finally {
      renaming = false;
    }
  }

  function onTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      // 交给 blur 统一保存，回车 + 失焦只提交一次。
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      titleDraft = savedTitle();
      event.currentTarget.blur();
    }
  }

  // --- 项目目标（失焦保存；清空 = 清除目标） ----------------------------------------

  let goalDraft = $state('');
  /** 上次同步进输入框的目标（同 syncedTitle，非响应式）。 */
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

  // --- 授权（照搬 GroupInfo 的按 Bot 分组，一步可达的安全控制） ----------------------

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

  // --- 危险区（两步确认删除） --------------------------------------------------------

  let confirmDelete = $state(false);
  let deleting = $state(false);

  async function deleteProject(): Promise<void> {
    if (deleting) return;
    deleting = true;
    try {
      // store 侧 close() 清掉 current，页面随视图收口回到会话列表。
      await chat.deleteConversation(conversationId);
    } finally {
      deleting = false;
    }
  }
</script>

{#if !(conversation !== null && conversation.type === 'project')}
  <!-- 会话切走 / 非项目组的过渡帧：effect 会把视图收回沟通，这里不画内容。 -->
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
        <!-- 概览 -->
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
            <p class="text-sm font-medium">{t('projectSettings.workdir')}</p>
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

        <!-- 成员 -->
        <section
          data-testid="project-settings-section-members"
          bind:this={sectionEls.members}
        >
          <ProjectMembersEditor {conversationId} />
        </section>

        <!-- 授权（安全控制：顶栏 ⚙ 一步可达，撤销不藏深） -->
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

        <!-- 定时与监看 -->
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

        <!-- 危险区 -->
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
