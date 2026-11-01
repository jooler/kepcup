<script lang="ts">
  /**
   * 头像编辑卡（参考 Grok Bot 的 Edit Avatar 弹层）：左上三个页签「预置 / 上传 /
   * 强调色」，右上 Reset（只重置头像形状，不动强调色）。预置页签只有形状网格
   * （预览用当前强调色）；上传页签选图后先经 AvatarCropper 裁成方形，确认再上传，
   * 遮罩 / 内边距也在这里；强调色页签是 Bot 在应用各处的腔调色，与是否上传头像无关。
   */
  import { ImagePlus, Minus, Plus, RotateCcw } from '@lucide/svelte';
  import {
    DEFAULT_BOT_ACCENT_COLOR,
    MAX_BOT_AVATAR_PADDING,
    normalizeBotAvatarMask,
    normalizeBotAvatarPadding,
    type Bot,
    type BotAccentColor,
    type BotAvatarMask,
  } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import {
    ACCENT_COLORS,
    AVATAR_MASKS,
    AVATAR_SHAPES,
    formatPresetAvatar,
    parsePresetAvatar,
    parseUploadedAvatar,
    resolveAccentColor,
  } from '$lib/avatars/presets';
  import AvatarCropper from '$lib/avatars/AvatarCropper.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import BotPresetAvatar from '$lib/avatars/BotPresetAvatar.svelte';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';

  let { bot, open = $bindable() }: { bot: Bot; open?: boolean } = $props();

  const shapeLabel = (id: string): string => t(`avatars.shape.${id}` as MessageKey);
  const colorLabel = (id: string): string => t(`avatars.color.${id}` as MessageKey);

  let tab = $state<'preset' | 'upload' | 'accent'>('preset');
  let uploading = $state(false);
  // 强调色写入中：色板一起禁用，避免连点把旧值写到最后。
  let accentPending = $state<BotAccentColor | null>(null);
  // 遮罩写入中：两个按钮一起禁用，避免连点把旧值写到最后。
  let maskPending = $state<BotAvatarMask | null>(null);
  // 内边距写入中：步进器乐观显示目标值，连点按目标值继续加减。
  let paddingPending = $state<number | null>(null);
  let cropFile = $state<File | null>(null);
  let node = $state<HTMLDivElement | null>(null);

  // 当前形状：只有预置头像才有；上传态没有形状，预置网格不画选中环。
  const selectedShape = $derived(parsePresetAvatar(bot.avatar)?.shape ?? null);
  /**
   * 当前强调色：显式 `accentColor` → 预置头像内嵌色 → 默认「黑白」。上传头像不会
   * 改变它（旧 bug：上传后颜色回退成第一个自动色）。
   */
  const accent = $derived(resolveAccentColor(bot.accentColor, bot.avatar));
  // 写入中乐观显示目标色，避免连点在旧色上重复写。
  const activeAccentId = $derived(accentPending ?? accent.id);

  // 遮罩切换只对上传头像露出：预置头像自带轮廓，改形状没有意义。
  const uploadedFile = $derived(parseUploadedAvatar(bot.avatar));
  const mask = $derived(normalizeBotAvatarMask(bot.avatarMask));
  // 步进器展示值：写入中乐观显示目标值，否则用已保存的（读侧归一，缺省 0）。
  const padding = $derived(paddingPending ?? normalizeBotAvatarPadding(bot.avatarPadding));

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

  /** 遮罩单独一条 RPC（不是 Profile 字段）：core 发布 bot.updated，头像即时换形状。 */ async function applyMask(
    next: BotAvatarMask,
  ): Promise<void> {
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

  /**
   * 内边距同遮罩：单独一条 RPC（bots.avatar.padding），core 发布 bot.updated。
   * 步进连点：pending 期间按乐观值继续加减，全部落到最新的目标值。
   */
  async function applyPadding(next: number): Promise<void> {
    const clamped = Math.min(Math.max(Math.round(next), 0), MAX_BOT_AVATAR_PADDING);
    if (clamped === padding) return;
    paddingPending = clamped;
    try {
      await core.call('bots.avatar.padding', { id: bot.id, padding: clamped });
    } catch (error) {
      toast.error(
        t('rightPanel.avatarSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      paddingPending = null;
    }
  }

  /**
   * 强调色单独一条 RPC（bots.accent.color）：与头像完全解耦——选形状、换上传图、
   * 改遮罩 / 内边距都不会写它。core 会同步改写预置串的颜色段（旧客户端也跟着变）。
   */
  async function applyAccentColor(color: BotAccentColor): Promise<void> {
    if (color === accent.id || accentPending !== null) return;
    accentPending = color;
    try {
      await core.call('bots.accent.color', { id: bot.id, color });
    } catch (error) {
      toast.error(
        t('rightPanel.avatarSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      accentPending = null;
    }
  }

  /** 选形状：颜色段永远写当前强调色（旧版本客户端只认内嵌色）。 */
  function pickShape(shapeId: string): void {
    void applyAvatar(formatPresetAvatar(shapeId, accent.id));
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
      <button
        type="button"
        class="rounded-full px-2.5 py-1 font-medium transition-colors {tab === 'accent'
          ? 'bg-muted text-foreground'
          : 'text-foreground/55 hover:text-foreground'}"
        onclick={() => (tab = 'accent')}
        data-testid="avatar-tab-accent"
      >
        {t('rightPanel.avatarTabAccent')}
      </button>
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex items-center gap-1 rounded-full px-2 py-1 text-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => pickShape(AVATAR_SHAPES[0]!.id)}
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
            class="flex aspect-square items-center justify-center rounded-xl transition-colors hover:bg-accent {selectedShape?.id ===
            shape.id
              ? 'bg-accent ring-2 ring-ring'
              : ''}"
            title={shapeLabel(shape.id)}
            aria-label={shapeLabel(shape.id)}
            onclick={() => pickShape(shape.id)}
            data-testid={`avatar-shape-${shape.id}`}
          >
            <BotPresetAvatar
              value={formatPresetAvatar(shape.id, accent.id)}
              accentColor={accent.id}
              class="size-11/12"
              animated={false}
            />
          </button>
        {/each}
      </div>
    {:else if tab === 'accent'}
      <div class="p-2" data-testid="avatar-accent-tab">
        <p class="px-1 pb-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('rightPanel.avatarAccentHint')}
        </p>
        <!-- 宽度刚好放下 6 颗，多出的 5 颗换行后由 justify-center 居中，形成 6+5。 -->
        <div
          class="mx-auto box-content flex w-[calc(6*1.75rem+5*0.75rem+1px)] flex-wrap justify-center gap-3 px-2 pt-1 pb-3"
          data-testid="avatar-color-grid"
        >
          {#each ACCENT_COLORS as color (color.id)}
            <button
              type="button"
              class="size-7 shrink-0 rounded-full transition-transform hover:scale-110 disabled:pointer-events-none disabled:opacity-60 {activeAccentId ===
              color.id
                ? 'ring-2 ring-ring ring-offset-2 ring-offset-popover'
                : ''}"
              style="background: {color.hex};"
              title={colorLabel(color.id)}
              aria-label={colorLabel(color.id)}
              onclick={() => void applyAccentColor(color.id)}
              disabled={accentPending !== null}
              data-testid={`avatar-color-${color.id}`}
            ></button>
          {/each}
        </div>
        <div class="flex items-center gap-2 border-t px-1 pt-2">
          <span class="text-xs text-muted-foreground"
            >{t('rightPanel.avatarAccentCurrent', {
              color: colorLabel(accent.id),
            })}</span
          >
          <span class="flex-1"></span>
          <button
            type="button"
            class="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-foreground/60 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            onclick={() => void applyAccentColor(DEFAULT_BOT_ACCENT_COLOR)}
            disabled={accentPending !== null || accent.id === DEFAULT_BOT_ACCENT_COLOR}
            title={t('rightPanel.avatarAccentResetHint')}
            data-testid="avatar-accent-reset"
          >
            <RotateCcw class="size-3.5" aria-hidden="true" />
            {t('rightPanel.avatarAccentReset')}
          </button>
        </div>
      </div>
    {:else}
      <div class="p-2">
        {#if uploadedFile !== null}
          <div class="mb-2" data-testid="avatar-mask-picker">
            <!-- 标题不换行不收缩（6 字标题也不折行），说明占满剩余宽度自动换行。 -->
            <p class="flex items-baseline gap-1.5 px-1 pb-1.5">
              <span class="shrink-0 text-xs font-medium whitespace-nowrap"
                >{t('rightPanel.avatarMaskTitle')}</span
              >
              <span class="min-w-0 flex-1 text-[11px] text-muted-foreground"
                >{t('rightPanel.avatarMask.hint')}</span
              >
            </p>
            <div class="flex gap-2" role="group" aria-label={t('rightPanel.avatarMaskTitle')}>
              {#each AVATAR_MASKS as option (option)}
                <button
                  type="button"
                  class="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 transition-colors hover:bg-accent {mask ===
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
                    accentColor={bot.accentColor}
                    mask={option}
                    {padding}
                    class="size-12"
                    animated={false}
                  />
                  <span class="text-xs">{t(`rightPanel.avatarMask.${option}` as MessageKey)}</span>
                </button>
              {/each}
            </div>
          </div>
          <!-- 内边距：标题一行，右侧 − / 数值 / + 步进（说明与预览图已并入形状预览）。 -->
          <div
            class="flex items-center gap-1.5 px-1 pb-2"
            role="group"
            aria-label={t('rightPanel.avatarPaddingTitle')}
            data-testid="avatar-padding-picker"
          >
            <span class="shrink-0 text-xs font-medium whitespace-nowrap"
              >{t('rightPanel.avatarPaddingTitle')}</span
            >
            <div class="ml-auto flex items-center gap-1">
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-md border border-border/60 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                onclick={() => void applyPadding(padding - 1)}
                aria-label={t('rightPanel.avatarPaddingDecrease')}
                disabled={padding <= 0}
                data-testid="avatar-padding-decrease"
              >
                <Minus class="size-3.5" aria-hidden="true" />
              </button>
              <span class="w-9 text-center text-xs tabular-nums" data-testid="avatar-padding-value">
                {padding}px
              </span>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-md border border-border/60 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                onclick={() => void applyPadding(padding + 1)}
                aria-label={t('rightPanel.avatarPaddingIncrease')}
                disabled={padding >= MAX_BOT_AVATAR_PADDING}
                data-testid="avatar-padding-increase"
              >
                <Plus class="size-3.5" aria-hidden="true" />
              </button>
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
