import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AppError,
  SHARE_FAILED_TTL_MS,
  SHARE_INBOX_STALE_MS,
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  SHARE_PROCESSING_STALE_MS,
  isShareIntakeId,
  shareManifestSchema,
  type ShareConsumeInput,
  type ShareConsumeOutput,
  type ShareFailedChanged,
  type ShareFailedItem,
  type ShareFailedRetryInput,
  type ShareFailedRetryOutput,
  type ShareTarget,
  type ShareTargets,
} from '@kepcup/shared';
import { rmSync } from '../infra/fs-rm.js';
import { shareInboxDir, shareInboxRoot, type AppPaths } from '../infra/paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { Orchestrator } from '../dispatch/orchestrator.js';

/**
 * 分享接收（D94，docs/design/44-macos-share-extension.md）。
 *
 * 扩展只写 App Group inbox 并唤起主应用；主进程把批次目录移进 core inbox
 * 后调 `share.consume`。本服务只处理 core inbox 与 main.db：
 * 校验路径 / hash / 目标 → 在一个事务里落附件 + 消息 + intake 状态 → 提交后
 * 走既有路由唤醒。
 *
 * 幂等：`share_intakes.id` 是批次键，同一个 id 重复消费不会发第二条消息。
 */

interface ShareIntakeRow {
  id: string;
  state: 'received' | 'processing' | 'done' | 'failed_target' | 'failed';
  target_kind: 'bot' | 'project';
  target_id: string;
  conversation_id: string | null;
  message_id: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface ShareSweepResult {
  /** 超时被打回 `received` 的 processing 行数。 */
  resetProcessing: number;
  /** 过期被清理的失败行数。 */
  expiredFailed: number;
  /** 过期被清理的完成行数。 */
  expiredDone: number;
  /** 过期被清理的 `received` 行数（sweep 打回后始终没消费掉的）。 */
  expiredReceived: number;
  /** 无对应 DB 行、且过期的 core inbox 目录数。 */
  orphanInboxDirs: number;
}

export interface ShareIntakeServiceDeps {
  db: SqliteDatabase;
  paths: AppPaths;
  clock: Clock;
  logger: CoreLogger;
  attachments: AttachmentsService;
  conversations: ConversationsService;
  bots: BotsService;
  orchestrator: Orchestrator;
  /** 发布 RPC 事件（core → 渲染层 / 主进程）。 */
  publish: (event: 'share.failed.changed', payload: ShareFailedChanged) => void;
}

export class ShareIntakeService {
  readonly #db: SqliteDatabase;
  readonly #paths: AppPaths;
  readonly #clock: Clock;
  readonly #logger: CoreLogger;
  readonly #attachments: AttachmentsService;
  readonly #conversations: ConversationsService;
  readonly #bots: BotsService;
  readonly #orchestrator: Orchestrator;
  readonly #publish: ShareIntakeServiceDeps['publish'];

  constructor(deps: ShareIntakeServiceDeps) {
    this.#db = deps.db;
    this.#paths = deps.paths;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#attachments = deps.attachments;
    this.#conversations = deps.conversations;
    this.#bots = deps.bots;
    this.#orchestrator = deps.orchestrator;
    this.#publish = deps.publish;
  }

  // --- 目标快照 -------------------------------------------------------------

