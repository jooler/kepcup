<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { describeAppLink } from './bridge-guard';

  /**
   * 应用 / 组件界面共用的外链确认条（D73 P3 引入，D81 P1 复用）：安全 UI——
   * role="alertdialog"、主机名突出、过长 URL 截断展示；确认 / 取消由宿主卡片处理
   * （卡片侧另有 pendingLink 单例与拒绝冷却，本组件只负责展示与转发点击）。
   * 标题与按钮文案由调用方用各自的 i18n 键解析后传入（两层对用户的称谓不同）。
   */
  let {
    url,
    title,
    hostLabel,
    confirmLabel,
    cancelLabel,
    /** testid 前缀（如 `mcp-app` / `bot-widget`，后缀 -link-confirm 等）。 */
    testidPrefix,
    onconfirm,
    oncancel,
  }: {
    url: string;
    title: string;
    hostLabel: string;
    confirmLabel: string;
    cancelLabel: string;
    testidPrefix: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  const info = $derived(describeAppLink(url));
</script>

<div
  class="border-t bg-amber-500/5 px-3 py-2 text-xs"
  data-testid="{testidPrefix}-link-confirm"
  role="alertdialog"
  aria-label={title}
>
  <p class="font-medium">{title}</p>
  <p class="mt-1" data-testid="{testidPrefix}-link-host">
    <span class="text-muted-foreground">{hostLabel}</span>
    <strong class="text-sm">{info.host}</strong>
  </p>
  <p class="mt-1 break-all text-muted-foreground" data-testid="{testidPrefix}-link-url">
    {info.display}
  </p>
  <div class="mt-2 flex justify-end gap-1">
    <Button
      size="sm"
      variant="ghost"
      class="h-6 px-2 text-xs"
      onclick={oncancel}
      data-testid="{testidPrefix}-link-cancel">{cancelLabel}</Button
    >
    <Button
      size="sm"
      class="h-6 px-2 text-xs"
      onclick={onconfirm}
      data-testid="{testidPrefix}-link-open">{confirmLabel}</Button
    >
  </div>
</div>
