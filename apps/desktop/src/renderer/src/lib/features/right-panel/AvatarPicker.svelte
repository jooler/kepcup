<script lang="ts">
  /**
   * 头像编辑卡（参考 Grok Bot 的 Edit Avatar 弹层）：左上「预置 / 上传」
   * 两个页签，右上 Reset（恢复预置第一个形状 + 第一种颜色）。预置页签
   * 形状网格 + 颜色色板，点选即保存；上传页签选择图片后前端缩放再上传。
   */
  import { ImagePlus, RotateCcw } from '@lucide/svelte';
  import type { Bot } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import {
    AVATAR_COLORS,
    AVATAR_SHAPES,
    DEFAULT_AVATAR,
    formatPresetAvatar,
    parsePresetAvatar,
  } from '$lib/avatars/presets';
  import { fileToScaledPngBase64 } from '$lib/avatars/upload-image';
  import BotPresetAvatar from '$lib/avatars/BotPresetAvatar.svelte';

  let { bot, open = $bindable() }: { bot: Bot; open?: boolean } = $props();

  let tab = $state<'preset' | 'upload'>('preset');
  let uploading = $state(false);
  let node = $state<HTMLDivElement | null>(null);

  // 当前选择：预置值直接解析；尚未设置头像（或上传态）时视为默认组合，
  // 让「重置」的目标（第一个形状+第一种颜色）在选择器里有选中标记。
  const selected = $derived(
    parsePresetAvatar(bot.avatar) ?? {
      shape: AVATAR_SHAPES[0]!,
      color: AVATAR_COLORS[0]!,
    },
  );
  // 预置网格里实时反显的颜色：上传态等没有预置颜色时用默认色。
  const activeColor = $derived(selected.color);

  function closeOnPointerdown(event: PointerEvent): void {
    if (open && node && !node.contains(event.target as globalThis.Node)) open = false;
  }

  async function applyAvatar(avatarValue: string): Promise<void> {
    try {
      // profile 来自响应式 store，嵌套对象仍是代理——RPC 走 structured clone，
      // 必须先 snapshot 成纯数据，否则 postMessage 直接抛错。
      await contacts.update(
        bot.id,
        $state.snapshot({
          ...bot.profile,
          identity: { ...bot.profile.identity, avatar: avatarValue },
        }) as Bot['profile'],
      );
    } catch (error) {
      toast.error(
        t('rightPanel.avatarSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function onPickFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploading = true;
    try {
      const bytesBase64 = await fileToScaledPngBase64(file);
      await core.call('bots.avatar.upload', { id: bot.id, mime: 'image/png', bytesBase64 });
      open = false;
    } catch (error) {
      toast.error(
        t('rightPanel.avatarUploadFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      uploading = false;
    }
  }
</script>

<svelte:window
  onpointerdown={closeOnPointerdown}
  onkeydown={(e) => {
    if (e.key === 'Escape') open = false;
  }}
/>

{#if open}
  <div
    bind:this={node}
    class="absolute top-full left-1/2 z-30 mt-2 w-76 -translate-x-1/2 rounded-2xl border bg-popover p-3 text-sm shadow-xl"
    data-testid="avatar-picker"
  >
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="rounded-full px-2.5 py-1 font-medium transition-colors {tab === 'preset'
          ? 'bg-muted text-foreground'
          : 'text-foreground/55 hover:text-foreground'}"
        onclick={() => (tab = 'preset')}
        data-testid="avatar-tab-preset"
      >
        {t('rightPanel.avatarTabPreset')}
      </button>
      <button
        type="button"
        class="rounded-full px-2.5 py-1 font-medium transition-colors {tab === 'upload'
          ? 'bg-muted text-foreground'
          : 'text-foreground/55 hover:text-foreground'}"
        onclick={() => (tab = 'upload')}
        data-testid="avatar-tab-upload"
      >
        {t('rightPanel.avatarTabUpload')}
      </button>
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex items-center gap-1 rounded-full px-2 py-1 text-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => void applyAvatar(DEFAULT_AVATAR)}
        title={t('rightPanel.avatarResetHint')}
        data-testid="avatar-reset"
      >
        <RotateCcw class="size-3.5" aria-hidden="true" />
        {t('rightPanel.avatarReset')}
      </button>
    </div>

    {#if tab === 'preset'}
      <div class="mt-3 grid grid-cols-5 gap-1.5" data-testid="avatar-shape-grid">
        {#each AVATAR_SHAPES as shape (shape.id)}
          <button
            type="button"
            class="flex aspect-square items-center justify-center rounded-xl transition-colors hover:bg-accent {selected.shape.id ===
              shape.id
              ? 'bg-accent ring-2 ring-ring'
              : ''}"
            title={shape.label}
            aria-label={shape.label}
            onclick={() => void applyAvatar(formatPresetAvatar(shape.id, activeColor.id))}
            data-testid={`avatar-shape-${shape.id}`}
          >
            <BotPresetAvatar
              value={formatPresetAvatar(shape.id, activeColor.id)}
              class="size-11/12"
              animated={false}
            />
          </button>
        {/each}
      </div>
      <div class="mt-3 grid grid-cols-6 gap-2 px-1" data-testid="avatar-color-grid">
        {#each AVATAR_COLORS as color (color.id)}
          <button
            type="button"
            class="flex aspect-square items-center justify-center rounded-full transition-transform hover:scale-110 {selected.color.id ===
              color.id
              ? 'ring-2 ring-ring ring-offset-2 ring-offset-popover'
              : ''}"
            style="background: {color.hex}"
            title={color.label}
            aria-label={color.label}
            onclick={() => void applyAvatar(formatPresetAvatar(selected.shape.id, color.id))}
            data-testid={`avatar-color-${color.id}`}
          ></button>
        {/each}
      </div>
    {:else}
      <label
        class="mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground transition-colors hover:bg-accent {uploading
          ? 'pointer-events-none opacity-60'
          : ''}"
        data-testid="avatar-upload-zone"
      >
        <ImagePlus class="size-6" aria-hidden="true" />
        <span>{t('rightPanel.avatarUploadHint')}</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          class="hidden"
          onchange={onPickFile}
          data-testid="avatar-upload-input"
        />
      </label>
    {/if}
  </div>
{/if}
