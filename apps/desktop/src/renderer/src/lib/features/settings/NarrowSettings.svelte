<script lang="ts">
  import { tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import { motionMs, MOTION } from '$lib/motion';
  import { Button } from '$lib/components/ui/button';
  import {
    asIconComponent,
    settingsSectionLabel,
    visibleSettingsSections,
    type SettingsViewSection,
  } from './settings-sections-list';
  import SettingsSectionView from './SettingsSectionView.svelte';
  import { revealSettingsAnchor } from './anchor-scroll';
  import {
    blurEditableTarget,
    ESCAPE_PRIORITY,
    registerEscapeLayer,
  } from '$lib/features/shell/escape-layers';

  /**
   * 窄屏设置全屏页（33-narrow-layout，修复 7）：设置不再是弹框——分组列表占
   * 一页，点条目进对应分组详情页（左上角返回）。入口统一走 shell.openSettings：
   * 不带分区落列表页，带分区直达详情页；「通讯录」「用户画像」在窄屏是底部
   * tab，深链由 shell store 切 tab、不进本页。
   *
   * 顶部拖拽带让出 macOS 红绿灯；Esc 在列表点进的详情页回列表、其余关页面
   * （嵌套弹层先归弹层，统一经 escape-layers 仲裁）。
   */
  const isMac = /Mac/i.test(navigator.platform);

  const open = $derived(shell.narrowSettingsOpen);
  const sections = $derived(visibleSettingsSections(true));
  const section = $derived(shell.narrowSettingsSection as SettingsViewSection | null);
  const label = $derived(section === null ? t('settings.title') : settingsSectionLabel(section));

  let contentEl: HTMLElement | null = $state(null);

  // 锚点滚动：详情页渲染完后滚到 [data-settings-anchor]（anchor-scroll.ts，与宽屏弹框共用）。
  $effect(() => {
    const anchor = shell.narrowSettingsAnchor;
    if (!open || section === null || anchor === null) return;
    void revealSettingsAnchor({
      anchor,
      container: () => contentEl,
      flush: tick,
      clear: () => (shell.narrowSettingsAnchor = null),
    });
  });

  /** 返回：列表点进的详情回列表；深链直达的详情 / 列表页关页面（shell.backNarrowSettings）。 */
  const back = (): void => shell.backNarrowSettings();

  // Esc 经层级仲裁（escape-layers.ts）：页面打开期间登记为最顶的全屏页；嵌套的
  // bits-ui 弹层（Select / Popover / 弹框）已 preventDefault 的 Esc 仲裁器不会再派发，
  // 输入框里的 Esc 先失焦；设置页开在 Bot 覆盖层之上时一次 Esc 只关设置页。
  $effect(() => {
    if (!open) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.page,
      onEscape: (event) => {
        if (blurEditableTarget(event)) return;
        back();
      },
    });
  });
</script>

{#if open}
  <!-- app-no-drag：整页声明 no-drag，盖掉下层会话头部 / 其他页面延伸上来的 drag 矩形
       （app-region 按 DOM 顺序后者胜出）；顶栏自己再声明 drag。 -->
  <div
    class="app-no-drag fixed inset-0 z-50 flex flex-col bg-background"
    data-testid="narrow-settings-page"
    in:fly={{ x: 48, duration: motionMs(MOTION.enter) }}
    out:fly={{ x: 48, duration: motionMs(MOTION.exit) }}
  >
    <div
      class="app-drag flex h-14 shrink-0 items-center gap-1 border-b {isMac
        ? 'pr-3 pl-20'
        : 'px-3'}"
    >
      <Button
        variant="ghost"
        size="icon"
        class="app-no-drag size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        onclick={back}
        aria-label={t('narrow.back')}
        title={t('narrow.back')}
        data-testid="narrow-settings-back"
      >
        <ChevronLeft class="size-5" aria-hidden="true" />
      </Button>
      <h1 class="truncate text-base font-semibold">{label}</h1>
    </div>

    {#if section === null}
      <div
        class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-3"
        data-testid="narrow-settings-list"
        in:fade={{ duration: motionMs(MOTION.content) }}
      >
        {#each sections as item (item.id)}
          {@const Icon = asIconComponent(item.icon)}
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 rounded-xl p-3 text-left
              text-sm transition-colors hover:bg-accent/40"
            onclick={() => shell.selectNarrowSettingsSection(item.id)}
            data-testid={`narrow-settings-item-${item.id}`}
          >
            <span
              class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-foreground/80"
            >
              <Icon class="size-4.5" />
            </span>
            <span class="min-w-0 flex-1 truncate">{item.label}</span>
            <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        {/each}
      </div>
    {:else}
      <div
        class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4"
        bind:this={contentEl}
        data-testid="narrow-settings-content"
        in:fade={{ duration: motionMs(MOTION.content) }}
      >
        <SettingsSectionView {section} />
      </div>
    {/if}
  </div>
{/if}
