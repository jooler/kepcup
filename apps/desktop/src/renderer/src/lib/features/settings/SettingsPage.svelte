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
   * 「模型 → 默认模型」；「模型」分区外层不滚，锚点由 ModelsSection 滚到右栏
   * 详情内部）。扩展中心是伪分区（'extension-center'），主体渲染
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
   * 模型 / 智能体分区两栏（左导航 + 右详情）放宽到 max-w-5xl；扩展中心不限宽
   * （市场 / 已安装的卡片网格吃满可用宽度）。
   *
   * 扩展中心同时接管纵向与横向留白：外层内容区不滚动、不给内边距，整块撑满
   * 剩余高度与整行宽度，滚动交给各分组自己的滚动区（市场 / 已安装 / 设置），
   * 留白由滚动容器的内边距提供（`bleed`）——这样滚动条贴应用右缘，内容仍有
   * 视觉留白；否则插件详情页会把整个设置页（含页签）当成一个长文档滚动。
   *
   * 「模型」「智能体」分区同理接管纵向空间：外层内容区只留内边距、不滚动，
   * 两栏卡以窗口剩余高度为最大高度撑满（`min-h-0` + `flex-1`），滚动归右栏
   * 详情自己（ModelsSection / AgentsSection 把右栏设为 overflow-y-auto）——
   * 否则供应商 / 智能体详情内容一多，整个设置页（含顶部标题行）会变成一个
   * 长文档滚动。
   */
  const contentClass = $derived(
    activeSection === 'extension-center'
      ? 'flex min-h-0 flex-1 flex-col'
      : activeSection === 'models' || activeSection === 'agents'
        ? 'mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col'
        : 'mx-auto max-w-3xl',
  );
  /** 扩展中心与「模型」「智能体」分区自己管滚动（扩展中心留白归 bleed）；其余分区仍由内容区滚动。 */
  const contentScrollerClass = $derived(
    activeSection === 'extension-center'
      ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
      : activeSection === 'models' || activeSection === 'agents'
        ? 'flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-6'
        : 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6',
  );

  let contentEl: HTMLElement | undefined = $state();

  // 锚点滚动：目标分区渲染完成后滚到 [data-settings-anchor]，然后复位（anchor-scroll.ts，
  // 与窄屏设置页共用）。「模型」分区外层不可滚（overflow-hidden），锚点交给
  // ModelsSection 在右栏详情内部滚，这里不抢。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (!shell.settingsOpen || anchor === null) return;
    if (activeSection === 'models') return;
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
  <!-- overflow-y-auto 会把另一轴的 visible 计算成 auto：显式 overflow-x-hidden，
       否则分区里个别超宽元素会让这一列出现横向滚动条。扩展中心分组自带滚动区，
       外层就不滚（否则滚动条会贴住窗口边缘）。 -->
  <div class={contentScrollerClass} data-testid="settings-page-content" bind:this={contentEl}>
    {#key activeSection}
      <div in:fade={{ duration: motionMs(MOTION.content) }} class={contentClass}>
        <SettingsSectionView section={activeSection} bleed={activeSection === 'extension-center'} />
      </div>
    {/key}
  </div>
</div>
