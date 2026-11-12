/**
 * 任务直注模式（D115，docs/design/56 §1）：任务详情底栏直接复用对话的
 * Composer，用 `injectTaskId` 切成注入模式。凡是要和主对话「分开」的判定都
 * 收敛在这里的纯函数里，Composer 只负责接线，单测也不用挂组件。
 */
import { TASK_INSTRUCTION_MAX_CHARS } from '@kepcup/shared';

/**
 * 任务直注草稿键：与对话草稿同库不同键（`conversationId` 不长这样），
 * 任务草稿与主对话草稿互不串台。
 */
export function taskDraftKey(taskId: string): string {
  return `task:${taskId}`;
}

/** 输入坞右侧按钮位：录音胶囊 > 空输入时的语音键 > 发送键。 */
export type ComposerRightAction = 'recording' | 'voice' | 'send';

/**
 * 右侧按钮位（用户原话：空输入显示语音键，「有文字后按钮变成发送键」；
 * 没配语音识别就「不再显示语音输入按钮，直接显示发送按钮」，此时空输入的
 * 发送键为禁用态——由调用方按 `sendable` 置 disabled）。
 */
export function composerRightAction(input: {
  recording: boolean;
  hasContent: boolean;
  voiceKeyVisible: boolean;
}): ComposerRightAction {
  if (input.recording) return 'recording';
  if (!input.hasContent && input.voiceKeyVisible) return 'voice';
  return 'send';
}

/** 直注内容判定：去首尾空白后非空、且不超过单条指令上限才可发。 */
export function injectContentState(
  markdown: string,
  maxChars: number = TASK_INSTRUCTION_MAX_CHARS,
): { text: string; sendable: boolean; overLimit: boolean } {
  const text = markdown.trim();
  return {
    text,
    sendable: text.length > 0 && text.length <= maxChars,
    overLimit: text.length > maxChars,
  };
}
