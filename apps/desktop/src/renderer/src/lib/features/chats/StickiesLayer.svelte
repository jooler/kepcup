<script lang="ts">
  import { GripVertical, Pin, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import {
    STICKIE_MARGIN,
    STICKIE_WIDTH,
    type Stickie,
    clampStickiePosition,
    defaultStickiePosition,
  } from './stickies';
  import { stickies } from './stickies.svelte';

  /**
   * 对话容器内的便签层（辅助阅读，docs 方案：类 mac stickies）：绝对定位
   * 浮在消息列表上层，z-20 让位顶部药丸与输入坞（z-30），输入始终可用。
   * 便签可拖拽（顶部手柄，pointer capture）、可关闭；点击任意便签把它
   * 带到本层最上（store 单调 z 号，类窗口管理）。conversation 作用域
   * 只在本对话渲染，global 作用域在每个对话渲染且共享位置与层号。卡片
   * 自带 app-no-drag 且渲染顺序在 header 之后（app.css：矩形沿 DOM 顺序
   * 覆盖，盖住顶部药丸区域时仍可拖拽/关闭）。
   */
  let { conversationId }: { conversationId: string } = $props();

  let layer: HTMLDivElement | undefined = $state();
  let layerWidth = $state(0);
  let layerHeight = $state(0);
  /** 各卡片实测高度：Y 向夹取要用（便签高度随内容变化）。 */
  let cardHeights = $state<Record<string, number>>({});

  const items = $derived(stickies.visibleIn(conversationId));

  // 容器变窄/变矮（右栏开合、窗口缩放）时把便签拉回可视范围。
  $effect(() => {
    if (layerWidth === 0 || layerHeight === 0) return;
    for (const stickie of items) {
      const position = stickie.position;
      if (position === null) continue;
      const clamped = clampStickiePosition(
        position,
        layerWidth,
        layerHeight,
        cardHeights[stickie.id] ?? 96,
      );
      if (clamped.x !== position.x || clamped.y !== position.y) {
        stickies.moveTo(stickie.id, clamped);
        stickies.commitPosition(stickie.id);
      }
    }
  });

  /**
   * 默认落点：按创建序级联（右上角起步）。槽位用全局创建序而非当前对话
   * 的可见序——可见序随对话切换变化，会让未拖过的便签换对话就跳动。
   */
  function creationSlot(stickie: Stickie): number {
    return stickies.items.indexOf(stickie);
  }

  function placedAt(stickie: Stickie): { x: number; y: number } {
    if (stickie.position !== null) return stickie.position;
    // 首帧容器尺寸未回填，先给安全落点，下一帧换算默认位。
    if (layerWidth === 0 || layerHeight === 0) return { x: STICKIE_MARGIN, y: 64 };
    return defaultStickiePosition(layerWidth, layerHeight, creationSlot(stickie));
  }

  // 未放置的便签在首次渲染时把默认落点写回 store：位置从此固定，跨对话
  // 切换、删除其他便签都不会再引起重算跳动（写一次后条件不再成立，收敛）。
  $effect(() => {
    if (layerWidth === 0 || layerHeight === 0) return;
    for (const stickie of items) {
      if (stickie.position !== null) continue;
      stickies.moveTo(stickie.id, placedAt(stickie));
      stickies.commitPosition(stickie.id);
    }
  });

  /**
   * 便签来源会话的显示名（全局便签标注「来自 X」）：群聊取群名，单聊取
   * Bot 名（bot 缺失时经 botName 兜底，设计/01：已删 Bot 显示其 id）。
   */
  function sourceName(conversationId: string): string {
    const conversation = chat.conversations.find((c) => c.id === conversationId);
    if (conversation === undefined) return '';
    if (conversation.type === 'group') return conversation.title ?? '';
    return conversation.bot?.name || chat.botName(conversation.directBotId ?? '');
  }

  /**
   * 手柄条的作用域文案：本地固定「仅当前对话可见」；全局在其他对话里
   * 优先标来源（「来自 X」），在来源对话自身里仍显示「所有对话可见」
   * （对着来源 Bot 说「来自它自己」是冗余）。
   */
  function scopeLabel(stickie: Stickie): string {
    if (stickie.scope === 'conversation') return t('chats.stickieScopeLocal');
    if (stickie.conversationId === conversationId) return t('chats.stickieScopeGlobal');
    const name = sourceName(stickie.conversationId);
    return name.length > 0 ? t('chats.stickieFrom', { name }) : t('chats.stickieScopeGlobal');
  }

  let drag: {
    id: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    origin: { x: number; y: number };
    cardHeight: number;
  } | null = null;

  function onDragStart(event: PointerEvent, stickie: Stickie): void {
    if (event.button !== 0) return;
    drag = {
      id: stickie.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origin: placedAt(stickie),
      cardHeight: cardHeights[stickie.id] ?? 96,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onDragMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    stickies.moveTo(
      drag.id,
      clampStickiePosition(
        {
          x: drag.origin.x + (event.clientX - drag.startClientX),
          y: drag.origin.y + (event.clientY - drag.startClientY),
        },
        layerWidth,
        layerHeight,
        drag.cardHeight,
      ),
    );
  }

  function onDragEnd(event: PointerEvent): void {
    if (drag !== null && event.pointerId === drag.pointerId) {
      stickies.commitPosition(drag.id);
      drag = null;
    }
  }
</script>

<div
  bind:this={layer}
  bind:clientWidth={layerWidth}
  bind:clientHeight={layerHeight}
  class="pointer-events-none absolute inset-0 z-20"
  data-testid="stickies-layer"
>
  {#each items as stickie (stickie.id)}
    {@const pos = placedAt(stickie)}
    {@const label = scopeLabel(stickie)}
    <div
      role="group"
      aria-label={t('chats.stickieCard')}
      class="app-no-drag pointer-events-auto absolute flex flex-col rounded-lg border border-yellow-500/50 bg-yellow-100 text-yellow-950 shadow-lg
        dark:border-zinc-600/60 dark:bg-zinc-800 dark:text-zinc-100"
      style="left: {pos.x}px; top: {pos.y}px; width: {STICKIE_WIDTH}px; z-index: {stickie.z};"
      onpointerdown={() => stickies.bringToFront(stickie.id)}
      data-testid="stickie-card"
      data-stickie-scope={stickie.scope}
    >
      <!-- 手柄条：拖拽区 + 作用域标识 + 关闭 -->
      <div
        role="group"
        aria-label={t('chats.stickieHandle')}
        title={t('chats.stickieHandle')}
        class="flex h-6 shrink-0 cursor-grab touch-none items-center gap-1 rounded-t-lg border-b border-black/10 bg-black/5 pr-0.5 pl-1 select-none active:cursor-grabbing dark:border-white/10 dark:bg-white/5"
        onpointerdown={(event) => onDragStart(event, stickie)}
        onpointermove={onDragMove}
        onpointerup={onDragEnd}
        onpointercancel={onDragEnd}
        data-testid="stickie-drag-handle"
      >
        <GripVertical class="size-3 shrink-0 opacity-50" aria-hidden="true" />
        <!-- 溢出省略；完整信息（来源 + 可见范围）在 title 里 -->
        <span class="min-w-0 flex-1 truncate text-[10px] opacity-60" title={label}>
          {label}
        </span>
        <!-- 作用域切换：默认 pin（点击改全局），激活（全局）时加背景态；点击不得触发拖拽。 -->
        <button
          type="button"
          aria-pressed={stickie.scope === 'global'}
          class="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/10
            {stickie.scope === 'global' ? 'bg-black/10 dark:bg-white/15' : ''}"
          title={stickie.scope === 'global'
            ? t('chats.pinToConversation')
            : t('chats.pinToAllConversations')}
          aria-label={stickie.scope === 'global'
            ? t('chats.pinToConversation')
            : t('chats.pinToAllConversations')}
          onpointerdown={(event) => event.stopPropagation()}
          onclick={() =>
            stickies.setScope(stickie.id, stickie.scope === 'global' ? 'conversation' : 'global')}
          data-testid="stickie-toggle-scope"
        >
          <Pin
            class="size-3 {stickie.scope === 'global' ? 'opacity-100' : 'opacity-60'}"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          aria-label={t('common.close')}
          title={t('common.close')}
          onpointerdown={(event) => event.stopPropagation()}
          onclick={() => stickies.remove(stickie.id)}
          data-testid="stickie-close"
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </div>
      <!-- 正文保持可选中/可复制；超高内部滚动 -->
      <div
        class="max-h-72 overflow-y-auto px-2.5 py-2 text-xs leading-5 break-words whitespace-pre-wrap"
        bind:clientHeight={cardHeights[stickie.id]}
      >
        {stickie.text}
      </div>
    </div>
  {/each}
</div>
