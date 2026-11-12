<script lang="ts">
  import { tick, untrack, onDestroy } from 'svelte';
  import { StickyNotePlus } from '@lucide/svelte';
  import { newId, type ConversationNote } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import NoteCard from './NoteCard.svelte';
  import type { NoteItem } from './note-model';

  /**
   * 右栏 Bot 详情「便签」tab：用户手动记录协作中值得留存的信息（启动命令、
   * 测试账号等）。纯用户数据，不进入 Bot 上下文。条目随输入防抖落库，失焦
   * 立即保存；清空后失焦即删除。
   *
   * 由 RightPanel 按 conversationId `{#key}` 重建：本实例的列表只属于一个
   * 对话。切对话时旧实例被销毁、在途写入照常落原对话，不需要在实例内处理
   * 换对话的列表替换。
   */
  let { conversationId }: { conversationId: string } = $props();

  let notes = $state<NoteItem[]>([]);
  let loading = $state(true);
  let scrollEl = $state<HTMLDivElement | null>(null);
  let focusId = $state<string | null>(null);

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 防抖定时器不是 UI 状态。
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 正在落库的 id（同一 id 只允许一个请求在途）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 在途台账，不进 UI 状态。
  const saving = new Set<string>();
  /** 新建请求在途时被删除的 id：请求完成后清理服务端孤儿行。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 临时墓碑集合，不进 UI 状态。
  const tombstones = new Set<string>();
  let loadSeq = 0;

  $effect(() => {
    const id = conversationId;
    const seq = ++loadSeq;
    loading = true;
    void (async () => {
      try {
        const result = (await core.call('notes.list', { conversationId: id })) as {
          notes: ConversationNote[];
        };
        if (seq !== loadSeq) return;
        notes = result.notes.map(toItem);
      } catch (error) {
        if (seq === loadSeq) toast.error(errorText(codeOf(error), t('rightPanel.notesLoadFailed')));
      } finally {
        if (seq === loadSeq) loading = false;
      }
    })();
  });

  onDestroy(() => {
    untrack(flushAll);
    // 清空正文后没等到失焦就被卸载（关面板 / 换对话 / 关窗）：按失焦规则删除，
    // 免得下次打开又看到旧正文。
    for (const entry of [...notes]) {
      if (entry.text.trim().length === 0) removeNote(entry.id);
    }
  });

  function toItem(note: ConversationNote): NoteItem {
    return {
      id: note.id,
      conversationId: note.conversationId,
      text: note.text,
      persisted: true,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  function codeOf(error: unknown): string | undefined {
    return (error as { code?: string } | undefined)?.code;
  }

  async function addNote(): Promise<void> {
    // 列表还没回来时不新建，避免随后被服务端结果覆盖。
    if (loading) return;
    const now = Date.now();
    const id = newId('note');
    notes = [
      ...notes,
      { id, conversationId, text: '', persisted: false, createdAt: now, updatedAt: now },
    ];
    focusId = id;
    await tick();
    if (scrollEl !== null) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  /** 空白处双击新建；卡片与按钮上的双击不触发。 */
  function handleContainerDblClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-testid="note-card"], button')) return;
    void addNote();
  }

  function patchText(id: string, text: string): void {
    notes = notes.map((entry) =>
      entry.id === id ? { ...entry, text, updatedAt: Date.now() } : entry,
    );
    scheduleSave(id);
  }

  function scheduleSave(id: string, delay = 500): void {
    const existing = timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void save(id);
      }, delay),
    );
  }

  function flush(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    void save(id);
  }

  function flushAll(): void {
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      void save(id);
    }
    timers.clear();
  }

  /** 落库：新建走 notes.create（id 由渲染层预先给出），已有行走 notes.update。 */
  async function save(id: string): Promise<void> {
    const item = notes.find((entry) => entry.id === id);
    if (item === undefined) return;
    const text = item.text;
    if (text.trim().length === 0) return;
    // 同一 id 只允许一个请求在途；期间的新输入由完成后补发。
    if (saving.has(id)) return;
    saving.add(id);
    let ok = false;
    try {
      if (item.persisted) {
        await core.call('notes.update', { id, text });
      } else {
        await core.call('notes.create', {
          id,
          conversationId: item.conversationId,
          text,
        });
      }
      ok = true;
      // 新建请求在途时卡片被删掉了：把刚建出来的行也清掉。
      if (tombstones.has(id)) {
        tombstones.delete(id);
        await core.call('notes.delete', { id }).catch((error: unknown) => {
          toast.error(errorText(codeOf(error), t('rightPanel.notesDeleteFailed')));
        });
        return;
      }
      notes = notes.map((entry) =>
        entry.id === id ? { ...entry, persisted: true, updatedAt: Date.now() } : entry,
      );
    } catch (error) {
      tombstones.delete(id);
      // 请求在途时便签被删掉（update 先到 / 后到都可能报 NOT_FOUND）：不为已经
      // 从列表消失的条目弹错。
      if (notes.some((entry) => entry.id === id)) {
        toast.error(errorText(codeOf(error), t('rightPanel.notesSaveFailed')));
      }
    } finally {
      saving.delete(id);
      const current = notes.find((entry) => entry.id === id);
      // 请求期间又改过：用最新正文再存一次（失败时不自动重试，等下次输入 / 失焦）。
      if (ok && current !== undefined && current.text !== text && current.text.trim().length > 0) {
        scheduleSave(id, 0);
      }
    }
  }

  function removeNote(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    const item = notes.find((entry) => entry.id === id);
    notes = notes.filter((entry) => entry.id !== id);
    if (item === undefined) return;
    if (item.persisted) {
      void core.call('notes.delete', { id }).catch((error: unknown) => {
        toast.error(errorText(codeOf(error), t('rightPanel.notesDeleteFailed')));
      });
    } else if (saving.has(id)) {
      // 新建还没返回：标记墓碑，create 完成后由 save() 负责删除。
      tombstones.add(id);
    }
  }

  function handleBlur(id: string): void {
    const item = notes.find((entry) => entry.id === id);
    if (item === undefined) return;
    if (item.text.trim().length === 0) {
      removeNote(id);
      return;
    }
    flush(id);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="bot-notes-tab">
  <div class="flex justify-end">
    <button
      type="button"
      class="flex size-8 cursor-pointer items-center justify-center rounded-md bg-transparent text-foreground opacity-50 transition-opacity hover:bg-transparent hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:opacity-100 disabled:cursor-default disabled:opacity-30"
      title={t('rightPanel.notesAdd')}
      aria-label={t('rightPanel.notesAdd')}
      disabled={loading}
      onclick={() => void addNote()}
      data-testid="bot-notes-add"
    >
      <StickyNotePlus class="size-4" aria-hidden="true" />
    </button>
  </div>

  <div
    bind:this={scrollEl}
    class="min-h-0 flex-1 overflow-y-auto"
    role="group"
    aria-label={t('rightPanel.tabNotes')}
    ondblclick={handleContainerDblClick}
    data-testid="bot-notes-scroll"
  >
    {#if notes.length > 0}
      <ul class="space-y-2 pr-1" data-testid="bot-notes-list">
        {#each notes as note (note.id)}
          <li>
            <NoteCard
              {note}
              autofocus={focusId === note.id}
              oninput={(text) => patchText(note.id, text)}
              onblur={() => handleBlur(note.id)}
              ondelete={() => removeNote(note.id)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
