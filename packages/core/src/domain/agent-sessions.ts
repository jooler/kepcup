import type { SqliteDatabase } from '../infra/db.js';

/**
 * 外部智能体会话复用记录（D72 P5，design 28 §7，表建于 main 0017）：每个
 * (Bot, 对话, Agent) 至多一条。`fingerprint` 覆盖会话级参数（提示词、cwd、
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
    agentSessionId: row.agent_session_id,
    fingerprint: row.fingerprint,
    lastRunId: row.last_run_id,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export class AgentSessionsStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(botId: string, conversationId: string, agentId: string): AgentSessionRow | null {
    const row = this.db
      .prepare(
        'select * from agent_sessions where bot_id = ? and conversation_id = ? and agent_id = ?',
      )
      .get(botId, conversationId, agentId) as Row | undefined;
    return row !== undefined ? toRow(row) : null;
  }

  /** Inserts or replaces the (Bot, conversation, Agent) row. */
  upsert(row: AgentSessionRow): void {
    this.db
      .prepare(
        `insert into agent_sessions (id, bot_id, conversation_id, agent_id, agent_session_id, fingerprint, last_run_id, last_used_at, created_at)
         values (@id, @botId, @conversationId, @agentId, @agentSessionId, @fingerprint, @lastRunId, @lastUsedAt, @createdAt)
         on conflict (bot_id, conversation_id, agent_id) do update set
           id = excluded.id, agent_session_id = excluded.agent_session_id,
           fingerprint = excluded.fingerprint, last_run_id = excluded.last_run_id,
           last_used_at = excluded.last_used_at, created_at = excluded.created_at`,
      )
      .run(row);
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

  listByBot(botId: string): AgentSessionRow[] {
    return (
      this.db.prepare('select * from agent_sessions where bot_id = ?').all(botId) as Row[]
    ).map(toRow);
  }
}
