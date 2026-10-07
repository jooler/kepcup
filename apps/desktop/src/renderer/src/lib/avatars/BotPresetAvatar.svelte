<script lang="ts">
  /**
   * 预置头像渲染：单色形状 + 白色眼睛胶囊。眼睛动画（look/blink）在
   * app.css 全局定义——{@html} 注入的节点拿不到 Svelte 的 scoped class。
   */
  import {
    AVATAR_COLORS,
    AVATAR_SHAPES,
    avatarColorForeground,
    parsePresetAvatar,
  } from './presets';

  let {
    value,
    class: klass = '',
    animated = true,
  }: { value: string; class?: string; animated?: boolean } = $props();

  const parsed = $derived(
    parsePresetAvatar(value) ?? {
      shape: AVATAR_SHAPES[0]!,
      color: AVATAR_COLORS[0]!,
    },
  );
</script>

<svg
  viewBox="0 0 100 100"
  class="bot-preset-avatar {klass}"
  class:bot-animated={animated}
  role="img"
  aria-hidden="true"
>
  <!-- 填充走 style 而非 fill 属性：第一种「黑白」是 var() 主题变量，
       属性语法不解析 var()，只有 CSS 才行。 -->
  <g style:fill={parsed.color.hex}>
    <!-- 形状片段来自模块内静态常量（presets.ts），无任何用户输入参与。 -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html parsed.shape.markup}
  </g>
  <g transform="translate(0 {parsed.shape.eyeDy ?? 0})">
    <g class="bot-eyes-look">
      <g class="bot-eyes-blink" style:fill={avatarColorForeground(parsed.color)}>
        <rect x="33.75" y="37.5" width="10.5" height="23" rx="5.25" />
        <rect x="55.75" y="37.5" width="10.5" height="23" rx="5.25" />
      </g>
    </g>
  </g>
</svg>
