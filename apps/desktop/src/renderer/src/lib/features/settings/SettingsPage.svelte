<script lang="ts">
  import { tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import { motionMs, MOTION } from '$lib/motion';
  import { settingsSectionLabel } from './settings-sections-list';
  import SettingsSectionView from './SettingsSectionView.svelte';
  import { revealSettingsAnchor } from './anchor-scroll';
  import {
    blurEditableTarget,
    ESCAPE_PRIORITY,
    registerEscapeLayer,
  } from '$lib/features/shell/escape-layers';

  /**
   * 宽屏设置页（原 SettingsDialog 弹框改整页视图）：主区被设置接管——左栏是分类
   * 列表（AppSidebar 按 shell.settingsOpen 渲染，顶部「返回对话」退出），本组件
   * 只负责主体：顶部当前分类标题 + 分区内容。点击左栏条目只渲染对应分区（条件
   * 渲染，非滚动定位），滚动条归当前分区内容自己；打开时按 shell.settingsSection
   * 直接落在目标分类，带 anchor 时再滚到分区内的 [data-settings-anchor]（如
   * 「模型 → 默认模型」）。扩展中心是伪分区（'extension-center'），主体渲染
   * ExtensionCenterBody（市场 / 已安装 / 设置页签）。内容列按分类限宽：表单分区
   * max-w-3xl 居中，扩展中心不限宽、只加大左右留白（见 contentClass）。
   *
   * 分区清单 / 内容视图与窄屏设置页（NarrowSettings）共用（settings-sections-list /
   * SettingsSectionView）；窄屏不走本页（shell.openSettings 重路由到 NarrowSettings
   * 全屏页或对应 tab）。
   */
  const activeSection = $derived(shell.settingsSection);
  const activeLabel = $derived(
    activeSection === 'extension-center'
      ? t('sidebar.extensionCenter')
      : settingsSectionLabel(activeSection),
  );
  /**
   * 内容列的宽度策略：表单型设置分区限宽居中（拉满窗口后字段行过长难读）；
   * 扩展中心不限宽（市场 / 已安装的卡片网格吃满可用宽度），只加大左右留白。
   */
  const contentClass = $derived(
    activeSection === 'extension-center' ? 'px-2 sm:px-10' : 'mx-auto max-w-3xl',
  );

  let contentEl: HTMLElement | undefined = $state();

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

  // Esc 退出设置页（escape-layers 仲裁，同窄屏设置页：输入控件里先失焦再退出）。
  $effect(() => {
    if (!shell.settingsOpen) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.page,
      onEscape: (event) => {
        if (blurEditableTarget(event)) return;
        shell.closeSettings();
      },
    });
  });
</script>

<div class="flex min-h-0 flex-1 flex-col bg-background" data-testid="settings-page">
  <header
    class="app-drag flex h-12 shrink-0 items-center border-b px-4 sm:px-5"
    data-testid="settings-page-header"
  >
    <h2 class="text-sm font-medium">{activeLabel}</h2>
  </header>
  <div
    class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
    data-testid="settings-page-content"
    bind:this={contentEl}
  >
    {#key activeSection}
      <div in:fade={{ duration: motionMs(MOTION.content) }} class={contentClass}>
        <SettingsSectionView section={activeSection} />
      </div>
    {/key}
  </div>
</div>
