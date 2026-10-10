<script lang="ts">
  import type { OAuthClientView } from '@kepcup/shared';
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';

  /**
   * 「OAuth 客户端」（D73 P2 §6.4）：用户按授权服务器（issuer）自带客户端（BYO）。
   * 优先于自动注册（CIMD / DCR）与 KepCup 预注册表；Client Secret 只写入、永不回显。
   * 仍有连接使用该 issuer 时 core 拒绝删除（先断开连接）。
   */
  let clients = $state<OAuthClientView[]>([]);
  let adding = $state(false);
  let issuer = $state('');
  let clientId = $state('');
  let clientSecret = $state('');
  let clearSecret = $state(false);
  let busy = $state(false);

  /** 表单里的 issuer 已有带 secret 的客户端：保存时默认保留该 secret，可勾选清除。 */
  const existingWithSecret = $derived(
    clients.find(
      (client) =>
        client.hasSecret && client.issuer.replace(/\/+$/, '') === issuer.trim().replace(/\/+$/, ''),
    ) ?? null,
  );

  /** secret 是明文输入：取消 / 保存 / 组件卸载都立即清空，不留在内存里的表单状态中。 */
  function resetForm(): void {
    issuer = '';
    clientId = '';
    clientSecret = '';
    clearSecret = false;
    adding = false;
  }

  onDestroy(() => {
    clientSecret = '';
    clientId = '';
  });

  function reason(cause: unknown): string {
    return String((cause as Error).message ?? cause);
  }

  async function load(): Promise<void> {
    try {
      clients = await settingsStore.listOauthClients();
    } catch {
      clients = [];
    }
  }

  $effect(() => {
    void load();
  });

  function sourceLabel(source: OAuthClientView['source']): string {
    if (source === 'manual') return t('apps.oauthClientSourceManual');
    if (source === 'dcr') return t('apps.oauthClientSourceDcr');
    return t('apps.oauthClientSourcePreregistered');
  }

  async function save(): Promise<void> {
    if (issuer.trim().length === 0 || clientId.trim().length === 0) return;
    busy = true;
    try {
      await settingsStore.setOauthClient({
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(clientSecret.length > 0 ? { clientSecret } : {}),
        ...(clearSecret && clientSecret.length === 0 && existingWithSecret !== null
          ? { clearSecret: true }
          : {}),
      });
      toast.success(t('apps.oauthClientSaved'));
      resetForm();
      await load();
    } catch (cause) {
      toast.error(t('apps.oauthClientFailed', { reason: reason(cause) }));
    } finally {
      clientSecret = '';
      busy = false;
    }
  }

  async function remove(client: OAuthClientView): Promise<void> {
    busy = true;
    try {
      await settingsStore.removeOauthClient(client.issuer);
      toast.success(t('apps.oauthClientRemoved'));
      await load();
    } catch (cause) {
      toast.error(t('apps.oauthClientFailed', { reason: reason(cause) }));
    } finally {
      busy = false;
    }
  }
</script>

<section class="space-y-2" data-testid="oauth-clients">
  <h4 class="text-sm font-medium">{t('apps.oauthClientTitle')}</h4>
  <p class="text-xs text-muted-foreground">{t('apps.oauthClientHint')}</p>

  {#if clients.length === 0}
    <p class="text-xs text-muted-foreground">{t('apps.oauthClientEmpty')}</p>
  {/if}
  {#each clients as client (client.issuer)}
    <div
      class="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2"
      data-testid={`oauth-client-${client.issuer}`}
    >
      <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{client.issuer}</code>
      <Badge variant="outline">{sourceLabel(client.source)}</Badge>
      <code class="text-xs text-muted-foreground">{client.clientId}</code>
      {#if client.hasSecret}
        <Badge variant="outline">{t('apps.oauthClientSecretSet')}</Badge>
      {/if}
      {#if client.connectionCount > 0}
        <span class="text-xs text-muted-foreground">
          {t('apps.oauthClientConnections', { count: client.connectionCount })}
        </span>
      {/if}
      <Button
        size="sm"
        variant="ghost"
        class="ml-auto text-destructive hover:text-destructive"
        disabled={busy || client.connectionCount > 0}
        title={client.connectionCount > 0 ? t('apps.oauthClientRemoveBlocked') : undefined}
        onclick={() => void remove(client)}
      >
        {t('apps.oauthClientRemove')}
      </Button>
    </div>
  {/each}

  {#if adding}
    <div class="space-y-2 rounded-xl border px-3 py-2.5" data-testid="oauth-client-form">
      <div class="grid gap-1.5">
        <Label for="oauth-client-issuer">{t('apps.oauthClientIssuer')}</Label>
        <Input
          id="oauth-client-issuer"
          class="h-8"
          bind:value={issuer}
          placeholder={t('apps.oauthClientIssuerPlaceholder')}
        />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="oauth-client-id">{t('apps.clientId')}</Label>
          <Input id="oauth-client-id" class="h-8" bind:value={clientId} />
        </div>
        <div class="grid gap-1.5">
          <Label for="oauth-client-secret">{t('apps.clientSecret')}</Label>
          <Input
            id="oauth-client-secret"
            class="h-8"
            type="password"
            autocomplete="off"
            bind:value={clientSecret}
            placeholder={t('apps.clientSecretPlaceholder')}
          />
        </div>
      </div>
      {#if existingWithSecret !== null}
        <label class="flex items-center gap-1.5 text-xs" data-testid="oauth-client-clear-secret">
          <Checkbox
            checked={clearSecret}
            disabled={clientSecret.length > 0}
            onCheckedChange={(checked) => (clearSecret = checked === true)}
          />
          {t('apps.oauthClientClearSecret')}
        </label>
      {/if}
      <div class="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || issuer.trim().length === 0 || clientId.trim().length === 0}
          onclick={() => void save()}
          data-testid="oauth-client-save"
        >
          {t('apps.oauthClientSave')}
        </Button>
        <Button size="sm" variant="ghost" onclick={resetForm} data-testid="oauth-client-cancel">
          {t('settings.mcpCancel')}
        </Button>
      </div>
    </div>
  {:else}
    <Button
      size="sm"
      variant="secondary"
      onclick={() => (adding = true)}
      data-testid="oauth-client-add"
    >
      {t('apps.oauthClientAdd')}
    </Button>
  {/if}
</section>
