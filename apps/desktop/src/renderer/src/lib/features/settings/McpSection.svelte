<script lang="ts">
  import type { McpServer, McpToolRisk } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { appDetailStore } from '$lib/stores/app-detail.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import ConnectAppPanel from '$lib/features/apps/ConnectAppPanel.svelte';
  import { customConnectionId } from '$lib/features/apps/connect-flow';
  import McpRiskBadge from '../approvals/McpRiskBadge.svelte';
  import McpToolPolicies from './McpToolPolicies.svelte';
  import McpbInstall from './McpbInstall.svelte';
  import McpDevTools from './McpDevTools.svelte';
  import OAuthClientsPanel from './OAuthClientsPanel.svelte';

  /**
   * 「MCP 服务器」section（docs/design/23-mcp-and-subagent.md，D65）：server
   * 增删改、启用开关、免审批开关（带风险提示）、连接测试（列出工具名；列表
   * 里测已保存配置，表单里保存前测草稿、新填密钥仅随本次测试生效）、逐工具
   * 风险档与策略（W5，McpToolPolicies）。
   * 密钥只写不读：env / headers 的值输入后即落 secrets 表，settings 只存
   * `secret:env:<name>` / `secret:header:<name>` 占位符。
   * D73：Streamable HTTP server 可选认证方式「无 / Header / OAuth」；OAuth 的
   * 连接状态与「连接 / 重新连接 / 断开」由 ConnectAppPanel 呈现（与对话内连接卡
   * 共用）；删除 server 走 `mcp.removeServer`（连同密钥、令牌、连接行一并清理）。
   * D73 P1（§5.5 工具锁定）：「测试」成功后列出工具（带风险档），「批准」/「保存并批准」
   * 把测试时看到的定义哈希交给 `apps.tools.approveAfterTest`；批准前工具不暴露给
   * Bot，行上显示待批准数（`apps.connections.tools`，连接 id `custom:{serverId}`）。
   */

  type Draft = McpServer & { secretDrafts: Record<string, string> };

  const servers = $derived(settingsStore.settings?.mcpServers ?? []);
  let editingId = $state<string | null>(null);
  let draft = $state<Draft | null>(null);
  let busy = $state(false);
  let testing = $state(false);
  /** 列表里最近一次「测试」属于哪个 server（结果只显示在它的行上）。 */
  let testServerId = $state<string | null>(null);
  let testTools = $state<string[] | null>(null);
  let testError = $state<string | null>(null);
  /** 测试时看到的工具定义哈希（`mcp.test` 的 `toolHashes`），供「批准」提交。 */
  let testHashes = $state<Record<string, string> | null>(null);
  let draftTesting = $state(false);
  let draftTestTools = $state<string[] | null>(null);
  let draftTestError = $state<string | null>(null);
  let draftTestHashes = $state<Record<string, string> | null>(null);
  let approving = $state(false);
  let newKind = $state<'stdio' | 'http' | 'sse'>('stdio');
  /** W5：展开了逐工具策略的 server。 */
  let toolsOpen = $state<Record<string, boolean>>({});
  /** D73 P2 §6.6：开发者模式（原始工具定义 / 授权事件日志 / 手动刷新工具）。 */
  const developerMode = $derived(settingsStore.developerMode);
  let devModeBusy = $state(false);

  async function toggleDeveloperMode(on: boolean): Promise<void> {
    devModeBusy = true;
    try {
      await settingsStore.setDeveloperMode(on);
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      devModeBusy = false;
    }
  }

  $effect(() => {
    appsStore.start();
    appDetailStore.start();
  });

  // 待批准数：只对 core 已登记连接行的 server 读清单（没有行 = 从未列过工具，读清单会
  // 触发一次连接，留到用户点「测试」时再做）。正在拉的跳过，免得连接列表刷新时并发重复
  // 请求；loadingTools 不追踪——否则失败（缓存仍空）→ 清 loading → 重跑 → 再拉，会循环。
  $effect(() => {
    const known = new Set(appsStore.connections.map((connection) => connection.id));
    for (const server of servers) {
      const id = customConnectionId(server.id);
      if (
        !known.has(id) ||
        appDetailStore.toolsFor(id) !== null ||
        untrack(() => appDetailStore.loadingTools[id] === true)
      ) {
        continue;
      }
      void appDetailStore.loadTools(id).catch(() => undefined);
    }
  });

  function riskOf(serverId: string, toolName: string): McpToolRisk | null {
    const view = appDetailStore.toolsFor(customConnectionId(serverId));
    return view?.tools.find((tool) => tool.toolName === toolName)?.risk ?? null;
  }

  /** 把测试时看到的工具定义交给 core 批准（§5.5）；返回是否有工具被批准。 */
  async function approveTested(serverId: string, hashes: Record<string, string>): Promise<boolean> {
    approving = true;
    try {
      const { approved } = await appDetailStore.approveAfterTest(serverId, hashes);
      if (approved.length > 0) {
        toast.success(t('settings.mcpToolsApproved', { count: approved.length }));
      } else {
        toast.error(t('settings.mcpToolsApproveNone'));
      }
      return approved.length > 0;
    } catch (error) {
      toast.error(
        t('settings.mcpToolsApproveFailed', { reason: String((error as Error).message ?? error) }),
      );
      return false;
    } finally {
      approving = false;
    }
  }

  function emptyDraft(kind: 'stdio' | 'http' | 'sse'): Draft {
    const id = `mcp_${Date.now().toString(36)}`;
    return {
      id,
      name: '',
      transport: kind,
      ...(kind === 'stdio' ? { command: '', args: [] } : { url: '' }),
      enabled: true,
      autoApprove: false,
      auth: 'none',
      secretDrafts: {},
    };
  }

  /**
   * D73：落盘前规整认证方式。http：`oauth` / `none` 不带静态 header（切换认证方式
   * 后残留的 header 一并丢弃），`headers` 无 header 时退化为 `none`；stdio / sse
   * 无选择器，随 headers 是否存在而定（与 shared 的缺省推断一致）。
   */
  function withAuth(server: McpServer): McpServer {
    const hasHeaders = Object.keys(server.headers ?? {}).length > 0;
    if (server.transport === 'http' && (server.auth === 'oauth' || server.auth === 'none')) {
      const { headers: _dropped, ...rest } = server;
      void _dropped;
      return { ...rest, auth: server.auth };
    }
    return { ...server, auth: hasHeaders ? 'headers' : 'none' };
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

  function resetTestResults(): void {
    testServerId = null;
    testTools = null;
    testError = null;
    testHashes = null;
    draftTestTools = null;
    draftTestError = null;
    draftTestHashes = null;
  }

  function addServer(): void {
    draft = emptyDraft(newKind);
    editingId = null;
    resetTestResults();
  }

  function editServer(server: McpServer): void {
    draft = { ...server, secretDrafts: {} };
    editingId = server.id;
    resetTestResults();
  }

  function cancelEdit(): void {
    draft = null;
    editingId = null;
  }

  /**
   * 落盘：先写新输入的密钥，再整体覆盖 mcpServers。`approveTools` = 「保存并批准工具」：
   * 保存成功后把草稿测试时看到的工具定义交给 core 批准。
   */
  async function save(approveTools = false): Promise<void> {
    if (draft === null) return;
    const hashesToApprove = approveTools ? draftTestHashes : null;
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
      const { secretDrafts, ...draftServer } = draft;
      const server = withAuth(draftServer);
      // 切到 OAuth / 无认证后被丢弃的 header：其已存密钥一并清掉，不留孤儿。
      const keptHeaders = new Set(Object.keys(server.headers ?? {}));
      const droppedHeaders = Object.keys(draftServer.headers ?? {}).filter(
        (name) => !keptHeaders.has(name),
      );
      // 新输入的密钥值先落 secrets（env: 直接名；header: h: 前缀区分草稿键）。
      for (const [name, value] of Object.entries(secretDrafts)) {
        if (value.length === 0) continue;
        if (name.startsWith('h:')) {
          if (!keptHeaders.has(name.slice(2))) continue;
          await settingsStore.setMcpSecret(serverId, 'header', name.slice(2), value);
        } else {
          await settingsStore.setMcpSecret(serverId, 'env', name, value);
        }
      }
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
      for (const name of droppedHeaders) {
        await settingsStore.removeMcpSecret(serverId, 'header', name).catch(() => {});
      }
      toast.success(t('settings.saved'));
      draft = null;
      editingId = null;
      draftTestTools = null;
      draftTestHashes = null;
      if (hashesToApprove !== null) await approveTested(serverId, hashesToApprove);
      else void appsStore.refresh().catch(() => undefined);
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
      // D73：core 删除 settings 条目并清理密钥 / 令牌 / 连接行（不再整体覆盖 mcpServers）。
      await settingsStore.removeMcpServer(server.id);
      if (editingId === server.id) cancelEdit();
      void appsStore.refresh().catch(() => undefined);
      toast.success(t('settings.saved'));
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function test(server: McpServer): Promise<void> {
    testing = true;
    testServerId = server.id;
    testTools = null;
    testError = null;
    testHashes = null;
    try {
      const result = await settingsStore.testMcp(server);
      testTools = result.tools;
      testHashes = result.toolHashes ?? null;
      if (result.missingSecrets.length > 0) {
        testError = t('settings.mcpMissingSecrets', { names: result.missingSecrets.join(', ') });
      } else if (result.needsAuth !== undefined && result.message !== undefined) {
        testError = result.message;
      }
      // 风险档 / 待批准状态来自锁定清单（测试本身不登记）；测试成功后拉一次。
      if (result.tools.length > 0) {
        void appDetailStore.loadTools(customConnectionId(server.id)).catch(() => undefined);
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
    draftTestHashes = null;
    try {
      const { secretDrafts: _ignored, ...server } = draft;
      void _ignored;
      const result = await settingsStore.testMcp(
        withAuth(server as McpServer),
        draftSecretValues(draft),
      );
      draftTestTools = result.tools;
      draftTestHashes = result.toolHashes ?? null;
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
  <label class="flex items-start gap-2 text-xs" data-testid="mcp-dev-mode">
    <Checkbox
      checked={developerMode}
      disabled={devModeBusy}
      onCheckedChange={(checked) => void toggleDeveloperMode(checked === true)}
    />
    <span>
      <span class="block font-medium">{t('settings.devMode')}</span>
      <span class="block text-muted-foreground">{t('settings.devModeHint')}</span>
    </span>
  </label>

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
        {#if appDetailStore.pendingFor(customConnectionId(server.id)) > 0}
          <Badge
            variant="outline"
            class="border-amber-500/60 text-amber-700 dark:text-amber-400"
            data-testid={`mcp-pending-${server.id}`}
          >
            {t('settings.mcpToolsPending', {
              count: appDetailStore.pendingFor(customConnectionId(server.id)),
            })}
          </Badge>
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
      {#if testServerId === server.id}
        {#if testTools !== null && testError === null}
          <div class="space-y-1.5" data-testid={`mcp-tools-${server.id}`}>
            <p class="text-xs text-emerald-600 dark:text-emerald-400">
              {t('settings.mcpToolsFound', { count: testTools.length })}
            </p>
            {#if testTools.length > 0}
              <div class="flex flex-wrap gap-1.5" data-testid={`mcp-tested-${server.id}`}>
                <!-- 按位置键：server 返回的工具名可能重复，重名会让按名键的 each 崩掉 -->
                {#each testTools as name, index (index)}
                  {@const risk = riskOf(server.id, name)}
                  <span class="flex items-center gap-1 text-xs">
                    <code class="rounded bg-muted px-1.5 py-0.5">{name}</code>
                    {#if risk !== null}
                      <McpRiskBadge {risk} testid={`mcp-tested-risk-${server.id}-${name}`} />
                    {/if}
                  </span>
                {/each}
              </div>
              {#if testHashes !== null && appDetailStore.pendingFor(customConnectionId(server.id)) > 0}
                {@const hashes = testHashes}
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={approving}
                    onclick={() => void approveTested(server.id, hashes)}
                    data-testid={`mcp-approve-${server.id}`}
                  >
                    {t('settings.mcpToolsApprove')}
                  </Button>
                  <span class="text-xs text-muted-foreground">
                    {t('settings.mcpToolsApproveHint')}
                  </span>
                </div>
              {/if}
            {/if}
          </div>
        {:else if testError !== null}
          <p class="text-xs text-destructive">{testError}</p>
        {/if}
      {/if}
      {#if server.auth === 'oauth'}
        <div class="space-y-1.5 border-t pt-2.5" data-testid={`mcp-oauth-${server.id}`}>
          <p class="text-xs font-medium">{t('settings.mcpOauthSection')}</p>
          <ConnectAppPanel
            target={{ kind: 'custom', serverId: server.id }}
            name={server.name}
            testid={`mcp-connect-${server.id}`}
          />
        </div>
      {/if}
      {#if toolsOpen[server.id]}
        <McpToolPolicies {server} />
      {/if}
      {#if developerMode}
        <McpDevTools {server} />
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
            placeholder={draft.transport === 'sse'
              ? 'https://mcp.example.com/sse'
              : 'https://mcp.example.com/mcp'}
          />
        </div>
      {/if}

      {#if draft.transport === 'http'}
        <div class="grid gap-1.5">
          <Label for="mcp-auth">{t('settings.mcpAuthLabel')}</Label>
          <select
            id="mcp-auth"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={draft.auth}
            data-testid="mcp-auth"
          >
            <option value="none">{t('settings.mcpAuthNone')}</option>
            <option value="headers">{t('settings.mcpAuthHeaders')}</option>
            <option value="oauth">{t('settings.mcpAuthOauth')}</option>
          </select>
        </div>
      {/if}

      {#if draft.transport === 'http' && draft.auth === 'oauth'}
        <p class="text-xs text-muted-foreground" data-testid="mcp-auth-oauth-hint">
          {t('settings.mcpAuthOauthHint')}
          {#if editingId === null}{t('settings.mcpAuthOauthSaveFirst')}{/if}
        </p>
      {:else if draft.transport !== 'http' || draft.auth === 'headers'}
        <p class="text-xs text-muted-foreground">{t('settings.mcpSecretHint')}</p>
      {/if}

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
      {:else if draft.transport !== 'http' || draft.auth === 'headers'}
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

      <div class="flex flex-wrap items-center gap-2">
        {#if draftTestHashes !== null && Object.keys(draftTestHashes).length > 0 && draftTestError === null}
          <!-- §5.5：测试到的工具批准前不暴露给 Bot；保存即批准测试时看到的定义。 -->
          <Button
            size="sm"
            disabled={busy || approving}
            onclick={() => void save(true)}
            data-testid="mcp-save-approve"
          >
            {t('settings.mcpToolsSaveApprove')}
          </Button>
        {/if}
        <Button
          size="sm"
          variant={draftTestHashes !== null && draftTestError === null ? 'secondary' : 'default'}
          disabled={busy}
          onclick={() => void save()}
          data-testid="mcp-save"
        >
          {t('settings.save')}
        </Button>
        {#if !(draft.transport === 'http' && draft.auth === 'oauth')}
          <!-- OAuth 的草稿无令牌可测：保存并连接后在列表里测试。 -->
          <Button
            size="sm"
            variant="secondary"
            disabled={draftTesting}
            onclick={() => void testDraft()}
            data-testid="mcp-test-draft"
          >
            {draftTesting ? t('settings.testing') : t('settings.test')}
          </Button>
        {/if}
        <Button size="sm" variant="ghost" onclick={cancelEdit}>{t('settings.mcpCancel')}</Button>
      </div>

      {#if draftTestTools !== null && draftTestError === null}
        <div class="space-y-1.5" data-testid="mcp-draft-test-ok">
          <p class="text-xs text-emerald-600 dark:text-emerald-400">
            {t('settings.mcpToolsFound', { count: draftTestTools.length })}
          </p>
          {#if draftTestTools.length > 0}
            <div class="flex flex-wrap gap-1.5" data-testid="mcp-draft-tested">
              {#each draftTestTools as name, index (index)}
                <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{name}</code>
              {/each}
            </div>
            <p class="text-xs text-muted-foreground">{t('settings.mcpToolsApproveHint')}</p>
          {/if}
        </div>
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
      <McpbInstall />
    </div>
  {/if}

  <OAuthClientsPanel />
</section>
