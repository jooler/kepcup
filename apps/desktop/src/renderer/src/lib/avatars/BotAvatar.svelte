<script lang="ts">
  /**
   * 统一的 Bot 头像：preset → SVG 预置头像；upload → RPC 取回的图片；
   * 其它（历史数据/已删除）→ 首字母占位。尺寸由调用方以 class 传入
   * （组件内部元素均为 size-full）。
   */
  import * as Avatar from '$lib/components/ui/avatar';
  import type { BotAvatarMask } from '@kepcup/shared';
  import { avatarImages } from './avatar-images.svelte';
  import BotPresetAvatar from './BotPresetAvatar.svelte';
  import { avatarMaskClass, parsePresetAvatar, parseUploadedAvatar } from './presets';

  let {
    botId,
    name = '',
    avatar = null,
    mask = null,
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
  const maskClass = $derived(avatarMaskClass(mask));
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
  <span
    class="inline-block {klass} shrink-0 overflow-hidden {maskClass}"
    data-testid={testId}
    data-avatar-mask={mask ?? 'circle'}
  >
    <img src={uploadedUrl} alt={name} class="size-full object-cover" />
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
