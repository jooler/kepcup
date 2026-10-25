<script lang="ts">
  import { FolderOpen, TriangleAlert } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { workdirs } from '$lib/stores/workdirs.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import WorkdirSettingsDialog from './WorkdirSettingsDialog.svelte';

  let {
    conversationId,
    workdirId,
    disabled,
    /** false = 只挂载弹框不渲染表单区块：右栏「配置」二级菜单用自己的行触发 openWorkdir()。 */
    showBlock = true,
  }: {
    conversationId: string;
    workdirId: string | null;
    disabled?: boolean;
    showBlock?: boolean;
  } = $props();

  let settingsOpen = $state(false);
  let settingsAnchor = $state<string | null>(null);
  /** 系统目录选择器刚选出、还没在目录设置弹框里保存确认的路径；保存才正式绑定。 */
  let pendingPath = $state<string | null>(null);

  const current = $derived(workdirs.boundOf(conversationId, workdirId));
  const missing = $derived(current !== null && current.status === 'missing');
  // 有 Bot 正在执行时禁用（docs/design/08-workdir.md "选择与切换"）。
  const running = $derived((chat.current?.activeRuns.length ?? 0) > 0);
  const effectiveDisabled = $derived(disabled === true || running);

  // 对话内设置卡的「在设置中打开」（shell.openWorkdirSettings）：已绑工作目录直接开目录设置并
  // 聚焦锚点；还没绑工作目录先走系统目录选择器（锚点丢弃，与旧的选择弹框一致）。
  $effect(() => {
    const request = shell.workdirSettingsRequest;
    if (request === null) return;
    shell.workdirSettingsRequest = null;
    if (current !== null) {
      settingsAnchor = request.anchor;
      settingsOpen = true;
    } else if (!effectiveDisabled) {
      void pickNew();
    }
  });

  // 弹框关闭（保存或取消）即清掉待确认路径，不影响下一次打开。
  $effect(() => {
    if (!settingsOpen) pendingPath = null;
  });

  /** 系统目录选择器选出路径 → 打开待确认模式的目录设置弹框；取消选择则原地不动。 */
  async function pickNew(): Promise<void> {
    const path = await workdirs.pickPath();
    if (path === null) return;
    pendingPath = path;
    settingsOpen = true;
  }

  /** 单步入口（区块触发按钮 / 配置二级菜单行）：已绑直接开目录设置，未绑先选目录。 */
  export function openWorkdir(): void {
    if (effectiveDisabled) return;
    if (current !== null) settingsOpen = true;
    else void pickNew();
  }
</script>

{#if showBlock}
  <!-- 右栏表单区块（Bot「配置」tab / 群信息）：自带标签的通栏触发按钮 -->
  <div class="grid gap-1.5" data-testid="workdir-selector">
    <Label>{t('workdirs.selector')}</Label>
    <Button
      variant="outline"
      size="sm"
      class="h-9 w-full justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground"
      disabled={effectiveDisabled}
      onclick={openWorkdir}
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
{/if}

<WorkdirSettingsDialog
  bind:open={settingsOpen}
  bind:anchor={settingsAnchor}
  workdir={current}
  {conversationId}
  {pendingPath}
/>
