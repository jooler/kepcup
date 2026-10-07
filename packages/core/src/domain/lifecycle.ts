import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import { workspacePathFor } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ConversationsService } from './conversations.js';
import type { MessagesService } from './messages.js';
import type { DraftsService } from './drafts.js';
import type { AttachmentsService } from './attachments.js';
import type { JobsService } from './jobs.js';
import type { BotsService } from './bots.js';
import type { GrantsService } from '../permissions/grants.js';
import type { SqliteDatabase } from '../infra/db.js';

export interface LifecycleDeps {
  paths: AppPaths;
  logger: CoreLogger;
  mainDb: SqliteDatabase;
  runsDb: SqliteDatabase;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  drafts: DraftsService;
  attachments: AttachmentsService;
  jobs: JobsService;
  grants: GrantsService;
  /** Aborts active runs of a conversation / bot before rows are removed. */
  abortRunsForConversation(conversationId: string): Promise<void>;
  abortRunsForBot(botId: string): Promise<void>;
  /** Cancels one bot's runs in one conversation (P05 group removal). */
  abortRunsForBotInConversation(botId: string, conversationId: string): void;
  /** Notifies the group turn coordinator that a member left (P05). */
  onGroupMemberRemoved(botId: string, conversationId: string): void;
  /**
   * D71 cross-bot delegations: active ones touching the deleted conversation /
   * bot end as `cancelled` (rows kept; B's run aborted). Runs BEFORE the run
   * aborts so the settle hook stays silent. No-op when absent.
   */
  delegations?:
    | {
        onConversationDeleted(conversationId: string): void;
        prepareBotDeletion(botId: string): void;
      }
    | undefined;
  /** P07 memory cascades (承诺 void / 连接关闭), no-op when memory absent. */
  memory?:
    | {
        onConversationDeleted(conversationId: string, memberBotIds: string[]): void;
        onGroupMemberRemoved(botId: string, conversationId: string): void;
        prepareBotDeletion(botId: string): void;
        /** Deletion-dialog count; 0 without opening a missing database. */
        memoryItemCount(botId: string): number;
      }
    | undefined;
  /** P08 skills cascades (bot_skills rows + library GC), no-op when absent. */
  skills?:
    | {
        prepareBotDeletion(botId: string): void;
        /** Deletion-dialog count. */
        skillCount(botId: string): number;
      }
    | undefined;
  /** P09 wiki cascades (mutex drop + deletion-dialog count), no-op when absent. */
  wiki?:
    | {
        prepareBotDeletion(botId: string): void;
        wikiPageCount(botId: string): number;
      }
    | undefined;
  /** P10 schedule cascades (删除/取消任务), no-op when absent. */
  schedules?:
    | {
        deleteForConversation(conversationId: string): number;
        prepareBotDeletion(botId: string): number;
        cancelForBotInConversation(botId: string, conversationId: string): number;
      }
    | undefined;
  /**
   * D72 P5 external-agent sessions (agent_sessions rows + best-effort
   * `session/delete` on the agent side). The agents' own on-disk history is
   * not KepCup's to manage. No-op when absent.
   */
  agentSessions?:
    | {
        onConversationDeleted(conversationId: string): void;
        prepareBotDeletion(botId: string): void;
        onGroupMemberRemoved(botId: string, conversationId: string): void;
      }
    | undefined;
  /**
   * P11 browser cascades (close pages / clear the bot's session partition).
   * Runs after the runs of the deleted scope are aborted, so in-flight page
   * operations observe the close and fail cleanly (BR-P11 race protection:
   * permanent closes also tombstone the pair/bot against late ensurePage).
   */
  browser?:
    | {
        closeForConversation(conversationId: string, memberBotIds: string[]): Promise<void>;
        closeForBotInConversation(botId: string, conversationId: string): Promise<void>;
        prepareBotDeletion(botId: string): Promise<void>;
      }
    | undefined;
}

