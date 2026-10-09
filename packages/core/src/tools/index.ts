import { Type } from '@earendil-works/pi-ai';
import { AppError, TOOL_OUTPUT_MAX_CHARS, type Message } from '@kepcup/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { truncateToBudget } from '../agent/tokens.js';
import { renderMessageLine, type RenderMessageOptions } from '../agent/context/conversation.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { SecretsService } from '../domain/secrets.js';
import type { ToolGateway } from '../gateway/index.js';
import type { SandboxNetworkPolicy } from '../sandbox/types.js';
import type { ProjectRuntime } from '../project/service.js';
import type { GitRemoteOperation } from '../project/git-remote.js';
import { buildCodingTools } from './coding-tools.js';
import { buildMemoryTools, type MemoryToolFacade } from './memory-tools.js';
import { buildSetupTools, type SetupToolFacade } from './setup-tools.js';
import { buildWikiTools, type WikiToolFacade } from './wiki-tools.js';
import { buildScheduleTools, type ScheduleToolFacade } from './schedule-tools.js';
import { buildBrowserTools } from './browser.js';
import { buildImageTools, type MediaToolFacade } from './image-tools.js';
import { buildSpeechTools } from './speech-tools.js';
import { buildWebTools, type SearchToolFacade } from './web-tools.js';
import { buildSkillTools, type SkillInstallFacade } from './skill-tools.js';
import { readOnlyRefusal } from './read-only.js';
import { buildDelegateTools } from './delegate-tools.js';
import { buildButlerTools, buildListBotsTool, type ButlerToolFacade } from './butler-tools.js';
import { buildDelegationTools, type DelegationToolFacade } from './delegation-tools.js';
import { buildAskUserTool, buildTaskTools, type TaskToolFacade } from './task-tools.js';
import type { SubagentToolFacade } from '../agent/subagent.js';
import type { McpToolFacade } from '../mcp/tools.js';
import type { BrowserHostRpc } from '../browser/facade.js';
import type { FileReadState } from './fs-state.js';

export interface ResponseToolDeps {
  messages: MessagesService;
  attachments: AttachmentsService;
  runs: RunsService;
  secrets: SecretsService;
  renderOptions: RenderMessageOptions;
  gateway: ToolGateway;
  /** Created before tools run ("首次执行时创建"). */
  workspacePath: string;
  /** Bound project directory (null = none); base for relative paths + bash. */
  projectPath: string | null;
  /** Project runtime for lease / git remote tools (P04). */
  projects: ProjectRuntime;
  network: SandboxNetworkPolicy;
  /** Per-run read hashes; released when the run settles. */
  fsState: FileReadState;
  /** Called for every message the bot sends (output_message_ids + events). */
  onBotMessage: (message: Message) => void;
  /**
   * P05 group chains: validate mention_bot_ids, extend/create the chain and
   * deliver to the targets. Returns a suffix note for the tool result.
   */
  onMentionBots?: (mentionBotIds: string[], message: Message) => string;
  /**
   * P06 environment manager facade: request host-level tool installs.
   * Narrow interface so tools never touch the DB layer directly.
   */
  environment: EnvironmentToolFacade;
  /**
   * P07 memory domain (optional so stripped unit setups keep working); when
   * present the seven memory tools join the response toolset.
   */
  memory?: MemoryToolFacade | undefined;
  /** Trigger messages of the current run (memory evidence). */
  batchMessages?: Message[] | undefined;
  /**
   * P08 skills domain (optional in stripped unit setups): the create_skill
   * tool registers a skill_authoring background job.
   */
  skills?: SkillsToolFacade | undefined;
  /**
   * P09 wiki domain (optional in stripped unit setups): the read-only
   * wiki_search / wiki_read tools and the wiki_enqueue registration tool.
   */
  wiki?: WikiToolFacade | undefined;
  /**
   * P10 schedule domain (optional in stripped unit setups): the schedule /
   * list_schedules / cancel_schedule tools.
   */
  schedule?: ScheduleToolFacade | undefined;
  /**
   * P11 browser capability hosted by the main process (port B). Present in
   * the real core; tests may omit it (no browser_* tools are registered).
   */
  browser?: BrowserHostRpc | undefined;
  /**
   * 对话式新建（setup interview，UI 改版）：仅在 bots.setup_state =
   * 'interviewing' 时提供，注册 save_profile / finish_setup 两个专属工具。
   */
  setup?: SetupToolFacade | undefined;
  /**
   * 图像生成后端（docs/design/18-inline-setup.md）：present 时注册
   * generate_image 工具；未配置能力时工具返回 SETUP_REQUIRED，由
   * orchestrator 中断 run 并引导设置。
   */
  media?: MediaToolFacade | undefined;
  /**
   * 联网检索网关（docs/design/21-web-search.md）：present 时注册
   * web_search / web_fetch 工具；web_search 缺配置返回 SETUP_REQUIRED。
   */
  search?: SearchToolFacade | undefined;
  /**
   * 技能安装门面（docs/design/22-file-skill-routing.md）：present 时注册
   * install_skill 工具（预置轻授权 / 外部仓库扫描审批，均阻塞等用户决定）。
   */
  skillInstall?: SkillInstallFacade | undefined;
  /**
   * 宿主 SubAgent 门面（docs/design/23-mcp-and-subagent.md D66）：present 时
   * 注册 delegate_task 工具（嵌套减配子 run，结果压缩回传）。
   */
  subagent?: SubagentToolFacade | undefined;
  /**
   * MCP 工具（docs/design/23-mcp-and-subagent.md D65）：orchestrator 已按
   * 「应用 enabled ∩ Bot 选中」构建好的包装工具，直接注册。W5：任务拿全部已
   * 启用的工具；对话轮拿的是只读工具面（只读 + 有效审批 auto，≤
   * TURN_MCP_READ_TOOLS_MAX），由 orchestrator 选好。
   */
  mcp?: McpToolFacade | undefined;
  /**
   * 管家宿主（D70，docs/design/27-butler-and-delegation.md）：present 时所有
   * Bot 注册只读 list_bots；`isButler` 为真时再注册 propose_team /
   * propose_bot / propose_group。
   */
  butler?: { host: ButlerToolFacade; isButler: boolean } | undefined;
  /**
   * 跨 Bot 委派宿主（D71）：present 时注册 delegate_to_bot / cancel_delegation。
   * orchestrator 对 triggerReason='delegation' 的 run 不传（少给模型一个无用
   * 工具）；单跳的真正保障是宿主执行时按 run_id 反查。
   */
  delegation?: DelegationToolFacade | undefined;
  /**
   * 任务层（D75）：present 时对话轮注册 start_task / inject_task / cancel_task /
   * list_tasks / forward_task_result（任务内不注册：深度 1）。
   */
  tasks?: TaskToolFacade | undefined;
}

