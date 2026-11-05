<script lang="ts">
  /**
   * 组件详情（配置二级菜单组件行的「查看」落点）：信息卡 + 发到当前对话 / 两步
   * 删除。完整管理（刷新 / 全列表）仍在「组件」tab；这里只做单组件的快捷查看，
   * RPC 契约与原「组件」tab 一致（widgets.publish / widgets.delete）。
   */
  import { Blocks, ChevronLeft, History, Send } from '@lucide/svelte';
  import type { MicroAppsListItem, WidgetsListItem } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { formatBytes } from '$lib/features/settings/mcpb-install';
  import { checkBadge } from '$lib/features/widgets/check-status';

  let {
    botId,
    conversationId,
    widget,
    onChanged,
    onBack,
  }: {
    botId: string;
    /** 「发到当前对话」的目的地；缺省不显示发布按钮。 */
    conversationId: string | undefined;
    widget: WidgetsListItem;
    /** 删除 / 发卡后通知（RightPanel 据此刷新菜单行）。删除成功还会触发 onBack。 */
    onChanged: () => void;
    onBack: () => void;
  } = $props();

  /** 两步删除：先点「删除」武装确认，再点「确认删除」才发请求。 */
  let deleteArmed = $state(false);
  let deleting = $state(false);
  let publishing = $state(false);

  const badge = $derived(checkBadge(widget.checkStatus));

  async function publish(): Promise<void> {
    if (conversationId === undefined) return;
    publishing = true;
    try {
      const result = (await core.call('widgets.publish', {
        botId,
        widgetId: widget.widgetId,
        conversationId,
      })) as { ok: boolean; message?: string; cardMessageId?: string };
      // 发卡失败（cardMessageId 缺省）时组件还在、只是对话里没有卡——如实警示。
      if (!result.ok) {
        toast.error(result.message ?? t('widgetsTab.actionFailed'));
      } else if (result.cardMessageId === undefined) {
        toast.warning(t('widgetsTab.publishCardFailed'));
      } else {
        toast.success(t('widgetsTab.published'));
      }
      onChanged();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')),
      );
    } finally {
      publishing = false;
    }
  }

  async function remove(): Promise<void> {
    deleting = true;
    try {
      const result = (await core.call('widgets.delete', {
        botId,
        widgetId: widget.widgetId,
      })) as { ok: boolean };
      // {ok:false}（并发已删 / botId 不匹配）不是异常，必须显式分辨，不能假报成功。
      if (!result.ok) {
        toast.error(t('widgetsTab.actionFailed'));
        return;
      }
      toast.success(t('widgetsTab.deleted'));
      onChanged();
      onBack();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')),
      );
    } finally {
      deleting = false;
    }
  }

  function whenText(): string {
    return new Date(widget.updatedAt).toLocaleString();
  }

  // --- 微应用管理段（D112 P2，55 §14）：用量 / 网络 / 运行问题 / 摘要 / 回退 -----------
  let microInfo = $state<MicroAppsListItem | null>(null);

  $effect(() => {
    void widget.widgetId;
    microInfo = null;
    void (async () => {
      try {
        const result = (await core.call('microApps.list', { botId })) as { items: MicroAppsListItem[] };
        microInfo = result.items.find((item) => item.widgetId === widget.widgetId) ?? null;
      } catch {
        microInfo = null;
      }
    })();
  });

  let rollbackArmed = $state(false);

  async function rollback(version: number): Promise<void> {
    try {
      const result = (await core.call('microApps.rollback', { botId, widgetId: widget.widgetId, version })) as {
        ok: boolean;
        message?: string;
      };
      if (!result.ok) toast.error(result.message ?? t('widgetsTab.actionFailed'));
      else toast.success(t('botWidget.microApp.rolledBack', { version }));
      onChanged();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')),
      );
    } finally {
      rollbackArmed = false;
    }
  }

  async function clearContext(): Promise<void> {
    try {
      await core.call('microApps.clearContext', { botId, widgetId: widget.widgetId });
      toast.success(t('botWidget.microApp.contextCleared'));
      onChanged();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')),
      );
    }
  }
</script>

