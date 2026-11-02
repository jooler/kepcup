<script lang="ts">
  import { untrack } from 'svelte';
  import type { SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import PluginFieldForm from '$lib/features/plugins/PluginFieldForm.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { prefillBoolean, prefillString } from './setting-card-model';

  /**
   * 某个邮件插件的设置卡（mail.plugin）：选择已安装的邮件插件 → 改它声明的配置 →
   * 决定要不要交给这个 Bot。配置与启停都用扩展中心原有的 RPC（`plugins.config.set` /
   * `plugins.enableForBots` / `plugins.setBotPlugins`），保存后由 `completeCard` 核对。
   */

  let {
    botId,
    prefill = null,
    testid = 'setting-card-mail-plugin',
    onSaved,
  }: {
    botId: string;
    prefill?: SettingValues | null;
    testid?: string;
    onSaved?: (values?: SettingValues) => void;
  } = $props();

  const candidates = $derived(
    plugins.plugins.filter((plugin) => plugin.providesInstances.includes('mail')),
  );
  let pluginId = $state(untrack(() => prefillString(prefill, 'plugin') ?? ''));
  /** null = 跟随当前 Bot 的实际启用集；布尔值 = 用户刚改过。 */
  let forBotDraft = $state<boolean | null>(
    untrack(() => prefillBoolean(prefill, 'enabled') ?? null),
  );
  let configValues = $state<Record<string, unknown>>({});
  let storedSensitiveKeys = $state<string[]>([]);
  let configLoading = $state(false);
  let busy = $state(false);

  const selected = $derived(candidates.find((plugin) => plugin.id === pluginId) ?? null);
  const bot = $derived(contacts.bots.find((entry) => entry.id === botId) ?? null);
  const enabledIds = $derived(new Set(bot?.profile.runtime.plugin_ids ?? []));
  const forBot = $derived(forBotDraft ?? (selected !== null && enabledIds.has(selected.id)));

  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
    contacts.start();
    if (contacts.bots.length === 0) void contacts.refresh().catch(() => undefined);
  });

  // 插件清单 / Bot 启用集到位后选一个缺省插件（优先这个 Bot 已启用的）；预填的 id
  // 不在已安装清单里（插件被卸载）时也回退到缺省候选。
  $effect(() => {
    if (candidates.length === 0) return;
    if (pluginId.length > 0 && candidates.some((plugin) => plugin.id === pluginId)) return;
    const preferred =
      candidates.find((plugin) => enabledIds.has(plugin.id)) ??
      candidates.find((plugin) => plugin.enabled) ??
      candidates[0]!;
    pluginId = preferred.id;
  });

  // 换插件时拉一次它的配置（敏感字段只回「已存」，值永不回显）。
  $effect(() => {
    const plugin = selected;
    if (plugin === null || plugin.configFields.length === 0) {
      configValues = {};
      storedSensitiveKeys = [];
      return;
    }
    let cancelled = false;
    configLoading = true;
    void plugins
      .loadConfig(plugin.id)
      .then((config) => {
        if (cancelled) return;
        configValues = { ...config.values };
        storedSensitiveKeys = config.storedSensitiveKeys;
      })
      .catch(() => {
        if (!cancelled) configValues = {};
      })
      .finally(() => {
        if (!cancelled) configLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function explain(error: unknown): string {
    return error instanceof Error ? errorText(undefined, error.message) : String(error);
  }

  async function enableGlobally(): Promise<void> {
    if (selected === null || busy) return;
    busy = true;
    try {
      await plugins.setEnabled(selected.id, true);
      toast.success(t('mailCard.plugin.enabledGlobally', { plugin: selected.name }));
    } catch (error) {
      toast.error(explain(error));
    } finally {
      busy = false;
    }
  }

  async function save(): Promise<void> {
    const plugin = selected;
    if (plugin === null || busy) return;
    busy = true;
    try {
      if (plugin.configFields.length > 0) {
        await plugins.saveConfig(plugin.id, configValues);
      }
      if (bot !== null) {
        const current = bot.profile.runtime.plugin_ids ?? [];
        if (forBot && !current.includes(plugin.id)) {
          await core.call('plugins.enableForBots', { pluginId: plugin.id, botIds: [botId] });
        } else if (!forBot && current.includes(plugin.id)) {
          await core.call('plugins.setBotPlugins', {
            botId,
            pluginIds: current.filter((id) => id !== plugin.id),
          });
        }
      }
      toast.success(t('mailCard.plugin.saved'));
      onSaved?.({ plugin: plugin.id, enabled: forBot });
    } catch (error) {
      toast.error(explain(error));
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid gap-2" data-testid={testid}>
  {#if candidates.length === 0}
    <p class="text-xs text-muted-foreground" data-testid={`${testid}-empty`}>
      {t('mail.noPlugin')}
    </p>
    <div class="flex justify-end">
      <Button
        size="sm"
        variant="outline"
        onclick={() => shell.openExtensionCenter('market')}
        data-testid={`${testid}-market`}
      >
        {t('mail.openMarket')}
      </Button>
    </div>
  {:else}
    <Label for={`${testid}-plugin`}>{t('mail.pickPlugin')}</Label>
    <select
      id={`${testid}-plugin`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={pluginId}
      onchange={() => (forBotDraft = null)}
      data-testid={`${testid}-plugin`}
    >
      {#each candidates as plugin (plugin.id)}
        <option value={plugin.id}>{plugin.name}</option>
      {/each}
    </select>

    {#if selected !== null}
      {#if !selected.enabled}
        <p class="text-xs text-amber-700 dark:text-amber-400" data-testid={`${testid}-disabled`}>
          {t('mailCard.plugin.globalDisabled', { plugin: selected.name })}
        </p>
        <div class="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onclick={() => void enableGlobally()}
            data-testid={`${testid}-enable-global`}
          >
            {t('mailCard.plugin.enableGlobal')}
          </Button>
        </div>
      {/if}

      <label class="flex items-center gap-2 text-sm">
        <Checkbox
          checked={forBot}
          onCheckedChange={(checked) => (forBotDraft = checked === true)}
          data-testid={`${testid}-for-bot`}
        />
        {t('mailCard.plugin.forBot')}
      </label>
      {#if bot === null}
        <p class="text-xs text-muted-foreground" data-testid={`${testid}-bot-loading`}>
          {t('apps.catalog.loading')}
        </p>
      {/if}

      {#if selected.configFields.length > 0}
        <div class="grid gap-2 border-t pt-2">
          <p class="text-xs font-medium text-muted-foreground">
            {t('mailCard.plugin.configHeading')}
          </p>
          {#if configLoading}
            <p class="text-xs text-muted-foreground">{t('mail.testing')}</p>
          {:else}
            <PluginFieldForm
              fields={selected.configFields}
              bind:values={configValues}
              {storedSensitiveKeys}
              idScope={`${testid}-config`}
              testid={`${testid}-config`}
            />
          {/if}
        </div>
      {/if}

      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={busy || configLoading || bot === null}
          onclick={() => void save()}
          data-testid={`${testid}-save`}
        >
          {t('mailCard.save')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
