const MAX_UPLOAD_BYTES = 20_000_000;
const MAX_SVG_BYTES = 3_000_000;

function isSvg(file: File): boolean {
  return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
}

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * 上传头像的 RPC 载荷：位图在渲染端先缩到 ≤256×256 再编码 PNG，控制 RPC
 * 体积与落盘大小；SVG 是矢量，原样上传（core 限制 3 MB）。
 */
export async function fileToAvatarPayload(
  file: File,
  max = 256,
): Promise<{ mime: 'image/png' | 'image/svg+xml'; bytesBase64: string }> {
  if (isSvg(file)) {
    if (file.size > MAX_SVG_BYTES) throw new Error('image too large');
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { mime: 'image/svg+xml', bytesBase64: await bytesToBase64(bytes) };
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('image too large');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('png encode failed');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { mime: 'image/png', bytesBase64: await bytesToBase64(bytes) };
  } finally {
    bitmap.close();
  }
}
