<script lang="ts">
  import { FolderPlus, RefreshCw } from '@lucide/svelte';
  import { t, errorText } from '$lib/i18n';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { TeamWorkdirPickerState } from './team-workdir-picker.svelte';

  /**
   * 团队工作路径选择器（member-bots B-10）：`team.bots.workdirOptions` 的选项集
   * 分组展示（admin 启用根 / 我的目录，带来源徽章），支持 `workdirMkdir` 在本人
   * workdirs 子树内新建子文件夹。不做自由路径输入——成员永不浏览任意 FS；
   * 越界 / 非法目录名以服务端错误码内联呈现（WORKDIR_NOT_ALLOWED / INVALID_INPUT）。
   */
  let {
    source,
    selected = null,
    onSelect,
    adminOnly = false,
    compact = false,
  }: {
    source: SourceId;
    /** 当前选中路径（高亮行；null = 未选）。 */
    selected?: string | null;
    onSelect: (path: string) => void;
    /** public Bot 只能落在管理根（B-10）：我的目录分组不展示。 */
    adminOnly?: boolean;
    /** 紧凑形态（访谈目录卡内嵌）。 */
    compact?: boolean;
  } = $props();

  const picker = new TeamWorkdirPickerState(source, { adminOnly });

  // 闭包内引用 props（避免只捕获初值）：mode 切换 adminOnly 即时生效。
  $effect(() => {
    picker.sync(source, adminOnly);
  });
  $effect(() => {
    void picker.refresh();
  });

  let mkdirFor = $state<string | null | undefined>(undefined);
  let mkdirName = $state('');

  function startMkdir(parentPath: string | null): void {
    mkdirFor = parentPath;
    mkdirName = '';
    picker.mkdirError = null;
  }

  async function confirmMkdir(): Promise<void> {
    const parent = mkdirFor === undefined ? undefined : mkdirFor;
    const path = await picker.mkdir(mkdirName, parent ?? undefined);
    if (path !== null) {
      mkdirFor = undefined;
      mkdirName = '';
      onSelect(path);
    }
  }

  function pathLabel(path: string): string {
    // 全路径可读性差：展示时截断前缀（title 里保留全路径）。
    return path.length > 42 ? `…${path.slice(-41)}` : path;
  }
</script>

<div class="space-y-2" data-testid="team-workdir-picker">
  {#if picker.loading && !picker.loaded}
    <p class="text-xs text-muted-foreground" data-testid="team-workdir-loading">
      {t('teamBot.workdirLoading')}
    </p>
  {:else if picker.loadError !== null}
    <div class="space-y-1" data-testid="team-workdir-error">
      <p class="text-xs text-destructive">{errorText(picker.loadError, t('teamBot.workdirLoadFailed'))}</p>
      <Button size="sm" variant="outline" onclick={() => void picker.refresh()}>
        {t('common.refresh')}
      </Button>
    </div>
  {:else}
    {#if picker.groups.admin.length > 0}
      <div class="space-y-1">
        {#if !compact}
          <p class="text-xs font-medium">{t('teamBot.workdirSource.admin')}</p>
        {/if}
        <ul class="space-y-0.5">
          {#each picker.groups.admin as option (option.path)}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent
                  {selected === option.path ? 'border-primary/50 bg-accent' : ''}"
                onclick={() => onSelect(option.path)}
                title={option.path}
                data-selected={selected === option.path ? 'true' : undefined}
                data-testid={`team-workdir-option-${option.path}`}
              >
                <span
                  class="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] text-primary"
                  data-testid="team-workdir-source-badge">{t('teamBot.workdirSource.admin')}</span
                >
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{option.name}</span>
                  <span class="block truncate text-xs text-muted-foreground">{pathLabel(option.path)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if !adminOnly && picker.groups.member.length > 0}
      <div class="space-y-1">
        <p class="flex items-center gap-2 text-xs font-medium">
          {t('teamBot.workdirSource.member')}
          <button
            type="button"
            class="flex items-center gap-1 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
            onclick={() => startMkdir(null)}
            title={t('teamBot.workdirMkdirAtRoot')}
            data-testid="team-workdir-mkdir-root"
          >
            <FolderPlus class="size-3.5" aria-hidden="true" />
          </button>
        </p>
        <ul class="space-y-0.5">
          {#each picker.groups.member as option (option.path)}
            <li class="flex items-center gap-1">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent
                  {selected === option.path ? 'border-primary/50 bg-accent' : ''}"
                onclick={() => onSelect(option.path)}
                title={option.path}
                data-selected={selected === option.path ? 'true' : undefined}
                data-testid={`team-workdir-option-${option.path}`}
              >
                <span
                  class="shrink-0 rounded-full bg-emerald-500/10 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
                  >{t('teamBot.workdirSource.member')}</span
                >
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{option.name}</span>
                  <span class="block truncate text-xs text-muted-foreground">{pathLabel(option.path)}</span>
                </span>
              </button>
              <button
                type="button"
                class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onclick={() => startMkdir(option.path)}
                title={t('teamBot.workdirMkdirUnder', { name: option.name })}
                aria-label={t('teamBot.workdirMkdirUnder', { name: option.name })}
                data-testid={`team-workdir-mkdir-${option.path}`}
              >
                <FolderPlus class="size-3.5" aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if picker.groups.admin.length === 0 && (adminOnly || picker.groups.member.length === 0)}
      <p class="text-xs text-muted-foreground" data-testid="team-workdir-empty">
        {t('teamBot.workdirEmpty')}
      </p>
    {/if}
    {#if mkdirFor !== undefined}
      <div class="space-y-1.5 rounded-lg border border-dashed p-2" data-testid="team-workdir-mkdir-form">
        <p class="text-xs text-muted-foreground">
          {mkdirFor === null ? t('teamBot.workdirMkdirAtRoot') : t('teamBot.workdirMkdirUnder', { name: pathLabel(mkdirFor) })}
        </p>
        <div class="flex items-center gap-2">
          <Input
            bind:value={mkdirName}
            placeholder={t('teamBot.workdirMkdirPlaceholder')}
            class="h-8 bg-background text-sm"
            data-testid="team-workdir-mkdir-input"
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void confirmMkdir();
              }
            }}
          />
          <Button
            size="sm"
            class="h-8"
            disabled={picker.creating || mkdirName.trim().length === 0}
            onclick={() => void confirmMkdir()}
            data-testid="team-workdir-mkdir-confirm"
          >
            {picker.creating ? t('teamBot.workdirCreating') : t('teamBot.workdirMkdirConfirm')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="h-8"
            disabled={picker.creating}
            onclick={() => (mkdirFor = undefined)}
            data-testid="team-workdir-mkdir-cancel"
          >
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    {/if}
    {#if picker.mkdirError !== null}
      <p class="text-xs text-destructive" data-testid="team-workdir-mkdir-error">
        {errorText(picker.mkdirError, t('teamBot.workdirMkdirFailed'))}
      </p>
    {/if}
    {#if !compact}
      <button
        type="button"
        class="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onclick={() => void picker.refresh()}
        data-testid="team-workdir-refresh"
      >
        <RefreshCw class="size-3" aria-hidden="true" />
        {t('common.refresh')}
      </button>
    {/if}
  {/if}
</div>
