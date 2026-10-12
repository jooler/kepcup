/**
 * 输入框直发（docs/design/01-conversation.md 输入与发送）的编排，抽成纯函数以便
 * 单测（Composer.svelte 只负责接线）：
 *
 * - 先等在途上传落定（settle），**之后重新判空**：只有附件且全部上传失败 / 文本为空
 *   时不发出空消息（core 会回 INVALID_INPUT，用户只看到莫名其妙的 toast）；
 * - 附件 chip 在发送**成功后**才移除（commit）；失败时原样留着，文本也回填，
 *   用户可直接重试，已上传的附件不会成为孤儿；
 * - 例外：core 因附件「不存在 / 不属于该对话 / 已被占用」拒绝（INVALID_INPUT）时，
 *   原样重试永远失败（chip 卡死）。此时按 attachments.status 判因，摘掉失效的 chip
 *   并给出明确提示——不存在（多为超过 7 天被回收）与已被占用（很可能上一次发送 core
 *   已受理、只是响应丢了）是两种不同的说法；
 * - 防重入按会话分闸：同一会话一次只允许一个发送在途（上传未完成时连按两次 Enter，
 *   第二次直接忽略），而会话 A 等上传时，会话 B 的发送不受影响。
 */

export interface UploadLike {
  state: 'uploading' | 'ready' | 'error';
  attachmentId: string | null;
}

/** 已就绪、可随消息发出的附件 id（按 chip 顺序）。 */
export function readyAttachmentIds(uploads: readonly UploadLike[]): string[] {
  return uploads
    .filter((upload) => upload.state === 'ready' && upload.attachmentId !== null)
    .map((upload) => upload.attachmentId as string);
}

/** 发送结果：失败时带 core 的错误码（无码 = 非结构化错误）。 */
export type SendResult = { ok: true } | { ok: false; code: string | undefined };

/** attachments.status 返回的单条状态。 */
export interface AttachmentStatusLike {
  id: string;
  state: 'pending' | 'sent' | 'missing';
}

/** 失效附件：missing = 已不存在，sent = 已绑定到某条消息（多半是先前那次发送已受理）。 */
export interface AttachmentIssue {
  missing: string[];
  sent: string[];
}

export const NO_ATTACHMENT_ISSUE: AttachmentIssue = { missing: [], sent: [] };

/** 把批量状态归类为失效附件（pending 的不算）。 */
export function classifyAttachmentStatuses(
  statuses: readonly AttachmentStatusLike[],
): AttachmentIssue {
  return {
    missing: statuses.filter((entry) => entry.state === 'missing').map((entry) => entry.id),
    sent: statuses.filter((entry) => entry.state === 'sent').map((entry) => entry.id),
  };
}

export function hasAttachmentIssue(issue: AttachmentIssue): boolean {
  return issue.missing.length > 0 || issue.sent.length > 0;
}

export interface ComposerSendDeps {
  /** 等在途上传落定，返回可发送的附件 id（不移除 chip）。 */
  settle(): Promise<string[]>;
  /** 发出消息（只发往发起发送时的那个会话）；ok = core 已受理。不负责 toast。 */
  send(text: string, attachmentIds: string[]): Promise<SendResult>;
  /** 发送成功后移除已随消息发出的附件 chip（不 detach：附件已属于该消息）。 */
  commit(attachmentIds: string[]): void;
  /** 发送失败：把清掉的输入内容放回编辑器。 */
  restore(): void;
  /** 被 INVALID_INPUT 拒绝且带附件时判因（一次往返）；抛错视为「判不出」。 */
  inspectAttachments(attachmentIds: string[]): Promise<AttachmentIssue>;
  /** 摘掉失效 chip 并给出明确提示（missing / sent 措辞不同）。 */
  onAttachmentIssue(issue: AttachmentIssue): void;
  /** 与附件无关（或判不出）的失败：通用错误提示。 */
  reportFailure(code: string | undefined): void;
}

export type ComposerSendOutcome = 'sent' | 'empty' | 'failed';

export async function performComposerSend(
  text: string,
  deps: ComposerSendDeps,
): Promise<ComposerSendOutcome> {
  const attachmentIds = await deps.settle();
  if (text.length === 0 && attachmentIds.length === 0) return 'empty';
  const result = await deps.send(text, attachmentIds);
  if (!result.ok) {
    let issue = NO_ATTACHMENT_ISSUE;
    if (result.code === 'INVALID_INPUT' && attachmentIds.length > 0) {
      try {
        issue = await deps.inspectAttachments(attachmentIds);
      } catch {
        // 判不出就按通用错误处理，chip 保留（用户仍可手动移除）。
      }
    }
    if (hasAttachmentIssue(issue)) deps.onAttachmentIssue(issue);
    else deps.reportFailure(result.code);
    deps.restore();
    return 'failed';
  }
  deps.commit(attachmentIds);
  return 'sent';
}

/**
 * 防重入闸（按 key 分闸，key = 会话 id）：同 key 的 `run` 期间再次触发直接返回
 * undefined；不同 key 互不影响。
 */
export function createSendGuard() {
  const busy = new Set<string>();
  return {
    isBusy(key: string): boolean {
      return busy.has(key);
    },
    async run<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
      if (busy.has(key)) return undefined;
      busy.add(key);
      try {
        return await task();
      } finally {
        busy.delete(key);
      }
    },
  };
}
