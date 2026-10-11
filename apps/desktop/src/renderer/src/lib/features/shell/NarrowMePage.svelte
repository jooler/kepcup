<script lang="ts">
  import { ChevronRight, Settings2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import * as Avatar from '$lib/components/ui/avatar';
  import ProfileSection from '$lib/features/settings/ProfileSection.svelte';
  import NarrowPage from './NarrowPage.svelte';

  /**
   * 窄屏「我」tab 页（33-narrow-layout）：用户卡（本地用户）+ 设置入口 + 用户
   * 画像（复用设置分区，窄屏设置页里没有这一项）。设置入口不带分区参——
   * shell.openSettings() 在窄屏落到设置分组列表页（NarrowSettings），再进各
   * 分组详情。顶部只有红绿灯拖拽带（不渲染标题，见 NarrowPage）。
   */
</script>

<NarrowPage testid="narrow-me-page">
  <div class="space-y-4 p-4 pb-8">
    <div class="flex items-center gap-3">
      <Avatar.Root class="size-14">
        <Avatar.Fallback class="text-lg">{t('sidebar.userFallback')}</Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0">
        <p class="truncate text-base font-medium">{t('sidebar.userName')}</p>
        <p class="truncate text-xs text-muted-foreground">{t('sidebar.userEmail')}</p>
      </div>
    </div>

    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-xl border p-3 text-left
        text-sm transition-colors hover:bg-accent/40"
      onclick={() => shell.openSettings()}
      data-testid="narrow-me-settings"
    >
      <Settings2 class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="flex-1">{t('menu.settings')}</span>
      <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>

    <ProfileSection />
  </div>
</NarrowPage>