/**
 * Read-only file tools a supervisor turn keeps (design 30 §2.1 只读查询): no
 * write / edit, no bash — commands only run inside tasks.
 */
const TURN_FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'ls', 'find', 'grep']);

/** The slice of SkillsService the create_skill tool needs. */
export interface SkillsToolFacade {
  requestAuthoring(input: {
    botId: string;
    conversationId: string;
    name: string;
    description: string;
    reason: string;
  }): { ok: boolean; message: string };
}

/** The slice of EnvManager the request_environment tool needs. */
export interface EnvironmentToolFacade {
  request(
    identity: RunIdentity,
    input: { item: string; version?: string; reason: string },
  ): Promise<
    | { status: 'installed'; item: string; version: string; path: string; system: boolean }
    | { status: 'installing'; item: string }
    | { status: 'submitted'; item: string; approvalId: string }
  >;
  /** Catalog items offered on this platform (for the unknown-item listing). */
  offeredItems(): string[];
}

const TEXTUAL_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|sql))/;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

function guessMime(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Conversation-loop tools (docs/dev/04-agent-runtime.md "工具目录"), by loop
 * type (D75 design 30 §2.1 / §2.2):
 * - `turn` (supervisor turn, read-only): conversation core, read-only queries
 *   (message / attachment / run lookups, read / ls / find / grep), task
 *   management + forward_task_result, async hosted actions (delegate_to_bot,
 *   schedules, wiki ingest, memory candidates, skill authoring, butler
 *   proposals), web_search / web_fetch and read-only MCP tools (W5: risk
 *   `read` with effective approval `auto`, capped). No writes, commands,
 *   browser, media generation, other MCP tools, skill / environment installs,
 *   access requests or delegate_task — those are a task's work. (The gateway
 *   refuses writes of a turn at execution time as well — MCP calls are
 *   re-checked there too; this list only keeps useless tools away.)
 * - otherwise (a task): the full working toolset, minus what belongs to the
 *   turn (task management, cross-bot delegation, butler proposals).
 */
