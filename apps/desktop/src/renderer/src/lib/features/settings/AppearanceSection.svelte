<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { userPrefersMode } from 'mode-watcher';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { i18n, localeOptions, t } from '$lib/i18n';
  import * as Select from '$lib/components/ui/select';
  import { Button } from '$lib/components/ui/button';
  import { applySettingItem } from '$lib/features/settings-card/apply';
  import { prefillString } from '$lib/features/settings-card/setting-card-model';

  /**
   * 外观（参考 Grok Bot 设置弹框）：明暗主题 + 语言，各占一整行——标签在
   * 左、控件在右。主题经 mode-watcher 持久化（写 userPrefersMode 即生效并
   * 落 localStorage）；语言注册表当前只有简体中文，选择器先就位，新增语言
   * 时无需改动此组件。
   *
   * `embedded`：对话内设置卡只显示 `focus` 那一项，先改草稿，点「应用」才写入
   * 本机并结卡。设置页不传这些 props，仍是选中即生效。
   */
  type ModeValue = 'light' | 'dark' | 'system';

  let {
    embedded = false,
    focus = 'all' as 'all' | 'theme' | 'language',
    prefill = null as SettingValues | null,
    messageId = undefined as string | undefined,
    onSaved,
  }: {
    embedded?: boolean;
    focus?: 'all' | 'theme' | 'language';
    prefill?: SettingValues | null;
    messageId?: string | undefined;
    onSaved?: () => void;
  } = $props();

  const showTheme = $derived(!embedded || focus === 'all' || focus === 'theme');
  const showLanguage = $derived(!embedded || focus === 'all' || focus === 'language');

  function isMode(value: string | null): value is ModeValue {
    return value === 'light' || value === 'dark' || value === 'system';
  }

  let draftTheme = $state<ModeValue>(
    untrack(() => {
      const wanted = prefillString(prefill, 'theme');
      if (isMode(wanted)) return wanted;
      return isMode(userPrefersMode.current) ? userPrefersMode.current : 'system';
    }),
  );
  // 预填只认支持的界面语言；别的值（Bot 随口给的 'en' 之类）忽略，草稿停在当前语言。
  let draftLanguage = $state(
    untrack(() => {
      const wanted = prefillString(prefill, 'language');
      return wanted !== null && localeOptions.some((option) => option.id === wanted)
        ? wanted
        : i18n.locale;
    }),
  );
  let busy = $state(false);

  async function applyEmbedded(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (showTheme) {
        userPrefersMode.current = draftTheme;
        await applySettingItem({
          itemId: 'general.theme',
          values: { theme: draftTheme },
          expected: null,
          messageId: focus === 'theme' ? messageId : undefined,
        });
      }
      if (showLanguage) {
        i18n.locale = draftLanguage;
        await applySettingItem({
          itemId: 'general.language',
          values: { language: draftLanguage },
          expected: null,
          messageId: focus === 'language' ? messageId : undefined,
        });
      }
      toast.success(t('settingCard.appliedToast'));
      onSaved?.();
    } catch (error) {
      toast.error(
        t('settingCard.actionFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      busy = false;
    }
  }

  const themeOptions: Array<{ value: ModeValue; label: string }> = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];

  const currentMode = $derived(userPrefersMode.current);
</script>

<section class="space-y-3" data-testid="settings-appearance">
  {#if !embedded}
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
  {:else}
    <div class="grid gap-2">
      {#if showTheme}
        <span class="text-sm">{t('settings.theme')}</span>
        <Select.Root type="single" bind:value={draftTheme}>
          <Select.Trigger class="w-full" data-testid="appearance-theme" aria-label={t('settings.theme')}>
            {themeOptions.find((option) => option.value === draftTheme)?.label ?? draftTheme}
          </Select.Trigger>
          <Select.Content>
            {#each themeOptions as option (option.value)}
              <Select.Item value={option.value}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
      {#if showLanguage}
        <span class="text-sm">{t('settings.language')}</span>
        <Select.Root type="single" bind:value={draftLanguage}>
          <Select.Trigger
            class="w-full"
            data-testid="appearance-language"
            aria-label={t('settings.language')}
          >
            {localeOptions.find((option) => option.id === draftLanguage)?.label ?? draftLanguage}
          </Select.Trigger>
          <Select.Content>
            {#each localeOptions as option (option.id)}
              <Select.Item value={option.id}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
      <div class="flex justify-end">
        <Button size="sm" disabled={busy} onclick={() => void applyEmbedded()} data-testid="appearance-apply">
          {t('settingCard.apply')}
        </Button>
      </div>
    </div>
  {/if}
</section>
