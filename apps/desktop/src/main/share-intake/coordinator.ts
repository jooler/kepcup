import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { SHARE_INBOX_STALE_MS, type ShareConsumeInput, type ShareConsumeOutput, type ShareTargets } from '@kepcup/shared';
import { shareInboxDir } from './app-group';
import { listIntakeDirs, listReadyIntakes, readStagedIntake, type StagedIntake } from './manifest';
import { writeTargetsSnapshot } from './targets';
import { parseShareUrl } from './url';

/**
 * D94 §7.3：主进程的分享协调器。
 *
 * 扩展把批次写进 App Group inbox 并唤起主应用；协调器把批次目录搬进 core
 * inbox（`{home}/inbox/share/{intakeId}/`），再调 core 的 `share.consume`。
 * 投递幂等、崩溃可恢复、目标失效不丢文件。
 *
 * 主进程不碰附件库、不读 `~/.kepcup` 里的会话数据；失败时不自动重试
 * `failed_target`（等恢复面板）。
 */

export interface ShareCoordinatorLogger {
  info: (message: string, detail?: Record<string, unknown>) => void;
  warn: (message: string, detail?: Record<string, unknown>) => void;
}

export interface ShareIntakeCoordinatorDeps {
  /** App Group 容器目录；null = 本机没有这个能力（跳过）。 */
  groupDir: string | null;
  /** core 的数据目录（`{home}`）；core inbox 落在它下面。 */
  coreHome: string;
  logger: ShareCoordinatorLogger;
  /** 调 core 的平台方法（port B）。 */
  callPlatform: <T>(method: string, input?: unknown) => Promise<T>;
  /** 目标快照重写的防抖窗口。 */
  targetsDebounceMs?: number;
}

export interface ShareIntakeOutcome {
  intakeId: string;
  state: 'done' | 'failed_target' | 'failed' | 'processing' | 'skipped' | 'busy';
  errorCode?: string;
}

export class ShareIntakeCoordinator {
  readonly #deps: ShareIntakeCoordinatorDeps;
  /** 单飞：同一个批次不并发消费（URL 与启动扫描可能同时到）。 */
  readonly #inflight = new Map<string, Promise<ShareIntakeOutcome>>();
  #targetsTimer: NodeJS.Timeout | null = null;

  constructor(deps: ShareIntakeCoordinatorDeps) {
    this.#deps = deps;
  }

