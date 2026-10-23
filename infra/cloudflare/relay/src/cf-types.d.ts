/**
 * 本地声明的最小 Cloudflare 类型(参照 registry 的 cf-types.d.ts):离线类型检查用,
 * 不安装 @cloudflare/workers-types。真实包可替换本文件:tsconfig 的 types 加上
 * `@cloudflare/workers-types` 后删除它。
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** DO 标识:idFromName(sid) 的产物,`.name` 回读会话 id。 */
interface DurableObjectId {
  readonly name?: string;
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** `durable_objects` 绑定 RELAY_SESSION 的命名空间子集。 */
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** hibernation API 子集(设计 §4.3:state.acceptWebSocket + tags)。 */
interface DurableObjectState {
  readonly id: DurableObjectId;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

/** `new WebSocketPair()`:[0] 返还给客户端,[1] 由 DO 接受。 */
declare const WebSocketPair: { new (): [WebSocket, WebSocket] };

/** Workers 的 101 响应可携带 webSocket(接口合并补进 DOM 的 ResponseInit)。 */
interface ResponseInit {
  webSocket?: WebSocket;
}

/** Workers 服务端 WebSocket 在 DOM WebSocket 之上的扩展(接口合并)。 */
interface WebSocket {
  accept(): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown | null;
}

/** `assets.binding`(ASSETS):Worker 侧主动取静态资产。 */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
