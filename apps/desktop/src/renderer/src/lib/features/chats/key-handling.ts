/**
 * Composer key handling for the outgoing queue (docs/design/01-conversation.md
 * "输入与待发送队列" + P01 任务 4; attachments, docs/design/20-conversation-media.md).
 * Pure logic, unit-tested without a DOM.
 */

export type ComposerAction = 'add-draft' | 'flush' | 'add-and-flush' | 'newline' | 'none';

export interface ComposerKeyEvent {
  key: string;
  /** Cmd (macOS) or Ctrl (other platforms). */
  meta: boolean;
  shift: boolean;
  /** IME composition is active (`isComposing` / keyCode 229). */
  isComposing: boolean;
  hasText: boolean;
  /** 待发送附件已选（纯附件可发送，docs/design/20-conversation-media.md）。 */
  hasAttachments?: boolean;
  queueLength: number;
}

export function resolveComposerAction(event: ComposerKeyEvent): ComposerAction {
  if (event.key !== 'Enter') return 'none';
  // Never intercept Enter while the IME is confirming a candidate.
  if (event.isComposing) return 'none';
  if (event.shift) return 'newline';
  const hasContent = event.hasText || event.hasAttachments === true;
  if (event.meta) return hasContent ? 'add-and-flush' : 'flush';
  if (hasContent) return 'add-draft';
  if (event.queueLength > 0) return 'flush';
  return 'none';
}
