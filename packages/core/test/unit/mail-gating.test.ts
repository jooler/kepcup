import { describe, expect, it, vi } from 'vitest';
import { buildResponseTools } from '../../src/tools/index.js';
import type { MailService } from '../../src/mail/service.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D91（design 40 §6）：邮件工具按绑定门控，对话轮与任务两个分支一致。
 * mail_request_setup 有 mail 就注册（有无绑定都一样，用户随时可以让 Bot 添加更多邮箱）；
 * 没有绑定邮箱 → 只有它；有绑定 → 另加全部读写工具（D144 起含邮箱内部写操作）。
 */

const MAIL_TOOLS = [
  'mail_accounts',
  'mail_list',
  'mail_read',
  'mail_search',
  'mail_mark',
  'mail_tag',
  'mail_move',
  'mail_delete',
  'mail_draft',
  'mail_folders',
  'mail_send',
];

function identityOf(loopType: 'turn' | 'task', botId: string | null = 'bot_1'): RunIdentity {
  return { runId: 'run_1', botId, conversationId: 'conv_1', loopType };
}

function mailNames(input: {
  loopType: 'turn' | 'task';
  bound: unknown[];
  mailBound?: boolean;
  botId?: string | null;
}): string[] {
  const accountsForBot = vi.fn(() => input.bound);
  const mail = { accountsForBot } as unknown as MailService;
  const tools = buildResponseTools({
    identity: identityOf(input.loopType, input.botId),
    deps: {
      messages: {} as never,
      attachments: {} as never,
      runs: {} as never,
      secrets: {} as never,
      renderOptions: {} as never,
      gateway: {} as never,
      workspacePath: '/tmp/ws',
      workdirPath: null,
      workdirs: {} as never,
      network: { mode: 'open', allowDomains: [] } as never,
      fsState: {} as never,
      environment: { request: async () => ({}), offeredItems: () => [] } as never,
      mail,
      ...(input.mailBound !== undefined ? { mailBound: input.mailBound } : {}),
      mailSetup: { requestSetup: () => ({ ok: true, message: 'ok' }) },
      logger: { warn: () => {} },
    } as never,
  });
  return tools.map((tool) => tool.name).filter((name) => name.startsWith('mail_'));
}

describe.each(['turn', 'task'] as const)('D91 mail gating (%s)', (loopType) => {
  it('0 bindings → only mail_request_setup', () => {
    expect(mailNames({ loopType, bound: [] })).toEqual(['mail_request_setup']);
  });

  it('1 binding → all read/write tools plus mail_request_setup (adding more mailboxes stays possible)', () => {
    const names = mailNames({ loopType, bound: [{ id: 'mal_1', pluginId: null }] });
    expect([...names].sort()).toEqual([...MAIL_TOOLS, 'mail_request_setup'].sort());
  });

  it('an explicit mailBound decision wins over a second lookup', () => {
    expect(mailNames({ loopType, bound: [{ id: 'mal_1', pluginId: null }], mailBound: false })).toEqual([
      'mail_request_setup',
    ]);
    expect(mailNames({ loopType, bound: [], mailBound: true })).toHaveLength(MAIL_TOOLS.length + 1);
  });

  it('no bot context → counts as unbound', () => {
    expect(mailNames({ loopType, bound: [{ id: 'mal_1', pluginId: null }], botId: null })).toEqual([
      'mail_request_setup',
    ]);
  });
});
