import { readdirSync } from 'node:fs';
import { rmSync } from '../infra/fs-rm.js';
import path from 'node:path';
import { AppError } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import { projectRoot, workspacePathFor } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ConversationsService } from './conversations.js';
import type { MessagesService } from './messages.js';
import type { AttachmentsService } from './attachments.js';
import type { JobsService } from './jobs.js';
import type { BotsService } from './bots.js';
import type { ProjectsService } from './projects.js';
import type { GrantsService } from '../permissions/grants.js';
import type { SqliteDatabase } from '../infra/db.js';

export interface LifecycleDeps {
  paths: AppPaths;
  logger: CoreLogger;
  mainDb: SqliteDatabase;
  runsDb: SqliteDatabase;
  bots: BotsService;
  conversations: ConversationsService;
  /** Project membership lookups for the lead guard (D92 T1a). */
  projects: ProjectsService;

  messages: MessagesService;
  attachments: AttachmentsService;
  jobs: JobsService;
  grants: GrantsService;
  /** Aborts active runs of a conversation / bot before rows are removed. */
  abortRunsForConversation(conversationId: string): Promise<void>;
  abortRunsForBot(botId: string): Promise<void>;
  /** Cancels one bot's runs in one conversation (P05 member removal). */
  abortRunsForBotInConversation(botId: string, conversationId: string): void;
  /** Notifies the project turn coordinator that a member left (P05). */
  onProjectMemberRemoved(botId: string, conversationId: string): void;
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
  /**
   * D73 P1 app-tool grants (`app_tool_grants`): a deleted bot loses all of them, a bot
   * removed from a project loses the ones scoped to that conversation. Conversation
   * deletion cascades through the foreign key. No-op when absent.
   */
  appGrants?:
    | {
        revokeForBot(botId: string): number;
        revokeForBotInConversation(botId: string, conversationId: string): number;
      }
    | undefined;
  /**
   * D73 P2 taint rows (`app_taint`, no foreign keys): a deleted conversation loses all of its
   * rows, a deleted bot the rows of its own direct conversations (its project rows keep the
   * project's taint until they expire). No-op when absent.
   */
  taint?:
    | {
        deleteForConversation(conversationId: string): number;
        deleteForBotInConversations(botId: string, conversationIds: readonly string[]): number;
      }
    | undefined;
  /** P07 memory cascades (承诺 void / 连接关闭), no-op when memory absent. */
  memory?:
    | {
        onConversationDeleted(conversationId: string, memberBotIds: string[]): void;
        onProjectMemberRemoved(botId: string, conversationId: string): void;
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
        /** D92 T1b WP9: drains the project wiki's maintenance mutex. */
        prepareProjectDeletion(projectId: string): Promise<void>;
        wikiPageCount(botId: string): number;
      }
    | undefined;
  /**
   * D92 T1b WP9 project wiki index connections: a deleted project's wiki.db is
   * closed BEFORE its directory (and the file with it) is removed.
   */
  wikiIndex?:
    | {
        closeProject(projectId: string): void;
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
   * D90 workbench todos (no-op when absent): a deleted conversation / bot or a bot removed from
   * a project sends the todos that depended on it back to draft with a reason.
   */
  workbench?:
    | {
        /** Before the conversation row goes (the project FK is `ON DELETE SET NULL`). */
        onConversationDeleting(conversationId: string): void;
        /** After the bot / membership change took effect. */
        onExecutorChanged(): void;
      }
    | undefined;
  /** W7 watch cascades (删除监看), no-op when absent. */
  watches?:
    | {
        deleteForConversation(conversationId: string): number;
        prepareBotDeletion(botId: string): number;
        removeForBotInConversation(botId: string, conversationId: string): number;
      }
    | undefined;
  /** D84：删除 Bot 时去掉它的邮箱绑定，账号保留。 */
  mail?:
    | {
        prepareBotDeletion(botId: string): number;
      }
    | undefined;
  /**
   * D81 bot-widget cascades: conversation deletion cascades through the foreign
   * key (`widgets.conversation_id`); a deleted bot's rows go here — the bots
   * row becomes a tombstone, so `bot_id`'s FK never fires. No-op when absent.
   */
  widgets?:
    | {
        prepareBotDeletion(botId: string): number;
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
        onProjectMemberRemoved(botId: string, conversationId: string): void;
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
    this.#cascade('taint conversation cascade failed', { conversationId }, () =>
      this.deps.taint?.deleteForConversation(conversationId),
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

    // D90: todos assigned to this project (or scheduled in it) fall back to draft before the FK
    // nulls their assignee column and the schedules disappear.
    this.#cascade('workbench conversation cascade failed', { conversationId }, () =>
      this.deps.workbench?.onConversationDeleting(conversationId),
    );
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
    // W7: the conversation's watches are deleted (FK cascades too; this also
    // tells the interface and re-arms the worker).
    try {
      this.deps.watches?.deleteForConversation(conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { conversationId, error: error instanceof Error ? error.message : String(error) },
        'watch conversation cascade failed',
      );
    }

    // D92 T1b WP9: a project wiki's in-flight maintenance keeps owning the
    // wiki until it settles — drain the mutex before the rows / directory go
    // (queued wiki jobs are cancelled right below).
    if (conv.type === 'project') {
      try {
        await this.deps.wiki?.prepareProjectDeletion(conversationId);
      } catch (error) {
        this.deps.logger.warn(
          { conversationId, error: error instanceof Error ? error.message : String(error) },
          'wiki project cleanup failed',
        );
      }
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
    // Run-change records (P04) have no FK on conversation_id; the workdir's
    // files and shadow repository are untouched (docs/dev/03-data-model.md).
    mainDb.prepare('delete from run_changes where conversation_id = ?').run(conversationId);
    // Chains cascade via FK (P05).
    mainDb.prepare('delete from conversations where id = ?').run(conversationId);
    this.deps.attachments.deleteConversationFiles(conversationId);
    this.#deleteConversationWorkspaces(conversationId);

    // D92 T1b WP9: the project wiki (git), wiki-store and wiki.db die together
    // with the project; the pooled connection closes BEFORE the file is removed.
    if (conv.type === 'project') {
      this.#cascade('project wiki index close failed', { conversationId }, () =>
        this.deps.wikiIndex?.closeProject(conversationId),
      );
      rmSync(projectRoot(this.deps.paths, conversationId), { recursive: true, force: true });
    }

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
    // D92 T1a：项目组负责人不可删除——先更换负责人（同管家守卫，任何级联之前）。
    const ledProjects = this.deps.projects.ledProjectsOf(botId);
    if (ledProjects.length > 0) {
      throw new AppError('PROJECT_LEAD_REQUIRED', this.#leadBlockMessage(ledProjects), {
        projects: ledProjects,
      });
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

    // Project memberships go first so the turn coordinator skips the bot in
    // every project it was in (docs/dev/03-data-model.md 删除 Bot, P05 row).
    const projectIds = this.projectConversationIdsOf(botId);
    for (const conversationId of projectIds)
      this.deps.onProjectMemberRemoved(botId, conversationId);
    this.deps.mainDb.prepare('delete from conversation_members where bot_id = ?').run(botId);
    this.#cascade('app tool grant bot cascade failed', { botId }, () =>
      this.deps.appGrants?.revokeForBot(botId),
    );
    this.#cascade('taint bot cascade failed', { botId }, () =>
      this.deps.taint?.deleteForBotInConversations(
        botId,
        this.deps.conversations.listDirectByBot(botId).map((conv) => conv.id),
      ),
    );

    for (const conv of this.deps.conversations.listDirectByBot(botId)) {
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
    // W7: the bot's watches are deleted (its watch_alert jobs were cancelled above).
    try {
      this.deps.watches?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'watch bot cleanup failed',
      );
    }
    try {
      this.deps.mail?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'mail bot cleanup failed',
      );
    }
    // D81: the bot's widgets (versions / docs cascade with the widgets rows;
    // the bots row turns into a tombstone below, so the FK alone never fires).
    try {
      this.deps.widgets?.prepareBotDeletion(botId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'widget bot cleanup failed',
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

    // D90: todos this bot executed (or led) fall back to draft.
    this.#cascade('workbench bot cascade failed', { botId }, () =>
      this.deps.workbench?.onExecutorChanged(),
    );
    this.deps.logger.info({ botId }, 'bot deleted');
  }

  /**
   * Removes one bot from one project and runs the per-conversation cascade
   * (docs/dev/03-data-model.md "从群中移除 Bot", P05): cancel its runs in this
   * conversation, delete the member row, revoke this pair's grants, delete
   * this pair's workspace. History messages stay (sender keeps its name).
   */
  async removeProjectMember(conversationId: string, botId: string): Promise<void> {
    this.deps.bots.getOrThrow(botId);
    this.deps.conversations.getOrThrow(conversationId);

    this.deps.onProjectMemberRemoved(botId, conversationId);
    this.#cascade('agent session project-removal cascade failed', { botId, conversationId }, () =>
      this.deps.agentSessions?.onProjectMemberRemoved(botId, conversationId),
    );

    // P07: the bot's commitments made in this project are voided.
    try {
      this.deps.memory?.onProjectMemberRemoved(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'memory project-removal cascade failed',
      );
    }

    // P10: the bot's schedules in this project are cancelled
    // (03-data-model.md 从群中移除 Bot).
    try {
      this.deps.schedules?.cancelForBotInConversation(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'schedule project-removal cascade failed',
      );
    }
    // W7: the bot's watches in this project are deleted.
    try {
      this.deps.watches?.removeForBotInConversation(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'watch project-removal cascade failed',
      );
    }

    // P11: the bot's page for this project is closed (permanent — the pair's
    // workspace dies here too).
    try {
      await this.deps.browser?.closeForBotInConversation(botId, conversationId);
    } catch (error) {
      this.deps.logger.warn(
        { botId, conversationId, error: error instanceof Error ? error.message : String(error) },
        'browser project-removal cascade failed',
      );
    }

    // D92 T1b WP9: the removed member's queued project wiki ingests die with
    // the membership; already-ingested sources stay (executor-pays already
    // spent). Its jobs in OTHER conversations are untouched.
    this.deps.jobs.cancelPendingByBotInConversation(botId, conversationId, 'wiki_ingest');

    this.deps.mainDb
      .prepare('delete from conversation_members where conversation_id = ? and bot_id = ?')
      .run(conversationId, botId);
    this.deps.grants.revokeForBotInConversation(botId, conversationId);
    this.#cascade('app tool grant project-removal cascade failed', { botId, conversationId }, () =>
      this.deps.appGrants?.revokeForBotInConversation(botId, conversationId),
    );
    this.deps.mainDb
      .prepare('update approvals set bot_id = null where bot_id = ? and conversation_id = ?')
      .run(botId, conversationId);
    rmSync(workspacePathFor(this.deps.paths, botId, conversationId), {
      recursive: true,
      force: true,
    });

    this.#cascade('workbench project-removal cascade failed', { botId, conversationId }, () =>
      this.deps.workbench?.onExecutorChanged(),
    );
    this.deps.logger.info({ conversationId, botId }, 'project member removed');
  }

  /**
   * Project conversation ids the bot currently belongs to. Public because the
   * RPC layer must capture them BEFORE deleteBot drops the member rows —
   * afterwards the affected projects are unenumerable, yet their open member
   * lists still need a conversation.updated push (deleted bot renders as id).
   */
  projectConversationIdsOf(botId: string): string[] {
    const rows = this.deps.mainDb
      .prepare(
        "select c.id as id from conversations c join conversation_members m on m.conversation_id = c.id where m.bot_id = ? and c.type = 'project'",
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
    ledProjects: Array<{ id: string; title: string | null }>;
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
      ledProjects: this.deps.projects.ledProjectsOf(botId),
    };
  }

  #leadBlockMessage(led: Array<{ id: string; title: string | null }>): string {
    const names = led.map((project) => project.title ?? project.id).join('、');
    return `该 Bot 是 ${led.length} 个项目组的负责人，请先更换：${names}`;
  }
}
