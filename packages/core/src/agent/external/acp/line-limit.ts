import type { AcpByteChannel } from './client.js';

/**
 * Agent stdout 单行字节上限（D118）：ACP SDK 的 `ndJsonStream` 把一整行缓冲进
 * 内存再解析、没有任何长度上限——行为异常（或流损坏）的 Agent 可以让宿主内存
 * 无界增长。这里透传字节、按 `\n` 计数（不缓存整行，内存常数），单行超限即
 * `onLimit()` 并 error 掉流：连接随之关闭，宿主按进程退出处理（活跃 run 失败，
 * 保持的会话下个 run 恢复）。shim 通道是进程内内存管道，不经过这层。
 */
export function limitAgentLines(
  readable: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): ReadableStream<Uint8Array> {
  let sinceNewline = 0;
  let limited = false;
  return readable.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (limited) return;
        // Count bytes since the last newline; a line split across chunks
        // accumulates until its terminator arrives (or the limit trips).
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk[i] === 0x0a) {
            sinceNewline = 0;
            continue;
          }
          sinceNewline += 1;
          if (sinceNewline > maxBytes) {
            limited = true;
            onLimit();
            controller.error(new Error(`agent stdout line exceeded ${maxBytes} bytes`));
            return;
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Wraps a process byte channel's stdout with the line limit (D118). */
export function limitChannelLines(
  channel: AcpByteChannel,
  maxBytes: number,
  onLimit: () => void,
): AcpByteChannel {
  return {
    readable: limitAgentLines(channel.readable, maxBytes, onLimit),
    writable: channel.writable,
  };
}
