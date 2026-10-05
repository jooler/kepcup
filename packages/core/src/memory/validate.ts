import type { MemoryKind, MemorySource, MemorySensitivity } from '@kepcup/shared';
import { containsCredential } from './credential-patterns.js';

/**
 * Code-enforced write validation (docs/dev/phases/P07-memory.md "写入校验").
 * Runs before ANY memory item write and before any profile proposal enters
 * the shared layer — the model's self-restraint is never trusted.
 */

/** The slice of a message the evidence rules need. */
export interface EvidenceMessage {
  id: string;
  conversationId: string;
  senderType: 'user' | 'bot' | 'system';
  status: 'normal' | 'recalled' | 'edited';
}

export interface WriteCheckContext {
  /** Loads evidence messages (null = does not exist). */
  getMessage(id: string): EvidenceMessage | null;
  /** Conversation ids the owning bot participates in. */
  botConversationIds(botId: string): Set<string>;
}

export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  evidenceMessageIds: string[];
  confidence: number;
  sensitivity: MemorySensitivity;
  privateToBot: boolean;
}

export interface ProfileCandidate {
  content: string;
  source: MemorySource;
  evidenceMessageIds: string[];
  confidence: number;
  sensitivity?: MemorySensitivity | undefined;
  privateToBot?: boolean | undefined;
}

export type CheckVerdict = 'write' | 'private-only' | 'drop';

export interface CheckOutcome {
  verdict: CheckVerdict;
  /** Human-readable (loggable) reason; no message content. */
  reason: string;
}

const DROPPED = (reason: string): CheckOutcome => ({ verdict: 'drop', reason });
const WRITE: CheckOutcome = { verdict: 'write', reason: '' };

/** Shared checks: credentials, low-confidence inferred items, evidence validity. */
function baseChecks(
  content: string,
  source: MemorySource,
  confidence: number,
  evidenceMessageIds: string[],
  botId: string,
  ctx: WriteCheckContext,
): CheckOutcome {
  if (containsCredential(content)) {
    return DROPPED('content matches a credential pattern and is never stored');
  }
  if (source === 'inferred' && confidence < 0.5) {
    return DROPPED(`inferred item with confidence ${confidence} < 0.5`);
  }
  const conversations = ctx.botConversationIds(botId);
  for (const id of evidenceMessageIds) {
    const message = ctx.getMessage(id);
    if (!message) return DROPPED(`evidence message ${id} does not exist`);
    if (message.status === 'recalled') return DROPPED(`evidence message ${id} was recalled`);
    if (!conversations.has(message.conversationId)) {
      return DROPPED(`evidence message ${id} is outside this bot's conversations`);
    }
  }
  return WRITE;
}

/**
 * Evidence rule for fact/preference memories and every profile proposal:
 * at least one non-recalled USER message must back the claim — content from
 * web pages, files, tool output or other bots never reaches the profile.
 */
export function hasUserEvidence(evidenceMessageIds: string[], ctx: WriteCheckContext): boolean {
  return evidenceMessageIds.some((id) => ctx.getMessage(id)?.senderType === 'user');
}

export function checkMemoryCandidate(
  candidate: MemoryCandidate,
  botId: string,
  ctx: WriteCheckContext,
): CheckOutcome {
  const base = baseChecks(
    candidate.content,
    candidate.source,
    candidate.confidence,
    candidate.evidenceMessageIds,
    botId,
    ctx,
  );
  if (base.verdict === 'drop') return base;
  if (candidate.kind === 'fact' || candidate.kind === 'preference') {
    if (!hasUserEvidence(candidate.evidenceMessageIds, ctx)) {
      return DROPPED(`${candidate.kind} memories require at least one user message as evidence`);
    }
  }
  return WRITE;
}

/**
 * Profile proposals: sensitive / private-to-bot content never enters the
 * shared layer — it is downgraded to the proposing bot's private memory.
 */
export function checkProfileCandidate(
  candidate: ProfileCandidate,
  botId: string,
  ctx: WriteCheckContext,
): CheckOutcome {
  const base = baseChecks(
    candidate.content,
    candidate.source,
    candidate.confidence,
    candidate.evidenceMessageIds,
    botId,
    ctx,
  );
  if (base.verdict === 'drop') return base;
  if (candidate.sensitivity === 'sensitive' || candidate.privateToBot === true) {
    return {
      verdict: 'private-only',
      reason:
        candidate.sensitivity === 'sensitive'
          ? "sensitive content stays in the proposing bot's private memory"
          : 'user said "only tell you": stays in this bot\'s private memory',
    };
  }
  // ALL profile proposals require user evidence (信任隔离, design/06).
  if (!hasUserEvidence(candidate.evidenceMessageIds, ctx)) {
    return DROPPED('profile proposals require at least one user message as evidence');
  }
  return WRITE;
}
