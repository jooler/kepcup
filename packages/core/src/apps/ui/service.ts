import type { CallToolResult, Tool as McpTool } from '@earendil-works/pi-mcp';
import { Type, validateToolArguments } from '@earendil-works/pi-ai';
import {
  AppError,
  MCP_APP_CALL_ARGS_MAX_CHARS,
  MCP_APP_CALL_RESULT_MAX_CHARS,
  MCP_APP_CARD_TYPE,
  MCP_APP_INPUT_MAX_CHARS,
  MCP_APP_RESOURCES_MAX,
  MCP_APP_RESOURCE_TTL_MS,
  MCP_APP_RESULT_MAX_CHARS,
  MCP_APP_SCHEME,
  appLoopbackKey,
  appUiCardSchema,
  isToolVisibleToApp,
  mcpAppResourceUriOf,
  type AppUiCard,
  type AppUiToolResult,
  type AppsUiOpenOutput,
  type McpServer,
  type Message,
} from '@kepcup/shared';
import type { RunIdentity } from '../../agent/types.js';
import type { Clock } from '../../infra/clock.js';
import type { McpService } from '../../mcp/service.js';
import type { AppToolContext } from '../exposure.js';
import { parseUiResource } from './resource.js';
import { UiResourceStore, appUiHostFor } from './store.js';

/**
 * MCP Apps 渲染服务（D73 P3 §7.5，设计 29 §11.6；spike 与安全结论见 todo/connected-apps.md 附录 B.7）。
 *
 * - {@link McpAppUiService.onToolResult}：包装后的 MCP 工具成功返回、且工具定义（或结果）带
 *   `_meta.ui.resourceUri` 时，在对话里发一张 `mcp_app` 卡片消息。**模型看不到任何变化**——卡片内容
 *   不含 HTML、令牌，也不回灌上下文（`renderCard` 只给一行固定文案）。
 * - {@link McpAppUiService.open}：卡片挂载时调用，经所属 MCP 连接 `resources/read` 取 `ui://` HTML，
 *   校验后登记成内存资源，返回 iframe 地址。
 * - {@link McpAppUiService.callTool}：界面发起的 `tools/call`——只允许同一 server 的、`_meta.ui.visibility`
 *   显式含 `app` 的工具；走与模型调用相同的网关 `mcpToolCall`（审批卡 / 授权 / 风险 / 污点外发 /
 *   工具锁定），身份为 `loopType: 'host'`（这是用户发起的动作，不受对话轮只读限制）。
 * - {@link McpAppUiService.openLink}：只接受 https 链接，经主进程 `shell.openExternal`（白名单再核一次）。
 */

/** 网关的最小面（`ToolGateway` 满足它）。 */
export interface UiGatewayPort {
  mcpToolCall(
    identity: RunIdentity,
    server: { id: string; name: string },
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      connection?: AppToolContext;
      openWorldHint?: boolean | undefined;
      origin?: 'app_ui';
    },
  ): Promise<unknown>;
  markAppTaint(identity: RunIdentity): void;
}

export interface McpAppUiDeps {
  mcp: Pick<McpService, 'serverFor' | 'listTools' | 'readResource' | 'callTool' | 'toolApproved'>;
  gateway: UiGatewayPort;
  messages: {
    append(input: {
      conversationId: string;
      senderType: 'system';
      kind: 'card';
      cardType: string;
      cardAppUi: AppUiCard;
      runId?: string | null;
    }): Message;
    getById(id: string): Message | null;
  };
  publishMessage(message: Message): void;
  /** 目录连接的工具上下文（审批卡的账号 / 应用名）；自定义 server 为 undefined。 */
  appContextFor?: ((serverId: string) => AppToolContext | undefined) | undefined;
  /**
   * 该 server 是否允许显示 MCP Apps 界面（缺省 = 允许）。本机连接 / `developer` 分级的条目声明
   * `ui: false`：它们返回的 HTML 不可信，core 不发卡、不取资源、不服务页面（评审 A4）。
   */
  uiAllowed?: ((serverId: string) => boolean) | undefined;
  secrets: { redact(text: string): string };
  shell: { openExternal(input: { url: string }): Promise<{ ok: boolean }> };
  clock: Clock;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
}

/** wrapMcpTool 在工具成功返回后交给服务的事实（均来自 MCP 连接，不来自模型）。 */
export interface UiToolResultInput {
  identity: RunIdentity;
  server: McpServer;
  app?: AppToolContext | undefined;
  tool: McpTool;
  args: Record<string, unknown>;
  result: CallToolResult;
}

/** 一个 run 最多发这么多张界面卡，防止循环刷屏。 */
const CARDS_PER_RUN_MAX = 8;

