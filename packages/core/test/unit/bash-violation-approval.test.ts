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

function toolsFor(loopType: RunIdentity['loopType'], exitCode = 1) {
  const requested: Array<{ path: string; mode: string; preauthorize?: boolean }> = [];
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
      violations: [{ line: `cat(x) deny(1) file-read-data ${blocked}` }],
    }),
    checkPath: () => ({ kind: 'needs_grant', resolvedPath: blocked, reason: 'outside' }),
    ensurePathAccess: async (
      _identity: RunIdentity,
      target: string,
      mode: 'read' | 'write',
      _reason: string,
      options: { preauthorize?: boolean } = {},
    ) => {
      requested.push({
        path: target,
        mode,
        ...(options.preauthorize !== undefined ? { preauthorize: options.preauthorize } : {}),
      });
      return target;
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
    expect(requested).toEqual([{ path: blocked, mode: 'read', preauthorize: true }]);
    expect(result.content).toContain('用户已允许');
    expect(result.content).toContain('重新执行命令');
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
});
