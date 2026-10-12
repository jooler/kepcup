import { describe, expect, it } from 'vitest';
import {
  classifyAttachmentStatuses,
  createSendGuard,
  performComposerSend,
  readyAttachmentIds,
  type AttachmentIssue,
  type ComposerSendDeps,
} from './composer-send.js';

function harness(overrides: Partial<ComposerSendDeps> = {}) {
  const calls: string[] = [];
  const sent: Array<{ text: string; ids: string[] }> = [];
  const issues: AttachmentIssue[] = [];
  const deps: ComposerSendDeps = {
    settle: async () => [],
    send: async (text, ids) => {
      calls.push('send');
      sent.push({ text, ids });
      return { ok: true };
    },
    commit: (ids) => calls.push(`commit:${ids.join(',')}`),
    restore: () => calls.push('restore'),
    inspectAttachments: async () => ({ missing: [], sent: [] }),
    onAttachmentIssue: (issue) => {
      issues.push(issue);
      calls.push('issue');
    },
    reportFailure: (code) => calls.push(`report:${code ?? 'none'}`),
    ...overrides,
  };
  return { deps, calls, sent, issues };
}

describe('performComposerSend', () => {
  it('文本 + 附件：发出后摘掉附件 chip，不回填', async () => {
    const { deps, calls, sent } = harness({ settle: async () => ['att_1'] });
    expect(await performComposerSend('你好', deps)).toBe('sent');
    expect(sent).toEqual([{ text: '你好', ids: ['att_1'] }]);
    expect(calls).toEqual(['send', 'commit:att_1']);
  });

  it('只有附件且全部上传失败（文本空、无可发附件）：不发出空消息、不回填', async () => {
    const { deps, calls, sent } = harness({ settle: async () => [] });
    expect(await performComposerSend('', deps)).toBe('empty');
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('只有附件且上传成功：发空文本 + 附件', async () => {
    const { deps, sent } = harness({ settle: async () => ['att_9'] });
    expect(await performComposerSend('', deps)).toBe('sent');
    expect(sent).toEqual([{ text: '', ids: ['att_9'] }]);
  });

  it('发送失败：回填内容，附件 chip 不摘（可直接重试）', async () => {
    const { deps, calls } = harness({
      settle: async () => ['att_1'],
      send: async () => ({ ok: false, code: 'PROVIDER_UNREACHABLE' }),
    });
    expect(await performComposerSend('内容', deps)).toBe('failed');
    expect(calls).toEqual(['report:PROVIDER_UNREACHABLE', 'restore']);
  });

  it('INVALID_INPUT 且附件已不存在（超过 7 天被回收）：摘掉失效 chip + 明确提示，回填文本，不再给通用错误', async () => {
    const inspected: string[][] = [];
    const { deps, calls, issues } = harness({
      settle: async () => ['att_old', 'att_ok'],
      send: async () => ({ ok: false, code: 'INVALID_INPUT' }),
      inspectAttachments: async (ids) => {
        inspected.push(ids);
        return { missing: ['att_old'], sent: [] };
      },
    });
    expect(await performComposerSend('内容', deps)).toBe('failed');
    expect(inspected).toEqual([['att_old', 'att_ok']]);
    expect(issues).toEqual([{ missing: ['att_old'], sent: [] }]);
    expect(calls).toEqual(['issue', 'restore']);
  });

  it('INVALID_INPUT 且附件已被占用（上次发送已受理、响应丢了）：作为 sent 上报，与 missing 区分', async () => {
    const { deps, issues, calls } = harness({
      settle: async () => ['att_1'],
      send: async () => ({ ok: false, code: 'INVALID_INPUT' }),
      inspectAttachments: async () => ({ missing: [], sent: ['att_1'] }),
    });
    expect(await performComposerSend('内容', deps)).toBe('failed');
    expect(issues).toEqual([{ missing: [], sent: ['att_1'] }]);
    expect(calls).toEqual(['issue', 'restore']);
  });

  it('INVALID_INPUT 但附件都还在（别的输入问题）：按通用错误提示，chip 不动', async () => {
    const { deps, issues, calls } = harness({
      settle: async () => ['att_1'],
      send: async () => ({ ok: false, code: 'INVALID_INPUT' }),
      inspectAttachments: async () => ({ missing: [], sent: [] }),
    });
    expect(await performComposerSend('内容', deps)).toBe('failed');
    expect(issues).toEqual([]);
    expect(calls).toEqual(['report:INVALID_INPUT', 'restore']);
  });

  it('判因的 RPC 本身失败：退回通用错误提示，chip 保留', async () => {
    const { deps, issues, calls } = harness({
      settle: async () => ['att_1'],
      send: async () => ({ ok: false, code: 'INVALID_INPUT' }),
      inspectAttachments: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await performComposerSend('内容', deps)).toBe('failed');
    expect(issues).toEqual([]);
    expect(calls).toEqual(['report:INVALID_INPUT', 'restore']);
  });

  it('非 INVALID_INPUT 失败或没带附件：不去判因（不多一次往返）', async () => {
    let inspected = 0;
    const inspect = async (): Promise<AttachmentIssue> => {
      inspected += 1;
      return { missing: [], sent: [] };
    };
    const a = harness({
      settle: async () => ['att_1'],
      send: async () => ({ ok: false, code: 'NOT_FOUND' }),
      inspectAttachments: inspect,
    });
    await performComposerSend('x', a.deps);
    const b = harness({
      settle: async () => [],
      send: async () => ({ ok: false, code: 'INVALID_INPUT' }),
      inspectAttachments: inspect,
    });
    await performComposerSend('x', b.deps);
    expect(inspected).toBe(0);
  });

  it('发送在 settle 之后才发生（等在途上传落定）', async () => {
    const order: string[] = [];
    const { deps } = harness({
      settle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('settled');
        return ['att_2'];
      },
      send: async () => {
        order.push('send');
        return { ok: true };
      },
    });
    await performComposerSend('x', deps);
    expect(order).toEqual(['settled', 'send']);
  });
});

describe('createSendGuard', () => {
  it('同一会话在途时再次触发被忽略；结束（含抛错）后可再发', async () => {
    const guard = createSendGuard();
    let release: () => void = () => {};
    let runs = 0;
    const first = guard.run('conv_a', async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'a';
    });
    expect(guard.isBusy('conv_a')).toBe(true);
    expect(await guard.run('conv_a', async () => 'b')).toBeUndefined();
    release();
    expect(await first).toBe('a');
    expect(guard.isBusy('conv_a')).toBe(false);
    await expect(
      guard.run('conv_a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(guard.isBusy('conv_a')).toBe(false);
    expect(await guard.run('conv_a', async () => 'c')).toBe('c');
    expect(runs).toBe(1);
  });

  it('按会话分闸：A 还在等上传时，B 的发送不被吞', async () => {
    const guard = createSendGuard();
    let release: () => void = () => {};
    const pendingA = guard.run('conv_a', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    expect(guard.isBusy('conv_a')).toBe(true);
    expect(guard.isBusy('conv_b')).toBe(false);
    expect(await guard.run('conv_b', async () => 'sent-b')).toBe('sent-b');
    release();
    await pendingA;
    expect(guard.isBusy('conv_a')).toBe(false);
  });
});

describe('会话切换不误投', () => {
  it('send 依赖拿到的是发起时的会话 id：settle 期间“切走”后文本仍只发往原会话', async () => {
    // 调用方（Composer）把 conversationId 捕获进 deps；这里用一个会变的“当前会话”模拟切换。
    let currentConversation = 'conv_a';
    const delivered: Array<{ conversationId: string; text: string }> = [];
    const origin = currentConversation;
    const { deps } = harness({
      settle: async () => {
        currentConversation = 'conv_b'; // 等上传期间用户切到了 B；A 的上传最终失败 → []
        return [];
      },
      send: async (text) => {
        delivered.push({ conversationId: origin, text });
        return { ok: true };
      },
    });
    expect(await performComposerSend('只发给 A', deps)).toBe('sent');
    expect(currentConversation).toBe('conv_b');
    expect(delivered).toEqual([{ conversationId: 'conv_a', text: '只发给 A' }]);
  });
});

describe('classifyAttachmentStatuses', () => {
  it('pending 不算失效；missing / sent 分开归类并保序', () => {
    expect(
      classifyAttachmentStatuses([
        { id: 'a', state: 'pending' },
        { id: 'b', state: 'missing' },
        { id: 'c', state: 'sent' },
        { id: 'd', state: 'missing' },
      ]),
    ).toEqual({ missing: ['b', 'd'], sent: ['c'] });
  });
});

describe('readyAttachmentIds', () => {
  it('只取 ready 且有 id 的条目，顺序不变', () => {
    expect(
      readyAttachmentIds([
        { state: 'ready', attachmentId: 'a' },
        { state: 'uploading', attachmentId: null },
        { state: 'error', attachmentId: null },
        { state: 'ready', attachmentId: 'b' },
      ]),
    ).toEqual(['a', 'b']);
  });
});
