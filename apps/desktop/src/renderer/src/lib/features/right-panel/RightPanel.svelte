<script lang="ts">
  import { onMount } from 'svelte';
  import { X, Monitor, Pencil } from '@lucide/svelte';
  import type { BotProfile } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { shell } from '$lib/stores/shell.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import BotProfileForm from '$lib/features/bot-panel/BotProfileForm.svelte';
  import AgentBadge from '$lib/features/bot-panel/AgentBadge.svelte';
  import ProjectSelector from '$lib/features/projects/ProjectSelector.svelte';
  import GroupInfo from './GroupInfo.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import SkillsTab from './SkillsTab.svelte';
  import WikiTab from './WikiTab.svelte';
  import SchedulesPanel from './SchedulesPanel.svelte';
  import WatchesPanel from '$lib/features/watches/WatchesPanel.svelte';
  import AvatarPicker from './AvatarPicker.svelte';
  import { showBrowser } from './show-browser';

  const conversation = $derived(chat.current?.conversation ?? null);
  const isGroup = $derived(conversation?.type === 'group');
  const bot = $derived(chat.current?.conversation.bot ?? null);
  const grants = $derived(permissions.grants);
  const confirmMode = $derived(permissions.sandbox !== null && !permissions.sandbox.available);

  let draft = $state<BotProfile | null>(null);
  let activeTab = $state('profile');
  // D80: a card / message tag asked for the schedules tab.
  $effect(() => {
    const requested = shell.rightPanelTabRequest;
    if (requested === null) return;
    if (tabItems.some((tab) => tab.value === requested)) activeTab = requested;
    shell.rightPanelTabRequest = null;
  });

  /**
   * 手写切换条：组件库 Tabs 的样式变体写在 `data-active:` 上，而 bits-ui 实际
   * 输出 `data-state="active"`，激活样式永不生效。此处自绘——Grok 风格的药丸
   * 分段条（激活项灰底圆角胶囊，非激活项透明度减半），放在头部资料卡下方。
   */
  const tabItems = [
    { value: 'profile', labelKey: 'rightPanel.tabProfile' },
    { value: 'access', labelKey: 'rightPanel.tabAccess' },
    { value: 'memory', labelKey: 'rightPanel.tabMemory' },
    { value: 'skills', labelKey: 'rightPanel.tabSkills' },
    { value: 'wiki', labelKey: 'rightPanel.tabWiki' },
    { value: 'schedules', labelKey: 'rightPanel.tabSchedules' },
    { value: 'other', labelKey: 'rightPanel.otherSection' },
  ] as const;

  function onTablistKeydown(
    event: KeyboardEvent & { currentTarget: EventTarget & HTMLDivElement },
  ): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = tabItems.findIndex((tab) => tab.value === activeTab);
    if (index === -1) return;
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabItems[(index + delta + tabItems.length) % tabItems.length];
    if (!next) return;
    activeTab = next.value;
    event.currentTarget.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }

  /** 「其它」分组：移除 Bot（删除全部数据，历史保留为只读）。 */
  let removeOpen = $state(false);
  let removePreview = $state({ conversations: 0, messages: 0 });
  let removing = $state(false);

  /**
   * 最近一次保存到 core 的完整 profile。头像 / 名称 / 简介的点按直编以它为
   * 基准合并，配置表单的自动保存也用它做回声抑制：RPC 回写 store 后 draft
   * 与它一致则不再触发下一轮保存。
   */
  let savedProfile = $state<BotProfile | null>(null);

  $effect(() => {
    if (bot && bot.status === 'active') {
      draft = structuredClone($state.snapshot(bot.profile)) as BotProfile;
      savedProfile = bot.profile;
    } else {
      draft = null;
      savedProfile = null;
    }
  });

  async function saveProfile(id: string, profile: BotProfile): Promise<void> {
    try {
      const updated = await contacts.update(id, $state.snapshot(profile) as BotProfile);
      savedProfile = updated.profile;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 配置表单自动保存：深度监听 draft（stringify 建立全量依赖），变更后防抖
   * 落盘，无需手动保存按钮。与最近保存结果一致时跳过，避免保存回写 store
   * 引发的回声循环。
   */
  $effect(() => {
    const currentBot = bot;
    const currentDraft = draft;
    if (!currentBot || !currentDraft) return;
    const snapshot = JSON.stringify($state.snapshot(currentDraft));
    if (savedProfile && JSON.stringify($state.snapshot(savedProfile)) === snapshot) return;
    const timer = setTimeout(() => void saveProfile(currentBot.id, currentDraft), 500);
    return () => {
      clearTimeout(timer);
      // 防抖期间切换到其它 Bot（draft 被整体重克隆）会清掉定时器，窗口内的
      // 未落盘改动在这里立即补救。同一 Bot 的重跑（按键 / save_profile 外部
      // 更新触发重克隆）不在此列：前者交给新定时器，后者以服务端数据为准；
      // bot 为空是移除 / 关闭会话，不补写。
      if (bot && currentBot.id !== bot.id) void saveProfile(currentBot.id, currentDraft);
    };
  });

  /**
   * W8：确认切换浏览器资料后立即保存（不走防抖自动保存）；draft 随之更新，
   * 保存回写 savedProfile 后自动保存判定为一致，不会再存一次。
   */
  async function confirmBrowserProfile(next: string): Promise<void> {
    if (!bot || !draft) return;
    draft.runtime.browser_profile = next;
    await saveProfile(bot.id, draft);
  }

  /** draft 相对最近一次保存仍有未落盘改动时立即保存。 */
  function flushDirtyDraft(): void {
    if (!bot || !draft || !savedProfile) return;
    if (JSON.stringify($state.snapshot(draft)) === JSON.stringify($state.snapshot(savedProfile))) {
      return;
    }
    void saveProfile(bot.id, draft);
  }

  // 右栏收起是整个卸载（ChatsArea 的 {#if}）：卸载清理里把防抖窗口内的
  // 未落盘改动立即保存，live draft/bot 就是待保存值。
  onMount(() => () => flushDirtyDraft());

  /** 头像 / 名称 / 简介的点按直编：在最近保存的 profile 上做字段级合并。 */
  async function patchIdentity(patch: Partial<BotProfile['identity']>): Promise<void> {
    if (!bot) return;
    const base = savedProfile ?? bot.profile;
    try {
      // profile 来自响应式 store，RPC 走 structured clone，先 snapshot 成纯数据。
      const updated = await contacts.update(
        bot.id,
        $state.snapshot({
          ...base,
          identity: { ...base.identity, ...patch },
        }) as BotProfile,
      );
      savedProfile = updated.profile;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  // --- 名称 / 简介点按直编 -------------------------------------------------
  let pickerOpen = $state(false);
  let editingName = $state(false);
  let nameDraft = $state('');
  let editingBio = $state(false);
  let bioDraft = $state('');

  function startNameEdit(): void {
    if (!bot) return;
    nameDraft = bot.profile.identity.name;
    editingName = true;
  }

  async function commitName(): Promise<void> {
    if (!editingName) return;
    editingName = false;
    const name = nameDraft.trim();
    if (!bot || name.length === 0 || name === bot.profile.identity.name) return;
    await patchIdentity({ name });
  }

  function startBioEdit(): void {
    if (!bot) return;
    bioDraft = bot.profile.identity.bio;
    editingBio = true;
  }

  async function commitBio(): Promise<void> {
    if (!editingBio) return;
    editingBio = false;
    if (!bot || bioDraft === bot.profile.identity.bio) return;
    await patchIdentity({ bio: bioDraft.trim() });
  }

  async function askRemove(): Promise<void> {
    if (!bot) return;
    removePreview = await contacts.deletionPreview(bot.id);
    removeOpen = true;
  }

  async function confirmRemove(): Promise<void> {
    if (!bot) return;
    // remove 生效后派生值 bot 即为 null，名字要在 await 前捕获。
    const { id, name } = bot;
    removing = true;
    try {
      await contacts.remove(id);
      removeOpen = false;
      toast.success(t('contacts.deleteTitle', { name }));
      chat.close();
    } finally {
      removing = false;
    }
  }
</script>

<aside class="flex h-full min-h-0 flex-col border-l bg-background" data-testid="right-panel">
  <header class="app-drag flex h-12 shrink-0 items-center justify-end px-4">
    <div class="app-no-drag flex items-center gap-1">
      <!-- P11 任务 5: 查看该 Bot 在当前对话中的浏览器页面（直聊才有单一 Bot）。 -->
      {#if !isGroup && bot?.status === 'active' && conversation}
        <Button
          variant="ghost"
          size="sm"
          class="h-7 gap-1 px-2 text-xs"
          title={t('rightPanel.browserShowHint')}
          onclick={() => void showBrowser(bot.id, conversation.id, bot.name)}
          data-testid="browser-show"
        >
          <Monitor class="size-3.5" aria-hidden="true" />
          {t('rightPanel.browserShow')}
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="icon"
        class="size-7"
        onclick={() => shell.toggleRightPanel()}
        data-testid="right-panel-hide"
        aria-label={t('shell.rightPanelHide')}
      >
        <X class="size-4" aria-hidden="true" />
      </Button>
    </div>
  </header>

  {#if isGroup}
    <GroupInfo conversationId={conversation!.id} />
  {:else if !bot}
    <div class="flex flex-1 items-center justify-center p-6">
      <p class="text-sm text-muted-foreground">{t('rightPanel.placeholder')}</p>
    </div>
  {:else if bot.status !== 'active'}
    <div class="flex flex-1 items-center justify-center p-6">
      <p class="text-sm text-muted-foreground" data-testid="deleted-bot-note">
        {t('rightPanel.deletedBot')}
      </p>
    </div>
  {:else if draft}
    <div class="flex min-h-0 flex-1 flex-col">
      <!-- 头部资料卡（参考 Grok Bot）：头像 / 名称 / 简介，点按直接编辑 -->
      <div class="relative shrink-0 px-4 pb-3">
        <div class="flex flex-col items-center gap-1 text-center">
          <button
            type="button"
            class="group relative size-24 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={() => (pickerOpen = !pickerOpen)}
            title={t('rightPanel.avatarEditTitle')}
            data-testid="bot-avatar-button"
          >
            <BotAvatar
              botId={bot.id}
              name={bot.name}
              avatar={bot.avatar}
              class="size-24"
              fallbackClass="text-2xl"
              testId="bot-avatar"
            />
            <span
              class="absolute inset-0 flex items-center justify-center rounded-full bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <Pencil class="size-6" aria-hidden="true" />
            </span>
          </button>
          {#if editingName}
            <input
              class="w-full rounded-md border border-input bg-background px-2 py-1 text-center text-xl font-semibold outline-none focus:ring-1 focus:ring-ring"
              bind:value={nameDraft}
              maxlength={50}
              onkeydown={(e) => {
                if (e.key === 'Enter') void commitName();
                if (e.key === 'Escape') editingName = false;
              }}
              onblur={() => void commitName()}
              data-testid="bot-name-inline-input"
            />
          {:else}
            <button
              type="button"
              class="max-w-full truncate rounded-md px-2 py-0.5 text-xl font-semibold transition-colors hover:bg-accent"
              onclick={startNameEdit}
              title={t('rightPanel.clickToEdit')}
              data-testid="bot-name-edit"
            >
              {bot.name}
            </button>
          {/if}
          {#if editingBio}
            <input
              class="w-full rounded-md border border-input bg-background px-2 py-1 text-center text-sm outline-none focus:ring-1 focus:ring-ring"
              bind:value={bioDraft}
              maxlength={500}
              onkeydown={(e) => {
                if (e.key === 'Enter') void commitBio();
                if (e.key === 'Escape') editingBio = false;
              }}
              onblur={() => void commitBio()}
              data-testid="bot-bio-inline-input"
            />
          {:else}
            <button
              type="button"
              class="max-w-full truncate rounded-md px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent {bot.bio
                ? ''
                : 'italic'}"
              onclick={startBioEdit}
              title={t('rightPanel.clickToEdit')}
              data-testid="bot-bio-edit"
            >
              {bot.bio || t('rightPanel.bioPlaceholder')}
            </button>
          {/if}
          {#if bot.profile.runtime.agent.id.length > 0 && bot.setupState !== 'interviewing'}
            <!-- D72：外部智能体驱动的 Bot——徽标 + 隔离说明，点击跳设置页对应 Agent -->
            <AgentBadge agentId={bot.profile.runtime.agent.id} />
          {/if}
        </div>
        <AvatarPicker bind:open={pickerOpen} {bot} />
      </div>

      <div
        class="flex shrink-0 items-center gap-0.5 overflow-x-auto px-3 pb-1 whitespace-nowrap"
        role="tablist"
        tabindex={-1}
        data-testid="right-panel-tabs"
        onkeydown={onTablistKeydown}
      >
        {#each tabItems as tab (tab.value)}
          <button
            type="button"
            role="tab"
            id={`tab-${tab.value}`}
            aria-selected={activeTab === tab.value}
            aria-controls={`tab-panel-${tab.value}`}
            tabindex={activeTab === tab.value ? 0 : -1}
            class="rounded-full px-2.5 py-1 text-[13px] transition-colors {activeTab === tab.value
              ? 'bg-muted font-medium text-foreground'
              : 'text-foreground/50 hover:bg-accent/60 hover:text-foreground/80'}"
            onclick={() => (activeTab = tab.value)}
          >
            {t(tab.labelKey)}
          </button>
        {/each}
      </div>
      <div
        id="tab-panel-profile"
        role="tabpanel"
        aria-labelledby="tab-profile"
        class="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={activeTab !== 'profile'}
        data-testid="profile-tab"
      >
        <div class="space-y-4">
          <!-- 项目目录（P04）：绑定在对话上，配置 tab 内手动选择/切换；
               执行中切换由选择器内部禁用。 -->
          {#if conversation}
            <ProjectSelector
              conversationId={conversation.id}
              projectId={conversation.projectId}
              disabled={conversation.readOnly}
            />
          {/if}
          <!-- 名字/简介走上方头部资料卡的点按直编；表单值变化即自动保存，无需按钮。 -->
          <BotProfileForm
            bind:profile={draft}
            showIdentity={false}
            onBrowserProfileConfirm={confirmBrowserProfile}
          />
        </div>
      </div>
      <div
        id="tab-panel-access"
        role="tabpanel"
        aria-labelledby="tab-access"
        class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm"
        hidden={activeTab !== 'access'}
        data-testid="access-tab"
      >
        {#if confirmMode}
          <p
            class="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
            data-testid="confirm-mode-hint"
          >
            {t('chats.confirmModeBanner', { reason: permissions.sandbox?.reason ?? '' })}
          </p>
        {/if}
        {#if grants.length === 0}
          <p class="text-muted-foreground" data-testid="grants-empty">
            {t('rightPanel.grantsEmpty')}
          </p>
        {:else}
          <ul class="space-y-2" data-testid="grants-list">
            {#each grants as grant (grant.id)}
              <li class="rounded-md border p-2" data-testid={`grant-item-${grant.id}`}>
                <code class="block text-xs break-all">{grant.path}</code>
                <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    >{t(
                      grant.access === 'write' ? 'rightPanel.grantWrite' : 'rightPanel.grantRead',
                    )}</span
                  >
                  <span>·</span>
                  <span
                    >{t(
                      grant.duration === 'once'
                        ? 'rightPanel.grantOnce'
                        : 'rightPanel.grantConversation',
                    )}</span
                  >
                  <Button
                    variant="ghost"
                    size="sm"
                    class="ml-auto h-6 px-2 text-xs text-destructive"
                    onclick={() => void permissions.revokeGrant(grant.id)}
                    data-testid={`grant-revoke-${grant.id}`}
                  >
                    {t('rightPanel.revoke')}
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
        <p class="text-xs text-muted-foreground">{t('rightPanel.grantsHint')}</p>
      </div>
      <div
        id="tab-panel-memory"
        role="tabpanel"
        aria-labelledby="tab-memory"
        class="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={activeTab !== 'memory'}
      >
        {#if bot}
          <MemoryTab botId={bot.id} active={activeTab === 'memory'} />
        {/if}
      </div>
      <div
        id="tab-panel-skills"
        role="tabpanel"
        aria-labelledby="tab-skills"
        class="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={activeTab !== 'skills'}
      >
        {#if bot}
          <SkillsTab botId={bot.id} active={activeTab === 'skills'} />
        {/if}
      </div>
      <div
        id="tab-panel-wiki"
        role="tabpanel"
        aria-labelledby="tab-wiki"
        class="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={activeTab !== 'wiki'}
      >
        {#if bot}
          <WikiTab botId={bot.id} active={activeTab === 'wiki'} />
        {/if}
      </div>
      <div
        id="tab-panel-schedules"
        role="tabpanel"
        aria-labelledby="tab-schedules"
        class="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={activeTab !== 'schedules'}
      >
        {#if bot && conversation}
          <!-- P10: the current conversation's schedules (direct chat = this bot). -->
          <SchedulesPanel
            conversationId={conversation.id}
            active={activeTab === 'schedules'}
            testid="schedules-tab"
          />
          <!-- W7: the conversation's web-page watches, next to its schedules. -->
          <section class="mt-4 space-y-2">
            <p class="text-xs font-medium">{t('watches.title')}</p>
            <WatchesPanel
              conversationId={conversation.id}
              active={activeTab === 'schedules'}
              testid="watches-tab"
            />
          </section>
        {/if}
      </div>
      <div
        id="tab-panel-other"
        role="tabpanel"
        aria-labelledby="tab-other"
        class="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={activeTab !== 'other'}
        data-testid="bot-other-section"
      >
        <!-- 其它分组：移除 Bot（左栏条目不再有「…」删除入口，收拢到这里）。
             管家（D70）不可删除：只给说明，不给按钮。 -->
        {#if bot?.systemRole === 'butler'}
          <p class="text-xs text-muted-foreground" data-testid="bot-remove-butler-note">
            {t('rightPanel.butlerUndeletable')}
          </p>
        {:else}
          <Button
            variant="outline"
            size="sm"
            class="h-7 w-full gap-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onclick={() => void askRemove()}
            data-testid="bot-remove"
          >
            {t('rightPanel.removeBot')}
          </Button>
        {/if}
      </div>
    </div>
  {/if}
</aside>

<Dialog bind:open={removeOpen}>
  <DialogContent class="max-w-md" data-testid="bot-remove-dialog">
    <DialogHeader>
      <DialogTitle>{t('contacts.deleteTitle', { name: bot?.name ?? '' })}</DialogTitle>
    </DialogHeader>
    <p class="text-sm text-muted-foreground" data-testid="bot-remove-body">
      {t('contacts.deleteBody', {
        conversations: removePreview.conversations,
        messages: removePreview.messages,
      })}
    </p>
    {#if (bot?.profile.runtime.agent.id ?? '').length > 0}
      <p class="text-xs text-muted-foreground" data-testid="bot-remove-body-agent-note">
        {t('contacts.deleteAgentNote')}
      </p>
    {/if}
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => (removeOpen = false)}
        data-testid="bot-remove-cancel"
      >
        {t('contacts.cancel')}
      </Button>
      <Button
        variant="destructive"
        onclick={confirmRemove}
        disabled={removing}
        data-testid="bot-remove-confirm"
      >
        {t('contacts.deleteConfirm')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
