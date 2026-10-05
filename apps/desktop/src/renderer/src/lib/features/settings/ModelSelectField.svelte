<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';

  /**
   * 默认模型下拉（settingsStore.availableModelOptions = 已配置 key 的厂商
   * 对话模型）。设置页「默认模型」与对话内模型设置卡片共用同一份选项事实。
   */
  let {
    value = $bindable(''),
    id,
    testid,
    labelledBy,
  }: {
    value?: string;
    id?: string;
    /** data-testid；缺省不输出。 */
    testid?: string;
    /** 外部 label 元素的 id（无障碍标注）。 */
    labelledBy?: string;
  } = $props();
</script>

<select
  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
  bind:value
  {id}
  aria-labelledby={labelledBy}
  data-testid={testid}
>
  <option value="">{t('settings.modelPlaceholder')}</option>
  {#each settingsStore.availableModelOptions as option (option.ref)}
    <option value={option.ref}>{option.label}</option>
  {/each}
</select>
