<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';

  /**
   * 「连接团队服务器」卡（T5 步骤 5 的渲染层部分，62.08 §3 P0 过渡）：远程
   * 遥控设置分区里的入口——地址输入 + 「连接」按钮 + 最近使用列表。
   *
   * 连接动作走 `platform.openTeamServer {url}`（README 固定契约，桌面主进程
   * 实现：另起一个远程模式进程窗口，`KEPCUP_REMOTE_URL` 指向团队服务器）。
   * web 端点的垫片没有这个方法——整个卡按端点隐藏（只有桌面显示），不靠
   * disabled 兜底（「连接」在 web 上永远不可能成功）。
   *
   * 最近使用存 localStorage（客户端本机；凭据不落渲染层，由团队窗口自己的
   * 登录 Cookie 承载）。
   */

  const RECENT_KEY = 'kepcup.teamServers.recent';
  const RECENT_MAX = 3;

  let address = $state('');
  let connecting = $state(false);
  let error = $state<'invalid' | 'failed' | null>(null);
  let recent = $state<string[]>(loadRecent());

  function loadRecent(): string[] {
    try {
      const raw = globalThis.localStorage?.getItem(RECENT_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_MAX)
        : [];
    } catch {
      return [];
    }
  }

  function saveRecent(url: string): void {
    const next = [url, ...recent.filter((entry) => entry !== url)].slice(0, RECENT_MAX);
    recent = next;
    try {
      globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // 持久化失败只影响下次启动的「最近使用」列表。
    }
  }

  /** 地址校验（与桌面主进程 resolveRemoteMode 同口径的轻量前端预检）。 */
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

  async function connect(): Promise<void> {
    // platform.openTeamServer（README 固定契约）由桌面主进程实现，preload 暴露为
    // `window.kepcup.platform.openTeamServer`（shim.d.ts 可选声明）；web 垫片没有
    // 这个方法——本卡在 web 端点根本不渲染（desktopOnly），判空只为旧构建兜底。
    const openTeamServer = window.kepcup.platform.openTeamServer;
    if (typeof openTeamServer !== 'function') return;
    const url = normalizeAddress(address);
    if (url === null) {
      error = 'invalid';
      return;
    }
    error = null;
    connecting = true;
    try {
      await openTeamServer({ url });
      saveRecent(url);
      toast.success(t('settings.teamServerOpening'));
    } catch {
      error = 'failed';
    } finally {
      connecting = false;
    }
  }

  const desktopOnly = ENDPOINT_KIND === 'desktop';
</script>

<!-- web 端点（浏览器 / PWA / 远程模式窗口）没有 platform.openTeamServer：整卡不渲染。 -->
{#if desktopOnly}
  <div class="rounded-xl border p-4" data-testid="team-server-connect-card">
    <h4 class="text-sm font-medium">{t('settings.teamServerTitle')}</h4>
    <p class="mt-1 text-xs text-muted-foreground">{t('settings.teamServerHint')}</p>
    <form
      class="mt-3 flex items-start gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      <input
        class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
        type="text"
        inputmode="url"
        spellcheck="false"
        placeholder={t('settings.teamServerPlaceholder')}
        bind:value={address}
        oninput={() => (error = null)}
        data-testid="team-server-address"
      />
      <Button size="sm" disabled={connecting || address.trim().length === 0} onclick={() => void connect()} data-testid="team-server-connect">
        {connecting ? t('settings.teamServerConnecting') : t('settings.teamServerConnect')}
      </Button>
    </form>
    {#if error === 'invalid'}
      <p class="mt-2 text-xs text-destructive" data-testid="team-server-error">
        {t('settings.teamServerInvalidUrl')}
      </p>
    {:else if error === 'failed'}
      <p class="mt-2 text-xs text-destructive" data-testid="team-server-error">
        {t('settings.teamServerFailed')}
      </p>
    {/if}
    {#if recent.length > 0}
      <div class="mt-3" data-testid="team-server-recent">
        <p class="text-xs text-muted-foreground">{t('settings.teamServerRecent')}</p>
        <ul class="mt-1 space-y-1">
          {#each recent as entry (entry)}
            <li>
              <button
                type="button"
                class="w-full truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onclick={() => {
                  address = entry;
                  void connect();
                }}
                data-testid={`team-server-recent-${entry}`}
              >
                {entry}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}
