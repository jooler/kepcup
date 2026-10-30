<script lang="ts">
  /**
   * 正方形头像裁切（设置页个人资料与 Bot 详情上传共用）：选图后弹出，画面默认
   * cover 填满方形视口，拖动平移、滚轮 / 滑杆 / 按钮等比缩放，视口即裁切范围，
   * 右下圆形小窗实时预览成图效果；确认后光栅化为 ≤256×256 的 PNG 载荷。
   * SVG 输入经 <img> 光栅化（裁切输出恒为位图），与整图上传共用体积约束。
   */
  import { ZoomIn, ZoomOut } from '@lucide/svelte';
  import type { BotAvatarMask } from '@kepcup/shared';
  import { avatarMaskClass } from './presets';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { canvasToAvatarPayload, loadImageFromFile, revokeLoadedImage } from './upload-image';

  let {
    file,
    mask = null,
    busy = false,
    onconfirm,
    oncancel,
  }: {
    file: File;
    /** Bot 头像的遮罩形状：右下预览小窗跟随（缺省 / null = 圆形）。 */
    mask?: BotAvatarMask | null;
    busy?: boolean;
    onconfirm: (payload: { mime: 'image/png'; bytesBase64: string }) => void;
    oncancel: () => void;
  } = $props();

  const VIEW = 256;
  const PREVIEW = 56;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 5;

  let image = $state<HTMLImageElement | null>(null);
  let loadFailed = $state(false);
  let zoom = $state(1);
  let ox = $state(0);
  let oy = $state(0);
  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;

  $effect(() => {
    let cancelled = false;
    let loaded: HTMLImageElement | null = null;
    loadImageFromFile(file)
      .then((img) => {
        if (cancelled) {
          revokeLoadedImage(img);
          return;
        }
        loaded = img;
        image = img;
        zoom = 1;
        ox = 0;
        oy = 0;
      })
      .catch(() => {
        if (!cancelled) loadFailed = true;
      });
    return () => {
      cancelled = true;
      if (loaded) revokeLoadedImage(loaded);
    };
  });

  /** cover 基准（zoom=1 时刚好铺满视口）下的显示尺寸与平移边界。 */
  const dims = $derived.by(() => {
    const w = image?.naturalWidth ?? 0;
    const h = image?.naturalHeight ?? 0;
    if (w === 0 || h === 0) return null;
    const s = Math.max(VIEW / w, VIEW / h) * zoom;
    const dw = w * s;
    const dh = h * s;
    return { s, dw, dh, mx: Math.max(0, (dw - VIEW) / 2), my: Math.max(0, (dh - VIEW) / 2) };
  });

  $effect(() => {
    if (!dims) return;
    ox = Math.min(dims.mx, Math.max(-dims.mx, ox));
    oy = Math.min(dims.my, Math.max(-dims.my, oy));
  });

  const mainStyle = $derived.by(() => {
    if (!dims) return '';
    return `width:${dims.dw}px;height:${dims.dh}px;left:${(VIEW - dims.dw) / 2 + ox}px;top:${
      (VIEW - dims.dh) / 2 + oy
    }px;`;
  });
  const previewStyle = $derived.by(() => {
    if (!dims) return '';
    const k = PREVIEW / VIEW;
    return `width:${dims.dw * k}px;height:${dims.dh * k}px;left:${
      ((VIEW - dims.dw) / 2 + ox) * k
    }px;top:${((VIEW - dims.dh) / 2 + oy) * k}px;`;
  });

  function setZoom(next: number): void {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  }

  function wheelAction(node: HTMLElement): { destroy: () => void } {
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY * 0.0015));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onWheel) };
  }

  function onPointerDown(event: PointerEvent): void {
    if (!image) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    ox += event.clientX - lastX;
    oy += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }
  function onPointerUp(event: PointerEvent): void {
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  async function confirm(): Promise<void> {
    if (!image || !dims) return;
    const sw = VIEW / dims.s;
    const sx = (dims.dw - VIEW) / 2 / dims.s - ox / dims.s;
    const sy = (dims.dh - VIEW) / 2 / dims.s - oy / dims.s;
    // 裁切源矩形夹回图片边界（cover + 平移边界已保证，只防浮点越界）。
    const clampedSx = Math.min(Math.max(sx, 0), Math.max(0, image.naturalWidth - sw));
    const clampedSy = Math.min(Math.max(sy, 0), Math.max(0, image.naturalHeight - sw));
    const canvas = document.createElement('canvas');
    canvas.width = VIEW;
    canvas.height = VIEW;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, clampedSx, clampedSy, sw, sw, 0, 0, VIEW, VIEW);
    onconfirm(await canvasToAvatarPayload(canvas));
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open && !busy) oncancel();
  }}
