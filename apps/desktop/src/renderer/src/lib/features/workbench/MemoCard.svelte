<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Memo } from '@kepcup/shared';
  import { MEMO_BODY_MAX_CHARS } from '@kepcup/shared';
  import {
    Check,
    FolderInput,
    GripVertical,
    ListPlus,
    MoreHorizontal,
    Pin,
    PinOff,
    Sparkles,
    Trash2,
  } from '@lucide/svelte';
  import { dragHandle } from 'svelte-dnd-action';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { ageText } from './age-text';
  import { memoCardClass } from './memo-card-class';
  import { memoConverted, memoToTodoDraft, splitMoveTargets } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘卡（D90 §5.4）：正文可点即改（contenteditable），防抖保存；相对时间与管家来源徽标；
   * 操作——置顶、转为事项，以及「…」菜单：「移动到」小标题下直接列出前几个分组（含「未分组」），
   * 更多的收进末尾「更多」二级菜单；分隔线下是删除（进最近删除，toast 里可撤销）。Esc 放弃未保存改动。
   *
   * 拖拽：卡片由 footer 的覆盖层把手（`use:dragHandle`）拖起，正文与 footer 上的文字 / 按钮
   * 都浮在把手之上，所以只有 footer 的空白处能拖，正文始终可编辑。`draggable` 为假（搜索结果，
   * 不在任何拖拽区里）时不放把手。已转事项的卡片整卡半透明。
   */
  let { memo, draggable = true }: { memo: Memo; draggable?: boolean } = $props();

  const SAVE_DEBOUNCE_MS = 450;

  let bodyEl = $state<HTMLElement | null>(null);
  let focused = $state(false);
  let saving = $state(false);
  /** 本地草稿；未聚焦且未脏时跟 `memo.body` 对齐。 */
  let draft = $state('');
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = $state(false);
  /** 当前编辑区绑定的备忘 id；换卡时重灌正文。 */
  let seededId = $state<string | null>(null);

  // 关联事项被取消后就不再算「已转事项」（恢复普通备忘的标签与样式），重新打开再回来。
  const converted = $derived(memoConverted(workbench.todos, memo.id));
  const age = $derived(ageText(memo.updatedAt));
  /** 「移动到」的目标：全部分组（「未分组」在最前，同 tab 序）；当前所在的那个打勾、不可选。 */
  const moveTargets = $derived<Array<{ id: string | null; title: string }>>([
    { id: null, title: t('workbench.memo.ungrouped') },
    ...workbench.memoGroups.map((group) => ({ id: group.id, title: group.title })),
  ]);
  /** 前几个直接列在「移动到」下，其余进「更多」二级菜单。 */
  const moveSplit = $derived(splitMoveTargets(moveTargets));

  function clearTimer(): void {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  // 卸载（切 tab / 换视图）时聚焦元素被移除不一定触发 blur：防抖窗口内的改动在此补存，不丢。
  onDestroy(() => {
    const pending = saveTimer !== null;
    clearTimer();
    if (pending && dirty) void persist();
  });

  function writeDom(text: string): void {
    if (bodyEl === null || bodyEl.textContent === text) return;
    // contenteditable：直接写 textContent，避免 Svelte 重绘打断光标。
    // eslint-disable-next-line svelte/no-dom-manipulating
    bodyEl.textContent = text;
  }

  // 挂载 / 换卡：把正文写入 contenteditable（不把 `{memo.body}` 放进子节点，以免重绘打光标）。
  $effect(() => {
    const el = bodyEl;
    const id = memo.id;
    if (el === null) return;
    if (seededId === id) return;
    clearTimer();
    dirty = false;
    focused = false;
    draft = memo.body;
    seededId = id;
    writeDom(memo.body);
  });

  // 外部正文变了：没在改时同步。
  $effect(() => {
    const body = memo.body;
    if (seededId !== memo.id || dirty || focused) return;
    draft = body;
    writeDom(body);
  });

  function failed(error: unknown): void {
    toast.error(
      errorText((error as { code?: string } | undefined)?.code, t('workbench.memo.saveFailed')),
    );
  }

  function readBody(): string {
    return (bodyEl?.innerText ?? draft).replace(/\u00a0/g, ' ');
  }

  function scheduleSave(): void {
    dirty = true;
    draft = readBody();
    clearTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, SAVE_DEBOUNCE_MS);
  }

  async function persist(): Promise<void> {
    const body = readBody().trim();
    if (saving) return;
    if (body.length === 0) return;
    if (body === memo.body) {
      dirty = false;
      return;
    }
    if (body.length > MEMO_BODY_MAX_CHARS) {
      toast.error(t('workbench.memo.saveFailed'));
      return;
    }
    saving = true;
    try {
      const result = (await core.call('memos.update', { id: memo.id, body })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      dirty = false;
      draft = result.memo.body;
    } catch (error) {
      failed(error);
    } finally {
      saving = false;
    }
  }

  function onInput(): void {
    const raw = bodyEl?.innerText ?? '';
    if (raw.length > MEMO_BODY_MAX_CHARS && bodyEl !== null) {
      const clipped = raw.slice(0, MEMO_BODY_MAX_CHARS);
      writeDom(clipped);
      const selection = window.getSelection();
      if (selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(bodyEl);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    scheduleSave();
  }

  function onFocus(): void {
    focused = true;
  }

  function onBlur(): void {
    focused = false;
    clearTimer();
    const body = readBody().trim();
    if (body.length === 0) {
      dirty = false;
      draft = memo.body;
      writeDom(memo.body);
      return;
    }
    void persist();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    clearTimer();
    dirty = false;
    draft = memo.body;
    writeDom(memo.body);
    bodyEl?.blur();
  }

  async function togglePin(): Promise<void> {
    try {
      const result = (await core.call('memos.update', { id: memo.id, pinned: !memo.pinned })) as {
        memo: Memo;
      };
      workbench.upsertMemo(result.memo);
    } catch (error) {
      failed(error);
    }
  }

  function toTodo(): void {
    workbench.newTodo({ ...memoToTodoDraft(memo.body), memoId: memo.id });
  }

  async function remove(): Promise<void> {
    clearTimer();
    try {
      const result = (await core.call('memos.delete', { id: memo.id })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      toast(t('workbench.memo.deleted'), {
        action: { label: t('workbench.memo.undo'), onClick: () => void restore(memo.id) },
      });
    } catch (error) {
      failed(error);
    }
  }

  async function restore(id: string): Promise<void> {
    try {
      const result = (await core.call('memos.restore', { id })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
    } catch (error) {
      failed(error);
    }
  }
</script>

<div
  class={memoCardClass(converted)}
  data-testid="memo-card"
  data-memo-id={memo.id}
  data-pinned={memo.pinned ? 'true' : 'false'}
>
  <div
    bind:this={bodyEl}
    contenteditable="plaintext-only"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={t('workbench.memo.title')}
    class="min-h-[1.25rem] break-words whitespace-pre-wrap outline-none focus:outline-none {focused
      ? 'max-h-48 overflow-y-auto'
      : 'line-clamp-6'}"
    data-testid="memo-body"
    oninput={onInput}
    onfocus={onFocus}
    onblur={onBlur}
    onkeydown={onKeydown}
  ></div>
  <div
    class="relative mt-auto flex items-center gap-1.5 pt-2 text-xs text-muted-foreground"
    data-testid="memo-footer"
  >
    <!-- 拖拽把手：footer 上的覆盖层，只有它能把卡片拖起来（列表用 dragHandleZone）。
         同层文字 / 按钮写 relative 浮在把手之上——点击、选词都不会触发拖拽，
         两者之间的空白（flex-1 占位）落回把手，即 footer 剩余位置均可拖。 -->
    {#if draggable}
      <div
        class="absolute inset-0 cursor-grab"
        aria-label={t('workbench.memo.cardHandle')}
        data-testid="memo-drag-handle"
        use:dragHandle
      ></div>
      <!-- grip 只是提示：非 hover 时 display:none，不占宽度（不是 opacity 占位）。 -->
      <GripVertical
        class="relative hidden size-3 shrink-0 group-hover/memo:block"
        aria-hidden="true"
        data-testid="memo-drag-grip"
      />
    {/if}
    {#if memo.pinned}
      <Pin class="relative size-3 shrink-0 text-amber-600" aria-hidden="true" />
    {/if}
    <span class="relative" data-testid="memo-age">{age}</span>
    {#if memo.source === 'butler'}
      <span
        class="relative inline-flex items-center gap-0.5 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-violet-700 dark:text-violet-400"
        data-testid="memo-butler"
      >
        <Sparkles class="size-3" aria-hidden="true" />{t('workbench.memo.byButler')}
      </span>
    {/if}
    {#if converted}
      <span class="relative rounded-md bg-muted px-1.5 py-0.5" data-testid="memo-converted">
        {t('workbench.memo.converted')}
      </span>
    {/if}
    <!-- 空白占位：不定位，让 mousedown 落到下面的把手层。 -->
    <span class="flex-1" data-testid="memo-footer-blank"></span>
    <div
      class="relative flex items-center gap-0.5 opacity-60 transition-opacity group-focus-within/memo:opacity-100 group-hover/memo:opacity-100"
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={memo.pinned ? t('workbench.memo.unpin') : t('workbench.memo.pin')}
        title={memo.pinned ? t('workbench.memo.unpin') : t('workbench.memo.pin')}
        onclick={() => void togglePin()}
        data-testid="memo-pin"
      >
        {#if memo.pinned}<PinOff />{:else}<Pin />{/if}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('workbench.memo.toTodo')}
        title={t('workbench.memo.toTodo')}
        onclick={toTodo}
        data-testid="memo-to-todo"
      >
        <ListPlus />
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={t('workbench.memo.more')}
          title={t('workbench.memo.more')}
          data-testid="memo-more"
        >
          <MoreHorizontal class="size-3.5" aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-44" data-testid="memo-more-menu">
          <!-- 「移动到」：前几个分组直接列出，其余收进末尾「更多」；没有别的分组可去时整段不显示。 -->
          {#if moveTargets.length > 1}
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading
                class="flex items-center gap-1.5"
                data-testid="memo-move-to"
              >
                <FolderInput class="size-3.5" aria-hidden="true" />{t('workbench.memo.moveTo')}
              </DropdownMenu.GroupHeading>
              {#each moveSplit.inline as target (target.id ?? 'ungrouped')}
                {@render moveTargetItem(target)}
              {/each}
              {#if moveSplit.more.length > 0}
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger inset data-testid="memo-move-more">
                    {t('workbench.memo.moveToMore')}
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent
                    class="max-h-72 w-44 overflow-y-auto"
                    data-testid="memo-move-more-targets"
                  >
                    {#each moveSplit.more as target (target.id ?? 'ungrouped')}
                      {@render moveTargetItem(target)}
                    {/each}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              {/if}
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
          {/if}
          <DropdownMenu.Item
            variant="destructive"
            onSelect={() => void remove()}
            data-testid="memo-delete"
          >
            <Trash2 />{t('workbench.memo.delete')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </div>
</div>

{#snippet moveTargetItem(target: { id: string | null; title: string })}
  {@const current = target.id === memo.groupId}
  <DropdownMenu.Item
    inset
    disabled={current}
    onSelect={() => void workbench.moveMemoToGroup(memo.id, target.id)}
    data-testid="memo-move-target"
    data-target-id={target.id ?? 'ungrouped'}
  >
    <span class="min-w-0 flex-1 truncate">{target.title}</span>
    {#if current}<Check class="size-3.5" aria-hidden="true" />{/if}
  </DropdownMenu.Item>
{/snippet}
