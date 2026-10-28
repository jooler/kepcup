<script lang="ts">
  import type { PluginFieldSummary } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  /**
   * 插件字段表单（D105 P3，从 PluginConsentPanel 的渲染循环抽出）：宿主按
   * `PluginFieldSummary` 列表自动构建表单，值整对象双向绑定。三处复用——
   * 安装同意卡的 MCPB user_config、插件卡的实例表单、（P4）卡片设置表单。
   * `idScope` 生成表单控件的 id / testid 前缀（同一页面多组字段时不冲突）。
   */

  let {
    fields,
    values = $bindable(),
    idScope,
    testid,
  }: {
    fields: PluginFieldSummary[];
    /** 当前值（`Record<fieldKey, string | number | boolean | string[]>`）。 */
    values: Record<string, unknown>;
    /** 控件 id / testid 的命名空间（如 `plugins-consent` 或 `mail-instance`）。 */
    idScope: string;
    testid?: string | undefined;
  } = $props();

  function setValue(key: string, value: unknown): void {
    values = { ...values, [key]: value };
  }
</script>

<div class="space-y-2" data-testid={testid}>
  {#each fields as field (field.key)}
    <div class="grid gap-1">
      <Label for={`${idScope}-${field.key}`} class="text-xs">
        {field.title}
        {#if field.required}<span class="text-destructive">· {t('plugins.consent.required')}</span>{/if}
        {#if field.sensitive}<span class="text-muted-foreground"
            >· {t('plugins.consent.sensitive')}</span
          >{/if}
      </Label>
      {#if field.type === 'boolean'}
        <Checkbox
          id={`${idScope}-${field.key}`}
          checked={values[field.key] === true}
          onCheckedChange={(checked) => setValue(field.key, checked === true)}
        />
      {:else if field.multiple}
        <textarea
          id={`${idScope}-${field.key}`}
          class="min-h-16 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          value={(values[field.key] as string | undefined) ?? ''}
          oninput={(event) => setValue(field.key, event.currentTarget.value)}
          data-testid={`${idScope}-field-${field.key}`}></textarea>
      {:else}
        <Input
          id={`${idScope}-${field.key}`}
          class="h-8"
          type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
          autocomplete="off"
          value={(values[field.key] as string | undefined) ?? ''}
          oninput={(event) => setValue(field.key, event.currentTarget.value)}
          data-testid={`${idScope}-field-${field.key}`}
        />
      {/if}
      {#if field.description !== undefined && field.description.length > 0}
        <p class="text-xs text-muted-foreground">{field.description}</p>
      {/if}
    </div>
  {/each}
</div>