>
  <Dialog.Content class="sm:max-w-sm" data-testid="avatar-cropper">
    <Dialog.Header>
      <Dialog.Title>{t('avatars.crop.title')}</Dialog.Title>
      <Dialog.Description>{t('avatars.crop.hint')}</Dialog.Description>
    </Dialog.Header>

    {#if image && dims}
      <div class="flex items-start gap-3">
        <div
          class="relative shrink-0 touch-none select-none overflow-hidden rounded-lg border {dragging
            ? 'cursor-grabbing'
            : 'cursor-grab'}"
          style="width:{VIEW}px;height:{VIEW}px;"
          use:wheelAction
          role="img"
          aria-label={t('avatars.crop.title')}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
          data-testid="avatar-cropper-viewport"
        >
          <div class="absolute" style={mainStyle}>
            <img src={image.src} alt="" class="block size-full select-none" draggable="false" />
          </div>
          <!-- 四角裁切指示 -->
          <span class="pointer-events-none absolute top-1 left-1 size-5 rounded-tl border-t-2 border-l-2 border-white/90"></span>
          <span class="pointer-events-none absolute top-1 right-1 size-5 rounded-tr border-t-2 border-r-2 border-white/90"></span>
          <span class="pointer-events-none absolute bottom-1 left-1 size-5 rounded-bl border-b-2 border-l-2 border-white/90"></span>
          <span class="pointer-events-none absolute right-1 bottom-1 size-5 rounded-br border-r-2 border-b-2 border-white/90"></span>
        </div>
        <div class="flex flex-col items-center gap-2">
          <div
            class="relative shrink-0 overflow-hidden {avatarMaskClass(mask)} border shadow-sm"
            style="width:{PREVIEW}px;height:{PREVIEW}px;"
            data-testid="avatar-cropper-preview"
          >
            <div class="absolute" style={previewStyle}>
              <img src={image.src} alt="" class="block size-full select-none" draggable="false" />
            </div>
          </div>
          <span class="text-xs text-muted-foreground">{t('avatars.crop.preview')}</span>
        </div>
      </div>

      <div class="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          class="size-7"
          disabled={zoom <= MIN_ZOOM}
          onclick={() => setZoom(zoom / 1.25)}
          data-testid="avatar-cropper-zoom-out"
        >
          <ZoomOut class="size-4" aria-hidden="true" />
        </Button>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step="0.01"
          bind:value={zoom}
          class="h-1 flex-1 accent-primary"
          data-testid="avatar-cropper-slider"
          aria-label={t('avatars.crop.zoom')}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          class="size-7"
          disabled={zoom >= MAX_ZOOM}
          onclick={() => setZoom(zoom * 1.25)}
          data-testid="avatar-cropper-zoom-in"
        >
          <ZoomIn class="size-4" aria-hidden="true" />
        </Button>
      </div>
    {:else if loadFailed}
      <p class="py-8 text-center text-sm text-muted-foreground" data-testid="avatar-cropper-error">
        {t('avatars.crop.loadFailed')}
      </p>
    {:else}
      <div class="flex items-center justify-center py-8" style="min-height:{VIEW}px;">
        <span class="text-sm text-muted-foreground">{t('common.loading')}</span>
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={oncancel} data-testid="avatar-cropper-cancel">
        {t('common.cancel')}
      </Button>
      <Button disabled={!image || busy} onclick={() => void confirm()} data-testid="avatar-cropper-confirm">
        {busy ? t('avatars.crop.saving') : t('avatars.crop.confirm')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
