<script lang="ts">
  import type { ProfileCategory, ProfileItem } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { profileStore } from '$lib/stores/profile.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  const CATEGORY_ORDER: ProfileCategory[] = [
    'basic',
    'communication',
    'work',
    'interests',
    'boundaries',
    'recent',
  ];
  const CATEGORY_KEYS: Record<ProfileCategory, MessageKey> = {
    basic: 'settings.profileCategory.basic',
    communication: 'settings.profileCategory.communication',
    work: 'settings.profileCategory.work',
    interests: 'settings.profileCategory.interests',
    boundaries: 'settings.profileCategory.boundaries',
    recent: 'settings.profileCategory.recent',
  };

  let refreshing = $state(false);
  let editingId = $state<string | null>(null);
  let editText = $state('');
  let editCategory = $state<ProfileCategory>('basic');
  let confirmTarget = $state<ProfileItem | null>(null);
  let deleteDialogOpen = $state(false);
  let deleting = $state(false);

  $effect(() => {
    void profileStore.refresh();
  });

  const groups = $derived(
    CATEGORY_ORDER.map((category) => ({
      category,
      label: t(CATEGORY_KEYS[category]),
      entries: profileStore.items.filter((item) => item.category === category),
    })).filter((group) => group.entries.length > 0),
  );

  function botName(botId: string | null): string {
    if (botId === null) return t('settings.profileContributedUnknown');
    const known = contacts.bots.find((bot) => bot.id === botId);
    return known ? known.name || botId : botId;
  }

  async function refresh(): Promise<void> {
    refreshing = true;
    try {
      await profileStore.refresh();
    } finally {
      refreshing = false;
    }
  }

  function startEdit(item: ProfileItem): void {
    editingId = item.id;
    editText = item.content;
    editCategory = item.category;
  }

  async function saveEdit(item: ProfileItem): Promise<void> {
    const content = editText.trim();
    if (content.length === 0) return;
    try {
      await profileStore.updateItem(item.id, {
        content,
        ...(editCategory !== item.category ? { category: editCategory } : {}),
      });
      editingId = null;
      toast.success(t('settings.profileSaved'));
    } catch {
      toast.error(t('common.actionFailed'));
    }
  }

  async function remove(): Promise<void> {
    const target = confirmTarget;
    if (target === null) return;
    deleting = true;
    try {
      await profileStore.retractItem(target.id);
      toast.success(t('settings.profileDeleted'));
      deleteDialogOpen = false;
      confirmTarget = null;
    } catch {
      toast.error(t('common.actionFailed'));
    } finally {
      deleting = false;
    }
  }
</script>

<section class="space-y-3" data-testid="settings-profile">
  <div class="flex items-center gap-2">
    <h3 class="text-sm font-medium">{t('settings.profileSection')}</h3>
    <Button
      size="sm"
      variant="ghost"
      class="ml-auto h-7 px-2 text-xs"
      disabled={refreshing}
      onclick={() => void refresh()}
      data-testid="profile-refresh"
    >
      {t('common.refresh')}
    </Button>
  </div>
  <p class="text-xs text-muted-foreground">{t('settings.profileNote')}</p>

  <div class="rounded-md border p-3" data-testid="profile-card-preview">
    <h4 class="text-xs font-medium text-muted-foreground">{t('settings.profileCardTitle')}</h4>
    {#if profileStore.card?.content}
      <p class="mt-1 whitespace-pre-wrap text-sm" data-testid="profile-card-content">
        {profileStore.card.content}
      </p>
      {#if profileStore.card.compiledAt !== null}
        <p class="mt-1 text-xs text-muted-foreground">
          {t('settings.profileCardCompiled', { time: new Date(profileStore.card.compiledAt).toLocaleString() })}
        </p>
      {/if}
    {:else}
      <p class="mt-1 text-sm text-muted-foreground" data-testid="profile-card-empty">
        {t('settings.profileCardEmpty')}
      </p>
    {/if}
  </div>

  {#if groups.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="profile-empty">{t('settings.profileEmpty')}</p>
  {:else}
    <div class="space-y-4" data-testid="profile-groups">
      {#each groups as group (group.category)}
        <div class="space-y-2">
          <h4 class="text-xs font-medium text-muted-foreground">
            {group.label}
            <span class="tabular-nums">({group.entries.length})</span>
          </h4>
          <ul class="space-y-2">
            {#each group.entries as item (item.id)}
              <li class="rounded-md border p-3 text-sm" data-testid={`profile-item-${item.id}`}>
                {#if editingId === item.id}
                  <div class="grid gap-2">
                    <Textarea bind:value={editText} rows={3} data-testid="profile-edit-input" />
                    <div class="grid gap-1.5">
                      <Label for={`profile-category-${item.id}`}>{t('settings.profileCategoryLabel')}</Label>
                      <select
                        id={`profile-category-${item.id}`}
                        class="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm"
                        bind:value={editCategory}
                        data-testid="profile-edit-category"
                      >
                        {#each CATEGORY_ORDER as category (category)}
                          <option value={category}>{t(CATEGORY_KEYS[category])}</option>
                        {/each}
                      </select>
                    </div>
                    <div class="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onclick={() => (editingId = null)} data-testid="profile-edit-cancel">
                        {t('common.cancel')}
                      </Button>
                      <Button size="sm" onclick={() => void saveEdit(item)} data-testid="profile-edit-save">
                        {t('common.save')}
                      </Button>
                    </div>
                  </div>
                {:else}
                  <p class="whitespace-pre-wrap break-words" data-testid="profile-item-content">{item.content}</p>
                  <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{t(CATEGORY_KEYS[item.category])}</Badge>
                    <span data-testid="profile-item-contributed">
                      {item.contributedBy !== null
                        ? t('settings.profileContributedBy', { name: botName(item.contributedBy) })
                        : t('settings.profileContributedUnknown')}
                    </span>
                    <span>{t(item.source === 'explicit' ? 'settings.profileSourceExplicit' : 'settings.profileSourceInferred')}</span>
                    <div class="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" onclick={() => startEdit(item)} data-testid={`profile-edit-${item.id}`}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        class="h-6 px-2 text-xs text-destructive"
                        onclick={() => {
                          confirmTarget = item;
                          deleteDialogOpen = true;
                        }}
                        data-testid={`profile-delete-${item.id}`}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  {/if}
</section>

<Dialog bind:open={deleteDialogOpen}>
  <DialogContent data-testid="profile-delete-dialog">
    <DialogHeader>
      <DialogTitle>{t('settings.profileDeleteTitle')}</DialogTitle>
      <DialogDescription>{t('settings.profileDeleteBody')}</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={() => (deleteDialogOpen = false)}>{t('common.cancel')}</Button>
      <Button variant="destructive" disabled={deleting} onclick={() => void remove()} data-testid="profile-delete-confirm">
        {t('common.delete')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
