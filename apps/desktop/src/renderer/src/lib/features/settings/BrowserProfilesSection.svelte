<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { BrowserProfileEntry } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';

  /**
   * 「浏览器资料」section（W8 共享浏览器资料，todo/borrowings-from-personal-agents.md）：
   * 列出共享资料（名称、使用它的 Bot、清除数据、删除），新建与重命名。默认每个
   * Bot 私有；把 Bot 挂到共享资料在 Bot 详情里做。删除 / 清除数据先在行内确认。
   */

  let profiles = $state<BrowserProfileEntry[]>([]);
  let newName = $state('');
  let busy = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let confirming = $state<{ id: string; kind: 'clear' | 'delete' } | null>(null);

  function botNames(ids: string[]): string {
    return ids
      .map((id) => contacts.bots.find((bot) => bot.id === id)?.profile.identity.name ?? id)
      .join('、');
  }

  async function refresh(): Promise<void> {
    const result = (await core.call('browserProfiles.list')) as { profiles: BrowserProfileEntry[] };
    profiles = result.profiles;
  }

  /** Runs a mutation; the settings snapshot (Bot 详情下拉) follows the change. */
  async function run(
    action: () => Promise<{ profiles: BrowserProfileEntry[] }>,
    done?: string,
  ): Promise<void> {
    busy = true;
    try {
      const result = await action();
      profiles = result.profiles;
      void settingsStore.refresh().catch(() => {});
      if (done !== undefined) toast.success(done);
    } catch (error) {
      toast.error(
        t('settings.browserProfilesFailed', { message: String((error as Error).message ?? error) }),
      );
    } finally {
      busy = false;
      confirming = null;
    }
  }

  function create(): void {
    const name = newName.trim();
    if (name.length === 0) return;
    void run(async () => {
      const result = (await core.call('browserProfiles.create', { name })) as {
        profiles: BrowserProfileEntry[];
      };
      newName = '';
      return result;
    });
  }

  function saveRename(profile: BrowserProfileEntry): void {
    const name = renameDraft.trim();
    if (name.length === 0) return;
    void run(async () => {
      const result = (await core.call('browserProfiles.rename', { id: profile.id, name })) as {
        profiles: BrowserProfileEntry[];
      };
      renamingId = null;
      return result;
    });
  }

  function confirmAction(profile: BrowserProfileEntry): void {
    const pending = confirming;
    if (pending === null || pending.id !== profile.id) return;
    const method = pending.kind === 'delete' ? 'browserProfiles.delete' : 'browserProfiles.clear';
    void run(
      () => core.call(method, { id: profile.id }) as Promise<{ profiles: BrowserProfileEntry[] }>,
      pending.kind === 'delete'
        ? t('settings.browserProfilesDeleted', { name: profile.name })
        : t('settings.browserProfilesCleared', { name: profile.name }),
    );
  }

  onMount(() => {
    void refresh().catch(() => {});
  });
</script>

<section class="space-y-4" data-testid="settings-browser-profiles">
  <div class="space-y-1.5">
    <h3 class="text-sm font-medium">{t('settings.browserProfilesTitle')}</h3>
    <p class="text-xs text-muted-foreground">{t('settings.browserProfilesHint')}</p>
    <p class="text-xs text-amber-700 dark:text-amber-400">{t('settings.browserProfilesWarning')}</p>
  </div>

  <form
    class="flex items-center gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      create();
    }}
  >
    <Input
      class="h-8 max-w-xs"
      bind:value={newName}
      maxlength={40}
      placeholder={t('settings.browserProfilesNamePlaceholder')}
      data-testid="browser-profile-new-name"
    />
    <Button
      type="submit"
      size="sm"
      disabled={busy || newName.trim().length === 0}
      data-testid="browser-profile-create"
    >
      {t('settings.browserProfilesCreate')}
    </Button>
  </form>

  {#if profiles.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="browser-profiles-empty">
      {t('settings.browserProfilesEmpty')}
    </p>
  {:else}
    <ul class="space-y-2" data-testid="browser-profiles-list">
      {#each profiles as profile (profile.id)}
        <li
          class="space-y-2 rounded-lg border p-3"
          data-testid={`browser-profile-${profile.id}`}
          data-profile-name={profile.name}
        >
          {#if renamingId === profile.id}
            <form
              class="flex items-center gap-2"
              onsubmit={(event) => {
                event.preventDefault();
                saveRename(profile);
              }}
            >
              <Input
                class="h-8 max-w-xs"
                bind:value={renameDraft}
                maxlength={40}
                data-testid="browser-profile-rename-input"
              />
              <Button type="submit" size="sm" disabled={busy || renameDraft.trim().length === 0}>
                {t('settings.browserProfilesRenameSave')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (renamingId = null)}>
                {t('settings.browserProfilesRenameCancel')}
              </Button>
            </form>
          {:else}
            <div class="flex items-center gap-2">
              <span class="flex-1 truncate text-sm font-medium" data-testid="browser-profile-name">
                {profile.name}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onclick={() => {
                  renamingId = profile.id;
                  renameDraft = profile.name;
                }}
                data-testid="browser-profile-rename"
              >
                {t('settings.browserProfilesRename')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onclick={() => (confirming = { id: profile.id, kind: 'clear' })}
                data-testid="browser-profile-clear"
              >
                {t('settings.browserProfilesClear')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                class="text-destructive"
                disabled={busy}
                onclick={() => (confirming = { id: profile.id, kind: 'delete' })}
                data-testid="browser-profile-delete"
              >
                {t('settings.browserProfilesDelete')}
              </Button>
            </div>
          {/if}
          <p class="text-xs text-muted-foreground" data-testid="browser-profile-bots">
            {profile.botIds.length > 0
              ? t('settings.browserProfilesBots', { names: botNames(profile.botIds) })
              : t('settings.browserProfilesNoBots')}
          </p>
          {#if confirming !== null && confirming.id === profile.id}
            <div
              class="space-y-2 rounded bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300"
              data-testid="browser-profile-confirm"
              data-kind={confirming.kind}
            >
              <p>
                {confirming.kind === 'delete'
                  ? t('settings.browserProfilesDeleteConfirm', { name: profile.name })
                  : t('settings.browserProfilesClearConfirm', { name: profile.name })}
              </p>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onclick={() => confirmAction(profile)}
                  data-testid="browser-profile-confirm-yes"
                >
                  {t('settings.browserProfilesConfirm')}
                </Button>
                <Button size="sm" variant="ghost" onclick={() => (confirming = null)}>
                  {t('settings.browserProfilesCancel')}
                </Button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
