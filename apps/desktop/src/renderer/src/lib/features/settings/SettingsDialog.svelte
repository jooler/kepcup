<script lang="ts">
  import { tick } from 'svelte';
  import type { Component } from 'svelte';
  import {
    Activity,
    BarChart3,
    BookUser,
    Globe,
    Plug,
    Monitor,
    MoonStar,
    UserRound,
    Settings2,
    Cpu,
    type LucideIcon,
  } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { shell, type SettingsSectionId } from '$lib/stores/shell.svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import AppearanceSection from './AppearanceSection.svelte';
  import GeneralSection from './GeneralSection.svelte';
  import ModelsSection from './ModelsSection.svelte';
  import ContactsSection from '$lib/features/contacts/ContactsSection.svelte';
  import SandboxSection from './SandboxSection.svelte';
  import UnattendedSection from './UnattendedSection.svelte';
  import AllowlistSection from './AllowlistSection.svelte';
  import EnvironmentSection from './EnvironmentSection.svelte';
  import ProfileSection from './ProfileSection.svelte';
  import UsageSection from './UsageSection.svelte';
  import EmbeddingSection from './EmbeddingSection.svelte';
  import WebSearchSection from './WebSearchSection.svelte';
  import McpSection from './McpSection.svelte';
  import SchedulesSection from './SchedulesSection.svelte';
  import DiagnosticsSection from './DiagnosticsSection.svelte';

  /**
   * 全局设置弹框：左栏分组条目 + 右侧分组内容。点击左栏条目只渲染对应
   * 分组（条件渲染，非滚动定位），滚动条归当前分组内容自己；打开时按
   * shell.settingsSection 直接落在目标分组，带 anchor 时再滚到分组内的
   * [data-settings-anchor]（如「模型 → 默认模型」）。沙箱与访问白名单并入
   * 「环境」，定时任务并入「无人值守」。
   */
  interface SectionDef {
    id: SettingsSectionId;
    label: string;
    icon: LucideIcon;
  }

  const sections: SectionDef[] = [
    { id: 'general', label: t('settings.navGeneral'), icon: Settings2 },
    { id: 'models', label: t('settings.navModels'), icon: Cpu },
    { id: 'search', label: t('settings.navWebSearch'), icon: Globe },
    { id: 'mcp', label: t('settings.navMcp'), icon: Plug },
    { id: 'profile', label: t('settings.navProfile'), icon: UserRound },
    { id: 'contacts', label: t('settings.navContacts'), icon: BookUser },
    { id: 'unattended', label: t('settings.navUnattended'), icon: MoonStar },
    { id: 'environment', label: t('settings.navEnvironment'), icon: Monitor },
    { id: 'usage', label: t('settings.navUsage'), icon: BarChart3 },
    { id: 'diagnostics', label: t('settings.navDiagnostics'), icon: Activity },
  ];

  let activeSection = $state<SettingsSectionId>('general');
  let contentEl: HTMLElement | undefined = $state();

  const activeLabel = $derived(
    sections.find((section) => section.id === activeSection)?.label ?? t('settings.title'),
  );

  // 每次打开：落在指定分组（无左栏条目的 id 兜底回 usage）。
  $effect(() => {
    if (!shell.settingsOpen) return;
    const target = shell.settingsSection;
    activeSection = sections.some((section) => section.id === target) ? target : 'usage';
  });

  // 锚点滚动：目标分区渲染完成后滚到 [data-settings-anchor]，然后复位。
  // 手动算 scrollTop（scrollIntoView 会让整个弹框内容跟着抢滚动）。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (!shell.settingsOpen || anchor === null) return;
    void tick().then(() => {
      const container = contentEl;
      const target = container?.querySelector(`[data-settings-anchor="${anchor}"]`);
      if (container && target) {
        const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTo({ top: Math.max(0, container.scrollTop + offset - 8) });
      }
      shell.settingsAnchor = null;
    });
  });
</script>

<Dialog.Root bind:open={shell.settingsOpen}>
  <Dialog.Content
    class="grid h-[80vh] max-w-[calc(100%_-_2rem)] grid-cols-[13rem_1fr] gap-0 overflow-hidden p-0 sm:max-w-4xl"
    onInteractOutside={(event) => event.preventDefault()}
    data-testid="settings-dialog"
  >
    <Dialog.Title class="sr-only">{t('settings.title')}</Dialog.Title>
    <nav class="flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r bg-muted/30 p-3">
      {#each sections as section (section.id)}
        {@const Icon = section.icon as unknown as Component<{ class?: string }>}
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors
            {activeSection === section.id
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
          onclick={() => (activeSection = section.id)}
          data-testid={`settings-nav-${section.id}`}
        >
          <Icon class="size-4" />
          {section.label}
        </button>
      {/each}
    </nav>

    <div class="flex min-h-0 flex-col">
      <header class="flex h-12 shrink-0 items-center border-b px-5">
        <h2 class="text-sm font-medium">{activeLabel}</h2>
      </header>
      <div
        class="min-h-0 flex-1 overflow-y-auto p-6"
        data-testid="settings-page-content"
        bind:this={contentEl}
      >
        {#if activeSection === 'general'}
          <div data-settings-section="general" class="space-y-6">
            <div data-settings-anchor="appearance">
              <AppearanceSection />
            </div>
            <div data-settings-anchor="general">
              <GeneralSection />
            </div>
          </div>
        {:else if activeSection === 'models'}
          <div data-settings-section="models" class="space-y-6">
            <div data-settings-anchor="default-models">
              <ModelsSection />
            </div>
            <div data-settings-anchor="embedding">
              <EmbeddingSection />
            </div>
          </div>
        {:else if activeSection === 'search'}
          <div data-settings-section="search" class="space-y-6">
            <div data-settings-anchor="web-search">
              <WebSearchSection testid="settings-web-search" />
            </div>
          </div>
        {:else if activeSection === 'mcp'}
          <div data-settings-section="mcp" class="space-y-6">
            <div data-settings-anchor="mcp">
              <McpSection />
            </div>
          </div>
        {:else if activeSection === 'contacts'}
          <div data-settings-section="contacts">
            <ContactsSection />
          </div>
        {:else if activeSection === 'unattended'}
          <div data-settings-section="unattended" class="space-y-6">
            <UnattendedSection />
            <div data-settings-anchor="schedules">
              <SchedulesSection />
            </div>
          </div>
        {:else if activeSection === 'profile'}
          <div data-settings-section="profile">
            <ProfileSection />
          </div>
        {:else if activeSection === 'environment'}
          <div data-settings-section="environment" class="space-y-6">
            <div data-settings-anchor="environment">
              <EnvironmentSection />
            </div>
            <div data-settings-anchor="sandbox" class="space-y-3">
              <SandboxSection />
              <p class="text-xs text-muted-foreground" data-testid="sandbox-confirm-note">
                {t('settings.sandboxNoteP03')}
              </p>
            </div>
            <div data-settings-anchor="allowlist">
              <AllowlistSection />
            </div>
          </div>
        {:else if activeSection === 'usage'}
          <div data-settings-section="usage">
            <UsageSection />
          </div>
        {:else if activeSection === 'diagnostics'}
          <div data-settings-section="diagnostics">
            <DiagnosticsSection />
          </div>
        {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
