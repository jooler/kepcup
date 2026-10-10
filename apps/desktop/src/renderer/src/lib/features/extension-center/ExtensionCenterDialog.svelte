<script lang="ts">
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import ExtensionSkills from './ExtensionSkills.svelte';
  import ExtensionConnections from './ExtensionConnections.svelte';
  import ExtensionMcp from './ExtensionMcp.svelte';
  import { EXTENSION_CENTER_TABS, extensionTabForKey, type ExtensionCenterTab } from './tabs';

  /**
   * 扩展中心（原技能市场，docs/design/29-connected-apps.md §16）：三个分组——
   * Skills（预置技能，原技能市场内容原样迁入）、连接（已适配的预置连接应用：发现 / 连接 /
   * 管理）、MCP（已安装 MCP 的管理 + MCPB 本地包安装）。当前分组存在 shell store 里，
   * 各入口经 `shell.openExtensionCenter(tab)` 直达某一组。
   *
   * 面板是明确打开的管理界面：点遮罩/弹框外部不关闭（易误触），只留右上角
   * ✕ 与 Esc；技能安装进行中关闭弹框不中断安装（installing 在模块级单例里）。
   */

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const TAB_LABEL_KEYS = {
    skills: 'extensionCenter.tabs.skills',
    connections: 'extensionCenter.tabs.connections',
    mcp: 'extensionCenter.tabs.mcp',
  } as const;

  const tab = $derived(shell.extensionCenterTab);

  let tablist = $state<HTMLDivElement | null>(null);

  function select(next: ExtensionCenterTab): void {
    shell.extensionCenterTab = next;
  }

  function tabId(item: ExtensionCenterTab): string {
    return `extension-center-tab-${item}`;
  }

  function panelId(item: ExtensionCenterTab): string {
    return `extension-center-tabpanel-${item}`;
  }

  /** WAI-ARIA tabs：左右方向键 / Home / End 切换分组并把焦点移到新页签上。 */
  function onTablistKeydown(event: KeyboardEvent): void {
    const next = extensionTabForKey(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    select(next);
    tablist?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
  }
</script>

<Dialog bind:open>
  <DialogContent
    class="flex h-[85vh] max-w-xl flex-col overflow-hidden sm:max-w-[50rem]"
    data-testid="extension-center-dialog"
    onInteractOutside={(event) => event.preventDefault()}
  >
    <DialogHeader class="shrink-0">
      <DialogTitle>{t('extensionCenter.title')}</DialogTitle>
      <DialogDescription>{t('extensionCenter.description')}</DialogDescription>
    </DialogHeader>

    <div
      class="flex shrink-0 items-center gap-1 border-b"
      role="tablist"
      bind:this={tablist}
      data-testid="extension-center-tabs"
    >
      {#each EXTENSION_CENTER_TABS as item (item)}
        <button
          type="button"
          role="tab"
          id={tabId(item)}
          aria-selected={tab === item}
          aria-controls={panelId(item)}
          tabindex={tab === item ? 0 : -1}
          class="-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors {tab === item
            ? 'border-foreground font-medium text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => select(item)}
          onkeydown={onTablistKeydown}
          data-testid={`extension-center-tab-${item}`}
        >
          {t(TAB_LABEL_KEYS[item])}
        </button>
      {/each}
    </div>

    <div
      role="tabpanel"
      id={panelId(tab)}
      aria-labelledby={tabId(tab)}
      class="flex min-h-0 flex-1 flex-col"
    >
      {#if tab === 'skills'}
        <ExtensionSkills />
      {:else if tab === 'connections'}
        <ExtensionConnections />
      {:else}
        <ExtensionMcp />
      {/if}
    </div>
  </DialogContent>
</Dialog>
