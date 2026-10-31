<script lang="ts">
  /**
   * 统一的 Bot 头像：preset → SVG 预置头像；upload → RPC 取回的图片；
   * 其它（历史数据/已删除）→ 首字母占位。尺寸由调用方以 class 传入
   * （组件内部元素均为 size-full）。
   */
  import * as Avatar from '$lib/components/ui/avatar';
  import { normalizeBotAvatarMask, normalizeBotAvatarPadding, type BotAvatarMask } from '@kepcup/shared';
  import { avatarImages } from './avatar-images.svelte';
  import BotPresetAvatar from './BotPresetAvatar.svelte';
  import { avatarMaskClass, parsePresetAvatar, parseUploadedAvatar } from './presets';

  let {
    botId,
    name = '',
    avatar = null,
    mask = null,
    padding = null,
    class: klass = 'size-8',
    testId,
    animated = true,
    fallbackClass = '',
    glyphShadowOffset = null,
  }: {
    botId: string;
    name?: string;
    avatar?: string | null;
    /**
     * 上传头像的遮罩形状：'circle'（缺省）/ 'rounded' 圆角正方形。只作用于上传
     * 图片——预置头像自带轮廓、首字母占位保持圆形。
     */
    mask?: BotAvatarMask | null;
    /**
     * 上传头像的内边距（像素整数 0-16，上限见 shared MAX_BOT_AVATAR_PADDING）：
     * 容器尺寸不变，图片内缩 padding 后填充剩余空间，用来把自带留白不一的图片
     * 调到视觉大小一致。只作用于上传图片；null / 越界按 0。
     */
    padding?: number | null;
    class?: string;
    testId?: string;
    animated?: boolean;
    fallbackClass?: string;
    /** 群马赛克字影：朝向中心 1px；仅作用在字形/字母上，不是瓦片 box-shadow。 */
    glyphShadowOffset?: { x: number; y: number } | null;
  } = $props();

  const preset = $derived(parsePresetAvatar(avatar));
  const uploadFile = $derived(parseUploadedAvatar(avatar));
  const uploadedUrl = $derived(uploadFile === null ? null : avatarImages.url(botId, uploadFile));
  const initial = $derived((name || '?').slice(0, 1).toUpperCase());
  const shadowVars = $derived(
    glyphShadowOffset === null
      ? undefined
      : `--group-avatar-sx:${glyphShadowOffset.x}px; --group-avatar-sy:${glyphShadowOffset.y}px`,
  );
  const glyphShadowClass = $derived(glyphShadowOffset !== null ? 'group-avatar-glyph-shadow' : '');
  // 归一后的遮罩值同时驱动 class 与 data 属性（测试 / 调试看得到的就是实际生效的那个）。
  const maskValue = $derived(normalizeBotAvatarMask(mask));
  const maskClass = $derived(avatarMaskClass(maskValue));
  // 内边距同遮罩：归一后驱动 style 与 data 属性；0 不写 style（与旧行为逐像素一致）。
  const paddingValue = $derived(normalizeBotAvatarPadding(padding));
  const paddingStyle = $derived(paddingValue > 0 ? `padding:${paddingValue}px` : undefined);
  const letterShadowClass = $derived(
    glyphShadowOffset !== null ? 'group-avatar-letter-shadow' : '',
  );
</script>

{#if preset}
  <!-- 群马赛克需要字影溢出：去掉 overflow-hidden，让 drop-shadow 跟形状走。 -->
  <span
    class="inline-block {klass} shrink-0 rounded-full {glyphShadowOffset ? '' : 'overflow-hidden'}"
    style={shadowVars}
    data-testid={testId}
  >
    <BotPresetAvatar value={avatar ?? ''} class="size-full {glyphShadowClass}" {animated} />
  </span>
{:else if uploadFile !== null && uploadedUrl !== null}
  <!-- 遮罩圆角打在 img 上而不是容器上：border-radius 百分比按图片自身盒子解析，
       padding 内缩后形状仍跟随可见图片（容器上的圆角会够不着内缩的图——圆形把
       图片四角斜切掉、圆角方的直角直接露出来）。padding = 0 时与旧结构逐像素一致。 -->
  <span
    class="inline-block {klass} shrink-0"
    style={paddingStyle}
    data-testid={testId}
    data-avatar-mask={maskValue}
    data-avatar-padding={paddingValue}
  >
    <img src={uploadedUrl} alt={name} class="size-full object-cover {maskClass}" />
  </span>
{:else if glyphShadowOffset !== null}
  <!-- 字母占位：text-shadow 只打在字上，避免整圆 filter 看起来像瓦片描边。 -->
  <span
    class="inline-flex {klass} shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
    style={shadowVars}
    data-testid={testId}
  >
    <span class="leading-none select-none {fallbackClass} {letterShadowClass}">{initial}</span>
  </span>
{:else}
  <Avatar.Root class={klass}>
    <Avatar.Fallback class={fallbackClass} data-testid={testId}>{initial}</Avatar.Fallback>
  </Avatar.Root>
{/if}
