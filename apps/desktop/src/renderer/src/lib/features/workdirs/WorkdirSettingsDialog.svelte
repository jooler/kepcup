<script lang="ts">
  import type { Workdir, SettingValues } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { workdirs } from '$lib/stores/workdirs.svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Textarea } from '$lib/components/ui/textarea';
  import { revealDialogAnchor } from '$lib/features/settings/anchor-scroll';

  let {
    open = $bindable(false),
    workdir,
    anchor = $bindable(null),
    embedded = false,
    focus = 'protect' as 'protect' | 'ports',
    prefill: _prefill = null,
    onSaved,
  }: {
    open?: boolean;
    workdir: Workdir | null;
    /** 打开后要聚焦的锚点（对话内设置卡深链：workdir-protect / workdir-ports）；消费后复位。 */
    anchor?: string | null;
    /** 对话内设置卡：只显示保护规则或端口，并要求亲手确认。不采用 Bot 的预填。 */
    embedded?: boolean;
    focus?: 'protect' | 'ports';
    prefill?: SettingValues | null;
    onSaved?: () => void;
  } = $props();

  $effect(() => {
    const target = anchor;
    if (!open || target === null || workdir === null) return;
    anchor = null;
    void revealDialogAnchor(document, target);
  });

  let denyRead = $state('');
  let denyWrite = $state('');
  let ports = $state('');
  let loadedFor = $state<string | null>(null);
  let loadedEmbedded = $state<string | null>(null);
  let acknowledged = $state(false);
  let saving = $state(false);

  function loadFromWorkdir(current: Workdir): void {
    denyRead = current.protectRules.denyRead.join('\n');
    denyWrite = current.protectRules.denyWrite.join('\n');
    ports = (current.allowedPorts ?? []).map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join('\n');
  }

  $effect(() => {
    if (embedded || !open || workdir === null || loadedFor === workdir.id) return;
    loadFromWorkdir(workdir);
    loadedFor = workdir.id;
  });

  $effect(() => {
    if (!embedded || workdir === null || loadedEmbedded === workdir.id) return;
    loadFromWorkdir(workdir);
    loadedEmbedded = workdir.id;
    acknowledged = false;
  });

  function parseLines(raw: string): string[] {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function parsePorts(raw: string): Workdir['allowedPorts'] {
    const ranges: Array<[number, number]> = [];
    for (const line of parseLines(raw)) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(line);
      if (match === null) continue;
      const from = Number(match[1]);
      const to = match[2] !== undefined ? Number(match[2]) : from;
      if (Number.isNaN(from) || Number.isNaN(to) || from < 1 || to > 65535 || from > to) continue;
      ranges.push([from, to]);
    }
    return ranges.length > 0 ? ranges : null;
  }

  async function save(): Promise<void> {
    if (workdir === null) return;
    await workdirs.update(workdir.id, {
      protectRules: { denyRead: parseLines(denyRead), denyWrite: parseLines(denyWrite) },
      allowedPorts: parsePorts(ports),
    });
    open = false;
  }

  async function saveEmbedded(): Promise<void> {
    if (workdir === null || !acknowledged || saving) return;
    saving = true;
    try {
      if (focus === 'ports') {
        await workdirs.update(workdir.id, { allowedPorts: parsePorts(ports) });
      } else {
        await workdirs.update(workdir.id, {
          protectRules: { denyRead: parseLines(denyRead), denyWrite: parseLines(denyWrite) },
        });
      }
      onSaved?.();
    } catch {
      // workdirs.update 已经 toast 过失败原因。
    } finally {
      saving = false;
    }
  }

  let removeArmed = $state(false);
  let removeTimer: ReturnType<typeof setTimeout> | undefined;

  function armRemove(): void {
    if (!removeArmed) {
      removeArmed = true;
      clearTimeout(removeTimer);
      removeTimer = setTimeout(() => (removeArmed = false), 5000);
      return;
    }
    clearTimeout(removeTimer);
    removeArmed = false;
    void remove();
  }

  async function remove(): Promise<void> {
    if (workdir === null) return;
    await workdirs.remove(workdir.id);
    open = false;
  }
