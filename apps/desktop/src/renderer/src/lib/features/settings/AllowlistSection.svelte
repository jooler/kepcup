<script lang="ts">
  import type { AllowlistEntry, SettingValues } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';

  /**
   * 环境页的命令白名单：添加、启停、恢复默认。
   * `embedded`：对话内设置卡露出添加、启停和已有的风险提示。恢复默认会清掉自定义条目，
   * 留在设置页。加一条命令豁免是放宽，user-only 不预填：`prefill` 收下但不写进输入框。
   * 空模式不提交。添加或启停成功后 `onSaved`。
   */
  let {
    embedded = false,
    prefill: _prefill = null,
    onSaved,
  }: {
    /** 对话内设置卡。设置页不传。 */
    embedded?: boolean;
    /** 空白卡不采用。保留参数以对齐其它嵌入组件的调用形状。 */
    prefill?: SettingValues | null;
    /** 添加或启停成功后通知设置卡结卡。 */
    onSaved?: () => void;
  } = $props();

  let entries = $state<AllowlistEntry[]>([]);
  let pattern = $state('');
  let loaded = false;

  $effect(() => {
    if (loaded) return;
    loaded = true;
    void refresh();
  });

  async function refresh(): Promise<void> {
    const result = (await core.call('allowlist.list')) as { entries: AllowlistEntry[] };
    entries = result.entries;
  }

  async function add(): Promise<void> {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) return;
    const result = (await core.call('allowlist.add', { pattern: trimmed })) as {
      entries: AllowlistEntry[];
    };
    entries = result.entries;
    pattern = '';
    toast.success(t('settings.saved'));
    if (embedded) onSaved?.();
  }

  async function toggle(entry: AllowlistEntry): Promise<void> {
    const result = (await core.call('allowlist.update', {
      id: entry.id,
      enabled: !entry.enabled,
    })) as { entries: AllowlistEntry[] };
    entries = result.entries;
    if (embedded) onSaved?.();
  }

  async function reset(): Promise<void> {
    const result = (await core.call('allowlist.reset')) as { entries: AllowlistEntry[] };
    entries = result.entries;
  }
</script>

<section
  class="space-y-3"
  data-testid={embedded ? 'environment-allowlist-embedded' : 'settings-allowlist'}
>
  {#if !embedded}
    <h3 class="text-sm font-medium">{t('allowlist.settingsSection')}</h3>
  {/if}
  <p class="text-xs text-muted-foreground">{t('allowlist.note')}</p>

  <div class="flex items-center gap-2">
    <Input
      class="max-w-72"
      placeholder={t('allowlist.addPlaceholder')}
      bind:value={pattern}
      data-testid="allowlist-add-input"
    />
    <Button size="sm" variant="outline" onclick={() => void add()} data-testid="allowlist-add">
      {t('allowlist.add')}
    </Button>
    {#if !embedded}
      <Button size="sm" variant="ghost" onclick={() => void reset()} data-testid="allowlist-reset">
        {t('allowlist.reset')}
      </Button>
    {/if}
  </div>
  <p class="text-xs text-amber-600 dark:text-amber-400">{t('allowlist.addWarning')}</p>

  <ul class="space-y-1" data-testid="allowlist-list">
    {#each entries as entry (entry.id)}
      <li class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm" data-testid={`allowlist-entry-${entry.id}`}>
        <code class="min-w-0 flex-1 truncate">{entry.pattern}</code>
        <Badge variant="outline">{entry.builtin ? t('allowlist.builtin') : t('allowlist.custom')}</Badge>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-2 text-xs"
          onclick={() => void toggle(entry)}
          data-testid={`allowlist-toggle-${entry.id}`}
        >
          {entry.enabled ? t('allowlist.enabled') : t('allowlist.disabled')}
        </Button>
      </li>
    {:else}
      <li class="text-xs text-muted-foreground">{t('allowlist.empty')}</li>
    {/each}
  </ul>
</section>