  /**
   * 分享目标快照（`share.targets`）：只有 id、显示名、类型与归档状态——不含
   * 密钥、消息、备注与头像文件。管家作为 Bot 出现在列表里。
   */
  targets(): ShareTargets {
    const bots = this.#bots.listActive().map((bot) => ({
      id: bot.id,
      name: bot.name,
      kind: 'bot' as const,
      archived: false,
    }));
    const projects = this.#conversations
      .list()
      .filter((conversation) => conversation.type === 'project')
      .map((conversation) => ({
        id: conversation.id,
        name: conversation.title ?? conversation.id,
        kind: 'project' as const,
        archived: conversation.archivedAt !== null && conversation.archivedAt !== undefined,
      }));
    return { version: 1, generatedAt: this.#clock.now(), bots, projects };
  }

  // --- 消费 -----------------------------------------------------------------

  /**
   * 消费一个分享批次（`share.consume`）。幂等：同一个 intake id 重复调用只
   * 有一条消息。失败不丢文件——状态写 `failed_target` / `failed`，文件留在
   * core inbox 等恢复面板重试或删除。
   */
  consume(input: ShareConsumeInput): ShareConsumeOutput {
    const intakeId = input.intakeId;
    if (!isShareIntakeId(intakeId)) {
      throw new AppError('SHARE_INTAKE_INVALID', '分享批次 id 非法');
    }
    const existing = this.#row(intakeId);
    if (existing !== null) {
      if (existing.state === 'done') {
        return {
          state: 'done',
          ...(existing.message_id !== null ? { messageId: existing.message_id } : {}),
          ...(existing.conversation_id !== null
            ? { conversationId: existing.conversation_id }
            : {}),
        };
      }
      if (
        existing.state === 'processing' &&
        this.#clock.now() - existing.updated_at < SHARE_PROCESSING_STALE_MS
      ) {
        return { state: 'processing' };
      }
      // 目标已删（NOT_FOUND）是终态：同一目标重试必然再失败，直接返回原失败
      // 等用户在恢复面板里重选。READ_ONLY 不是终态（用户可解除只读后重试），
      // 同一目标也走完整重新校验。
      if (
        existing.state === 'failed_target' &&
        existing.error_code === 'SHARE_TARGET_NOT_FOUND' &&
        existing.target_kind === input.target.kind &&
        existing.target_id === input.target.id
      ) {
        return {
          state: 'failed_target',
          ...(existing.error_code !== null ? { errorCode: existing.error_code } : {}),
          ...(existing.error_message !== null ? { errorMessage: existing.error_message } : {}),
        };
      }
    }

    let prepared: {
      message: { id: string; attachments: Array<{ id: string }> };
      conversationId: string;
      wake: () => { runId: string | null };
    };
    try {
      const files = this.#validateFiles(intakeId, input.files);
      const tx = this.#db.transaction(() => {
        this.#upsertIntake(intakeId, input.target);
        const conversationId = this.#resolveTarget(input.target);
        const attachmentIds = files.map((file) =>
          this.#uploadAttachment(conversationId, file.bytes, file.originalName, file.mime),
        );
        const sent = this.#orchestrator.sendShareMessage(conversationId, {
          text: input.note,
          attachmentIds,
          shareIntakeId: intakeId,
        });
        this.#db
          .prepare(
            'update share_intakes set state = ?, message_id = ?, conversation_id = ?, error_code = NULL, error_message = NULL, updated_at = ? where id = ?',
          )
          .run('done', sent.message.id, conversationId, this.#clock.now(), intakeId);
        return { message: sent.message, conversationId, wake: sent.wake };
      });
      prepared = tx.immediate();
    } catch (error) {
      const failure = classifyFailure(error);
      this.#markFailed(intakeId, input.target, failure);
      this.#logger.warn(
        {
          intakeId,
          target: input.target,
          errorCode: failure.code,
          reason: failure.message,
        },
        'share intake failed',
      );
      return {
        state: failure.state,
        errorCode: failure.code,
        errorMessage: failure.message,
      };
    }

    // 提交后：唤醒既有路由（项目组走 D92，私聊走目录闸门）。
    try {
      prepared.wake();
    } catch (error) {
      // 投递失败不回滚消息（与 sendMessage 同一约定）。
      this.#logger.warn(
        { intakeId, reason: error instanceof Error ? error.message : String(error) },
        'share intake delivered but wake-up failed',
      );
    }
    this.#cleanupInbox(intakeId);
    this.#publish('share.failed.changed', { intakeId, state: 'done' });
    return {
      state: 'done',
      messageId: prepared.message.id,
      conversationId: prepared.conversationId,
      attachmentIds: prepared.message.attachments.map((attachment) => attachment.id),
    };
  }

  // --- 失败恢复 -------------------------------------------------------------

  /** 失败列表（`share.failed.list`）：失败与目标失效的批次。 */
  listFailed(): ShareFailedItem[] {
    const rows = this.#db
      .prepare(
        "select * from share_intakes where state in ('failed_target', 'failed') order by created_at",
      )
      .all() as ShareIntakeRow[];
    return rows.map((row) => {
      const manifest = this.#manifestOf(row.id);
      return {
        intakeId: row.id,
        createdAt: row.created_at,
        expiresAt: row.created_at + SHARE_FAILED_TTL_MS,
        errorCode: row.error_code ?? 'SHARE_INTAKE_INVALID',
        errorMessage: row.error_message ?? '',
        target: { kind: row.target_kind, id: row.target_id },
        files:
          manifest?.files.map((file) => ({
            originalName: file.originalName,
            size: file.size,
            mime: file.mime,
          })) ?? [],
      };
    });
  }

  /** 重选目标并重试（`share.failed.retry`）。 */
  retry(input: ShareFailedRetryInput): ShareFailedRetryOutput {
    const row = this.#row(input.intakeId);
    if (row === null) {
      throw new AppError('NOT_FOUND', `分享批次 ${input.intakeId} 不存在`);
    }
    if (row.state === 'done') {
      return {
        state: 'done',
        ...(row.message_id !== null ? { messageId: row.message_id } : {}),
        ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
      };
    }
    const manifest = this.#manifestOf(input.intakeId);
    if (manifest === null) {
      throw new AppError('SHARE_INTAKE_INVALID', '分享文件已丢失，无法重试');
    }
    const dir = shareInboxDir(this.#paths, input.intakeId);
    const result = this.consume({
      intakeId: input.intakeId,
      target: input.target,
      note: manifest.note,
      files: manifest.files.map((file) => ({
        path: path.join(dir, 'files', file.stagedName),
        originalName: file.originalName,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
      })),
    });
    return {
      state: result.state,
      ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
      ...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}),
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    };
  }

  /** 删除失败批次（`share.failed.discard`）：行与 core inbox 一起删；已发出的
   * 消息属于会话历史，不回收。 */
  discard(input: { intakeId: string }): void {
    if (!isShareIntakeId(input.intakeId)) {
      throw new AppError('SHARE_INTAKE_INVALID', '分享批次 id 非法');
    }
    const tx = this.#db.transaction(() => {
      this.#db.prepare('delete from share_intakes where id = ?').run(input.intakeId);
    });
    tx.immediate();
    this.#cleanupInbox(input.intakeId);
  }

  // --- 清扫 -----------------------------------------------------------------

  /**
   * 启动扫描：core inbox 里「manifest 齐全、DB 无行」的批次是「主进程移动后
   * 崩溃」的残留；「DB 行 state=received 且目录仍在」的批次是 sweep 打回的
   * 超时 processing（本进程或上个进程崩在落库途中）。两类都走同一套消费校验
   * 补消费掉——否则 received 行既不进恢复面板（listFailed 只列 failed*）也没
   * 有别的出口，会永久滞留（黑洞）。
   */
  scanInbox(): string[] {
    const root = shareInboxRoot(this.#paths);
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const recovered: string[] = [];
    for (const name of names) {
      if (!isShareIntakeId(name)) continue;
      const row = this.#row(name);
      if (row !== null && row.state !== 'received') continue;
      const manifest = this.#manifestOf(name);
      if (manifest === null) continue;
      const dir = shareInboxDir(this.#paths, name);
      const result = this.consume({
        intakeId: name,
        target: manifest.target,
        note: manifest.note,
        files: manifest.files.map((file) => ({
          path: path.join(dir, 'files', file.stagedName),
          originalName: file.originalName,
          mime: file.mime,
          size: file.size,
          sha256: file.sha256,
        })),
      });
      if (result.state === 'done') recovered.push(name);
    }
    return recovered;
  }

  /**
   * 启动与每日清扫：超时的 `processing` 打回 `received`（重试安全）、过期
   * 的失败 / 完成行清理、无 DB 行的 core inbox 残留清理。`received` 打回后
   * 始终没被补消费掉的（目录已丢或反复崩溃）也在 7 天 TTL 里连同目录清理，
   * 不留永久滞留行。
   */
  sweep(): ShareSweepResult {
    const now = this.#clock.now();
    const result: ShareSweepResult = {
      resetProcessing: 0,
      expiredFailed: 0,
      expiredDone: 0,
      expiredReceived: 0,
      orphanInboxDirs: 0,
    };

    const stale = this.#db
      .prepare("select id from share_intakes where state = 'processing' and updated_at < ?")
      .all(now - SHARE_PROCESSING_STALE_MS) as Array<{ id: string }>;
    for (const row of stale) {
      this.#db
        .prepare("update share_intakes set state = 'received', updated_at = ? where id = ?")
        .run(now, row.id);
      result.resetProcessing += 1;
    }

    const expired = this.#db
      .prepare(
        "select id, state from share_intakes where state in ('failed_target', 'failed', 'done', 'received') and created_at < ?",
      )
      .all(now - SHARE_FAILED_TTL_MS) as Array<{ id: string; state: string }>;
    for (const row of expired) {
      this.#db.prepare('delete from share_intakes where id = ?').run(row.id);
      if (row.state === 'done') result.expiredDone += 1;
      else if (row.state === 'received') result.expiredReceived += 1;
      else result.expiredFailed += 1;
      this.#cleanupInbox(row.id);
    }

    result.orphanInboxDirs = this.#sweepOrphanInboxDirs(now);
    return result;
  }

  // --- 内部 -----------------------------------------------------------------

  #row(intakeId: string): ShareIntakeRow | null {
    const row = this.#db.prepare('select * from share_intakes where id = ?').get(intakeId) as
      ShareIntakeRow | undefined;
    return row ?? null;
  }

  #upsertIntake(intakeId: string, target: ShareTarget): void {
    const now = this.#clock.now();
    const existing = this.#row(intakeId);
    if (existing === null) {
      this.#db
        .prepare(
          'insert into share_intakes (id, state, target_kind, target_id, attempts, created_at, updated_at) values (?, ?, ?, ?, 0, ?, ?)',
        )
        .run(intakeId, 'processing', target.kind, target.id, now, now);
      return;
    }
    this.#db
      .prepare(
        'update share_intakes set state = ?, target_kind = ?, target_id = ?, attempts = attempts + 1, error_code = NULL, error_message = NULL, updated_at = ? where id = ?',
      )
      .run('processing', target.kind, target.id, now, intakeId);
  }

  #markFailed(
    intakeId: string,
    target: ShareTarget,
    failure: { state: 'failed_target' | 'failed'; code: string; message: string },
  ): void {
    const now = this.#clock.now();
    const tx = this.#db.transaction(() => {
      const existing = this.#row(intakeId);
      if (existing === null) {
        this.#db
          .prepare(
            'insert into share_intakes (id, state, target_kind, target_id, attempts, error_code, error_message, created_at, updated_at) values (?, ?, ?, ?, 0, ?, ?, ?, ?)',
          )
          .run(
            intakeId,
            failure.state,
            target.kind,
            target.id,
            failure.code,
            failure.message,
            now,
            now,
          );
        return;
      }
      this.#db
        .prepare(
          'update share_intakes set state = ?, target_kind = ?, target_id = ?, attempts = attempts + 1, error_code = ?, error_message = ?, updated_at = ? where id = ?',
        )
        .run(failure.state, target.kind, target.id, failure.code, failure.message, now, intakeId);
    });
    tx.immediate();
    this.#publish('share.failed.changed', { intakeId, state: failure.state });
  }

  /**
   * 目标解析：Bot → 私聊（没有就建；已归档就取消归档），项目组 → 项目根会话。
   * 目标已删 / 只读 → 失败，不发送。
   */
  #resolveTarget(target: ShareTarget): string {
    if (target.kind === 'bot') {
      const bot = this.#bots.get(target.id);
      if (bot === null || bot.status !== 'active') {
        throw new AppError('SHARE_TARGET_NOT_FOUND', '目标 Bot 不存在或已删除');
      }
      const direct = this.#conversations.listDirectByBot(bot.id);
      if (direct.length > 0 && direct.every((conversation) => conversation.readOnly)) {
        throw new AppError('SHARE_TARGET_READ_ONLY', '目标对话为只读');
      }
      const { conversation } = this.#conversations.openDirect(bot.id);
      if (conversation.archivedAt !== null && conversation.archivedAt !== undefined) {
        this.#conversations.setArchived(conversation.id, false);
      }
      return conversation.id;
    }
    const conversation = this.#conversations.get(target.id);
    if (conversation === null || conversation.type !== 'project') {
      throw new AppError('SHARE_TARGET_NOT_FOUND', '目标项目组不存在或已删除');
    }
    if (conversation.readOnly) {
      throw new AppError('SHARE_TARGET_READ_ONLY', '目标对话为只读');
    }
    if (conversation.archivedAt !== null && conversation.archivedAt !== undefined) {
      this.#conversations.setArchived(conversation.id, false);
    }
    return conversation.id;
  }

  /**
   * 校验 core inbox 里的文件：路径必须落在本批次的 inbox 目录内、必须是普通
   * 文件（拒绝符号链接 / 目录 / 包）、大小与 SHA256 必须对得上。校验和上传读
   * 同一份字节：每个文件只 `realpath` 一次、只读一次（30MB 文件不读两遍），
   * 校验过的 buffer 直接交给附件上传，杜绝「校验 A、上传 B」的 TOCTOU。
   */
  #validateFiles(
    intakeId: string,
    files: ShareConsumeInput['files'],
  ): Array<{ bytes: Buffer; originalName: string; mime: string }> {
    if (files.length === 0 || files.length > SHARE_MAX_FILES) {
      throw new AppError('SHARE_INTAKE_INVALID', '分享文件数量不合法');
    }
    const dir = shareInboxDir(this.#paths, intakeId);
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      throw new AppError('SHARE_INTAKE_INVALID', '分享批次目录不存在');
    }
    let total = 0;
    const validated: Array<{ bytes: Buffer; originalName: string; mime: string }> = [];
    for (const file of files) {
      if (file.path.includes('..')) {
        throw new AppError('SHARE_INTAKE_INVALID', '分享文件路径非法');
      }
      let link;
      try {
        link = lstatSync(file.path);
      } catch {
        throw new AppError('SHARE_INTAKE_INVALID', '分享文件不存在');
      }
      if (link.isSymbolicLink() || !link.isFile()) {
        throw new AppError('SHARE_INTAKE_INVALID', '分享文件不是普通文件');
      }
      const real = realpathSync(file.path);
      if (real !== realDir && !real.startsWith(realDir + path.sep)) {
        throw new AppError('SHARE_INTAKE_INVALID', '分享文件路径越界');
      }
      if (file.size > SHARE_MAX_FILE_BYTES) {
        throw new AppError('SHARE_FILE_TOO_LARGE', '分享文件超过单文件上限');
      }
      const stat = statSync(real);
      if (stat.size !== file.size) {
        throw new AppError('SHARE_INTAKE_INVALID', '分享文件大小与清单不符');
      }
      total += stat.size;
      if (total > SHARE_MAX_TOTAL_BYTES) {
        throw new AppError('SHARE_FILE_TOO_LARGE', '分享文件总量超过上限');
      }
      const bytes = readFileSync(real);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== file.sha256.toLowerCase()) {
        throw new AppError('SHARE_INTAKE_INVALID', '分享文件校验失败（sha256 不符）');
      }
      validated.push({ bytes, originalName: file.originalName, mime: file.mime });
    }
    return validated;
  }

  #uploadAttachment(
    conversationId: string,
    bytes: Buffer,
    fileName: string,
    mime: string,
  ): string {
    const attachment = this.#attachments.upload({
      conversationId,
      fileName,
      mime,
      bytes,
    });
    return attachment.id;
  }

  /** core inbox 里的 manifest（扩展写的，主进程整目录搬过来）。 */
  #manifestOf(intakeId: string): ReturnType<typeof shareManifestSchema.parse> | null {
    try {
      const raw = readFileSync(path.join(shareInboxDir(this.#paths, intakeId), 'manifest.json'));
      const parsed = shareManifestSchema.safeParse(JSON.parse(raw.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  #cleanupInbox(intakeId: string): void {
    try {
      rmSync(shareInboxDir(this.#paths, intakeId), { recursive: true, force: true });
    } catch {
      // 清理失败不影响投递结果。
    }
  }

  /** core inbox 里没有 DB 行、且过期的目录：清掉（崩溃遗留）。 */
  #sweepOrphanInboxDirs(now: number): number {
    const root = shareInboxRoot(this.#paths);
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (this.#row(name) !== null) continue;
      const dir = path.join(root, name);
      try {
        const stat = statSync(dir);
        if (now - stat.mtimeMs < SHARE_INBOX_STALE_MS) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // 单个目录删不掉不影响其余。
      }
    }
    return removed;
  }
}

/** 把异常分类成 intake 状态：目标问题与其它错误分开（设计 §6.3）。 */
function classifyFailure(error: unknown): {
  state: 'failed_target' | 'failed';
  code: string;
  message: string;
} {
  if (error instanceof AppError) {
    if (error.code === 'SHARE_TARGET_NOT_FOUND' || error.code === 'SHARE_TARGET_READ_ONLY') {
      return { state: 'failed_target', code: error.code, message: error.message };
    }
    return { state: 'failed', code: error.code, message: error.message };
  }
  return {
    state: 'failed',
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}