<div class="space-y-3" data-testid="bot-widget-detail">
  <div class="flex items-center gap-1">
    <Button
      variant="ghost"
      size="icon"
      class="size-7"
      onclick={onBack}
      title={t('common.back')}
      data-testid="bot-detail-back"
    >
      <ChevronLeft class="size-4" aria-hidden="true" />
    </Button>
    <p class="min-w-0 flex-1 truncate text-sm font-medium" data-testid="bot-widget-detail-title">
      {widget.title}
    </p>
  </div>

  <div class="rounded-xl border p-3 text-sm">
    <div class="flex items-center gap-2">
      <Blocks class="size-4 shrink-0 text-violet-600" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate font-medium">{widget.title}</span>
      {#if widget.scope === 'bot'}
        <span
          class="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-700 dark:text-violet-400"
        >
          {t('widgetsTab.assetBadge')}
        </span>
      {:else}
        <span class="shrink-0 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
          {t('widgetsTab.conversationScopedBadge')}
        </span>
      {/if}
    </div>
    {#if widget.description !== ''}
      <p class="mt-1.5 text-xs text-muted-foreground">{widget.description}</p>
    {/if}
    <p class="mt-1.5 text-xs text-muted-foreground">
      v{widget.version} · {t('widgetsTab.versionCount', { n: widget.versionCount })} ·
      {formatBytes(widget.sizeBytes)} · {whenText()}{#if widget.queriesCount > 0}
        · {t('widgetsTab.queriesCount', { n: widget.queriesCount })}{/if}{#if badge !== null}
        · <span data-testid={`bot-widget-detail-check-${widget.widgetId}`}>{t(badge.label)}</span
        >{/if}
    </p>
  </div>

  {#if microInfo !== null}
    <!-- 微应用管理（P2）：网络档位 / 今日用量 / 运行问题 / 进度摘要 / 版本回退。 -->
    <div class="rounded-xl border p-3 text-sm" data-testid="bot-widget-micro-manage">
      <p class="text-xs font-medium">{t('botWidget.microApp.manageTitle')}</p>
      <p class="mt-1 text-xs text-muted-foreground">
        {t('botWidget.microApp.manageNet')}：
        {#if microInfo.netMode === 'open'}{t('botWidget.microApp.netOpen')}
        {:else if microInfo.netMode === 'none'}{t('botWidget.microApp.netNone')}
        {:else}{t('botWidget.microApp.netAllowlist', { domains: microInfo.netAllowlist.join('、') })}{/if}
      </p>
      <p class="mt-1 text-xs text-muted-foreground" data-testid="bot-widget-micro-usage">
        {t('botWidget.microApp.manageUsage', {
          calls: microInfo.usage.aiCalls,
          tokens: microInfo.usage.aiTokens,
          asr: Math.round(microInfo.usage.asrMs / 1000),
          tts: microInfo.usage.ttsChars,
        })}
      </p>
      {#if microInfo.diagnostics24h.length > 0}
        <p class="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="bot-widget-micro-diag">
          {t('botWidget.microApp.manageIssues')}：{microInfo.diagnostics24h
            .map((item) => `${item.code} ×${item.count}`)
            .join('、')}
        </p>
      {/if}
      {#if microInfo.contextHeadline !== null}
        <p class="mt-1 flex items-center gap-1 text-xs text-muted-foreground" data-testid="bot-widget-micro-context">
          {t('botWidget.microApp.manageContext')}：{microInfo.contextHeadline}
          <button
            type="button"
            class="underline underline-offset-2"
            onclick={() => void clearContext()}
            data-testid="bot-widget-micro-context-clear"
          >
            {t('botWidget.microApp.clearContext')}
          </button>
        </p>
      {/if}
      {#if microInfo.latestVersion > 1 && microInfo.version > 1}
        <div class="mt-1.5 flex items-center gap-1 text-xs">
          {#if rollbackArmed}
            <button
              type="button"
              class="text-destructive underline underline-offset-2"
              onclick={() => void rollback((microInfo?.version ?? 2) - 1)}
              data-testid="bot-widget-micro-rollback-confirm"
            >
              {t('botWidget.microApp.rollbackConfirm', { version: (microInfo?.version ?? 2) - 1 })}
            </button>
            <button type="button" class="text-muted-foreground underline underline-offset-2" onclick={() => (rollbackArmed = false)}>
              {t('common.cancel')}
            </button>
          {:else}
            <button
              type="button"
              class="flex items-center gap-1 text-muted-foreground underline underline-offset-2"
              onclick={() => (rollbackArmed = true)}
              data-testid="bot-widget-micro-rollback"
            >
              <History class="size-3" aria-hidden="true" />
              {t('botWidget.microApp.rollback', { version: (microInfo?.version ?? 2) - 1 })}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="flex justify-end gap-1.5">
    {#if deleteArmed}
      <Button
        size="sm"
        variant="ghost"
        class="h-7 px-2 text-xs"
        onclick={() => (deleteArmed = false)}
        data-testid="bot-widget-detail-delete-dismiss"
      >
        {t('common.cancel')}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        class="h-7 px-2 text-xs"
        disabled={deleting}
        onclick={() => void remove()}
        data-testid="bot-widget-detail-delete-confirm"
      >
        {t('widgetsTab.deleteConfirm')}
      </Button>
    {:else}
      {#if widget.scope === 'bot' && conversationId !== undefined}
        <Button
          size="sm"
          variant="outline"
          class="h-7 gap-1 px-2 text-xs"
          disabled={publishing}
          onclick={() => void publish()}
          data-testid="bot-widget-detail-publish"
        >
          <Send class="size-3" aria-hidden="true" />
          {t('widgetsTab.publish')}
        </Button>
      {/if}
      <Button
        size="sm"
        variant="ghost"
        class="h-7 px-2 text-xs text-destructive"
        onclick={() => (deleteArmed = true)}
        data-testid="bot-widget-detail-delete"
      >
        {t('widgetsTab.delete')}
      </Button>
    {/if}
  </div>
</div>
