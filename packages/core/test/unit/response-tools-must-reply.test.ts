import { describe, expect, it } from 'vitest';
import type { RunIdentity } from '../../src/agent/types.js';
import { buildResponseTools, type ResponseToolDeps } from '../../src/tools/index.js';

/**
 * D92 T1a 必答回合（WP3 步骤 7.3）：触发批里有 MUST_REPLY_REASONS 部分的轮
 * （routed / lead_fallback），工具面不注册 skip_reply；其余轮照旧。合并批
 * 只要有一个必答部分就必答（orchestrator 侧 `parts.some(...)`，宿主口径）。
 */

const IDENTITY: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'turn',
};

function deps(mustReply: boolean): ResponseToolDeps {
  return {
    messages: {},
    attachments: {},
    runs: {},
    secrets: { redact: (text: string) => text },
    renderOptions: {},
    gateway: {} as ResponseToolDeps['gateway'],
    workspacePath: '/tmp/none',
    workdirPath: null,
    workdirs: {} as ResponseToolDeps['workdirs'],
    network: { mode: 'none', allowDomains: [] },
    fsState: {} as ResponseToolDeps['fsState'],
    onBotMessage: () => {},
    environment: {} as ResponseToolDeps['environment'],
    mustReply,
  } as unknown as ResponseToolDeps;
}

function toolNames(list: Array<{ name: string }>): string[] {
  return list.map((tool) => tool.name);
}

describe('buildResponseTools mustReply (D92 T1a 必答回合)', () => {
  it('a must-reply turn has no skip_reply', () => {
    const tools = toolNames(buildResponseTools({ identity: IDENTITY, deps: deps(true) }));
    expect(tools).toContain('send_message');
    expect(tools).not.toContain('skip_reply');
  });

  it('an ordinary turn keeps skip_reply', () => {
    const tools = toolNames(buildResponseTools({ identity: IDENTITY, deps: deps(false) }));
    expect(tools).toContain('skip_reply');
  });
});
