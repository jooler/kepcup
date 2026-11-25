<script lang="ts">
  import { t } from '$lib/i18n';

  /**
   * 团队成员头像（T5，62.04 §1 名册）：无头像时用显示名首字母 + 姿态色。
   * 与 BotAvatar 分开——成员没有预置形状 / 遮罩 / 强调色体系，保持朴素圆形。
   * `state` 给在线绿点 / 离线灰点（成员卡与 dm 会话头部共用）。
   */
  let {
    name,
    avatar = null,
    state = null,
    class: className = 'size-10',
    testId,
  }: {
    name: string;
    /** 头像值（团队服务器的成员头像 URL / data URL）；null = 首字母回落。 */
    avatar?: string | null;
    /** 在线状态；null = 不渲染状态点（头像堆叠等小尺寸场景）。 */
    state?: 'online' | 'away' | 'offline' | null;
    class?: string;
    testId?: string;
  } = $props();

  const initial = $derived(name.trim().slice(0, 1).toUpperCase() || '?');
  const away = $derived(state === 'away');
</script>

<!-- 尺寸 class 打在外层：内层元素统一 size-full。之前内层同时挂 size-full 与
     调用方的 size-N，Tailwind 级联里 size-full 压过 size-N，外层又没有尺寸，
     首字母圆塌缩成内容大小（2026-11 侧栏 dm 条目实测 14×20px）。 -->
<span class="relative inline-flex shrink-0 {className}" data-testid={testId}>
  {#if avatar}
    <img
      src={avatar}
      alt=""
      class="size-full rounded-full object-cover"
      draggable="false"
    />
  {:else}
    <span
      class="flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground"
      aria-hidden="true"
    >
      {initial}
    </span>
  {/if}
  {#if state !== null}
    <span
      class="absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-background
        {state === 'online'
        ? 'bg-emerald-500'
        : away
          ? 'bg-amber-400'
          : 'bg-zinc-400'}"
      title={state === 'online'
        ? t('team.memberOnline')
        : away
          ? t('team.memberAway')
          : t('team.memberOffline')}
      data-testid="member-state-dot"
      data-state={state}
    ></span>
  {/if}
</span>
