<script lang="ts">
  import type { Conversation } from '@kepcup/shared';
  import { AppError } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import {
    PLUGIN_KIND_LABEL_KEYS,
    pluginKindBadges,
    togglePluginId,
  } from '$lib/features/bot-panel/bot-plugins';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { shell } from '$lib/stores/shell.svelte';

  /**
   * 项目详情「插件」分区（P2 注入模型步骤 4）：项目会话内的叠加授权——启用的
   * 插件对**本项目会话与任务**里的所有成员 Bot 可用（`project_plugins` 表，
   * `projects.plugins.set` 整集写入），不改变成员 Bot 自己的启用集。
   */
  let {
    conversationId,
    conversation,
  }: {
    conversationId: string;
    conversation: Conversation;
  } = $props();

  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
  });

  // 本地乐观状态：写成功后 core 广播项目事件、会话对象被刷新时重新对齐服务端值。
  let selected = $state<string[]>([]);
  let aligned: Conversation | null = null;
  $effect(() => {
    if (conversation === aligned) return;
    aligned = conversation;
    selected = conversation.plugins ?? [];
  });

  let saving = $state(false);

  async function togglePlugin(pluginId: string, on: boolean): Promise<void> {
    const next = togglePluginId(selected, pluginId, on);
    selected = next;
    saving = true;
    try {
      await core.call('projects.plugins.set', { conversationId, pluginIds: next });
    } catch (caught) {
      // 回滚到会话当前值：下次事件刷新会再对齐一次。
      selected = conversation.plugins ?? [];
      const message = caught instanceof Error ? caught.message : String(caught);
      toast.error(
        t('plugins.toast.failed', {
          reason: errorText(caught instanceof AppError ? caught.code : undefined, message),
        }),
      );
    } finally {
      saving = false;
    }
  }

  function openStore(): void {
    shell.openExtensionCenter('market');
  }
</script>

<section class="space-y-3" data-settings-anchor="project-plugins">
  <p class="text-xs text-muted-foreground" data-testid="project-plugins-hint">
    {t('projectSettings.plugins.hint')}
  </p>
  {#if plugins.loadError !== null}
    <p class="text-xs text-destructive" data-testid="project-plugins-error">
      {t('plugins.loadFailed', { reason: plugins.loadError })}
    </p>
  {:else if plugins.plugins.length === 0 && !plugins.loading}
    <div class="flex items-center gap-2">
      <p class="text-xs text-muted-foreground" data-testid="project-plugins-empty">
        {t('projectSettings.plugins.empty')}
      </p>
      <Button
        size="sm"
        variant="ghost"
        class="h-7 px-2 text-xs"
        onclick={openStore}
        data-testid="project-plugins-open-store"
      >
        {t('botPanel.plugins.openStore')}
      </Button>
    </div>
  {:else}
    <div class="space-y-1.5" data-testid="project-plugins">
      {#each plugins.plugins as plugin (plugin.id)}
        {@const kinds = pluginKindBadges(plugin)}
        <label
          class="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm"
          data-testid={`project-plugins-${plugin.id}`}
        >
          <Checkbox
            checked={selected.includes(plugin.id)}
            disabled={saving}
            onCheckedChange={(checked) => void togglePlugin(plugin.id, checked === true)}
            data-testid={`project-plugins-toggle-${plugin.id}`}
          />
          <span class="min-w-0 flex-1 truncate font-medium">{plugin.name}</span>
          {#each kinds as kind (kind)}
            <Badge variant="secondary" data-testid={`project-plugins-kind-${kind}-${plugin.id}`}>
              {t(PLUGIN_KIND_LABEL_KEYS[kind])}
            </Badge>
          {/each}
        </label>
      {/each}
    </div>
  {/if}
</section>
