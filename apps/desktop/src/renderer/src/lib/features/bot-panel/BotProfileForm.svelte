<script lang="ts">
  /** Shared profile form fields for bot create (dialog) and edit (right panel). */
  import type { BotProfile } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { settingsStore } from '$lib/stores/settings.svelte';

  let {
    profile = $bindable(),
    /** 名字/简介在右栏头部资料卡已有点按直编，编辑场景传 false 隐藏（新建场景必填，保持显示）。 */
    showIdentity = true,
  }: { profile: BotProfile; showIdentity?: boolean } = $props();

  /**
   * Only providers with a stored key offer models here; a stored model ref
   * whose provider key was removed stays selectable as a marked stale entry
   * so the current value still renders (and can be consciously cleared).
   */
  const modelOptions = $derived.by(() => {
    const options = settingsStore.availableModelOptions;
    const stale = [profile.runtime.model, profile.runtime.light_model].filter(
      (ref) => ref.length > 0 && !options.some((option) => option.ref === ref),
    );
    return [
      ...options,
      ...stale.map((ref) => ({ ref, label: t('contacts.modelUnavailable', { ref }) })),
    ];
  });
  // D65：应用级已启用的 MCP server 才出现在勾选列表里。
  const mcpOptions = $derived(
    (settingsStore.settings?.mcpServers ?? []).filter((server) => server.enabled),
  );

  function toggleMcpServer(id: string, checked: boolean): void {
    const selected = profile.runtime.mcp_server_ids.filter((entry) => entry !== id);
    profile.runtime.mcp_server_ids = checked ? [...selected, id] : selected;
  }
  let boundariesText = $state(profile.boundaries.join('\n'));
  let allowlistText = $state(profile.runtime.network_allowlist.join('\n'));

  function syncBoundaries(): void {
    profile.boundaries = boundariesText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function syncAllowlist(): void {
    profile.runtime.network_allowlist = allowlistText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
</script>

<div class="space-y-4">
  {#if showIdentity}
    <div class="grid gap-1.5">
      <Label for="bot-name">{t('contacts.name')}</Label>
      <Input
        id="bot-name"
        bind:value={profile.identity.name}
        placeholder={t('contacts.namePlaceholder')}
        data-testid="bot-name-input"
      />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-bio">{t('contacts.bio')}</Label>
      <Input
        id="bot-bio"
        bind:value={profile.identity.bio}
        placeholder={t('contacts.bioPlaceholder')}
        data-testid="bot-bio-input"
      />
    </div>
  {/if}
  <div class="grid gap-1.5">
    <Label for="bot-personality">{t('contacts.personality')}</Label>
    <Textarea
      id="bot-personality"
      bind:value={profile.persona.personality}
      rows={2}
      data-testid="bot-personality-input"
    />
  </div>
  <div class="grid gap-4 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="bot-tone">{t('contacts.tone')}</Label>
      <Input id="bot-tone" bind:value={profile.persona.tone} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-style">{t('contacts.style')}</Label>
      <Input id="bot-style" bind:value={profile.persona.style} />
    </div>
  </div>
  <div class="grid gap-1.5">
    <Label for="bot-values">{t('contacts.values')}</Label>
    <Textarea id="bot-values" bind:value={profile.persona.values} rows={2} />
  </div>
  <div class="grid gap-1.5">
    <Label for="bot-samples">{t('contacts.sampleDialogues')}</Label>
    <Textarea id="bot-samples" bind:value={profile.persona.sample_dialogues} rows={3} />
  </div>
  <div class="grid gap-4 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="bot-expertise">{t('contacts.expertise')}</Label>
      <Input id="bot-expertise" bind:value={profile.role.expertise} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-responsibilities">{t('contacts.responsibilities')}</Label>
      <Input id="bot-responsibilities" bind:value={profile.role.responsibilities} />
    </div>
  </div>
  <div class="grid gap-1.5">
    <Label for="bot-boundaries">{t('contacts.boundaries')}</Label>
    <Textarea id="bot-boundaries" bind:value={boundariesText} oninput={syncBoundaries} rows={2} />
  </div>
  <div class="grid gap-1.5">
    <Label for="bot-network-policy">{t('contacts.networkPolicy')}</Label>
    <select
      id="bot-network-policy"
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={profile.runtime.network_policy}
      data-testid="bot-network-policy"
    >
      <option value="open">{t('contacts.networkPolicyOpen')}</option>
      <option value="allowlist">{t('contacts.networkPolicyAllowlist')}</option>
      <option value="none">{t('contacts.networkPolicyNone')}</option>
    </select>
  </div>
  {#if profile.runtime.network_policy === 'allowlist'}
    <div class="grid gap-1.5">
      <Label for="bot-network-allowlist">{t('contacts.networkAllowlist')}</Label>
      <Textarea
        id="bot-network-allowlist"
        rows={2}
        bind:value={allowlistText}
        oninput={syncAllowlist}
        placeholder={t('contacts.networkAllowlistHint')}
      />
    </div>
  {/if}
  <div class="grid gap-4 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="bot-model">{t('contacts.mainModel')}</Label>
      <select
        id="bot-model"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={profile.runtime.model}
        data-testid="bot-model-select"
      >
        <option value="">—</option>
        {#each modelOptions as option (option.ref)}
          <option value={option.ref}>{option.label}</option>
        {/each}
      </select>
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-light-model">{t('contacts.lightModel')}</Label>
      <select
        id="bot-light-model"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={profile.runtime.light_model}
      >
        <option value="">—</option>
        {#each modelOptions as option (option.ref)}
          <option value={option.ref}>{option.label}</option>
        {/each}
      </select>
    </div>
  </div>
  {#if mcpOptions.length > 0}
    <div class="grid gap-1.5">
      <Label>{t('contacts.mcpServers')}</Label>
      <div class="space-y-1.5" data-testid="bot-mcp-servers">
        {#each mcpOptions as server (server.id)}
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={profile.runtime.mcp_server_ids.includes(server.id)}
              onCheckedChange={(checked) => toggleMcpServer(server.id, checked === true)}
              data-testid={`bot-mcp-${server.id}`}
            />
            {server.name}
            {#if server.autoApprove}
              <span class="text-xs text-muted-foreground">({t('contacts.mcpAutoApproveTag')})</span>
            {/if}
          </label>
        {/each}
      </div>
      <p class="text-xs text-muted-foreground">{t('contacts.mcpServersHint')}</p>
    </div>
  {/if}
</div>
