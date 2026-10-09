<script lang="ts">
  import type { McpServer } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import McpToolPolicies from './McpToolPolicies.svelte';

  /**
   * 「MCP 服务器」section（docs/design/23-mcp-and-subagent.md，D65）：server
   * 增删改、启用开关、免审批开关（带风险提示）、连接测试（列出工具名；列表
   * 里测已保存配置，表单里保存前测草稿、新填密钥仅随本次测试生效）、逐工具
   * 风险档与策略（W5，McpToolPolicies）。
   * 密钥只写不读：env / headers 的值输入后即落 secrets 表，settings 只存
   * `secret:env:<name>` / `secret:header:<name>` 占位符。
   */

  type Draft = McpServer & { secretDrafts: Record<string, string> };

  const servers = $derived(settingsStore.settings?.mcpServers ?? []);
  let editingId = $state<string | null>(null);
  let draft = $state<Draft | null>(null);
  let busy = $state(false);
  let testing = $state(false);
  let testTools = $state<string[] | null>(null);
  let testError = $state<string | null>(null);
  let draftTesting = $state(false);
  let draftTestTools = $state<string[] | null>(null);
  let draftTestError = $state<string | null>(null);
  let newKind = $state<'stdio' | 'http' | 'sse'>('stdio');
  /** W5：展开了逐工具策略的 server。 */
  let toolsOpen = $state<Record<string, boolean>>({});

  function emptyDraft(kind: 'stdio' | 'http' | 'sse'): Draft {
    const id = `mcp_${Date.now().toString(36)}`;
    return {
      id,
      name: '',
      transport: kind,
      ...(kind === 'stdio' ? { command: '', args: [] } : { url: '' }),
      enabled: true,
      autoApprove: false,
      secretDrafts: {},
    };
  }

  function envEntries(server: Draft): Array<{ name: string; value: string }> {
    return Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }));
  }

  function addEnvWithName(name: string, value = ''): void {
    if (draft === null || name.trim().length === 0) return;
    const key = name.trim();
    const env = { ...(draft.env ?? {}) };
    const exists = env[key] !== undefined;
    env[key] = `secret:env:${key}`;
    draft.env = env;
    // 已存密钥不回显：同名且填了新值 = 覆盖草稿值；留空 = 保持已存值。
    if (value.length > 0 || !exists) {
      draft.secretDrafts = { ...draft.secretDrafts, [key]: value };
    }
  }

  function removeEnv(name: string): void {
    if (draft === null) return;
    const env = { ...(draft.env ?? {}) };
    delete env[name];
    draft.env = Object.keys(env).length > 0 ? env : undefined;
    const drafts = { ...draft.secretDrafts };
    delete drafts[name];
    draft.secretDrafts = drafts;
    void settingsStore.removeMcpSecret(draft.id, 'env', name).catch(() => {});
  }

  function addHeader(name: string, value = ''): void {
    if (draft === null || name.trim().length === 0) return;
    const key = name.trim();
    const headers = { ...(draft.headers ?? {}) };
    const exists = headers[key] !== undefined;
    headers[key] = `secret:header:${key}`;
    draft.headers = headers;
    // 已存密钥不回显：同名且填了新值 = 覆盖草稿值；留空 = 保持已存值。
    if (value.length > 0 || !exists) {
      draft.secretDrafts = { ...draft.secretDrafts, [`h:${key}`]: value };
    }
  }

  let envDraftName = $state('');
  let envDraftValue = $state('');
  let headerDraftName = $state('');
  let headerDraftValue = $state('');

  function submitEnv(): void {
    addEnvWithName(envDraftName, envDraftValue);
    envDraftName = '';
    envDraftValue = '';
  }

  function submitHeader(): void {
    addHeader(headerDraftName, headerDraftValue);
    headerDraftName = '';
    headerDraftValue = '';
  }

  /** 测试/保存前把名称+值输入框里未回车的内容一并收进去：所见即所测。 */
  function flushPendingEntries(): void {
    submitEnv();
    submitHeader();
  }

  function removeHeader(name: string): void {
    if (draft === null) return;
    const headers = { ...(draft.headers ?? {}) };
    delete headers[name];
    draft.headers = Object.keys(headers).length > 0 ? headers : undefined;
    const drafts = { ...draft.secretDrafts };
    delete drafts[`h:${name}`];
    draft.secretDrafts = drafts;
    void settingsStore.removeMcpSecret(draft.id, 'header', name).catch(() => {});
  }

  function addServer(): void {
    draft = emptyDraft(newKind);
    editingId = null;
    testTools = null;
    testError = null;
    draftTestTools = null;
    draftTestError = null;
  }

  function editServer(server: McpServer): void {
    draft = { ...server, secretDrafts: {} };
    editingId = server.id;
    testTools = null;
    testError = null;
    draftTestTools = null;
    draftTestError = null;
  }

  function cancelEdit(): void {
    draft = null;
    editingId = null;
  }

  /** 落盘：先写新输入的密钥，再整体覆盖 mcpServers。 */
  async function save(): Promise<void> {
    if (draft === null) return;
    flushPendingEntries();
    if (draft.name.trim().length === 0) {
      toast.error(t('settings.mcpNameRequired'));
      return;
    }
    if (draft.transport === 'stdio' && (draft.command ?? '').trim().length === 0) {
      toast.error(t('settings.mcpCommandRequired'));
      return;
    }
    if (draft.transport !== 'stdio' && (draft.url ?? '').trim().length === 0) {
      toast.error(t('settings.mcpUrlRequired'));
      return;
    }
    busy = true;
    try {
      const serverId = draft.id;
      // 新输入的密钥值先落 secrets（env: 直接名；header: h: 前缀区分草稿键）。
      for (const [name, value] of Object.entries(draft.secretDrafts)) {
        if (value.length === 0) continue;
        if (name.startsWith('h:')) {
          await settingsStore.setMcpSecret(serverId, 'header', name.slice(2), value);
        } else {
          await settingsStore.setMcpSecret(serverId, 'env', name, value);
        }
      }
      const { secretDrafts: _ignored, ...server } = draft;
      void _ignored;
      const existing = settingsStore.settings?.mcpServers ?? [];
      const index = existing.findIndex((entry) => entry.id === serverId);
      // W5: the form does not edit per-tool policies — keep the live ones
      // (changed in the tool list while the form was open), not the snapshot.
      const merged = (
        index >= 0 ? { ...server, toolPolicies: existing[index]!.toolPolicies } : server
      ) as McpServer;
      if (merged.toolPolicies === undefined) delete merged.toolPolicies;
      const next =
        index >= 0
          ? existing.map((entry, i) => (i === index ? merged : entry))
          : [...existing, merged];
      await settingsStore.update({ mcpServers: next });
      toast.success(t('settings.saved'));
      draft = null;
      editingId = null;
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function toggleEnabled(server: McpServer, enabled: boolean): Promise<void> {
    await patchServer(server, { enabled });
  }

  async function toggleAutoApprove(server: McpServer, autoApprove: boolean): Promise<void> {
    await patchServer(server, { autoApprove });
  }

  async function patchServer(server: McpServer, patch: Partial<McpServer>): Promise<void> {
    busy = true;
    try {
      const existing = settingsStore.settings?.mcpServers ?? [];
      const next = existing.map((entry) =>
        entry.id === server.id ? { ...entry, ...patch } : entry,
      );
      await settingsStore.update({ mcpServers: next });
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function removeServer(server: McpServer): Promise<void> {
    busy = true;
    try {
      const existing = settingsStore.settings?.mcpServers ?? [];
      await settingsStore.update({
        mcpServers: existing.filter((entry) => entry.id !== server.id),
      });
      toast.success(t('settings.saved'));
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function test(server: McpServer): Promise<void> {
    testing = true;
    testTools = null;
    testError = null;
    try {
      const result = await settingsStore.testMcp(server);
      testTools = result.tools;
      if (result.missingSecrets.length > 0) {
        testError = t('settings.mcpMissingSecrets', { names: result.missingSecrets.join(', ') });
      }
    } catch (error) {
      testError = String((error as Error).message ?? error);
      toast.error(t('settings.testFailed', { reason: testError }));
    } finally {
      testing = false;
    }
  }

  /** 草稿里新输入、尚未落 secrets 表的密钥值：仅用于保存前的连接测试。 */
  function draftSecretValues(draft: Draft): {
    env: Record<string, string>;
    header: Record<string, string>;
  } {
    const env: Record<string, string> = {};
    const header: Record<string, string> = {};
    for (const [name, value] of Object.entries(draft.secretDrafts)) {
      if (value.length === 0) continue;
      if (name.startsWith('h:')) header[name.slice(2)] = value;
      else env[name] = value;
    }
    return { env, header };
  }

  /** 保存前测试草稿配置：新填密钥随本次测试带上，不落盘。 */
  async function testDraft(): Promise<void> {
    if (draft === null) return;
    flushPendingEntries();
    if (draft.name.trim().length === 0) {
      toast.error(t('settings.mcpNameRequired'));
      return;
    }
    if (draft.transport === 'stdio' && (draft.command ?? '').trim().length === 0) {
      toast.error(t('settings.mcpCommandRequired'));
      return;
    }
    if (draft.transport !== 'stdio' && (draft.url ?? '').trim().length === 0) {
      toast.error(t('settings.mcpUrlRequired'));
      return;
    }
    draftTesting = true;
    draftTestTools = null;
    draftTestError = null;
    try {
      const { secretDrafts: _ignored, ...server } = draft;
      void _ignored;
      const result = await settingsStore.testMcp(
        server as McpServer,
        draftSecretValues(draft),
      );
      draftTestTools = result.tools;
      if (result.missingSecrets.length > 0) {
        draftTestError = t('settings.mcpMissingSecrets', {
          names: result.missingSecrets.join(', '),
        });
      }
    } catch (error) {
      draftTestError = String((error as Error).message ?? error);
      toast.error(t('settings.testFailed', { reason: draftTestError }));
    } finally {
      draftTesting = false;
    }
  }
</script>

<section class="space-y-3" data-testid="mcp-section">
  <h3 class="text-sm font-medium">{t('settings.mcpTitle')}</h3>
  <p class="text-xs text-muted-foreground">{t('settings.mcpHint')}</p>

  {#each servers as server (server.id)}
    <div class="space-y-2 rounded-xl border px-4 py-3.5" data-testid={`mcp-server-${server.id}`}>
      <div class="flex flex-wrap items-center gap-2">
        <Badge>{server.name}</Badge>
        <Badge variant="outline"
          >{server.transport === 'stdio'
            ? server.command || 'stdio'
            : server.transport === 'sse'
              ? 'SSE'
              : 'HTTP'}</Badge
        >
        {#if !server.enabled}
          <Badge variant="outline">{t('settings.mcpDisabled')}</Badge>
        {/if}
        <div class="ml-auto flex items-center gap-3">
          <label class="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={server.enabled}
              onCheckedChange={(checked) => void toggleEnabled(server, checked === true)}
            />
            {t('settings.mcpEnabled')}
          </label>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1.5 text-xs" data-testid={`mcp-auto-${server.id}`}>
          <Checkbox
            checked={server.autoApprove}
            onCheckedChange={(checked) => void toggleAutoApprove(server, checked === true)}
          />
          {t('settings.mcpAutoApprove')}
        </label>
        {#if server.autoApprove}
          <span class="text-xs text-amber-600 dark:text-amber-400"
            >{t('settings.mcpAutoApproveWarn')}</span
          >
        {/if}
        <div class="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={testing}
            onclick={() => void test(server)}
          >
            {testing ? t('settings.testing') : t('settings.test')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (toolsOpen = { ...toolsOpen, [server.id]: !toolsOpen[server.id] })}
            data-testid={`mcp-tools-toggle-${server.id}`}
          >
            {toolsOpen[server.id] ? t('settings.mcpToolsHide') : t('settings.mcpTools')}
          </Button>
          <Button size="sm" variant="ghost" onclick={() => editServer(server)}>
            {t('settings.mcpEdit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="text-destructive hover:text-destructive"
            disabled={busy}
            onclick={() => void removeServer(server)}
          >
            {t('settings.mcpRemove')}
          </Button>
        </div>
      </div>
      {#if testTools !== null && testError === null}
        <p
          class="text-xs text-emerald-600 dark:text-emerald-400"
          data-testid={`mcp-tools-${server.id}`}
        >
          {t('settings.mcpToolsFound', { count: testTools.length })}: {testTools.join('、')}
        </p>
      {:else if testError !== null}
        <p class="text-xs text-destructive">{testError}</p>
      {/if}
      {#if toolsOpen[server.id]}
        <McpToolPolicies {server} />
      {/if}
    </div>
  {/each}

  {#if draft !== null}
    <div class="space-y-3 rounded-xl border px-4 py-3.5" data-testid="mcp-edit-form">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="mcp-name">{t('settings.mcpNameLabel')}</Label>
          <Input id="mcp-name" class="h-9" bind:value={draft.name} placeholder="filesystem" />
        </div>
        {#if editingId === null}
          <div class="grid gap-1.5">
            <Label for="mcp-transport">{t('settings.mcpTransportLabel')}</Label>
            <select
              id="mcp-transport"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              bind:value={draft.transport}
            >
              <option value="stdio">stdio</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE（旧版）</option>
            </select>
          </div>
        {/if}
      </div>

      {#if draft.transport === 'stdio'}
        <div class="grid gap-1.5">
          <Label for="mcp-command">{t('settings.mcpCommandLabel')}</Label>
          <Input id="mcp-command" class="h-9" bind:value={draft.command} placeholder="npx" />
        </div>
        <div class="grid gap-1.5">
          <Label for="mcp-args">{t('settings.mcpArgsLabel')}</Label>
          <Input
            id="mcp-args"
            class="h-9"
            value={(draft.args ?? []).join(' ')}
            oninput={(event) => {
              const text = event.currentTarget.value;
              draft!.args = text.length === 0 ? [] : text.split(' ');
            }}
            placeholder="-y @modelcontextprotocol/server-filesystem /path"
          />
        </div>
      {:else}
        <div class="grid gap-1.5">
          <Label for="mcp-url">{t('settings.mcpUrlLabel')}</Label>
          <Input
            id="mcp-url"
            class="h-9"
            bind:value={draft.url}
            placeholder={
              draft.transport === 'sse'
                ? 'https://mcp.example.com/sse'
                : 'https://mcp.example.com/mcp'
            }
          />
        </div>
      {/if}

      <p class="text-xs text-muted-foreground">{t('settings.mcpSecretHint')}</p>

      {#if draft.transport === 'stdio'}
        <div class="space-y-1.5">
          <Label>{t('settings.mcpEnvLabel')}</Label>
          {#each envEntries(draft) as entry (entry.name)}
            <div class="flex items-center gap-2">
              <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.name}</code>
              <Input
                class="h-8 flex-1"
                type="password"
                placeholder={t('settings.providerKeySet')}
                bind:value={draft.secretDrafts[entry.name]}
              />
              <Button size="sm" variant="ghost" onclick={() => removeEnv(entry.name)}>✕</Button>
            </div>
          {/each}
          <div class="flex items-center gap-2">
            <Input
              class="h-8 w-40 shrink-0"
              placeholder={t('settings.mcpAddEnvName')}
              bind:value={envDraftName}
              onkeydown={(event) => {
                if (event.key === 'Enter') submitEnv();
              }}
            />
            <Input
              class="h-8 flex-1"
              placeholder={t('settings.mcpAddEnvValue')}
              bind:value={envDraftValue}
              onkeydown={(event) => {
                if (event.key === 'Enter') submitEnv();
              }}
            />
          </div>
        </div>
      {:else}
        <div class="space-y-1.5">
          <Label>{t('settings.mcpHeadersLabel')}</Label>
          {#each Object.keys(draft.headers ?? {}) as name (name)}
            <div class="flex items-center gap-2">
              <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{name}</code>
              <Input
                class="h-8 flex-1"
                type="password"
                placeholder={t('settings.providerKeySet')}
                bind:value={draft.secretDrafts[`h:${name}`]}
              />
              <Button size="sm" variant="ghost" onclick={() => removeHeader(name)}>✕</Button>
            </div>
          {/each}
          <div class="flex items-center gap-2">
            <Input
              class="h-8 w-40 shrink-0"
              placeholder={t('settings.mcpAddHeaderName')}
              bind:value={headerDraftName}
              onkeydown={(event) => {
                if (event.key === 'Enter') submitHeader();
              }}
            />
            <Input
              class="h-8 flex-1"
              placeholder={t('settings.mcpAddHeaderValue')}
              bind:value={headerDraftValue}
              onkeydown={(event) => {
                if (event.key === 'Enter') submitHeader();
              }}
            />
          </div>
        </div>
      {/if}

      <div class="flex items-center gap-2">
        <Button size="sm" disabled={busy} onclick={() => void save()} data-testid="mcp-save">
          {t('settings.save')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={draftTesting}
          onclick={() => void testDraft()}
          data-testid="mcp-test-draft"
        >
          {draftTesting ? t('settings.testing') : t('settings.test')}
        </Button>
        <Button size="sm" variant="ghost" onclick={cancelEdit}>{t('settings.mcpCancel')}</Button>
      </div>

      {#if draftTestTools !== null && draftTestError === null}
        <p class="text-xs text-emerald-600 dark:text-emerald-400" data-testid="mcp-draft-test-ok">
          {t('settings.mcpToolsFound', { count: draftTestTools.length })}: {draftTestTools.join(
            '、',
          )}
        </p>
      {:else if draftTestError !== null}
        <p class="text-xs text-destructive" data-testid="mcp-draft-test-error">
          {draftTestError}
        </p>
      {/if}
    </div>
  {:else}
    <div class="flex items-center gap-2">
      <select
        class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={newKind}
        data-testid="mcp-new-kind"
      >
        <option value="stdio">stdio</option>
        <option value="http">Streamable HTTP</option>
        <option value="sse">SSE（旧版）</option>
      </select>
      <Button size="sm" onclick={addServer} data-testid="mcp-add">{t('settings.mcpAdd')}</Button>
    </div>
  {/if}
</section>
