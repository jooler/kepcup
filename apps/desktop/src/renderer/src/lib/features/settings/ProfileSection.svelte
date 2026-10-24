<script lang="ts">
  /**
   * 个人资料（Profile）分区：上层是「头像与名称」身份卡 + 用户画像二级菜单
   * （一个分类一条目，右侧箭头示意可点进），下层是各分类 / 画像卡片预览的
   * 详情视图（返回按钮回到菜单）。头像上传先经 AvatarCropper 裁成方形再入库；
   * 名称与头像引用存 settings 行（条目 profile.user-name / profile.user-avatar）。
   */
  import type { ProfileCategory, ProfileItem } from '@kepcup/shared';
  import { ArrowLeft, ChevronRight, ImagePlus, Pencil, UserRound } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { profileStore } from '$lib/stores/profile.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { avatarImages } from '$lib/avatars/avatar-images.svelte';
  import AvatarCropper from '$lib/avatars/AvatarCropper.svelte';
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

  /** 画像的二级视图：'card' = 画像卡片预览，其余 = 分类条目列表。 */
  type PersonaView = 'card' | ProfileCategory;

  let personaView = $state<PersonaView | null>(null);
  let refreshing = $state(false);
  let editingId = $state<string | null>(null);
  let editText = $state('');
  let editCategory = $state<ProfileCategory>('basic');
  let confirmTarget = $state<ProfileItem | null>(null);
  let deleteDialogOpen = $state(false);
  let deleting = $state(false);

  // --- 头像与名称 -----------------------------------------------------------
  let nameDraft = $state<string | null>(null);
  let editingName = $state(false);
  let nameEl: HTMLDivElement | undefined = $state(undefined);
  let avatarBusy = $state(false);
  let cropFile = $state<File | null>(null);
  let avatarInput: HTMLInputElement | null = $state(null);
  let nameTimer: ReturnType<typeof setTimeout> | undefined;

  const savedName = $derived(settingsStore.settings?.userProfileName ?? '');
  /** 展示行的文本：编辑中的草稿优先；为空时模板显示占位提示。 */
  const displayName = $derived(nameDraft ?? savedName);
  const avatarFile = $derived.by(() => {
    const ref = settingsStore.settings?.userProfileAvatar ?? '';
    return ref.startsWith('upload:') ? ref.slice('upload:'.length) : null;
  });
  const avatarUrl = $derived(avatarFile !== null ? avatarImages.user(avatarFile) : null);

  $effect(() => {
    void profileStore.refresh();
  });

  const menuEntries = $derived.by(() => {
    const entries: Array<{ view: PersonaView; label: string; count: number | null }> = [
      { view: 'card', label: t('settings.profileMenuCard'), count: null },
    ];
    for (const category of CATEGORY_ORDER) {
      entries.push({
        view: category,
        label: t(CATEGORY_KEYS[category]),
        count: profileStore.items.filter((item) => item.category === category).length,
      });
    }
    return entries;
  });

  const detailTitle = $derived(
    personaView === null
      ? ''
      : personaView === 'card'
        ? t('settings.profileCardTitle')
        : t(CATEGORY_KEYS[personaView]),
  );
  const detailEntries = $derived(
    personaView === null || personaView === 'card'
      ? []
      : profileStore.items.filter((item) => item.category === personaView),
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

  /**
   * 名称随输入自动保存：停顿 600ms 落一次盘，失焦立即落盘；成功不打扰
   * （连续输入时 toast 会刷屏），失败才提示。与已存值相同则只清草稿。
   */
  async function saveName(): Promise<void> {
    if (nameDraft === null) return;
    const next = nameDraft.trim();
    if (next === savedName) {
      nameDraft = null;
      return;
    }
    try {
      await settingsStore.update({ userProfileName: next });
      nameDraft = null;
    } catch {
      toast.error(t('common.actionFailed'));
    }
  }

  function onNameInput(value: string): void {
    nameDraft = value;
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => void saveName(), 600);
  }

  function onNameBlur(): void {
    clearTimeout(nameTimer);
    void saveName();
    editingName = false;
  }

  /** 光标移到 contenteditable 文本末尾（进入编辑与超长截断后都用）。 */
  function placeCursorEnd(el: HTMLDivElement): void {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /** 点击名称文本 / 笔图标：激活编辑态，光标落到文本最后。 */
  async function startNameEdit(): Promise<void> {
    editingName = true;
    await tick();
    const el = nameEl;
    if (!el) return;
    el.textContent = nameDraft ?? savedName;
    el.focus();
    placeCursorEnd(el);
  }

  function onNameEditInput(): void {
    const el = nameEl;
    if (!el) return;
    let text = el.textContent ?? '';
    if (text.length > 100) {
      // maxlength 语义：截断后光标放回末尾（超长通常发生在末尾继续输入）。
      text = text.slice(0, 100);
      el.textContent = text;
      placeCursorEnd(el);
    }
    onNameInput(text);
  }

  function onNameEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      // contenteditable 里的 Enter 不换行：提交并退出编辑。
      event.preventDefault();
      clearTimeout(nameTimer);
      void saveName();
      editingName = false;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clearTimeout(nameTimer);
      nameDraft = null; // 丢弃草稿；随后的 blur 走 saveName 时草稿为空、不会写回
      editingName = false;
    }
  }

  function pickAvatar(): void {
    avatarInput?.click();
  }

  function onPickAvatar(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    cropFile = file;
  }

  async function onCropConfirm(payload: { mime: 'image/png'; bytesBase64: string }): Promise<void> {
    avatarBusy = true;
    try {
      await core.call('user.avatar.upload', payload);
      cropFile = null;
      toast.success(t('settings.profileAvatarSaved'));
    } catch {
      toast.error(t('common.actionFailed'));
    } finally {
      avatarBusy = false;
    }
  }

  async function removeAvatar(): Promise<void> {
    try {
      await settingsStore.update({ userProfileAvatar: '' });
      toast.success(t('settings.profileAvatarRemoved'));
    } catch {
      toast.error(t('common.actionFailed'));
    }
  }
