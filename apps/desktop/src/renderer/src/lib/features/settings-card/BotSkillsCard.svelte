<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { skillsStore } from '$lib/stores/skills.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { applySettingItem } from './apply';
  import { prefillBoolean, prefillString } from './setting-card-model';

  /**
   * 这个 Bot 的技能启停。列表与右栏「技能」页同一份 `skillsStore`，保存经
   * `settings.items.apply` 调用 `skills.enable` / `skills.disable`。只启停这个 Bot 自己的技能：
   * 公共技能（所有 Bot 共用）不在这里改，给「在技能页管理」。
   */
  let {
    botId,
    prefill = null,
    expected = null,
    messageId,
    testid = 'setting-card-bot-skills',
    onSaved,
    onConflict,
  }: {
    botId: string;
    prefill?: SettingValues | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    testid?: string;
    onSaved?: (values: SettingValues) => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  let skill = $state(untrack(() => prefillString(prefill, 'skill') ?? ''));
  let enabled = $state(untrack(() => prefillBoolean(prefill, 'enabled') ?? true));
  let busy = $state(false);

  $effect(() => {
    skillsStore.start();
    void skillsStore.load(botId, true).catch(() => undefined);
  });

  const skills = $derived(skillsStore.botId === botId ? skillsStore.skills : []);
  /** 选中的是公共技能（所有 Bot 共用，启停是全局的）。 */
  const selectedPublic = $derived(
    skills.find((entry) => entry.name === skill)?.scope === 'public',
  );

  $effect(() => {
    const list = skills;
    if (skill.length > 0 || list.length === 0) return;
    const first =
      list.find((entry) => entry.status !== 'incompatible' && entry.scope !== 'public') ??
      list[0];
    if (first !== undefined) {
      skill = first.name;
      enabled = first.status === 'active';
    }
  });

  async function apply(): Promise<void> {
    if (busy || skill.length === 0) return;
    busy = true;
    try {
      const out = await applySettingItem({
        itemId: 'bot.skills',
        values: { skill, enabled },
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

<div class="grid gap-2" data-testid={testid}>
  {#if skills.length === 0}
    <p class="text-xs text-muted-foreground">{t('settingCard.skills.empty')}</p>
  {:else}
    <Label for={`${testid}-skill`}>{t('settingCard.skills.pick')}</Label>
    <select
      id={`${testid}-skill`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={skill}
      data-testid={`${testid}-skill`}
    >
      {#each skills as entry (entry.name)}
        <option value={entry.name}>{entry.name}</option>
      {/each}
    </select>
    {#if selectedPublic}
      <!-- 公共技能所有 Bot 共用：这张「这个 Bot」的卡不改它（core 同样拒绝），退回技能页。 -->
      <p class="text-xs text-muted-foreground" data-testid={`${testid}-public`}>
        {t('settingCard.skills.publicHint', { name: skill })}
      </p>
      <div class="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onclick={() => shell.openExtensionCenter('skills')}
          data-testid={`${testid}-open-skills`}
        >
          {t('settingCard.skills.openSkillsPage')}
        </Button>
      </div>
    {:else}
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={enabled} data-testid={`${testid}-enabled`} />
        {t('skills.enable')}
      </label>
      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={busy || skill.length === 0}
          onclick={() => void apply()}
          data-testid={`${testid}-apply`}
        >
          {t('settingCard.apply')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
