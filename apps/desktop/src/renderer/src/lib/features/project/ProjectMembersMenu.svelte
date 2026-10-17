<script lang="ts">
  import { Crown } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import ProjectMemberPicker from './ProjectMemberPicker.svelte';

  /**
   * 成员头像堆叠 + 下拉（WP6 §4 步骤 4）。自建轻量弹层，不用 bits-ui
   * DropdownMenu——里面要放搜索输入框，菜单的 typeahead 会吃掉按键；仓库也没有
   * popover 组件。堆叠是重叠式（后一个压前一个、负责人在最前带冠标），与侧栏的
   * ProjectAvatarStack 马赛克语义不同，不复用它。
   */
  const STACK_MAX = 5;

  const current = $derived(chat.current);
  const conversation = $derived(current?.conversation ?? null);
  const leadBotId = $derived(conversation?.leadBotId ?? null);

  /** 菜单与堆叠的成员顺序：负责人最前，其余按入群顺序。 */
  const members = $derived.by(() => {
    const list = [...(current?.members ?? [])];
    list.sort((a, b) => {
      if (a.bot.id === leadBotId) return -1;
      if (b.bot.id === leadBotId) return 1;
      return a.joinedAt - b.joinedAt;
    });
    return list;
  });
  const shown = $derived(members.slice(0, STACK_MAX));
  const overflow = $derived(Math.max(0, members.length - STACK_MAX));

  let open = $state(false);
  let root: HTMLElement | undefined = $state();

  // Focus lands on the search box when the menu opens (no extra mouse move
  // for picking or Esc-closing); the input lives inside ProjectMemberPicker,
  // so reach it here by its testid.
  $effect(() => {
    if (open)
      queueMicrotask(() =>
        root?.querySelector<HTMLInputElement>('input[data-testid="project-member-add"]')?.focus(),
      );
  });

  const memberIds = $derived(members.map((member) => member.bot.id));

  function close(): void {
    open = false;
  }

  function toggle(): void {
    if (open) close();
    else open = true;
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (!open) return;
    if (root?.contains(event.target as Node)) return;
    close();
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return;
    close();
  }

  /**
   * The picker stops all keystrokes from leaking (global shortcuts listen at
   * the window level); Esc is intercepted here on the capture phase so
   * pressing it in the search box still closes the menu.
   */
  function onPickerKeydownCapture(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  async function addMember(botId: string): Promise<void> {
    if (!conversation) return;
    // The member list refreshes itself via the conversation.updated event.
    await chat.addProjectMembers(conversation.id, [botId]);
  }

  function manageMembers(): void {
    shell.openProjectSettings('members');
    close();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    class="flex items-center -space-x-2 rounded-md p-0.5 transition-colors hover:bg-accent/60"
    onclick={toggle}
    aria-haspopup="true"
    aria-expanded={open}
    aria-label={t('project.header.membersTrigger')}
    data-testid="project-members-trigger"
  >
    {#each shown as member (member.bot.id)}
      <span class="relative shrink-0">
        <BotAvatar
          botId={member.bot.id}
          name={member.bot.name}
          avatar={member.bot.avatar ?? null}
          class="size-7 rounded-full ring-2 ring-background"
          animated={false}
        />
        {#if member.bot.id === leadBotId}
          <Crown class="absolute -right-0.5 -bottom-0.5 size-3 text-amber-500" aria-hidden="true" />
        {/if}
      </span>
    {/each}
    {#if overflow > 0}
      <span
        class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background tabular-nums"
      >
        +{overflow}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      class="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border bg-background p-2 shadow-lg"
      data-testid="project-members-menu"
    >
      <p class="px-1 py-1 text-xs text-muted-foreground">
        {t('project.members.title')} · {t('project.members.count', { count: members.length })}
      </p>
      <ul class="max-h-56 space-y-0.5 overflow-y-auto">
        {#each members as member (member.bot.id)}
          <li
            class="flex items-center gap-2 rounded-md px-1 py-1.5"
            data-testid={`project-member-row-${member.bot.id}`}
          >
            <BotAvatar
              botId={member.bot.id}
              name={member.bot.name}
              avatar={member.bot.avatar ?? null}
              class="size-7 shrink-0"
              animated={false}
            />
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1">
                <span class="truncate text-sm">{member.bot.name}</span>
                {#if member.bot.id === leadBotId}
                  <span
                    class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                  >
                    {t('project.members.leadBadge')}
                  </span>
                {/if}
              </span>
              <span class="block truncate text-xs text-muted-foreground">
                {member.bot.profile.role.responsibilities || member.bot.bio}
              </span>
            </span>
          </li>
        {/each}
      </ul>

      <div class="my-1.5 border-t" role="separator"></div>

      <p class="px-1 pb-1 text-xs font-medium">{t('project.members.add')}</p>
      <div onkeydowncapture={onPickerKeydownCapture}>
        <ProjectMemberPicker excludeIds={memberIds} onPick={addMember} testid="project-member-add" />
      </div>

      <button
        type="button"
        class="mt-1 w-full rounded-md px-1 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={manageMembers}
        data-testid="project-members-manage"
      >
        {t('project.members.manage')}
      </button>
    </div>
  {/if}
</div>
