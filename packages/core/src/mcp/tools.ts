import { Type } from '@earendil-works/pi-ai';
import { toLlmContent, type Tool as McpTool } from '@earendil-works/pi-mcp';
import {
  TOOL_OUTPUT_MAX_CHARS,
  TURN_MCP_READ_TOOLS_MAX,
  type AppAuthReason,
  type McpServer,
  type SetupRequirement,
} from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { ToolGateway } from '../gateway/index.js';
import type { SecretsService } from '../domain/secrets.js';
import { mcpToolName, type McpService } from './service.js';
import { classifyRiskDetailed } from './risk.js';
import { allowedOnReadOnlySurface, decideMcpTool, type McpToolDecision } from './policy.js';
import { findAppAuthRequiredError } from '../apps/auth/errors.js';
import { customConnectionId } from '../apps/connection-store.js';
import { toolLockKey, type LockedToolInfo } from '../apps/tool-lock.js';
import type { AppServerBinding, AppToolContext } from '../apps/exposure.js';
import { appToolName } from '../apps/naming.js';
import { TOOL_SETUP_REQUIRED } from '../tools/image-tools.js';

/**
 * MCP tool → KepCup ToolDefinition 包装（D65）：调用与内置工具同管道——
 * 审批（网关 mcpToolCall：tool policy > server autoApprove > 风险档默认）、
 * 审计、结果 `<untrusted>` 包裹 + 脱敏 + 截断、图片块走 ToolResult.images。
 *
 * W5：两种工具面——任务（全部已启用的工具）与只读工具面（对话轮 / 只读子
 * 代理：只放风险 read 且有效审批 auto 的工具，最多 TURN_MCP_READ_TOOLS_MAX
 * 个）。`enabled:false` 的工具两边都不注册。调用时网关重新解析风险与策略。
 */

/** wrapMcpTool 命中授权问题时的回调：orchestrator 写进本 run 的 `setupHit`。 */
export type McpSetupRequiredHandler = (requirement: SetupRequirement) => void;

export interface McpToolFacade {
  /** Orchestrator 预先解析并构建好的 MCP 包装工具（ready to register）。 */
  readonly tools: ToolDefinition[];
  /**
   * 只读工具面上没放进来的已启用 MCP 工具数（非只读 / 需确认 / 超出上限）；
   * > 0 时对话轮系统提示说明「更多 MCP 工具在任务中可用」。任务面恒为 0。
   */
  readonly omitted?: number;
}

/**
 * 因授权问题本次没能列出工具的 server（D73）：run 开头 listTools 遇到
 * `AppAuthRequiredError` 时收集（不再只记日志）——工具不暴露，但提示词的
 * `<connected_apps>` 标为「需重新连接」，模型可调用 `app_request_connection`。
 */
export interface McpUnavailableServer {
  serverId: string;
  serverName: string;
  connectionId: string;
  reason: AppAuthReason;
  scopes?: string[] | undefined;
}

/**
 * 工具定义锁定（D73 P1）：某 server 本次因「新增 / 定义变化、尚未复核」而没有暴露的工具。
 * 提示词 / 界面据此提示「应用有 N 个工具待复核」（本期不改提示词文案）。
 */
export interface McpLockedServer {
  serverId: string;
  serverName: string;
  /** 锁定行所属的连接 id（`custom:{serverId}` / `conn_…`）。 */
  connectionId: string;
  tools: LockedToolInfo[];
}

/**
 * 暴露过滤（D73 P1，`ToolLockService.partition`）：`serverKey` 是锁定行的连接 id；返回
 * 允许暴露的工具与被锁定的工具。在包装（去重、风险分级）之前应用。
 */
export type McpToolFilter = (
  serverKey: string,
  tools: McpTool[],
) => { exposed: McpTool[]; locked: LockedToolInfo[] };

