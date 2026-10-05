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
