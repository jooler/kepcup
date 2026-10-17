import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * The source ledger of a project wiki (D85 §3.2 text subset + `createdBy`,
 * D92 T1b WP9): every ingested source registers `raw/_assets/{assetId}.json`
 * so pages can cite it and the team can manage entries per creator. Bot wikis
 * have no ledger (their sources stay anonymous in `raw/`). Pure helpers plus
 * thin IO; all read-modify-write happens under the wiki service mutex.
 */

/** Who first submitted the content (later submissions of the same content only append sources). */
export type WikiAssetCreator = { kind: 'user' } | { kind: 'bot'; id: string };

/** One submission record of one asset (same content from more places appends here). */
export interface WikiAssetSourceRecord {
  type: 'attachment' | 'file' | 'url';
  ref: string;
  /** Conversation that carried the submission (project id for a project wiki); null when unknown. */
  conversationId: string | null;
  at: number;
}

/** Text subset of the D85 asset manifest (design 36 §3.2). */
export interface WikiAssetEntry {
  /** `ast_` + first 24 hex chars of the content sha256 (same content = same asset). */
  id: string;
  /** 64 hex chars, sha256 of the stored raw bytes. */
  sha256: string;
  /** This phase only ingests text-like sources. */
  kind: 'text' | 'html';
  fileName: string;
  bytes: number;
  /** Always `git` this phase: the original lives at `rawRelPath` inside the repository. */
  storage: 'git';
  /** Wiki-root-relative path of the original, e.g. `raw/20261017-3f9a0c1b2d4e-notes.md`. */
  rawRelPath: string;
  createdBy: WikiAssetCreator;
  sources: WikiAssetSourceRecord[];
  status: 'maintained';
  createdAt: number;
  updatedAt: number;
}

export const wikiAssetCreatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('bot'), id: z.string().min(1) }),
]);

export const wikiAssetSourceRecordSchema = z.object({
  type: z.enum(['attachment', 'file', 'url']),
  ref: z.string(),
  conversationId: z.string().nullable(),
  at: z.number(),
});

export const wikiAssetEntrySchema = z.object({
  id: z.string().regex(/^ast_[0-9a-f]{24}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(['text', 'html']),
  fileName: z.string(),
  bytes: z.number().int().nonnegative(),
  storage: z.literal('git'),
  rawRelPath: z.string(),
  createdBy: wikiAssetCreatorSchema,
  sources: z.array(wikiAssetSourceRecordSchema),
  status: z.literal('maintained'),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** `ast_` + the first 24 hex chars of the content hash (D85 §3.2; not a ULID, not in ID_PREFIXES). */
export function assetIdOf(sha256: string): string {
  return `ast_${sha256.slice(0, 24)}`;
}

/** Ledger file of one asset inside a wiki root: `raw/_assets/{assetId}.json`. */
export function ledgerPath(root: string, assetId: string): string {
  return path.join(root, 'raw', '_assets', `${assetId}.json`);
}

/**
 * Every ledger entry of the wiki root, ordered by file name. A missing
 * directory yields `[]`; a single corrupt file is skipped with a log line and
 * never breaks the whole list (one bad file must not take the sources panel
 * down — design 41 §8 risk notes).
 */
export function readLedger(
  root: string,
  logger?: { warn: (obj: object, msg: string) => void },
): WikiAssetEntry[] {
  const dir = path.join(root, 'raw', '_assets');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: WikiAssetEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = wikiAssetEntrySchema.safeParse(
        JSON.parse(readFileSync(path.join(dir, name), 'utf8')),
      );
      if (parsed.success) {
        entries.push(parsed.data);
        continue;
      }
      logger?.warn({ file: name, issues: parsed.error.issues.length }, 'wiki asset ledger entry invalid; skipped');
    } catch (error) {
      logger?.warn(
        { file: name, error: error instanceof Error ? error.message : String(error) },
        'wiki asset ledger entry unreadable; skipped',
      );
    }
  }
  return entries;
}

/** Atomic write: temp file + rename, so a crash never leaves a torn JSON. */
export function writeLedgerEntry(root: string, entry: WikiAssetEntry): void {
  const file = ledgerPath(root, entry.id);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Appends one submission to the asset's sources (same `type` + `ref` already
 * present = no-op) and bumps `updatedAt`. Returns true when a record was added.
 */
export function appendSource(
  entry: WikiAssetEntry,
  source: WikiAssetSourceRecord,
  now: number,
): boolean {
  const exists = entry.sources.some(
    (existing) => existing.type === source.type && existing.ref === source.ref,
  );
  if (exists) return false;
  entry.sources.push(source);
  entry.updatedAt = now;
  return true;
}

/** Removes the ledger file of one asset (no-op when already gone). */
export function removeLedgerEntry(root: string, assetId: string): void {
  rmSync(ledgerPath(root, assetId), { force: true });
}

/** Directory of one owner's ledger inside the wiki root (test/helper surface). */
export function ledgerDirOf(root: string): string {
  return path.join(root, 'raw', '_assets');
}

/** True when the owner's wiki has a ledger directory on disk. */
export function hasLedger(root: string): boolean {
  return existsSync(ledgerDirOf(root));
}
