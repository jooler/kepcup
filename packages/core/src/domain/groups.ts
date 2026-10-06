import { AppError, newId, type Bot, type Conversation } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { BotsService } from './bots.js';
import type { ConversationsService } from './conversations.js';

export interface GroupMember {
  bot: Bot;
  joinedAt: number;
}

export interface GroupsDeps {
  db: SqliteDatabase;
  clock: Clock;
  conversations: ConversationsService;
  bots: BotsService;
  /** Removal cascade (workspace / grants / approvals / runs) lives in lifecycle. */
  removeMemberCascade(conversationId: string, botId: string): Promise<void>;
  /** Publishes conversation.updated after membership changes. */
  publishConversation(conversationId: string): void;
}
/** Member rows of a conversation with join time. */
interface MemberRow {
  conversation_id: string;
  bot_id: string;
  joined_at: number;
}

/**
 * Group conversations (P05): creation with at least two members, rename,
 * membership changes. Deletion reuses the conversation cascade.
 */
export class GroupsService {
  constructor(private readonly deps: GroupsDeps) {}

  create(input: { title: string; memberBotIds: string[]; description?: string }): Conversation {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new AppError('INVALID_INPUT', '群名称不能为空');
    }
    const unique = [...new Set(input.memberBotIds)];
    if (unique.length < 2) {
      throw new AppError('INVALID_INPUT', '群聊至少需要 2 个成员');
    }
    for (const botId of unique) {
      const bot = this.deps.bots.get(botId);
      if (!bot || bot.status !== 'active') {
        throw new AppError('NOT_FOUND', `Bot ${botId} 不存在或已删除`);
      }
    }

    const id = newId('conv');
    const now = this.deps.clock.now();
    const run = this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          "insert into conversations (id, type, title, description, created_at) values (?, 'group', ?, ?, ?)",
        )
        .run(id, title, input.description?.trim() || null, now);
      for (const botId of unique) {
        this.deps.db
          .prepare(
            'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
          )
          .run(id, botId, now);
      }
    });
    run.immediate();
    const conversation = this.deps.conversations.getOrThrow(id);
    this.deps.publishConversation(id);
    return conversation;
  }

  /**
   * 对话内群创建（design/19 D60）第一步：创建 `setup_state='creating'` 的群
   * 对话——暂无名称与成员，问题卡片由 orchestrator 逐题下发；成员在成员步
   * 作答时经 addMembers 落行，完成时 finalizeSetup 一次性生效。
   */
  createSetup(): Conversation {
    const id = newId('conv');
    const now = this.deps.clock.now();
    const run = this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          "insert into conversations (id, type, setup_state, created_at) values (?, 'group', 'creating', ?)",
        )
        .run(id, now);
    });
    run.immediate();
    const conversation = this.deps.conversations.getOrThrow(id);
    this.deps.publishConversation(id);
    return conversation;
  }

  /**
   * 群创建完成落点（project 步作答后由 orchestrator 调用）：名称与定位描述
   * 一次性写入、清 setup_state；标题校验与 create 一致。
   */
  finalizeSetup(
    conversationId: string,
    input: { title: string; description: string },
  ): Conversation {
    const conversation = this.#requireGroup(conversationId);
    if (conversation.setupState !== 'creating') {
      throw new AppError('INVALID_INPUT', '该群聊不在创建流程中');
    }
    const title = input.title.trim();
    if (title.length === 0) {
      throw new AppError('INVALID_INPUT', '群名称不能为空');
    }
    const run = this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          'update conversations set title = ?, description = ?, setup_state = NULL where id = ?',
        )
        .run(title, input.description.trim(), conversationId);
    });
    run.immediate();
    const updated = this.deps.conversations.getOrThrow(conversationId);
    this.deps.publishConversation(conversationId);
    return updated;
  }

  rename(conversationId: string, title: string): Conversation {
    this.#requireGroup(conversationId);
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new AppError('INVALID_INPUT', '群名称不能为空');
    }
    this.deps.db
      .prepare('update conversations set title = ? where id = ?')
      .run(trimmed, conversationId);
    const conversation = this.deps.conversations.getOrThrow(conversationId);
    this.deps.publishConversation(conversationId);
    return conversation;
  }

  addMembers(conversationId: string, botIds: string[]): GroupMember[] {
    this.#requireGroup(conversationId);
    const existing = new Set(this.deps.conversations.memberBotIds(conversationId));
    const now = this.deps.clock.now();
    const run = this.deps.db.transaction(() => {
      for (const botId of [...new Set(botIds)]) {
        if (existing.has(botId)) continue;
        const bot = this.deps.bots.get(botId);
        if (!bot || bot.status !== 'active') {
          throw new AppError('NOT_FOUND', `Bot ${botId} 不存在或已删除`);
        }
        this.deps.db
          .prepare(
            'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
          )
          .run(conversationId, botId, now);
      }
    });
    run.immediate();
    const members = this.members(conversationId);
    this.deps.publishConversation(conversationId);
    return members;
  }

  /** Validates membership, then runs the removal cascade (03-data-model.md). */
  async removeMember(conversationId: string, botId: string): Promise<void> {
    this.#requireGroup(conversationId);
    if (!this.deps.conversations.memberBotIds(conversationId).includes(botId)) {
      throw new AppError('NOT_FOUND', '该 Bot 不是群成员');
    }
    await this.deps.removeMemberCascade(conversationId, botId);
    this.deps.publishConversation(conversationId);
  }

  members(conversationId: string): GroupMember[] {
    const rows = this.deps.db
      .prepare(
        'select m.bot_id as bot_id, m.joined_at as joined_at from conversation_members m where m.conversation_id = ? order by m.joined_at',
      )
      .all(conversationId) as MemberRow[];
    const members: GroupMember[] = [];
    for (const row of rows) {
      const bot = this.deps.bots.get(row.bot_id);
      if (bot) members.push({ bot, joinedAt: row.joined_at });
    }
    return members;
  }

  #requireGroup(conversationId: string): Conversation {
    const conversation = this.deps.conversations.getOrThrow(conversationId);
    if (conversation.type !== 'group') {
      throw new AppError('INVALID_INPUT', '该对话不是群聊');
    }
    return conversation;
  }
}
