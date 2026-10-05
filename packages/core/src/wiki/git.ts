import { existsSync } from 'node:fs';
import path from 'node:path';
import { initRepository, openRepository, type Repository } from 'es-git';

import type { CoreLogger } from '../infra/logger.js';

const GIT_SIGNATURE = { name: 'kepcup', email: 'wiki@localhost' } as const;

/**
 * es-git helpers of one bot's wiki repository. Same layout conclusions as the
 * P04/P08 precedents: a plain init inside the app-owned data directory
 * (DEV-006's "no .git in the worktree" rule targets USER project directories),
 * commits are append-only, and diff text never uses Diff.print (DEV-006) —
 * only tree diffs for changed-path discovery, which are unaffected.
 */

/** Opens (creating on first use) the bot's wiki repository. */
export async function openWikiRepo(
  wikiRoot: string,
  logger: CoreLogger,
): Promise<{ repo: Repository; created: boolean }> {
  const fresh = !existsSync(path.join(wikiRoot, '.git'));
  const repo = fresh ? await initRepository(wikiRoot) : await openRepository(wikiRoot);
  if (fresh) logger.info({ wikiRoot }, 'wiki repository initialized');
  return { repo, created: fresh };
}

/** Commits the current worktree state (add -A semantics: edits + deletions). */
export async function commitWikiTree(wikiRoot: string, message: string): Promise<string> {
  const repo = (await openRepository(wikiRoot)) as Repository;
  const index = repo.index();
  index.addAll(['.']);
  index.write();
  const treeId = index.writeTree();
  let parent: string | null = null;
  try {
    parent = repo.head().target();
  } catch {
    // first commit
  }
  // BR-P09-003: commit times are data — the weekly lint uses the oldest
  // commit as the "never linted" baseline and wiki.history shows them, so the
  // signature carries an explicit timestamp instead of es-git's default.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = { ...GIT_SIGNATURE, timeOptions: { timestamp } } as const;
  return repo.commit(repo.getTree(treeId), message, {
    updateRef: 'HEAD',
    author: signature,
    committer: signature,
    parents: parent !== null ? [parent] : [],
  });
}

/** Wiki-root-relative paths that changed between two commits (pages/ only). */
export function changedPagePaths(
  repo: Repository,
  fromOid: string | null,
  toOid: string,
): string[] {
  const oldTree = fromOid !== null ? repo.getCommit(fromOid).tree() : null;
  const newTree = repo.getCommit(toOid).tree();
  const diff = repo.diffTreeToTree(oldTree, newTree);
  const paths = new Set<string>();
  const deltas = diff.deltas();
  let step = deltas.next();
  while (!step.done) {
    const delta = step.value;
    const newPath = delta.newFile().path();
    const oldPath = delta.oldFile().path();
    for (const p of [newPath, oldPath]) {
      if (p !== null && (p === 'pages' || p.startsWith('pages/'))) paths.add(p);
    }
    step = deltas.next();
  }
  return [...paths];
}