</script>

<section class="space-y-4" data-testid="settings-profile">
  {#if personaView === null}
    <!-- 上层：身份（头像居中 + 名称随输即存） + 画像菜单 -->
    <div class="space-y-3" data-settings-anchor="profile-identity" data-testid="profile-identity">
      <div class="flex flex-col items-center gap-1.5">
        <button
          type="button"
          class="group relative size-20 shrink-0 cursor-pointer overflow-hidden rounded-full border bg-muted transition-colors hover:bg-accent"
          onclick={pickAvatar}
          title={t('settings.profileAvatarChange')}
          data-testid="profile-avatar-button"
        >
          {#if avatarUrl !== null}
            <img src={avatarUrl} alt="" class="size-full object-cover" draggable="false" />
          {:else}
            <span class="flex size-full items-center justify-center">
              <UserRound class="size-9 text-muted-foreground" aria-hidden="true" />
            </span>
          {/if}
          <span
            class="absolute inset-x-0 bottom-0 flex justify-center bg-black/50 py-1 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <ImagePlus class="size-4 text-white" aria-hidden="true" />
          </span>
        </button>
        {#if avatarFile !== null}
          <button
            type="button"
            class="cursor-pointer text-xs text-destructive transition-colors hover:text-destructive/80 hover:underline"
            disabled={avatarBusy}
            onclick={() => void removeAvatar()}
            data-testid="profile-avatar-remove"
          >
            {t('settings.profileAvatarRemove')}
          </button>
        {/if}
      </div>
      <div class="flex justify-center">
        {#if editingName}
          <div
            bind:this={nameEl}
            class="max-w-full min-w-[4ch] text-center text-sm font-medium outline-none"
            contenteditable="plaintext-only"
            role="textbox"
            tabindex="0"
            aria-label={t('settings.profileNameLabel')}
            oninput={onNameEditInput}
            onkeydown={onNameEditKeydown}
            onblur={onNameBlur}
            data-testid="profile-name-input"
          ></div>
        {:else}
          <button
            type="button"
            class="group/name flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent/50"
            onclick={() => void startNameEdit()}
            title={t('settings.profileNameEditHint')}
            data-testid="profile-name-display"
          >
            <span
              class="truncate text-sm font-medium {displayName.trim().length === 0
                ? 'text-muted-foreground'
                : ''}"
            >
              {displayName.trim().length === 0 ? t('settings.profileNamePlaceholder') : displayName}
            </span>
            <Pencil
              class="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/name:opacity-100"
              aria-hidden="true"
            />
          </button>
        {/if}
      </div>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
        class="hidden"
        bind:this={avatarInput}
        onchange={onPickAvatar}
        data-testid="profile-avatar-input"
      />
    </div>

    <div class="space-y-2" data-settings-anchor="profile-persona" data-testid="profile-persona">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium">{t('settings.profilePersonaTitle')}</h3>
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
      <ul class="overflow-hidden rounded-md border" data-testid="profile-menu">
        {#each menuEntries as entry (entry.view)}
          <li class="border-b last:border-b-0">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
              onclick={() => (personaView = entry.view)}
              data-testid={`profile-menu-${entry.view}`}
            >
              <span class="flex-1">{entry.label}</span>
              {#if entry.count !== null}
                <span class="tabular-nums text-xs text-muted-foreground">{entry.count}</span>
              {/if}
              <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {:else}
    <!-- 下层：画像卡片预览 / 分类详情 -->
    <div class="space-y-3" data-testid={`profile-detail-${personaView}`}>
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          class="-ml-2 h-7 px-2 text-xs"
          onclick={() => (personaView = null)}
          data-testid="profile-back"
        >
          <ArrowLeft class="size-3.5" aria-hidden="true" />
          {t('common.back')}
        </Button>
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
      <h3 class="text-sm font-medium">{detailTitle}</h3>

      {#if personaView === 'card'}
        <div class="rounded-md border p-3" data-testid="profile-card-preview">
          {#if profileStore.card?.content}
            <p class="whitespace-pre-wrap text-sm" data-testid="profile-card-content">
              {profileStore.card.content}
            </p>
            {#if profileStore.card.compiledAt !== null}
              <p class="mt-1 text-xs text-muted-foreground">
                {t('settings.profileCardCompiled', { time: new Date(profileStore.card.compiledAt).toLocaleString() })}
              </p>
            {/if}
          {:else}
            <p class="text-sm text-muted-foreground" data-testid="profile-card-empty">
              {t('settings.profileCardEmpty')}
            </p>
          {/if}
        </div>
      {:else}
        {#if detailEntries.length === 0}
          <p class="text-sm text-muted-foreground" data-testid="profile-empty">{t('settings.profileEmpty')}</p>
        {:else}
          <ul class="space-y-2" data-testid="profile-groups">
            {#each detailEntries as item (item.id)}
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
        {/if}
      {/if}
    </div>
  {/if}
</section>

{#if cropFile !== null}
  <AvatarCropper file={cropFile} busy={avatarBusy} onconfirm={onCropConfirm} oncancel={() => (cropFile = null)} />
{/if}

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
