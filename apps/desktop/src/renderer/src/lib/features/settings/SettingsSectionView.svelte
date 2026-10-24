<script lang="ts">
  import { t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import AppearanceSection from './AppearanceSection.svelte';
  import GeneralSection from './GeneralSection.svelte';
  import HardwareSection from './HardwareSection.svelte';
  import ModelsSection from './ModelsSection.svelte';
  import ContactsSection from '$lib/features/contacts/ContactsSection.svelte';
  import SandboxSection from './SandboxSection.svelte';
  import UnattendedSection from './UnattendedSection.svelte';
  import AllowlistSection from './AllowlistSection.svelte';
  import EnvironmentSection from './EnvironmentSection.svelte';
  import ProfileSection from './ProfileSection.svelte';
  import RemoteSection from './RemoteSection.svelte';
  import UsageSection from './UsageSection.svelte';
  import EmbeddingSection from './EmbeddingSection.svelte';
  import WebSearchSection from './WebSearchSection.svelte';
  import BrowserProfilesSection from './BrowserProfilesSection.svelte';
  import AgentsSection from './AgentsSection.svelte';
  import BackgroundTasksSection from './BackgroundTasksSection.svelte';
  import SchedulesSection from './SchedulesSection.svelte';
  import DiagnosticsSection from './DiagnosticsSection.svelte';
  import type { SettingsViewSection } from './settings-sections-list';

  /**
   * 设置分区内容（分区 id → 对应分区组件，含 data-settings-section /
   * data-settings-anchor 锚点）：SettingsDialog（宽屏弹框）与 NarrowSettings
   * （窄屏全屏页）共用。容器与滚动归调用方。
   */
  let { section }: { section: SettingsViewSection } = $props();
</script>

{#if section === 'general'}
  <div data-settings-section="general" class="space-y-6">
    <div data-settings-anchor="appearance">
      <AppearanceSection />
    </div>
    <div data-settings-anchor="general">
      <GeneralSection />
    </div>
  </div>
{:else if section === 'hardware'}
  <div data-settings-section="hardware" class="space-y-6">
    <div data-settings-anchor="hardware">
      <HardwareSection />
    </div>
  </div>
{:else if section === 'models'}
  <div data-settings-section="models" class="space-y-6">
    <div data-settings-anchor="default-models">
      <ModelsSection />
    </div>
    <div data-settings-anchor="embedding">
      <EmbeddingSection />
    </div>
  </div>
{:else if section === 'search'}
  <div data-settings-section="search" class="space-y-6">
    <div data-settings-anchor="web-search">
      <WebSearchSection testid="settings-web-search" />
    </div>
  </div>
{:else if section === 'browser'}
  <div data-settings-section="browser" class="space-y-6">
    <div data-settings-anchor="browser-profiles">
      <BrowserProfilesSection />
    </div>
  </div>
{:else if section === 'agents'}
  <div data-settings-section="agents" class="space-y-6">
    <div data-settings-anchor="agents">
      <AgentsSection />
    </div>
    {#if agentsStore.experimental}
      <div data-settings-anchor="background-tasks">
        <BackgroundTasksSection />
      </div>
    {/if}
  </div>
{:else if section === 'contacts'}
  <div data-settings-section="contacts">
    <ContactsSection />
  </div>
{:else if section === 'unattended'}
  <div data-settings-section="unattended" class="space-y-6">
    <UnattendedSection />
    <div data-settings-anchor="schedules">
      <SchedulesSection />
    </div>
  </div>
{:else if section === 'remote'}
  <div data-settings-section="remote" class="space-y-6">
    <RemoteSection />
  </div>
{:else if section === 'profile'}
  <div data-settings-section="profile">
    <ProfileSection />
  </div>
{:else if section === 'environment'}
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
{:else if section === 'usage'}
  <div data-settings-section="usage">
    <UsageSection />
  </div>
{:else if section === 'diagnostics'}
  <div data-settings-section="diagnostics">
    <DiagnosticsSection />
  </div>
{/if}
