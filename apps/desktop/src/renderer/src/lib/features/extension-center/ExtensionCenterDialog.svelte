<script lang="ts">
  import { t } from '$lib/i18n';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import ExtensionCenterBody from './ExtensionCenterBody.svelte';

  /**
   * 扩展中心弹框（docs/design/29-connected-apps.md §16）：三个分组的主体在
   * ExtensionCenterBody（与窄屏「扩展」tab 页共用）。
   *
   * 面板是明确打开的管理界面：点遮罩/弹框外部不关闭（易误触），只留右上角
   * ✕ 与 Esc；技能安装进行中关闭弹框不中断安装（installing 在模块级单例里）。
   * 窄屏模式下扩展入口走底部 tab 页，不再打开这个弹框（NarrowShell 会把
   * openExtensionCenter 深链重路由到 tab）；窗口被拉窄时宽度上限贴视口。
   */

  let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Dialog bind:open>
  <DialogContent
    class="flex h-[70vh] max-w-[calc(100%_-_1rem)] flex-col overflow-hidden sm:max-w-6xl"
    data-testid="extension-center-dialog"
    onInteractOutside={(event) => event.preventDefault()}
  >
    <DialogHeader class="shrink-0">
      <DialogTitle>{t('extensionCenter.title')}</DialogTitle>
      <DialogDescription>{t('extensionCenter.description')}</DialogDescription>
    </DialogHeader>

    <ExtensionCenterBody />
  </DialogContent>
</Dialog>