export interface McpToolResolution {
  entries: McpToolEntry[];
  unavailable: McpUnavailableServer[];
  /** 工具锁定拦下的工具（无锁定或全部已批准时为空数组）。 */
  locked: McpLockedServer[];
}

/** 一个已解析的 MCP 工具：所属 server、原始定义、模型侧名字与构建时的决定。 */
export interface McpToolEntry {
  server: McpServer;
  tool: McpTool;
  name: string;
  decision: McpToolDecision;
  /** D73：目录连接的工具带连接上下文（审批载荷、审计、命名 `app_{slug}_{tool}`）。 */
  app?: AppToolContext | undefined;
}

/**
 * 列出各 server 的工具（懒连接 + 缓存），去重并跳过 `enabled:false`。单个
 * server 连不上不拖垮整个 run：跳过并在 mcp.server_status 事件里可见。
 */
export async function resolveMcpToolEntries(input: {
  servers: McpServer[];
  mcp: McpService;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
  /**
   * 连接失败是否计入重连预算（默认 true = 任务）。对话轮传 false：对话轮每轮
   * 都会解析，不能把任务的预算耗光。
   */
  countFailures?: boolean;
  /** D73 P1：工具定义锁定过滤（缺省 = 不过滤）。 */
  toolFilter?: McpToolFilter | undefined;
  /**
   * D73 P1 命名 / 决定选项：目录连接合成的 server 返回绑定——工具名用
   * `appToolName(slug, tool)`（`app_{slug}_{tool}`），风险与审批由绑定给出（W5 分级 + 目录
   * 叠加 + 用户逐工具策略）。返回 undefined 的 server（自定义 MCP）保持 `mcp_{serverId}_{tool}`
   * 与 W5 分级，行为不变。
   */
  appBindingFor?: ((server: McpServer) => AppServerBinding | undefined) | undefined;
}): Promise<McpToolResolution> {
  const { servers, mcp, logger } = input;
  const entries: McpToolEntry[] = [];
  const unavailable: McpUnavailableServer[] = [];
  const locked: McpLockedServer[] = [];
  const taken = new Set<string>();
  for (const server of servers) {
    let tools;
    try {
      tools = await mcp.listTools(server, { countFailure: input.countFailures ?? true });
    } catch (error) {
      const authError = findAppAuthRequiredError(error);
      if (authError !== null) {
        // 授权问题不是故障：不暴露该 server 的工具，但要让模型知道需要重新连接。
        unavailable.push({
          serverId: server.id,
          serverName: server.name,
          connectionId: authError.connectionId,
          reason: authError.reason,
          ...(authError.scopes !== undefined ? { scopes: authError.scopes } : {}),
        });
        continue;
      }
      logger.warn(
        { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
        'mcp server unavailable; skipping its tools',
      );
      continue;
    }
    if (input.toolFilter !== undefined) {
      const key = toolLockKey(server);
      const filtered = input.toolFilter(key, tools);
      tools = filtered.exposed;
      if (filtered.locked.length > 0) {
        locked.push({
          serverId: server.id,
          serverName: server.name,
          connectionId: key,
          tools: filtered.locked,
        });
      }
    }
    const binding = input.appBindingFor?.(server);
    for (const tool of tools) {
      const decision =
        binding !== undefined
          ? binding.decide(tool)
          : decideMcpTool(
              server,
              tool.name,
              classifyRiskDetailed({ name: tool.name, annotations: tool.annotations }),
            );
      if (!decision.enabled) continue;
      let name =
        binding !== undefined
          ? appToolName(binding.connectorSlug, tool.name)
          : mcpToolName(server.id, tool.name);
      // sanitize 之后撞名（`a.b` / `a_b`）：应用工具用哈希后缀消歧；自定义 MCP 保持跳过。
      if (taken.has(name) && binding !== undefined) {
        name = appToolName(binding.connectorSlug, tool.name, { disambiguate: true });
      }
      if (taken.has(name)) {
        logger.warn({ name, serverId: server.id }, 'duplicate mcp tool name; skipping');
        continue;
      }
      taken.add(name);
      entries.push({
        server,
        tool,
        name,
        decision,
        ...(binding !== undefined
          ? {
              app: {
                connectionId: binding.connectionId,
                connectorId: binding.connectorId,
                connectorSlug: binding.connectorSlug,
                accountLabel: binding.accountLabel,
                appName: binding.appName,
              },
            }
          : {}),
      });
    }
  }
  return { entries, unavailable, locked };
}

/**
 * 只读工具面（对话轮 / 只读子代理）的工具：只读且有效审批为 auto（被用户改成
 * ask 的只读工具不进——对话轮是秒级的，不在对话轮里等审批），按 server 顺序取
 * 前 `max` 个。`omitted` = 其余已启用工具数。
 */
export function selectReadOnlyMcpEntries(
  entries: McpToolEntry[],
  max: number = TURN_MCP_READ_TOOLS_MAX,
): { entries: McpToolEntry[]; omitted: number } {
  const eligible = entries.filter((entry) => allowedOnReadOnlySurface(entry.decision));
  const selected = eligible.slice(0, Math.max(0, max));
  return { entries: selected, omitted: entries.length - selected.length };
}

/** 为某个 run 身份包装已解析的工具。 */
export function wrapMcpToolEntries(input: {
  identity: RunIdentity;
  entries: McpToolEntry[];
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
  onSetupRequired?: McpSetupRequiredHandler | undefined;
}): ToolDefinition[] {
  const { identity, entries, mcp, gateway, secrets, onSetupRequired } = input;
  return entries.map((entry) =>
    wrapMcpTool({
      identity,
      server: entry.server,
      tool: entry.tool,
      name: entry.name,
      decision: entry.decision,
      app: entry.app,
      mcp,
      gateway,
      secrets,
      onSetupRequired,
    }),
  );
}

/**
 * 解析 + 包装。`surface: 'readOnly'` 只取只读工具面的工具（对话轮 / 只读子
 * 代理）；默认 'task' 取全部已启用工具。
 */
export async function buildMcpTools(input: {
  identity: RunIdentity;
  servers: McpServer[];
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
  surface?: 'task' | 'readOnly';
  onSetupRequired?: McpSetupRequiredHandler | undefined;
  /** D73 P1：工具定义锁定过滤，每个 server 的工具在包装前先过它。 */
  toolFilter?: McpToolFilter | undefined;
  /** D73 P1：目录连接 server 的命名 / 决定绑定（见 `resolveMcpToolEntries`）。 */
  appBindingFor?: ((server: McpServer) => AppServerBinding | undefined) | undefined;
}): Promise<{
  tools: ToolDefinition[];
  unavailable: McpUnavailableServer[];
  locked: McpLockedServer[];
}> {
  const { entries: all, unavailable, locked } = await resolveMcpToolEntries(input);
  const entries = input.surface === 'readOnly' ? selectReadOnlyMcpEntries(all).entries : all;
  return { tools: wrapMcpToolEntries({ ...input, entries }), unavailable, locked };
}

function wrapMcpTool(input: {
  identity: RunIdentity;
  server: McpServer;
  tool: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> };
  name: string;
  decision: McpToolDecision;
  app?: AppToolContext | undefined;
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
  onSetupRequired?: McpSetupRequiredHandler | undefined;
}): ToolDefinition {
  const { identity, server, tool, name, decision, app, mcp, gateway, secrets, onSetupRequired } =
    input;
  const riskLabel =
    decision.risk === 'read' ? '只读' : decision.risk === 'write' ? '写入' : '可能有破坏性';
  return {
    name,
    // W2: the effect ledger classifies by this risk (and the live one).
    mcp: { serverId: server.id, toolName: tool.name, risk: decision.risk },
    description:
      (app !== undefined
        ? `应用工具（来自「${app.appName}」，账号 ${app.accountLabel}，${riskLabel}）：`
        : `MCP 工具（来自服务器「${server.name}」，${riskLabel}）：`) +
      `${tool.description ?? tool.title ?? tool.name}。` +
      (decision.approval === 'auto' ? '调用无需用户批准。' : '调用会请求用户批准。'),
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      type: 'object',
      properties: tool.inputSchema.properties ?? {},
    }),
    execute: async (params, ctx): Promise<ToolResult> => {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        await gateway.mcpToolCall(identity, server, tool.name, args, {
          signal: ctx.signal,
          ...(app !== undefined ? { connection: app } : {}),
        });
      } catch (error) {
        return gatewayMcpErrorResult(error);
      }
      let result;
      try {
        result = await mcp.callTool(server, tool.name, args, { signal: ctx.signal });
      } catch (error) {
        // D73：授权失效 / 需追加权限 → 记下 connect-app 需求（orchestrator 写入 setupHit，
        // 既有 abort → failed + run.setup → 卡片 → runs.retry 链路），工具结果 SETUP_REQUIRED。
        const authError = findAppAuthRequiredError(error);
        if (authError !== null) {
          onSetupRequired?.({
            kind: 'connect-app',
            target:
              app !== undefined
                ? { kind: 'catalog', connectorId: app.connectorId }
                : { kind: 'custom', serverId: server.id },
            connectionId:
              app !== undefined
                ? app.connectionId
                : authError.connectionId || customConnectionId(server.id),
            reason: authError.reason,
            ...(authError.scopes !== undefined ? { scopes: authError.scopes } : {}),
          });
          return {
            ok: false,
            content: `需要重新连接「${server.name}」：${authError.reason === 'scope' ? '该应用需要追加权限' : '授权已失效或尚未连接'}。请告知用户在设置中重新连接；连接完成后本次请求会自动继续，不要让用户粘贴令牌。`,
            errorCode: TOOL_SETUP_REQUIRED,
          };
        }
        return {
          ok: false,
          content: `MCP 调用失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: error instanceof Error && 'code' in error ? String(error.code) : 'MCP_CALL_FAILED',
          // W2: the request may have reached the server before the transport /
          // timeout failed — the ledger keeps it as uncertain (safe side).
          effect: { outcome: 'uncertain' },
        };
      }
      const content = toLlmContent(result);
      const textParts: string[] = [];
      const images: Array<{ mimeType: string; base64: string }> = [];
      for (const block of content) {
        if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
          textParts.push((block as { text: string }).text);
        } else if (block.type === 'image') {
          const image = block as { data?: string; mimeType?: string };
          if (image.data !== undefined && image.mimeType !== undefined) {
            images.push({ base64: image.data, mimeType: image.mimeType });
          }
        } else {
          textParts.push(`（${block.type} 内容已省略）`);
        }
      }
      const redacted = secrets.redact(textParts.join('\n'));
      const truncated = truncateToBudget(redacted, TOOL_OUTPUT_MAX_CHARS);
      const suffix = truncated.truncated ? '\n[输出已截断]' : '';
      // W4 回执：结构化结果（或纯 JSON 文本）里现成的链接 / id，只进台账
      // （记录器再做敏感值擦除与 secrets 脱敏），审批卡据此显示「已完成」的回执。
      const receipt = result.isError === true ? null : mcpReceiptOf(result, textParts);
      return {
        ok: result.isError !== true,
        content: `<untrusted>\n${truncated.text || '（无输出）'}${suffix}\n</untrusted>`,
        ...(images.length > 0 ? { images } : {}),
        ...(result.isError === true ? { errorCode: 'MCP_CALL_FAILED' } : {}),
        ...(receipt !== null ? { effect: { receipt } } : {}),
      };
    },
  };
}

/** Receipt keys looked up at the top level of the result object (W4). */
const RECEIPT_URL_KEYS = ['url', 'html_url', 'web_url', 'permalink', 'link', 'htmlUrl', 'webUrl'];
const RECEIPT_ID_KEYS = ['id', 'message_id', 'messageId', 'issue_id', 'number', 'ts', 'uuid'];
/** Id-shaped: no whitespace, ≤ 64 chars (W4 复查 S3). */
const RECEIPT_ID_MAX_CHARS = 64;
/** Typical secret / token prefixes — never shown as a receipt. */
const SECRET_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abposr]-?|AKIA|ASIA|AIza|ya29\.|eyJ)/i;

/**
 * Whether a receipt id looks like an id and not like a credential: no
 * whitespace, ≤ 64 chars, no well-known secret prefix, and not a long
 * high-entropy string (> 32 chars mixing upper, lower and digits).
 */
export function receiptIdShaped(value: string): boolean {
  if (value.length === 0 || value.length > RECEIPT_ID_MAX_CHARS || /\s/.test(value)) return false;
  if (SECRET_PREFIX.test(value)) return false;
  if (value.length > 32 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) {
    return false;
  }
  return true;
}

/** A receipt URL without its query string / fragment (tokens often live there). */
function receiptUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}
/** A text result larger than this is not parsed for a receipt. */
const RECEIPT_TEXT_PARSE_MAX_CHARS = 64 * 1024;

/**
 * W4: a cheap receipt from an MCP tool result — the URL / id the server
 * already returns at the top level of `structuredContent`, or of the only
 * text block when it is a JSON object. Nothing found → null (the status alone
 * is the receipt). Server-supplied: the recorder scrubs and bounds it, the
 * card shows it as text, the model only sees it inside `<untrusted>`.
 */
export function mcpReceiptOf(
  result: { structuredContent?: Record<string, unknown> },
  textParts: readonly string[],
): { url?: string; externalId?: string } | null {
  let source: Record<string, unknown> | null =
    result.structuredContent !== undefined && result.structuredContent !== null
      ? result.structuredContent
      : null;
  if (source === null && textParts.length === 1) {
    const text = textParts[0]!.trim();
    if (text.startsWith('{') && text.length <= RECEIPT_TEXT_PARSE_MAX_CHARS) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          source = parsed as Record<string, unknown>;
        }
      } catch {
        source = null;
      }
    }
  }
  if (source === null) return null;
  const pick = (
    keys: readonly string[],
    accept: (value: string) => string | null,
  ): string | null => {
    for (const key of keys) {
      const value = source![key];
      const text =
        typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
      const accepted = text !== null && text.length > 0 ? accept(text) : null;
      if (accepted !== null) return accepted;
    }
    return null;
  };
  const url = pick(RECEIPT_URL_KEYS, receiptUrl);
  const externalId = pick(RECEIPT_ID_KEYS, (value) => (receiptIdShaped(value) ? value : null));
  if (url === null && externalId === null) return null;
  return {
    ...(url !== null ? { url } : {}),
    ...(externalId !== null ? { externalId } : {}),
  };
}

/** 审批环节的错误映射（拒绝要可继续，模型能调整做法）。 */
function gatewayMcpErrorResult(error: unknown): ToolResult {
  const code = (error as { code?: string })?.code;
  // W5：只读工具面上调用时已不再是「只读 + 免审批」，或工具已被停用。
  if (code === 'RUN_READ_ONLY' || code === 'MCP_TOOL_NOT_FOUND') {
    return {
      ok: false,
      content: error instanceof Error ? error.message : String(error),
      errorCode: code,
    };
  }
  if (code === 'APPROVAL_DENIED') {
    return {
      ok: false,
      content: '用户拒绝或取消了该 MCP 工具调用的审批。不要反复重试；调整做法或询问用户。',
      errorCode: 'APPROVAL_DENIED',
    };
  }
  return {
    ok: false,
    content: `MCP 调用审批失败：${error instanceof Error ? error.message : String(error)}`,
    errorCode: typeof code === 'string' ? code : 'INTERNAL',
  };
}
