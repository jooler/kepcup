<script lang="ts">
  import type { BotProfile } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import PluginIcon from '$lib/features/plugins/PluginIcon.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Label } from '$lib/components/ui/label';
  import {
    addedPlugins,
    enabledPluginCount,
    pluginKindBadges,
    PLUGIN_KIND_LABEL_KEYS,
  } from './bot-plugins';

  /**
   * 成员面（团队端点）Bot 详情「插件」区块：只读展示管理员在管理台绑定到该
   * Bot 的插件。成员面没有 `plugins.*` 管理权限（method-policy admin plane），
   * 交互式的 BotPluginsSection 会调用 `plugins.instances.list` /
   * `plugins.setBotPlugins` 等被拒方法——团队视图只读 `plugins.list`（服务器
   * 目录，host 路径经 projection 剥掉），不渲染添加 / 移除 / 账号勾选。
   */
  let { profile }: { profile: BotProfile } = $props();

  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
  });

  const added = $derived(addedPlugins(plugins.plugins, profile.runtime.plugin_ids));
  const enabledSummary = $derived(
    enabledPluginCount(profile.runtime.plugin_ids, plugins.plugins),
  );
</script>

<div class="space-y-2" data-testid="bot-plugins-team" data-settings-anchor="bot-plugins">
  <!-- 旧区块深链锚点（与 BotPluginsSection 同落点）。 -->
  <div class="hidden" data-settings-anchor="bot-apps"></div>
  <div class="hidden" data-settings-anchor="bot-mcp"></div>

  <div class="flex items-center gap-2">
    <Label>{t('botPanel.sections.plugins')}</Label>
    <span class="text-xs text-muted-foreground">
      {enabledSummary > 0
        ? t('botPanel.plugins.summaryEnabled', { count: enabledSummary })
        : t('botPanel.plugins.summaryNone')}
    </span>
  </div>
  <p class="text-xs text-muted-foreground">{t('botPanel.plugins.teamManagedHint')}</p>

  {#if plugins.loadError !== null}
    <p class="text-xs text-destructive" data-testid="bot-plugins-error">
      {t('plugins.loadFailed', { reason: plugins.loadError })}
    </p>
  {:else if plugins.plugins.length === 0 && !plugins.loading}
    <p class="text-xs text-muted-foreground" data-testid="bot-plugins-team-empty">
      {t('botPanel.plugins.empty')}
    </p>
  {:else if added.length === 0}
    <p class="text-xs text-muted-foreground" data-testid="bot-plugins-team-none-added">
      {t('botPanel.plugins.teamManagedEmpty')}
    </p>
  {:else}
    <div class="space-y-1.5">
      {#each added as plugin (plugin.id)}
        {@const kinds = pluginKindBadges(plugin)}
        <div
          class="rounded-lg border px-2.5 py-2"
          data-testid={`bot-plugins-team-${plugin.id}`}
          data-enabled={String(plugin.enabled)}
        >
          <div class="flex items-start gap-2">
            <PluginIcon src={plugin.iconDataUri} label={plugin.name} class="size-8" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="min-w-0 truncate text-sm font-medium">{plugin.name}</span>
                {#each kinds as kind (kind)}
                  <Badge variant="secondary">{t(PLUGIN_KIND_LABEL_KEYS[kind])}</Badge>
                {/each}
              </div>
              {#if plugin.description.length > 0}
                <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {plugin.description}
                </p>
              {/if}
              {#if !plugin.enabled}
                <p class="mt-0.5 text-xs text-muted-foreground">
                  {t('botPanel.plugins.appDisabled')}
                </p>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
