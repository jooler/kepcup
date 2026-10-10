import type { RpcTransport } from '@kepcup/shared';

export function domPortToTransport(port: MessagePort): RpcTransport {
  return {
    post: (data) => port.postMessage(data),
    onData: (handler) => {
      const listener = (event: MessageEvent) => handler(event.data);
      port.addEventListener('message', listener);
      return () => port.removeEventListener('message', listener);
    },
    close: () => port.close(),
  };
}

/**
 * Whether a window message is the genuine core-port hand-over: from this very window (a sandboxed
 * iframe's `parent.postMessage` has another `source`), carrying the preload's secret nonce, with a port.
 */
export function isCorePortMessage(
  event: Pick<MessageEvent, 'data' | 'source' | 'ports'>,
  self: unknown,
  nonce: string,
): boolean {
  if (event.source !== self || event.ports.length === 0) return false;
  const data = event.data as { type?: unknown; nonce?: unknown } | null;
  return (
    data !== null &&
    typeof data === 'object' &&
    data.type === 'core-port' &&
    typeof data.nonce === 'string' &&
    data.nonce === nonce &&
    nonce.length > 0
  );
}
