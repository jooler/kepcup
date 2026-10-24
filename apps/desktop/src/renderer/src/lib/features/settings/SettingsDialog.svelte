<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { resolveSettingsSection, type ResolvedSection } from './sections';
  import {
    asIconComponent,
    settingsSectionLabel,
    visibleSettingsSections,
  } from './settings-sections-list';
  import SettingsSectionView from './SettingsSectionView.svelte';
  import { revealSettingsAnchor } from './anchor-scroll';

  /**
   * 全局设置弹框：左栏分组条目 + 右侧分组内容。点击左栏条目只渲染对应
   * 分组（条件渲染，非滚动定位），滚动条归当前分组内容自己；打开时按
   * shell.settingsSection 直接落在目标分组，带 anchor 时再滚到分组内的
   * [data-settings-anchor]（如「模型 → 默认模型」）。沙箱与访问白名单并入
   *「环境」，定时任务并入「无人值守」；连接应用 / 已连接账号 / 邮箱在扩展中心
   *（`mcp` / `developer` 旧深链由 shell.openSettings 改开扩展中心）。
   *
   * 分区清单 / 内容视图与窄屏设置页（NarrowSettings）共用（settings-sections-list /
   * SettingsSectionView）；窄屏不再打开本弹框（shell.openSettings 重路由到
   * NarrowSettings 全屏页或对应 tab），窗口被拉窄时宽度上限贴视口。
   */
  type SectionId = ResolvedSection['section'];

  const narrow = $derived(narrowLayout.narrow);
  const sections = $derived(visibleSettingsSections(narrow));

  let clickedSection = $state<SectionId | null>(null);
  let contentEl: HTMLElement | undefined = $state();

  const requestedSection = $derived.by(() => {
    const resolved = resolveSettingsSection(shell.settingsSection);
    return sections.some((section) => section.id === resolved.section)
      ? resolved.section
      : ('general' as SectionId);
  });
  const activeSection = $derived(clickedSection ?? requestedSection);
  const activeLabel = $derived(settingsSectionLabel(activeSection));

  // 每次打开：展开别名后落在指定分组（无条目的 id 兜底回 general——窄屏下
  // 通讯录 / 用户画像深链即落这里，入口本身已在底部 tab）。分区同步取自
  // store 的派生值，不用延迟 effect 回写：回写与用户点别的分区的点击存在
  // 竞态（弹框刚开时 effect 尚未押上，点击先改了本地状态，随后被重置回
  // 打开时请求的分区）。点过的分区记进 clickedSection，关闭时清空。
  $effect(() => {
    if (shell.settingsOpen) return;
    clickedSection = null;
  });

  // 锚点滚动：目标分区渲染完成后滚到 [data-settings-anchor]，然后复位（anchor-scroll.ts，
  // 与窄屏设置页共用）。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (!shell.settingsOpen || anchor === null) return;
    void revealSettingsAnchor({
      anchor,
      container: () => contentEl,
      flush: tick,
      clear: () => (shell.settingsAnchor = null),
    });
  });
</script>

<Dialog.Root bind:open={shell.settingsOpen}>
  <Dialog.Content
    class="grid h-[80vh] max-w-[calc(100%_-_1rem)] grid-cols-1 grid-rows-[auto_1fr] gap-0 overflow-hidden p-0
      sm:max-w-4xl sm:grid-cols-[13rem_1fr] sm:grid-rows-1"
    onInteractOutside={(event) => event.preventDefault()}
    data-testid="settings-dialog"
  >
    <Dialog.Title class="sr-only">{t('settings.title')}</Dialog.Title>
    <nav
      class="flex min-h-0 shrink-0 flex-row items-center gap-1 overflow-x-auto border-b bg-muted/30 p-2 pr-12
        sm:flex-col sm:items-stretch sm:gap-0.5 sm:overflow-y-auto sm:border-r sm:border-b-0 sm:p-3"
    >
      {#each sections as section (section.id)}
        {@const Icon = asIconComponent(section.icon)}
        <button
          type="button"
          class="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm whitespace-nowrap transition-colors
            {activeSection === section.id
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
          onclick={() => (clickedSection = section.id)}
          data-testid={`settings-nav-${section.id}`}
        >
          <Icon class="size-4" />
          {section.label}
        </button>
      {/each}
    </nav>

    <div class="flex min-h-0 flex-col">
      <header class="flex h-12 shrink-0 items-center border-b px-4 sm:px-5">
        <h2 class="text-sm font-medium">{activeLabel}</h2>
      </header>
      <div
        class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
        data-testid="settings-page-content"
        bind:this={contentEl}
      >
        <SettingsSectionView section={activeSection} />
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
