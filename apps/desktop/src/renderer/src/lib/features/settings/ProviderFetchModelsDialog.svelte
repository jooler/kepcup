<script lang="ts">
  import type { FetchedProviderModel } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { untrack } from 'svelte';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { formatContextWindow } from './provider-instances';

  /**
   * 「获取模型」选择弹框：列出从供应商拉取到的模型，勾选要登记的条目。
   * 勾选是「临时清单」语义：打开时为空，跨关键词筛选持续累积（换词不清
   * 空已勾项），「清空」清掉全部勾选，「全选」把当前筛选结果并入清单；
   * 确认只提交清单里的条目。已登记的同 id 条目只读展示（合并策略 = 只新增
   * 不覆盖，见 `mergeFetchedProviderModels`）。拉取本身在父组件的按钮里做
   * （按钮带 loading 态），这里只负责挑选；`initialSelected` 由父组件持有
   * （重开弹框时恢复上次勾选）。
   */
  let {
    models = [],
    existingIds = [],
    initialSelected = [],
    open = $bindable(false),
    onConfirm,
  }: {
    models: FetchedProviderModel[];
    existingIds?: readonly string[];
    initialSelected?: readonly string[];
    open?: boolean;
    onConfirm: (picked: FetchedProviderModel[]) => void;
  } = $props();

  let search = $state('');
  let selected = $state<string[]>([]);

  const existing = $derived(new Set(existingIds));

  // 打开时播种一次临时清单（继承父组件已勾项）；依赖变化不重置——只订阅
  // open，筛选 / 已登记集合的变更不能清掉用户跨筛选累积的勾选。
  $effect(() => {
    if (!open) return;
    untrack(() => {
      search = '';
      selected = initialSelected.filter((id) => !existing.has(id));
    });
  });

  const filtered = $derived.by(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(query) || (m.name ?? '').toLowerCase().includes(query),
    );
  });

  /** 当前筛选结果里的新条目 id（「全选」的并入范围）。 */
  const selectableIds = $derived(
    filtered.filter((m) => !existing.has(m.id)).map((m) => m.id),
  );

  function toggle(id: string, checked: boolean): void {
    selected = checked
      ? [...new Set([...selected, id])]
      : selected.filter((s) => s !== id);
  }

  function selectFiltered(): void {
    selected = [...new Set([...selected, ...selectableIds])];
  }

  /** 清空整个临时清单（不分筛选范围）：下一次勾选从零累积。 */
  function clearAll(): void {
    selected = [];
  }

  function confirm(): void {
    const picked = models.filter((m) => selected.includes(m.id));
    if (picked.length === 0) return;
    onConfirm(picked);
    open = false;
  }
</script>

<Dialog bind:open>
  <DialogContent
    class="max-h-[72vh] sm:max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
    data-testid="provider-fetch-models-dialog"
  >
    <DialogHeader>
      <DialogTitle>{t('settings.fetchModelsDialogTitle')}</DialogTitle>
    </DialogHeader>

    <div class="-mr-4 min-h-0 space-y-3 overflow-y-auto pr-4 pl-2">
      <p class="text-xs text-muted-foreground">{t('settings.fetchModelsDialogHint')}</p>
      <div class="flex items-center gap-2">
        <Input
          placeholder={t('settings.fetchModelsSearch')}
          bind:value={search}
          data-testid="provider-fetch-models-search"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={selectableIds.length === 0}
          onclick={() => selectFiltered()}
          data-testid="provider-fetch-models-all"
        >
          {t('settings.fetchModelsAll')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={selected.length === 0}
          onclick={() => clearAll()}
          data-testid="provider-fetch-models-none"
        >
          {t('settings.fetchModelsNone')}
        </Button>
      </div>
      {#if models.length === 0}
        <div
          class="flex h-20 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          data-testid="provider-fetch-models-empty"
        >
          {t('settings.fetchModelsEmpty')}
        </div>
      {:else}
        <ul class="divide-y rounded-xl border">
          {#each filtered as model (model.id)}
            {@const label = model.name ?? model.id}
            <li
              class="flex items-center gap-2 px-3 py-2"
              data-testid={`provider-fetch-model-row-${model.id}`}
            >
              <Checkbox
                checked={!existing.has(model.id) && selected.includes(model.id)}
                disabled={existing.has(model.id)}
                onCheckedChange={(checked) => toggle(model.id, checked === true)}
              />
              <span class="min-w-0 flex-1 truncate font-mono text-sm">{label}</span>
              {#if label !== model.id}
                <span class="hidden truncate font-mono text-xs text-muted-foreground sm:block">
                  {model.id}
                </span>
              {/if}
              {#if model.contextWindow !== undefined}
                <Badge variant="outline">{formatContextWindow(model.contextWindow)}</Badge>
              {/if}
              {#if existing.has(model.id)}
                <Badge variant="outline">{t('settings.fetchModelsExisting')}</Badge>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="flex items-center justify-end gap-2 pt-2">
      <span class="mr-auto text-xs text-muted-foreground" data-testid="provider-fetch-models-count">
        {t('settings.fetchModelsSelected', { count: selected.length })}
      </span>
      <Button variant="outline" onclick={() => (open = false)}>
        {t('settings.cancel')}
      </Button>
      <Button
        disabled={selected.length === 0}
        onclick={() => confirm()}
        data-testid="provider-fetch-models-confirm"
      >
        {t('settings.confirm')}
      </Button>
    </div>
  </DialogContent>
</Dialog>
