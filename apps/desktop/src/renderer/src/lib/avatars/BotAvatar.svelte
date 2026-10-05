<script lang="ts">
  /**
   * 统一的 Bot 头像：preset → SVG 预置头像；upload → RPC 取回的图片；
 * 其它（历史数据/已删除）→ 首字母占位。尺寸由调用方以 class 传入
   * （组件内部元素均为 size-full）。
   */
  import * as Avatar from '$lib/components/ui/avatar';
  import { avatarImages } from './avatar-images.svelte';
  import BotPresetAvatar from './BotPresetAvatar.svelte';
  import { parsePresetAvatar, parseUploadedAvatar } from './presets';

  let {
    botId,
    name = '',
    avatar = null,
    class: klass = 'size-8',
    testId,
    animated = true,
    fallbackClass = '',
  }: {
    botId: string;
    name?: string;
    avatar?: string | null;
    class?: string;
    testId?: string;
    animated?: boolean;
    fallbackClass?: string;
  } = $props();

  const preset = $derived(parsePresetAvatar(avatar));
  const uploadFile = $derived(parseUploadedAvatar(avatar));
  const uploadedUrl = $derived(
    uploadFile === null ? null : avatarImages.url(botId, uploadFile),
  );
  const initial = $derived((name || '?').slice(0, 1).toUpperCase());
</script>

{#if preset}
  <span class="inline-block {klass} shrink-0 overflow-hidden rounded-full" data-testid={testId}>
    <BotPresetAvatar value={avatar ?? ''} class="size-full" animated={animated} />
  </span>
{:else if uploadFile !== null && uploadedUrl !== null}
  <span class="inline-block {klass} shrink-0 overflow-hidden rounded-full" data-testid={testId}>
    <img src={uploadedUrl} alt={name} class="size-full object-cover" />
  </span>
{:else}
  <Avatar.Root class={klass}>
    <Avatar.Fallback class={fallbackClass} data-testid={testId}>{initial}</Avatar.Fallback>
  </Avatar.Root>
{/if}
