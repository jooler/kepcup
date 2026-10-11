/**
 * Composer key handling for direct send (docs/design/01-conversation.md
 * "输入与发送"; attachments, docs/design/20-conversation-media.md).
 * Pure logic, unit-tested without a DOM.
 */

export type ComposerAction = 'send' | 'newline' | 'none';

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
}

export function resolveComposerAction(event: ComposerKeyEvent): ComposerAction {
  if (event.key !== 'Enter') return 'none';
  // Never intercept Enter while the IME is confirming a candidate.
  if (event.isComposing) return 'none';
  if (event.shift) return 'newline';
  // Enter / Cmd+Ctrl+Enter 都直发；空内容不拦截。
  return event.hasText || event.hasAttachments === true ? 'send' : 'none';
}
