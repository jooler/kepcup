import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import {
  AppError,
  newId,
  PROJECT_DEFAULT_PROTECT_RULES,
  PROJECTS_RECENT_LIMIT,
  type Project,
  type ProjectProtectRules,
  type RunChange,
} from '@kepcup/shared';
import { canonicalPath } from '../infra/paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ProjectRow {
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
  project_id: string;
  conversation_id: string | null;
  before_oid: string;
  after_oid: string | null;
  files_json: string | null;
  reverted_at: number | null;
  created_at: number;
}

function parseProtectRules(raw: string): ProjectProtectRules {
  // On-disk JSON written only through this service; fall closed to defaults.
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectProtectRules>;
    return {
      denyRead: Array.isArray(parsed.denyRead) ? parsed.denyRead : [...PROJECT_DEFAULT_PROTECT_RULES.denyRead],
      denyWrite: Array.isArray(parsed.denyWrite) ? parsed.denyWrite : [],
    };
  } catch {
    return { denyRead: [...PROJECT_DEFAULT_PROTECT_RULES.denyRead], denyWrite: [] };
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    protectRules: parseProtectRules(row.protect_rules_json),
    allowedPorts: row.allowed_ports_json ? (JSON.parse(row.allowed_ports_json) as Project['allowedPorts']) : null,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Projects (docs/design/08-project.md "实体"): local directories bound to
 * conversations. One row per realpath; the selector lists recent ones.
 */
export class ProjectsService {
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
  ensureByPath(dir: string, dataHome: string): Project {
    const resolved = canonicalPath(dir);
    let stats;
    try {
      stats = statSync(resolved);
    } catch {
      throw new AppError('PROJECT_MISSING', `目录不存在或不可访问：${dir}`);
    }
    if (!stats.isDirectory()) {
      throw new AppError('INVALID_INPUT', 'project 必须是一个目录');
    }
    if (resolved === dataHome || resolved.startsWith(dataHome.endsWith('/') ? dataHome : `${dataHome}/`)) {
      throw new AppError('PATH_OUT_OF_SCOPE', '应用数据目录不能作为 project');
    }

    const now = this.#clock.now();
    const existing = this.#db.prepare('select * from projects where path = ?').get(resolved) as
      | ProjectRow
      | undefined;
    if (existing) {
      if (existing.status !== 'available') {
        this.#db.prepare("update projects set status = 'available' where id = ?").run(existing.id);
      }
      this.#db.prepare('update projects set last_used_at = ? where id = ?').run(now, existing.id);
      // 名称固定为文件夹名（不再可改）：把改名功能时期留下的自定义名一并矫正。
      if (existing.name !== path.basename(resolved)) {
        this.#db
          .prepare('update projects set name = ? where id = ?')
          .run(path.basename(resolved), existing.id);
      }
      return this.getOrThrow(existing.id);
    }
    const id = newId('prj');
    this.#db
      .prepare(
        'insert into projects (id, path, name, protect_rules_json, allowed_ports_json, status, created_at, last_used_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        resolved,
        path.basename(resolved),
        JSON.stringify(PROJECT_DEFAULT_PROTECT_RULES),
        null,
        'available',
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): Project | null {
    const row = this.#db.prepare('select * from projects where id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  }

  getOrThrow(id: string): Project {
    const project = this.get(id);
    if (!project) throw new AppError('NOT_FOUND', `Project ${id} does not exist`);
    return project;
  }

  /** Most recently used projects (selector). */
  listRecent(limit: number = PROJECTS_RECENT_LIMIT): Project[] {
    const rows = this.#db
      .prepare('select * from projects order by last_used_at desc limit ?')
      .all(limit) as ProjectRow[];
    return rows.map(rowToProject);
  }

  /** Refreshes `status` from disk; returns the updated record. */
  refreshStatus(id: string): Project {
    const project = this.getOrThrow(id);
    const available = existsSync(project.path) && statSync(project.path).isDirectory();
    if ((available && project.status !== 'available') || (!available && project.status !== 'missing')) {
      this.#db
        .prepare('update projects set status = ? where id = ?')
        .run(available ? 'available' : 'missing', id);
      return this.getOrThrow(id);
    }
    return project;
  }

  // 名称不可改：固定为所选文件夹的名字（ensureByPath 写入 basename）。
  update(
    id: string,
    patch: { protectRules?: ProjectProtectRules; allowedPorts?: Project['allowedPorts'] },
  ): Project {
    this.getOrThrow(id);
    if (patch.protectRules !== undefined) {
      this.#db
        .prepare('update projects set protect_rules_json = ? where id = ?')
        .run(JSON.stringify(patch.protectRules), id);
    }
    if (patch.allowedPorts !== undefined) {
      this.#db
        .prepare('update projects set allowed_ports_json = ? where id = ?')
        .run(patch.allowedPorts === null ? null : JSON.stringify(patch.allowedPorts), id);
    }
    return this.getOrThrow(id);
  }

  /** Removes the record (run_changes cascade via FK; files untouched). */
  remove(id: string): void {
    this.getOrThrow(id);
    this.#db.prepare('delete from projects where id = ?').run(id);
  }

  /** Ids of conversations still bound to this project (unbind on remove). */
  conversationsBound(id: string): string[] {
    const rows = this.#db
      .prepare('select id from conversations where project_id = ?')
      .all(id) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // --- run changes ----------------------------------------------------------

  recordChange(change: {
    runId: string;
    projectId: string;
    conversationId: string | null;
    beforeOid: string;
    afterOid: string | null;
    files: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>;
  }): RunChange {
    this.#db
      .prepare(
        'insert into run_changes (run_id, project_id, conversation_id, before_oid, after_oid, files_json, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(run_id) do update set project_id = excluded.project_id, conversation_id = excluded.conversation_id, before_oid = excluded.before_oid, after_oid = excluded.after_oid, files_json = excluded.files_json, reverted_at = null',
      )
      .run(
        change.runId,
        change.projectId,
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
      projectId: row.project_id,
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
