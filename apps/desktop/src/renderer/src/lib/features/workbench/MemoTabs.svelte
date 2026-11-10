<script lang="ts">
  import type { MemoGroup } from '@kepcup/shared';
  import { MEMO_GROUP_TITLE_MAX_CHARS } from '@kepcup/shared';
  import { MoreHorizontal, Pencil, Plus, Trash2 } from '@lucide/svelte';
  import { dragHandle, dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import {
    anchorFromFinalize,
    createClickGuard,
    isNoopMove,
    isShadow,
    stripShadow,
  } from '$lib/features/board/board-dnd';
  import MemoTabDropZone from './MemoTabDropZone.svelte';
  import type { MemoTabId } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘的分组 tab 栏（D90 §5.4 tab 化）。
   *
   * - 「未分组」伪分组 tab 恒在第一位、不在拖拽区里（不能排序 / 改名 / 删除）；没有未分组条目时
   *   隐藏，拖拽中仍显示（卡片要能拖回未分组）。隐藏只是 display:none，落区注册保留。
   * - 命名分组 tab 在分组拖拽区里（type 'group'）拖拽排序。整个 tab 是把手层：按下不移动 = 点击
   *   切换，移动 = 拖拽（dnd-action 移动 3px 才起拖）；可见的标题按钮 pointer-events: none，
   *   只为键盘切换留焦点（把手的 Space / Enter 归键盘拖拽）。
   * - 当前 tab 上带「…」菜单：重命名（行内输入框；也可双击标题）与分隔线下的删除（确认后组内
   *   备忘回到未分组）。菜单项只登记动作，菜单关完再执行（见 onMenuCloseAutoFocus）。
   * - 每个 tab 叠一层备忘落区（MemoTabDropZone）：拖着卡片悬停 → 切到该分组，再放进网格。
   */
  let {
    active,
    ungroupedShown,
    flipDurationMs,
    onSelect,
  }: {
    /** 生效 tab（已回落过）；null = 还没有任何 tab。 */
    active: MemoTabId | null;
    ungroupedShown: boolean;
    flipDurationMs: number;
    onSelect: (id: MemoTabId) => void;
  } = $props();

  let groupItems = $state.raw<MemoGroup[]>([]);
  /** 拖着卡片正悬停在哪个 tab 上（高亮落点）。 */
  let hoverTab = $state<MemoTabId | null>(null);

  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);

  let deleting = $state<MemoGroup | null>(null);

  // 新建分组弹框：工作台离开即卸载（与抽屉一致），状态放组件内即可。
  let createOpen = $state(false);
  let groupName = $state('');
  let nameInput = $state<HTMLInputElement | null>(null);
  let creating = $state(false);

  /** 拖完 tab 松手时浏览器会补发一次 click，别让它顺手切了 tab。 */
  const clickGuard = createClickGuard();

  const counts = $derived.by(() => {
    // Plain Map: count memos per group for one render pass, not reactive UI state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const map = new Map<string | null, number>();
    for (const memo of workbench.memos) map.set(memo.groupId, (map.get(memo.groupId) ?? 0) + 1);
    return map;
  });

  $effect(() => {
    const next = workbench.memoGroups;
    if (workbench.groupDragging) return;
    groupItems = next;
  });

  // 重命名输入框出现时聚焦并全选；新建弹框打开时同理。
  $effect(() => {
    if (renamingId === null) return;
    queueMicrotask(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  });

  $effect(() => {
    if (!createOpen) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  function countOf(groupId: string | null): number {
    return counts.get(groupId) ?? 0;
  }

  function select(id: MemoTabId): void {
    if (clickGuard.ignores()) return;
    onSelect(id);
  }

  function setHover(id: MemoTabId, hovering: boolean): void {
    if (hovering) hoverTab = id;
    else if (hoverTab === id) hoverTab = null;
  }

  function onGroupConsider(event: CustomEvent<DndEvent<MemoGroup>>): void {
    const info = event.detail.info;
    if (info.trigger === 'dragStopped') {
      workbench.setGroupDragging(false);
      return;
    }
    groupItems = event.detail.items;
    workbench.setGroupDragging(true);
  }

  function onGroupFinalize(event: CustomEvent<DndEvent<MemoGroup>>): void {
    const info = event.detail.info;
    if (info.source !== 'keyboard') clickGuard.arm();
    const decision = anchorFromFinalize({
      items: event.detail.items,
      droppedId: info.id,
      info,
    });
    if (decision.kind === 'ignore') {
      if (info.trigger === 'droppedIntoAnother') groupItems = stripShadow(event.detail.items);
      if (info.source !== 'keyboard') workbench.setGroupDragging(false);
      return;
    }
    const next = stripShadow(event.detail.items);
    const prevIds = workbench.memoGroups.map((group) => group.id);
    groupItems = next;
    if (!isNoopMove(prevIds, next.map((group) => group.id))) {
      void workbench.moveGroup(info.id, decision.beforeId);
    }
    if (info.source !== 'keyboard') workbench.setGroupDragging(false);
  }

  function startRename(group: MemoGroup): void {
    renameDraft = group.title;
    renamingId = group.id;
  }

  /** 「…」菜单里选中的动作，等菜单关完再执行（见 onMenuCloseAutoFocus）。不进响应式。 */
  let pendingAction: { kind: 'rename' | 'delete'; group: MemoGroup } | null = null;

  function queueAction(kind: 'rename' | 'delete', group: MemoGroup): void {
    pendingAction = { kind, group };
  }

  /**
   * 菜单关闭、要把焦点还给「…」的那一刻才动手，并阻止归还：重命名时「…」随即被输入框替换，
   * 抢回焦点会让输入框立刻失焦提交；删除时焦点交给确认弹框，也免得菜单与弹框的模态层叠在一起。
   * 分组可能刚被别处删掉（事件重拉），那就什么也不做。
   */
  function onMenuCloseAutoFocus(event: Event): void {
    const action = pendingAction;
    if (action === null) return;
    pendingAction = null;
    event.preventDefault();
    if (!workbench.memoGroups.some((group) => group.id === action.group.id)) return;
    if (action.kind === 'rename') startRename(action.group);
    else deleting = action.group;
  }

  /** 菜单打开时清掉上一个菜单没来得及执行的动作，免得它在这次关闭时被误执行。 */
  function onMenuOpenChange(open: boolean): void {
    if (open) pendingAction = null;
  }

  async function commitRename(): Promise<void> {
    const id = renamingId;
    if (id === null) return;
    renamingId = null;
    await workbench.renameGroup(id, renameDraft);
  }

  function onRenameKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renamingId = null;
    }
  }

  function openCreateGroup(): void {
    groupName = '';
    createOpen = true;
  }

  /**
   * 先取出要删的分组再关弹框：模板里的 `{@const target = deleting}` 是派生值，
   * `deleting = null` 之后再读它就成了 null。
   */
  function confirmDeleteGroup(): void {
    const group = deleting;
    deleting = null;
    if (group !== null) void workbench.deleteGroup(group.id);
  }

  async function confirmCreateGroup(): Promise<void> {
    const title = groupName.trim();
    if (title.length === 0 || creating) return;
    creating = true;
    try {
      const group = await workbench.createGroup(title);
      if (group !== null) {
        createOpen = false;
        onSelect(group.id);
      }
    } finally {
      creating = false;
    }
  }

  function onCreateGroupKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void confirmCreateGroup();
  }

  function tabClass(id: MemoTabId): string {
    const base =
      'relative flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors';
    // 亮色主题的 --muted 是纯白、--background 是浅灰：轨道用前景色叠一层，选中块用 card（暗色用更亮的 accent）。
    const state =
      active === id
        ? 'bg-card text-foreground shadow-sm dark:bg-accent'
        : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground';
    const drop = hoverTab === id ? 'ring-2 ring-primary/60' : '';
    return `${base} ${state} ${drop}`;
  }
