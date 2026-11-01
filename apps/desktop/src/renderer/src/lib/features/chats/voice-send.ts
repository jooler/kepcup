/**
 * 语音消息发送编排（docs/design/53-voice-conversation.md「用户语音发送链路」，
 * 26 号「语音消息语义」的落地）。从 Composer 抽成纯函数以便单测（同
 * composer-send.ts 的惯例，Composer.svelte 只负责接线）：
 *
 * - 转写 → 空识别 toast 不发送；缺设置（CAPABILITY_NOT_CONFIGURED /
 *   PROVIDER_AUTH_FAILED）置卡不发送（此时尚未上传，无附件可撤）；非缺设置的
 *   转写失败**空文本 + 附件照发**，Bot 收到附件行后可用 transcribe_audio 自行
 *   转写兜底；
 * - WAV 包 File 走 composerDrafts 上传管道（语音条不渲染 chips，与文字草稿共用
 *   会话实例——异常残留退回文字模式后可见可删，53 号「无静默孤儿」）；
 * - settle → send → commit 复用 performComposerSend；restore 语义由接线方决定
 *   （语音内容不进输入框，无草稿可回填，Composer 接线为 no-op：发送失败时附件
 *   chip 原样留在 composerDrafts）。
 *
 * ## 防重入：串行化而不是忽略（P2-1）
 *
 * 设计承诺「发送后可立即再录」（53 号半双工），连发是正常使用路径；而
 * sendGuard.run 忙时返回 undefined 的「忽略」语义只适合文字直发（第二次按键
 * 是误触）。语音消息的转写文本是用户已说出口的话，**不允许静默丢弃**：
 * 前一条（语音或文字）的 settle+send 还在途时，这条排队等 guard 空闲
 * （`waitForIdle` 是 busy→idle 的完成通知，promise 唤醒、无需轮询，可靠），
 * 空闲后按转写完成序逐条发出、文本与附件配对完整（settle 取的是当时草稿里
 * 全部就绪附件，串行后不会被前一条的收尾交错）。「按说出的顺序」依赖 UI 层
 * 不变量：语音条相位机已把录音串行化、语音-语音不会并发，排队实际只对文字
 * 占闸生效；若将来放宽并发录音，此处的顺序与配对保证需重审。解锁与抢闸之间
 * 被并发发送占先（run 返回 undefined）的极小窗口：再等一轮，必然收敛。
 */

import {
  performComposerSend,
  type ComposerSendDeps,
  type ComposerSendOutcome,
} from './composer-send';
import type { VoiceRecording } from './voice-recorder';

/**
 * 转写缺设置：置卡（chatSession.requestCapabilitySetup('asr')）不发送。两个码
 * 都意味着「配置好了才有得谈」，与网络失败（空文本 + 附件照发）严格区分。
 */
export function isCapabilityError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'CAPABILITY_NOT_CONFIGURED' || code === 'PROVIDER_AUTH_FAILED';
}

/** sendGuard 的排队视图（createSendGuard 的结构子集，测试可注入假闸）。 */
export interface VoiceSendGuard {
  isBusy(key: string): boolean;
  waitForIdle(key: string): Promise<void>;
  run<T>(key: string, task: () => Promise<T>): Promise<T | undefined>;
}

export interface VoiceSendDeps {
  /** media.transcribeSpeech：返回识别文本（编排侧 trim，空串 = 没说话）；抛错带 code。 */
  transcribe(audioBase64: string): Promise<string>;
  /** 没说话：toast 且不发送（53 号交互状态机）。 */
  onNoSpeech(): void;
  /** 缺设置：置起 asr 能力卡，不发送、不上传。 */
  onCapabilityMissing(): void;
  /** 非缺设置的转写失败：提示后仍按「空文本 + 附件照发」继续。 */
  onTranscribeFailed(error: unknown): void;
  /**
   * 转写已落定、即将进入上传 / 排队 / 发送（可选钩子）：语音条文案从「识别中…」
   * 切到「发送中…」——识别与发送共用 transcribing 相位，不等长的是后者
   * （sendGuard 排队 + settle），此前该窗口 UI 显示失真。
   */
  onSending?(): void;
  /** WAV 包 File 走 composerDrafts 上传管道（voice-{ts}.wav / audio/wav）。 */
  uploadVoiceRecording(file: File): void;
  /** 防重入闸：与文字直发共用（按会话分闸），语音侧排队而非忽略（见头注释）。 */
  guard: VoiceSendGuard;
  /** performComposerSend 的依赖（settle / send / commit / restore / …），接线方组装。 */
  composerSend: ComposerSendDeps;
}

/** no-speech / capability-missing = 未发出（原因已提示 / 置卡）；其余同 performComposerSend。 */
export type VoiceSendOutcome = ComposerSendOutcome | 'no-speech' | 'capability-missing';

/** 等闸空闲再抢（抢闸失败再等一轮），返回值不可能 undefined（task 返回非 undefined）。 */
async function runWhenGuardIdle(
  guard: VoiceSendGuard,
  conversationId: string,
  task: () => Promise<ComposerSendOutcome>,
): Promise<ComposerSendOutcome> {
  for (;;) {
    await guard.waitForIdle(conversationId);
    const outcome = await guard.run(conversationId, task);
    if (outcome !== undefined) return outcome;
    // 解锁与抢闸之间被并发发送占先：再等一轮 busy→idle（每轮都有真实通知，
    // 不会空转）。
  }
}

/** 语音消息发送（转写分支 + 上传 + 串行化发送），分支语义见文件头注释。 */
export async function sendVoiceRecording(
  rec: Pick<VoiceRecording, 'base64' | 'blob'>,
  conversationId: string,
  deps: VoiceSendDeps,
): Promise<VoiceSendOutcome> {
  let text = '';
  try {
    text = (await deps.transcribe(rec.base64)).trim();
    if (text.length === 0) {
      // 没说话：toast 且不发送（53 号）。
      deps.onNoSpeech();
      return 'no-speech';
    }
  } catch (error) {
    if (isCapabilityError(error)) {
      deps.onCapabilityMissing();
      return 'capability-missing';
    }
    // 非缺设置（网络等）：提示后空文本 + 附件照发（模型侧 transcribe_audio 兜底）。
    deps.onTranscribeFailed(error);
  }
  // 走到这里 = 即将进入发送：转写已落定且非缺设置（no-speech / capability-
  // missing 已在上面 return）；但 settle 为空（无文本无附件）时仍可能返回
  // empty 不实发——钩子只是 UI 预告，不承诺结果。
  deps.onSending?.();
  deps.uploadVoiceRecording(new File([rec.blob], `voice-${Date.now()}.wav`, { type: 'audio/wav' }));
  return runWhenGuardIdle(deps.guard, conversationId, () =>
    performComposerSend(text, deps.composerSend),
  );
}
