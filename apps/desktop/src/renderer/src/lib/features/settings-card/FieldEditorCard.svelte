<script lang="ts">
  import type { SettingItem, SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { settingFieldText, settingOptionText, t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import ModelSelectField from '$lib/features/settings/ModelSelectField.svelte';
  import { applySettingItem } from './apply';
  import {
    controlDefault,
    fieldControl,
    seedValues,
    valuesFromState,
    type FieldControlKind,
  } from './field-editor-model';

  /**
   * `card: 'field-editor'` 的通用卡片（todo/settings-catalog-registry.md §4.3.5）：默认按
   * 目录字段的元数据渲染（toggle / text / number / 静态下拉 / 智能体 / 厂商 / 模型），
   * 新增简单条目零改动出卡；种子值按 `fields[].path`（缺省 = 字段名）从 settings 快照取。
   * 四个有联动或 i18n 语义的条目保留专用分支（SPECIAL_ITEM_IDS）。
   * 保存走 `settings.items.apply`（条目级 CAS，与设置页落到同一个 core 服务）。
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

  /** 专用分支：并发上限（provider 联动 limit + 「默认」伪选项）、开机启动（i18n 标签与
   * OS 级提示）、组件审查模型（i18n 提示）、默认智能体（「无」空选项）。 */
  const SPECIAL_ITEM_IDS = new Set([
    'models.concurrency',
    'general.launch-at-login',
    'models.widget-review',
    'agents.default',
  ]);
  const special = SPECIAL_ITEM_IDS.has(item.id);

  const hasPrefill = untrack(() => prefill !== null && Object.keys(prefill).length > 0);
  const seeded = untrack(() => seedValues(item, hasPrefill ? prefill : null, settingsStore.settings));

  /** 按控件类型分桶的可绑定状态（Svelte 绑定需要具体类型，不能绑 unknown）。 */
  function bucket<K extends FieldControlKind>(kind: K) {
    const out: Record<string, unknown> = {};
    for (const field of item.fields) {
      if (field.sensitive || fieldControl(field) !== kind) continue;
      const value = seeded[field.name] ?? controlDefault(field);
      if (kind === 'number') out[field.name] = typeof value === 'number' ? value : controlDefault(field);
      else if (kind === 'toggle') out[field.name] = value === true;
      else out[field.name] = typeof value === 'string' ? value : '';
    }
    return out;
  }

  let toggles: Record<string, boolean> = $state(untrack(() => bucket('toggle') as Record<string, boolean>));
  let texts: Record<string, string> = $state(untrack(() => bucket('text') as Record<string, string>));
  let numbers: Record<string, number> = $state(untrack(() => bucket('number') as Record<string, number>));
  let selects: Record<string, string> = $state(untrack(() => bucket('select-static') as Record<string, string>));
  let agentSelects: Record<string, string> = $state(untrack(() => bucket('select-agents') as Record<string, string>));
  let providerSelects: Record<string, string> = $state(untrack(() => bucket('select-providers') as Record<string, string>));
  let models: Record<string, string> = $state(untrack(() => bucket('model') as Record<string, string>));
  // 专用分支的具名控件（历史默认与绑定类型同旧实现）。
  let model = $state(typeof seeded.model === 'string' ? seeded.model : '');
  let provider = $state(typeof seeded.provider === 'string' ? seeded.provider : 'default');
  let limit = $state(typeof seeded.limit === 'number' ? seeded.limit : 4);
  let agent = $state(typeof seeded.agent === 'string' ? seeded.agent : '');
  let enabled = $state(seeded.enabled !== false);
  let busy = $state(false);
  let synced = false;

  function resync(): void {
    const current = seedValues(item, null, settingsStore.settings);
    const of = (name: string): unknown => current[name];
    for (const field of item.fields) {
      if (field.sensitive) continue;
      const value = of(field.name);
      switch (fieldControl(field)) {
        case 'toggle':
          if (typeof value === 'boolean') toggles[field.name] = value;
          break;
        case 'text':
          if (typeof value === 'string') texts[field.name] = value;
          break;
        case 'number':
          if (typeof value === 'number') numbers[field.name] = value;
          break;
        case 'select-static':
          if (typeof value === 'string') selects[field.name] = value;
          break;
        case 'select-agents':
          if (typeof value === 'string') agentSelects[field.name] = value;
          break;
        case 'select-providers':
          if (typeof value === 'string') providerSelects[field.name] = value;
          break;
        case 'model':
          if (typeof value === 'string') models[field.name] = value;
          break;
        default:
          break;
      }
    }
    if (typeof current.model === 'string') model = current.model;
    if (typeof current.provider === 'string') provider = current.provider;
    if (typeof current.limit === 'number') limit = current.limit;
    if (typeof current.agent === 'string') agent = current.agent;
    if (typeof current.enabled === 'boolean') enabled = current.enabled;
  }

  $effect(() => {
    if (hasPrefill || settingsStore.settings === null || synced) return;
    synced = true;
    resync();
  });

  const needsAgents = $derived(item.fields.some((field) => field.options === 'agents'));
  $effect(() => {
    if (!needsAgents) return;
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });

  /** 当前选中的智能体（专用 agent 控件或通用 select-agents 字段），用于选项目录补全。 */
  const currentAgentId = $derived.by(() => {
    const generic = item.fields.find(
      (field) => !field.sensitive && fieldControl(field) === 'select-agents',
    );
    const id = generic === undefined ? agent : agentSelects[generic.name] ?? '';
    return id.length > 0 ? agentsStore.get(id) : null;
  });
  const agentOptions = $derived.by(() => {
    const list = agentsStore.agents.filter((entry) => entry.enabled);
    const current = currentAgentId;
    return current !== null && !list.includes(current) ? [...list, current] : list;
  });
  const providerOptions = $derived(settingsStore.providers);

  function values(): SettingValues {
    const state: SettingValues = {};
    for (const field of item.fields) {
      if (field.sensitive) continue;
      // 专用分支的控件绑定具名状态，优先于通用桶（两者只对专用条目分开维护）。
      if (special) {
        if (field.name === 'model') {
          state.model = model;
          continue;
        }
        if (field.name === 'provider') {
          state.provider = provider;
          continue;
        }
        if (field.name === 'limit') {
          state.limit = limit;
          continue;
        }
        if (field.name === 'agent') {
          state.agent = agent;
          continue;
        }
        if (field.name === 'enabled') {
          state.enabled = enabled;
          continue;
        }
      }
      switch (fieldControl(field)) {
        case 'toggle':
          state[field.name] = toggles[field.name] ?? false;
          break;
        case 'text':
          state[field.name] = texts[field.name] ?? '';
          break;
        case 'number':
          state[field.name] = numbers[field.name] ?? (controlDefault(field) as number);
          break;
        case 'select-static':
          state[field.name] = selects[field.name] ?? '';
          break;
        case 'select-agents':
          state[field.name] = agentSelects[field.name] ?? '';
          break;
        case 'select-providers':
          state[field.name] = providerSelects[field.name] ?? '';
          break;
        case 'model':
          state[field.name] = models[field.name] ?? '';
          break;
        default:
          // 不支持的字段不提交（卡上已提示去设置页改）。
          break;
      }
    }
    return valuesFromState(item, state);
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
    {#if field.sensitive}
      <!-- 敏感字段永不经卡片渲染（只可能在 form 卡的专用组件里由用户手填） -->
    {:else if special && field.name === 'model'}
      <Label for={`${testid}-model`}>{t('settings.widgetReviewModel')}</Label>
      <ModelSelectField bind:value={model} id={`${testid}-model`} testid={`${testid}-model`} />
      <p class="text-xs text-muted-foreground">{t('settings.widgetReviewModelHint')}</p>
    {:else if special && field.name === 'provider'}
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
    {:else if special && field.name === 'limit'}
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
    {:else if special && field.name === 'agent'}
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
    {:else if special && field.name === 'enabled'}
      <label class="flex items-start gap-2 text-sm">
        <Checkbox bind:checked={enabled} data-testid={`${testid}-enabled`} />
        <span class="grid gap-0.5">
          <span>{t('settings.launchAtLogin')}</span>
          <span class="text-xs text-muted-foreground">{t('settings.launchAtLoginHint')}</span>
        </span>
      </label>
    {:else if fieldControl(field) === 'toggle'}
      <label class="flex items-start gap-2 text-sm">
        <Checkbox bind:checked={toggles[field.name]} data-testid={`${testid}-${field.name}`} />
        <span class="grid gap-0.5">
          <span>{settingFieldText(item.id, field.name, field.label)}</span>
          {#if field.hint !== undefined}
            <span class="text-xs text-muted-foreground">{field.hint}</span>
          {/if}
        </span>
      </label>
    {:else if fieldControl(field) === 'text'}
      <Label for={`${testid}-${field.name}`}>
        {settingFieldText(item.id, field.name, field.label)}
      </Label>
      <input
        id={`${testid}-${field.name}`}
        type="text"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={texts[field.name]}
        data-testid={`${testid}-${field.name}`}
      />
    {:else if fieldControl(field) === 'number'}
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
    {:else if fieldControl(field) === 'select-static'}
      <Label for={`${testid}-${field.name}`}>
        {settingFieldText(item.id, field.name, field.label)}
      </Label>
      <select
        id={`${testid}-${field.name}`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={selects[field.name]}
        data-testid={`${testid}-${field.name}`}
      >
        {#each field.staticOptions ?? [] as option (option.value)}
          <option value={option.value}>
            {settingOptionText(item.id, field.name, option.value, option.label)}
          </option>
        {/each}
      </select>
    {:else if fieldControl(field) === 'select-agents'}
      <Label for={`${testid}-${field.name}`}>
        {settingFieldText(item.id, field.name, field.label)}
      </Label>
      <select
        id={`${testid}-${field.name}`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={agentSelects[field.name]}
        data-testid={`${testid}-${field.name}`}
      >
        {#each agentOptions as option (option.id)}
          <option value={option.id}>{option.name}</option>
        {/each}
      </select>
    {:else if fieldControl(field) === 'select-providers'}
      <Label for={`${testid}-${field.name}`}>
        {settingFieldText(item.id, field.name, field.label)}
      </Label>
      <select
        id={`${testid}-${field.name}`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={providerSelects[field.name]}
        data-testid={`${testid}-${field.name}`}
      >
        {#each providerOptions as option (option.id)}
          <option value={option.id}>{option.name}</option>
        {/each}
      </select>
    {:else if fieldControl(field) === 'model'}
      <Label for={`${testid}-${field.name}`}>
        {settingFieldText(item.id, field.name, field.label)}
      </Label>
      <ModelSelectField
        bind:value={models[field.name]}
        id={`${testid}-${field.name}`}
        testid={`${testid}-${field.name}`}
      />
    {:else}
      <div class="grid gap-0.5 text-sm">
        <span>{settingFieldText(item.id, field.name, field.label)}</span>
        <span class="text-xs text-muted-foreground">{t('settingCard.fieldUnsupported')}</span>
      </div>
    {/if}
  {/each}
  <div class="flex justify-end">
    <Button size="sm" disabled={busy} onclick={() => void apply()} data-testid={`${testid}-apply`}>
      {t('settingCard.apply')}
    </Button>
  </div>
</div>
