<script lang="ts">
  import type { ShareTarget } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { shareRecovery } from './share-recovery.svelte';

  /**
   * 分享失败恢复面板（D94 §8.1）。
   *
   * 分享批次投递失败（目标被删 / 只读 / 文件校验不过）时不丢文件：core 把批次
   * 记进 `share_intakes`，本面板列出它们，用户可以重选目标重试、或删除。
   * 写操作一律走 core 的 `share.failed.*`，面板不直接碰文件。
   *
   * 空列表不显示任何入口（没有失败就没有这块 UI）。
   */

  /** 错误码 → 文案 key（core 只给机器码，界面按码映射短文案）。 */
  const ERROR_KEYS: Record<string, MessageKey> = {
    SHARE_INTAKE_INVALID: 'share.error.SHARE_INTAKE_INVALID',
    SHARE_TARGET_NOT_FOUND: 'share.error.SHARE_TARGET_NOT_FOUND',
    SHARE_TARGET_READ_ONLY: 'share.error.SHARE_TARGET_READ_ONLY',
    SHARE_FILE_TOO_LARGE: 'share.error.SHARE_FILE_TOO_LARGE',
    SHARE_MATERIALIZE_FAILED: 'share.error.SHARE_MATERIALIZE_FAILED',
  };

  const items = $derived(shareRecovery.items);
  const visible = $derived(items.length > 0);

  $effect(() => {
    shareRecovery.start();
    void shareRecovery.refresh();
  });

  function targetLabel(target: ShareTarget): string {
    if (target.kind === 'bot') {
      return contacts.bots.find((bot) => bot.id === target.id)?.name ?? target.id;
    }
    return (
      contacts.projects.find((conversation) => conversation.id === target.id)?.title ?? target.id
    );
  }

  const botOptions = $derived(
    contacts.bots.filter((bot) =>
      shareRecovery.query.trim().length === 0
        ? true
        : bot.name.includes(shareRecovery.query.trim()),
    ),
  );
  const projectOptions = $derived(
    contacts.projects.filter((conversation) =>
      shareRecovery.query.trim().length === 0
        ? true
        : (conversation.title ?? '').includes(shareRecovery.query.trim()),
    ),
  );

  async function retry(intakeId: string, target: ShareTarget): Promise<void> {
    const result = await shareRecovery.retry(intakeId, target);
    if (result === 'done') toast.success(t('share.recovery.retried'));
    else toast.error(t('share.recovery.retryFailed'));
  }

  async function discard(intakeId: string): Promise<void> {
    const ok = await shareRecovery.discard(intakeId);
    if (ok) toast.success(t('share.recovery.discarded'));
    else toast.error(t('share.recovery.discardFailed'));
  }

  function formatSize(size: number): string {
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
    return `${(size / 1024 / 1024).toFixed(1)}MB`;
  }

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  function errorText(code: string): string {
    const key = ERROR_KEYS[code];
    return key === undefined ? t('share.error.SHARE_INTAKE_INVALID') : t(key);
  }
</script>

{#if visible}
  <div
    class="app-no-drag fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] space-y-2 rounded-lg border bg-popover p-3 shadow-lg"
    data-testid="share-recovery-panel"
  >
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold">{t('share.recovery.title')}</h2>
      <span class="text-xs text-muted-foreground">{items.length}</span>
    </div>
    <ul class="max-h-72 space-y-2 overflow-y-auto">
      {#each items as item (item.intakeId)}
        <li
          class="rounded-md border p-2 text-xs"
          data-testid={`share-recovery-item-${item.intakeId}`}
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="truncate font-medium">
                {item.files.map((file) => file.originalName).join('、') ||
                  t('share.recovery.noFiles')}
              </div>
              <div class="text-muted-foreground">
                {item.files.map((file) => formatSize(file.size)).join('、')} · {formatTime(
                  item.createdAt,
                )}
              </div>
              <div class="text-muted-foreground">
                {t('share.recovery.originalTarget')}: {targetLabel(item.target)}
              </div>
              <div class="text-muted-foreground">
                {t('share.recovery.reason')}: {errorText(item.errorCode)}
              </div>
              <div class="text-muted-foreground">
                {t('share.recovery.expiresAt')}: {formatTime(item.expiresAt)}
              </div>
            </div>
          </div>
          <div class="mt-2 flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={shareRecovery.busyId === item.intakeId}
              onclick={() => void retry(item.intakeId, item.target)}
              data-testid={`share-recovery-retry-${item.intakeId}`}
            >
              {t('share.recovery.retry')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={shareRecovery.busyId === item.intakeId}
              onclick={() => shareRecovery.toggleReselect(item.intakeId)}
              data-testid={`share-recovery-reselect-${item.intakeId}`}
            >
              {t('share.recovery.reselect')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={shareRecovery.busyId === item.intakeId}
              onclick={() => void discard(item.intakeId)}
              data-testid={`share-recovery-discard-${item.intakeId}`}
            >
              {t('share.recovery.discard')}
            </Button>
          </div>
          {#if shareRecovery.reselecting === item.intakeId}
            <div class="mt-2 space-y-1 border-t pt-2">
              <Input
                value={shareRecovery.query}
                oninput={(event) => {
                  shareRecovery.query = event.currentTarget.value;
                }}
                placeholder={t('share.recovery.searchTarget')}
                class="h-7 text-xs"
                data-testid={`share-recovery-search-${item.intakeId}`}
              />
              <ul class="max-h-32 space-y-0.5 overflow-y-auto">
                {#each botOptions as bot (bot.id)}
                  <li>
                    <button
                      type="button"
                      class="w-full truncate rounded px-1 py-0.5 text-left hover:bg-accent"
                      onclick={() => void retry(item.intakeId, { kind: 'bot', id: bot.id })}
                      data-testid={`share-recovery-bot-${bot.id}`}
                    >
                      {bot.name}
                    </button>
                  </li>
                {/each}
                {#each projectOptions as project (project.id)}
                  <li>
                    <button
                      type="button"
                      class="w-full truncate rounded px-1 py-0.5 text-left hover:bg-accent"
                      onclick={() => void retry(item.intakeId, { kind: 'project', id: project.id })}
                      data-testid={`share-recovery-project-${project.id}`}
                    >
                      {project.title ?? project.id}
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
