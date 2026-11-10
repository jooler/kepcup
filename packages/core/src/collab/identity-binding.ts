import { AppError, type RpcMethodSpec } from '@kepcup/shared';

/**
 * 逐连接的客户端身份绑定（D119/D120 审查修复）：presence、草稿租约、消息与
 * 审批归属都接受客户端自报的 clientId，宿主必须在连接上绑定首个身份，之后
 * 同一连接换身份即拒绝——否则同一设备可冒充另一个客户端（草稿租约、归属、
 * 审批竞争提示全部可伪造）。
 *
 * 只包裹携带客户端身份的方法；其它方法原样透传。
 */
const CLIENT_BOUND_METHODS = new Set([
  'collab.presence.update',
  'collab.presence.leave',
  'collab.draft.claim',
  'collab.draft.update',
  'collab.draft.release',
  'collab.draft.send',
  'messages.send',
  'approvals.decide',
]);

export interface ClientIdentityBinding {
  readonly boundClientId: string | null;
  bindClient(clientId: string, connectionId: string | null): void;
}

function identityOf(input: unknown): { clientId: string | null; connectionId: string | null } {
  if (input === null || typeof input !== 'object') {
    return { clientId: null, connectionId: null };
  }
  const record = input as {
    clientId?: unknown;
    connectionId?: unknown;
    client?: { id?: unknown };
  };
  const clientId =
    typeof record.clientId === 'string'
      ? record.clientId
      : typeof record.client?.id === 'string'
        ? record.client.id
        : null;
  const connectionId =
    typeof record.connectionId === 'string' && record.connectionId.length > 0
      ? record.connectionId
      : null;
  return { clientId, connectionId };
}

export function withClientIdentityBinding(
  methods: Record<string, RpcMethodSpec>,
  binding: ClientIdentityBinding,
): Record<string, RpcMethodSpec> {
  const wrapped: Record<string, RpcMethodSpec> = {};
  for (const [name, spec] of Object.entries(methods)) {
    if (!CLIENT_BOUND_METHODS.has(name)) {
      wrapped[name] = spec;
      continue;
    }
    wrapped[name] = {
      ...spec,
      handle: (input) => {
        const { clientId, connectionId } = identityOf(input);
        if (clientId !== null) {
          if (binding.boundClientId === null) {
            binding.bindClient(clientId, connectionId);
          } else if (binding.boundClientId !== clientId) {
            throw new AppError('INVALID_INPUT', '同一连接不能更换客户端身份');
          } else if (connectionId !== null) {
            binding.bindClient(clientId, connectionId);
          }
        }
        return spec.handle(input);
      },
    };
  }
  return wrapped;
}
