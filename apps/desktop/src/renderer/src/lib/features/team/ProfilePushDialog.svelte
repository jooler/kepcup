<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { profilePush } from './profile-push.svelte';

  /**
   * 画像上行确认清单（T7 步骤 5，62.05 §1）：本机 profile.list 条目逐条勾选
   * ——`boundaries` 类与命中敏感规则的条目默认不勾选（列 sensitive 标记）；
   * 确认后经团队连接 team.profile.push 上行（只补不删）。仅桌面端点挂载。
   * 上行成功即关闭（结果用 toast 反馈），不让用户误以为还有未完成的事务。
   */

  async function confirm(): Promise<void> {
    const result = await profilePush.confirm();
    if (result !== null) {
      toast.success(
        t('team.profilePushResult', { added: result.added, skipped: result.skipped }),
      );
    }
  }
</script>

<Dialog.Root open={profilePush.open} onOpenChange={(open) => !open && profilePush.close()}>
  <Dialog.Content class="max-w-lg" data-testid="profile-push-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('team.profilePushTitle')}</Dialog.Title>
      <Dialog.Description>{t('team.profilePushBody')}</Dialog.Description>
    </Dialog.Header>

    {#if profilePush.loading}
      <p class="py-6 text-center text-sm text-muted-foreground" data-testid="profile-push-loading">
        {t('team.profilePushLoading')}
      </p>
    {:else if profilePush.error !== null}
      <p class="py-4 text-sm text-destructive" data-testid="profile-push-error">
        {t('team.profilePushError')}
      </p>
    {:else if profilePush.items.length === 0}
      <p class="py-6 text-center text-sm text-muted-foreground" data-testid="profile-push-empty">
        {t('team.profilePushEmpty')}
      </p>
    {:else}
      <ul class="max-h-72 space-y-1 overflow-y-auto" data-testid="profile-push-list">
        {#each profilePush.items as item (item.id)}
          <li>
            <label
              class="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-accent/40"
              data-testid={`profile-push-item-${item.id}`}
              data-sensitive={item.sensitive ? 'true' : 'false'}
            >
              <input
                type="checkbox"
                class="mt-0.5"
                checked={item.checked}
                onchange={() => profilePush.toggle(item.id)}
                data-testid={`profile-push-check-${item.id}`}
              />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="text-xs text-muted-foreground">{item.category}</span>
                  {#if item.sensitive}
                    <span
                      class="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                      data-testid={`profile-push-sensitive-${item.id}`}
                      >{t('team.profilePushSensitive')}</span
                    >
                  {/if}
                </span>
                <span class="mt-0.5 block truncate">{item.content}</span>
              </span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={() => profilePush.close()} data-testid="profile-push-cancel">
        {t('contacts.cancel')}
      </Button>
      <Button
        disabled={profilePush.pushing || profilePush.items.every((item) => !item.checked)}
        onclick={() => void confirm()}
        data-testid="profile-push-confirm"
      >
        {profilePush.pushing ? t('team.profilePushPushing') : t('team.profilePushConfirm')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
