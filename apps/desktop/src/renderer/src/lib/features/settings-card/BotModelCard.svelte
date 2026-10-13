<script lang="ts">
  import type { Bot, SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import { nextLocalFromStore } from '$lib/features/settings/model-defaults-sync';
  import { applySettingItem } from './apply';
  import { prefillString } from './setting-card-model';

  /**
   * Bot 模型片段卡（设置目录 `bot.model` / `bot.light-model`，卡片键 `bot-model`，
   * todo/conversational-app-setup.md §4.2）：与 Bot 配置表单同一份选项（已配置 Key 的厂商对话
   * 模型，留空 = 跟随默认），自带「应用」——经 `settings.items.apply`（target = 该 Bot）做条目级
   * CAS，core 落到同一个 `bots.update`。右栏 Bot 配置表单不用它，行为不变。
   */
  let {
    itemId,
    botId,
    prefill = null,
    expected = null,
    messageId,
    testid = 'setting-card-bot-model',
    onSaved,
    onConflict,
  }: {
    itemId: string;
    /** 被修改的 Bot。 */
    botId: string;
    /** Bot 的非敏感预填（`model` = 模型 ref，空串 = 跟随默认）。 */
    prefill?: SettingValues | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    testid?: string;
    onSaved?: (values: SettingValues) => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  const light = $derived(itemId === 'bot.light-model');

  /** 会话快照里的 Bot（群成员 / 单聊 Bot），兜底通讯录（core 推 bot.updated 后更新）。 */
  const bot = $derived.by((): Bot | null => {
    const current = chat.current;
    return (
      contacts.bots.find((entry) => entry.id === botId) ??
      current?.members.find((member) => member.bot.id === botId)?.bot ??
      (current?.conversation.bot?.id === botId ? current.conversation.bot : null) ??
      null
    );
  });
  const stored = $derived(
    (light ? bot?.profile.runtime.light_model : bot?.profile.runtime.model) ?? '',
  );
  const hasPrefill = untrack(() => typeof prefill?.model === 'string');
  let value = $state(untrack(() => prefillString(prefill, 'model') ?? ''));
  let busy = $state(false);

  /** 已存的 ref 不在可选项里（厂商 Key 被删）时仍作为一项显示，免得下拉显示成别的值。 */
  const options = $derived.by(() => {
    const available = settingsStore.availableModelOptions;
    const extra = [stored, value].filter(
      (ref, index, list) =>
        ref.length > 0 &&
        list.indexOf(ref) === index &&
        !available.some((option) => option.ref === ref),
    );
    return [
      ...available,
      ...extra.map((ref) => ({ ref, label: t('contacts.modelUnavailable', { ref }) })),
    ];
  });

  // 没有预填时跟随已存值；只在已存值真的变了时才覆盖本地选择（model-defaults-sync.ts）。
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
    if (busy) return;
    busy = true;
    try {
      const out = await applySettingItem({
        itemId,
        values: { model: value },
        expected,
        target: { botId },
        messageId,
      });
      if (out.status === 'conflict') {
        onConflict?.(out.current);
        return;
      }
      toast.success(t('settingCard.appliedToast'));
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
  <Label for={`${testid}-select`}>
    {light ? t('contacts.lightModel') : t('contacts.mainModel')}{#if bot !== null}
      · {bot.name}{/if}
  </Label>
  <div class="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
    <select
      id={`${testid}-select`}
      class="flex h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value
      data-testid={`${testid}-select`}
    >
      <option value="">
        {light
          ? t('settingCard.botModel.followDefaultLight')
          : t('setupCard.botModelFollowDefault')}
      </option>
      {#each options as option (option.ref)}
        <option value={option.ref}>{option.label}</option>
      {/each}
    </select>
    <Button
      size="sm"
      class="h-9"
      disabled={busy}
      onclick={() => void apply()}
      data-testid={`${testid}-apply`}
    >
      {t('settingCard.apply')}
    </Button>
  </div>
</div>
