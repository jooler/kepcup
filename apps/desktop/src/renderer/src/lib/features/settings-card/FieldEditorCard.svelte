<script lang="ts">
  import type { SettingItem, SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { settingFieldText, t } from '$lib/i18n';
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
      case 'general.task-loop':
        return { ...(settings?.taskLoop ?? {}) };
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
  // Generic directory fields: number / toggle beyond the special-cased names
  // above (D93 setting cards reuse field-editor instead of a bespoke card).
  const numberNames = untrack(() =>
    item.fields
      .filter((field) => field.type === 'number' && field.name !== 'limit')
      .map((field) => field.name),
  );
  const toggleNames = untrack(() =>
    item.fields
      .filter((field) => field.type === 'toggle' && field.name !== 'enabled')
      .map((field) => field.name),
  );
  let numbers = $state<Record<string, number>>(
    Object.fromEntries(
      numberNames.map((name) => [name, typeof seeded[name] === 'number' ? seeded[name] : 0]),
    ),
  );
  let toggles = $state<Record<string, boolean>>(
    Object.fromEntries(toggleNames.map((name) => [name, seeded[name] !== false])),
  );
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
    for (const name of numberNames) {
      if (typeof current[name] === 'number') numbers[name] = current[name];
    }
    for (const name of toggleNames) {
      if (typeof current[name] === 'boolean') toggles[name] = current[name];
    }
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
      else if (field.type === 'number') out[field.name] = numbers[field.name] ?? 0;
      else if (field.type === 'toggle') out[field.name] = toggles[field.name] ?? false;
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
      <Label for={`${testid}-provider`}>{settingFieldText(item.id, field.name, field.label)}</Label>
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
    {:else if field.type === 'number'}
      <Label for={`${testid}-${field.name}`}>
        {settingFieldText(item.id, field.name, field.label)}
      </Label>
      <input
        id={`${testid}-${field.name}`}
        type="number"
        min={field.min}
        max={field.max}
        step={field.step}
        class="flex h-9 w-40 rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={numbers[field.name]}
        data-testid={`${testid}-${field.name}`}
      />
    {:else if field.type === 'toggle'}
      <label class="flex items-start gap-2 text-sm">
        <Checkbox
          bind:checked={toggles[field.name]}
          data-testid={`${testid}-${field.name}`}
        />
        <span class="grid gap-0.5">
          <span>{settingFieldText(item.id, field.name, field.label)}</span>
          {#if field.hint !== undefined}
            <span class="text-xs text-muted-foreground">{field.hint}</span>
          {/if}
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
