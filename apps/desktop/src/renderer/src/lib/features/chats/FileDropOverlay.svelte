<script lang="ts">
  import { FilePlus2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';

  /**
   * 父视图级拖拽提示浮层（file-drop.svelte.ts 的 dragActive 驱动）：文件拖在
   * 视图上方时整片加罩，告诉用户松手即附加附件。pointer-events-none 不拦截
   * 任何事件（drop 仍由根元素与输入坞药丸各自处理）；absolute 定位要求宿主
   * 是 relative 根（三个视图根均满足）。
   */
  let { active }: { active: boolean } = $props();
</script>

{#if active}
  <div
    class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/50"
    data-testid="file-drop-overlay"
  >
    <div
      class="flex items-center gap-2.5 rounded-2xl border-2 border-dashed border-ring/70 bg-surface-raised px-5 py-4 text-sm font-medium shadow-xl"
    >
      <FilePlus2 class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{t('composer.dropToAttach')}</span>
    </div>
  </div>
{/if}
