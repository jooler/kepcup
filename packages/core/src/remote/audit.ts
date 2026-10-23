import { AsyncLocalStorage } from 'node:async_hooks';
import type { RemoteDeviceId } from '@kepcup/shared';

/**
 * 远程遥控动作的审计来源标记（D96 §5.3）：远程端点发起的审批、设置写入、任务
 * 取消等动作在审计 detail 里带 `source: 'remote:{deviceId}'`。来源随调用链传播
 * （AsyncLocalStorage）——Hub 给每个远程端点的 RPC handler 包一层 `withRemoteSource`，
 * 下游任何走 AuditService 的记录自动携带，不需要逐个 handler 传参。
 */

interface RemoteSource {
  deviceId: RemoteDeviceId;
}

const storage = new AsyncLocalStorage<RemoteSource>();

/** 在某个远程端点的调用上下文里执行 `task`（Hub 的 per-endpoint RPC 包装）。 */
export function withRemoteSource<T>(deviceId: RemoteDeviceId, task: () => T): T {
  return storage.run({ deviceId }, task);
}

/** 当前调用若来自远程端点，返回 `'remote:{deviceId}'`；本机调用返回 null。 */
export function currentRemoteSource(): string | null {
  const source = storage.getStore();
  return source === undefined ? null : `remote:${source.deviceId}`;
}
