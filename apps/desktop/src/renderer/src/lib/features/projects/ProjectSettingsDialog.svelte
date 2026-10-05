<script lang="ts">
  import type { Project } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { projects } from '$lib/stores/projects.svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';

  let { open = $bindable(false), project }: { open: boolean; project: Project | null } = $props();

  // 名称不再是可编辑字段：项目名固定为所选文件夹的名字（bind 时取 basename）。
  let denyRead = $state('');
  let denyWrite = $state('');
  let ports = $state('');
  let loadedFor = $state<string | null>(null);

  $effect(() => {
    if (!open || project === null || loadedFor === project.id) return;
    denyRead = project.protectRules.denyRead.join('\n');
    denyWrite = project.protectRules.denyWrite.join('\n');
    ports = (project.allowedPorts ?? []).map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join('\n');
    loadedFor = project.id;
  });

  function parseLines(raw: string): string[] {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function parsePorts(raw: string): Project['allowedPorts'] {
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
    if (project === null) return;
    await projects.update(project.id, {
      protectRules: { denyRead: parseLines(denyRead), denyWrite: parseLines(denyWrite) },
      allowedPorts: parsePorts(ports),
    });
    open = false;
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
    if (project === null) return;
    await projects.remove(project.id);
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-lg" data-testid="project-settings-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('projects.settingsTitle')}</Dialog.Title>
      <Dialog.Description class="font-mono text-xs">{project?.path ?? ''}</Dialog.Description>
    </Dialog.Header>
    {#if project !== null}
      <div class="space-y-3">
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{t('projects.settingsDenyRead')}</span>
          <Textarea bind:value={denyRead} rows={5} class="font-mono text-xs" data-testid="project-deny-read-input" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{t('projects.settingsDenyWrite')}</span>
          <Textarea bind:value={denyWrite} rows={3} class="font-mono text-xs" data-testid="project-deny-write-input" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{t('projects.settingsPorts')}</span>
          <Textarea bind:value={ports} rows={2} class="font-mono text-xs" data-testid="project-ports-input" />
          <span class="block text-[10px] text-muted-foreground">{t('projects.settingsPortsHint')}</span>
        </label>
      </div>
      <Dialog.Footer class="mt-2 flex items-center gap-2">
        <Button
          variant={removeArmed ? 'destructive' : 'outline'}
          size="sm"
          onclick={armRemove}
          data-testid="project-remove"
          title={t('projects.removeBody', { name: project.name })}
        >
          {removeArmed ? t('projects.removeConfirm') : t('projects.removeCurrent')}
        </Button>
        <div class="flex-1"></div>
        <Button variant="outline" size="sm" onclick={() => (open = false)}>{t('contacts.cancel')}</Button>
        <Button size="sm" onclick={() => void save()} data-testid="project-save">{t('projects.save')}</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
