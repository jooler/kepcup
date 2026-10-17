import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, WIKI_SOURCE_MAX_BYTES, WIKI_TEXT_SOURCE_MAX_CHARS, wikiOwnerSchema, type WikiOwner } from '@kepcup/shared';

import { wikiRawDir, wikiRoot } from '../infra/paths.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import type { MessagesService } from '../domain/messages.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { Orchestrator } from '../dispatch/orchestrator.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { Clock } from '../infra/clock.js';
import { initWiki } from './init.js';
import { openRepository } from 'es-git';
import {
  contentSha256,
  fetchUrlInSandbox,
  findRawByHash,
  shortHash,
  rawFileName,
  sniffSourceKind,
  type SourceKind,
} from './source.js';
import { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js';
import { inlineTextFor, runWikiMaintenance, type WikiMaintenanceDeps } from './maintenance.js';
import {
  appendSource,
  assetIdOf,
  readLedger,
  writeLedgerEntry,
  type WikiAssetCreator,
  type WikiAssetEntry,
} from './assets.js';
import { commitWikiTree } from './git.js';
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

/** Parsed wiki_ingest payload (owner-less historic payloads are rejected). */
interface IngestPayload {
  owner: WikiOwner;
  createdBy: WikiAssetCreator;
  sourceType: 'attachment' | 'url' | 'file' | 'text';
  ref: string;
  note: string;
}

/**
 * Wiki ingest job (任务 3; owner-generalized in D92 T1b WP9): resolve the
 * source (attachment copy / workspace or workdir file copy within access
 * range / sandboxed URL fetch), store the raw material under `raw/` (dated +
 * content-hashed file name, same-hash skip), run the maintenance loop, commit
 * once and update the owner's wiki_fts. Project wikis additionally register
 * the source in the `raw/_assets` ledger (createdBy, sources) and the loop
 * runs as the SUBMITTING member (executor-pays, design 41 §8.4). 入库是 Bot
 * 自己的知识库整理：成功不出现在对话里（只有 wiki_ingested / wiki_changed 总线
 * 事件驱动 UI），终态失败才交代——Bot 提交的经内部事件用自己的话向用户交代，
 * 用户提交的走 app.notice 轻量提示。The whole flow is serialized per owner
 * through the wiki service mutex.
 */
export async function runWikiIngestJob(deps: WikiIngestJobDeps): Promise<void> {
  const { job } = deps;
  if (job.bot_id === null) {
    throw new AppError('INVALID_INPUT', 'wiki ingest requires a bot');
  }
  const botId = job.bot_id; // the executor (member bot for a project wiki)
  const bot = deps.bots.get(botId);
  if (bot === null || bot.status !== 'active') return; // deleted mid-queue

  const payload = parsePayload(job.payload_json);
  const owner = payload.owner;

  // The executor must still belong to the project (a member removed after
  // enqueueing loses its queued ingests; cancelPendingByBotInConversation
  // covers the queued rows, this covers the claim window).
  if (owner.kind === 'project') {
    if (deps.conversations.get(owner.id) === null) return; // project deleted mid-queue
    if (!deps.conversations.memberBotIds(owner.id).includes(botId)) {
      throw new AppError('INVALID_INPUT', '执行者已不是该项目组的成员，入库作废');
    }
  }

  // Conversation may have been deleted between enqueue and now; the
  // notification falls back to the bot's direct chat (authoring precedent).
  // For a project wiki it is the project conversation itself.
  const triggerConversationId =
    job.conversation_id !== null && deps.conversations.get(job.conversation_id) !== null
      ? job.conversation_id
      : null;

  let outcome: IngestOutcome;
  try {
    outcome = await deps.wiki.runExclusively(owner, async () => {
      await initWiki(deps.paths, owner, deps.logger);
      const root = wikiRoot(deps.paths, owner);
      const rawDir = wikiRawDir(deps.paths, owner);

      // --- resolve the source into raw bytes --------------------------------
      const source = await resolveSource(deps, {
        botId,
        conversationId: triggerConversationId,
        sourceType: payload.sourceType,
        ref: payload.ref,
      });

      // --- raw/ (append-only): dated + hashed name, same-hash skip ----------
      const sha256 = contentSha256(source.bytes);
      const assetId = assetIdOf(sha256);
      const hash12 = shortHash(source.bytes);
      const existing = findRawByHash(rawDir, hash12);
      if (existing !== null) {
        // Same content already present. Skipped only when a previous
        // maintenance already committed it; an uncommitted leftover (a failed
        // attempt) is reused so the retry still produces the pages.
        const committed = await isRawCommitted(root, `raw/${existing}`);
        if (committed) {
          if (owner.kind === 'project' && isLedgerKind(source.kind)) {
            const { appended } = ensureLedgerEntry(root, {
              assetId,
              sha256,
              sourceKind: source.kind,
              fileName: source.name,
              bytes: source.bytes.length,
              rawRelPath: `raw/${existing}`,
              createdBy: payload.createdBy,
              sourceRecord: {
                type: payload.sourceType,
                ref: ledgerRefOf(payload.sourceType, payload.ref),
                conversationId: job.conversation_id,
                at: deps.clock.now(),
              },
              now: deps.clock.now(),
            });
            // The ledger change joins the history with one small commit (the
            // original itself is already committed); an exact repeat (same
            // type + ref already recorded) writes identical bytes — no commit.
            if (appended) {
              await commitWikiTree(root, `wiki: 登记重复来源 ${assetId}`);
            }
          }
          deps.logger.info(
            { owner: `${owner.kind}:${owner.id}`, rawFile: existing },
            'wiki ingest skipped: same source hash',
          );
          const fallbackConversation =
            triggerConversationId ?? deps.conversations.openDirect(botId).conversation.id;
          deps.publish('wiki_ingested', {
            owner,
            botId,
            conversationId: fallbackConversation,
            rawPath: `raw/${existing}`,
            skipped: true,
          });
          deps.publish('wiki_changed', { owner });
          return {
            skipped: true,
            rawRelPath: `raw/${existing}`,
            conversationId: fallbackConversation,
            changedPages: [],
          } satisfies IngestOutcome;
        }
      }

      let rawName = existing;
      if (rawName === null) {
        rawName = rawFileName(new Date(deps.clock.now()), hash12, source.name);
        writeFileSync(path.join(rawDir, rawName), source.bytes);
        deps.logger.info(
          { owner: `${owner.kind}:${owner.id}`, rawFile: rawName, bytes: source.bytes.length },
          'wiki raw stored',
        );
      }

      // --- project ledger (D85 §3.2 text subset; before the loop so the
      // maintenance commit carries the original and the ledger together) -----
      let ledgerEntry: WikiAssetEntry | null = null;
      if (owner.kind === 'project' && isLedgerKind(source.kind)) {
        ledgerEntry = ensureLedgerEntry(root, {
          assetId,
          sha256,
          sourceKind: source.kind,
          fileName: source.name,
          bytes: source.bytes.length,
          rawRelPath: `raw/${rawName}`,
          createdBy: payload.createdBy,
          sourceRecord: {
            type: payload.sourceType,
            ref: ledgerRefOf(payload.sourceType, payload.ref),
            conversationId: job.conversation_id,
            at: deps.clock.now(),
          },
          now: deps.clock.now(),
        }).entry;
      }

      // --- maintenance loop ---------------------------------------------------
      const maintenance = await runWikiMaintenance(deps, {
        kind: 'ingest',
        input: {
          owner,
          botId,
          conversationId: triggerConversationId,
          sourceDescription: source.description,
          note: payload.note,
          rawRelPath: `raw/${rawName}`,
          inlineText: inlineTextFor(source.kind, source.bytes, source.converted),
          sourceKind: source.kind,
          sourceName: source.name,
          ...(ledgerEntry !== null
            ? {
                assetId: ledgerEntry.id,
                submitterLabel:
                  payload.createdBy.kind === 'user'
                    ? '用户'
                    : (deps.bots.get(payload.createdBy.id)?.name ?? payload.createdBy.id),
              }
            : {}),
        },
      });

      // --- 入库完成（任务 3）-------------------------------------------------
      // 入库是 Bot 自己的知识库整理（docs/design/01-conversation.md 消息原则）：
      // 成功不产生对话消息、不触发回应 run——之后 wiki_search 直接可用。UI 状态
      // 由下面的 wiki_ingested / wiki_changed 总线事件驱动。
      const targetConversation =
        triggerConversationId ?? deps.conversations.openDirect(botId).conversation.id;
      deps.publish('wiki_ingested', {
        owner,
        botId,
        conversationId: targetConversation,
        rawPath: `raw/${rawName}`,
        skipped: false,
      });
      deps.publish('wiki_changed', { owner });
      return {
        skipped: false,
        rawRelPath: `raw/${rawName}`,
        conversationId: targetConversation,
        changedPages: maintenance.changedPages,
      } satisfies IngestOutcome;
    });
  } catch (error) {
    // BR-P09-005: a terminally failed ingest must reach the requesting side
    // instead of only the jobs table (P06 BR-P06-002 precedent) — retryable
    // failures stay silent until the last attempt so nobody is spammed.
    // Bot-submitted sources wake the bot with an internal event (it explains
    // in its own words); user-submitted ones get an app.notice (no message
    // rows — D92 T1b).
    if (job.attempts >= JOB_MAX_ATTEMPTS) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (payload.createdBy.kind === 'bot') {
          if (triggerConversationId !== null) {
            deps.orchestrator.deliverEventToBot(
              botId,
              triggerConversationId,
              'wiki_ingest_failed',
              `你之前登记的一次 Wiki 入库失败了（来源：${payload.ref.slice(0, 120)}；原因：${message.slice(0, 300)}），资料没有进入${owner.kind === 'project' ? '项目' : '你的'}知识库。请用一句话告诉用户这份资料这次没能整理成功，不要复述技术细节；之后可以直接重试。`,
              { internal: true },
            );
          }
        } else if (triggerConversationId !== null) {
          deps.publish('app.notice', {
            key: `wiki-ingest-failed:${job.id}`,
            level: 'warning',
            text: `${owner.kind === 'project' ? '项目 Wiki' : 'Wiki'} 入库失败：${payload.ref.slice(0, 120)}（原因：${message.slice(0, 200)}）`,
          });
        }
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
    {
      owner: `${owner.kind}:${owner.id}`,
      botId,
      jobId: job.id,
      skipped: outcome.skipped,
      changed: outcome.changedPages.length,
    },
    'wiki ingest job finished',
  );
}

/** Parses and validates the ingest payload (breaking: owner + createdBy required). */
function parsePayload(payloadJson: string): IngestPayload {
  const raw = JSON.parse(payloadJson) as {
    owner?: unknown;
    createdBy?: unknown;
    sourceType?: unknown;
    ref?: unknown;
    note?: unknown;
  };
  const owner = wikiOwnerSchema.safeParse(raw.owner);
  if (!owner.success) {
    throw new AppError('INVALID_INPUT', 'wiki ingest payload 缺少有效的 owner');
  }
  const createdByRaw = raw.createdBy as { kind?: unknown; id?: unknown } | undefined;
  const createdBy: WikiAssetCreator | null =
    createdByRaw?.kind === 'user'
      ? { kind: 'user' }
      : createdByRaw?.kind === 'bot' && typeof createdByRaw.id === 'string' && createdByRaw.id.length > 0
        ? { kind: 'bot', id: createdByRaw.id }
        : null;
  if (createdBy === null) {
    throw new AppError('INVALID_INPUT', 'wiki ingest payload 缺少有效的 createdBy');
  }
  const sourceType = raw.sourceType;
  if (
    sourceType !== 'attachment' &&
    sourceType !== 'url' &&
    sourceType !== 'file' &&
    sourceType !== 'text'
  ) {
    throw new AppError('INVALID_INPUT', `未知的入库来源类型：${String(sourceType)}`);
  }
  return {
    owner: owner.data,
    createdBy,
    sourceType,
    ref: typeof raw.ref === 'string' ? raw.ref : '',
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

/** Only text-like sources get a ledger entry this phase (D85 binary/derive is out of scope). */
function isLedgerKind(kind: SourceKind): kind is 'text' | 'html' {
  return kind === 'text' || kind === 'html';
}

interface LedgerInput {
  assetId: string;
  sha256: string;
  sourceKind: 'text' | 'html';
  fileName: string;
  bytes: number;
  rawRelPath: string;
  createdBy: WikiAssetCreator;
  sourceRecord: { type: 'attachment' | 'file' | 'url' | 'text'; ref: string; conversationId: string | null; at: number };
  now: number;
}

/**
 * The ledger's `ref` of one submission: the full reference for attachment /
 * file / URL sources; for a pasted `text` source only an 80-char preview —
 * the body itself lives in `raw/`, the ledger must not duplicate it.
 */
export function ledgerRefOf(sourceType: 'attachment' | 'file' | 'url' | 'text', ref: string): string {
  return sourceType === 'text' ? ref.trim().slice(0, 80) : ref;
}

/**
 * File name of a pasted `text` source (D92 T1b WP10): `note-{yyyyMMdd-HHmmss}.md`,
 * UTC like every other wiki stamp.
 */
export function textSourceFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `note-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.md`
  );
}

/**
 * Appends the submission to the asset's ledger entry, creating the entry when
 * this content is new. `createdBy` stays the FIRST creator on repeats.
 * Persists via {@link writeLedgerEntry}; `appended` is true when a new source
 * record was added (an exact repeat only rewrites identical bytes).
 */
function ensureLedgerEntry(root: string, input: LedgerInput): { entry: WikiAssetEntry; appended: boolean } {
  const existing = readLedger(root).find((entry) => entry.id === input.assetId);
  const entry: WikiAssetEntry = existing ?? {
    id: input.assetId,
    sha256: input.sha256,
    kind: input.sourceKind,
    fileName: input.fileName,
    bytes: input.bytes,
    storage: 'git',
    rawRelPath: input.rawRelPath,
    createdBy: input.createdBy,
    sources: [],
    status: 'maintained',
    createdAt: input.now,
    updatedAt: input.now,
  };
  const appended = appendSource(entry, input.sourceRecord, input.now);
  if (appended || existing === undefined) {
    writeLedgerEntry(root, entry);
  }
  return { entry, appended };
}

interface ResolvedSource {
  bytes: Buffer;
  name: string;
  mime: string;
  /** Content-sniffed class; decides whether the bytes may be inlined as text. */
  kind: SourceKind;
  /** HTML → markdown conversion result (URL sources). */
  converted: string | null;
  description: string;
}

async function resolveSource(
  deps: WikiIngestJobDeps,
  input: { botId: string; conversationId: string | null; sourceType: string; ref: string },
): Promise<ResolvedSource> {
  if (input.sourceType === 'text') {
    // D92 T1b WP10: a user-pasted body — the ref IS the content. Validated at
    // enqueue time; re-checked here so a hand-crafted job payload cannot smuggle
    // an oversized body past the RPC boundary.
    const text = input.ref.trim();
    if (text.length === 0) {
      throw new AppError('INVALID_INPUT', '文本内容为空');
    }
    if (text.length > WIKI_TEXT_SOURCE_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', `文本超过长度上限（${WIKI_TEXT_SOURCE_MAX_CHARS} 字）`);
    }
    const bytes = Buffer.from(text, 'utf8');
    assertSize(bytes.length, '粘贴文本');
    const fileName = textSourceFileName(new Date(deps.clock.now()));
    return {
      bytes,
      name: fileName,
      mime: 'text/markdown',
      kind: 'text',
      converted: null,
      description: `粘贴文本 ${fileName}`,
    };
  }

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
    // and this claim. Recalled material must never enter raw/ — check the
    // source message status (BR-P07-006 / BR-P08-007 precedent).
    if (attachment.messageId !== null) {
      const message = deps.messages.getById(attachment.messageId);
      if (message === null || message.status === 'recalled') {
        throw new AppError('NOT_FOUND', '来源消息已撤回，停止入库');
      }
    }
    const bytes = deps.attachments.readBytes(attachment);
    assertSize(bytes.length, `附件 ${attachment.fileName}`);
    const sniffed = sniffSourceKind(bytes, attachment.fileName, attachment.mime);
    return {
      bytes,
      name: attachment.fileName,
      mime: sniffed.mime,
      kind: sniffed.kind,
      converted: null,
      description: `附件 ${attachment.fileName}`,
    };
  }

  if (input.sourceType === 'file') {
    if (input.conversationId === null) {
      throw new AppError('INVALID_INPUT', '文件入库需要发起对话，无法确定可访问范围');
    }
    // 在可访问范围内（workspace / workdir / 有效授权）才允许复制。
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
    const sniffed = sniffSourceKind(bytes, name);
    return {
      bytes,
      name,
      mime: sniffed.mime,
      kind: sniffed.kind,
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
    kind: converted !== null ? 'text' : 'html',
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
