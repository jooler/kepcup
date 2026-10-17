<script lang="ts">
  import { FolderOpen, Settings, TriangleAlert } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { workdirs } from '$lib/stores/workdirs.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import * as Dialog from '$lib/components/ui/dialog';
  import WorkdirSettingsDialog from './WorkdirSettingsDialog.svelte';

  let {
    conversationId,
    workdirId,
    disabled,
  }: { conversationId: string; workdirId: string | null; disabled?: boolean } = $props();

  let pickerOpen = $state(false);
  let settingsOpen = $state(false);
  let settingsAnchor = $state<string | null>(null);

  const current = $derived(workdirs.boundOf(conversationId, workdirId));
  const missing = $derived(current !== null && current.status === 'missing');
  // 有 Bot 正在执行时禁用（docs/design/08-workdir.md "选择与切换"）。
  const running = $derived((chat.current?.activeRuns.length ?? 0) > 0);
  const effectiveDisabled = $derived(disabled === true || running);

  // 对话内设置卡的「在设置中打开」（shell.openWorkdirSettings）：已绑工作目录直接开工作目录设置并
  // 聚焦锚点；还没绑工作目录先开选择框（绑定后用户再点「权限设置」）。
  $effect(() => {
    const request = shell.workdirSettingsRequest;
    if (request === null) return;
    shell.workdirSettingsRequest = null;
    if (current !== null) {
      settingsAnchor = request.anchor;
      settingsOpen = true;
    } else if (!effectiveDisabled) {
      pickerOpen = true;
    }
  });

  async function handleSelect(path: string): Promise<void> {
    // 绑定后保持弹框打开：用户看到 ✓ 与刚出现的「权限设置」，可继续配置。
    try {
      await workdirs.select(conversationId, path);
    } catch {
      // toast already shown by the store
    }
  }

  async function handlePickNew(): Promise<void> {
    await workdirs.selectWithDialog(conversationId);
  }
</script>

<!-- 右栏表单区块（Bot「配置」tab / 群信息）：自带标签的通栏触发按钮 -->
<div class="grid gap-1.5" data-testid="workdir-selector">
  <Label>{t('workdirs.selector')}</Label>
  <Button
    variant="outline"
    size="sm"
    class="h-9 w-full justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground"
    disabled={effectiveDisabled}
    onclick={() => (pickerOpen = true)}
    title={current !== null ? current.path : t('workdirs.none')}
    data-testid="workdir-selector-trigger"
  >
    {#if missing}<TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
    {:else}<FolderOpen class="size-3.5 shrink-0" aria-hidden="true" />{/if}
    <span class="truncate" data-testid="workdir-selector-name">
      {current !== null ? current.name : t('workdirs.none')}
    </span>
  </Button>
  {#if missing}
    <span class="text-[11px] text-amber-600">{t('workdirs.missingWarning')}</span>
  {/if}
  {#if running}
    <span class="text-[11px] text-muted-foreground" data-testid="workdir-switch-blocked-hint">
      {t('workdirs.switchBlocked')}
    </span>
  {/if}
</div>

<Dialog.Root bind:open={pickerOpen}>
  <Dialog.Content class="max-w-md" data-testid="workdir-picker-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('workdirs.selector')}</Dialog.Title>
      <Dialog.Description>{current !== null ? current.path : ''}</Dialog.Description>
    </Dialog.Header>
    <div class="max-h-72 space-y-1 overflow-y-auto" data-testid="workdir-picker-list">
      {#each workdirs.recent as workdir (workdir.id)}
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
          disabled={workdir.id === workdirId}
          onclick={() => void handleSelect(workdir.path)}
          data-testid="workdir-option"
          data-workdir-id={workdir.id}
          data-workdir-status={workdir.status}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate">{workdir.name}</span>
            <span class="block truncate text-[11px] text-muted-foreground">{workdir.path}</span>
          </span>
          {#if workdir.status === 'missing'}
            <TriangleAlert class="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          {/if}
          {#if workdir.id === workdirId}
            <span class="text-xs text-muted-foreground">✓</span>
          {/if}
        </button>
      {:else}
        <p class="px-3 py-4 text-center text-xs text-muted-foreground">{t('workdirs.none')}</p>
      {/each}
    </div>
    <div class="flex flex-col gap-1 border-t pt-2">
      <Button
        variant="ghost"
        size="sm"
        class="justify-start gap-2"
        onclick={() => void handlePickNew()}
        data-testid="workdir-pick-new"
      >
        <FolderOpen class="size-3.5" aria-hidden="true" />
        {t('workdirs.pickNew')}
      </Button>
      {#if current !== null}
        <!-- 权限设置叠在选择弹框之上：取消/Esc 只关上层，选择弹框原地保留 -->
        <Button
          variant="ghost"
          size="sm"
          class="justify-start gap-2"
          onclick={() => (settingsOpen = true)}
          data-testid="workdir-settings"
        >
          <Settings class="size-3.5" aria-hidden="true" />
          {t('workdirs.manage')}
        </Button>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<WorkdirSettingsDialog bind:open={settingsOpen} bind:anchor={settingsAnchor} workdir={current} />
