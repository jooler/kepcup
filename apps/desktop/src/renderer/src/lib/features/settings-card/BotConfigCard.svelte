<script lang="ts">
  import { interpretAppConnectionSelection, type Bot, type SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { isCatalogConnection } from '$lib/features/bot-panel/bot-apps';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import { applySettingItem } from './apply';
  import { prefillString } from './setting-card-model';

  /**
   * Bot 配置片段卡（浏览器资料、网络策略、MCP、连接、任务引擎）。选项与
   * `BotProfileForm` 同一批 store；保存经 `settings.items.apply` 做条目级 CAS，
   * core 落到同一个 `bots.update`。右栏整表保存不用它。
   *
   * user-only（放开网络、放宽任务引擎权限）不接收 Bot 的预填，从当前配置起由用户改。
   */
  let {
    itemId,
    botId,
    prefill = null,
    expected = null,
    messageId,
    testid = 'setting-card-bot-config',
    onSaved,
    onConflict,
  }: {
    itemId: string;
    botId: string;
    prefill?: SettingValues | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    testid?: string;
    onSaved?: (values: SettingValues) => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  const session = getChatSession();
  const bot = $derived.by((): Bot | null => {
    const current = session.view;
    return (
      contacts.bots.find((entry) => entry.id === botId) ??
      current?.members.find((member) => member.bot.id === botId)?.bot ??
      (current?.conversation.bot?.id === botId ? current.conversation.bot : null) ??
      null
    );
  });

  const runtime = $derived(bot?.profile.runtime ?? null);
  const seeded = untrack(() => prefill);

  // 空串有意义：浏览器资料 '' = 私有资料，任务引擎 '' = 内置引擎。不能用 prefillString
  // （它把空串当成缺省，会退回当前值，应用时就把 Bot 的建议写丢）。
  let profile = $state(
    untrack(() =>
      typeof seeded?.profile === 'string' ? seeded.profile : (runtime?.browser_profile ?? ''),
    ),
  );
  let policy = $state(
    untrack(() => {
      const wanted = prefillString(seeded, 'policy');
      if (wanted === 'none' || wanted === 'allowlist' || wanted === 'open') return wanted;
      return runtime?.network_policy ?? 'none';
    }),
  );
  let allowlist = $state(
    untrack(() => {
      const wanted = seeded?.allowlist;
      if (Array.isArray(wanted))
        return wanted.filter((entry) => typeof entry === 'string').join('\n');
      return (runtime?.network_allowlist ?? []).join('\n');
    }),
  );
  let servers = $state<string[]>(
    untrack(() => {
      const wanted = seeded?.servers;
      if (Array.isArray(wanted))
        return wanted.filter((entry): entry is string => typeof entry === 'string');
      return [...(runtime?.mcp_server_ids ?? [])];
    }),
  );
  let connections = $state<string[]>(
    untrack(() => {
      const wanted = seeded?.connections;
      if (Array.isArray(wanted)) {
        return wanted.filter((entry): entry is string => typeof entry === 'string');
      }
      return [...(runtime?.app_connection_ids ?? [])];
    }),
  );
  let connectionPrefillApplied = false;
  /** 预填 engine='agent' 时 Agent id 取当前值（预填只带引擎不带 id 的形态）。 */
  function agentIdOfEnginePrefill(wanted: unknown, currentId: string): string {
    if (wanted === 'agent') return engineValueOf(currentId) === 'agent' ? currentId : '';
    return '';
  }

  // 任务执行引擎三态（2026-11 修订，与目录 bot.agent 的 engine 字段同编码）：
  // 'default' = 跟随应用默认；'builtin' = 显式内置；'agent' = 外部智能体
  // （agentId 指明哪个）。`runtime.agent.id` 的 '' / 'builtin' / 目录 id 一一对应。
  const engineValueOf = (id: string): 'default' | 'builtin' | 'agent' =>
    id === '' ? 'default' : id === 'builtin' ? 'builtin' : 'agent';
  const agentIdOf = (id: string): string => (engineValueOf(id) === 'agent' ? id : '');
  let agentId = $state(
    untrack(() => {
      if (typeof seeded?.agent === 'string' && seeded.agent.length > 0) return seeded.agent;
      return agentIdOf(runtime?.agent.id ?? '');
    }),
  );
  let engine = $state<'default' | 'builtin' | 'agent'>(
    untrack(() => {
      const wanted = seeded?.engine;
      if (wanted === 'default' || wanted === 'builtin' || wanted === 'agent') return wanted;
      return engineValueOf(runtime?.agent.id ?? '');
    }),
  );
  let agentModel = $state(
    untrack(() =>
      typeof seeded?.model === 'string' ? seeded.model : (runtime?.agent.model ?? ''),
    ),
  );
  let permission = $state(
    untrack(() => {
      const wanted = prefillString(seeded, 'permission');
      if (wanted === 'read_only' || wanted === 'ask' || wanted === 'workspace') return wanted;
      return runtime?.agent.permission ?? 'workspace';
    }),
  );
  let busy = $state(false);
  let synced = false;

  // Bot 快照可能晚于卡片挂载才到。预填里有的字段（含空串）保持不动，缺的字段到了再抄当前值，只抄一次。
  $effect(() => {
    const current = runtime;
    if (current === null || synced) return;
    synced = true;
    if (typeof seeded?.profile !== 'string') profile = current.browser_profile;
    const wantedPolicy = prefillString(seeded, 'policy');
    if (wantedPolicy !== 'none' && wantedPolicy !== 'allowlist' && wantedPolicy !== 'open') {
      policy = current.network_policy;
    }
    if (!Array.isArray(seeded?.allowlist)) allowlist = current.network_allowlist.join('\n');
    if (!Array.isArray(seeded?.servers)) servers = [...current.mcp_server_ids];
    if (!Array.isArray(seeded?.connections)) connections = [...current.app_connection_ids];
    if (typeof seeded?.engine !== 'string') {
      engine = engineValueOf(current.agent.id);
      agentId = agentIdOf(current.agent.id);
    } else {
      agentId = agentIdOfEnginePrefill(seeded.engine, current.agent.id);
    }
    if (typeof seeded?.model !== 'string') agentModel = current.agent.model;
    const wantedPermission = prefillString(seeded, 'permission');
    if (
      wantedPermission !== 'read_only' &&
      wantedPermission !== 'ask' &&
      wantedPermission !== 'workspace'
    ) {
      permission = current.agent.permission;
    }
  });

  // 模型常把应用 slug（如 cloudflare）写进预填。连接列表到了之后解析成连接 id 并勾上，
  // 同时保留这个 Bot 已经有的授权。只处理一次，避免用户随后取消勾选被写回去。
  $effect(() => {
    if (itemId !== 'bot.apps' || connectionPrefillApplied) return;
    const wanted = seeded?.connections;
    const known = appsStore.connections.filter(isCatalogConnection);
    if (!Array.isArray(wanted) || known.length === 0 || runtime === null) return;
    const refs = wanted.filter((entry): entry is string => typeof entry === 'string');
    const interpreted = interpretAppConnectionSelection(runtime.app_connection_ids, refs, known);
    connectionPrefillApplied = true;
    if (!interpreted.ok) {
      if (interpreted.reason === 'ambiguous') {
        const ids = new Set(known.map((row) => row.id));
        connections = runtime.app_connection_ids.filter((id) => ids.has(id));
      }
      return;
    }
    connections = interpreted.ids;
  });

  // 外部智能体的模型 / 推理强度来自它自己的会话选项，按需探测并缓存。
  $effect(() => {
    if (itemId !== 'bot.agent') return;
    if (engine !== 'agent' || agentId.length === 0) return;
    if (agentsStore.options[agentId] !== undefined) return;
    void agentsStore.loadOptions(agentId).catch(() => undefined);
  });

  $effect(() => {
    if (itemId !== 'bot.agent' && itemId !== 'bot.apps' && itemId !== 'bot.mcp-servers') return;
    if (itemId === 'bot.agent') {
      agentsStore.start();
      if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
    }
    if (itemId === 'bot.apps') {
      appsStore.start();
      if (!appsStore.catalogLoaded) void appsStore.refresh().catch(() => undefined);
    }
  });

  const browserProfiles = $derived(settingsStore.settings?.browserProfiles ?? []);
  // D105 P2：插件贡献的 server 由插件启用集接管（勾选读时被忽略）——设置卡只列
  // 手动 / mcpb 独立安装的 server，与 Bot「插件」区块的手动工具服务同源。
  const mcpOptions = $derived(
    (settingsStore.settings?.mcpServers ?? []).filter(
      (server) => server.enabled !== false && server.source?.kind !== 'plugin',
    ),
  );
  const agentOptions = $derived(agentsStore.selectable);
  const agentChoices = $derived(
    itemId === 'bot.agent' && agentId.length > 0 ? agentsStore.options[agentId] : undefined,
  );
  /** 应用默认任务执行引擎的显示名（「跟随应用默认」选项的副标签）。 */
  const defaultEngineLabel = $derived.by(() => {
    const id = settingsStore.settings?.defaultTaskAgentId ?? '';
    if (id.length === 0) return t('contacts.taskEngineBuiltin');
    return agentsStore.get(id)?.name ?? id;
  });

  function changeEngine(value: 'default' | 'builtin' | 'agent'): void {
    engine = value;
    agentId = '';
    // 设置页里给该智能体配的默认模型：切过来时直接带上（留空 = 智能体默认）；
    // 跟随默认 / 内置引擎不携带模型。
    agentModel = '';
  }

  /** 引擎下拉选中某个外部智能体。 */
  function chooseAgent(id: string): void {
    engine = 'agent';
    agentId = id;
    agentModel = agentsStore.get(id)?.defaultModel ?? '';
  }

  function toggle(list: string[], id: string, on: boolean): string[] {
    return on ? (list.includes(id) ? list : [...list, id]) : list.filter((entry) => entry !== id);
  }

  function collected(): SettingValues {
    switch (itemId) {
      case 'bot.browser-profile':
        return { profile };
      case 'bot.network':
        // 白名单输入框只在「白名单」策略下可见：别的策略不提交域名（core 也不会存看不见的域名）。
        return policy === 'allowlist'
          ? {
              policy,
              allowlist: allowlist
                .split(/[\n,]/)
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            }
          : { policy };
      case 'bot.mcp-servers':
        return { servers };
      case 'bot.apps':
        return { connections };
      case 'bot.agent': {
        // 没有可选外部智能体时 'agent' 状态不成立：按跟随应用默认提交。
        if (engine === 'agent' && agentId.length > 0) {
          return { engine, agent: agentId, model: agentModel, permission };
        }
        // builtin 不带 model：core 适配器保留该 Bot 已有的内置任务模型。
        return engine === 'builtin' ? { engine } : { engine: 'default' };
      }
      default:
        return {};
    }
  }

  async function apply(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const out = await applySettingItem({
        itemId,
        values: collected(),
        expected,
        target: { botId },
        messageId,
      });
      if (out.status === 'conflict') {
        onConflict?.(out.current);
        return;
      }
      toast.success(t('settingCard.appliedToast'));
      onSaved?.(out.values);
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
</script>

<div class="grid gap-2" data-testid={testid}>
  {#if bot !== null}
    <p class="text-xs text-muted-foreground">{bot.name}</p>
  {/if}

  {#if itemId === 'bot.browser-profile'}
    <Label for={`${testid}-profile`}>{t('contacts.browserProfile')}</Label>
    <select
      id={`${testid}-profile`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={profile}
      data-testid={`${testid}-profile`}
    >
      <option value="">{t('contacts.browserProfilePrivate')}</option>
      {#each browserProfiles as entry (entry.id)}
        <option value={entry.id}>{t('contacts.browserProfileShared', { name: entry.name })}</option>
      {/each}
    </select>
    <p class="text-xs text-muted-foreground">{t('contacts.browserProfileHint')}</p>
  {:else if itemId === 'bot.network'}
    <Label for={`${testid}-policy`}>{t('contacts.networkPolicy')}</Label>
    <select
      id={`${testid}-policy`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={policy}
      data-testid={`${testid}-policy`}
    >
      <option value="none">{t('contacts.networkPolicyNone')}</option>
      <option value="allowlist">{t('contacts.networkPolicyAllowlist')}</option>
      <option value="open">{t('contacts.networkPolicyOpen')}</option>
    </select>
    {#if policy === 'allowlist'}
      <Label for={`${testid}-allowlist`}>{t('contacts.networkAllowlist')}</Label>
      <Textarea
        id={`${testid}-allowlist`}
        rows={2}
        bind:value={allowlist}
        placeholder={t('contacts.networkAllowlistHint')}
        data-testid={`${testid}-allowlist`}
      />
    {/if}
  {:else if itemId === 'bot.mcp-servers'}
    <Label>{t('botPanel.plugins.manualServers')}</Label>
    {#if mcpOptions.length === 0}
      <p class="text-xs text-muted-foreground">{t('settingCard.botConfig.noMcp')}</p>
    {:else}
      <div class="space-y-1.5">
        {#each mcpOptions as server (server.id)}
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={servers.includes(server.id)}
              onCheckedChange={(checked) =>
                (servers = toggle(servers, server.id, checked === true))}
              data-testid={`${testid}-mcp-${server.id}`}
            />
            {server.name}
          </label>
        {/each}
      </div>
    {/if}
  {:else if itemId === 'bot.apps'}
    <Label>{t('contacts.apps')}</Label>
    {#if appsStore.connections.length === 0}
      <p class="text-xs text-muted-foreground">{t('settingCard.botConfig.noApps')}</p>
    {:else}
      <div class="space-y-1.5">
        {#each appsStore.connections as connection (connection.id)}
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={connections.includes(connection.id)}
              onCheckedChange={(checked) =>
                (connections = toggle(connections, connection.id, checked === true))}
              data-testid={`${testid}-app-${connection.id}`}
            />
            <span class="min-w-0 truncate">{connection.label}</span>
          </label>
        {/each}
      </div>
    {/if}
  {:else if itemId === 'bot.agent'}
    <Label for={`${testid}-agent`}>{t('contacts.taskEngine')}</Label>
    <select
      id={`${testid}-agent`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      value={engine === 'agent' ? `@agent:${agentId}` : engine}
      onchange={(event) => {
        const value = event.currentTarget.value;
        if (value === 'default' || value === 'builtin') changeEngine(value);
        else if (value.startsWith('@agent:')) chooseAgent(value.slice('@agent:'.length));
      }}
      data-testid={`${testid}-agent`}
    >
      <option value="default">
        {t('contacts.taskEngineFollowDefault', {
          engine: defaultEngineLabel,
        })}
      </option>
      <option value="builtin">{t('contacts.taskEngineBuiltin')}</option>
      {#each agentOptions as option (option.id)}
        <option value={`@agent:${option.id}`}>{option.name}</option>
      {/each}
      {#if engine === 'agent' && agentId.length > 0 && !agentOptions.some((option) => option.id === agentId)}
        <option value={`@agent:${agentId}`}>
          {t('contacts.agentUnavailable', { id: agentsStore.get(agentId)?.name ?? agentId })}
        </option>
      {/if}
    </select>
    {#if engine === 'agent' && agentId.length === 0}
      <p class="text-xs text-muted-foreground">{t('settingCard.botConfig.noAgents')}</p>
    {/if}
    {#if engine === 'agent' && agentId.length > 0}
      <Label for={`${testid}-permission`}>{t('contacts.agentPermission')}</Label>
      <select
        id={`${testid}-permission`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={permission}
        data-testid={`${testid}-permission`}
      >
        <option value="read_only">{t('contacts.agentPermissionReadOnly')}</option>
        <option value="ask">{t('contacts.agentPermissionAsk')}</option>
        <option value="workspace">{t('contacts.agentPermissionWorkspace')}</option>
      </select>
      <Label for={`${testid}-model`}>{t('contacts.agentModel')}</Label>
      <input
        id={`${testid}-model`}
        list={`${testid}-model-options`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={agentModel}
        placeholder={t('contacts.agentDefault')}
        data-testid={`${testid}-model`}
      />
      <datalist id={`${testid}-model-options`}>
        {#each agentChoices?.models ?? [] as choice (choice.value)}
          <option value={choice.value}
            >{choice.name}{choice.description.length > 0
              ? t('common.parenthesized', { text: choice.description })
              : ''}</option
          >
        {/each}
      </datalist>
      <div class="flex items-center gap-2">
        <p class="text-xs text-muted-foreground">{t('contacts.agentModelFreeHint')}</p>
        <Button
          size="sm"
          variant="ghost"
          class="ml-auto h-6 px-2 text-xs"
          disabled={agentId.length === 0}
          onclick={() => void agentsStore.loadOptions(agentId, true).catch(() => undefined)}
          data-testid={`${testid}-model-refresh`}
        >
          {t('contacts.agentOptionsRefresh')}
        </Button>
      </div>
      {#if agentChoices?.error}
        <p class="text-xs text-destructive">
          {t('contacts.agentOptionsError', { error: agentChoices.error })}
        </p>
      {/if}
    {/if}
  {/if}

  <div class="flex justify-end">
    <Button size="sm" disabled={busy} onclick={() => void apply()} data-testid={`${testid}-apply`}>
      {t('settingCard.apply')}
    </Button>
  </div>
</div>
