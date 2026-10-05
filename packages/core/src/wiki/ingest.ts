import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, WIKI_SOURCE_MAX_BYTES } from '@kepcup/shared';

import { botWikiRawDir, botWikiRoot } from '../infra/paths.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import type { MessagesService } from '../domain/messages.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { Orchestrator } from '../dispatch/orchestrator.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { Clock } from '../infra/clock.js';
import { initWiki } from './init.js';
import { openRepository } from 'es-git';
import { fetchUrlInSandbox, findRawByHash, shortHash, rawFileName } from './source.js';
import { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js';
import { inlineTextFor, runWikiMaintenance, type WikiMaintenanceDeps } from './maintenance.js';
import { JOB_MAX_ATTEMPTS } from '../domain/jobs.js';

export interface WikiIngestJobDeps extends WikiMaintenanceDeps {
  sandbox: SandboxBackend;
  conversations: ConversationsService;
  messages: MessagesService;
  attachments: AttachmentsService;
  jobs: JobsService;
  orchestrator: Orchestrator;
  publish: (event: string, payload: unknown) => void;
  clock: Clock;
  job: JobRow;
}

export interface IngestOutcome {
  skipped: boolean;
  rawRelPath: string | null;
  conversationId: string | null;
  changedPages: string[];
}

/**
 * Wiki ingest job (任务 3): resolve the source (attachment copy / workspace or
 * project file copy within access range / sandboxed URL fetch), store the raw
 * material under `raw/` (dated + content-hashed file name, same-hash skip),
 * run the maintenance loop, commit once and update wiki_fts. 入库是 Bot 自己
 * 的知识库整理：成功不出现在对话里（只有 wiki_ingested / wiki_changed 总线
 * 事件驱动 UI），终态失败才以 internal 事件触发 Bot 用自己的话向用户交代。
 * The whole flow is serialized per bot through the wiki service mutex.
 */
export async function runWikiIngestJob(deps: WikiIngestJobDeps): Promise<void> {
  const { job } = deps;
  if (job.bot_id === null) {
    throw new AppError('INVALID_INPUT', 'wiki ingest requires a bot');
  }
  const botId = job.bot_id;
  const bot = deps.bots.get(botId);
  if (bot === null || bot.status !== 'active') return; // deleted mid-queue

  const payload = JSON.parse(job.payload_json) as {
    sourceType?: string;
    ref?: string;
    note?: string;
  };
  const sourceType = payload.sourceType;
  if (sourceType !== 'attachment' && sourceType !== 'url' && sourceType !== 'file') {
    throw new AppError('INVALID_INPUT', `未知的入库来源类型：${String(sourceType)}`);
  }
  const ref = payload.ref ?? '';
  const note = payload.note ?? '';

  // Conversation may have been deleted between enqueue and now; the
  // notification falls back to the bot's direct chat (authoring precedent).
  const triggerConversationId =
    job.conversation_id !== null && deps.conversations.get(job.conversation_id) !== null
      ? job.conversation_id
      : null;

  let outcome: IngestOutcome;
  try {
    outcome = await deps.wiki.runExclusively(botId, async () => {
      await initWiki(deps.paths, botId, deps.logger);
      const root = botWikiRoot(deps.paths, botId);
      const rawDir = botWikiRawDir(deps.paths, botId);

      // --- resolve the source into raw bytes --------------------------------
      const source = await resolveSource(deps, { botId, conversationId: triggerConversationId, sourceType, ref });

      // --- raw/ (append-only): dated + hashed name, same-hash skip ----------
      const hash12 = shortHash(source.bytes);
      const existing = findRawByHash(rawDir, hash12);
      let rawName = existing;
      if (rawName === null) {
        rawName = rawFileName(new Date(deps.clock.now()), hash12, source.name);
        writeFileSync(path.join(rawDir, rawName), source.bytes);
        deps.logger.info({ botId, rawFile: rawName, bytes: source.bytes.length }, 'wiki raw stored');
      } else {
        // Same content already present. Skipped only when a previous
        // maintenance already committed it; an uncommitted leftover (a failed
        // attempt) is reused so the retry still produces the pages.
        const committed = await isRawCommitted(root, `raw/${rawName}`);
        if (committed) {
          deps.logger.info({ botId, rawFile: rawName }, 'wiki ingest skipped: same source hash');
          const fallbackConversation =
            triggerConversationId ?? deps.conversations.openDirect(botId).conversation.id;
          deps.publish('wiki_ingested', {
            botId,
            conversationId: fallbackConversation,
            rawPath: `raw/${rawName}`,
            skipped: true,
          });
          deps.publish('wiki_changed', { botId });
          return {
            skipped: true,
            rawRelPath: `raw/${rawName}`,
            conversationId: fallbackConversation,
            changedPages: [],
          } satisfies IngestOutcome;
        }
      }

      // --- maintenance loop ---------------------------------------------------
      const maintenance = await runWikiMaintenance(deps, {
        kind: 'ingest',
        input: {
          botId,
          conversationId: triggerConversationId,
          sourceDescription: source.description,
          note,
          rawRelPath: `raw/${rawName}`,
          inlineText: inlineTextFor(source.mime, source.bytes, source.converted),
        },
      });

      // --- 入库完成（任务 3）-------------------------------------------------
      // 入库是 Bot 自己的知识库整理（docs/design/01-conversation.md 消息原则）：
      // 成功不产生对话消息、不触发回应 run——之后 wiki_search 直接可用。UI 状态
      // 由下面的 wiki_ingested / wiki_changed 总线事件驱动。
      const targetConversation =
        triggerConversationId ?? deps.conversations.openDirect(botId).conversation.id;
      deps.publish('wiki_ingested', {
        botId,
        conversationId: targetConversation,
        rawPath: `raw/${rawName}`,
        skipped: false,
      });
      deps.publish('wiki_changed', { botId });
      return {
        skipped: false,
        rawRelPath: `raw/${rawName}`,
        conversationId: targetConversation,
        changedPages: maintenance.changedPages,
      } satisfies IngestOutcome;
    });
  } catch (error) {
    // BR-P09-005: a terminally failed ingest must reach the requesting bot
    // instead of only the jobs table (P06 BR-P06-002 precedent) — the user
    // asked for this material, so the bot should say so in its own words.
    // Retryable failures stay silent until the last attempt so the user is
    // not spammed. 内部事务原则：触发消息对用户隐藏（internal），可见的只有
    // Bot 自己的一句话交代。
    if (job.attempts >= JOB_MAX_ATTEMPTS && triggerConversationId !== null) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        deps.orchestrator.deliverEventToBot(
          botId,
          triggerConversationId,
          'wiki_ingest_failed',
          `你之前登记的一次 Wiki 入库失败了（来源：${ref.slice(0, 120)}；原因：${message.slice(0, 300)}），资料没有进入你的知识库。请用一句话告诉用户这份资料这次没能整理成功，不要复述技术细节；之后可以直接重试。`,
          { internal: true },
        );
      } catch (notifyError) {
        deps.logger.warn(
          { botId, jobId: job.id, error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
          'wiki ingest failure notification failed',
        );
      }
    }
    throw error;
  }

  deps.logger.info(
    { botId, jobId: job.id, skipped: outcome.skipped, changed: outcome.changedPages.length },
    'wiki ingest job finished',
  );
}

