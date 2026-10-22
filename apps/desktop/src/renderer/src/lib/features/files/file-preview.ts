import { core } from '$lib/rpc/client.svelte';

/** `files.preview` payload (read-only bytes of one Bot-written local file). */
export interface FilePreviewPayload {
  path: string;
  name: string;
  mime: string;
  size: number;
  dataBase64: string;
}

export async function loadFilePreview(
  conversationId: string,
  path: string,
): Promise<FilePreviewPayload> {
  return (await core.call('files.preview', { conversationId, path })) as FilePreviewPayload;
}

export function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeBase64Text(dataBase64: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(dataBase64));
  } catch {
    return '';
  }
}

export function base64ObjectUrl(dataBase64: string, mime: string): string {
  return URL.createObjectURL(new Blob([base64ToBytes(dataBase64)], { type: mime }));
}

export function base64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const bytes = base64ToBytes(dataBase64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
