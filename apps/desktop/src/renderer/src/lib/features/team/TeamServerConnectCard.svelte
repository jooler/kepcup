<script lang="ts">
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { connections } from '$lib/rpc/connections.svelte';
  import { fusionPref } from '$lib/features/team/fusion-pref';
  import { teamCacheSync } from '$lib/features/team/cache-sync.svelte';
  import {
    getTeamServersApi,
    parseTeamError,
    type TeamServerEntry,
  } from '$lib/features/team/platform-team-servers';
  import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';

  /**
   * 「团队服务器」管理卡（T7 步骤 4，升级 T5 的连接卡）：已保存服务器列表
   *（地址 / 状态点 / 活跃账号）、添加、登录（用户名 / 密码 / 记住我）、多账号
   * 选择器（微信式，62.10 §4）、登出、「在此窗口融合」开关（默认开，本机
   * 偏好按 serverHash 存）、「在独立窗口打开」（T5 远程进程）与移除。
   *
   * 密码只在提交瞬间经 platform 调用传主进程（token / 密码不落任何渲染层
   * 存储）。web 端点没有 platform.teamServers：整卡不渲染（desktopOnly）。
   */

  const desktopOnly = ENDPOINT_KIND === 'desktop';
  const pref = fusionPref();

  let address = $state('');
  let adding = $state(false);
  let addError = $state<'invalid' | 'failed' | null>(null);

  /** 登录表单（当前选中的服务器）。 */
  let loginServer = $state<TeamServerEntry | null>(null);
  let username = $state('');
  let password = $state('');
  let remember = $state(true);
  let loggingIn = $state(false);
  let loginError = $state<string | null>(null);

  let removeTarget = $state<TeamServerEntry | null>(null);
  let busyHash = $state<string | null>(null);

  const servers = $derived(connections.servers);

  /** 地址校验（与 TeamServerConnectCard T5 同口径的轻量前端预检）。 */
  function normalizeAddress(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (parsed.username !== '' || parsed.password !== '') return null;
      return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
    } catch {
      return null;
    }
  }

  async function refresh(): Promise<void> {
    await connections.refreshServers();
  }

  async function addServer(): Promise<void> {
    const api = getTeamServersApi();
    if (api === null) return;
    const url = normalizeAddress(address);
    if (url === null) {
      addError = 'invalid';
      return;
    }
    addError = null;
    adding = true;
    try {
      const { serverHash } = await api.add({ url });
      await refresh();
      // 新服务器直接落到登录表单（没有账号时可登录）。
      loginServer = connections.serverOf(serverHash);
      address = '';
    } catch (error) {
      addError = 'failed';
      toast.error(errorTextOf(error));
    } finally {
      adding = false;
    }
  }

  async function login(): Promise<void> {
    const api = getTeamServersApi();
    const server = loginServer;
    if (api === null || server === null) return;
    if (username.trim().length === 0 || password.length === 0) return;
    loggingIn = true;
    loginError = null;
    try {
      await api.login({
        serverHash: server.serverHash,
        username: username.trim(),
        password,
        remember,
      });
      password = '';
      await refresh();
      if (pref.isEnabled(server.serverHash)) await connections.requestConnect(server.serverHash);
      loginServer = null;
    } catch (error) {
      loginError = errorTextOf(error);
    } finally {
      loggingIn = false;
    }
  }

  async function logout(server: TeamServerEntry): Promise<void> {
    const api = getTeamServersApi();
    if (api === null) return;
    busyHash = server.serverHash;
    try {
      await api.logout({ serverHash: server.serverHash });
      await refresh();
    } catch (error) {
      toast.error(errorTextOf(error));
    } finally {
      busyHash = null;
    }
  }

  async function switchAccount(server: TeamServerEntry, memberId: string): Promise<void> {
    const api = getTeamServersApi();
    if (api === null || memberId === server.activeMemberId) return;
    busyHash = server.serverHash;
    try {
      await api.switchAccount({ serverHash: server.serverHash, memberId });
      await refresh();
      if (pref.isEnabled(server.serverHash)) await connections.requestConnect(server.serverHash);
    } catch (error) {
      toast.error(errorTextOf(error));
    } finally {
      busyHash = null;
    }
  }

  async function toggleFusion(server: TeamServerEntry, enabled: boolean): Promise<void> {
    pref.setEnabled(server.serverHash, enabled);
    if (enabled) await connections.requestConnect(server.serverHash);
    else await connections.requestDisconnect(server.serverHash);
  }

  async function retryConnect(server: TeamServerEntry): Promise<void> {
    await connections.requestConnect(server.serverHash);
  }

  function openSeparateWindow(server: TeamServerEntry): void {
    const openTeamServer = window.kepcup.platform.openTeamServer;
    if (typeof openTeamServer !== 'function') return;
    void openTeamServer({ url: server.url }).then(() => {
      toast.success(t('settings.teamServerOpening'));
    });
  }

  async function confirmRemove(): Promise<void> {
    const api = getTeamServersApi();
    const server = removeTarget;
    if (api === null || server === null) return;
    busyHash = server.serverHash;
    try {
      await api.remove({ serverHash: server.serverHash });
      // T8（62.10 §4）：移除服务器 = 清除该服务器全部成员分区（含附件与密钥文件
      // + 各成员的同步 cursor）。确认框文案已提示；清除失败不影响移除本身。
      await teamCacheSync.clearServerPartitions(server.serverHash);
      removeTarget = null;
      await refresh();
    } catch (error) {
      toast.error(errorTextOf(error));
    } finally {
      busyHash = null;
    }
  }

  /** 错误按 code 出文案（chats.errorCode.<CODE>），无 code 透出主进程文本。 */
  function errorTextOf(error: unknown): string {
    const parsed = parseTeamError(error);
    if (parsed.code !== null && parsed.code.length > 0) {
      return errorText(parsed.code, parsed.message || t('settings.teamServerFailed'));
    }
    return parsed.message || t('settings.teamServerFailed');
  }

  function statusText(server: TeamServerEntry): string {
    switch (server.status) {
      case 'connected':
        return t('team.serverStatusConnected');
      case 'connecting':
        return t('team.serverConnecting');
      case 'unauthenticated':
        return t('team.serverStatusUnauthenticated');
      case 'error':
        return t('team.serverStatusError');
      default:
        return t('team.serverStatusIdle');
    }
  }

  function activeAccountName(server: TeamServerEntry): string {
    const account = server.accounts.find((entry) => entry.memberId === server.activeMemberId);
    return account?.displayName ?? account?.username ?? '';
  }
