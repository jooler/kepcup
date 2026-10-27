<script lang="ts">
  import type { PluginInspectOutput } from '@kepcup/shared';
  import { t, listSeparator } from '$lib/i18n';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { formatBytes, runtimeLabel } from '../settings/mcpb-install';
  import type { PluginForm } from './plugin-install';

  /**
   * 插件同意面板（D104 设计 51 §5 第 5 步）：`plugins.inspect` 推导结果的渲染，本地安装
   * 对话框、市场详情（P1）与 Bot 确认卡（P1）共用。权限与内容都来自 core 的推导，
   * 不采信清单自述；有阻断项时不渲染 user_config 表单（装不了就不用填）。
   */

  let {
    info,
    form = $bindable(),
    missing,
    testid = 'plugins-consent',
  }: {
    info: PluginInspectOutput;
    form: PluginForm;
    missing: string[];
    testid?: string;
  } = $props();

  const hasBlockers = $derived(
    info.blockers.length > 0 || info.conflicts.length > 0 || info.existing !== null,
  );
  const mcpbItems = $derived(info.mcp.filter((item) => item.kind === 'mcpb'));
</script>

<div class="space-y-3" data-testid={testid}>
  <div class="flex flex-wrap items-center gap-2">
    <Badge>{info.name}</Badge>
    <span class="text-xs text-muted-foreground"
      >{t('plugins.version', { version: info.version })}</span
    >
    <Badge variant="outline">{t(`plugins.origin.${info.origin}`)}</Badge>
    <Badge
      variant="outline"
      class={info.tier === 'developer' ? 'border-destructive text-destructive' : ''}
    >
      {t(`plugins.tier.${info.tier}`)}
    </Badge>
  </div>
  {#if info.author !== null && info.author.length > 0}
    <p class="text-xs text-muted-foreground">{t('plugins.consent.author')} {info.author}</p>
  {/if}
  {#if info.description.length > 0}
    <p class="text-xs text-muted-foreground">{info.description}</p>
  {/if}
  <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
    <span class="text-muted-foreground">{t('plugins.consent.sha')}</span>
    <code class="break-all" data-testid={`${testid}-sha`}>{info.packageSha256}</code>
    <span class="text-muted-foreground">{t('plugins.consent.size')}</span>
    <span>{formatBytes(info.sizeBytes)}</span>
  </div>

  {#if info.tier === 'developer'}
    <p
      class="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
      data-testid={`${testid}-developer-warn`}
    >
      {t('plugins.consent.developerWarn')}
    </p>
  {/if}

  {#if hasBlockers}
    <div
      class="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
      data-testid={`${testid}-blockers`}
    >
      <p class="font-medium">{t('plugins.consent.blockers')}</p>
      {#each info.blockers as blocker (blocker)}
        <p>{blocker}</p>
      {/each}
      {#if info.conflicts.length > 0}
        <p class="font-medium">{t('plugins.consent.conflicts')}</p>
        {#each info.conflicts as conflict (`${conflict.kind}:${conflict.ref}`)}
          <p>
            {t('plugins.consent.conflictItem', { ref: conflict.ref, withWhat: conflict.withWhat })}
          </p>
        {/each}
      {/if}
      {#if info.existing !== null}
        <p>{t('plugins.consent.existing', { version: info.existing.version })}</p>
      {/if}
    </div>
  {/if}

  {#if info.skills.length > 0}
    <div class="space-y-1.5">
      <Label class="text-xs">{t('plugins.consent.skills')}</Label>
      {#each info.skills as skill (skill.name)}
        <div class="grid gap-0.5">
          <span class="text-sm">{skill.name}</span>
          {#if skill.description.length > 0}
            <span class="text-xs text-muted-foreground">{skill.description}</span>
          {/if}
          {#if !skill.compatible}
            <span class="text-xs text-destructive">
              {t('plugins.consent.skillIncompatible', { reason: skill.incompatibleReason ?? '' })}
            </span>
          {/if}
          {#if skill.runtimeDeps.length > 0}
            <span class="text-xs text-muted-foreground">
              {t('plugins.consent.skillDeps', { deps: skill.runtimeDeps.join(listSeparator()) })}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if info.mcp.length > 0}
    <div class="space-y-1.5">
      <Label class="text-xs">{t('plugins.consent.mcp')}</Label>
      {#each info.mcp as item (item.id)}
        <div class="grid gap-0.5">
          {#if item.kind === 'mcpb'}
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm">{item.displayName}</span>
              <Badge variant="outline">{item.serverType}</Badge>
            </div>
            <Label class="mt-1 text-xs text-muted-foreground">{t('plugins.consent.mcpb')}</Label>
            <code class="block overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs whitespace-pre"
              >{item.launchCommand}</code
            >
            {#if item.runtime !== null && !item.runtime.available}
              <span class="text-xs text-destructive">
                {t('plugins.consent.runtimeMissing', { runtime: runtimeLabel(item.runtime.kind) })}
              </span>
            {/if}
            <code class="text-xs break-all text-muted-foreground">{item.mcpbSha256}</code>
          {:else}
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm">{item.displayName}</span>
              <Badge variant="outline">{t('plugins.consent.mcpHttp', { host: item.host })}</Badge>
            </div>
            <code class="text-xs break-all text-muted-foreground">{item.url}</code>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if !hasBlockers}
    {#each mcpbItems as item (item.id)}
      {#if item.userConfigFields.length > 0}
        <div class="space-y-2" data-testid={`${testid}-config-${item.id}`}>
          <Label class="text-xs">
            {t('plugins.consent.configTitle')} · {item.displayName}
          </Label>
          {#each item.userConfigFields as field (field.key)}
            <div class="grid gap-1">
              <Label for={`plugin-field-${item.id}-${field.key}`} class="text-xs">
                {field.title}
                {#if field.required}<span class="text-destructive"
                    >· {t('plugins.consent.required')}</span
                  >{/if}
                {#if field.sensitive}<span class="text-muted-foreground"
                    >· {t('plugins.consent.sensitive')}</span
                  >{/if}
              </Label>
              {#if field.type === 'boolean'}
                <Checkbox
                  id={`plugin-field-${item.id}-${field.key}`}
                  checked={form[item.id]?.[field.key] === true}
                  onCheckedChange={(checked) => {
                    const current = form[item.id] ?? {};
                    form[item.id] = { ...current, [field.key]: checked === true };
                  }}
                />
              {:else if field.multiple}
                <textarea
                  id={`plugin-field-${item.id}-${field.key}`}
                  class="min-h-16 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  value={(form[item.id]?.[field.key] as string | undefined) ?? ''}
                  oninput={(event) => {
                    const current = form[item.id] ?? {};
                    form[item.id] = { ...current, [field.key]: event.currentTarget.value };
                  }}
                  data-testid={`${testid}-field-${item.id}-${field.key}`}></textarea>
              {:else}
                <Input
                  id={`plugin-field-${item.id}-${field.key}`}
                  class="h-8"
                  type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
                  autocomplete="off"
                  value={(form[item.id]?.[field.key] as string | undefined) ?? ''}
                  oninput={(event) => {
                    const current = form[item.id] ?? {};
                    form[item.id] = { ...current, [field.key]: event.currentTarget.value };
                  }}
                  data-testid={`${testid}-field-${item.id}-${field.key}`}
                />
              {/if}
              {#if field.description.length > 0}
                <p class="text-xs text-muted-foreground">{field.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/each}
  {/if}

  {#if info.connectors.length > 0}
    <div class="space-y-1.5">
      <Label class="text-xs">{t('plugins.consent.connectors')}</Label>
      {#each info.connectors as connector (connector.slug)}
        <div class="grid gap-0.5">
          <span class="text-sm">{connector.title}</span>
          {#if connector.hosts.length > 0}
            <span class="text-xs text-muted-foreground">
              {t('plugins.consent.connectorHosts', {
                hosts: connector.hosts.join(listSeparator()),
              })}
            </span>
          {/if}
          {#if connector.scopes.length > 0}
            <span class="text-xs text-muted-foreground">
              {t('plugins.consent.connectorScopes', {
                scopes: connector.scopes.join(listSeparator()),
              })}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if info.mail.length > 0}
    <div class="space-y-1.5">
      <Label class="text-xs">{t('plugins.consent.mail')}</Label>
      {#each info.mail as template (template.id)}
        <div class="grid gap-0.5">
          <span class="text-sm">{template.label}</span>
          <span class="text-xs text-muted-foreground">
            {template.imapHost} · {template.smtpHost}
          </span>
        </div>
      {/each}
    </div>
  {/if}

  {#if missing.length > 0}
    <p class="text-xs text-muted-foreground" data-testid={`${testid}-missing`}>
      {t('plugins.consent.requiredMissing', { fields: missing.join(listSeparator()) })}
    </p>
  {/if}
</div>