</script>

{#if embedded && workdir !== null}
  <div class="grid gap-2" data-testid="workdir-settings-embedded">
    {#if focus === 'protect'}
      <label class="block space-y-1">
        <span class="text-xs text-muted-foreground">{t('workdirs.settingsDenyRead')}</span>
        <Textarea bind:value={denyRead} rows={4} class="font-mono text-xs" data-testid="workdir-card-deny-read" />
      </label>
      <label class="block space-y-1">
        <span class="text-xs text-muted-foreground">{t('workdirs.settingsDenyWrite')}</span>
        <Textarea bind:value={denyWrite} rows={3} class="font-mono text-xs" data-testid="workdir-card-deny-write" />
      </label>
    {:else}
      <label class="block space-y-1">
        <span class="text-xs text-muted-foreground">{t('workdirs.settingsPorts')}</span>
        <Textarea bind:value={ports} rows={2} class="font-mono text-xs" data-testid="workdir-card-ports" />
        <span class="block text-[10px] text-muted-foreground">{t('workdirs.settingsPortsHint')}</span>
      </label>
    {/if}
    <label class="flex items-start gap-2 text-sm">
      <Checkbox bind:checked={acknowledged} data-testid="workdir-card-ack" />
      <span>{focus === 'ports' ? t('settingCard.workdir.portsAck') : t('settingCard.workdir.protectAck')}</span>
    </label>
    <div class="flex justify-end">
      <Button
        size="sm"
        disabled={!acknowledged || saving}
        onclick={() => void saveEmbedded()}
        data-testid="workdir-card-save"
      >
        {t('settingCard.apply')}
      </Button>
    </div>
  </div>
{:else}
<Dialog.Root bind:open>
  <Dialog.Content class="max-w-lg" data-testid="workdir-settings-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('workdirs.settingsTitle')}</Dialog.Title>
      <Dialog.Description class="font-mono text-xs">{workdir?.path ?? ''}</Dialog.Description>
    </Dialog.Header>
    {#if workdir !== null}
      <div class="space-y-3">
        <!-- data-settings-anchor：对话内设置卡「在设置中打开」的落点（settings-catalog 深链）。 -->
        <div class="space-y-3" data-settings-anchor="workdir-protect">
          <label class="block space-y-1">
            <span class="text-xs text-muted-foreground">{t('workdirs.settingsDenyRead')}</span>
            <Textarea bind:value={denyRead} rows={5} class="font-mono text-xs" data-testid="workdir-deny-read-input" />
          </label>
          <label class="block space-y-1">
            <span class="text-xs text-muted-foreground">{t('workdirs.settingsDenyWrite')}</span>
            <Textarea bind:value={denyWrite} rows={3} class="font-mono text-xs" data-testid="workdir-deny-write-input" />
          </label>
        </div>
        <label class="block space-y-1" data-settings-anchor="workdir-ports">
          <span class="text-xs text-muted-foreground">{t('workdirs.settingsPorts')}</span>
          <Textarea bind:value={ports} rows={2} class="font-mono text-xs" data-testid="workdir-ports-input" />
          <span class="block text-[10px] text-muted-foreground">{t('workdirs.settingsPortsHint')}</span>
        </label>
      </div>
      <Dialog.Footer class="mt-2 flex items-center gap-2">
        <Button
          variant={removeArmed ? 'destructive' : 'outline'}
          size="sm"
          onclick={armRemove}
          data-testid="workdir-remove"
          title={t('workdirs.removeBody', { name: workdir.name })}
        >
          {removeArmed ? t('workdirs.removeConfirm') : t('workdirs.removeCurrent')}
        </Button>
        <div class="flex-1"></div>
        <Button variant="outline" size="sm" onclick={() => (open = false)}>{t('contacts.cancel')}</Button>
        <Button size="sm" onclick={() => void save()} data-testid="workdir-save">{t('workdirs.save')}</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
{/if}
