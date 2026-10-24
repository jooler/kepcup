<script lang="ts">
  /** 下钻详情的头部：返回回二级菜单 + 详情标题。 */
  import { ChevronLeft } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';

  let {
    title,
    onBack,
    testid = 'bot-detail-back',
  }: {
    title: string;
    onBack: () => void;
    testid?: string;
  } = $props();
</script>

<div class="flex shrink-0 items-center gap-1">
  <Button
    variant="ghost"
    size="icon"
    class="size-7"
    title={t('common.back')}
    onclick={onBack}
    data-testid={testid}
  >
    <ChevronLeft class="size-4" aria-hidden="true" />
  </Button>
  <p class="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
</div>
