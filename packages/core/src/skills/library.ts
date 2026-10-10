import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import {
  AppError,
  skillImportApprovalPayloadSchema,
  type SkillCandidate,
  type SkillImportApprovalPayload,
  type SkillScan,
} from '@kepcup/shared';
import { cloneRepository, type Repository } from 'es-git';

import type { AppPaths } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import type { RunIdentity } from '../agent/types.js';
import type { ApprovalsService } from '../permissions/approvals.js';
import type { EnvManager } from '../env/manager.js';
import { parseSkillDir } from './parse.js';
import { scanSkillDir } from './scan.js';
import type { SkillsService } from './registry.js';

export interface ImportRequest {
  sourceUrl: string;
  ref?: string | undefined;
  subdirectory?: string | undefined;
  botId: string;
  conversationId: string;
}

export type ImportOutcome =
  | { status: 'submitted'; approvalId: string }
  | { status: 'candidates'; candidates: SkillCandidate[] };

/** prepare 的就绪产物：审批 payload + commit 所需的全部上下文（D63）。 */
export interface PreparedImport {
  status: 'ready';
  stagingDir: string;
  skillDir: string;
  scan: SkillScan;
  contentHash: string;
  commitOid: string;
  /** 复用已入库的同内容条目（库不可变，只补 Bot 引用）。 */
  reuseExisting: boolean;
  payload: SkillImportApprovalPayload;
  sourceUrl: string;
  botId: string;
  conversationId: string;
}

export interface ImporterDeps {
  paths: AppPaths;
  clock: Clock;
  logger: CoreLogger;
  approvals: ApprovalsService;
  skills: SkillsService;
  /** Missing-dependency detection at scan time (null in stripped setups). */
  environment?: EnvManager | undefined;
  /**
   * P12: current enhanced-sandbox availability for the import card's
   * compatibility verdict (undefined = treated as missing).
   */
  enhancedSandbox?: { available(): boolean } | undefined;
}

/**
 * Git import pipeline (docs/dev/phases/P08-skills.md 任务 3): clone outside
 * the sandbox with es-git (pure libgit2 file download — no hooks are run and
 * no dependencies are installed, docs 注意事项), lock the commit, locate the
 * skill directories, hash the content, scan, raise a `skill_import` approval
 * whose card carries the scan results, and on approval move the content into
 * the read-only library and install it for the target bot.
 *
 * Staging lives under `cache/skill-imports/{id}/` until the decision; boot
 * recovery sweeps the whole staging root because a restart cancels every
 * pending approval (the decision callback dies with the process).
 */
export class SkillImporter {
  readonly #deps: ImporterDeps;

  constructor(deps: ImporterDeps) {
    this.#deps = deps;
  }

  get #stagingRoot(): string {
    return path.join(this.#deps.paths.cacheDir, 'skill-imports');
  }

