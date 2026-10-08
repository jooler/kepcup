import type { SqliteDatabase } from '../infra/db.js';

/**
 * 外部智能体会话复用记录（D72 P5，design 28 §7，表建于 main 0017；D75 按任务
 * 分，main 0019，design 30 §8.5）：每个 (Bot, 对话, Agent, 任务) 至多一条——
 * 任务各占自己的会话，`taskId === null` 的行属于非任务 run（D72 的响应 run）。
 * `continues_task_id` 接续时旧行改挂新任务（`inheritTask`）。`fingerprint`
 * 覆盖会话级参数（提示词、cwd、
 * 档位、模型 / effort、能力集合、工具集合、桥 server 名），变化即新建会话；
 * 桥 server 名由行 id 派生（`hostServerNameFor(id)`），换会话 = 换行 id。
 * 不设外键：删除对话 / Bot / 移出群时由 lifecycle 经 orchestrator 清理（并尽力
 * `session/delete`）。
 */
export interface AgentSessionRow {
  id: string;
  botId: string;
  conversationId: string;
  agentId: string;
  /** The task run owning the session; null = a non-task run's session. */
  taskId: string | null;
  agentSessionId: string;
  fingerprint: string;
  lastRunId: string | null;
  lastUsedAt: number;
  createdAt: number;
}

interface Row {
  id: string;
  bot_id: string;
  conversation_id: string;
  agent_id: string;
  task_id: string;
  agent_session_id: string;
  fingerprint: string;
  last_run_id: string | null;
  last_used_at: number;
  created_at: number;
}

function toRow(row: Row): AgentSessionRow {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    taskId: row.task_id.length > 0 ? row.task_id : null,
    agentSessionId: row.agent_session_id,
    fingerprint: row.fingerprint,
    lastRunId: row.last_run_id,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export class AgentSessionsStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(
    botId: string,
    conversationId: string,
    agentId: string,
    taskId: string | null,
  ): AgentSessionRow | null {
    const row = this.db
      .prepare(
        'select * from agent_sessions where bot_id = ? and conversation_id = ? and agent_id = ? and task_id = ?',
      )
      .get(botId, conversationId, agentId, taskId ?? '') as Row | undefined;
    return row !== undefined ? toRow(row) : null;
  }

  /**
   * `continues_task_id` (design 30 §8.5 继承): the source task's row moves to
   * the new task — one UPDATE; null when the source has no row or the new
   * task already has one (the caller then starts a new session).
   */
  inheritTask(
    botId: string,
    conversationId: string,
    agentId: string,
    fromTaskId: string,
    toTaskId: string,
  ): AgentSessionRow | null {
    try {
      const changed = this.db
        .prepare(
          'update agent_sessions set task_id = ? where bot_id = ? and conversation_id = ? and agent_id = ? and task_id = ?',
        )
        .run(toTaskId, botId, conversationId, agentId, fromTaskId).changes;
      if (changed === 0) return null;
    } catch {
      // The new task has a row already (unique key): keep both as they are.
      return null;
    }
    return this.get(botId, conversationId, agentId, toTaskId);
  }

  getById(id: string): AgentSessionRow | null {
    const row = this.db.prepare('select * from agent_sessions where id = ?').get(id) as
      Row | undefined;
    return row !== undefined ? toRow(row) : null;
  }

  /** Removes the rows of one agent session (invalidated by the engine); returns them. */
  deleteByAgentSession(agentId: string, agentSessionId: string): AgentSessionRow[] {
    const rows = (
      this.db
        .prepare('select * from agent_sessions where agent_id = ? and agent_session_id = ?')
        .all(agentId, agentSessionId) as Row[]
    ).map(toRow);
    for (const row of rows) this.delete(row.id);
    return rows;
  }

  /** Inserts or replaces the (Bot, conversation, Agent, task) row. */
  upsert(row: AgentSessionRow): void {
    this.db
      .prepare(
        `insert into agent_sessions (id, bot_id, conversation_id, agent_id, task_id, agent_session_id, fingerprint, last_run_id, last_used_at, created_at)
         values (@id, @botId, @conversationId, @agentId, @taskId, @agentSessionId, @fingerprint, @lastRunId, @lastUsedAt, @createdAt)
         on conflict (bot_id, conversation_id, agent_id, task_id) do update set
           id = excluded.id, agent_session_id = excluded.agent_session_id,
           fingerprint = excluded.fingerprint, last_run_id = excluded.last_run_id,
           last_used_at = excluded.last_used_at, created_at = excluded.created_at`,
      )
      .run({ ...row, taskId: row.taskId ?? '' });
  }

  /** A run of the session ended (the reuse window counts from here). */
  touch(id: string, lastRunId: string, lastUsedAt: number): void {
    this.db
      .prepare('update agent_sessions set last_run_id = ?, last_used_at = ? where id = ?')
      .run(lastRunId, lastUsedAt, id);
  }

  delete(id: string): void {
    this.db.prepare('delete from agent_sessions where id = ?').run(id);
  }

  listByConversation(conversationId: string): AgentSessionRow[] {
    return (
      this.db
        .prepare('select * from agent_sessions where conversation_id = ?')
        .all(conversationId) as Row[]
    ).map(toRow);
  }

  /** Rows of task sessions (the reaper closes expired ones, design 30 §8.5). */
  listTaskSessions(): AgentSessionRow[] {
    return (this.db.prepare("select * from agent_sessions where task_id != ''").all() as Row[]).map(
      toRow,
    );
  }

  listByBot(botId: string): AgentSessionRow[] {
    return (
      this.db.prepare('select * from agent_sessions where bot_id = ?').all(botId) as Row[]
    ).map(toRow);
  }
}