interface ResolvedSource {
  bytes: Buffer;
  name: string;
  mime: string;
  /** HTML → markdown conversion result (URL sources). */
  converted: string | null;
  description: string;
}

async function resolveSource(
  deps: WikiIngestJobDeps,
  input: { botId: string; conversationId: string | null; sourceType: string; ref: string },
): Promise<ResolvedSource> {
  if (input.sourceType === 'attachment') {
    const attachment = deps.attachments.get(input.ref);
    if (attachment === null) {
      throw new AppError('NOT_FOUND', `附件 ${input.ref} 不存在（可能已随消息删除）`);
    }
    if (
      input.conversationId !== null &&
      attachment.conversationId !== input.conversationId
    ) {
      throw new AppError('INVALID_INPUT', '附件不属于发起入库的对话');
    }
    // BR-P09-002: the source message may have been recalled between enqueue
    // and this claim (the recall cascade only removes raw files that already
    // exist). Recalled material must never enter raw/ — double-check the
    // source message status (BR-P07-006 / BR-P08-007 precedent).
    if (attachment.messageId !== null) {
      const message = deps.messages.getById(attachment.messageId);
      if (message === null || message.status === 'recalled') {
        throw new AppError('NOT_FOUND', '来源消息已撤回，停止入库');
      }
    }
    const bytes = deps.attachments.readBytes(attachment);
    assertSize(bytes.length, `附件 ${attachment.fileName}`);
    return {
      bytes,
      name: attachment.fileName,
      mime: attachment.mime,
      converted: null,
      description: `附件 ${attachment.fileName}`,
    };
  }

  if (input.sourceType === 'file') {
    if (input.conversationId === null) {
      throw new AppError('INVALID_INPUT', '文件入库需要发起对话，无法确定可访问范围');
    }
    // 在可访问范围内（workspace / project / 有效授权）才允许复制。
    const identity = {
      runId: `wiki_${deps.clock.now()}`,
      botId: input.botId,
      conversationId: input.conversationId,
      loopType: 'wiki_maintenance' as const,
    };
    const decision = deps.gateway.checkPath(identity, input.ref, 'read');
    if (decision.kind !== 'allowed') {
      throw new AppError(
        'PATH_OUT_OF_SCOPE',
        `文件不在可访问范围内（${decision.reason}）：${input.ref}`,
      );
    }
    const bytes = readFileSync(decision.resolvedPath);
    assertSize(bytes.length, `文件 ${input.ref}`);
    const name = path.basename(input.ref);
    return {
      bytes,
      name,
      mime: 'text/plain',
      converted: null,
      description: `文件 ${name}`,
    };
  }

  // URL：在沙箱中抓取（受网络策略约束；无沙箱 fail-closed）。
  const bot = deps.bots.get(input.botId);
  const network = {
    mode: bot?.profile.runtime.network_policy ?? 'open',
    allowDomains: bot?.profile.runtime.network_allowlist ?? [],
  } as const;
  const bytes = await fetchUrlInSandbox({
    sandbox: deps.sandbox,
    paths: deps.paths,
    url: input.ref,
    botNetwork: { mode: network.mode, allowDomains: [...network.allowDomains] },
    logger: deps.logger,
  });
  assertSize(bytes.length, `网页 ${input.ref}`);
  const text = bytes.toString('utf8');
  const converted = looksLikeHtml(text) ? htmlToMarkdown(text) : null;
  let name = path.basename(new URL(input.ref).pathname) || 'page';
  if (converted !== null) {
    name = `${name.replace(/\.[a-z0-9]+$/i, '') || 'page'}.md`;
  } else if (!/\.[a-z0-9]+$/i.test(name)) {
    name = `${name}.txt`;
  }
  return {
    bytes: converted !== null ? Buffer.from(converted, 'utf8') : bytes,
    name,
    mime: converted !== null ? 'text/markdown' : 'text/html',
    converted,
    description: `网页 ${input.ref}`,
  };
}

function assertSize(bytes: number, what: string): void {
  if (bytes > WIKI_SOURCE_MAX_BYTES) {
    throw new AppError('INVALID_INPUT', `${what} 超过入库大小上限（${WIKI_SOURCE_MAX_BYTES} 字节）`);
  }
}

/** True when the raw path already exists in the wiki HEAD tree. */
async function isRawCommitted(root: string, relPath: string): Promise<boolean> {
  if (!existsSync(path.join(root, '.git'))) return false;
  try {
    const repo = await openRepository(root);
    const head = repo.head().target();
    if (head === null) return false; // unborn HEAD — nothing committed yet
    return repo.getCommit(head).tree().getPath(relPath) !== null;
  } catch {
    return false;
  }
}
