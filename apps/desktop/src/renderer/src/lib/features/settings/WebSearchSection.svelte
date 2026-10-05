<script lang="ts">
  import type { WebSearchProviderId } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';

  /**
   * 「联网检索」section（docs/design/21-web-search.md，D62）：检索供应商
   * 三选一 + API key（存密钥表 `websearch:{provider}`）+ 连通性测试。
   * embedded=true 时隐藏标题与说明（对话内设置卡片自带），保存成功后回调
   * onSaved（inline setup 的继续对话钩子）。
   */
  let {
    testid,
    embedded = false,
    onSaved,
  }: {
    /** data-testid 前缀。 */
    testid: string;
    /** 紧凑形态：不渲染 section 标题与说明（对话内卡片场景）。 */
    embedded?: boolean;
    onSaved?: () => void;
  } = $props();

  const PROVIDERS: Array<{ id: WebSearchProviderId; name: string; consoleUrl: string }> = [
    { id: 'tavily', name: 'Tavily', consoleUrl: 'https://app.tavily.com' },
    { id: 'brave', name: 'Brave Search', consoleUrl: 'https://api-dashboard.search.brave.com' },
    { id: 'bocha', name: '博查 Bocha', consoleUrl: 'https://open.bochaai.com' },
  ];

  let provider = $state<WebSearchProviderId | ''>('');
  let key = $state('');
  let busy = $state(false);
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; text: string } | null>(null);

  const stored = $derived(settingsStore.settings?.webSearch.provider ?? null);
  /** 有未保存的修改（供应商/key 任一变化）。 */
  const dirty = $derived(provider !== '' && (stored !== provider || key.length > 0));

  // 同步已存配置到表单；用户编辑中（dirty）不覆盖。
  $effect(() => {
    if (dirty) return;
    provider = settingsStore.settings?.webSearch.provider ?? '';
    key = '';
  });

  /** 落盘供应商与 key（key 留空 = 保持不变）。 */
  async function persist(): Promise<void> {
    if (provider === '') throw new Error(t('settings.webSearchMissingProvider'));
    await settingsStore.update({ webSearch: { provider } });
    if (key.length > 0) {
      await settingsStore.setSearchKey(provider, key);
      key = '';
    }
  }

  async function save(): Promise<void> {
    busy = true;
    try {
      await persist();
      toast.success(t('settings.saved'));
      onSaved?.();
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function test(): Promise<void> {
    if (provider === '') return;
    testing = true;
    testResult = null;
    try {
      // 按设计「未保存先测」（不落库）：输入框有 key 用入参（服务端不存），
      // 留空则测已存 key。落库只经「保存」按钮。
      const result = await settingsStore.testSearch(provider, key.length > 0 ? key : undefined);
      if (result.ok) {
        testResult = {
          ok: true,
          text: t('settings.webSearchTestOk', {
            count: result.resultCount ?? 0,
            ms: result.elapsedMs ?? 0,
          }),
        };
        toast.success(testResult.text);
      } else {
        testResult = { ok: false, text: result.error ?? t('settings.webSearchTestFailed') };
        toast.error(t('settings.testFailed', { reason: testResult.text }));
      }
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      testing = false;
    }
  }

  async function clear(): Promise<void> {
    busy = true;
    try {
      if (stored !== null) await settingsStore.removeSearchKey(stored);
      await settingsStore.update({ webSearch: { provider: null } });
      provider = '';
      key = '';
      testResult = null;
      toast.success(t('settings.saved'));
    } finally {
      busy = false;
    }
  }
</script>

<section class="space-y-3" data-testid={`${testid}-section`}>
  {#if !embedded}
    <h3 class="text-sm font-medium">{t('settings.webSearchTitle')}</h3>
    <p class="text-xs text-muted-foreground">{t('settings.webSearchHint')}</p>
  {/if}

  <div class="space-y-3 rounded-xl border px-4 py-3.5">
    <div class="flex flex-wrap items-center gap-2" data-testid={`${testid}-status`}>
      {#if stored === null}
        <Badge variant="outline">{t('settings.webSearchNotConfigured')}</Badge>
      {:else}
        <Badge>{PROVIDERS.find((item) => item.id === stored)?.name ?? stored}</Badge>
      {/if}
      {#if testResult !== null}
        <span
          class="text-xs {testResult.ok
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-destructive'}"
          data-testid={`${testid}-test-result`}
        >
          {testResult.text}
        </span>
      {/if}
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1.5">
        <Label for={`${testid}-provider`}>{t('settings.webSearchProviderLabel')}</Label>
        <select
          id={`${testid}-provider`}
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          bind:value={provider}
          data-testid={`${testid}-provider`}
        >
          <option value="">—</option>
          {#each PROVIDERS as item (item.id)}
            <option value={item.id}>{item.name}</option>
          {/each}
        </select>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testid}-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testid}-key`}
          class="h-9"
          type="password"
          placeholder={stored !== null
            ? t('settings.providerKeySet')
            : t('settings.providerKeyPlaceholder')}
          bind:value={key}
          disabled={provider === ''}
          data-testid={`${testid}-key`}
        />
        {#if provider !== ''}
          <p class="text-xs text-muted-foreground">
            {t('settings.webSearchKeyHint', {
              url: PROVIDERS.find((item) => item.id === provider)?.consoleUrl ?? '',
            })}
          </p>
        {/if}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={busy || !dirty}
        onclick={() => void save()}
        data-testid={`${testid}-save`}
      >
        {t('settings.save')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || testing || provider === ''}
        onclick={() => void test()}
        data-testid={`${testid}-test`}
      >
        {testing ? t('settings.testing') : t('settings.test')}
      </Button>
      {#if stored !== null}
        <Button
          size="sm"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          disabled={busy}
          onclick={() => void clear()}
          data-testid={`${testid}-clear`}
        >
          {t('settings.webSearchClear')}
        </Button>
      {/if}
    </div>
  </div>
</section>
