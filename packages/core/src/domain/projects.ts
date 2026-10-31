import {
  AppError,
  PROJECT_GOAL_MAX_CHARS,
  PROJECT_MEMBER_PREVIEW_MAX,
  newId,
  normalizeBotAvatarMask,
  type Bot,
  type BotAvatarMask,
  type Conversation,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { BotsService } from './bots.js';
import type { ConversationsService } from './conversations.js';

export interface ProjectMember {
  bot: Bot;
  joinedAt: number;
}

/** 注入模型校验用的插件目录（`PluginStore` 的子集，由 start.ts 接线）。 */
export interface PluginDirectory {
  installed(id: string): boolean;
}

export interface ProjectsDeps {
  db: SqliteDatabase;
  clock: Clock;
  conversations: ConversationsService;
  bots: BotsService;
  /** Removal cascade (workspace / grants / approvals / runs) lives in lifecycle. */
  removeMemberCascade(conversationId: string, botId: string): Promise<void>;
  publishConversation(conversationId: string): void;
  /** Visible (non-internal) system message in the conversation; Bots see it in context. */
  appendSystemEvent(input: { conversationId: string; event: string; text: string }): void;
  /** Label of the conversation's bound workdir (for the "member joined" message), or null. */
  workdirLabelOf(conversationId: string): string | null;
  /** P2 注入模型：`projects.plugins.set` 写后广播（扩展中心 / 右栏刷新）。 */
  emitPluginsChanged(pluginIds: string[]): void;
}

interface MemberRow {
  conversation_id: string;
  bot_id: string;
  joined_at: number;
}

/**
 * Project conversations (D92 T1a, docs/design/41-project-team.md): one goal,
 * a mandatory non-butler lead among the members, membership changes. Deletion
 * reuses the conversation cascade. The butler is never a participant.
 */
export class ProjectsService {
  /** P2 注入模型：插件目录（`installed(id)` 校验写 RPC 的 pluginIds）；start.ts 在插件账本构造后接入。 */
  #pluginDirectory: PluginDirectory | null = null;

  constructor(private readonly deps: ProjectsDeps) {}

  /** P2：接入插件目录（`PluginStore`），`setPlugins` 校验 pluginIds 均已安装。 */
  attachPluginDirectory(directory: PluginDirectory): void {
    this.#pluginDirectory = directory;
  }

  create(input: {
    title: string;
    goal?: string | null;
    leadBotId: string;
    memberBotIds: string[];
  }): Conversation {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new AppError('INVALID_INPUT', '项目组名称不能为空');
    }
    this.#validateGoal(input.goal);
    const unique = [...new Set(input.memberBotIds)];
    if (unique.length < 2) {
      throw new AppError('INVALID_INPUT', '项目组至少需要 2 个成员（含负责人）');
    }
    if (!unique.includes(input.leadBotId)) {
      throw new AppError('INVALID_INPUT', '负责人必须是项目成员');
    }
    for (const botId of unique) {
      const bot = this.deps.bots.get(botId);
      if (!bot || bot.status !== 'active') {
        throw new AppError('NOT_FOUND', `Bot ${botId} 不存在或已删除`);
      }
      if (bot.systemRole === 'butler') {
        throw new AppError('INVALID_INPUT', '管家不能加入项目组');
      }
    }

    const id = newId('conv');
    const now = this.deps.clock.now();
    const run = this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          "insert into conversations (id, type, title, goal, lead_bot_id, created_at) values (?, 'project', ?, ?, ?, ?)",
        )
        .run(id, title, input.goal?.trim() || null, input.leadBotId, now);
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

  /** Replaces the lead with an existing member (a visible system event follows). */
  setLead(conversationId: string, botId: string): Conversation {
    const conversation = this.#requireProject(conversationId);
    const bot = this.deps.bots.get(botId);
    if (!bot || bot.status !== 'active') {
      throw new AppError('NOT_FOUND', `Bot ${botId} 不存在或已删除`);
    }
    if (bot.systemRole === 'butler') {
      throw new AppError('INVALID_INPUT', '管家不能加入项目组');
    }
    if (!this.deps.conversations.memberBotIds(conversationId).includes(botId)) {
      throw new AppError('NOT_FOUND', '该 Bot 不是项目成员');
    }
    if (conversation.leadBotId === botId) return conversation;

    this.deps.db
      .prepare('update conversations set lead_bot_id = ? where id = ?')
      .run(botId, conversationId);
    const name = bot.profile.identity.name || bot.name;
    this.deps.appendSystemEvent({
      conversationId,
      event: 'project_lead_changed',
      text: `负责人已更换为 ${name}`,
    });
    const updated = this.deps.conversations.getOrThrow(conversationId);
    this.deps.publishConversation(conversationId);
    return updated;
  }

  update(conversationId: string, patch: { title?: string; goal?: string | null }): Conversation {
    this.#requireProject(conversationId);
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length === 0) {
        throw new AppError('INVALID_INPUT', '项目组名称不能为空');
      }
      this.deps.db
        .prepare('update conversations set title = ? where id = ?')
        .run(title, conversationId);
    }
    if (patch.goal !== undefined) {
      this.#validateGoal(patch.goal);
      this.deps.db
        .prepare('update conversations set goal = ? where id = ?')
        .run(patch.goal?.trim() || null, conversationId);
    }
    const conversation = this.deps.conversations.getOrThrow(conversationId);
    this.deps.publishConversation(conversationId);
    return conversation;
  }

  addMembers(conversationId: string, botIds: string[]): ProjectMember[] {
    this.#requireProject(conversationId);
    const existing = new Set(this.deps.conversations.memberBotIds(conversationId));
    const now = this.deps.clock.now();
    const joined: string[] = [];
    const run = this.deps.db.transaction(() => {
      for (const botId of [...new Set(botIds)]) {
        if (existing.has(botId)) continue;
        const bot = this.deps.bots.get(botId);
        if (!bot || bot.status !== 'active') {
          throw new AppError('NOT_FOUND', `Bot ${botId} 不存在或已删除`);
        }
        if (bot.systemRole === 'butler') {
          throw new AppError('INVALID_INPUT', '管家不能加入项目组');
        }
        this.deps.db
          .prepare(
            'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
          )
          .run(conversationId, botId, now);
        joined.push(botId);
      }
    });
    run.immediate();
    // One visible system event per new member (Bots see it in context).
    const workdirLabel = this.deps.workdirLabelOf(conversationId);
    for (const botId of joined) {
      const bot = this.deps.bots.get(botId);
      const name = bot ? (bot.profile.identity.name || bot.name) : botId;
      const text =
        workdirLabel === null
          ? `${name} 已加入项目组`
          : `${name} 已加入项目组，获得工作目录「${workdirLabel}」的读写权限`;
      this.deps.appendSystemEvent({ conversationId, event: 'project_member_joined', text });
    }
    const members = this.members(conversationId);
    this.deps.publishConversation(conversationId);
    return members;
  }

  /** Validates membership, then runs the removal cascade (03-data-model.md). */
  async removeMember(conversationId: string, botId: string): Promise<void> {
    const conversation = this.#requireProject(conversationId);
    if (!this.deps.conversations.memberBotIds(conversationId).includes(botId)) {
      throw new AppError('NOT_FOUND', '该 Bot 不是项目成员');
    }
    if (conversation.leadBotId === botId) {
      throw new AppError('PROJECT_LEAD_REQUIRED', '请先更换项目负责人');
    }
    await this.deps.removeMemberCascade(conversationId, botId);
    this.deps.publishConversation(conversationId);
  }

  members(conversationId: string): ProjectMember[] {
    const rows = this.deps.db
      .prepare(
        // bot_id breaks join-time ties (a project's founders share one joined_at)
        // so this order matches memberPreviews() — the avatar layout seeds on it.
        'select m.bot_id as bot_id, m.joined_at as joined_at from conversation_members m where m.conversation_id = ? order by m.joined_at, m.bot_id',
      )
      .all(conversationId) as MemberRow[];
    const members: ProjectMember[] = [];
    for (const row of rows) {
      const bot = this.deps.bots.get(row.bot_id);
      if (bot) members.push({ bot, joinedAt: row.joined_at });
    }
    return members;
  }

  /**
   * Avatar previews for list views (`Conversation.memberPreviews`): the first
   * `limit` members in join order, from one joined query — no per-member
   * `bots.get` / profile parse on every `conversations.list`.
   */
  memberPreviews(
    conversationId: string,
    limit: number = PROJECT_MEMBER_PREVIEW_MAX,
  ): Array<{ id: string; name: string; avatar: string | null; avatarMask: BotAvatarMask }> {
    const rows = this.deps.db
      .prepare(
        'select b.id as id, b.name as name, b.avatar as avatar, b.avatar_mask as avatarMask from conversation_members m join bots b on b.id = m.bot_id where m.conversation_id = ? order by m.joined_at, m.bot_id limit ?',
      )
      .all(conversationId, limit) as Array<{
      id: string;
      name: string;
      avatar: string | null;
      avatarMask: string | null;
    }>;
    return rows.map((row) => ({ ...row, avatarMask: normalizeBotAvatarMask(row.avatarMask) }));
  }

  /**
   * P2 注入模型：该项目会话内叠加授权的插件 id（`project_plugins`，按 plugin_id
   * 排序稳定）。读路径——运行时装配一次读取，不进缓存。
   */
  pluginsOf(conversationId: string): string[] {
    const rows = this.deps.db
      .prepare('select plugin_id from project_plugins where conversation_id = ? order by plugin_id')
      .all(conversationId) as Array<{ plugin_id: string }>;
    return rows.map((row) => row.plugin_id);
  }

  /**
   * P2 注入模型：整体替换该项目的叠加授权集（`projects.plugins.set`）。会话必须是
   * 项目组；每个 pluginId 都须已安装（经注入的插件目录）。只对「该项目会话内的
   * 对话轮与任务」生效，不修改成员 Bot 的个人配置。
   */
  setPlugins(conversationId: string, pluginIds: string[]): string[] {
    this.#requireProject(conversationId);
    const unique = [...new Set(pluginIds)].sort();
    // 与 setBotPlugins 一致：新旧并集广播，被移除的插件视图同样要刷新。
    const previous = new Set(this.pluginsOf(conversationId));
    for (const pluginId of unique) {
      if (!this.#pluginDirectory?.installed(pluginId)) {
        throw new AppError('INVALID_INPUT', `插件 ${pluginId} 未安装，不能授权给项目组`);
      }
    }
    const run = this.deps.db.transaction(() => {
      this.deps.db
        .prepare('delete from project_plugins where conversation_id = ?')
        .run(conversationId);
      for (const pluginId of unique) {
        this.deps.db
          .prepare('insert into project_plugins (conversation_id, plugin_id) values (?, ?)')
          .run(conversationId, pluginId);
      }
    });
    run.immediate();
    this.deps.publishConversation(conversationId);
    this.deps.emitPluginsChanged([...new Set([...unique, ...previous])]);
    return unique;
  }

  /**
   * D105 P2：插件卸载时清掉所有项目对该 id 的叠加授权（幂等；行级删除即可，
   * 各项目视图经 conversation 事件刷新）。
   */
  removePluginFromAll(pluginId: string): void {
    const rows = this.deps.db
      .prepare('select distinct conversation_id from project_plugins where plugin_id = ?')
      .all(pluginId) as Array<{ conversation_id: string }>;
    this.deps.db.prepare('delete from project_plugins where plugin_id = ?').run(pluginId);
    for (const row of rows) this.deps.publishConversation(row.conversation_id);
  }

  leadOf(conversationId: string): string | null {
    const row = this.deps.db
      .prepare('select lead_bot_id as lead_bot_id from conversations where id = ?')
      .get(conversationId) as { lead_bot_id: string | null } | undefined;
    return row?.lead_bot_id ?? null;
  }

  ledProjectsOf(botId: string): Array<{ id: string; title: string | null }> {
    return this.deps.db
      .prepare(
        "select id, title from conversations where type = 'project' and lead_bot_id = ? order by created_at",
      )
      .all(botId) as Array<{ id: string; title: string | null }>;
  }

  #requireProject(conversationId: string): Conversation {
    const conversation = this.deps.conversations.getOrThrow(conversationId);
    if (conversation.type !== 'project') {
      throw new AppError('INVALID_INPUT', '该会话不是项目组');
    }
    return conversation;
  }

  #validateGoal(goal: string | null | undefined): void {
    if (goal !== undefined && goal !== null && goal.length > PROJECT_GOAL_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', `项目目标不能超过 ${PROJECT_GOAL_MAX_CHARS} 字`);
    }
  }
}
