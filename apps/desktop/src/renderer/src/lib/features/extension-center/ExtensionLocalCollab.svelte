<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    inkcopCollabEnabled,
    setInkcopCollabEnabled,
  } from '$lib/features/inkcop-collab';

  /**
   * 扩展中心 →「本机应用协作」（契约 v0.3）：
   * InkCop 卡片：启停 + 桥状态 chip + 说明 + API 密钥 + 可选服务地址。
   */

  let busy = $state(false);
  let online = $state<boolean | null>(null);
  let authError = $state(false);
  let enableOverride = $state<boolean | null>(null);
  let apiKeyDraft = $state('');
  let baseUrlDraft = $state('');
  let savingCreds = $state(false);
  let credsHydrated = $state(false);

  const enabled = $derived(
    enableOverride !== null
      ? enableOverride
      : inkcopCollabEnabled(settingsStore.settings),
  );

  $effect(() => {
    const settings = settingsStore.settings;
    if (settings === null) return;
    if (enableOverride !== null && settings.inkcopLocalCollab.enabled === enableOverride) {
      enableOverride = null;
    }
    if (!credsHydrated) {
      apiKeyDraft = settings.inkcopLocalCollab.apiKey ?? '';
      baseUrlDraft = settings.inkcopLocalCollab.baseUrl ?? '';
      credsHydrated = true;
    }
  });

  async function probe(): Promise<{
    online: boolean;
    authError?: boolean;
    discoveredApiKey?: string;
    discoveredBaseUrl?: string;
    tip?: string;
  }> {
    try {
      const health = (await core.call('inkcop.health', {})) as {
        online: boolean;
        authError?: boolean;
        discoveredApiKey?: string;
        discoveredBaseUrl?: string;
        tip?: string;
      };
      online = health.online === true;
      authError = health.authError === true;
      return health;
    } catch {
      online = false;
      authError = false;
      return { online: false };
    }
  }

  /** 密钥为空时用同机 endpoint.token 预填并落盘。 */
  async function maybePrefillFromProbe(health: {
    discoveredApiKey?: string;
    discoveredBaseUrl?: string;
  }): Promise<void> {
    const settings = settingsStore.settings;
    if (settings === null) return;
    const patch: { apiKey?: string; baseUrl?: string } = {};
    const storedKey = (settings.inkcopLocalCollab.apiKey ?? '').trim();
    if (storedKey.length === 0 && typeof health.discoveredApiKey === 'string' && health.discoveredApiKey.length > 0) {
      patch.apiKey = health.discoveredApiKey;
      apiKeyDraft = health.discoveredApiKey;
    }
    // 不自动写 baseUrl：同机默认走 endpoint；仅密钥预填。
    if (Object.keys(patch).length === 0) return;
    await settingsStore.update({
      inkcopLocalCollab: {
        enabled: settings.inkcopLocalCollab.enabled,
        ...patch,
      },
    });
  }

  onMount(() => {
    void (async () => {
      const health = await probe();
      await maybePrefillFromProbe(health);
    })();
  });

  async function toggle(next: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    enableOverride = next;
    try {
      const result = await setInkcopCollabEnabled(next);
      online = result.online;
      authError = result.authError === true;
      if (next && result.discoveredApiKey) {
        await maybePrefillFromProbe(result);
      }
      if (next && result.authError) {
        toast.message(t('extensionCenter.localCollab.inkcop.authToast'));
      } else if (next && !result.online) {
        toast.message(t('extensionCenter.localCollab.inkcop.offlineToast'));
      } else if (next) {
        toast.success(t('extensionCenter.localCollab.inkcop.enabledToast'));
      }
    } catch (error) {
      enableOverride = null;
      toast.error(
        t('extensionCenter.localCollab.inkcop.toggleFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      busy = false;
    }
  }

  async function persistCredentials(): Promise<void> {
    if (savingCreds) return;
    const settings = settingsStore.settings;
    if (settings === null) return;
    const nextKey = apiKeyDraft.trim();
    const nextUrl = baseUrlDraft.trim().replace(/\/$/, '');
    if (
      nextKey === (settings.inkcopLocalCollab.apiKey ?? '') &&
      nextUrl === (settings.inkcopLocalCollab.baseUrl ?? '')
    ) {
      return;
    }
    savingCreds = true;
    try {
      await settingsStore.update({
        inkcopLocalCollab: {
          enabled: settings.inkcopLocalCollab.enabled,
          apiKey: nextKey,
          baseUrl: nextUrl,
        },
      });
      const health = await probe();
      if (health.authError) {
        toast.message(t('extensionCenter.localCollab.inkcop.authToast'));
      } else if (!health.online) {
        toast.message(t('extensionCenter.localCollab.inkcop.offlineToast'));
      }
    } catch (error) {
      toast.error(
        t('extensionCenter.localCollab.inkcop.toggleFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      savingCreds = false;
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3" data-testid="extension-local-collab">
  <p class="text-xs text-muted-foreground">{t('extensionCenter.localCollab.hint')}</p>

  <div
    class="flex flex-col gap-2 rounded-xl border px-4 py-3.5"
    data-testid="local-collab-inkcop-card"
  >
    <label class="flex items-center gap-3" data-testid="local-collab-inkcop-enable">
      <Checkbox
        checked={enabled}
        disabled={busy}
        onCheckedChange={(checked) => void toggle(checked === true)}
        data-testid="local-collab-inkcop-checkbox"
      />
      <span class="flex min-w-0 flex-wrap items-center gap-1.5">
        <Label class="font-medium">{t('extensionCenter.localCollab.inkcop.enable')}</Label>
        {#if online === true}
          <Badge
            variant="outline"
            class="border-emerald-500/60 text-[10px] text-emerald-700 dark:text-emerald-400"
            data-testid="local-collab-inkcop-online"
          >
            {t('extensionCenter.localCollab.inkcop.online')}
          </Badge>
        {:else if authError}
          <Badge
            variant="outline"
            class="border-rose-500/60 text-[10px] text-rose-700 dark:text-rose-400"
            data-testid="local-collab-inkcop-auth-error"
          >
            {t('extensionCenter.localCollab.inkcop.authError')}
          </Badge>
        {:else if online === false}
          <Badge
            variant="outline"
            class="border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-400"
            data-testid="local-collab-inkcop-offline"
          >
            {t('extensionCenter.localCollab.inkcop.offline')}
          </Badge>
        {/if}
      </span>
    </label>
    <p
      class="pl-8 text-xs text-muted-foreground"
      data-testid="local-collab-inkcop-description"
    >
      {t('extensionCenter.localCollab.inkcop.description')}
    </p>

    <div class="mt-1 flex flex-col gap-2 pl-8" data-testid="local-collab-inkcop-creds">
      <div class="flex flex-col gap-1">
        <Label class="text-xs text-muted-foreground" for="inkcop-api-key">
          {t('extensionCenter.localCollab.inkcop.apiKey')}
        </Label>
        <Input
          id="inkcop-api-key"
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder={t('extensionCenter.localCollab.inkcop.apiKeyPlaceholder')}
          bind:value={apiKeyDraft}
          disabled={busy || savingCreds}
          onblur={() => void persistCredentials()}
          data-testid="local-collab-inkcop-api-key"
        />
      </div>
      <div class="flex flex-col gap-1">
        <Label class="text-xs text-muted-foreground" for="inkcop-base-url">
          {t('extensionCenter.localCollab.inkcop.baseUrl')}
        </Label>
        <Input
          id="inkcop-base-url"
          type="url"
          autocomplete="off"
          spellcheck={false}
          placeholder={t('extensionCenter.localCollab.inkcop.baseUrlPlaceholder')}
          bind:value={baseUrlDraft}
          disabled={busy || savingCreds}
          onblur={() => void persistCredentials()}
          data-testid="local-collab-inkcop-base-url"
        />
      </div>
    </div>
  </div>
</div>
