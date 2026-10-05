<script lang="ts">
  import { FolderOpen, Settings, TriangleAlert } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { projects } from '$lib/stores/projects.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import * as Dialog from '$lib/components/ui/dialog';
  import ProjectSettingsDialog from './ProjectSettingsDialog.svelte';

  let {
    conversationId,
    projectId,
    disabled,
  }: { conversationId: string; projectId: string | null; disabled?: boolean } = $props();

  let pickerOpen = $state(false);
  let settingsOpen = $state(false);

  const current = $derived(projects.boundOf(conversationId, projectId));
  const missing = $derived(current !== null && current.status === 'missing');
  // 有 Bot 正在执行时禁用（docs/design/08-project.md "选择与切换"）。
  const running = $derived((chat.current?.activeRuns.length ?? 0) > 0);
  const effectiveDisabled = $derived(disabled === true || running);

  async function handleSelect(path: string): Promise<void> {
    // 绑定后保持弹框打开：用户看到 ✓ 与刚出现的「权限设置」，可继续配置。
    try {
      await projects.select(conversationId, path);
    } catch {
      // toast already shown by the store
    }
  }

  async function handlePickNew(): Promise<void> {
    await projects.selectWithDialog(conversationId);
  }
</script>

<!-- 右栏表单区块（Bot「配置」tab / 群信息）：自带标签的通栏触发按钮 -->
<div class="grid gap-1.5" data-testid="project-selector">
  <Label>{t('projects.selector')}</Label>
  <Button
    variant="outline"
    size="sm"
    class="h-9 w-full justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground"
    disabled={effectiveDisabled}
    onclick={() => (pickerOpen = true)}
    title={current !== null ? current.path : t('projects.none')}
    data-testid="project-selector-trigger"
  >
    {#if missing}<TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
    {:else}<FolderOpen class="size-3.5 shrink-0" aria-hidden="true" />{/if}
    <span class="truncate" data-testid="project-selector-name">
      {current !== null ? current.name : t('projects.none')}
    </span>
  </Button>
  {#if missing}
    <span class="text-[11px] text-amber-600">{t('projects.missingWarning')}</span>
  {/if}
  {#if running}
    <span class="text-[11px] text-muted-foreground" data-testid="project-switch-blocked-hint">
      {t('projects.switchBlocked')}
    </span>
  {/if}
</div>

<Dialog.Root bind:open={pickerOpen}>
  <Dialog.Content class="max-w-md" data-testid="project-picker-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('projects.selector')}</Dialog.Title>
      <Dialog.Description>{current !== null ? current.path : ''}</Dialog.Description>
    </Dialog.Header>
    <div class="max-h-72 space-y-1 overflow-y-auto" data-testid="project-picker-list">
      {#each projects.recent as project (project.id)}
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
          disabled={project.id === projectId}
          onclick={() => void handleSelect(project.path)}
          data-testid="project-option"
          data-project-id={project.id}
          data-project-status={project.status}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate">{project.name}</span>
            <span class="block truncate text-[11px] text-muted-foreground">{project.path}</span>
          </span>
          {#if project.status === 'missing'}
            <TriangleAlert class="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          {/if}
          {#if project.id === projectId}
            <span class="text-xs text-muted-foreground">✓</span>
          {/if}
        </button>
      {:else}
        <p class="px-3 py-4 text-center text-xs text-muted-foreground">{t('projects.none')}</p>
      {/each}
    </div>
    <div class="flex flex-col gap-1 border-t pt-2">
      <Button
        variant="ghost"
        size="sm"
        class="justify-start gap-2"
        onclick={() => void handlePickNew()}
        data-testid="project-pick-new"
      >
        <FolderOpen class="size-3.5" aria-hidden="true" />
        {t('projects.pickNew')}
      </Button>
      {#if current !== null}
        <!-- 权限设置叠在选择弹框之上：取消/Esc 只关上层，选择弹框原地保留 -->
        <Button
          variant="ghost"
          size="sm"
          class="justify-start gap-2"
          onclick={() => (settingsOpen = true)}
          data-testid="project-settings"
        >
          <Settings class="size-3.5" aria-hidden="true" />
          {t('projects.manage')}
        </Button>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<ProjectSettingsDialog bind:open={settingsOpen} project={current} />
