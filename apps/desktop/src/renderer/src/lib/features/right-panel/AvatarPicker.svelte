<script lang="ts">
  /**
   * 头像编辑卡（参考 Grok Bot 的 Edit Avatar 弹层）：左上「预置 / 上传」
   * 两个页签，右上 Reset（恢复预置第一个形状 + 第一种颜色）。预置页签
   * 形状网格 + 颜色色板，点选即保存；上传页签选图后先经 AvatarCropper
   * 裁成方形（弹窗 Portal 到 body），确认再上传。
   */
  import { ImagePlus, RotateCcw } from '@lucide/svelte';
  import { normalizeBotAvatarMask, type Bot, type BotAvatarMask } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import {
    AVATAR_COLORS,
    AVATAR_MASKS,
    AVATAR_SHAPES,
    DEFAULT_AVATAR,
    formatPresetAvatar,
    parsePresetAvatar,
    parseUploadedAvatar,
  } from '$lib/avatars/presets';
  import AvatarCropper from '$lib/avatars/AvatarCropper.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import BotPresetAvatar from '$lib/avatars/BotPresetAvatar.svelte';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';

  let { bot, open = $bindable() }: { bot: Bot; open?: boolean } = $props();

  const shapeLabel = (id: string): string => t(`avatars.shape.${id}` as MessageKey);
  const colorLabel = (id: string): string => t(`avatars.color.${id}` as MessageKey);

  let tab = $state<'preset' | 'upload'>('preset');
  let uploading = $state(false);
  // 遮罩写入中：两个按钮一起禁用，避免连点把旧值写到最后。
  let maskPending = $state<BotAvatarMask | null>(null);
  let cropFile = $state<File | null>(null);
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

  // 遮罩切换只对上传头像露出：预置头像自带轮廓，改形状没有意义。
  const uploadedFile = $derived(parseUploadedAvatar(bot.avatar));
  const mask = $derived(normalizeBotAvatarMask(bot.avatarMask));

  // Esc 经层级仲裁：头像选择器开着时，一次 Esc 只收起它，不连带关外层的 Bot 详情覆盖层。
  $effect(() => {
    if (!open) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.popover,
      onEscape: () => {
        open = false;
      },
    });
  });

  function closeOnPointerdown(event: PointerEvent): void {
    // 裁切弹窗开着时（Portal 到 body，目标必在 node 外）不动选择器。
    if (cropFile !== null) return;
    if (open && node && !node.contains(event.target as globalThis.Node)) open = false;
  }

  async function applyAvatar(avatarValue: string): Promise<void> {
    try {
      // profile 来自响应式 store，嵌套对象仍是代理——RPC 走 structured clone，
      // 必须先 snapshot 成纯数据，否则 postMessage 直接抛错。base = 这份写入前的
      // profile：core 三方合并，没改的字段（如模型）不会被盖回去。
      const base = $state.snapshot(bot.profile) as Bot['profile'];
      await contacts.update(
        bot.id,
        {
          ...base,
          identity: { ...base.identity, avatar: avatarValue },
        },
        base,
      );
    } catch (error) {
      toast.error(
        t('rightPanel.avatarSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** 遮罩单独一条 RPC（不是 Profile 字段）：core 发布 bot.updated，头像即时换形状。 */
  async function applyMask(next: BotAvatarMask): Promise<void> {
    if (next === mask || maskPending !== null) return;
    maskPending = next;
    try {
      await core.call('bots.avatar.mask', { id: bot.id, mask: next });
    } catch (error) {
      toast.error(
        t('rightPanel.avatarSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      maskPending = null;
    }
  }

  function onPickFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // 选图先弹裁切：确认后才上传（AvatarCropper 的 onconfirm）。
    cropFile = file;
  }

  async function onCropConfirm(payload: { mime: 'image/png'; bytesBase64: string }): Promise<void> {
    uploading = true;
    try {
      await core.call('bots.avatar.upload', {
        id: bot.id,
        mime: payload.mime,
        bytesBase64: payload.bytesBase64,
      });
      cropFile = null;
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

<svelte:window onpointerdown={closeOnPointerdown} />

{#if open}
  <div
    bind:this={node}
    class="absolute top-full left-1/2 z-30 mt-2 w-76 -translate-x-1/2 rounded-2xl border bg-popover text-sm shadow-xl"
    data-testid="avatar-picker"
  >
    <div class="flex items-center gap-1 border-b p-2">
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
      <div class="grid grid-cols-5 gap-1.5 p-2" data-testid="avatar-shape-grid">
        {#each AVATAR_SHAPES as shape (shape.id)}
          <button
            type="button"
            class="flex aspect-square items-center justify-center rounded-xl transition-colors hover:bg-accent {selected
              .shape.id === shape.id
              ? 'bg-accent ring-2 ring-ring'
              : ''}"
            title={shapeLabel(shape.id)}
            aria-label={shapeLabel(shape.id)}
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
      <!-- 宽度刚好放下 6 颗，多出的 5 颗换行后由 justify-center 居中，形成 6+5。 -->
      <div
        class="mx-auto box-content flex w-[calc(6*1.75rem+5*0.75rem+1px)] flex-wrap justify-center gap-3 p-4"
        data-testid="avatar-color-grid"
      >
        {#each AVATAR_COLORS as color (color.id)}
          <button
            type="button"
            class="size-7 shrink-0 rounded-full transition-transform hover:scale-110 {selected.color
              .id === color.id
              ? 'ring-2 ring-ring ring-offset-2 ring-offset-popover'
              : ''}"
            style="background: {color.hex};"
            title={colorLabel(color.id)}
            aria-label={colorLabel(color.id)}
            onclick={() => void applyAvatar(formatPresetAvatar(selected.shape.id, color.id))}
            data-testid={`avatar-color-${color.id}`}
          ></button>
        {/each}
      </div>
    {:else}
      <div class="p-2">
        {#if uploadedFile !== null}
          <div class="mb-2" data-testid="avatar-mask-picker">
            <p class="flex items-baseline gap-1.5 px-1 pb-1.5">
              <span class="text-xs font-medium">{t('rightPanel.avatarMaskTitle')}</span>
              <span class="text-[11px] text-muted-foreground"
                >{t('rightPanel.avatarMask.hint')}</span
              >
            </p>
            <div class="flex gap-2" role="group" aria-label={t('rightPanel.avatarMaskTitle')}>
              {#each AVATAR_MASKS as option (option)}
                <button
                  type="button"
                  class="flex flex-1 items-center justify-center gap-2 rounded-xl border px-2 py-2 transition-colors hover:bg-accent {mask ===
                  option
                    ? 'border-ring bg-accent'
                    : 'border-border/60'} {maskPending !== null
                    ? 'pointer-events-none opacity-60'
                    : ''}"
                  onclick={() => void applyMask(option)}
                  aria-pressed={mask === option}
                  disabled={maskPending !== null}
                  data-testid={`avatar-mask-${option}`}
                >
                  <!-- 直接用当前上传图做预览：选的就是最终效果。 -->
                  <BotAvatar
                    botId={bot.id}
                    name={bot.name}
                    avatar={bot.avatar}
                    mask={option}
                    class="size-8"
                    animated={false}
                  />
                  <span class="text-xs">{t(`rightPanel.avatarMask.${option}` as MessageKey)}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
        <label
          class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-2 px-4 py-6 text-center text-muted-foreground transition-colors hover:bg-accent {uploading
            ? 'pointer-events-none opacity-60'
            : ''}"
          data-testid="avatar-upload-zone"
        >
          <ImagePlus class="size-6" aria-hidden="true" />
          <span>{t('rightPanel.avatarUploadHint')}</span>
          <span class="text-xs text-muted-foreground/80"
            >{t('rightPanel.avatarUploadCropHint')}</span
          >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
            class="hidden"
            onchange={onPickFile}
            data-testid="avatar-upload-input"
          />
        </label>
      </div>
    {/if}
  </div>
{/if}

{#if cropFile !== null}
  <AvatarCropper
    file={cropFile}
    {mask}
    busy={uploading}
    onconfirm={onCropConfirm}
    oncancel={() => (cropFile = null)}
  />
{/if}
