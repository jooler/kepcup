/**
 * 最小 SSE 解析（契约 v0.1 §3.3）：按空行分帧，读 event + data。
 * 不依赖 EventSource（Node / Electron 主进程皆可用 ReadableStream）。
 */

export interface SseFrame {
  event: string;
  data: string;
}

/** 把一块文本拆成完整帧；返回剩余未成帧缓冲。 */
export function consumeSseBuffer(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const sep = rest.search(/\r?\n\r?\n/);
    if (sep < 0) break;
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep).replace(/^\r?\n\r?\n/, '');
    const frame = parseSseBlock(raw);
    if (frame !== null) frames.push(frame);
  }
  return { frames, rest };
}

function parseSseBlock(block: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
      continue;
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** 从 Response.body 逐帧回调；body 为空时抛错。 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = consumeSseBuffer(buffer);
      buffer = rest;
      for (const frame of frames) await onFrame(frame);
    }
    buffer += decoder.decode();
    const { frames } = consumeSseBuffer(buffer + '\n\n');
    for (const frame of frames) await onFrame(frame);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