  /** Boot recovery: staged clones never survive a restart (no waiter left). */
  sweepStaging(): void {
    rmSync(this.#stagingRoot, { recursive: true, force: true });
  }

  async import(request: ImportRequest): Promise<ImportOutcome> {
    const prepared = await this.prepare(request);
    if (prepared.status === 'candidates') return prepared;
    const payload = prepared.payload;
    const identity: RunIdentity = {
      runId: '',
      botId: request.botId,
      conversationId: request.conversationId,
      loopType: 'host',
    };
    const approval = this.#deps.approvals.submitNonBlocking(
      identity,
      'skill_import',
      payload as Record<string, unknown>,
      (outcome) => {
        if (outcome.decision === 'approved') {
          try {
            this.commit(prepared);
          } catch (error) {
            // The approval row already says "approved" — surface the failed
            // finalize instead of swallowing it (BR-P08-004): the card's
            // terminal state becomes `failed`, which is the user-facing
            // surface; nothing is installed and no conversation notice is
            // written (技能导入是 Bot 内部事务，docs/design/01-conversation.md).
            const reason = error instanceof Error ? error.message : String(error);
            this.#deps.logger.error(
              { skill: payload.name, error: reason },
              'skill import finalize failed',
            );
            try {
              this.#deps.approvals.fail(outcome.approval.id, `技能导入落位失败：${reason}`);
            } catch (failError) {
              this.#deps.logger.error(
                {
                  approvalId: outcome.approval.id,
                  error: failError instanceof Error ? failError.message : String(failError),
                },
                'marking skill_import approval failed also failed',
              );
            }
          }
          return;
        }
        this.#deps.logger.info(
          { skill: payload.name, decision: outcome.decision },
          'skill import not approved; staging removed',
        );
        this.discard(prepared);
      },
    );
    this.#deps.logger.info(
      {
        skill: payload.name,
        botId: request.botId,
        conversationId: request.conversationId,
        approvalId: approval.id,
        status: approval.status,
      },
      'skill import approval submitted',
    );
    return { status: 'submitted', approvalId: approval.id };
  }

  // --- prepare / commit 两段（docs/design/22-file-skill-routing.md，D63）-----
  //
  // RPC 导入入口（上）保持「提交即返回 + 回调落位」的非阻塞形态；工具发起的
  // 安装（install_skill source_url）走阻塞审批：prepare 在工具执行体内完成
  // clone+scan 并产出审批 payload，approvals.request 挂起 run 等用户决定，
  // 批准后 commit 落位并返回技能位置，拒绝/取消由工具拿到 APPROVAL_DENIED。

  /**
   * clone + 静态扫描 + 审批 payload（不安装、不等待）。多技能仓库仍返回
   * candidates（带 subdirectory 重试）。
   */
  async prepare(
    request: ImportRequest,
  ): Promise<PreparedImport | { status: 'candidates'; candidates: SkillCandidate[] }> {
    const url = normalizeSourceUrl(request.sourceUrl);
    const stagingDir = path.join(
      this.#stagingRoot,
      `imp_${this.#deps.clock.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(stagingDir, { recursive: true });
    const log = {
      sourceUrl: request.sourceUrl,
      ref: request.ref ?? null,
      subdirectory: request.subdirectory ?? null,
      botId: request.botId,
      stagingDir,
    };
    try {
      this.#deps.logger.info(log, 'skill import: cloning');
      const commitOid = await this.#clone(url, request.ref, stagingDir);
      const located = locateSkillDirs(stagingDir, request.subdirectory);
      this.#deps.logger.info(
        { ...log, commitOid, located: located.map((dir) => path.relative(stagingDir, dir) || '.') },
        'skill import: clone done, skill directories located',
      );
      if (located.length === 0) {
        throw new AppError(
          'SKILL_IMPORT_FAILED',
          '仓库中未找到技能目录（需要包含 SKILL.md 的目录）；可指定子目录重试',
        );
      }
      if (located.length > 1 && !request.subdirectory) {
        const candidates: SkillCandidate[] = located.map((dir) => {
          const parsed = parseSkillDir(dir);
          return {
            name: parsed?.name ?? path.basename(dir),
            description: parsed?.description ?? '',
            subdirectory: path.relative(stagingDir, dir),
          };
        });
        rmSync(stagingDir, { recursive: true, force: true });
        return { status: 'candidates', candidates };
      }
      const skillDir = located[0]!;
      const parsed = parseSkillDir(skillDir);
      if (parsed === null) {
        throw new AppError(
          'SKILL_IMPORT_FAILED',
          '所选目录不是有效技能（SKILL.md 缺少 name/description）',
        );
      }
      const scan = scanSkillDir(skillDir, parsed, {
        enhancedSandboxAvailable: this.#deps.enhancedSandbox?.available() ?? false,
      });
      const contentHash = hashDirectory(skillDir);
      // Identical content already in the library: approving reuses it (the
      // library entry is immutable) and only adds the bot's reference.
      const existing = this.#deps.skills.libraryByNameAndHash(scan.name, contentHash);
      const missingDeps = this.#deps.environment
        ? scan.runtimeDeps.filter((dep) => !this.#deps.environment!.depAvailable(dep))
        : [];

      const payload = skillImportApprovalPayloadSchema.parse({
        sourceUrl: request.sourceUrl,
        ...(request.ref ? { ref: request.ref } : {}),
        ...(request.subdirectory ? { subdirectory: request.subdirectory } : {}),
        commitOid,
        name: scan.name,
        description: scan.description,
        scan,
        missingDeps,
      });
      this.#deps.logger.info(
        {
          ...log,
          skill: scan.name,
          commitOid,
          hash: contentHash,
          reuseExisting: existing !== null,
          compatibility: scan.compatibility,
          compatibilityReasons: scan.compatibilityReasons,
          runtimeDeps: scan.runtimeDeps,
          missingDeps,
          files: scan.files.length,
        },
        'skill import: prepared (scan done, awaiting approval)',
      );
      return {
        status: 'ready',
        stagingDir,
        skillDir,
        scan,
        contentHash,
        commitOid,
        reuseExisting: existing !== null,
        payload,
        sourceUrl: request.sourceUrl,
        botId: request.botId,
        conversationId: request.conversationId,
      };
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      this.#deps.logger.warn(
        {
          ...log,
          code: error instanceof AppError ? error.code : 'SKILL_IMPORT_FAILED',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'skill import: prepare failed',
      );
      if (error instanceof AppError) throw error;
      throw new AppError(
        'SKILL_IMPORT_FAILED',
        `克隆或扫描失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 批准后落位：staging 内容入只读库并为 Bot 安装，最后清 staging。 */
  commit(prepared: PreparedImport): void {
    this.#deps.skills.installImported({
      botId: prepared.botId,
      conversationId: prepared.conversationId,
      name: prepared.scan.name,
      scan: prepared.scan,
      sourceUrl: prepared.sourceUrl,
      commitOid: prepared.commitOid,
      contentHash: prepared.contentHash,
      // Copy the located skill directory (a repo may hold several);
      // the clone root is discarded either way.
      stagingDir: prepared.skillDir,
      reuseExisting: prepared.reuseExisting,
    });
    this.discard(prepared);
  }

  /** 丢弃 staging（拒绝 / 取消 / 已落位后的清理）。 */
  discard(prepared: PreparedImport): void {
    rmSync(prepared.stagingDir, { recursive: true, force: true });
  }

  /** Conversation notice after a failed finalize (best-effort, BR-P08-004). */
  /**
   * Resolves a branch/tag to a commit id. Annotated tags resolve to the tag
   * object first, so `ref^{commit}` is tried before the raw ref (libgit2
   * revparse syntax); an unknown ref is a user-facing failure.
   */
  #resolveRefOid(repo: Repository, ref: string): string {
    try {
      return repo.revparseSingle(`${ref}^{commit}`);
    } catch {
      try {
        return repo.revparseSingle(ref);
      } catch {
        throw new AppError('SKILL_IMPORT_FAILED', `找不到分支或标签：${ref}`);
      }
    }
  }

  /** Clone (HTTPS or a local path), optional ref checkout, lock HEAD. */
  async #clone(url: string, ref: string | undefined, stagingDir: string): Promise<string> {
    let repo: Repository;
    if (isLocalPath(url)) {
      const source = path.resolve(url.replace(/^file:\/\//, ''));
      if (!existsSync(source)) {
        throw new AppError('SKILL_IMPORT_FAILED', `本地路径不存在：${url}`);
      }
      repo = await cloneRepository(source, stagingDir);
    } else {
      // normalizeSourceUrl guarantees https:// at this point.
      repo = await cloneRepository(url, stagingDir);
    }
    if (ref !== undefined && ref.length > 0) {
      // Peel annotated tags to the commit (`v1^{commit}`); plain refs resolve
      // through the same syntax, so try it first.
      const oid = this.#resolveRefOid(repo, ref);
      const commitOid = repo.getCommit(oid).id();
      // Detached checkout of the requested ref locks the content; the clone
      // already fetched every branch, so this stays off the network.
      repo.checkoutTree(repo.getCommit(commitOid).asObject(), { force: true });
      // checkoutTree does not move HEAD (libgit2): without this, the recorded
      // commit would be the default branch's tip while the installed content
      // is the ref's — audit trail would lie (BR-P08-001).
      repo.setHeadDetached(repo.getCommit(commitOid));
      return commitOid;
    }
    const head = repo.head().target();
    if (head === null) {
      throw new AppError('SKILL_IMPORT_FAILED', '克隆完成但没有可用的提交（空仓库？）');
    }
    return head;
  }
}

