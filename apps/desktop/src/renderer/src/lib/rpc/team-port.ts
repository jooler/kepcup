/**
 * 团队连接端口交接消息的校验（T7，62.08 §3 桌面融合视图）。
 *
 * 主进程的团队桥接（team-bridge）把团队服务器的 RPC 帧通道经 window message
 * 交给渲染层：`{type:'team-port', nonce, serverHash, activeMemberId}` + MessagePort。校验与
 * core-port（`isCorePortMessage`，preload ↔ 渲染层的同构先例）完全同口径：
 * 必须来自本窗口（沙箱 iframe 的 `parent.postMessage` 的 `source` 不同）、带
 * preload 的秘密 nonce、且附端口；在此基础上还要求 `serverHash` 是非空字符串
 * （多团队服务器并存时端口按 hash 归属）。
 */
export function isTeamPortMessage(
  event: Pick<MessageEvent, 'data' | 'source' | 'ports'>,
  self: unknown,
  nonce: string,
): boolean {
  if (event.source !== self || event.ports.length === 0) return false;
  const data = event.data as {
    type?: unknown;
    nonce?: unknown;
    serverHash?: unknown;
    activeMemberId?: unknown;
  } | null;
  return (
    data !== null &&
    typeof data === 'object' &&
    data.type === 'team-port' &&
    typeof data.nonce === 'string' &&
    data.nonce === nonce &&
    nonce.length > 0 &&
    typeof data.serverHash === 'string' &&
    data.serverHash.length > 0 &&
    (data.activeMemberId === null ||
      (typeof data.activeMemberId === 'string' && data.activeMemberId.length > 0))
  );
}
