import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';
import type { ToolGateway } from '../../src/gateway/index.js';
import { buildCodingTools } from '../../src/tools/coding-tools.js';
import { FileReadState } from '../../src/tools/fs-state.js';
import { executeToolSafely } from '../../src/agent/tool-execution.js';

/**
 * D123 ④: a write outside the task's declared domain is fail-closed at step 0
 * of `gateway.checkPath` — before workspace / grant allowances are consulted —
 * so the sandbox hint must send the task to ask_user, not request_access.
 * Plain access denials (a grant really can free them) keep the old hint.
 */

const outside = '/proj/other/file.txt';

function toolsFor(options: {
  violation: string;
  checkPath: (identity: RunIdentity, target: string, mode: 'read' | 'write') => unknown;
}) {
  const requested: Array<{ path: string; mode: string; preauthorize?: boolean }> = [];
  const identity: RunIdentity = {
    runId: 'run_task',
    botId: 'bot_x',
    conversationId: 'conv_x',
    loopType: 'task',
  };
  const gateway = {
    exec: async () => ({
      exitCode: 1,
      timedOut: false,
      violations: [{ line: options.violation }],
    }),
    checkPath: options.checkPath,
    ensurePathAccess: async (
      _identity: RunIdentity,
      target: string,
      mode: 'read' | 'write',
      _reason: string,
      extra: { preauthorize?: boolean } = {},
    ) => {
      requested.push({
        path: target,
        mode,
        ...(extra.preauthorize !== undefined ? { preauthorize: extra.preauthorize } : {}),
      });
      return target;
    },
  } as unknown as ToolGateway;
  const tools = buildCodingTools(identity, {
    gateway,
    workspacePath: mkdtempSync(path.join(os.tmpdir(), 'kepcup-bash-domain-')),
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

describe('sandbox violations outside the task write domain (D123 ④)', () => {
  it('points at ask_user instead of request_access, and holds no grant card', async () => {
    const { bash, requested, ctx } = toolsFor({
      violation: `bash(x) deny(1) file-write-create ${outside}`,
      checkPath: (_identity, _target, mode) =>
        mode === 'write'
          ? { kind: 'forbidden', resolvedPath: outside, reason: '写域外', outOfDomain: true }
          : { kind: 'needs_grant', resolvedPath: outside, reason: 'outside' },
    });
    const result = await executeToolSafely(bash, { command: 'echo x > other/file.txt' }, ctx);
    expect(result.content).toContain('在本任务写域之外');
    expect(result.content).toContain('ask_user');
    expect(result.content).toContain('request_access 不能解除写域限制');
    expect(result.content).not.toContain('可调用 request_access 工具申请');
    expect(requested).toEqual([]);
  });

  it('keeps the request_access hint when a grant can actually free the path', async () => {
    const { bash, ctx } = toolsFor({
      violation: `bash(x) deny(1) file-write-create ${outside}`,
      checkPath: () => ({ kind: 'needs_grant', resolvedPath: outside, reason: 'outside' }),
    });
    const result = await executeToolSafely(bash, { command: 'echo x > other/file.txt' }, ctx);
    expect(result.content).toContain('可调用 request_access 工具申请');
    expect(result.content).not.toContain('在本任务写域之外');
  });

  it('a read denial is never called a domain violation', async () => {
    const { bash, ctx } = toolsFor({
      violation: `cat(x) deny(1) file-read-data ${outside}`,
      checkPath: () => ({ kind: 'needs_grant', resolvedPath: outside, reason: 'outside' }),
    });
    const result = await executeToolSafely(bash, { command: 'cat other/file.txt' }, ctx);
    expect(result.content).toContain('可调用 request_access 工具申请');
    expect(result.content).not.toContain('在本任务写域之外');
  });
});