export function buildResponseTools(input: {
  identity: RunIdentity;
  deps: ResponseToolDeps;
}): ToolDefinition[] {
  const { identity, deps } = input;
  const { gateway } = deps;

  const isTask = identity.loopType === 'task';
  const sendMessage: ToolDefinition<{
    text: string;
    mention_bot_ids?: string[];
    reply_to?: string;
    attachment_paths?: string[];
  }> = {
    name: 'send_message',
    description:
      '在当前对话中发送一条消息（用于中途同步进展、确认收到）。最终回复无需调用本工具，直接结束即可。可通过 attachment_paths 附带 workspace 中的文件。',
    // A task cannot @ group members (D75 §6.2): the parameter is not offered.
    parameters: Type.Object({
      text: Type.String({ description: '要发送的消息内容' }),
      ...(isTask
        ? {}
        : {
            mention_bot_ids: Type.Optional(
              Type.Array(Type.String(), { description: '要 @ 的 Bot id（群聊）' }),
            ),
          }),
      reply_to: Type.Optional(Type.String({ description: '引用回复的消息 id' })),
      attachment_paths: Type.Optional(
        Type.Array(Type.String(), { description: '附件路径（workspace 内的文件）' }),
      ),
    }),
    execute: async (params) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前上下文没有对话，无法发送消息',
          errorCode: 'INVALID_INPUT',
        };
      }
      const uploaded = [];
      for (const filePath of params.attachment_paths ?? []) {
        // Only a path this run may read right now: a grantable one (outside the
        // workspace / project, sensitive locations) is never read and uploaded
        // without the user's approval (审查 pre-existing HIGH).
        const decision = gateway.checkPath(identity, filePath, 'read');
        if (decision.kind === 'forbidden') {
          return {
            ok: false,
            content: `附件不在可访问范围内：${filePath}（${decision.reason}）`,
            errorCode: 'PATH_OUT_OF_SCOPE',
          };
        }
        if (decision.kind !== 'allowed') {
          return {
            ok: false,
            content:
              identity.loopType === 'turn'
                ? `附件不在授权范围内：${filePath}（${decision.reason}）。需要发送它请派任务（start_task），在任务里先用 request_access 申请读取。`
                : `附件不在授权范围内：${filePath}（${decision.reason}）。先用 request_access 申请读取该路径，用户批准后再发送。`,
            errorCode: 'PATH_OUT_OF_SCOPE',
          };
        }
        try {
          const bytes = readFileSync(decision.resolvedPath);
          uploaded.push(
            deps.attachments.upload({
              conversationId: identity.conversationId,
              fileName: path.basename(filePath),
              mime: guessMime(filePath),
              bytes,
            }),
          );
        } catch (error) {
          return {
            ok: false,
            content: `读取附件失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
            errorCode: 'INVALID_INPUT',
          };
        }
      }
      // D75 §6.2: a task is no group member — it never @-mentions bots (no
      // chain either; chain budgets count turns only).
      const mentionIds = isTask ? [] : (params.mention_bot_ids ?? []);
      const message = deps.messages.append({
        conversationId: identity.conversationId,
        senderType: 'bot',
        senderBotId: identity.botId,
        kind: 'text',
        text: params.text,
        replyTo: params.reply_to ?? null,
        mentions: mentionIds,
        runId: identity.runId,
        // D75 §6.1: a task's messages are progress, attributed to the task.
        ...(isTask ? { taskOrigin: { taskId: identity.runId } } : {}),
      });
      if (uploaded.length > 0)
        deps.attachments.attachToMessage(
          uploaded.map((a) => a.id),
          message.id,
        );
      deps.onBotMessage(message);
      const note = uploaded.length > 0 ? `，附件 ${uploaded.length} 个` : '';
      const chainNote =
        mentionIds.length > 0 ? (deps.onMentionBots?.(mentionIds, message) ?? '') : '';
      return { ok: true, content: `已发送（消息 id：${message.id}${note}）${chainNote}` };
    },
  };

  const skipReply: ToolDefinition<{ reason: string }> = {
    name: 'skip_reply',
    description: '结束本次执行且不发送最终回复（例如已经有人回答、无需回应）。',
    parameters: Type.Object({
      reason: Type.String({ description: '不回复的原因' }),
    }),
    execute: async (params) => {
      void params;
      return { ok: true, content: '好的，本次执行结束，不发送回复。', terminate: true };
    },
  };

  // D75 §2.4.3 / §2.4.5: the conversation as this run's bot sees it — shared
  // rows plus its own private task_event rows; a task reads shared rows only
  // (it never sees its bot's other task round-trips). Message tools render
  // task entries in full: they are how the model fetches text the recent
  // window truncates.
  // (`string` widening: core's LoopType gains 'task' with the task layer, W1-A.)
  const viewerBotId = identity.loopType === 'task' ? null : identity.botId;

  const searchMessages: ToolDefinition<{ query: string; limit?: number }> = {
    name: 'search_messages',
    description: '按关键词搜索当前对话中的历史消息。',
    parameters: Type.Object({
      query: Type.String({ description: '关键词' }),
      limit: Type.Optional(Type.Number({ description: '返回条数上限，默认 20' })),
    }),
    execute: async (params) => {
      if (identity.conversationId === null) {
        return { ok: false, content: '没有可用对话', errorCode: 'INVALID_INPUT' };
      }
      const found = deps.messages.search(identity.conversationId, params.query, {
        viewerBotId,
        limit: Math.min(50, params.limit ?? 20),
      });
      if (found.length === 0) return { ok: true, content: '没有找到匹配的消息。' };
      const lines = found.map((m) => renderMessageLine(m, deps.renderOptions, 'full'));
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const getMessagesAround: ToolDefinition<{ message_id: string; n?: number }> = {
    name: 'get_messages_around',
    description: '获取某条消息前后各 N 条消息（N ≤ 20），用于了解上下文。',
    parameters: Type.Object({
      message_id: Type.String({ description: '消息 id' }),
      n: Type.Optional(Type.Number({ description: '前后各取几条，默认 5' })),
    }),
    execute: async (params) => {
      if (identity.conversationId === null) {
        return { ok: false, content: '没有可用对话', errorCode: 'INVALID_INPUT' };
      }
      const anchor = deps.messages.getById(params.message_id);
      if (
        !anchor ||
        anchor.conversationId !== identity.conversationId ||
        // Another bot's private row answers exactly like a missing one.
        (anchor.ownerBotId !== null && anchor.ownerBotId !== viewerBotId)
      ) {
        return { ok: false, content: '消息不存在或不属于当前对话', errorCode: 'NOT_FOUND' };
      }
      const n = Math.max(1, Math.min(20, Math.floor(params.n ?? 5)));
      const around = deps.messages.around(identity.conversationId, anchor.seq, n, viewerBotId);
      const lines = around.map((m) => renderMessageLine(m, deps.renderOptions, 'full'));
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const getAttachment: ToolDefinition<{ attachment_id: string }> = {
    name: 'get_attachment',
    description: '读取当前对话中的附件：文本类返回内容，其他类型复制到 workspace 并返回路径。',
    parameters: Type.Object({
      attachment_id: Type.String({ description: '附件 id（形如 att_...）' }),
    }),
    execute: async (params) => {
      if (identity.conversationId === null) {
        return { ok: false, content: '没有可用对话', errorCode: 'INVALID_INPUT' };
      }
      const attachment = deps.attachments.get(params.attachment_id);
      if (!attachment || attachment.conversationId !== identity.conversationId) {
        return { ok: false, content: '附件不存在或不属于当前对话', errorCode: 'NOT_FOUND' };
      }
      const bytes = deps.attachments.readBytes(attachment);
      if (TEXTUAL_MIME.test(attachment.mime)) {
        const truncated = truncateToBudget(bytes.toString('utf8'), TOOL_OUTPUT_MAX_CHARS);
        const suffix = truncated.truncated ? '\n[输出已截断]' : '';
        return {
          ok: true,
          content: `<untrusted>附件 ${attachment.fileName}：\n${deps.secrets.redact(truncated.text)}${suffix}</untrusted>`,
        };
      }
      // Non-textual: copy into the workspace so bash / read can use the file.
      // The copy is host-owned (D75): read-only runs may make it too, confined
      // to `.attachments/` (gateway.checkHostCopyPath).
      const targetDir = path.join(deps.workspacePath, '.attachments');
      const target = path.join(targetDir, `${attachment.id}_${attachment.fileName}`);
      const decision = gateway.checkHostCopyPath(identity, target, '.attachments');
      if (decision.kind === 'forbidden') {
        return {
          ok: false,
          content: `无法复制附件：${decision.reason}`,
          errorCode: decision.readOnlyRun === true ? 'RUN_READ_ONLY' : 'PATH_OUT_OF_SCOPE',
        };
      }
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(decision.resolvedPath, bytes);
      gateway.audit(identity, 'fs_write', { path: decision.resolvedPath, tool: 'get_attachment' });
      return {
        ok: true,
        content: `附件已复制到 workspace：${decision.resolvedPath}`,
      };
    },
  };

  const listMyRuns: ToolDefinition<Record<string, never>> = {
    name: 'list_my_runs',
    description: '查询自己在当前对话中的执行记录摘要。',
    parameters: Type.Object({}),
    execute: async () => {
      if (identity.conversationId === null || identity.botId === null) {
        return { ok: false, content: '没有可用对话', errorCode: 'INVALID_INPUT' };
      }
      const runs = deps.runs
        .listByConversation(identity.conversationId, 20)
        // D75: the bot's turns and tasks (a task's process is read via get_run).
        .filter(
          (r) => r.botId === identity.botId && (r.loopType === 'turn' || r.loopType === 'task'),
        );
      if (runs.length === 0) return { ok: true, content: '还没有执行记录。' };
      const lines = runs.map(
        (r) =>
          `${r.id} | ${r.loopType === 'task' ? `任务「${r.taskTitle ?? ''}」` : '对话轮'} | ${r.status} | ${r.triggerReason ?? '-'} | ${new Date(r.createdAt).toISOString()} | ${r.summary ?? r.error ?? ''}`,
      );
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const getRun: ToolDefinition<{ run_id: string }> = {
    name: 'get_run',
    description: '查看某次执行的步骤概要。',
    parameters: Type.Object({
      run_id: Type.String({ description: '执行 id（形如 run_...）' }),
    }),
    execute: async (params) => {
      const run = deps.runs.get(params.run_id);
      // Only this bot's own runs in this conversation (审查 L2): another
      // member's turns / tasks are its private process.
      if (
        !run ||
        run.conversationId !== identity.conversationId ||
        run.botId !== identity.botId
      ) {
        return { ok: false, content: '执行记录不存在', errorCode: 'RUN_NOT_FOUND' };
      }
      const steps = deps.runs.stepsFor(run.id);
      const lines = steps.map((s) => {
        const payload = s.payload as Record<string, unknown>;
        switch (s.type) {
          case 'tool_call':
            return `${s.seq}. 调用工具 ${payload['toolName']}`;
          case 'tool_result':
            return `${s.seq}. 工具返回（${payload['ok'] ? '成功' : '失败'}）`;
          case 'progress':
            return `${s.seq}. ${payload['text']}`;
          case 'assistant':
            return `${s.seq}. 模型输出（${payload['stopReason']}）`;
          default:
            return `${s.seq}. ${s.type}`;
        }
      });
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const requestAccess: ToolDefinition<{
    path: string;
    access: 'read' | 'write';
    reason: string;
  }> = {
    name: 'request_access',
    description:
      '申请访问 workspace 以外的文件或目录（读或写）。文件工具越界时也会自动发起授权；需要在批量操作前一次性申请时使用本工具。用户批准后授权立即生效；拒绝时你会收到拒绝结果，请调整做法。',
    parameters: Type.Object({
      path: Type.String({ description: '要访问的文件或目录（绝对路径或相对 workspace 的路径）' }),
      access: Type.Union([Type.Literal('read'), Type.Literal('write')], {
        description: '访问类型：read 只读，write 读写（包含读）',
      }),
      reason: Type.String({ description: '申请原因，会展示给用户' }),
    }),
    execute: async (params, ctx) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法申请授权',
          errorCode: 'INVALID_INPUT',
        };
      }
      if (params.access !== 'read' && params.access !== 'write') {
        return { ok: false, content: 'access 只能是 read 或 write', errorCode: 'INVALID_INPUT' };
      }
      try {
        const resolved = await gateway.ensurePathAccess(
          identity,
          params.path,
          params.access,
          params.reason,
          // D75：主动申请的「仅这一次」留给随后真正使用它的那次工具调用。
          { signal: ctx.signal, preauthorize: true },
        );
        return {
          ok: true,
          content: `用户已批准${params.access === 'write' ? '读写' : '读取'}：${resolved}`,
        };
      } catch (error) {
        if (error instanceof AppError && error.code === 'APPROVAL_DENIED') {
          return {
            ok: false,
            content: '用户拒绝或取消了该授权请求。请调整做法，例如改用 workspace 内的路径。',
            errorCode: 'APPROVAL_DENIED',
          };
        }
        if (error instanceof AppError && error.code === 'PATH_OUT_OF_SCOPE') {
          return { ok: false, content: error.message, errorCode: 'PATH_OUT_OF_SCOPE' };
        }
        throw error;
      }
    },
  };

  const requestUnsandboxed: ToolDefinition<{
    command: string;
    cwd?: string;
    reason: string;
  }> = {
    name: 'request_unsandboxed',
    description:
      '申请在沙箱外执行一条命令（例如需要调用 Docker、系统钥匙串等沙箱内不可用的能力）。每次执行都需要用户逐条确认，没有“一直允许”；沙箱外的改动不保证可以回退。',
    parameters: Type.Object({
      command: Type.String({ description: '要在沙箱外执行的完整命令' }),
      cwd: Type.Optional(
        Type.String({ description: '工作目录（必须在 workspace 内，默认 workspace）' }),
      ),
      reason: Type.String({ description: '执行原因，会展示给用户' }),
    }),
    execute: async (params, ctx) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法申请沙箱外执行',
          errorCode: 'INVALID_INPUT',
        };
      }
      let cwd: string | undefined;
      if (params.cwd !== undefined) {
        const decision = gateway.checkPath(identity, params.cwd, 'read');
        const base = deps.projectPath ?? deps.workspacePath;
        if (decision.kind !== 'allowed' || !decision.resolvedPath.startsWith(base)) {
          return {
            ok: false,
            content: 'cwd 必须位于当前 project 或 workspace 内',
            errorCode: 'INVALID_INPUT',
          };
        }
        cwd = decision.resolvedPath;
      }
      try {
        const result = await gateway.requestUnsandboxed(identity, params.command, params.reason, {
          signal: ctx.signal,
          cwd,
        });
        const body = [result.stdout, result.stderr]
          .filter((s) => s.length > 0)
          .join('\n')
          .trim();
        const redacted = deps.secrets.redact(body);
        const truncated = truncateToBudget(redacted, TOOL_OUTPUT_MAX_CHARS);
        const suffix = truncated.truncated ? '\n[输出已截断]' : '';
        return {
          ok: result.exitCode === 0,
          content: `<untrusted>命令已在沙箱外执行（退出码 ${result.exitCode ?? 'unknown'}）：\n${truncated.text || '（无输出）'}${suffix}</untrusted>`,
          ...(result.exitCode === 0 ? {} : { errorCode: 'COMMAND_FAILED' }),
        };
      } catch (error) {
        if (error instanceof AppError && error.code === 'APPROVAL_DENIED') {
          return {
            ok: false,
            content: '用户未批准沙箱外执行。请改用沙箱内可完成的方案。',
            errorCode: 'APPROVAL_DENIED',
          };
        }
        throw error;
      }
    },
  };

  const acquireProjectWrite: ToolDefinition<{ reason?: string }> = {
    name: 'acquire_project_write',
    description:
      '申请 project 写入租约。执行会改动 project 文件的命令（安装依赖、格式化等）前必须先调用；使用 write / edit 工具时会自动申请，无需重复调用。租约被其他执行持有时会排队等待。',
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: '申请原因，会展示给用户' })),
    }),
    execute: async (params, ctx) => {
      const project = deps.projects.boundProject(identity.conversationId);
      if (project === null) {
        return {
          ok: false,
          content: '当前对话未绑定 project，无需申请写入租约',
          errorCode: 'INVALID_INPUT',
        };
      }
      if (project.status === 'missing') {
        return {
          ok: false,
          content: `项目目录不存在（可能被移动或删除）：${project.path}`,
          errorCode: 'PROJECT_MISSING',
        };
      }
      try {
        await deps.projects.ensureWriteLease(identity, project.path, {
          signal: ctx.signal,
          reason: params.reason ?? '申请 project 写入租约',
        });
        return { ok: true, content: `已取得 ${project.name} 的写入租约，可以执行改动项目的命令。` };
      } catch (error) {
        if (error instanceof AppError && error.code === 'APPROVAL_DENIED') {
          return { ok: false, content: '执行已取消，未取得租约', errorCode: 'APPROVAL_DENIED' };
        }
        throw error;
      }
    },
  };

  const gitRemote: ToolDefinition<{
    operation: GitRemoteOperation;
    args?: string[];
    reason: string;
  }> = {
    name: 'git_remote',
    description:
      '申请执行 git 远程操作（push / pull / fetch / clone / remote_add / init）。这类操作无法在沙箱内完成：每次都需要用户确认，由应用在沙箱外调用系统 git（使用你本机已配置的凭据）。args 逐条给出命令行参数，不要包含 shell 引号或命令替换。',
    parameters: Type.Object({
      operation: Type.Union(
        ['push', 'pull', 'fetch', 'clone', 'remote_add', 'init'].map((op) => Type.Literal(op)),
        { description: 'git 子命令' },
      ),
      args: Type.Optional(
        Type.Array(Type.String(), { description: 'git 命令参数（如 remote 名称与 URL、分支名）' }),
      ),
      reason: Type.String({ description: '执行原因，会展示给用户' }),
    }),
    execute: async (params, ctx) => {
      const args = params.args ?? [];
      try {
        const result = await gateway.gitRemote(
          identity,
          { operation: params.operation, args, reason: params.reason },
          { signal: ctx.signal },
        );
        const redacted = deps.secrets.redact(result.output);
        const truncated = truncateToBudget(redacted, TOOL_OUTPUT_MAX_CHARS);
        const suffix = truncated.truncated ? '\n[输出已截断]' : '';
        return {
          ok: result.exitCode === 0,
          content: `<untrusted>git ${params.operation} 已在沙箱外执行（退出码 ${result.exitCode ?? 'unknown'}）：\n${truncated.text || '（无输出）'}${suffix}</untrusted>`,
          ...(result.exitCode === 0 ? {} : { errorCode: 'COMMAND_FAILED' }),
        };
      } catch (error) {
        if (error instanceof AppError) {
          const hints: Record<string, string> = {
            APPROVAL_DENIED: '用户拒绝或取消了该 git 远程操作。不要重试，改为询问用户。',
            GIT_CLI_MISSING: '本机未安装 git 命令行。请告知用户安装 git 后重试。',
            PROJECT_MISSING: '项目目录不存在，无法执行 git 操作。',
            INVALID_INPUT: '当前对话未绑定 project，无法执行 git 远程操作。',
          };
          return {
            ok: false,
            content: hints[error.code] ?? error.message,
            errorCode: error.code,
          };
        }
        throw error;
      }
    },
  };

  const requestEnvironment: ToolDefinition<{
    item: string;
    version?: string;
    reason: string;
  }> = {
    name: 'request_environment',
    description:
      '申请安装宿主层环境（所有 Bot 共享），例如 python、node、uv 或 git 命令行。用户批准后自动下载安装（或打开系统安装器），完成后你会收到事件通知，无需等待或轮询。安装到应用私有目录，不改动系统环境。可先调用本工具查询：已安装会直接返回路径。',
    parameters: Type.Object({
      item: Type.String({ description: '环境项名称，例如 python、node、uv、git' }),
      version: Type.Optional(
        Type.String({ description: '期望版本（当前固定使用目录版本，仅作提示）' }),
      ),
      reason: Type.String({ description: '申请原因，会展示给用户' }),
    }),
    execute: async (params) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法申请安装环境',
          errorCode: 'INVALID_INPUT',
        };
      }
      // Installs change the host environment shared by every bot.
      const readOnly = readOnlyRefusal(gateway, identity, '不能申请安装环境');
      if (readOnly !== null) return readOnly;
      try {
        const outcome = await deps.environment.request(identity, {
          item: params.item,
          ...(params.version !== undefined ? { version: params.version } : {}),
          reason: params.reason,
        });
        if (outcome.status === 'installed') {
          return {
            ok: true,
            content: `环境 ${outcome.item}（${outcome.version}）已可用，路径：${outcome.path}${outcome.system ? '（系统安装）' : ''}。可直接在命令中使用。`,
          };
        }
        if (outcome.status === 'installing') {
          return {
            ok: true,
            content: `环境 ${outcome.item} 正在安装中，完成后会通知你。`,
          };
        }
        return {
          ok: true,
          content: `已提交 ${outcome.item} 的安装申请（审批 id：${outcome.approvalId}），用户批准后会自动下载安装。批准、拒绝或安装完成/失败都会以事件通知你，无需等待或轮询；收到通知前请先做其他能做的部分。`,
        };
      } catch (error) {
        if (error instanceof AppError && error.code === 'ENV_ITEM_UNKNOWN') {
          const offered = deps.environment.offeredItems().join('、');
          return {
            ok: false,
            content: `${error.message}。可申请的项：${offered}`,
            errorCode: 'ENV_ITEM_UNKNOWN',
          };
        }
        if (error instanceof AppError && error.code === 'ENV_ITEM_UNSUPPORTED_PLATFORM') {
          return { ok: false, content: error.message, errorCode: error.code };
        }
        throw error;
      }
    },
  };

  const coding = buildCodingTools(identity, {
    gateway,
    workspacePath: deps.workspacePath,
    projectPath: deps.projectPath,
    network: deps.network,
    secrets: deps.secrets,
    fsState: deps.fsState,
  });

  // P07 memory tools (evidence = the triggering batch of this run).
  const memoryTools =
    deps.memory !== undefined
      ? buildMemoryTools({
          identity,
          memory: {
            ...deps.memory,
            triggerMessages: () => deps.batchMessages ?? [],
          },
        })
      : [];

  // P08 create_skill (docs/dev/04-agent-runtime.md 工具目录, R 列).
  const createSkill: ToolDefinition<{
    name: string;
    description: string;
    reason: string;
  }> = {
    name: 'create_skill',
    description:
      '登记一个技能生成任务（用户说“以后都这样做”或希望把某类重复工作沉淀为技能时使用）。后台技能生成 loop 会起草稿、验证（语法 + 沙箱跑测试），通过后自动启用并通知；失败时保留草稿不打扰用户。技能名只能用小写字母、数字和连字符。',
    parameters: Type.Object({
      name: Type.String({ description: '技能名（小写字母、数字、连字符，例如 deploy-check）' }),
      description: Type.String({ description: '一句话描述这个技能做什么、何时使用' }),
      reason: Type.String({ description: '为什么要沉淀这个技能（会帮助生成 loop 理解背景）' }),
    }),
    execute: async (params) => {
      if (identity.botId === null || identity.conversationId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法登记技能生成任务',
          errorCode: 'INVALID_INPUT',
        };
      }
      const outcome = deps.skills?.requestAuthoring({
        botId: identity.botId,
        conversationId: identity.conversationId,
        name: params.name,
        description: params.description,
        reason: params.reason,
      });
      if (outcome === undefined) {
        return { ok: false, content: '技能模块未就绪', errorCode: 'INTERNAL' };
      }
      return outcome.ok
        ? { ok: true, content: outcome.message }
        : { ok: false, content: outcome.message, errorCode: 'INVALID_INPUT' };
    },
  };

  // P09 wiki tools (docs/dev/04-agent-runtime.md 工具目录, R 列): read-only
  // towards the wiki + the enqueue registration.
  const wikiTools = deps.wiki !== undefined ? buildWikiTools({ identity, wiki: deps.wiki }) : [];

  // P10 schedule tools (docs/dev/04-agent-runtime.md 工具目录, R 列).
  const scheduleTools =
    deps.schedule !== undefined ? buildScheduleTools({ identity, schedule: deps.schedule }) : [];

  // P11 browser tools (docs/dev/04-agent-runtime.md 工具目录, R 列; access=network
  // — 公网默认可访问，网络规则在主进程的页面网络上下文中强制).
  const browserTools =
    deps.browser !== undefined
      ? buildBrowserTools({
          identity,
          browser: deps.browser,
          workspacePath: deps.workspacePath,
          projectPath: deps.projectPath,
          // D75: a page click can start a download; a read-only run's
          // downloads never land in the workspace.
          ...(gateway.writeDenial(identity) !== null
            ? { downloadsDir: gateway.readOnlyDownloadsDir(identity) }
            : {}),
        })
      : [];

  // 对话式新建（setup interview）：访谈期间才注册，正常运行的 Bot 不可见。
  const setupTools =
    deps.setup !== undefined
      ? buildSetupTools({
          identity,
          setup: deps.setup,
          variant: deps.butler?.isButler === true ? 'butler' : 'bot',
        })
      : [];

  // 图像/语音/视频生成与理解（docs/design/18-inline-setup.md、
  // 20-conversation-media.md、25-capability-tools.md）：媒体网关就绪才注册；
  // 未配置能力时工具返回 SETUP_REQUIRED，由 orchestrator 中断 run 并引导设置。
  const imageTools =
    deps.media !== undefined
      ? buildImageTools({
          identity,
          media: deps.media,
          workspacePath: deps.workspacePath,
          attachments: deps.attachments,
          gateway,
        })
      : [];
  const speechTools =
    deps.media !== undefined
      ? buildSpeechTools({
          identity,
          media: deps.media,
          workspacePath: deps.workspacePath,
          attachments: deps.attachments,
          gateway,
        })
      : [];

  // 联网检索（docs/design/21-web-search.md）：网关就绪才注册。
  const webTools = deps.search !== undefined ? buildWebTools({ search: deps.search }) : [];

  // 技能安装（docs/design/22-file-skill-routing.md）：门面就绪才注册。
  const skillTools =
    deps.skillInstall !== undefined
      ? buildSkillTools({ identity, skills: deps.skillInstall, gateway })
      : [];

  // 宿主 SubAgent（docs/design/23-mcp-and-subagent.md D66）：门面就绪才注册。
  const delegateTools =
    deps.subagent !== undefined ? buildDelegateTools({ identity, subagent: deps.subagent }) : [];

  // MCP 工具（docs/design/23-mcp-and-subagent.md D65）：orchestrator 已解析
  // 并按工具面选好（W5：对话轮只有只读 + 免审批的那部分）。
  const mcpTools = deps.mcp?.tools ?? [];

  // 跨 Bot 委派（D71）：异步转交给另一个联系人 Bot。
  const delegationTools =
    deps.delegation !== undefined
      ? buildDelegationTools({ identity, delegation: deps.delegation })
      : [];

  // 管家（D70）：list_bots 人人可用（只读名片），提议类工具仅管家。
  const butlerTools =
    deps.butler !== undefined
      ? [
          buildListBotsTool({ identity, butler: deps.butler.host }),
          ...(deps.butler.isButler ? buildButlerTools({ identity, butler: deps.butler.host }) : []),
        ]
      : [];

  if (identity.loopType === 'turn') {
    const taskTools =
      deps.tasks !== undefined ? buildTaskTools({ identity, tasks: deps.tasks }) : [];
    return [
      sendMessage,
      skipReply,
      searchMessages,
      getMessagesAround,
      getAttachment,
      listMyRuns,
      getRun,
      ...coding.filter((tool) => TURN_FILE_TOOLS.has(tool.name)),
      ...taskTools,
      ...memoryTools,
      ...(deps.skills !== undefined ? [createSkill] : []),
      ...wikiTools,
      ...scheduleTools,
      ...webTools,
      ...delegationTools,
      ...butlerTools,
      // W5: read-only MCP tools (call-time re-check in the gateway).
      ...mcpTools,
      ...setupTools,
    ];
  }

  return [
    sendMessage,
    skipReply,
    searchMessages,
    getMessagesAround,
    getAttachment,
    listMyRuns,
    getRun,
    requestAccess,
    requestUnsandboxed,
    acquireProjectWrite,
    gitRemote,
    requestEnvironment,
    ...coding,
    ...memoryTools,
    ...(deps.skills !== undefined ? [createSkill] : []),
    ...wikiTools,
    ...scheduleTools,
    ...browserTools,
    ...imageTools,
    ...speechTools,
    ...webTools,
    ...skillTools,
    ...delegateTools,
    // §2.4.6: a task asks the user on a question card bound to it.
    ...(identity.loopType === 'task' && deps.tasks?.ask !== undefined
      ? [buildAskUserTool({ identity, ask: deps.tasks.ask.bind(deps.tasks) })]
      : []),
    // Tasks keep list_bots (read-only cards); routing to other bots and the
    // butler's proposals are the turn's (design 30 §1.2).
    ...(deps.butler !== undefined ? [buildListBotsTool({ identity, butler: deps.butler.host })] : []),
    ...mcpTools,
    ...setupTools,
  ];
}

/** Shared no-op result helper for tests. */
export function emptyToolResult(): ToolResult {
  return { ok: true, content: '' };
}

/**
 * Subagent 减配研究工具集（D66）：read/grep/find/ls + 沙箱 bash + 联网检索 +
 * 只读 MCP 工具（W5：只读 + 有效审批 auto，≤ TURN_MCP_READ_TOOLS_MAX，按子
 * run 身份包装好的 `mcp`）。无 write / edit（避免与主 run 的 project 写租约竞
 * 争）、无 send_message / delegate_task（禁止再委派）、无 memory / schedule /
 * browser / skills 工具。
 */
export function buildSubagentResearchTools(input: {
  identity: RunIdentity;
  deps: Pick<
    ResponseToolDeps,
    'gateway' | 'workspacePath' | 'projectPath' | 'network' | 'secrets' | 'fsState' | 'search' | 'mcp'
  >;
}): ToolDefinition[] {
  const coding = buildCodingTools(
    input.identity,
    {
      gateway: input.deps.gateway,
      workspacePath: input.deps.workspacePath,
      projectPath: input.deps.projectPath,
      network: input.deps.network,
      secrets: input.deps.secrets,
      fsState: input.deps.fsState,
    },
    { excludeWriteTools: true },
  );
  const web = input.deps.search !== undefined ? buildWebTools({ search: input.deps.search }) : [];
  return [...coding, ...web, ...(input.deps.mcp?.tools ?? [])];
}
