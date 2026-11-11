import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composerRightAction, injectContentState, taskDraftKey } from './composer-inject.js';

describe('任务直注模式（Composer 复用，D115）', () => {
  it('任务草稿用独立键，绝不落在会话草稿键上', () => {
    expect(taskDraftKey('run_123')).toBe('task:run_123');
    // 会话 id 是 `conv_...`，不会撞上任务草稿键。
    expect(taskDraftKey('run_123').startsWith('conv_')).toBe(false);
  });

  it('右侧按钮位：录音 > 空输入的语音键 > 发送键', () => {
    // 录音中（转写进行中同理）优先显示录音胶囊，不显示语音键/发送键位。
    expect(composerRightAction({ recording: true, hasContent: false, voiceKeyVisible: true })).toBe(
      'recording',
    );
    // 空输入且有语音识别：显示语音键。
    expect(
      composerRightAction({ recording: false, hasContent: false, voiceKeyVisible: true }),
    ).toBe('voice');
    // 有内容：变发送键（语音在录音中不参与）。
    expect(composerRightAction({ recording: false, hasContent: true, voiceKeyVisible: true })).toBe(
      'send',
    );
    // 没配语音识别：空输入也直接给发送键（由调用方置 disabled）。
    expect(
      composerRightAction({ recording: false, hasContent: false, voiceKeyVisible: false }),
    ).toBe('send');
  });

  it('直注内容：去空白后非空才可发，超上限不可发', () => {
    expect(injectContentState('  继续跑测试  ')).toEqual({
      text: '继续跑测试',
      sendable: true,
      overLimit: false,
    });
    expect(injectContentState('   \n\t ')).toEqual({ text: '', sendable: false, overLimit: false });
    expect(injectContentState('x'.repeat(10), 8)).toEqual({
      text: 'x'.repeat(10),
      sendable: false,
      overLimit: true,
    });
  });

  it('Composer 注入模式不碰会话发送 / 草稿 / 协作 / 语音对话', () => {
    const source = readFileSync(new URL('./Composer.svelte', import.meta.url), 'utf8');
    // 注入目标由 prop 决定，创建即隔离（调用方必须显式传参，不能默认注进主对话）。
    expect(source).toContain('injectTaskId');
    expect(source).toContain('taskDraftKey(injectTaskId)');
    expect(source).toContain('tasks.inject(taskId, content.text)');
    // 注入模式下 replyTo / 待发附件 / 提及 / 共享草稿 / 语音模式入口全部让位。
    expect(source).toContain('injectMode ? null : chatSession.replyTo');
    expect(source).toContain('injectMode ? [] : composerDrafts.uploadsOf');
    expect(source).toContain('const voiceModeEntryVisible = $derived(!isProject && !injectMode);');
    expect(source).toContain('const voiceKeyVisible = $derived(');
    expect(source).toContain('composerRightAction({');
    expect(source).toContain('injectContentState(');
    // 语音识别不可用时不在任务详情里置会话设置卡（那里没设置卡入口），只提示。
    expect(source).toContain('function requestAsrSetup(): void {');
    expect(source).toContain("toast.error(t('task.run.injectVoiceUnavailable'));");
    // 注入模式完全不进协作：共享草稿 / presence 的进入与事件上报都 let out。
    expect(source).toContain('const draftsKey = injectMode');
    expect(source).toContain('if (injectMode) return;\n    sharedDraft.start();');
    // 右侧按钮位的落地：空输入 + 无 ASR 时仍渲染发送键，但必须 disabled；
    // 有内容时也渲染发送键（与对话里一致）。
    expect(source).toContain("{#if hasContent || rightAction === 'send'}");
    expect(source).toContain('disabled={readOnly || collabReader || !hasContent || injectSending}');
    // + 附件键保留但禁用：tasks.inject 只收文本。
    expect(source).toContain('disabled={readOnly || injectMode}');
    expect(source).toContain("t('task.run.injectAttachUnsupported')");
    // 发送反馈与旧注入坞同口径（delivered / queued / 失败代码）。
    expect(source).toContain("toast.success(t('task.run.injectSent'));");
    expect(source).toContain("toast.warning(t('task.run.injectQueued'));");
    expect(source).toContain("t('task.run.injectFailed')");
  });
});
