async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * 把图片文件解码成 HTMLImageElement（SVG 也能走 <img> 光栅化，是裁切的统一入口）。
 * 调用方负责在用完后 `URL.revokeObjectURL`。
 */
export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new Error('image decode failed', { cause: error });
  }
  return image;
}

/** 释放 loadImageFromFile 的 object URL（单独导出便于 finally 里成对调用）。 */
export function revokeLoadedImage(image: HTMLImageElement): void {
  if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
}

/**
 * 裁切结果（canvas 已按方形画好）→ 头像上传载荷：统一缩到 ≤256×256 再编码 PNG，
 * 控制 RPC 体积与落盘大小（core 侧另有 3 MB 上限兜底）。
 */
export async function canvasToAvatarPayload(
  source: HTMLCanvasElement,
  max = 256,
): Promise<{ mime: 'image/png'; bytesBase64: string }> {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('png encode failed');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { mime: 'image/png', bytesBase64: await bytesToBase64(bytes) };
}
