import { describe, expect, it, vi } from 'vitest';
import {
  buildMailTools,
  decideMailSetupRequest,
  MAIL_REQUEST_SETUP_TOOL,
} from '../../src/tools/mail-tools.js';
import { TOOL_SETUP_REQUIRED } from '../../src/tools/image-tools.js';
import type { MailService } from '../../src/mail/service.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * mail_request_setup：记下 mail-account 需求并返回 SETUP_REQUIRED（design 18 / D84）。
 * D91 后续：已有绑定时不再拒绝——照常产出 mail-account 需求（新增一个邮箱，原有的保持不变）。
 */

const identity: RunIdentity = {
  botId: 'bot_1',
  conversationId: 'conv_1',
  runId: 'run_1',
  loopType: 'turn',
};

/** D91：mail_request_setup 始终注册；`bound: true` 时另有五个读写工具。 */
function toolsWith(
  setup: { requestSetup: ReturnType<typeof vi.fn> },
  bound: unknown[] = [],
  boundFlag = bound.length > 0,
) {
  const mail = {
    accountsForBot: () => bound,
  } as unknown as MailService;
  return buildMailTools({
    identity,
    mail,
    gateway: { writeDenial: () => null },
    bound: boundFlag,
    setup: { requestSetup: setup.requestSetup },
  });
}

describe('decideMailSetupRequest', () => {
  it('unbound → ok with mail-account requirement', () => {
    const decided = decideMailSetupRequest({
      botId: 'bot_1',
      bound: [],
      reason: '帮我接管邮箱',
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    // P3：无 provider 预填——添加入口是邮件插件卡。
    expect(decided.requirement).toEqual({ kind: 'mail-account', reason: '帮我接管邮箱' });
    expect(decided.message).toContain('已请求用户添加邮箱');
  });

  it('already bound → still a requirement; the message lists the existing mailboxes, says one is added, points at propose_handover', () => {
    const decided = decideMailSetupRequest({
      botId: 'bot_1',
      bound: [{ label: '工作', address: 'me@example.com' }],
      reason: '再加一个',
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.requirement).toEqual({ kind: 'mail-account', reason: '再加一个' });
    expect(decided.message).toContain('me@example.com');
    expect(decided.message).toContain('新增');
    expect(decided.message).toContain('propose_handover');
    expect(decided.message).toContain('不要让用户把授权码贴进聊天');
  });

  it('no bot → refuse', () => {
    expect(decideMailSetupRequest({ botId: null, bound: [] })).toMatchObject({
      ok: false,
      message: expect.stringContaining('没有 Bot'),
    });
  });
});

describe('mail_request_setup', () => {
  it('registers the tool when setup facade is provided', () => {
    const names = toolsWith({ requestSetup: vi.fn() }).map((tool) => tool.name);
    expect(names).toContain(MAIL_REQUEST_SETUP_TOOL);
  });

  it('omits the tool when setup facade is absent', () => {
    const mail = { accountsForBot: () => [] } as unknown as MailService;
    const names = buildMailTools({
      identity,
      mail,
      gateway: { writeDenial: () => null },
      bound: false,
    }).map((tool) => tool.name);
    expect(names).not.toContain(MAIL_REQUEST_SETUP_TOOL);
    expect(names).toEqual([]);
  });

  it('D91: unbound → only mail_request_setup; bound → the five tools plus mail_request_setup', () => {
    const unbound = toolsWith({ requestSetup: vi.fn() }, []).map((tool) => tool.name);
    expect(unbound).toEqual([MAIL_REQUEST_SETUP_TOOL]);
    const bound = toolsWith({ requestSetup: vi.fn() }, [
      { id: 'mal_1', label: '工作', address: 'me@example.com' },
    ]).map((tool) => tool.name);
    expect(bound).toEqual([
      'mail_accounts',
      'mail_list',
      'mail_read',
      'mail_search',
      'mail_send',
      MAIL_REQUEST_SETUP_TOOL,
    ]);
  });

  it('the tool description invites adding more mailboxes and no longer says "do not call when bound"', () => {
    const tool = toolsWith({ requestSetup: vi.fn() }).find(
      (entry) => entry.name === MAIL_REQUEST_SETUP_TOOL,
    )!;
    expect(tool.description).toContain('添加（更多）邮箱');
    expect(tool.description).toContain('propose_handover');
    expect(tool.description).toContain('不要索要授权码');
    expect(tool.description).not.toContain('不要调用');
    expect(tool.description).not.toContain('扩展中心去');
  });

  it('unbound → SETUP_REQUIRED', async () => {
    const requestSetup = vi.fn().mockReturnValue({
      ok: true,
      message: '已请求用户添加邮箱并交给你',
    });
    const tool = toolsWith({ requestSetup }).find((entry) => entry.name === MAIL_REQUEST_SETUP_TOOL)!;
    const result = await tool.execute(
      { reason: '帮我接管邮箱' },
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(requestSetup).toHaveBeenCalledWith({ reason: '帮我接管邮箱' });
    expect(result).toMatchObject({
      ok: false,
      errorCode: TOOL_SETUP_REQUIRED,
      content: expect.stringContaining('已请求用户添加邮箱'),
    });
  });

  it('facade refuse → no SETUP_REQUIRED (e.g. no bot context)', async () => {
    const requestSetup = vi.fn().mockReturnValue({ ok: false, message: '当前执行没有 Bot 上下文' });
    const tool = toolsWith({ requestSetup }, [], false).find(
      (entry) => entry.name === MAIL_REQUEST_SETUP_TOOL,
    )!;
    const result = await tool.execute(
      { reason: '再检查' },
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(requestSetup).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(result.errorCode).not.toBe(TOOL_SETUP_REQUIRED);
  });

  it('bound bot calling the tool → SETUP_REQUIRED (not a refusal)', async () => {
    const requestSetup = vi.fn().mockReturnValue({ ok: true, message: '已请求用户添加邮箱并交给你：这次会新增一个' });
    const tool = toolsWith({ requestSetup }, [{ id: 'mal_1', label: '工作', address: 'me@example.com' }]).find(
      (entry) => entry.name === MAIL_REQUEST_SETUP_TOOL,
    )!;
    const result = await tool.execute(
      { reason: '再加一个' },
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(result).toMatchObject({ ok: false, errorCode: TOOL_SETUP_REQUIRED });
  });

  it('mail_accounts only exists when bound; an emptied binding reports no mailbox without pointing at the absent setup tool', async () => {
    const tool = toolsWith({ requestSetup: vi.fn() }, [], true).find(
      (entry) => entry.name === 'mail_accounts',
    )!;
    const result = await tool.execute(
      {},
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(result).toMatchObject({ ok: true, content: expect.stringContaining('没有交给你的邮箱') });
    expect(result.content).not.toContain('mail_request_setup');
  });

  it('fails without bot context', async () => {
    const requestSetup = vi.fn();
    const mail = { accountsForBot: () => [] } as unknown as MailService;
    const tool = buildMailTools({
      identity: { ...identity, botId: null },
      mail,
      gateway: { writeDenial: () => null },
      bound: false,
      setup: { requestSetup },
    }).find((entry) => entry.name === MAIL_REQUEST_SETUP_TOOL)!;
    const noBot = { ...identity, botId: null };
    const result = await tool.execute(
      {},
      { identity: noBot, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(requestSetup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
  });
});
