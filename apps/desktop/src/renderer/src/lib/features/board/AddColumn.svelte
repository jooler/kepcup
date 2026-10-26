<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { board } from './board.svelte';

  /** Ghost control at the end of the track, outside the column drag zone. */
  function add(): void {
    void board.createColumn(t('board.column.titlePlaceholder'));
  }
</script>

<button
  type="button"
  class="flex h-10 shrink-0 cursor-pointer items-center gap-1 self-start rounded-lg px-3 text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
  aria-label={t('board.addColumn')}
  onclick={add}
  data-testid="board-add-column"
>
  <Plus class="size-4" aria-hidden="true" />
  {t('board.addColumn')}
</button>
