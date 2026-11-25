<script lang="ts">
  import { tick } from 'svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { connections } from '$lib/rpc/connections.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { fusionPref } from '$lib/features/team/fusion-pref';
  import { teamCacheSync } from '$lib/features/team/cache-sync.svelte';
  import {
    getTeamServersApi,
    parseTeamError,
    type TeamServerEntry,
  } from '$lib/features/team/platform-team-servers';
  import {
    normalizeTeamServerAddress,
    probeFailureOf,
    type TeamServerProbeFailure,
  } from '$lib/features/team/team-server-connect';
  import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';

  /**
   * 「团队服务器」管理卡（T7 步骤 4，升级 T5 的连接卡；2026-11 连接流程重构）：
   *
   * 步骤一（地址）：输入地址 → 主进程 `probe` 健康检查（`GET /api/auth/whoami`，
   * 可达 + 是团队服务器）→ **通过后才 add 登记**。检查失败只弹框说明原因，
   * 不登记、不落任何配置；用户修正地址后可重试。
   *
   * 步骤二（登录）：健康检查通过后登录表单出现在地址下方（不再藏在列表条目
   * 的状态分支里），用户名 / 密码交主进程换 token；成功后建立团队连接，
   * 已保存服务器列表随后展示状态 / 多账号 / 融合开关。
   *
   * 密码只在提交瞬间经 platform 调用传主进程（token / 密码不落任何渲染层
   * 存储）。web 端点没有 platform.teamServers：整卡不渲染（desktopOnly）。
   *
   * 已保存条目支持本机重命名（名称只存 team-servers.json，不上传服务器；
   * 左栏等显示处名称优先、地址兜底）。
   */

  const desktopOnly = ENDPOINT_KIND === 'desktop';
  const pref = fusionPref();

  /** `add-failed` = 健康检查通过但登记失败（写配置文件出错），同样弹框。 */
  type ConnectFailure = TeamServerProbeFailure | { kind: 'add-failed'; detail: string | null };

  let address = $state('');
  let adding = $state(false);
  let invalidAddress = $state(false);
  let probeFailure = $state<ConnectFailure | null>(null);

  /** 登录步骤的目标服务器（null = 未展开登录表单）。 */
  let loginServerHash = $state<string | null>(null);
  let loginSection = $state<HTMLElement | null>(null);
  /** 新添加服务器登录成功后回到对话列表（直接看到左栏出现的团队内容）。 */
  let closeSettingsOnLogin = $state(false);
  let username = $state('');
  let password = $state('');
  let remember = $state(true);
  let loggingIn = $state(false);
  let loginError = $state<string | null>(null);

  let removeTarget = $state<TeamServerEntry | null>(null);
  let busyHash = $state<string | null>(null);

  /** 内联重命名（null = 未在编辑）；草稿为空保存 = 清除名称（回退显示地址）。 */
  let renamingHash = $state<string | null>(null);
  let nameDraft = $state('');

  const servers = $derived(connections.servers);
  const loginServer = $derived(
    loginServerHash === null ? null : connections.serverOf(loginServerHash),
  );

  async function refresh(): Promise<void> {
    await connections.refreshServers();
  }

  /**
   * 步骤一：地址 → 健康检查 → 通过才登记 → 展开登录表单。
   * 检查失败（不可达 / 不是团队服务器）弹框说明原因并直接返回，**不 add**。
   */
  async function addServer(): Promise<void> {
    const api = getTeamServersApi();
    if (api === null || adding) return;
    const url = normalizeTeamServerAddress(address);
    if (url === null) {
      invalidAddress = true;
      return;
    }
    invalidAddress = false;
    probeFailure = null;
    adding = true;
    try {
      const result = await api.probe({ url });
      const failure = probeFailureOf(result);
      if (failure !== null) {
        probeFailure = failure;
        return;
      }
      const { serverHash } = await api.add({ url });
      await refresh();
      address = '';
      const entry = connections.serverOf(serverHash);
      // 同一地址重复添加：已登录的服务器不再重复走登录，只确保连接在跑
      //（idle 直接连；unreachable 是过期状态——probe 刚证明服务器可达，踢一次
      // 重连，避免 toast「已连接」而列表仍显示「服务器不可用」的矛盾）；
      // 未登录 / 出错（例如 token 失效）仍落到登录步骤。
      if (
        entry !== null &&
        entry.activeMemberId !== null &&
        entry.status !== 'unauthenticated' &&
        entry.status !== 'error'
      ) {
        if (entry.status === 'idle' || entry.status === 'unreachable') {
          await connections.requestConnect(serverHash);
        }
        toast.success(t('settings.teamServerAlreadyConnected'));
        return;
      }
      startLogin(serverHash, { closeSettingsOnSuccess: true });
    } catch (error) {
      probeFailure = { kind: 'add-failed', detail: errorTextOf(error) };
    } finally {
      adding = false;
    }
  }

  /** 展开登录步骤（新添加的服务器 / 列表里点「登录」）。 */
  function startLogin(
    serverHash: string,
    options: { closeSettingsOnSuccess?: boolean } = {},
  ): void {
    const server = connections.serverOf(serverHash);
    if (server === null) return;
    closeSettingsOnLogin = options.closeSettingsOnSuccess === true;
    loginServerHash = serverHash;
    loginError = null;
    password = '';
    const account =
      server.accounts.find((entry) => entry.memberId === server.activeMemberId) ??
      server.accounts[0];
    username = account?.username ?? '';
    remember = true;
    void tick().then(() =>
      loginSection?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }

  function cancelLogin(): void {
    loginServerHash = null;
    loginError = null;
    closeSettingsOnLogin = false;
    username = '';
    password = '';
  }

  /** 步骤二：主进程登录换 token → 建立团队连接（融合开着时）。 */
  async function login(): Promise<void> {
    const api = getTeamServersApi();
    const server = loginServer;
    if (api === null || server === null || loggingIn) return;
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
      if (pref.isEnabled(server.serverHash)) {
        // 连接失败不回滚登录（token 已拿到，状态点会显示 error 供重试）。
        await connections.requestConnect(server.serverHash).catch(() => undefined);
      }
      loginServerHash = null;
      username = '';
      toast.success(t('settings.teamServerLoginSuccess', { url: server.url }));
      // 新添加服务器的首次登录：回到对话列表，左栏团队分组随即出现。
      if (closeSettingsOnLogin) {
        closeSettingsOnLogin = false;
        shell.closeSettings();
      }
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
      if (loginServerHash === server.serverHash) cancelLogin();
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

  // --- 服务器名称（仅本机：设置里改名，左栏等显示处名称优先、地址兜底） -------

  function displayNameOf(server: TeamServerEntry): string {
    return server.name !== '' ? server.name : server.url;
  }

  /**
   * 内联重命名同时只开一处（renamingHash 单值）：点另一台的「重命名」会直接
   * 换编辑对象、丢弃未保存草稿——列表场景下不做二次确认。
   */
  function startRename(server: TeamServerEntry): void {
    renamingHash = server.serverHash;
    nameDraft = server.name;
  }

  function cancelRename(): void {
    renamingHash = null;
    nameDraft = '';
  }

  async function saveRename(server: TeamServerEntry): Promise<void> {
    const api = getTeamServersApi();
    if (api === null || busyHash === server.serverHash) return;
    busyHash = server.serverHash;
    try {
      await api.rename({ serverHash: server.serverHash, name: nameDraft });
      cancelRename();
      await refresh();
    } catch (error) {
      toast.error(errorTextOf(error));
    } finally {
      busyHash = null;
    }
  }

  function onRenameKeydown(server: TeamServerEntry, event: KeyboardEvent): void {
    // 输入法合成中的 Enter / Escape 是候选操作，不触发保存 / 取消（同
    // ProviderDetail.onNameKeydown 的 IME 约定）。
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveRename(server);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }

  /** 重命名输入框挂载即聚焦并全选现名（改名最高频动作是整体替换）。 */
  function focusRenameInput(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  async function retryConnect(server: TeamServerEntry): Promise<void> {
    await connections.requestConnect(server.serverHash);
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
      if (loginServerHash === server.serverHash) cancelLogin();
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
      case 'error':
        // error 只在前 3 次快速重试之间瞬时存在（此后桥报 unreachable）：
        // 与 connecting 同文案，避免「连接出错 / 连接中」来回闪。
        return t('team.serverConnecting');
      case 'unreachable':
        return t('team.serverUnavailable');
      case 'unauthenticated':
        return t('team.serverStatusUnauthenticated');
      default:
        return server.activeMemberId === null
          ? t('team.serverStatusUnauthenticated')
          : t('team.serverStatusIdle');
    }
  }

  function activeAccountName(server: TeamServerEntry): string {
    const account = server.accounts.find((entry) => entry.memberId === server.activeMemberId);
    return account?.displayName ?? account?.username ?? '';
  }

  /** 失败弹框正文（连接失败原因）。 */
  function failureReason(failure: ConnectFailure): string {
    switch (failure.kind) {
      case 'unreachable':
        return t('settings.teamServerProbeUnreachable');
      case 'personal':
        return t('settings.teamServerProbePersonal');
      case 'unknown':
        return t('settings.teamServerProbeUnknown');
      case 'add-failed':
        return t('settings.teamServerAddFailed');
    }
  }
</script>

{#if desktopOnly}
  <div class="rounded-xl border p-4" data-testid="team-server-connect-card">
    <h4 class="text-sm font-medium">{t('settings.teamServerTitle')}</h4>
    <p class="mt-1 text-xs text-muted-foreground">{t('settings.teamServerHintFusion')}</p>

    <!-- 步骤一：地址 + 健康检查（检查通过才登记）。 -->
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
        oninput={() => {
          invalidAddress = false;
        }}
        data-testid="team-server-address"
      />
      <Button
        type="submit"
        size="sm"
        class="mt-0.5"
        disabled={adding || address.trim().length === 0}
        data-testid="team-server-connect"
      >
        {adding ? t('settings.teamServerProbing') : t('settings.teamServerAdd')}
      </Button>
    </form>
    {#if invalidAddress}
      <p class="mt-2 text-xs text-destructive" data-testid="team-server-error">
        {t('settings.teamServerInvalidUrl')}
      </p>
    {:else if adding}
      <p class="mt-2 text-xs text-muted-foreground" data-testid="team-server-probing">
        {t('settings.teamServerProbeChecking')}
      </p>
    {/if}

    <!-- 步骤二：健康检查通过后，登录表单出现在地址下方。 -->
    {#if loginServer !== null}
      <div
        class="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3"
        bind:this={loginSection}
        data-testid="team-server-login-step"
      >
        <p class="text-xs font-medium text-emerald-700 dark:text-emerald-400">
          {t('settings.teamServerProbePassed', { url: loginServer.url })}
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          {t('settings.teamServerLoginStepHint')}
        </p>
        <form
          class="mt-2 space-y-1.5"
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
              onclick={cancelLogin}
              data-testid="team-login-cancel"
            >
              {t('contacts.cancel')}
            </Button>
          </div>
        </form>
      </div>
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
                  : server.status === 'connecting' || server.status === 'error'
                    ? 'bg-amber-400'
                    : 'bg-zinc-400'}"
                data-testid="team-server-status-dot"
              ></span>
              {#if renamingHash === server.serverHash}
                <!-- 内联重命名：Enter 保存、Escape 取消；清空保存 = 回退显示地址。 -->
                <input
                  class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
                  type="text"
                  maxlength="100"
                  placeholder={t('team.serverNamePlaceholder')}
                  bind:value={nameDraft}
                  onkeydown={(event) => onRenameKeydown(server, event)}
                  use:focusRenameInput
                  data-testid={`team-server-name-input-${server.serverHash}`}
                />
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  disabled={busyHash === server.serverHash}
                  onclick={() => void saveRename(server)}
                  data-testid={`team-server-name-save-${server.serverHash}`}
                >
                  {t('common.save')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  disabled={busyHash === server.serverHash}
                  onclick={cancelRename}
                  data-testid={`team-server-name-cancel-${server.serverHash}`}
                >
                  {t('contacts.cancel')}
                </Button>
              {:else}
                <span class="min-w-0 flex-1 truncate text-sm" title={server.url}>
                  {displayNameOf(server)}
                </span>
                <span class="shrink-0 text-xs text-muted-foreground">{statusText(server)}</span>
              {/if}
            </div>
            {#if server.name !== '' && renamingHash !== server.serverHash}
              <!-- 已命名：名称为主、地址保留一行小字（设置里始终能看到真实地址）。 -->
              <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={server.url}>
                {server.url}
              </p>
            {/if}
            {#if activeName !== ''}
              <p class="mt-1 truncate text-xs text-muted-foreground" data-testid="team-server-account">
                {t('team.serverActiveAccount', { name: activeName })}
              </p>
            {/if}

            {#if server.status === 'connected'}
              {#if server.accounts.length > 1}
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
            {:else}
              <!-- 未登录 / 出错：登录入口（表单在上方步骤二就地展开）。 -->
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
                <div class="flex flex-wrap gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={() => startLogin(server.serverHash)}
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
              {#if renamingHash !== server.serverHash}
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  disabled={busyHash === server.serverHash}
                  onclick={() => startRename(server)}
                  data-testid={`team-server-rename-${server.serverHash}`}
                >
                  {t('team.renameServer')}
                </Button>
              {/if}
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

  <!-- 健康检查失败弹框：说明原因 + 明确「未添加」。 -->
  <Dialog
    open={probeFailure !== null}
    onOpenChange={(open) => {
      if (!open) probeFailure = null;
    }}
  >
    <DialogContent class="max-w-md" data-testid="team-server-probe-dialog">
      <DialogHeader>
        <DialogTitle>{t('settings.teamServerProbeFailedTitle')}</DialogTitle>
      </DialogHeader>
      <div class="space-y-2">
        <p class="text-sm" data-testid="team-server-probe-dialog-reason">
          {probeFailure === null ? '' : failureReason(probeFailure)}
        </p>
        {#if probeFailure !== null && probeFailure.detail !== null}
          <p
            class="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all text-muted-foreground"
            data-testid="team-server-probe-dialog-detail"
          >
            {probeFailure.detail}
          </p>
        {/if}
        <p class="text-xs text-muted-foreground">
          {t('settings.teamServerProbeNotAdded')}
        </p>
      </div>
      <DialogFooter>
        <Button onclick={() => (probeFailure = null)} data-testid="team-server-probe-dialog-ok">
          {t('common.close')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
{/if}