/** sha256 over relative paths + file contents (stable across machines). */
export function hashDirectory(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        hash.update(rel);
        hash.update('\0');
        hash.update(createHash('sha256').update(readFileSync(abs)).digest());
        hash.update('\0');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex').slice(0, 32);
}

/** Copies a skill tree excluding git metadata (library content only). */
export function copySkillTree(from: string, to: string): void {
  const walk = (current: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const sourceEntry = path.join(current, entry.name);
      const targetEntry = path.join(target, entry.name);
      if (entry.isDirectory()) {
        walk(sourceEntry, targetEntry);
      } else if (entry.isFile()) {
        const stats = statSync(sourceEntry);
        if (stats.size > 50 * 1024 * 1024) {
          throw new AppError('SKILL_IMPORT_FAILED', `技能包含超过 50MB 的文件：${entry.name}`);
        }
        const bytes = readFileSync(sourceEntry);
        writeReadonly(targetEntry, bytes);
      }
    }
  };
  walk(from, to);
}

/** Writes a library file and drops its write bits (content immutability). */
function writeReadonly(file: string, bytes: Buffer): void {
  writeFileSync(file, bytes);
  try {
    chmodSync(file, 0o444);
  } catch {
    // Windows may ignore chmod; gateway + sandbox still block writes.
  }
}

/** Locates skill directories inside a clone (repo root may be a skill itself). */
export function locateSkillDirs(root: string, subdirectory?: string | undefined): string[] {
  if (subdirectory !== undefined && subdirectory.length > 0) {
    const target = path.resolve(root, subdirectory);
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
      return [];
    }
    if (!existsSync(path.join(target, 'SKILL.md'))) return [];
    return [target];
  }
  if (existsSync(path.join(root, 'SKILL.md'))) return [root];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      if (existsSync(path.join(child, 'SKILL.md'))) {
        found.push(child);
        continue; // a skill root is not descended into
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * Accepted import sources: HTTPS URLs plus local absolute paths / file://
 * URLs (local repositories and tests — the network protocols ssh/git/http
 * are rejected outright, 任务书 注意事项).
 */
export function normalizeSourceUrl(sourceUrl: string): string {
  const trimmed = sourceUrl.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('file://')) return trimmed;
  if (path.isAbsolute(trimmed)) return trimmed;
  throw new AppError('SKILL_IMPORT_FAILED', '技能来源必须是 HTTPS git 地址或本机路径');
}

export function isLocalPath(url: string): boolean {
  return url.startsWith('file://') || (!url.startsWith('https://') && path.isAbsolute(url));
}
