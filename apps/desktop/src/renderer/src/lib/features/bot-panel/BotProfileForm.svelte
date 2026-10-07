<script lang="ts">
  /** Shared profile form fields for bot create (dialog) and edit (right panel). */
  import type { BotProfile } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import type { HostCapabilityId, HostCapabilityPrerequisite } from '@kepcup/shared';
  import type { MessageKey } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import {
    capabilityRows,
    engineValue,
    estimatedTools,
    normalizeCapabilities,
    parseEngineValue,
    toggleCapability,
    AGENT_OPTION_PREFIX,
  } from './agent-capabilities';

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

  // --- 外部智能体（D72 §3）：主模型选择器扩展为「模型 / 智能体」 -----------------
  /** 首次把 Bot 切到外部智能体时弹框说明让渡项（每台设备一次）。 */
  const SWITCH_ACK_KEY = 'kepcup.agentSwitchAcknowledged';

  $effect(() => {
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });

  const selectedAgentId = $derived(profile.runtime.agent.id);
  const selectedAgent = $derived(
    selectedAgentId.length > 0 ? agentsStore.get(selectedAgentId) : null,
  );
  /** 智能体组：实验开关打开时列已启用的 Agent；当前值不在其中时仍保留一项以便显示。 */
  const agentOptions = $derived.by(() => {
    const list = agentsStore.experimental ? agentsStore.selectable : [];
    const options = list.map((agent) => ({
      id: agent.id,
      label:
        agent.status === 'needs_auth'
          ? `${agent.name}（${t('contacts.agentNeedsAuthTag')}）`
          : agent.name,
    }));
    if (selectedAgentId.length > 0 && !options.some((option) => option.id === selectedAgentId)) {
      options.push({
        id: selectedAgentId,
        label: t('contacts.agentUnavailable', { id: selectedAgent?.name ?? selectedAgentId }),
      });
    }
    return options;
  });
  /** 没有任何内置模型时隐藏「轻量模型」（后台任务另行处理，§3）。 */
  const showLightModel = $derived(
    settingsStore.availableModelOptions.length > 0 || profile.runtime.light_model.length > 0,
  );

  let pendingAgentId = $state<string | null>(null);
  let switchDialogOpen = $state(false);
  let engineSelect = $state<HTMLSelectElement | undefined>();

  function acknowledged(): boolean {
    try {
      return localStorage.getItem(SWITCH_ACK_KEY) === '1';
    } catch {
      return false;
    }
  }

  function applyAgent(agentId: string): void {
    const sameAgent = profile.runtime.agent.id === agentId;
    const agent = agentsStore.get(agentId);
    profile.runtime.agent = {
      ...profile.runtime.agent,
      id: agentId,
      ...(sameAgent ? {} : { model: '', effort: '', capabilities: null }),
      // 预览档 Agent 默认更严（§6）。
      ...(sameAgent
        ? {}
        : { permission: agent?.tier === 'preview' ? ('ask' as const) : ('workspace' as const) }),
    };
  }

  function onEngineChange(value: string): void {
    const parsed = parseEngineValue(value);
    if ('model' in parsed) {
      profile.runtime.agent = { ...profile.runtime.agent, id: '' };
      profile.runtime.model = parsed.model;
      return;
    }
    if (parsed.agentId === profile.runtime.agent.id) return;
    if (!acknowledged()) {
      pendingAgentId = parsed.agentId;
      switchDialogOpen = true;
      // Keep showing the current engine until the notice is confirmed.
      if (engineSelect !== undefined) engineSelect.value = engineValue(profile.runtime);
      return;
    }
    applyAgent(parsed.agentId);
  }

  function confirmSwitch(): void {
    try {
      localStorage.setItem(SWITCH_ACK_KEY, '1');
    } catch {
      // Not persisted: the notice shows again next time.
    }
    if (pendingAgentId !== null) applyAgent(pendingAgentId);
    pendingAgentId = null;
    switchDialogOpen = false;
  }

  // Model / effort choices come from the agent's session config options (cached).
  $effect(() => {
    const id = selectedAgentId;
    if (id.length === 0 || agentsStore.options[id] !== undefined) return;
    void agentsStore.loadOptions(id).catch(() => undefined);
  });
  const agentChoices = $derived(
    selectedAgentId.length > 0 ? agentsStore.options[selectedAgentId] : undefined,
  );

  function prerequisiteReady(prerequisite: HostCapabilityPrerequisite): boolean {
    if (prerequisite.kind === 'web-search') {
      return (settingsStore.settings?.webSearch.provider ?? null) !== null;
    }
    return settingsStore.isCapabilityReady(prerequisite.capability);
  }

  const capabilityContext = $derived({
    nativeCapabilities: selectedAgent?.nativeCapabilities ?? {},
    prerequisiteReady,
  });
  /**
   * 能力包默认值取决于该 Agent 的原生能力声明：目录视图未加载前不允许勾选，
   * 免得按空声明算出的默认值被存成显式数组。
   */
  const capabilitiesReady = $derived(agentsStore.loaded && selectedAgent !== null);
  const capabilityList = $derived(
    capabilityRows(profile.runtime.agent.capabilities, capabilityContext),
  );
  const toolEstimate = $derived(estimatedTools(capabilityList));

  function toggleAgentCapability(id: HostCapabilityId, checked: boolean): void {
    const next = toggleCapability(
      profile.runtime.agent.capabilities,
      id,
      checked,
      capabilityContext,
    );
    profile.runtime.agent.capabilities = normalizeCapabilities(next, capabilityContext);
  }

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
      <Label for="bot-model"
        >{agentOptions.length > 0 ? t('contacts.mainModelOrAgent') : t('contacts.mainModel')}</Label
      >
      <select
        id="bot-model"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:this={engineSelect}
        value={engineValue(profile.runtime)}
        onchange={(event) => onEngineChange(event.currentTarget.value)}
        data-testid="bot-model-select"
      >
        <option value="">—</option>
        {#if agentOptions.length > 0}
          <optgroup label={t('contacts.engineGroupModels')}>
            {#each modelOptions as option (option.ref)}
              <option value={option.ref}>{option.label}</option>
            {/each}
          </optgroup>
          <optgroup label={t('contacts.engineGroupAgents')}>
            {#each agentOptions as option (option.id)}
              <option value={`${AGENT_OPTION_PREFIX}${option.id}`}>{option.label}</option>
            {/each}
          </optgroup>
        {:else}
          {#each modelOptions as option (option.ref)}
            <option value={option.ref}>{option.label}</option>
          {/each}
        {/if}
      </select>
    </div>
    {#if showLightModel}
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
    {/if}
  </div>
  {#if selectedAgentId.length > 0}
    <div class="space-y-3 rounded-lg border px-3 py-3" data-testid="bot-agent-settings">
      <p class="text-xs text-muted-foreground">{t('contacts.agentIsolationNote')}</p>
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="grid gap-1.5">
          <Label for="bot-agent-model">{t('contacts.agentModel')}</Label>
          <select
            id="bot-agent-model"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={profile.runtime.agent.model}
            data-testid="bot-agent-model"
          >
            <option value="">{t('contacts.agentDefault')}</option>
            {#each agentChoices?.models ?? [] as choice (choice.value)}
              <option value={choice.value}>{choice.name}</option>
            {/each}
            {#if profile.runtime.agent.model.length > 0 && !(agentChoices?.models ?? []).some((choice) => choice.value === profile.runtime.agent.model)}
              <option value={profile.runtime.agent.model}>{profile.runtime.agent.model}</option>
            {/if}
          </select>
        </div>
        <div class="grid gap-1.5">
          <Label for="bot-agent-effort">{t('contacts.agentEffort')}</Label>
          <select
            id="bot-agent-effort"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={profile.runtime.agent.effort}
          >
            <option value="">{t('contacts.agentDefault')}</option>
            {#each agentChoices?.efforts ?? [] as choice (choice.value)}
              <option value={choice.value}>{choice.name}</option>
            {/each}
            {#if profile.runtime.agent.effort.length > 0 && !(agentChoices?.efforts ?? []).some((choice) => choice.value === profile.runtime.agent.effort)}
              <option value={profile.runtime.agent.effort}>{profile.runtime.agent.effort}</option>
            {/if}
          </select>
        </div>
        <div class="grid gap-1.5">
          <Label for="bot-agent-permission">{t('contacts.agentPermission')}</Label>
          <select
            id="bot-agent-permission"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={profile.runtime.agent.permission}
            data-testid="bot-agent-permission"
          >
            <option value="read_only">{t('contacts.agentPermissionReadOnly')}</option>
            <option value="workspace">{t('contacts.agentPermissionWorkspace')}</option>
            <option value="ask">{t('contacts.agentPermissionAsk')}</option>
          </select>
        </div>
      </div>
      {#if agentChoices?.error}
        <p class="text-xs text-destructive">
          {t('contacts.agentOptionsError', { error: agentChoices.error })}
        </p>
      {/if}
      <Button
        size="sm"
        variant="ghost"
        class="h-7 px-2 text-xs"
        onclick={() => void agentsStore.loadOptions(selectedAgentId, true).catch(() => undefined)}
      >
        {t('contacts.agentOptionsRefresh')}
      </Button>

      <div class="grid gap-1.5">
        <div class="flex items-center gap-2">
          <Label>{t('contacts.agentCapabilities')}</Label>
          <Button
            size="sm"
            variant="ghost"
            class="ml-auto h-7 px-2 text-xs"
            disabled={profile.runtime.agent.capabilities === null || !capabilitiesReady}
            onclick={() => (profile.runtime.agent.capabilities = null)}
            data-testid="bot-agent-capabilities-reset"
          >
            {t('contacts.agentCapabilitiesReset')}
          </Button>
        </div>
        <div class="space-y-1.5" data-testid="bot-agent-capabilities">
          {#each capabilityList as row (row.id)}
            <label class="flex items-start gap-2 text-sm" class:opacity-60={row.required}>
              <Checkbox
                checked={row.checked}
                disabled={row.required || !capabilitiesReady}
                onCheckedChange={(checked) => toggleAgentCapability(row.id, checked === true)}
                data-testid={`bot-agent-capability-${row.id}`}
              />
              <span class="space-y-0.5">
                <span class="flex flex-wrap items-center gap-1.5">
                  {t(`agents.capabilities.${row.id}.name` as MessageKey)}
                  {#if row.required}
                    <span class="text-xs text-muted-foreground"
                      >（{t('contacts.agentCapabilityRequired')}）</span
                    >
                  {/if}
                  {#if row.unconfigured}
                    <span class="text-xs text-amber-600 dark:text-amber-400"
                      >（{t('contacts.agentCapabilityUnconfigured')}）</span
                    >
                  {/if}
                </span>
                <span class="block text-xs text-muted-foreground"
                  >{t(`agents.capabilities.${row.id}.description` as MessageKey)}</span
                >
                {#if row.nativeTools.length > 0}
                  <span class="block text-xs text-muted-foreground"
                    >{t('contacts.agentCapabilityNative')}（{row.nativeTools.join('、')}）</span
                  >
                {/if}
              </span>
            </label>
          {/each}
        </div>
        <p class="text-xs text-muted-foreground" data-testid="bot-agent-tool-count">
          {toolEstimate.mcp && profile.runtime.mcp_server_ids.length > 0
            ? t('contacts.agentToolCountMcp', { count: toolEstimate.count })
            : t('contacts.agentToolCount', { count: toolEstimate.count })}
        </p>
        <p class="text-xs text-muted-foreground">{t('contacts.agentCapabilitiesHint')}</p>
      </div>
    </div>
  {/if}
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

<Dialog bind:open={switchDialogOpen}>
  <DialogContent data-testid="bot-agent-switch-dialog">
    <DialogHeader>
      <DialogTitle>
        {t('contacts.agentSwitchTitle', {
          name: (pendingAgentId !== null ? agentsStore.get(pendingAgentId)?.name : null) ?? '',
        })}
      </DialogTitle>
      <DialogDescription>{t('contacts.agentSwitchIntro')}</DialogDescription>
    </DialogHeader>
    <ul class="list-disc space-y-1 pl-5 text-sm">
      <li>{t('contacts.agentSwitchTools')}</li>
      <li>{t('contacts.agentSwitchPrompt')}</li>
      <li>{t('contacts.agentSwitchFeatures')}</li>
      <li>{t('contacts.agentSwitchHistory')}</li>
      <li>{t('contacts.agentSwitchReads')}</li>
    </ul>
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => {
          pendingAgentId = null;
          switchDialogOpen = false;
        }}>{t('contacts.agentSwitchCancel')}</Button
      >
      <Button onclick={confirmSwitch} data-testid="bot-agent-switch-confirm"
        >{t('contacts.agentSwitchConfirm')}</Button
      >
    </DialogFooter>
  </DialogContent>
</Dialog>
