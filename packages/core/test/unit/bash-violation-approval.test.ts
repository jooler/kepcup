import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';
import type { ToolGateway } from '../../src/gateway/index.js';
import { buildCodingTools } from '../../src/tools/coding-tools.js';
import { FileReadState } from '../../src/tools/fs-state.js';
import { executeToolSafely } from '../../src/agent/tool-execution.js';

const blocked = '/tmp/outside/secret.txt';

function toolsFor(
  loopType: RunIdentity['loopType'],
  exitCode = 1,
  violations: Array<{ line: string }> = [{ line: `cat(x) deny(1) file-read-data ${blocked}` }],
) {
  const requested: Array<{ paths: string[]; preauthorize?: boolean }> = [];
  const identity: RunIdentity = {
    runId: `run_${loopType}`,
    botId: 'bot_x',
    conversationId: 'conv_x',
    loopType,
  };
  const gateway = {
    exec: async () => ({
      exitCode,
      timedOut: false,
      violations,
    }),
    checkPath: () => ({ kind: 'needs_grant', resolvedPath: blocked, reason: 'outside' }),
    ensurePathAccessBatch: async (
      _identity: RunIdentity,
      items: Array<{ path: string; mode: 'read' | 'write' }>,
      options: { preauthorize?: boolean } = {},
    ) => {
      requested.push({
        paths: items.map((item) => item.path),
        ...(options.preauthorize !== undefined ? { preauthorize: options.preauthorize } : {}),
      });
      return {
        resolved: items.map((item) => item.path),
        denied: [],
        approvalId: 'apr_x',
        duration: 'once',
      };
    },
  } as unknown as ToolGateway;
  const tools = buildCodingTools(identity, {
    gateway,
    workspacePath: mkdtempSync(path.join(os.tmpdir(), 'kepcup-bash-approval-')),
    workdirPath: null,
    network: { mode: 'none', allowDomains: [] },
    secrets: { redact: (text: string) => text } as never,
    fsState: new FileReadState(),
  });
  const ctx: ToolContext = {
    identity,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };
  return {
    bash: new Map(tools.map((tool) => [tool.name, tool])).get('bash') as ToolDefinition,
    requested,
    ctx,
  };
}

describe('sandbox violations request access in a task', () => {
  it('a task asks for each grantable blocked path and leaves the grant for the retry', async () => {
    const { bash, requested, ctx } = toolsFor('task');
    const result = await executeToolSafely(bash, { command: 'cat /tmp/outside/secret.txt' }, ctx);
    expect(requested).toEqual([{ paths: [blocked], preauthorize: true }]);
    expect(result.content).toContain('用户已允许');
    expect(result.content).toContain('重新执行命令');
  });

  it('one command blocked on several paths asks once, in a single batch card (D140 §3.5)', async () => {
    const paths = ['/tmp/outside/a.txt', '/tmp/outside/b.txt', '/tmp/outside/c.txt'];
    const violations = paths.map((p) => ({ line: `cat(x) deny(1) file-read-data ${p}` }));
    const { bash, requested, ctx } = toolsFor('task', 1, violations);
    const result = await executeToolSafely(bash, { command: 'cat /tmp/outside/*.txt' }, ctx);
    // One batch call covers every grantable path — one card, not one per path.
    expect(requested).toEqual([{ paths, preauthorize: true }]);
    expect(result.content).toContain('用户已允许');
    for (const p of paths) expect(result.content).toContain(p);
  });

  it('a successful task does not hold a card for an incidental denial', async () => {
    const { bash, requested, ctx } = toolsFor('task', 0);
    const result = await executeToolSafely(bash, { command: 'cat /tmp/outside/secret.txt' }, ctx);
    expect(requested).toEqual([]);
    expect(result.content).toContain('request_access');
    expect(result.content).not.toContain('用户已允许');
  });

  it('a turn keeps the old hint and never holds a card', async () => {
    const { bash, requested, ctx } = toolsFor('turn');
    const result = await executeToolSafely(bash, { command: 'cat /tmp/outside/secret.txt' }, ctx);
    expect(requested).toEqual([]);
    expect(result.content).toContain('request_access');
    expect(result.content).not.toContain('用户已允许');
  });

  it('a network violation line points at request_network (D140-3), with no path card', async () => {
    const { bash, requested, ctx } = toolsFor('task', 1, [
      { line: 'deny network-outbound api.example.com:443 (proxy deny: not allowed by network policy)' },
      { line: 'deny http-request GET https://api.example.com/x (proxy deny: not allowed by network policy)' },
    ]);
    const result = await executeToolSafely(bash, { command: 'curl https://api.example.com' }, ctx);
    // Network lines are not file paths: no access batch, only the request_network hint.
    expect(requested).toEqual([]);
    expect(result.content).toContain('request_network');
    expect(result.content).toContain('外部网络被污点保护切断');
    expect(result.content).not.toContain('request_access');
  });
});
