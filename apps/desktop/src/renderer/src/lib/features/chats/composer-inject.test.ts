import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composerRightAction, injectAttachAction, injectContentState, taskDraftKey } from './composer-inject.js';

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

  it('D115 附件直注预检：无视觉且无看图模型 → setup；外部引擎 / null ref → pick', () => {
    const base = {
      injectMode: true,
      conversationId: 'conv_1' as string | null,
      executorKnownBuiltin: true,
      executorAcceptsImages: false,
      multimodalReady: false,
    };
    // 内置引擎 + 无视觉 + 无看图模型：弹配置卡（用户要求的正确逻辑）。
    expect(injectAttachAction(base)).toBe('setup');
    // 配了看图模型（多模态能力就绪）：直接弹文件框。
    expect(injectAttachAction({ ...base, multimodalReady: true })).toBe('pick');
    // 执行模型本身支持视觉：直接弹文件框。
    expect(injectAttachAction({ ...base, executorAcceptsImages: true })).toBe('pick');
    // 外部 Agent 任务：伪 ref（agent:{id}/…）解析不到已配置厂商 → 不预检。
    expect(injectAttachAction({ ...base, executorKnownBuiltin: false })).toBe('pick');
    // ref 为 null（bot 未配模型 / 契约缺省）：同样放行，不落入看图模型预检。
    expect(
      injectAttachAction({
        ...base,
        executorKnownBuiltin: false,
        executorAcceptsImages: false,
        multimodalReady: false,
      }),
    ).toBe('pick');
    // 会话上下文缺失：blocked（按钮此时应为禁用态，这里兜底防误触）。
    expect(injectAttachAction({ ...base, conversationId: null })).toBe('blocked');
    // 对话模式恒弹文件框（预检只属于注入坞）。
    expect(injectAttachAction({ ...base, injectMode: false })).toBe('pick');
  });

  it('Composer 注入模式不碰会话发送 / 草稿 / 协作 / 语音对话', () => {
    const source = readFileSync(new URL('./Composer.svelte', import.meta.url), 'utf8');
    // 注入目标由 prop 决定，创建即隔离（调用方必须显式传参，不能默认注进主对话）。
    expect(source).toContain('injectTaskId');
    expect(source).toContain('taskDraftKey(injectTaskId)');
    // D115 附件直注：注入发送随 attachmentIds 直发（纯附件允许空文本）。
    expect(source).toContain('tasks.inject(taskId, content.text, attachmentIds)');
    // 注入模式下 replyTo / 提及 / 共享草稿 / 语音模式入口全部让位。
    expect(source).toContain('injectMode ? null : chatSession.replyTo');
    // D115 附件直注：注入模式读 `task:<id>` 键的上传队列（不再整体让位）。
    expect(source).toContain('injectMode\n      ? composerDrafts.uploadsOf(injectTaskId');
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
    // D115 附件直注：+ 键注入模式不再整体禁用；会话上下文缺失才禁用并说明。
    expect(source).toContain('disabled={readOnly || (injectMode ? !canInjectAttach : false)}');
    expect(source).toContain("t('task.run.injectAttachUnsupported')");
    // D115 附件直注预检：执行模型不支持视觉且未配看图模型 → 宿主弹配置卡。
    expect(source).toContain('executorAcceptsImages');
    expect(source).toContain("settingsStore.isCapabilityReady('multimodal')");
    expect(source).toContain('onRequestAttachSetup?.()');
    // 发送反馈与旧注入坞同口径（delivered / queued / 失败代码）。
    expect(source).toContain("toast.success(t('task.run.injectSent'));");
    expect(source).toContain("toast.warning(t('task.run.injectQueued'));");
    expect(source).toContain("t('task.run.injectFailed')");
  });
});
