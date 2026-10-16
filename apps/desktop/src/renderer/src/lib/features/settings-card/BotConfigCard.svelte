<script lang="ts">
  import { interpretAppConnectionSelection, type Bot, type SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
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

  const bot = $derived.by((): Bot | null => {
    const current = chat.current;
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
  let agentId = $state(
    untrack(() => (typeof seeded?.agent === 'string' ? seeded.agent : (runtime?.agent.id ?? ''))),
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
    if (typeof seeded?.agent !== 'string') agentId = current.agent.id;
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
  const mcpOptions = $derived(
    (settingsStore.settings?.mcpServers ?? []).filter((server) => server.enabled !== false),
  );
  const agentOptions = $derived.by(() => {
    const list = agentsStore.experimental ? agentsStore.selectable : [];
    return list;
  });

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
      case 'bot.agent':
        return { agent: agentId, model: agentModel, permission };
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
    <Label>{t('contacts.mcpServers')}</Label>
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
    <Label for={`${testid}-agent`}>{t('contacts.agentTaskEngineHint')}</Label>
    <select
      id={`${testid}-agent`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={agentId}
      data-testid={`${testid}-agent`}
    >
      <option value="">{t('settingCard.botConfig.builtinEngine')}</option>
      {#each agentOptions as option (option.id)}
        <option value={option.id}>{option.name}</option>
      {/each}
    </select>
    {#if agentId.length > 0}
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
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={agentModel}
        placeholder={t('contacts.agentDefault')}
        data-testid={`${testid}-model`}
      />
    {/if}
  {/if}

  <div class="flex justify-end">
    <Button size="sm" disabled={busy} onclick={() => void apply()} data-testid={`${testid}-apply`}>
      {t('settingCard.apply')}
    </Button>
  </div>
</div>
