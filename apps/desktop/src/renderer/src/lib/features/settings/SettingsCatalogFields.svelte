<script lang="ts">
  import { getSettingItem, type SettingItem } from '@kepcup/shared';
  import { settingItemText } from '$lib/i18n';
  import FieldEditorCard from '$lib/features/settings-card/FieldEditorCard.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';

  /**
   * 设置页的「目录字段组」（todo/settings-catalog-registry.md §4.3.6 / 任务 6）：把
   * `card: 'field-editor'` 的全局条目直接渲染进设置页分区，新增简单设置在目标分区加
   * 一行即可，不必手写表单。锚点由调用方**静态**写在包裹元素上（覆盖率扫描只认字面量，
   * 组件内动态锚点扫不到），值 = 条目 `deepLink.anchor`。
   *
   * 只渲染 `owner === 'core'`、`scope === 'global'`、`card === 'field-editor'` 的条目。
   * 设置页是「改完即存」的形态：`saveOnChange` 让卡片省掉「应用」按钮，
   * 开关 / 下拉立即落盘、文本 / 数字防抖落盘；对话内设置卡仍走确认后保存。
   */
  let { itemIds, title }: { itemIds: readonly string[]; title?: string } = $props();

  const items = $derived(
    itemIds
      .map((id) => getSettingItem(id))
      .filter(
        (item): item is SettingItem =>
          item !== null &&
          item.owner === 'core' &&
          item.scope === 'global' &&
          item.card === 'field-editor',
      ),
  );
</script>

{#if items.length > 0}
  <section class="grid gap-3">
    {#if title !== undefined}<h3 class="text-sm font-medium">{title}</h3>{/if}
    {#each items as item (item.id)}
      <div class="grid gap-1">
        <span class="text-sm font-medium">
          {settingItemText(item.id, 'title', item.title)}
        </span>
        <span class="text-xs text-muted-foreground">
          {settingItemText(item.id, 'summary', item.summary)}
        </span>
        <FieldEditorCard {item} saveOnChange onSaved={() => void settingsStore.refresh()} />
      </div>
    {/each}
  </section>
{/if}
