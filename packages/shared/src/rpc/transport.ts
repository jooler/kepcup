/**
 * Transport-agnostic RPC channel. Implementations wrap Electron MessagePorts
 * (main <-> core, renderer <-> core) or in-process MessageChannels (tests).
 * Messages are plain JSON-serializable objects (structured clone).
 */
export interface RpcTransport {
  post(data: unknown): void;
  onData(handler: (data: unknown) => void): () => void;
  close?(): void;
}
