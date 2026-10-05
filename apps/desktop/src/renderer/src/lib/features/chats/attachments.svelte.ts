import type { Attachment } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 消息附件字节的渲染层缓存（docs/design/20-conversation-media.md）：
 * attachments.get 的 base64 → Blob → objectURL，按附件 id 做 LRU
 * （消息气泡与灯箱共用，避免同一次会话里重复拉取同一份字节）。
 */

const MAX_ENTRIES = 64;

// 普通 Map（刻意非响应式）：这只是字节缓存，没有任何界面从 Map 本身派生；
// 响应式 Map 会被 track 它的 effect/模板表达式观察到，而 attachmentUrl 在
// 缓存命中路径同步 delete+set 触碰 LRU——effect 因此自我失效无限重跑
// （渲染层主线程被 relayout 打满，见 P17 调试记录）。
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const urls = new Map<string, string>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const pending = new Map<string, Promise<string>>();

function evict(): void {
  while (urls.size > MAX_ENTRIES) {
    const oldest = urls.keys().next().value;
    if (oldest === undefined) break;
    urls.delete(oldest);
    // objectURL 由浏览器 GC 收敛；显式 revoke 会与正在渲染的 <img> 竞争，
    // 消息流体量下（64 条）泄漏可忽略。
  }
}

export function cachedAttachmentUrl(attachmentId: string): string | null {
  const hit = urls.get(attachmentId);
  if (hit !== undefined) {
    // 触碰以保持 LRU 顺序。
    urls.delete(attachmentId);
    urls.set(attachmentId, hit);
    return hit;
  }
  return null;
}

export async function attachmentUrl(attachment: Attachment): Promise<string> {
  const cached = cachedAttachmentUrl(attachment.id);
  if (cached !== null) return cached;
  const inflight = pending.get(attachment.id);
  if (inflight !== undefined) return inflight;
  const load = (async (): Promise<string> => {
    const result = (await core.call('attachments.get', { id: attachment.id })) as {
      dataBase64: string;
    };
    // atob 手动解码（CSP 的 connect-src 不含 data:，fetch data URL 会被拦）；
    // 产物是同源 blob URL（img-src/media-src 已放行 blob:）。
    const binary = atob(result.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
    urls.set(attachment.id, url);
    evict();
    return url;
  })();
  pending.set(attachment.id, load);
  try {
    return await load;
  } finally {
    pending.delete(attachment.id);
  }
}

/** 触发浏览器下载（blob URL + <a download>，无需主进程参与）。 */
export async function downloadAttachment(attachment: Attachment): Promise<void> {
  const url = await attachmentUrl(attachment);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = attachment.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
