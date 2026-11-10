<script lang="ts">
  import { agentIcon } from './agent-icons';

  /**
   * 智能体图标（目录 `AgentIcon` 字形）：品牌色图标走 `<img>`；单色品牌与
   * 缺图标时的首字母回落不会在暗色主题下变成黑块——单色标记用 CSS mask 按
   * 当前文字颜色绘制（`bg-current`），首字母用 `bg-muted`。
   */
  let {
    icon,
    name,
    size = 'sm',
  }: {
    icon: string;
    name: string;
    /** xs = 3.5（徽标）、sm = 4（设置页左栏）、lg = 9（目录卡片）。 */
    size?: 'xs' | 'sm' | 'lg';
  } = $props();

  const SIZES = {
    xs: 'size-3.5 rounded text-[9px]',
    sm: 'size-4 rounded text-[10px]',
    lg: 'size-9 rounded-lg text-sm',
  } as const;

  const asset = $derived(agentIcon(icon));
  const box = $derived(SIZES[size]);
</script>

{#if asset === null}
  <span
    class="flex shrink-0 items-center justify-center bg-muted font-medium {box}"
    aria-hidden="true">{name.slice(0, 1)}</span
  >
{:else if asset.mono}
  <span
    class="shrink-0 bg-current {box}"
    style={`-webkit-mask: url("${asset.url}") center / contain no-repeat; mask: url("${asset.url}") center / contain no-repeat;`}
    aria-hidden="true"
  ></span>
{:else}
  <img src={asset.url} alt="" class="shrink-0 object-contain {box}" />
{/if}
