<script lang="ts">
  import { tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import type { Component } from 'svelte';
  import { ChevronLeft, Search } from '@lucide/svelte';
  import { motionMs, MOTION } from '$lib/motion';
  import type { Bot } from '@kepcup/shared';
  import {
    Activity,
    BarChart3,
    BookUser,
    Box,
    CalendarClock,
    Cpu,
    Database,
    Monitor,
    Moon,
    MoonStar,
    Palette,
    Settings2,
    ShieldCheck,
    Sun,
    SunMoon,
    UserRound,
    Users,
    type LucideIcon,
  } from '@lucide/svelte';
  import { userPrefersMode } from 'mode-watcher';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { shell, type SettingsSectionId } from '$lib/stores/shell.svelte';
  import { chat, type ConversationView } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';
  import { Button } from '$lib/components/ui/button';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import * as Avatar from '$lib/components/ui/avatar';
  import * as Dialog from '$lib/components/ui/dialog';

  /**
   * 全局搜索弹框（侧栏搜索按钮 / Cmd+K）：检索 Bot、会话与设置条目。
   * 空查询时展示快捷入口——Bots 列表与高频设置；有查询时按
   * Bot → 对话 → 设置排序平铺（同参考截图），前 9 条带 ⌘N 直达。
   * 外观三条（自动风格/亮色/暗色）不跳设置，选中即生效。
   *
   * 窄屏（33-narrow-layout）不用弹框：全屏浮层带背景色把底层盖住（像打开
   * 新页面），顶部给 macOS 红绿灯留位；返回按钮 / Esc 关闭。结果行两种形态共用。
   *
   * 本组件挂在 App 根（不在 AppSidebar 里）：Cmd/Ctrl+K 与窄屏的任意 tab / 详情层都要
   * 能用，宽窄切换（整树重挂载）也不丢打开状态。窄屏的全屏层是自绘 fixed 层，没有 bits-ui
   * 的 Esc 与焦点约束，所以：Esc 经 escape-layers 仲裁；App 把底层容器置 inert（Tab 不会跑到
   * 被盖住的侧栏按钮）；关闭时焦点还给打开前的元素。
   */

  let {
    open = $bindable(false),
  }: {
    open?: boolean;
  } = $props();

  const isMac = /Mac/i.test(navigator.platform);
  const narrow = $derived(narrowLayout.narrow);

  let query = $state('');
  let activeIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);

  // --- 设置条目 ---------------------------------------------------------------

  interface SettingsTarget {
    id: string;
    icon: LucideIcon;
    label: string;
    /** 行副标题：顶级分组为「设置」，分区/子项为「设置 · 父分组」。 */
    subtitle: string;
    /** 中文之外的匹配词（英文别名，小写）。 */
    keywords: string;
    section: SettingsSectionId;
    /** 分组内锚点（[data-settings-anchor]），打开后滚动定位。 */
    anchor?: string;
    /** 直接生效的动作（外观切换）；存在时不跳设置弹框。 */
    apply?: () => void;
  }

  function applyTheme(mode: 'system' | 'light' | 'dark', label: string): void {
    userPrefersMode.current = mode;
    toast.success(t('search.themeApplied', { mode: label }));
  }

  const settingsTargets = $derived.by<SettingsTarget[]>(() => {
    const parent = t('search.settingsEntry');
    const appearance = `${parent} · ${t('settings.appearanceSection')}`;
    return [
      {
        id: 'settings',
        icon: Settings2,
        label: t('menu.settings'),
        subtitle: parent,
        keywords: 'settings',
        section: 'general',
      },
      {
        id: 'nav-general',
        icon: Settings2,
        label: t('settings.navGeneral'),
        subtitle: parent,
        keywords: 'general',
        section: 'general',
      },
      {
        id: 'appearance',
        icon: Palette,
        label: t('settings.appearanceSection'),
        subtitle: `${parent} · ${t('settings.navGeneral')}`,
        keywords: 'appearance theme',
        section: 'general',
        anchor: 'appearance',
      },
      {
        id: 'nav-models',
        icon: Cpu,
        label: t('settings.navModels'),
        subtitle: parent,
        keywords: 'models model',
        section: 'models',
      },
      {
        id: 'default-models',
        icon: Cpu,
        label: t('settings.modelsSection'),
        subtitle: `${parent} · ${t('settings.navModels')}`,
        keywords: 'default model',
        section: 'models',
        anchor: 'default-models',
      },
      {
        id: 'embedding',
        icon: Database,
        label: t('settings.embeddingSection'),
        subtitle: `${parent} · ${t('settings.navModels')}`,
        keywords: 'embedding vector',
        section: 'models',
        anchor: 'embedding',
      },
      {
        id: 'nav-contacts',
        icon: BookUser,
        label: t('settings.navContacts'),
        subtitle: parent,
        keywords: 'contacts bots',
        section: 'contacts',
      },
      {
        id: 'nav-sandbox',
        icon: Box,
        label: t('settings.sandboxSection'),
        subtitle: `${parent} · ${t('settings.navEnvironment')}`,
        keywords: 'sandbox',
        section: 'environment',
        anchor: 'sandbox',
      },
      {
        id: 'nav-schedules',
        icon: CalendarClock,
        label: t('settings.schedulesSection'),
        subtitle: `${parent} · ${t('settings.navUnattended')}`,
        keywords: 'schedule cron',
        section: 'unattended',
        anchor: 'schedules',
      },
      {
        id: 'theme-auto',
        icon: SunMoon,
        label: t('search.themeAuto'),
        subtitle: appearance,
        keywords: 'system auto theme',
        section: 'general',
        apply: () => applyTheme('system', t('search.themeAuto')),
      },
      {
        id: 'theme-light',
        icon: Sun,
        label: t('search.themeLight'),
        subtitle: appearance,
        keywords: 'light theme',
        section: 'general',
        apply: () => applyTheme('light', t('search.themeLight')),
      },
      {
        id: 'theme-dark',
        icon: Moon,
        label: t('search.themeDark'),
        subtitle: appearance,
        keywords: 'dark theme',
        section: 'general',
        apply: () => applyTheme('dark', t('search.themeDark')),
      },
      {
        id: 'nav-unattended',
        icon: MoonStar,
        label: t('settings.navUnattended'),
        subtitle: parent,
        keywords: 'unattended',
        section: 'unattended',
      },
      {
        id: 'nav-allowlist',
        icon: ShieldCheck,
        label: t('allowlist.settingsSection'),
        subtitle: `${parent} · ${t('settings.navEnvironment')}`,
        keywords: 'allowlist',
        section: 'environment',
        anchor: 'allowlist',
      },
      {
        id: 'nav-environment',
        icon: Monitor,
        label: t('settings.navEnvironment'),
        subtitle: parent,
        keywords: 'environment',
        section: 'environment',
      },
      {
        id: 'profile',
        icon: UserRound,
        label: t('settings.profileSection'),
        subtitle: parent,
        keywords: 'profile',
        section: 'profile',
      },
      {
        id: 'nav-usage',
        icon: BarChart3,
        label: t('settings.navUsage'),
        subtitle: parent,
        keywords: 'usage',
        section: 'usage',
      },
      {
        id: 'nav-diagnostics',
        icon: Activity,
        label: t('settings.navDiagnostics'),
        subtitle: parent,
        keywords: 'diagnostics logs',
        section: 'diagnostics',
      },
    ];
  });

  /** 高频设置（产品钦定的 9 条，顺序固定）。 */
  const quickSettingsIds = [
    'settings',
    'default-models',
    'nav-schedules',
    'theme-auto',
    'theme-light',
    'theme-dark',
    'nav-unattended',
    'profile',
    'nav-diagnostics',
  ] as const;

  const quickSettings = $derived(
    quickSettingsIds
      .map((id) => settingsTargets.find((target) => target.id === id))
      .filter((target) => target !== undefined),
  );

  // --- 结果行 -----------------------------------------------------------------

  type Row =
    | { kind: 'bot'; key: string; bot: Bot }
    | { kind: 'conversation'; key: string; conversation: ConversationView }
    | { kind: 'settings'; key: string; target: SettingsTarget };

  const BOT_CAP = 6;
  const CONVERSATION_CAP = 6;
  const SETTINGS_CAP = 10;
  const QUICK_BOT_CAP = 8;

  function conversationTitle(conversation: ConversationView): string {
    return conversation.type === 'project'
      ? (conversation.title ?? conversation.id)
      : (conversation.bot?.name ?? conversation.directBotId ?? conversation.id);
  }

  function conversationPreview(conversation: ConversationView): string {
    return chat.lastMessageText[conversation.id] ?? conversation.summary ?? '';
  }

  const quickBotRows = $derived(
    contacts.bots
      .slice(0, QUICK_BOT_CAP)
      .map((bot): Row => ({ kind: 'bot', key: `bot-${bot.id}`, bot })),
  );

  const quickSettingRows = $derived(
    quickSettings.map((target): Row => ({
      kind: 'settings',
      key: `settings-${target.id}`,
      target,
    })),
  );

  /** 有查询：Bot → 对话（与已匹配 Bot 的直聊去重）→ 设置，平铺。 */
  const searchRows = $derived.by<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const matches = (texts: string[]): boolean =>
      texts.some((text) => text.toLowerCase().includes(q));

    const bots = contacts.bots
      .filter((bot) => matches([bot.name, bot.bio, bot.id]))
      .slice(0, BOT_CAP);
    const botIds = new Set(bots.map((bot) => bot.id));

    const conversations = chat.conversations
      .filter(
        (conversation) =>
          (conversation.type === 'project' || !botIds.has(conversation.directBotId ?? '')) &&
          matches([
            conversationTitle(conversation),
            conversation.summary ?? '',
            conversationPreview(conversation),
          ]),
      )
      .slice(0, CONVERSATION_CAP);

    const settings = settingsTargets
      .filter((target) => matches([target.label, target.keywords]))
      .slice(0, SETTINGS_CAP);

    return [
      ...bots.map((bot): Row => ({ kind: 'bot', key: `bot-${bot.id}`, bot })),
      ...conversations.map((conversation): Row => ({
        kind: 'conversation',
        key: `conversation-${conversation.id}`,
        conversation,
      })),
      ...settings.map((target): Row => ({
        kind: 'settings',
        key: `settings-${target.id}`,
        target,
      })),
    ];
  });

  /** 键盘/⌘N 定位的可激活行：搜索态是平铺结果，快捷态是两组入口串联。 */
  const rows = $derived(
    query.trim().length > 0 ? searchRows : [...quickBotRows, ...quickSettingRows],
  );

  const isSearching = $derived(query.trim().length > 0);

  // 查询变化：高亮回到第一条；打开时清空上次输入并聚焦输入框。
  $effect(() => {
    void query;
    activeIndex = 0;
  });
  $effect(() => {
    if (!open) return;
    query = '';
    activeIndex = 0;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => inputEl?.focus());
    return () => {
      // 窄屏全屏层没有 bits-ui 的焦点归还：关闭时把焦点还给打开前的元素。
      if (!narrow) return;
      void tick().then(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  });

  // 窄屏全屏层的 Esc（宽屏弹框由 bits-ui 处理）。输入框自带焦点，Esc 直接关层。
  $effect(() => {
    if (!open || !narrow) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.page,
      onEscape: () => {
        open = false;
      },
    });
  });

  function activate(row: Row): void {
    open = false;
    query = '';
    if (row.kind === 'bot') {
      void chat.openDirect(row.bot.id);
      return;
    }
    if (row.kind === 'conversation') {
      void chat.select(row.conversation.id);
      return;
    }
    if (row.target.apply) {
      row.target.apply();
      return;
    }
    shell.openSettings(row.target.section, row.target.anchor);
  }

  function moveActive(delta: number): void {
    if (rows.length === 0) return;
    activeIndex = (activeIndex + delta + rows.length) % rows.length;
    void tick().then(() => {
      listEl?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  }

  function shortcutHint(index: number): string {
    return `${isMac ? '⌘' : 'Ctrl+'}${index + 1}`;
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key >= '1' && event.key <= '9') {
      const row = rows[Number(event.key) - 1];
      if (row) {
        event.preventDefault();
        activate(row);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      const row = rows[activeIndex];
      if (row) {
        event.preventDefault();
        activate(row);
      }
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- 结果区（宽窄两形态共用）：空态 / 搜索平铺 / 快捷入口两组。 -->
{#snippet rowsList()}
  {#snippet rowButton(row: Row, index: number)}
    <button
      type="button"
      class="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors
        {activeIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}"
      data-active={activeIndex === index}
      onclick={() => activate(row)}
      onmousemove={() => (activeIndex = index)}
      data-testid={`global-search-item-${row.key}`}
    >
      {#if row.kind === 'bot'}
        <BotAvatar
          botId={row.bot.id}
          name={row.bot.name}
          avatar={row.bot.avatar}
          mask={row.bot.avatarMask}
          class="size-10"
          fallbackClass="text-base"
        />
        <span class="grid min-w-0 flex-1 gap-0.5">
          <span class="truncate text-sm font-medium">{row.bot.name}</span>
          {#if row.bot.bio.length > 0}
            <span class="truncate text-xs text-muted-foreground">{row.bot.bio}</span>
          {/if}
        </span>
      {:else if row.kind === 'conversation'}
        {#if row.conversation.type === 'project'}
          <Avatar.Root class="size-10">
            <Avatar.Fallback class="bg-emerald-600 text-primary-foreground">
              <Users class="size-5" aria-hidden="true" />
            </Avatar.Fallback>
          </Avatar.Root>
        {:else}
          <BotAvatar
            botId={row.conversation.directBotId ?? row.conversation.id}
            name={row.conversation.bot?.name ?? row.conversation.directBotId ?? '?'}
            avatar={row.conversation.bot?.avatar ?? null}
            mask={row.conversation.bot?.avatarMask ?? null}
            class="size-10"
            fallbackClass="text-base"
          />
        {/if}
        <span class="grid min-w-0 flex-1 gap-0.5">
          <span class="truncate text-sm font-medium">{conversationTitle(row.conversation)}</span>
          {#if conversationPreview(row.conversation).length > 0}
            <span class="truncate text-xs text-muted-foreground">
              {conversationPreview(row.conversation)}
            </span>
          {/if}
        </span>
      {:else}
        {@const Icon = row.target.icon as unknown as Component<{ class?: string }>}
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-foreground/80"
        >
          <Icon class="size-4.5" />
        </span>
        <span class="grid min-w-0 flex-1 gap-0.5">
          <span class="truncate text-sm font-medium">{row.target.label}</span>
          <span class="truncate text-xs text-muted-foreground">{row.target.subtitle}</span>
        </span>
      {/if}
      {#if index < 9}
        <kbd
          class="shrink-0 rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
        >
          {shortcutHint(index)}
        </kbd>
      {/if}
    </button>
  {/snippet}

  {#if rows.length === 0}
    <p class="p-6 text-center text-sm text-muted-foreground" data-testid="global-search-empty">
      {t('search.noResults')}
    </p>
  {:else if isSearching}
    {#each searchRows as row, index (row.key)}
      {@render rowButton(row, index)}
    {/each}
  {:else}
    {#if quickBotRows.length > 0}
      <p class="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
        {t('search.groupBots')}
      </p>
      {#each quickBotRows as row, index (row.key)}
        {@render rowButton(row, index)}
      {/each}
    {/if}
    <p class="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
      {t('search.quickSettings')}
    </p>
    {#each quickSettingRows as row, index (row.key)}
      {@render rowButton(row, quickBotRows.length + index)}
    {/each}
  {/if}
{/snippet}

{#if narrow && open}
  <!-- 窄屏全屏浮层：盖住整个应用（像打开新页面），顶部拖拽带让出红绿灯。
       根节点 app-no-drag 盖掉下层延伸上来的 drag 矩形；顶栏是 app-drag，但输入框与按钮必须
       自带 app-no-drag——Electron 把 drag 区内的输入框也当窗口拖拽区，真实鼠标点击 / 框选
       会被吞（Playwright 的 CDP 点击测不出，由 e2e 的结构性断言守护）。 -->
  <div
    class="app-no-drag fixed inset-0 z-50 flex flex-col bg-background"
    data-testid="global-search-layer"
    in:fly={{ x: 48, duration: motionMs(MOTION.enter) }}
    out:fly={{ x: 48, duration: motionMs(MOTION.exit) }}
  >
    <div
      class="app-drag wco-inset-end flex h-14 shrink-0 items-center gap-1 border-b {isMac
        ? 'pr-3 pl-20'
        : 'px-3'}"
    >
      <Button
        variant="ghost"
        size="icon"
        class="app-no-drag size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        onclick={() => (open = false)}
        aria-label={t('narrow.back')}
        title={t('narrow.back')}
        data-testid="global-search-back"
      >
        <ChevronLeft class="size-5" aria-hidden="true" />
      </Button>
      <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        bind:this={inputEl}
        bind:value={query}
        placeholder={t('search.placeholder')}
        class="app-no-drag h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        data-testid="global-search-input"
      />
    </div>
    <div
      class="min-h-0 flex-1 overflow-y-auto p-2"
      bind:this={listEl}
      data-testid="global-search-list"
    >
      {@render rowsList()}
    </div>
  </div>
{:else}
  <Dialog.Root bind:open>
    <Dialog.Content
      class="w-[min(36rem,calc(100%_-_2rem))] max-w-none gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
      showCloseButton={false}
      data-testid="global-search-dialog"
    >
      <Dialog.Title class="sr-only">{t('search.open')}</Dialog.Title>
      <div class="flex items-center gap-2.5 border-b px-4">
        <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          bind:this={inputEl}
          bind:value={query}
          placeholder={t('search.placeholder')}
          class="h-14 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="global-search-input"
        />
      </div>

      <div
        class="max-h-[min(26rem,55vh)] overflow-y-auto p-2"
        bind:this={listEl}
        data-testid="global-search-list"
      >
        {@render rowsList()}
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}
