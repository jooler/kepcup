<script lang="ts">
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Users } from '@lucide/svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';

  /**
   * 成员头像堆叠 + 下拉（WP6 §4 步骤 4）：只读名册 + 「管理成员…」跳转。加人
   * 不在弹层里做——由「管理成员…」进详情页成员分区（ProjectMembersEditor）。
   * 自建轻量弹层，不用 bits-ui DropdownMenu；堆叠是重叠式（后一个压前一个，
   * 负责人排最前不加冠标），与侧栏的 ProjectAvatarStack 马赛克语义不同，不复用。
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

  function manageMembers(): void {
    shell.openProjectSettings('members');
    close();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    class="flex cursor-pointer items-center -space-x-4 rounded-full p-0.5 transition-colors hover:bg-accent/60"
    onclick={toggle}
    aria-haspopup="true"
    aria-expanded={open}
    aria-label={t('project.header.membersTrigger')}
    data-testid="project-members-trigger"
  >
    {#each shown as member (member.bot.id)}
      <!-- flex：BotAvatar 是 inline-block，inline 布局的基线会导致头像不垂直居中。 -->
      <span class="relative flex shrink-0">
        <BotAvatar
          botId={member.bot.id}
          name={member.bot.name}
          avatar={member.bot.avatar ?? null}
          class="size-7"
          animated={false}
        />
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
            <span class="min-w-0 flex-1 truncate text-sm">{member.bot.name}</span>
            {#if member.bot.id === leadBotId}
              <span
                class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
              >
                {t('project.members.leadBadge')}
              </span>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="my-1.5 border-t" role="separator"></div>

      <!-- 与成员行同一几何（px-1 py-1.5 + size-7 头像槽位）：标签与上方名字对齐。 -->
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        onclick={manageMembers}
        data-testid="project-members-manage"
      >
        <span class="flex size-7 shrink-0 items-center justify-center">
          <Users class="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <span class="min-w-0 truncate">{t('project.members.manage')}</span>
      </button>
    </div>
  {/if}
</div>
