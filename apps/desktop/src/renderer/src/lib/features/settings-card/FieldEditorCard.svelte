<script lang="ts">
  import type { SettingItem, SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import ModelSelectField from '$lib/features/settings/ModelSelectField.svelte';
  import { applySettingItem } from './apply';

  /**
   * 目录里字段简单、设置页控件又嵌在大分区里的条目（审查模型、并发、默认智能体、
   * 开机启动）。选项与设置页同一份 store，保存走 `settings.items.apply`
   * （条目级 CAS，与设置页落到同一个 core 服务）。右栏 / 设置页原有分区不用它。
   */
  let {
    item,
    prefill = null,
    expected = null,
    messageId,
    testid = 'setting-card-fields',
    onSaved,
    onConflict,
  }: {
    item: SettingItem;
    prefill?: SettingValues | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    testid?: string;
    onSaved?: (values: SettingValues) => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  function stored(): SettingValues {
    const settings = settingsStore.settings;
    switch (item.id) {
      case 'models.widget-review':
        return { model: settings?.widgetReviewModel ?? '' };
      case 'models.concurrency':
        return { provider: 'default', limit: settings?.providerConcurrency.default ?? 4 };
      case 'agents.default':
        return { agent: settings?.defaultAgentId ?? '' };
      case 'general.launch-at-login':
        return { enabled: settings?.launchAtLogin ?? true };
      default:
        return {};
    }
  }

  const seeded = untrack(() => ({ ...stored(), ...(prefill ?? {}) }));
  let model = $state(typeof seeded.model === 'string' ? seeded.model : '');
  let provider = $state(typeof seeded.provider === 'string' ? seeded.provider : 'default');
  let limit = $state(typeof seeded.limit === 'number' ? seeded.limit : 4);
  let agent = $state(typeof seeded.agent === 'string' ? seeded.agent : '');
  let enabled = $state(seeded.enabled !== false);
  let busy = $state(false);
  const hasPrefill = untrack(() => prefill !== null && Object.keys(prefill).length > 0);
  let synced = false;

  $effect(() => {
    if (hasPrefill || settingsStore.settings === null || synced) return;
    synced = true;
    const current = stored();
    if (typeof current.model === 'string') model = current.model;
    if (typeof current.provider === 'string') provider = current.provider;
    if (typeof current.limit === 'number') limit = current.limit;
    if (typeof current.agent === 'string') agent = current.agent;
    if (typeof current.enabled === 'boolean') enabled = current.enabled;
  });

  const needsAgents = $derived(item.fields.some((field) => field.options === 'agents'));
  $effect(() => {
    if (!needsAgents) return;
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });

  const agentOptions = $derived.by(() => {
    const list = agentsStore.agents.filter((entry) => entry.enabled);
    const current = agent.length > 0 ? agentsStore.get(agent) : null;
    return current !== null && !list.includes(current) ? [...list, current] : list;
  });
  const providerOptions = $derived(settingsStore.providers);

  function values(): SettingValues {
    const out: SettingValues = {};
    for (const field of item.fields) {
      if (field.sensitive) continue;
      if (field.name === 'model') out.model = model;
      else if (field.name === 'provider') out.provider = provider;
      else if (field.name === 'limit') out.limit = limit;
      else if (field.name === 'agent') out.agent = agent;
      else if (field.name === 'enabled') out.enabled = enabled;
    }
    return out;
  }

  async function apply(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const next = values();
      const out = await applySettingItem({ itemId: item.id, values: next, expected, messageId });
      if (out.status === 'conflict') {
        onConflict?.(out.current);
        return;
      }
      toast.success(t('settingCard.appliedToast'));
      await settingsStore.refresh().catch(() => undefined);
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
  {#each item.fields as field (field.name)}
    {#if field.name === 'model'}
      <Label for={`${testid}-model`}>{t('settings.widgetReviewModel')}</Label>
      <ModelSelectField bind:value={model} id={`${testid}-model`} testid={`${testid}-model`} />
      <p class="text-xs text-muted-foreground">{t('settings.widgetReviewModelHint')}</p>
    {:else if field.name === 'provider'}
      <Label for={`${testid}-provider`}>{field.label}</Label>
      <select
        id={`${testid}-provider`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={provider}
        data-testid={`${testid}-provider`}
      >
        <option value="default">{t('settingCard.concurrencyDefault')}</option>
        {#each providerOptions as option (option.id)}
          <option value={option.id}>{option.name}</option>
        {/each}
      </select>
    {:else if field.name === 'limit'}
      <Label for={`${testid}-limit`}>{t('settings.concurrency')}</Label>
      <input
        id={`${testid}-limit`}
        type="number"
        min="1"
        max="16"
        class="flex h-9 w-24 rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={limit}
        data-testid={`${testid}-limit`}
      />
    {:else if field.name === 'agent'}
      <Label for={`${testid}-agent`}>{t('agents.defaultAgent')}</Label>
      <select
        id={`${testid}-agent`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={agent}
        data-testid={`${testid}-agent`}
      >
        <option value="">{t('agents.defaultAgentNone')}</option>
        {#each agentOptions as option (option.id)}
          <option value={option.id}>{option.name}</option>
        {/each}
      </select>
    {:else if field.name === 'enabled'}
      <label class="flex items-start gap-2 text-sm">
        <Checkbox bind:checked={enabled} data-testid={`${testid}-enabled`} />
        <span class="grid gap-0.5">
          <span>{t('settings.launchAtLogin')}</span>
          <span class="text-xs text-muted-foreground">{t('settings.launchAtLoginHint')}</span>
        </span>
      </label>
    {/if}
  {/each}
  <div class="flex justify-end">
    <Button size="sm" disabled={busy} onclick={() => void apply()} data-testid={`${testid}-apply`}>
      {t('settingCard.apply')}
    </Button>
  </div>
</div>
