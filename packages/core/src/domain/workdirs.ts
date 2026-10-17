import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { rmSync } from '../infra/fs-rm.js';
import path from 'node:path';
import {
  AppError,
  newId,
  WORKDIR_DEFAULT_PROTECT_RULES,
  WORKDIRS_RECENT_LIMIT,
  type Workdir,
  type WorkdirProtectRules,
  type RunChange,
} from '@kepcup/shared';
import { canonicalPath } from '../infra/paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface WorkdirRow {
  id: string;
  path: string;
  name: string;
  protect_rules_json: string;
  allowed_ports_json: string | null;
  status: 'available' | 'missing';
  created_at: number;
  last_used_at: number;
}

interface RunChangeRow {
  run_id: string;
  workdir_id: string;
  conversation_id: string | null;
  before_oid: string;
  after_oid: string | null;
  files_json: string | null;
  reverted_at: number | null;
  created_at: number;
}

function parseProtectRules(raw: string): WorkdirProtectRules {
  // On-disk JSON written only through this service; fall closed to defaults.
  try {
    const parsed = JSON.parse(raw) as Partial<WorkdirProtectRules>;
    return {
      denyRead: Array.isArray(parsed.denyRead) ? parsed.denyRead : [...WORKDIR_DEFAULT_PROTECT_RULES.denyRead],
      denyWrite: Array.isArray(parsed.denyWrite) ? parsed.denyWrite : [],
    };
  } catch {
    return { denyRead: [...WORKDIR_DEFAULT_PROTECT_RULES.denyRead], denyWrite: [] };
  }
}

