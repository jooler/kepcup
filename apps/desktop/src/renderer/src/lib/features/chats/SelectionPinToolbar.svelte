<script lang="ts">
  import { Pin } from '@lucide/svelte';
  import { Portal } from 'bits-ui';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { placeSelectionToolbar } from './selection-pin';
  import { stickies } from './stickies.svelte';

  /**
   * 消息选中文本的浮动工具栏：列表内选中非空文本时浮出，一个 pin 按钮
   * 把选中文本钉成当前对话的便签（改全局在便签卡片上切换，见
   * StickiesLayer）。浮层 portal 到 body 末尾 + app-no-drag（app.css：
   * no-drag 矩形沿 DOM 顺序覆盖 header 的 drag 矩形，原地挂会被顶部拖拽
   * 区吞掉点击）。fixed 定位由选区矩形推导，滚动/选区变化时跟随。
   */
  let { container }: { container: HTMLElement | null } = $props();

  const TOOLBAR_WIDTH = 44;
  const TOOLBAR_HEIGHT = 32;

  let toolbar = $state<{ x: number; y: number; text: string } | null>(null);
  let frame = 0;

  function selectionHit(): { text: string; rect: DOMRect } | null {
    const el = container;
    const sel = window.getSelection();
    if (el === null || sel === null || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    // 列表外的选区（便签自身文本、输入框等）不触发。
    if (!el.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString();
    if (text.trim().length === 0) return null;
    return { text, rect: range.getBoundingClientRect() };
  }

  function update(): void {
    const hit = selectionHit();
    if (hit === null) {
      toolbar = null;
      return;
    }
    toolbar = {
      text: hit.text,
      ...placeSelectionToolbar(
        hit.rect,
        window.innerWidth,
        window.innerHeight,
        TOOLBAR_WIDTH,
        TOOLBAR_HEIGHT,
      ),
    };
  }

  // selectionchange 同步更新：rAF 在失焦/遮挡的窗口会被节流，工具栏会
  // 迟到数秒；该事件本身低频（选区变化才发），同步代价可忽略。
  // 滚动高频，保留 rAF 合帧。
  function scheduleUpdate(): void {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }

  function hide(): void {
    cancelAnimationFrame(frame);
    toolbar = null;
  }

  $effect(() => {
    document.addEventListener('selectionchange', update);
    // 捕获阶段收内层滚动容器（消息列表、便签正文）的 scroll，让工具栏跟随选区。
    window.addEventListener('scroll', scheduleUpdate, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', hide);
      cancelAnimationFrame(frame);
    };
  });

  // 切换对话即收起：旧选区已不属于新对话的列表。
  $effect(() => {
    void chat.current?.conversation.id;
    toolbar = null;
  });

  function pin(): void {
    const conversationId = chat.current?.conversation.id;
    if (conversationId === undefined || toolbar === null) return;
    stickies.pin(toolbar.text, conversationId, 'conversation');
    window.getSelection()?.removeAllRanges();
    toolbar = null;
  }
</script>

{#if toolbar}
  <Portal>
    <div
      class="app-no-drag fixed z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-xl"
      style="left: {toolbar.x}px; top: {toolbar.y}px;"
      data-testid="selection-toolbar"
    >
      <button
        type="button"
        class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t('chats.pinToConversation')}
        aria-label={t('chats.pinToConversation')}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => pin()}
        data-testid="pin-conversation"
      >
        <Pin class="size-3.5" aria-hidden="true" />
      </button>
    </div>
  </Portal>
{/if}
