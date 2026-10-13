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
 * 已有绑定时必须拒绝且不产生 setup，否则保存后续跑会再次弹卡。
 */

const identity: RunIdentity = {
  botId: 'bot_1',
  conversationId: 'conv_1',
  runId: 'run_1',
  loopType: 'turn',
};

function toolsWith(setup: { requestSetup: ReturnType<typeof vi.fn> }, bound: unknown[] = []) {
  const mail = {
    accountsForBot: () => bound,
  } as unknown as MailService;
  return buildMailTools({
    identity,
    mail,
    gateway: { writeDenial: () => null },
    setup: { requestSetup: setup.requestSetup },
  });
}

describe('decideMailSetupRequest', () => {
  it('unbound → ok with mail-account requirement', () => {
    const decided = decideMailSetupRequest({
      botId: 'bot_1',
      bound: [],
      provider: 'custom',
      reason: '帮我接管邮箱',
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.requirement).toEqual({
      kind: 'mail-account',
      provider: 'custom',
      reason: '帮我接管邮箱',
    });
    expect(decided.message).toContain('已请求用户添加邮箱');
  });

  it('already bound → refuse without requirement (no card)', () => {
    const decided = decideMailSetupRequest({
      botId: 'bot_1',
      bound: [{ label: '工作', address: 'me@example.com' }],
      reason: '再检查一下',
    });
    expect(decided).toMatchObject({
      ok: false,
      message: expect.stringContaining('已有绑定邮箱'),
    });
    expect(decided).toMatchObject({
      message: expect.stringContaining('me@example.com'),
    });
    expect('requirement' in decided).toBe(false);
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
    }).map((tool) => tool.name);
    expect(names).not.toContain(MAIL_REQUEST_SETUP_TOOL);
  });

  it('unbound → SETUP_REQUIRED', async () => {
    const requestSetup = vi.fn().mockReturnValue({
      ok: true,
      message: '已请求用户添加邮箱并交给你',
    });
    const tool = toolsWith({ requestSetup }).find((entry) => entry.name === MAIL_REQUEST_SETUP_TOOL)!;
    const result = await tool.execute(
      { provider: 'qq', reason: '帮我接管邮箱' },
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(requestSetup).toHaveBeenCalledWith({ provider: 'qq', reason: '帮我接管邮箱' });
    expect(result).toMatchObject({
      ok: false,
      errorCode: TOOL_SETUP_REQUIRED,
      content: expect.stringContaining('已请求用户添加邮箱'),
    });
  });

  it('facade refuse (already bound) → no SETUP_REQUIRED', async () => {
    const requestSetup = vi.fn().mockReturnValue({
      ok: false,
      message: '你已有绑定邮箱，无需再弹添加卡',
    });
    const tool = toolsWith({ requestSetup }, [
      { id: 'mal_1', label: '工作', address: 'me@example.com' },
    ]).find((entry) => entry.name === MAIL_REQUEST_SETUP_TOOL)!;
    const result = await tool.execute(
      { reason: '再检查' },
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(requestSetup).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
      content: expect.stringContaining('已有绑定邮箱'),
    });
    expect(result.errorCode).not.toBe(TOOL_SETUP_REQUIRED);
  });

  it('mail_accounts empty hints to call mail_request_setup', async () => {
    const tool = toolsWith({ requestSetup: vi.fn() }).find((entry) => entry.name === 'mail_accounts')!;
    const result = await tool.execute(
      {},
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(result).toMatchObject({
      ok: true,
      content: expect.stringContaining('mail_request_setup'),
    });
  });

  it('rejects unknown provider before calling the facade', async () => {
    const requestSetup = vi.fn();
    const tool = toolsWith({ requestSetup }).find((entry) => entry.name === MAIL_REQUEST_SETUP_TOOL)!;
    const result = await tool.execute(
      { provider: 'yahoo' },
      { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} },
    );
    expect(requestSetup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
  });

  it('fails without bot context', async () => {
    const requestSetup = vi.fn();
    const mail = { accountsForBot: () => [] } as unknown as MailService;
    const tool = buildMailTools({
      identity: { ...identity, botId: null },
      mail,
      gateway: { writeDenial: () => null },
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