  /** core inbox 根目录：`{home}/inbox/share/`。 */
  get coreInboxDir(): string {
    return path.join(this.#deps.coreHome, 'inbox', 'share');
  }

  /**
   * 启动扫描 + URL 唤起都走这里：清掉过期批次，把 inbox 里「带 ready」的批次
   * 消费掉。单个批次意外失败只记 warn，不拖垮本轮其它批次。
   */
  async scan(): Promise<ShareIntakeOutcome[]> {
    const groupDir = this.#deps.groupDir;
    if (groupDir === null) return [];
    const inbox = shareInboxDir(groupDir);
    this.#sweepInbox(inbox);
    const outcomes: ShareIntakeOutcome[] = [];
    for (const intakeId of listReadyIntakes(inbox)) {
      try {
        outcomes.push(await this.consume(intakeId));
      } catch (error) {
        this.#deps.logger.warn('share intake scan error', {
          intakeId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  }

  /**
   * App Group inbox 的清理（设计 §6.7）：
   *  - 超过 `SHARE_INBOX_STALE_MS`（24h）的目录直接删——无论 ready / not_ready /
   *    校验失败，坏批次不能每 30s 整读重哈希一轮。
   *  - 24h 内、带 `ready` 但校验永久失败的批次立即删（hash 不符、manifest 损坏等
   *    不会自愈）。消费失败（`failed*`）的批次不算：它们已搬进 core inbox，
   *    失败记录与恢复面板由 core 侧负责。
   *  - 不带 `ready` 的年轻目录保留（扩展可能还在写；core 未 ready 的语义同样不碰）。
   */
  #sweepInbox(inbox: string, now: number = Date.now()): void {
    for (const name of listIntakeDirs(inbox)) {
      const dir = path.join(inbox, name);
      try {
        const stat = statSync(dir);
        if (now - stat.mtimeMs > SHARE_INBOX_STALE_MS) {
          rmSync(dir, { recursive: true, force: true });
          this.#deps.logger.warn('share intake expired (removed)', { intakeId: name });
          continue;
        }
        if (!existsSync(path.join(dir, 'ready'))) continue;
        const staged = readStagedIntake(dir);
        if ('error' in staged && staged.error !== 'not_ready') {
          rmSync(dir, { recursive: true, force: true });
          this.#deps.logger.warn('share intake invalid (removed)', {
            intakeId: name,
            reason: staged.error,
          });
        }
      } catch (error) {
        this.#deps.logger.warn('share intake sweep error', {
          intakeId: name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 处理 `kepcup://share-intake?id=…`（扩展唤起主应用）。 */
  async handleUrl(raw: string): Promise<ShareIntakeOutcome | null> {
    const parsed = parseShareUrl(raw);
    if (parsed === null) return null;
    return this.consume(parsed.intakeId);
  }

  /**
   * 消费一个批次：校验 → 搬进 core inbox → 调 core。同一批次并发调用共享
   * 同一个 Promise（单飞）。
   */
  async consume(intakeId: string): Promise<ShareIntakeOutcome> {
    const existing = this.#inflight.get(intakeId);
    if (existing !== undefined) return existing;
    const task = this.#consumeOnce(intakeId).finally(() => {
      this.#inflight.delete(intakeId);
    });
    this.#inflight.set(intakeId, task);
    return task;
  }

  async #consumeOnce(intakeId: string): Promise<ShareIntakeOutcome> {
    const groupDir = this.#deps.groupDir;
    if (groupDir === null) return { intakeId, state: 'skipped' };
    const staged = readStagedIntake(path.join(shareInboxDir(groupDir), intakeId));
    if ('error' in staged) {
      // 不完整的目录不消费，也不删（扩展可能还在写）；下次启动再试。
      this.#deps.logger.warn('share intake skipped', { intakeId, reason: staged.error });
      return { intakeId, state: 'skipped' };
    }
    const moved = this.#moveToCoreInbox(staged);
    if (moved === null) {
      this.#deps.logger.warn('share intake move failed', { intakeId });
      return { intakeId, state: 'failed' };
    }
    const input: ShareConsumeInput = {
      intakeId,
      target: staged.manifest.target,
      note: staged.manifest.note,
      files: staged.manifest.files.map((file) => ({
        path: path.join(moved, 'files', file.stagedName),
        originalName: file.originalName,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
      })),
    };
    try {
      const result = await this.#deps.callPlatform<ShareConsumeOutput>('share.consume', input);
      // 消费成功（done）才清 App Group 目录；失败保留，等 core 的恢复面板。
      if (result.state === 'done') {
        rmSync(staged.dir, { recursive: true, force: true });
      }
      this.#deps.logger.info('share intake consumed', {
        intakeId,
        state: result.state,
        fileCount: input.files.length,
        totalBytes: input.files.reduce((sum, file) => sum + file.size, 0),
      });
      return {
        intakeId,
        state: result.state === 'done' ? 'done' : result.state,
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      };
    } catch (error) {
      // core 未就绪等：保留 core inbox，下次启动重试。
      this.#deps.logger.warn('share intake consume failed', {
        intakeId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { intakeId, state: 'failed' };
    }
  }

  /**
   * 搬进 core inbox：同卷直接 rename；跨卷先复制到临时目录、逐文件校验，
   * 再整体 rename 成最终目录。搬完删掉 App Group 里的原目录。
   */
  #moveToCoreInbox(staged: StagedIntake): string | null {
    const root = this.coreInboxDir;
    const target = path.join(root, staged.intakeId);
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      return null;
    }
    if (existsSync(target)) {
      // 上次搬过（主进程搬完就崩了）：直接用 core inbox 里的那份。
      rmSync(staged.dir, { recursive: true, force: true });
      return target;
    }
    try {
      renameSync(staged.dir, target);
      return target;
    } catch {
      // 跨卷：复制到临时目录再改名。
    }
    const temp = path.join(root, `.tmp-${staged.intakeId}`);
    try {
      rmSync(temp, { recursive: true, force: true });
      cpSync(staged.dir, temp, { recursive: true });
      const copied = readStagedIntake(temp);
      if ('error' in copied) {
        rmSync(temp, { recursive: true, force: true });
        return null;
      }
      renameSync(temp, target);
      rmSync(staged.dir, { recursive: true, force: true });
      return target;
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      this.#deps.logger.warn('share intake copy failed', {
        intakeId: staged.intakeId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** 重新拉目标快照并原子写进 App Group。 */
  async refreshTargets(): Promise<boolean> {
    const groupDir = this.#deps.groupDir;
    if (groupDir === null) return false;
    try {
      const targets = await this.#deps.callPlatform<ShareTargets>('share.targets');
      const result = writeTargetsSnapshot(groupDir, targets);
      if (!result.ok) {
        this.#deps.logger.warn('share targets write failed', { reason: result.reason });
      }
      return result.ok;
    } catch (error) {
      this.#deps.logger.warn('share targets fetch failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** core 说目标变了：防抖后重写快照（连续增删 Bot / 项目只写一次）。 */
  scheduleTargetsRefresh(): void {
    if (this.#targetsTimer !== null) clearTimeout(this.#targetsTimer);
    const delay = this.#deps.targetsDebounceMs ?? 500;
    this.#targetsTimer = setTimeout(() => {
      this.#targetsTimer = null;
      void this.refreshTargets();
    }, delay);
    this.#targetsTimer.unref?.();
  }
}