function rowToWorkdir(row: WorkdirRow): Workdir {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    protectRules: parseProtectRules(row.protect_rules_json),
    allowedPorts: row.allowed_ports_json ? (JSON.parse(row.allowed_ports_json) as Workdir['allowedPorts']) : null,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Workdirs (docs/design/08-workdir.md "实体"): local directories bound to
 * conversations. One row per realpath; the selector lists recent ones.
 */
export class WorkdirsService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  /**
   * Finds the record for `dir` (realpath'd) or creates it. Status reflects
   * the current disk state. The directory must exist and must not live
   * inside the application data directory.
   */
  ensureByPath(dir: string, dataHome: string): Workdir {
    const resolved = canonicalPath(dir);
    let stats;
    try {
      stats = statSync(resolved);
    } catch {
      throw new AppError('WORKDIR_MISSING', `目录不存在或不可访问：${dir}`);
    }
    if (!stats.isDirectory()) {
      throw new AppError('INVALID_INPUT', 'workdir 必须是一个目录');
    }
    if (resolved === dataHome || resolved.startsWith(dataHome.endsWith('/') ? dataHome : `${dataHome}/`)) {
      throw new AppError('PATH_OUT_OF_SCOPE', '应用数据目录不能作为 workdir');
    }

    const now = this.#clock.now();
    const existing = this.#db.prepare('select * from workdirs where path = ?').get(resolved) as
      | WorkdirRow
      | undefined;
    if (existing) {
      if (existing.status !== 'available') {
        this.#db.prepare("update workdirs set status = 'available' where id = ?").run(existing.id);
      }
      this.#db.prepare('update workdirs set last_used_at = ? where id = ?').run(now, existing.id);
      // 名称固定为文件夹名（不再可改）：把改名功能时期留下的自定义名一并矫正。
      if (existing.name !== path.basename(resolved)) {
        this.#db
          .prepare('update workdirs set name = ? where id = ?')
          .run(path.basename(resolved), existing.id);
      }
      return this.getOrThrow(existing.id);
    }
    const id = newId('wkd');
    this.#db
      .prepare(
        'insert into workdirs (id, path, name, protect_rules_json, allowed_ports_json, status, created_at, last_used_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        resolved,
        path.basename(resolved),
        JSON.stringify(WORKDIR_DEFAULT_PROTECT_RULES),
        null,
        'available',
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): Workdir | null {
    const row = this.#db.prepare('select * from workdirs where id = ?').get(id) as
      | WorkdirRow
      | undefined;
    return row ? rowToWorkdir(row) : null;
  }

  getOrThrow(id: string): Workdir {
    const workdir = this.get(id);
    if (!workdir) throw new AppError('NOT_FOUND', `Workdir ${id} does not exist`);
    return workdir;
  }

  /** Most recently used workdirs (selector). */
  listRecent(limit: number = WORKDIRS_RECENT_LIMIT): Workdir[] {
    const rows = this.#db
      .prepare('select * from workdirs order by last_used_at desc limit ?')
      .all(limit) as WorkdirRow[];
    return rows.map(rowToWorkdir);
  }

  /** Refreshes `status` from disk; returns the updated record. */
  refreshStatus(id: string): Workdir {
    const workdir = this.getOrThrow(id);
    const available = existsSync(workdir.path) && statSync(workdir.path).isDirectory();
    if ((available && workdir.status !== 'available') || (!available && workdir.status !== 'missing')) {
      this.#db
        .prepare('update workdirs set status = ? where id = ?')
        .run(available ? 'available' : 'missing', id);
      return this.getOrThrow(id);
    }
    return workdir;
  }

  // 名称不可改：固定为所选文件夹的名字（ensureByPath 写入 basename）。
  update(
    id: string,
    patch: { protectRules?: WorkdirProtectRules; allowedPorts?: Workdir['allowedPorts'] },
  ): Workdir {
    this.getOrThrow(id);
    if (patch.protectRules !== undefined) {
      this.#db
        .prepare('update workdirs set protect_rules_json = ? where id = ?')
        .run(JSON.stringify(patch.protectRules), id);
    }
    if (patch.allowedPorts !== undefined) {
      this.#db
        .prepare('update workdirs set allowed_ports_json = ? where id = ?')
        .run(patch.allowedPorts === null ? null : JSON.stringify(patch.allowedPorts), id);
    }
    return this.getOrThrow(id);
  }

  /** Removes the record (run_changes cascade via FK; files untouched). */
  remove(id: string): void {
    this.getOrThrow(id);
    this.#db.prepare('delete from workdirs where id = ?').run(id);
  }

  /** Ids of conversations still bound to this workdir (unbind on remove). */
  conversationsBound(id: string): string[] {
    const rows = this.#db
      .prepare('select id from conversations where workdir_id = ?')
      .all(id) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // --- run changes ----------------------------------------------------------

  recordChange(change: {
    runId: string;
    workdirId: string;
    conversationId: string | null;
    beforeOid: string;
    afterOid: string | null;
    files: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>;
  }): RunChange {
    this.#db
      .prepare(
        'insert into run_changes (run_id, workdir_id, conversation_id, before_oid, after_oid, files_json, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(run_id) do update set workdir_id = excluded.workdir_id, conversation_id = excluded.conversation_id, before_oid = excluded.before_oid, after_oid = excluded.after_oid, files_json = excluded.files_json, reverted_at = null',
      )
      .run(
        change.runId,
        change.workdirId,
        change.conversationId,
        change.beforeOid,
        change.afterOid,
        JSON.stringify(change.files),
        this.#clock.now(),
      );
    return this.getChangeOrThrow(change.runId);
  }

  markReverted(runId: string): void {
    this.#db.prepare('update run_changes set reverted_at = ? where run_id = ?').run(this.#clock.now(), runId);
  }

  getChange(runId: string): RunChange | null {
    const row = this.#db.prepare('select * from run_changes where run_id = ?').get(runId) as
      | RunChangeRow
      | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      workdirId: row.workdir_id,
      conversationId: row.conversation_id,
      beforeOid: row.before_oid,
      afterOid: row.after_oid,
      files: row.files_json ? (JSON.parse(row.files_json) as RunChange['files']) : [],
      revertedAt: row.reverted_at,
      createdAt: row.created_at,
    };
  }

  getChangeOrThrow(runId: string): RunChange {
    const change = this.getChange(runId);
    if (!change) throw new AppError('NOT_FOUND', `没有 ${runId} 的改动记录`);
    return change;
  }

  deleteChangesForConversation(conversationId: string): void {
    this.#db.prepare('delete from run_changes where conversation_id = ?').run(conversationId);
  }
}

/** Creates the parent directory of a checkpoint repo (data-dir side only). */
export function ensureCheckpointsParent(checkpointsPath: string): void {
  const parent = path.dirname(checkpointsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

/** Lists top-level names of a directory (context injection helper). */
export function topLevelEntries(dir: string, limit: number): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).slice(0, limit).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return [];
  }
}

/** Removes a directory tree if it exists (checkpoint cleanup). */
export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
