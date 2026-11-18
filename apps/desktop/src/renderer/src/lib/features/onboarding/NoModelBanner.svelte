<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * P13 任务 4: 「跳过模型配置后持续提示」(BR-P13-004). Shows once onboarding
   * is COMPLETE and no provider holds a key — whichever path led there
   * (「跳过引导」直达完成 or a later key removal), the task book's "无法与
   * Bot 对话，界面持续提示" is about the no-key state itself. Configuring any
   * key (settings page) removes it. Never blocks other features — it is a
   * single banner row above the working app. 外部智能体不替代模型（2026-11
   * 修订）：对话恒走内置模型，没有可用厂商 Key 就提示。
   */
  const noKey = $derived(
    settingsStore.settings !== null &&
      settingsStore.settings.onboarding.completed &&
      !settingsStore.providers.some((provider) => provider.hasKey),
  );
</script>

{#if noKey && !onboarding.open}
  <div
    class="app-no-drag pointer-events-none flex w-full max-w-xl items-center gap-3 rounded-full
      border border-amber-700/40 bg-amber-500 px-4 py-1.5 text-sm font-medium text-white shadow-lg"
    data-testid="no-model-banner"
  >
    <span class="min-w-0 flex-1">{t('onboarding.noModelBanner')}</span>
    <Button
      size="sm"
      variant="outline"
      class="pointer-events-auto h-6 border-white/60 bg-transparent px-2 text-white hover:bg-white/20"
      onclick={() => shell.openSettings('models')}
      data-testid="no-model-go-settings"
    >
      {t('onboarding.noModelGo')}
    </Button>
  </div>
{/if}