/** 本机开发 server 的 `host:port`（回环地址才有；CSP 回环来源只接受它）；其余 null。 */
function loopbackOriginOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const host = new URL(raw).hostname;
    const loopback =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host === '::1' ||
      /^127\.\d+\.\d+\.\d+$/.test(host);
    return loopback ? appLoopbackKey(raw) : null;
  } catch {
    return null;
  }
}

/** 脱敏 + 截断一个工具结果（只留文本块与结构化内容；图片 / 二进制块不带入界面）。 */
export function toUiToolResult(
  result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>,
  redact: (text: string) => string,
  maxChars: number,
): AppUiToolResult {
  let budget = maxChars;
  let truncated = false;
  const content: Array<{ type: 'text'; text: string }> = [];
  for (const block of result.content ?? []) {
    // The tool already ran: a malformed block from the server must not turn that into a failure.
    if (
      block === null ||
      typeof block !== 'object' ||
      block.type !== 'text' ||
      typeof (block as { text?: unknown }).text !== 'string'
    ) {
      continue;
    }
    const text = redact((block as { text: string }).text);
    if (text.length > budget) {
      truncated = true;
      if (budget > 0) content.push({ type: 'text', text: text.slice(0, budget) });
      budget = 0;
      break;
    }
    content.push({ type: 'text', text });
    budget -= text.length;
  }
  let structuredContent: Record<string, unknown> | undefined;
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    try {
      const json = redact(JSON.stringify(result.structuredContent));
      if (json.length <= Math.max(0, budget)) {
        structuredContent = JSON.parse(json) as Record<string, unknown>;
      } else {
        truncated = true;
      }
    } catch {
      truncated = true;
    }
  }
  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export class McpAppUiService {
  readonly #deps: McpAppUiDeps;
  readonly store: UiResourceStore;
  readonly #cardsByRun = new Map<string, number>();

  constructor(deps: McpAppUiDeps, store?: UiResourceStore) {
    this.#deps = deps;
    this.store =
      store ??
      new UiResourceStore({
        clock: deps.clock,
        ttlMs: MCP_APP_RESOURCE_TTL_MS,
        max: MCP_APP_RESOURCES_MAX,
      });
  }

  // --- 工具结果 → 卡片 -------------------------------------------------------

  /**
   * 工具成功返回后调用（`mcp/tools.ts`）。绝不抛错、绝不影响工具结果：任何失败只记 warn。
   * 返回发出的卡片消息（没有 UI 资源 / 无会话 / 超出每 run 上限则 null）。
   */
  onToolResult(input: UiToolResultInput): Message | null {
    try {
      return this.#emitCard(input);
    } catch (error) {
      this.#deps.logger.warn(
        {
          serverId: input.server.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'mcp app card failed',
      );
      return null;
    }
  }

  #emitCard(input: UiToolResultInput): Message | null {
    const { identity, server, tool, result } = input;
    if (result.isError === true) return null;
    const resourceUri = mcpAppResourceUriOf(tool._meta) ?? mcpAppResourceUriOf(result._meta);
    if (resourceUri === null) return null;
    if (this.#deps.uiAllowed?.(server.id) === false) return null;
    if (identity.conversationId === null) return null;
    const emitted = this.#cardsByRun.get(identity.runId) ?? 0;
    if (identity.runId !== '' && emitted >= CARDS_PER_RUN_MAX) return null;
    if (identity.runId !== '') {
      if (this.#cardsByRun.size > 1000) this.#cardsByRun.clear();
      this.#cardsByRun.set(identity.runId, emitted + 1);
    }
    const redact = (text: string): string => this.#deps.secrets.redact(text);
    const argsJson = redact(JSON.stringify(input.args));
    let toolInput: Record<string, unknown> = {};
    let inputTruncated = false;
    if (argsJson.length > MCP_APP_INPUT_MAX_CHARS) {
      inputTruncated = true;
    } else {
      try {
        toolInput = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        inputTruncated = true;
      }
    }
    const rawTitle = tool.title ?? tool.annotations?.title ?? tool.name;
    const card: AppUiCard = {
      serverId: server.id,
      appName: redact(input.app?.appName ?? server.name).slice(0, 120),
      botId: identity.botId,
      resourceUri,
      title: redact(rawTitle).slice(0, 120),
      toolName: tool.name,
      toolInput,
      toolResult: toUiToolResult(result, redact, MCP_APP_RESULT_MAX_CHARS),
      ...(inputTruncated ? { inputTruncated: true } : {}),
    };
    const message = this.#deps.messages.append({
      conversationId: identity.conversationId,
      senderType: 'system',
      kind: 'card',
      cardType: MCP_APP_CARD_TYPE,
      cardAppUi: card,
      ...(identity.runId !== '' ? { runId: identity.runId } : {}),
    });
    this.#deps.publishMessage(message);
    return message;
  }

  // --- 卡片挂载：登记资源 -------------------------------------------------------

  /** 卡片消息里的描述符（校验过；不是 `mcp_app` 卡则抛 NOT_FOUND）。 */
  cardOf(messageId: string): { message: Message; card: AppUiCard } {
    const message = this.#deps.messages.getById(messageId);
    const content = message?.content as { cardType?: unknown; appUi?: unknown } | undefined;
    if (
      message === null ||
      message.kind !== 'card' ||
      content?.cardType !== MCP_APP_CARD_TYPE ||
      content.appUi === undefined
    ) {
      throw new AppError('NOT_FOUND', '找不到这张应用卡片');
    }
    const parsed = appUiCardSchema.safeParse(content.appUi);
    if (!parsed.success) throw new AppError('APP_UI_INVALID', '应用卡片的内容已损坏');
    return { message, card: parsed.data };
  }

  #liveServer(serverId: string): McpServer {
    const server = this.#deps.mcp.serverFor(serverId);
    if (server === undefined || !server.enabled) {
      throw new AppError('APP_UI_EXPIRED', '这个应用已断开或被停用，请重新连接后再试');
    }
    if (this.#deps.uiAllowed?.(serverId) === false) {
      throw new AppError('APP_UI_INVALID', '这个应用（未审核的本机连接）不允许显示界面');
    }
    return server;
  }

  /** 取 HTML、校验、登记，返回渲染端挂载 iframe 所需的信息。 */
  async open(
    input: { messageId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<AppsUiOpenOutput> {
    const { message, card } = this.cardOf(input.messageId);
    const server = this.#liveServer(card.serverId);
    const read = await this.#deps.mcp.readResource(server, card.resourceUri, options);
    const parsed = parseUiResource(read, card.resourceUri, {
      loopbackOrigin: loopbackOriginOf(server.url),
    });
    const entry = this.store.put({
      serverId: server.id,
      messageId: message.id,
      conversationId: message.conversationId,
      botId: card.botId,
      toolName: card.toolName,
      resourceUri: card.resourceUri,
      html: parsed.html,
      csp: parsed.csp,
    });
    const appTools = await this.#appToolNames(server);
    return {
      resourceId: entry.id,
      url: `${MCP_APP_SCHEME}://${entry.host}/${entry.id}`,
      title: card.title,
      appName: card.appName,
      ...(parsed.prefersBorder !== undefined ? { prefersBorder: parsed.prefersBorder } : {}),
      connectDomains: parsed.connectDomains,
      resourceDomains: parsed.resourceDomains,
      ignored: parsed.ignored,
      deniedPermissions: parsed.deniedPermissions,
      toolInput: card.toolInput,
      toolResult: card.toolResult,
      appTools,
    };
  }

  close(resourceId: string): void {
    this.store.remove(resourceId);
  }

  async #appToolNames(server: McpServer): Promise<string[]> {
    try {
      const tools = await this.#deps.mcp.listTools(server, { countFailure: false });
      return tools
        .filter(
          (tool) =>
            isToolVisibleToApp(tool._meta) && this.#deps.mcp.toolApproved(server, tool.name),
        )
        .map((tool) => tool.name);
    } catch {
      return [];
    }
  }

  // --- 协议处理器取页面（平台方法 apps.ui.resource） -----------------------------

  /** 主进程协议处理器取已登记的页面：id 存在、未过期、host 匹配、所属应用仍在线。 */
  resource(input: { resourceId: string; host: string }): { html: string; csp: string } {
    const entry = this.store.get(input.resourceId);
    if (
      entry === undefined ||
      entry.host !== input.host ||
      entry.host !== appUiHostFor(entry.serverId)
    ) {
      throw new AppError('NOT_FOUND', '应用界面资源不存在或已过期');
    }
    this.#liveServer(entry.serverId);
    return { html: entry.html, csp: entry.csp };
  }

  // --- 界面发起的 tools/call -----------------------------------------------------

  async callTool(
    input: { resourceId: string; toolName: string; arguments: Record<string, unknown> },
    options: { signal?: AbortSignal } = {},
  ): Promise<AppUiToolResult> {
    const entry = this.store.get(input.resourceId);
    if (entry === undefined) {
      throw new AppError('APP_UI_EXPIRED', '应用界面已过期，请重新打开这张卡片');
    }
    let server = this.#liveServer(entry.serverId);
    const argsJson = JSON.stringify(input.arguments);
    if (argsJson.length > MCP_APP_CALL_ARGS_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', '工具参数过大');
    }
    const release = this.store.tryAcquireCall(entry.id);
    if (release === null) {
      throw new AppError('APP_UI_RATE_LIMITED', '应用界面调用工具过于频繁，请稍后再试');
    }
    let releaseSlot: (() => void) | null = null;
    // Cancelled with the resource (closed / expired / evicted / server gone) and with the caller.
    const signal =
      options.signal !== undefined
        ? AbortSignal.any([options.signal, entry.abort.signal])
        : entry.abort.signal;
    try {
      // 只允许同一 server、定义里显式声明 `visibility` 含 `app` 且已通过复核的工具。
      const tools = await this.#deps.mcp.listTools(server, { countFailure: false, signal });
      const tool = tools.find((candidate) => candidate.name === input.toolName);
      if (
        tool === undefined ||
        !isToolVisibleToApp(tool._meta) ||
        !this.#deps.mcp.toolApproved(server, input.toolName)
      ) {
        throw new AppError(
          'APP_UI_TOOL_NOT_ALLOWED',
          `应用界面不能调用工具 ${input.toolName.slice(0, 80)}（该工具没有声明对界面开放）`,
        );
      }
      // The user just said no to this tool on this card: do not raise another card for 30 s.
      if (this.store.isToolLocked(entry.id, input.toolName)) {
        throw new AppError(
          'APP_UI_RATE_LIMITED',
          '用户刚刚拒绝了这个操作，稍后再试（已暂时不再询问）',
        );
      }
      releaseSlot = this.store.tryAcquireConversationSlot(entry.conversationId);
      if (releaseSlot === null) {
        throw new AppError(
          'APP_UI_RATE_LIMITED',
          '这个对话里待处理的应用界面操作过多，请先处理已有的确认',
        );
      }
      // The same argument validation / coercion a model-initiated call gets before it executes.
      const args = this.#validatedArgs(tool, input.arguments);
      const identity: RunIdentity = {
        runId: '',
        botId: entry.botId,
        conversationId: entry.conversationId,
        loopType: 'host',
      };
      const context = this.#deps.appContextFor?.(server.id);
      // 与模型调用同一条审批路径（策略 / 风险档 / 污点外发 / 工具停用），但来源是应用界面：写入类
      // 一律要人点（无人值守也不自动批准）、不认持续授权、只给「仅这一次」。
      try {
        await this.#deps.gateway.mcpToolCall(identity, server, input.toolName, args, {
          signal,
          origin: 'app_ui',
          ...(context !== undefined ? { connection: context } : {}),
          openWorldHint: tool.annotations?.openWorldHint,
        });
      } catch (error) {
        if (entry.abort.signal.aborted) {
          throw new AppError('APP_UI_EXPIRED', '应用界面已关闭，操作已取消');
        }
        if (error instanceof AppError && error.code === 'APPROVAL_DENIED') {
          this.store.lockDeniedTool(entry.id, input.toolName);
          return {
            content: [{ type: 'text', text: '用户拒绝了这次调用' }],
            isError: true,
          };
        }
        throw error;
      }
      // A long approval wait may outlive the card / the connection: nothing runs for a stale page.
      if (entry.abort.signal.aborted || this.store.get(entry.id) !== entry) {
        throw new AppError('APP_UI_EXPIRED', '应用界面已关闭，操作未执行');
      }
      server = this.#liveServer(entry.serverId);
      const result = await this.#deps.mcp.callTool(server, input.toolName, args, { signal });
      if (context !== undefined && result.isError !== true)
        this.#deps.gateway.markAppTaint(identity);
      return toUiToolResult(
        result,
        (text) => this.#deps.secrets.redact(text),
        MCP_APP_CALL_RESULT_MAX_CHARS,
      );
    } finally {
      releaseSlot?.();
      release();
    }
  }

  #validatedArgs(tool: McpTool, args: Record<string, unknown>): Record<string, unknown> {
    try {
      return validateToolArguments(
        {
          name: tool.name,
          description: tool.description ?? '',
          parameters: Type.Unsafe({
            ...tool.inputSchema,
            type: 'object',
            properties: tool.inputSchema['properties'] ?? {},
          }) as never,
        },
        { type: 'toolCall', id: 'app_ui', name: tool.name, arguments: args as never },
      ) as Record<string, unknown>;
    } catch (error) {
      throw new AppError(
        'INVALID_INPUT',
        `工具参数不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- 外链 ---------------------------------------------------------------------

  async openLink(input: { resourceId: string; url: string }): Promise<{ ok: boolean }> {
    if (this.store.get(input.resourceId) === undefined) {
      throw new AppError('APP_UI_EXPIRED', '应用界面已过期，请重新打开这张卡片');
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false };
    }
    // 只放行 https（回环 http 由主进程白名单另行放行，应用界面不需要）；不带凭据。
    if (
      url.protocol !== 'https:' ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return { ok: false };
    }
    return this.#deps.shell.openExternal({ url: url.toString() });
  }
}
