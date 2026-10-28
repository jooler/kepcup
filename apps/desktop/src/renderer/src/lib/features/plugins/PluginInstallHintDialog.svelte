<script lang="ts">
  import type { Bot } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 安装成功接入引导（D105 P4 目标 5）：插件的能力不会自动生效——弹框告知需要到
   * Bot 详情 / 项目组设置启用，附「以后不再提醒」（设备级 UI 偏好走 localStorage，
   * 先例 `kepcup.apps.acpNoticeAck`，不入设置目录）与「立即添加到 Bot…」捷径
   * （二级视图：Bot 多选 → 合并写入各 Bot 的 plugin_ids）。只在安装路径出现
   * （市场 + 本地），更新与 Bot 发起的对话内确认卡不弹（对话内已有上下文）。
   */

  const DISMISSED_KEY = 'kepcup.plugins.installHint.dismissed';

  let {
    open = $bindable(false),
    plugin,
  }: {
    open: boolean;
    /** 刚安装成功的插件（名字用于标题与 Bot 选择文案）。 */
    plugin: { id: string; name: string } | null;
  } = $props();

  let view = $state<'hint' | 'pickBots'>('hint');
  let neverRemind = $state(false);
  let bots = $state<Bot[]>([]);
  let selectedBotIds = $state<string[]>([]);
  let loadingBots = $state(false);
  let adding = $state(false);

  // 每次打开都回到第一视图（上次「立即添加」中途关掉时不残留二级视图）。
  $effect(() => {
    if (open) {
      view = 'hint';
      neverRemind = false;
    }
  });

  async function openBotPicker(): Promise<void> {
    loadingBots = true;
    try {
      const result = (await core.call('bots.list', undefined)) as { bots: Bot[] };
      bots = result.bots.filter((bot) => bot.status === 'active');
      selectedBotIds = [];
      view = 'pickBots';
    } catch (error) {
      toast.error(explain(error));
    } finally {
      loadingBots = false;
    }
  }

  function toggleBot(botId: string, on: boolean): void {
    selectedBotIds = on
      ? [...selectedBotIds, botId]
      : selectedBotIds.filter((id) => id !== botId);
  }

  /**
   * 合并写入：`plugins.setBotPlugins` 是整集替换，这里读各 Bot 现有启用集并集上新
   * 插件再逐个写（Bot 数量小，串行即可）。
   */
  async function addToSelectedBots(): Promise<void> {
    if (plugin === null || adding) return;
    adding = true;
    try {
      for (const bot of bots.filter((candidate) => selectedBotIds.includes(candidate.id))) {
        const next = [
          ...new Set([...(bot.profile.runtime.plugin_ids ?? []), plugin.id]),
        ];
        await core.call('plugins.setBotPlugins', { botId: bot.id, pluginIds: next });
      }
      toast.success(t('plugins.installHint.added', { count: selectedBotIds.length }));
      finish();
    } catch (error) {
      toast.error(explain(error));
    } finally {
      adding = false;
    }
  }

  /** 关闭；勾了「不再提醒」就落 localStorage（本设备不再弹）。 */
  function finish(): void {
    if (neverRemind) {
      try {
        localStorage.setItem(DISMISSED_KEY, '1');
      } catch {
        // localStorage 不可用（隐私模式等）：只影响本设备偏好，不阻塞关闭。
      }
    }
    open = false;
  }

  function explain(error: unknown): string {
    const code = (error as { code?: string } | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    return errorText(code, message);
  }
</script>

<Dialog
  bind:open
  onOpenChange={(next) => {
    if (!next) finish();
  }}
>
  <DialogContent class="sm:max-w-md" data-testid="plugins-install-hint">
    {#if plugin !== null}
        {#if view === 'hint'}
          <DialogHeader>
            <DialogTitle data-testid="plugins-install-hint-title">
              {t('plugins.installHint.title', { name: plugin.name })}
            </DialogTitle>
            <DialogDescription>{t('plugins.installHint.body')}</DialogDescription>
          </DialogHeader>
          <label class="flex items-center gap-2 text-sm" data-testid="plugins-install-hint-never">
            <Checkbox bind:checked={neverRemind} data-testid="plugins-install-hint-dismiss" />
            {t('plugins.installHint.dismiss')}
          </label>
          <div class="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={loadingBots}
              onclick={() => void openBotPicker()}
              data-testid="plugins-install-hint-add"
            >
              {t('plugins.installHint.addToBots')}
            </Button>
            <Button size="sm" variant="ghost" onclick={finish} data-testid="plugins-install-hint-done">
              {t('plugins.installHint.done')}
            </Button>
          </div>
        {:else}
          <DialogHeader>
            <DialogTitle>{t('plugins.installHint.pickTitle')}</DialogTitle>
            <DialogDescription>
              {t('plugins.installHint.pickHint', { name: plugin.name })}
            </DialogDescription>
          </DialogHeader>
          <div class="max-h-64 space-y-1.5 overflow-y-auto" data-testid="plugins-install-hint-bots">
            {#each bots as bot (bot.id)}
              <label class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent/40">
                <Checkbox
                  checked={selectedBotIds.includes(bot.id)}
                  onCheckedChange={(checked) => toggleBot(bot.id, checked === true)}
                  data-testid={`plugins-install-hint-bot-${bot.id}`}
                />
                <span class="min-w-0 flex-1 truncate">{bot.name}</span>
              </label>
            {:else}
              <p class="px-1 py-3 text-center text-xs text-muted-foreground">
                {t('plugins.installHint.noBots')}
              </p>
            {/each}
          </div>
          <div class="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onclick={() => (view = 'hint')}
              data-testid="plugins-install-hint-back"
            >
              {t('plugins.installHint.back')}
            </Button>
            <Button
              size="sm"
              disabled={adding || selectedBotIds.length === 0}
              onclick={() => void addToSelectedBots()}
              data-testid="plugins-install-hint-confirm"
            >
              {t('plugins.installHint.add')}
            </Button>
          </div>
        {/if}
    {/if}
  </DialogContent>
</Dialog>
