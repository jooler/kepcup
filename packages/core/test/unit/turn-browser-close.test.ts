import { describe, expect, it } from 'vitest';
import type { RunIdentity } from '../../src/agent/types.js';
import { buildResponseTools, type ResponseToolDeps } from '../../src/tools/index.js';
import type { BrowserHostRpc } from '../../src/browser/facade.js';

/**
 * D75 工具面的浏览器边界：对话轮不给浏览器工具，唯一例外 `browser_close`
 * （释放页面是收尾动作，用户在对话里说「把浏览器关了」时轮里就能办）；
 * 任务拿到全部九个 `browser_*`。
 */

const BASE = { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1' } as const;
const turn: RunIdentity = { ...BASE, loopType: 'turn' };
const task: RunIdentity = { ...BASE, loopType: 'task' };

const BROWSER_TOOLS = [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_screenshot',
  'browser_back',
  'browser_close',
];

function deps(): ResponseToolDeps {
  return {
    messages: {},
    attachments: {},
    runs: {},
    secrets: { redact: (text: string) => text },
    renderOptions: {},
    gateway: {
      writeDenial: () => null,
      readOnlyDownloadsDir: () => '/tmp/none-downloads',
      egressCheck: async () => null,
    } as unknown as ResponseToolDeps['gateway'],
    workspacePath: '/tmp/none',
    workdirPath: null,
    workdirs: {} as ResponseToolDeps['workdirs'],
    network: { mode: 'none', allowDomains: [] },
    fsState: {} as ResponseToolDeps['fsState'],
    onBotMessage: () => {},
    environment: {} as ResponseToolDeps['environment'],
    browser: {} as BrowserHostRpc,
  } as unknown as ResponseToolDeps;
}

function toolNames(identity: RunIdentity): string[] {
  return buildResponseTools({ identity, deps: deps() }).map((tool) => tool.name);
}

describe('browser tools per run kind (D75 + browser_close 例外)', () => {
  it('对话轮：只有 browser_close，其余 browser_* 不注入', () => {
    const names = toolNames(turn);
    expect(names).toContain('browser_close');
    expect(names.filter((name) => name.startsWith('browser_'))).toEqual(['browser_close']);
    for (const name of BROWSER_TOOLS.filter((n) => n !== 'browser_close')) {
      expect(names).not.toContain(name);
    }
  });

  it('任务：全部九个浏览器工具都在', () => {
    const names = toolNames(task);
    for (const name of BROWSER_TOOLS) expect(names).toContain(name);
  });
});