</script>

<div class="flex min-w-0 shrink-0 items-center gap-1.5">
  <!-- 一个 tab 都没有（无未分组条目、无命名分组）时只留「+」；同样只是 display:none。 -->
  <div
    class="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-foreground/[0.05] p-[3px]"
    style:display={ungroupedShown || groupItems.length > 0 ? undefined : 'none'}
    role="tablist"
    aria-label={t('workbench.memo.tabsLabel')}
    data-testid="memo-tabs"
  >
    <!-- 伪分组 tab：恒在第一位，不在拖拽区里；隐藏只是 display:none（落区注册保留）。
         用内联 display 而不是 hidden 类：tab 自身带 flex，两个 display 工具类谁赢看样式表顺序。 -->
    <div
      class={tabClass('ungrouped')}
      style:display={ungroupedShown ? undefined : 'none'}
      data-testid="memo-tab"
      data-tab-id="ungrouped"
      data-active={active === 'ungrouped' ? 'true' : 'false'}
    >
      <MemoTabDropZone
        groupId={null}
        onHoverChange={(hovering) => setHover('ungrouped', hovering)}
        onDwell={() => onSelect('ungrouped')}
      />
      <button
        type="button"
        role="tab"
        aria-selected={active === 'ungrouped'}
        class="absolute inset-0 cursor-pointer rounded-md"
        aria-label={t('workbench.memo.ungrouped')}
        onclick={() => select('ungrouped')}
        data-testid="memo-tab-select"
      ></button>
      <span class="pointer-events-none relative" data-testid="memo-tab-title">
        {t('workbench.memo.ungrouped')}
      </span>
      <span class="pointer-events-none relative tabular-nums opacity-60" data-testid="memo-tab-count">
        {countOf(null)}
      </span>
    </div>

    <div
      class="flex items-center gap-0.5"
      data-testid="memo-groups-zone"
      use:dragHandleZone={{
        items: groupItems,
        type: 'group',
        flipDurationMs,
        morphDisabled: true,
        dropTargetStyle: {},
      }}
      onconsider={onGroupConsider}
      onfinalize={onGroupFinalize}
    >
      {#each groupItems as group (group.id)}
        {#if isShadow(group)}
          <!-- 排序占位：照被拖 tab 的内容撑出同样的宽度，只留虚线框。 -->
          <div
            class="flex h-7 shrink-0 items-center gap-1 rounded-md border border-dashed border-foreground/25 px-2.5 text-xs font-medium whitespace-nowrap text-transparent"
            aria-hidden="true"
          >
            <span>{group.title}</span><span class="tabular-nums">{countOf(group.id)}</span>
          </div>
        {:else}
          <div
            class={tabClass(group.id)}
            data-testid="memo-tab"
            data-tab-id={group.id}
            data-active={active === group.id ? 'true' : 'false'}
          >
            <MemoTabDropZone
              groupId={group.id}
              onHoverChange={(hovering) => setHover(group.id, hovering)}
              onDwell={() => onSelect(group.id)}
            />
            {#if renamingId === group.id}
              <Input
                bind:ref={renameInput}
                bind:value={renameDraft}
                maxlength={MEMO_GROUP_TITLE_MAX_CHARS}
                class="relative h-5 w-32 px-1.5 text-xs"
                aria-label={t('workbench.memo.renameGroup')}
                onkeydown={onRenameKeydown}
                onblur={() => void commitRename()}
                data-testid="memo-group-rename-input"
              />
            {:else}
              <!-- 把手层：整个 tab 可点（切换）也可拖（排序）；双击改名。键盘切换走下面的标题按钮
                   （把手的 Space / Enter 归 dnd-action 的键盘拖拽），所以这里只接鼠标点击。
                   role / tabindex 与 dragHandle 运行时设置的一致。 -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="absolute inset-0 rounded-md"
                role="button"
                tabindex="0"
                aria-label={t('workbench.memo.tabHandle', { name: group.title })}
                onclick={() => select(group.id)}
                ondblclick={() => startRename(group)}
                data-testid="memo-group-handle"
                use:dragHandle
              ></div>
              <!-- 标题按钮只为键盘切换留焦点；鼠标穿透到下面的把手层。 -->
              <button
                type="button"
                role="tab"
                aria-selected={active === group.id}
                class="pointer-events-none relative max-w-40 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onclick={() => onSelect(group.id)}
                data-testid="memo-tab-title"
              >
                {group.title}
              </button>
              <span
                class="pointer-events-none relative tabular-nums opacity-60"
                data-testid="memo-tab-count"
              >
                {countOf(group.id)}
              </span>
              {#if active === group.id}
                <DropdownMenu.Root onOpenChange={onMenuOpenChange}>
                  <DropdownMenu.Trigger
                    class="relative -mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    aria-label={t('workbench.memo.groupMenu', { name: group.title })}
                    title={t('workbench.memo.groupMenu', { name: group.title })}
                    data-testid="memo-group-more"
                  >
                    <MoreHorizontal class="size-3.5" aria-hidden="true" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content
                    align="start"
                    class="w-36"
                    onCloseAutoFocus={onMenuCloseAutoFocus}
                    data-testid="memo-group-menu"
                  >
                    <DropdownMenu.Item
                      onSelect={() => queueAction('rename', group)}
                      data-testid="memo-group-rename"
                    >
                      <Pencil />{t('workbench.memo.renameGroup')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      variant="destructive"
                      onSelect={() => queueAction('delete', group)}
                      data-testid="memo-group-delete"
                    >
                      <Trash2 />{t('workbench.memo.deleteGroup')}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              {/if}
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
  <Button
    size="icon-xs"
    variant="ghost"
    class="shrink-0 text-muted-foreground"
    aria-label={t('workbench.memo.addGroup')}
    title={t('workbench.memo.addGroup')}
    onclick={openCreateGroup}
    data-testid="memo-add-group"
  >
    <Plus />
  </Button>
</div>

<Dialog.Root
  open={createOpen}
  onOpenChange={(open) => {
    if (!open) createOpen = false;
  }}
>
  <Dialog.Content class="sm:max-w-sm" data-testid="memo-group-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('workbench.memo.addGroup')}</Dialog.Title>
      <Dialog.Description>{t('workbench.memo.groupDialogHint')}</Dialog.Description>
    </Dialog.Header>
    <Input
      bind:ref={nameInput}
      bind:value={groupName}
      maxlength={MEMO_GROUP_TITLE_MAX_CHARS}
      placeholder={t('workbench.memo.groupPlaceholder')}
      onkeydown={onCreateGroupKeydown}
      data-testid="memo-group-name"
    />
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (createOpen = false)}>
        {t('workbench.memo.groupCancel')}
      </Button>
      <Button
        disabled={groupName.trim().length === 0 || creating}
        onclick={() => void confirmCreateGroup()}
        data-testid="memo-group-create"
      >
        {t('workbench.memo.groupCreate')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

{#if deleting}
  {@const target = deleting}
  <Dialog.Root
    open
    onOpenChange={(open) => {
      if (!open) deleting = null;
    }}
  >
    <Dialog.Content class="sm:max-w-sm" data-testid="memo-group-delete-dialog">
      <Dialog.Header>
        <Dialog.Title>{t('workbench.memo.groupDeleteTitle', { title: target.title })}</Dialog.Title>
        <Dialog.Description>
          {t('workbench.memo.groupDeleteBody', { count: countOf(target.id) })}
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (deleting = null)}>
          {t('workbench.memo.groupDeleteCancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={confirmDeleteGroup}
          data-testid="memo-group-delete-confirm"
        >
          {t('workbench.memo.groupDeleteConfirm')}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
