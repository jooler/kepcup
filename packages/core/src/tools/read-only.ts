import type { RunIdentity, ToolResult } from '../agent/types.js';
import type { ToolGateway } from '../gateway/index.js';

/**
 * D75 §2.1 / §5.1: tools whose side effect bypasses the gateway's path check
 * (host-side writes into the workspace, installs) refuse up front for a
 * read-only run — supervisor turn, `writes: false` task, or a sub run owned by
 * one — with RUN_READ_ONLY and the readable reason plus what was refused.
 * Null when the run may write.
 */
export function readOnlyRefusal(
  gateway: Pick<ToolGateway, 'writeDenial'>,
  identity: RunIdentity,
  refused: string,
): ToolResult | null {
  const denial = gateway.writeDenial(identity);
  if (denial === null) return null;
  return { ok: false, content: `${denial}（${refused}）`, errorCode: 'RUN_READ_ONLY' };
}
