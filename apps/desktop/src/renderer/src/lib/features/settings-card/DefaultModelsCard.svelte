<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import ModelSelectField from '$lib/features/settings/ModelSelectField.svelte';
  import { nextLocalFromStore } from '$lib/features/settings/model-defaults-sync';
  import { applySettingItem } from './apply';
  import { prefillString } from './setting-card-model';

  /**
   * 默认主 / 轻量模型卡（设置目录 `models.default-main` / `models.default-light`，卡片键
   * `default-models`，todo/conversational-app-setup.md §4.2）：包住设置页同一个
   * `ModelSelectField`（选项 = 已配置 Key 的厂商对话模型），自带「应用」——经
   * `settings.items.apply` 做条目级 CAS（`expected` = 出卡时的当前值；失败续跑卡传 null 不比对）。
   * 设置页「模型」分区不用它（那里仍是原来的草稿 + 保存），行为不变。
   */
  let {
    itemId,
    embedded = true,
    prefill = null,
    expected = null,
    messageId,
    testid = 'setting-card-default-models',
    onSaved,
    onConflict,
  }: {
    itemId: string;
    /** 紧凑形态（对话内卡片）；false 时多一行说明。 */
    embedded?: boolean;
    /** Bot 的非敏感预填（`model` = 模型 ref）。 */
    prefill?: SettingValues | null;
    /** CAS 期望值（设置卡出卡时的 `before`）；null = 不比对。 */
    expected?: SettingValues | null;
    /** 从设置卡应用时带卡片消息 id（core 标 applied 并唤醒 Bot）。 */
    messageId?: string | undefined;
    testid?: string;
    onSaved?: (values: SettingValues) => void;
    /** CAS 冲突：当前值已在别处改过（卡片据此刷新对比后再让用户确认）。 */
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  const light = $derived(itemId === 'models.default-light');
  const stored = $derived(
    (light
      ? settingsStore.settings?.defaultLightModel
      : settingsStore.settings?.defaultMainModel) ?? '',
  );
  const hasPrefill = untrack(() => prefillString(prefill, 'model') !== null);
  let value = $state(untrack(() => prefillString(prefill, 'model') ?? ''));
  let busy = $state(false);

  // 没有预填时跟随已存值（快照晚到也能补上）；与设置页同一策略：只在已存值真的变了时
  // 才覆盖本地选择（model-defaults-sync.ts）。
  let lastApplied: string | null = null;
  $effect(() => {
    const storeValue = stored;
    if (hasPrefill) return;
    const next = nextLocalFromStore({
      storeValue,
      lastApplied,
      localValue: untrack(() => value),
    });
    value = next.localValue;
    lastApplied = next.lastApplied;
  });

  async function apply(): Promise<void> {
    if (value.length === 0 || busy) return;
    busy = true;
    try {
      const out = await applySettingItem({
        itemId,
        values: { model: value },
        expected,
        messageId,
      });
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

<div class="grid gap-1.5" data-testid={testid}>
  <Label for={`${testid}-select`}
    >{light ? t('settings.defaultLightModel') : t('settings.defaultMainModel')}</Label
  >
  {#if !embedded}
    <p class="text-xs text-muted-foreground">{t('settingCard.defaultModelsHint')}</p>
  {/if}
  <div class="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
    <div class="min-w-0 flex-1">
      <ModelSelectField bind:value id={`${testid}-select`} testid={`${testid}-select`} />
    </div>
    <Button
      size="sm"
      class="h-9"
      disabled={busy || value.length === 0}
      onclick={() => void apply()}
      data-testid={`${testid}-apply`}
    >
      {t('settingCard.apply')}
    </Button>
  </div>
</div>
