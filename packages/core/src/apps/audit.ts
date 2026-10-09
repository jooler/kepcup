/**
 * 连接应用的审计（D73，todo §4.9）：`app_connect` / `app_disconnect` 写入 `audit_log`。
 * 明细**只含** connectionId / connector / issuer / scopes（及断开时是否吊销成功等布尔
 * 结果），一律经 `redact` 后落库；绝不放令牌、授权码、client secret、完整授权 URL。
 */

export const APP_AUDIT_ACTIONS = {
  connect: 'app_connect',
  disconnect: 'app_disconnect',
  toolsReview: 'app_tools_review',
} as const;

/** `audit_log` 写入口（无 run 身份：连接 / 断开由用户在界面发起）。 */
export interface AppAuditSink {
  recordSystem(action: string, detail: Record<string, unknown>): void;
}

export interface AppConnectAuditInput {
  connectionId: string;
  /** 连接器标识（自定义 server 为 `custom:{serverId}`）。 */
  connectorId: string;
  issuer: string | null;
  scopes: string[];
}

export interface AppDisconnectAuditInput extends AppConnectAuditInput {
  /** RFC 7009 吊销是否成功（缺 `revocation_endpoint` 时两者均为 false）。 */
  revoked: { refresh: boolean; access: boolean };
  /** `mcp.removeServer` 连带删除了连接行。 */
  removed: boolean;
}

export interface AppToolsReviewAuditInput {
  connectionId: string;
  connectorId: string;
  /** 本次批准的工具名。 */
  approved: string[];
}

export class AppAuditor {
  readonly #sink: AppAuditSink;
  readonly #redact: (text: string) => string;

  constructor(deps: { sink: AppAuditSink; redact: (text: string) => string }) {
    this.#sink = deps.sink;
    this.#redact = deps.redact;
  }

  /** 交互授权完成（连接 / 重新连接 / 追加权限）时调用。 */
  auditAppConnect(input: AppConnectAuditInput): void {
    this.#write(APP_AUDIT_ACTIONS.connect, {
      connectionId: input.connectionId,
      connector: input.connectorId,
      issuer: input.issuer,
      scopes: input.scopes,
    });
  }

  auditAppDisconnect(input: AppDisconnectAuditInput): void {
    this.#write(APP_AUDIT_ACTIONS.disconnect, {
      connectionId: input.connectionId,
      connector: input.connectorId,
      issuer: input.issuer,
      scopes: input.scopes,
      revoked: input.revoked,
      removed: input.removed,
    });
  }

  /** 工具复核通过（首连确认 / 设置页复核 / 自定义 server 测试后保存）。 */
  auditAppToolsReview(input: AppToolsReviewAuditInput): void {
    this.#write(APP_AUDIT_ACTIONS.toolsReview, {
      connectionId: input.connectionId,
      connector: input.connectorId,
      approved: input.approved,
    });
  }

  #write(action: string, detail: Record<string, unknown>): void {
    const redacted = JSON.parse(this.#redact(JSON.stringify(detail))) as Record<string, unknown>;
    this.#sink.recordSystem(action, redacted);
  }
}