</script>

{#if desktopOnly}
  <div class="rounded-xl border p-4" data-testid="team-server-connect-card">
    <h4 class="text-sm font-medium">{t('settings.teamServerTitle')}</h4>
    <p class="mt-1 text-xs text-muted-foreground">{t('settings.teamServerHintFusion')}</p>

    <!-- 添加服务器 -->
    <form
      class="mt-3 flex items-start gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void addServer();
      }}
    >
      <input
        class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
        type="text"
        inputmode="url"
        spellcheck="false"
        placeholder={t('settings.teamServerPlaceholder')}
        bind:value={address}
        oninput={() => (addError = null)}
        data-testid="team-server-address"
      />
      <Button
        size="sm"
        disabled={adding || address.trim().length === 0}
        onclick={() => void addServer()}
        data-testid="team-server-connect"
      >
        {adding ? t('settings.teamServerAdding') : t('settings.teamServerAdd')}
      </Button>
    </form>
    {#if addError === 'invalid'}
      <p class="mt-2 text-xs text-destructive" data-testid="team-server-error">
        {t('settings.teamServerInvalidUrl')}
      </p>
    {:else if addError === 'failed'}
      <p class="mt-2 text-xs text-destructive" data-testid="team-server-error">
        {t('settings.teamServerFailed')}
      </p>
    {/if}

    <!-- 已保存服务器列表 -->
    {#if servers.length > 0}
      <ul class="mt-3 space-y-2" data-testid="team-server-list">
        {#each servers as server (server.serverHash)}
          {@const fusion = pref.isEnabled(server.serverHash)}
          {@const activeName = activeAccountName(server)}
          <li
            class="rounded-lg border p-3"
            data-testid={`team-server-item-${server.serverHash}`}
            data-status={server.status}
          >
            <div class="flex items-center gap-2">
              <span
                class="size-2 shrink-0 rounded-full {server.status === 'connected'
                  ? 'bg-emerald-500'
                  : server.status === 'connecting'
                    ? 'bg-amber-400'
                    : 'bg-zinc-400'}"
                data-testid="team-server-status-dot"
              ></span>
              <span class="min-w-0 flex-1 truncate text-sm" title={server.url}>{server.url}</span>
              <span class="shrink-0 text-xs text-muted-foreground">{statusText(server)}</span>
            </div>
            {#if activeName !== ''}
              <p class="mt-1 truncate text-xs text-muted-foreground" data-testid="team-server-account">
                {t('team.serverActiveAccount', { name: activeName })}
              </p>
            {/if}

            {#if server.status === 'unauthenticated' || server.status === 'error'}
              <!-- 未认证 / 出错：登录表单（或重试）。 -->
              <div class="mt-2 space-y-1.5" data-testid="team-server-login">
                {#if server.accounts.length > 0}
                  <p class="text-xs text-muted-foreground">{t('team.serverKnownAccounts')}</p>
                  <div class="flex flex-wrap gap-1">
                    {#each server.accounts as account (account.memberId)}
                      <Button
                        variant="outline"
                        size="sm"
                        class="h-7 px-2 text-xs"
                        disabled={busyHash === server.serverHash}
                        onclick={() => void switchAccount(server, account.memberId)}
                        data-testid={`team-server-account-${account.memberId}`}
                      >
                        {account.displayName || account.username}
                      </Button>
                    {/each}
                  </div>
                {/if}
                {#if loginServer?.serverHash === server.serverHash}
                  <form
                    class="space-y-1.5"
                    onsubmit={(event) => {
                      event.preventDefault();
                      void login();
                    }}
                  >
                    <input
                      class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      type="text"
                      autocomplete="username"
                      placeholder={t('team.loginUsername')}
                      bind:value={username}
                      data-testid="team-login-username"
                    />
                    <input
                      class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      type="password"
                      autocomplete="current-password"
                      placeholder={t('team.loginPassword')}
                      bind:value={password}
                      data-testid="team-login-password"
                    />
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input type="checkbox" bind:checked={remember} data-testid="team-login-remember" />
                      {t('team.loginRemember')}
                    </label>
                    {#if loginError !== null}
                      <p class="text-xs text-destructive" data-testid="team-login-error">{loginError}</p>
                    {/if}
                    <div class="flex gap-1.5">
                      <Button
                        size="sm"
                        type="submit"
                        disabled={loggingIn || username.trim().length === 0 || password.length === 0}
                        data-testid="team-login-submit"
                      >
                        {loggingIn ? t('team.loginSubmitting') : t('team.loginSubmit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onclick={() => (loginServer = null)}
                        data-testid="team-login-cancel"
                      >
                        {t('contacts.cancel')}
                      </Button>
                    </div>
                  </form>
                {:else}
                  <div class="flex flex-wrap gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => {
                        loginServer = server;
                        loginError = null;
                      }}
                      data-testid="team-server-show-login"
                    >
                      {t('team.loginSubmit')}
                    </Button>
                    {#if server.status === 'error'}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyHash === server.serverHash}
                        onclick={() => void retryConnect(server)}
                        data-testid="team-server-retry"
                      >
                        {t('team.serverRetry')}
                      </Button>
                    {/if}
                  </div>
                {/if}
              </div>
            {:else if server.accounts.length > 1}
              <!-- 多账号选择器（微信式）。 -->
              <div class="mt-2 flex flex-wrap gap-1" data-testid="team-server-accounts">
                {#each server.accounts as account (account.memberId)}
                  <Button
                    variant={account.memberId === server.activeMemberId ? 'default' : 'outline'}
                    size="sm"
                    class="h-7 px-2 text-xs"
                    disabled={busyHash === server.serverHash}
                    onclick={() => void switchAccount(server, account.memberId)}
                    data-testid={`team-server-account-${account.memberId}`}
                  >
                    {account.displayName || account.username}
                  </Button>
                {/each}
              </div>
            {/if}

            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={fusion}
                  onchange={(event) => void toggleFusion(server, (event.currentTarget as HTMLInputElement).checked)}
                  data-testid={`team-server-fusion-${server.serverHash}`}
                />
                {t('team.fusionToggle')}
              </label>
              <span class="flex-1"></span>
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                onclick={() => openSeparateWindow(server)}
                data-testid={`team-server-open-window-${server.serverHash}`}
              >
                {t('team.openSeparateWindow')}
              </Button>
              {#if server.activeMemberId !== null}
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  disabled={busyHash === server.serverHash}
                  onclick={() => void logout(server)}
                  data-testid={`team-server-logout-${server.serverHash}`}
                >
                  {t('team.logout')}
                </Button>
              {/if}
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs text-destructive hover:text-destructive"
                disabled={busyHash === server.serverHash}
                onclick={() => (removeTarget = server)}
                data-testid={`team-server-remove-${server.serverHash}`}
              >
                {t('team.removeServer')}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-3 text-xs text-muted-foreground" data-testid="team-server-empty">
        {t('team.serversEmpty')}
      </p>
    {/if}

    <!-- 移除确认（原生 confirm 语义的轻量内联卡）。 -->
    {#if removeTarget !== null}
      <div
        class="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
        data-testid="team-server-remove-confirm"
      >
        <p class="text-sm">{t('team.removeServerConfirm', { url: removeTarget.url })}</p>
        <div class="mt-2 flex gap-1.5">
          <Button variant="destructive" size="sm" onclick={() => void confirmRemove()} data-testid="team-server-remove-confirm-ok">
            {t('team.removeServer')}
          </Button>
          <Button variant="outline" size="sm" onclick={() => (removeTarget = null)} data-testid="team-server-remove-confirm-cancel">
            {t('contacts.cancel')}
          </Button>
        </div>
      </div>
    {/if}
  </div>
{/if}