/**
 * Deletion cascades for P01/P02 (docs/dev/03-data-model.md "删除级联"). Later
 * phases extend these methods as their tables appear.
 */
export class LifecycleService {
  constructor(private readonly deps: LifecycleDeps) {}

  /** Runs one optional cascade; a failure is logged, never aborts the deletion. */
  #cascade(message: string, context: Record<string, string>, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.deps.logger.warn(
        { ...context, error: error instanceof Error ? error.message : String(error) },
        message,
      );
    }
  }

  /** Physically deletes a conversation and everything scoped to it. */
  async deleteConversation(conversationId: string): Promise<void> {
    const { mainDb, runsDb } = this.deps;
    const conv = this.deps.conversations.getOrThrow(conversationId);

    // D71: delegations sent from / delivered into this conversation end first
    // (before the aborts below, so their settle hook does not post cards).
    try {
      this.deps.delegations?.onConversationDeleted(conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { conversationId, error: error instanceof Error ? error.message : String(error) },
        'delegation conversation cascade failed',
      );
    }

    await this.deps.abortRunsForConversation(conversationId);
    this.#cascade('agent session conversation cascade failed', { conversationId }, () =>
      this.deps.agentSessions?.onConversationDeleted(conversationId),
    );

    // P07: commitments made in this conversation are void for every member
    // (docs/dev/03-data-model.md 删除级联) — while the member rows still exist.
    const memberBotIds = this.deps.conversations.memberBotIds(conversationId);
    try {
      this.deps.memory?.onConversationDeleted(conversationId, memberBotIds);
    } catch (error) {
      this.deps.logger.warn(
        { conversationId, error: error instanceof Error ? error.message : String(error) },
        'memory conversation cascade failed',
      );
    }

    // P11: the members' browser pages for this conversation are closed
    // (permanent — a late in-flight ensurePage cannot resurrect them).
    try {
      await this.deps.browser?.closeForConversation(conversationId, memberBotIds);
    } catch (error) {
      this.deps.logger.warn(
        { conversationId, error: error instanceof Error ? error.message : String(error) },
        'browser conversation cascade failed',
      );
    }

    // P10: the conversation's schedules are deleted (03-data-model 删除级联;
    // the FK also cascades on the conversations row delete below).
    try {
      this.deps.schedules?.deleteForConversation(conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { conversationId, error: error instanceof Error ? error.message : String(error) },
        'schedule conversation cascade failed',
      );
    }

    // Jobs are cancelled BEFORE the run rows: a reflection job claimed in
    // between would otherwise re-create a run row after the delete (P07).
    this.deps.jobs.cancelByConversation(conversationId);

    // Runs live in runs.db (cross-database references are id-only).
    runsDb.prepare('delete from runs where conversation_id = ?').run(conversationId);

    // FTS is not FK-linked; clear it explicitly, the rest cascades.
    mainDb.prepare('delete from messages_fts where conversation_id = ?').run(conversationId);
    // Approvals have no FK; clean them by hand. Pending ones were already
    // cancelled by abortRunsForConversation. Grants cascade via FK.
    mainDb.prepare('delete from approvals where conversation_id = ?').run(conversationId);
    // Run-change records (P04) have no FK on conversation_id; the project's
    // files and shadow repository are untouched (docs/dev/03-data-model.md).
    mainDb.prepare('delete from run_changes where conversation_id = ?').run(conversationId);
    // Chains cascade via FK (P05).
    mainDb.prepare('delete from conversations where id = ?').run(conversationId);
    this.deps.attachments.deleteConversationFiles(conversationId);
    this.#deleteConversationWorkspaces(conversationId);

    this.deps.logger.info({ conversationId, type: conv.type }, 'conversation deleted');
  }

  /** Every bot's workspace for this conversation (docs/dev/03-data-model.md, P02). */
  #deleteConversationWorkspaces(conversationId: string): void {
    const workspacesRoot = path.join(this.deps.paths.home, 'bots');
    try {
      const botDirs = readdirSync(workspacesRoot, { withFileTypes: true }).filter((e) =>
        e.isDirectory(),
      );
      for (const botDir of botDirs) {
        rmSync(path.join(workspacesRoot, botDir.name, 'workspaces', conversationId), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      // No bots directory (nothing created yet).
    }
  }

  /**
   * Deletes a bot: cancels its runs, turns its row into an id-only
   * placeholder, makes direct conversations read-only (queue cleared) and
   * removes the bot data directory. Message history is kept.
   */
  async deleteBot(botId: string): Promise<void> {
    const { runsDb, paths } = this.deps;
    const bot = this.deps.bots.getOrThrow(botId);
    // D70：管家不可删除——在任何级联（含中止 run）之前拒绝。
    if (bot.systemRole === 'butler') {
      throw new AppError('BOT_UNDELETABLE', '管家不能删除');
    }

    // D71: delegations this bot sent or received end before its runs abort.
    try {
      this.deps.delegations?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'delegation bot cascade failed',
      );
    }

    await this.deps.abortRunsForBot(botId);
    this.#cascade('agent session bot cascade failed', { botId }, () =>
      this.deps.agentSessions?.prepareBotDeletion(botId),
    );

    // Group memberships go first so the turn coordinator skips the bot in
    // every group it was in (docs/dev/03-data-model.md 删除 Bot, P05 row).
    const groupIds = this.groupConversationIdsOf(botId);
    for (const conversationId of groupIds) this.deps.onGroupMemberRemoved(botId, conversationId);
    this.deps.mainDb.prepare('delete from conversation_members where bot_id = ?').run(botId);

    for (const conv of this.deps.conversations.listDirectByBot(botId)) {
      this.deps.drafts.removeAll(conv.id);
      this.deps.conversations.setReadOnly(conv.id, true);
    }

    // P09: drain + drop the wiki maintenance mutex chain BEFORE the run rows
    // die — an in-flight maintenance loop still appends steps to its run and
    // writes the wiki, so it must settle first (BR-P09-010): run_steps has a
    // FOREIGN KEY on runs(id) and a step insert after the row was deleted
    // would throw inside the engine loop. After the drain the loop is fully
    // settled; queued maintenance observes the deletion through its own
    // re-checks (BR-P08-007), so it can never resurrect bots/{id}/wiki, and
    // the directory dies with bots/{id}/ below (03-data-model.md 删除 Bot:
    // bots/{id}/ 整个目录，含 wiki)。
    try {
      await this.deps.wiki?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'wiki bot cleanup failed',
      );
    }
    runsDb.prepare('delete from runs where bot_id = ?').run(botId);
    // The bot's background jobs go before the data they would write: a
    // skill_authoring job claimed after this point would otherwise re-create
    // bots/{id}/ directories and bot_skills rows (BR-P08-007; the running one
    // is handled by the pre-promote double-check in the authoring loop).
    this.deps.jobs.cancelByBot(botId);
    // P10: the bot's schedules are deleted alongside its jobs
    // (03-data-model.md 删除 Bot: "schedules、jobs | 删除 / 取消").
    try {
      this.deps.schedules?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'schedule bot cleanup failed',
      );
    }
    // P11: every page of the bot closes, the session partition storage and
    // its directory on disk are removed, and the bot is tombstoned so an
    // aborted run's late ensurePage fails instead of resurrecting the session.
    try {
      await this.deps.browser?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'browser bot cleanup failed',
      );
    }
    // Approval rows lose their bot context (placeholder bots keep no profile);
    // grants are deleted outright (docs/dev/03-data-model.md 删除级联, P03).
    this.deps.mainDb.prepare('update approvals set bot_id = null where bot_id = ?').run(botId);
    this.deps.grants.deleteForBot(botId);
    // P08: bot_skills rows go first; library versions only this bot referenced
    // are collected here (03-data-model.md 删除 Bot, P08 row). The authored
    // skills directory dies with bots/{id}/ below.
    try {
      this.deps.skills?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'skills bot cleanup failed',
      );
    }
    this.deps.bots.markDeleted(botId);
    // P07: close the pooled memory.db connection before the directory (which
    // contains memory.db) is removed. profile_items are kept (shared layer).
    try {
      this.deps.memory?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'memory bot cleanup failed',
      );
    }
    rmSync(path.join(paths.home, 'bots', botId), { recursive: true, force: true });

    this.deps.logger.info({ botId }, 'bot deleted');
  }

  /**
   * Removes one bot from one group and runs the per-conversation cascade
   * (docs/dev/03-data-model.md "从群中移除 Bot", P05): cancel its runs in this
   * conversation, delete the member row, revoke this pair's grants, delete
   * this pair's workspace. History messages stay (sender keeps its name).
   */
  async removeGroupMember(conversationId: string, botId: string): Promise<void> {
    this.deps.bots.getOrThrow(botId);
    this.deps.conversations.getOrThrow(conversationId);

    this.deps.onGroupMemberRemoved(botId, conversationId);
    this.#cascade('agent session group-removal cascade failed', { botId, conversationId }, () =>
      this.deps.agentSessions?.onGroupMemberRemoved(botId, conversationId),
    );

    // P07: the bot's commitments made in this group are voided.
    try {
      this.deps.memory?.onGroupMemberRemoved(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'memory group-removal cascade failed',
      );
    }

    // P10: the bot's schedules in this group are cancelled
    // (03-data-model.md 从群中移除 Bot).
    try {
      this.deps.schedules?.cancelForBotInConversation(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'schedule group-removal cascade failed',
      );
    }

    // P11: the bot's page for this group is closed (permanent — the pair's
    // workspace dies here too).
    try {
      await this.deps.browser?.closeForBotInConversation(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'browser group-removal cascade failed',
      );
    }

    this.deps.mainDb
      .prepare('delete from conversation_members where conversation_id = ? and bot_id = ?')
      .run(conversationId, botId);
    this.deps.grants.revokeForBotInConversation(botId, conversationId);
    this.deps.mainDb
      .prepare('update approvals set bot_id = null where bot_id = ? and conversation_id = ?')
      .run(botId, conversationId);
    rmSync(workspacePathFor(this.deps.paths, botId, conversationId), {
      recursive: true,
      force: true,
    });

    this.deps.logger.info({ conversationId, botId }, 'group member removed');
  }

  /**
   * Group conversation ids the bot currently belongs to. Public because the
   * RPC layer must capture them BEFORE deleteBot drops the member rows —
   * afterwards the affected groups are unenumerable, yet their open member
   * lists still need a conversation.updated push (deleted bot renders as id).
   */
  groupConversationIdsOf(botId: string): string[] {
    const rows = this.deps.mainDb
      .prepare(
        "select c.id as id from conversations c join conversation_members m on m.conversation_id = c.id where m.bot_id = ? and c.type = 'group'",
      )
      .all(botId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Stats shown in the confirmation dialog before deleting a bot. */
  deletionPreview(botId: string): {
    conversations: number;
    messages: number;
    memoryItems: number;
    wikiPages: number;
    skills: number;
  } {
    const { mainDb } = this.deps;
    const conversations = mainDb
      .prepare('select count(*) as n from conversations where direct_bot_id = ? and read_only = 0')
      .get(botId) as { n: number };
    const messages = mainDb
      .prepare('select count(*) as n from messages where sender_bot_id = ?')
      .get(botId) as { n: number };
    return {
      conversations: conversations.n,
      messages: messages.n,
      memoryItems: this.deps.memory?.memoryItemCount(botId) ?? 0,
      wikiPages: this.deps.wiki?.wikiPageCount(botId) ?? 0,
      skills: this.deps.skills?.skillCount(botId) ?? 0,
    };
  }
}
