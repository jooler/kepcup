<script lang="ts">
  import { userPrefersMode } from 'mode-watcher';
  import { i18n, localeOptions, t } from '$lib/i18n';
  import * as Select from '$lib/components/ui/select';

  /**
   * 外观（参考 Grok Bot 设置弹框）：明暗主题 + 语言，各占一整行——标签在
   * 左、控件在右。主题经 mode-watcher 持久化（写 userPrefersMode 即生效并
   * 落 localStorage）；语言注册表当前只有简体中文，选择器先就位，新增语言
   * 时无需改动此组件。
   */
  type ModeValue = 'light' | 'dark' | 'system';

  const themeOptions: Array<{ value: ModeValue; label: string }> = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];

  const currentMode = $derived(userPrefersMode.current);
</script>

<section class="space-y-3" data-testid="settings-appearance">
  <h3 class="text-sm font-medium">{t('settings.appearanceSection')}</h3>
  <div class="divide-y rounded-xl border px-4">
    <div class="flex items-center justify-between gap-4 py-3.5">
      <span class="text-sm">{t('settings.theme')}</span>
      <Select.Root type="single" bind:value={userPrefersMode.current}>
        <Select.Trigger
          class="w-40"
          data-testid="appearance-theme"
          aria-label={t('settings.theme')}
        >
          {themeOptions.find((option) => option.value === currentMode)?.label ?? currentMode}
        </Select.Trigger>
        <Select.Content>
          {#each themeOptions as option (option.value)}
            <Select.Item value={option.value}>{option.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="py-3.5">
      <div class="flex items-center justify-between gap-4">
        <span class="text-sm">{t('settings.language')}</span>
        <Select.Root type="single" bind:value={i18n.locale}>
          <Select.Trigger
            class="w-40"
            data-testid="appearance-language"
            aria-label={t('settings.language')}
          >
            {localeOptions.find((option) => option.id === i18n.locale)?.label ?? i18n.locale}
          </Select.Trigger>
          <Select.Content>
            {#each localeOptions as option (option.id)}
              <Select.Item value={option.id}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <p class="mt-1 text-xs text-muted-foreground">{t('settings.languageHint')}</p>
    </div>
  </div>
</section>
