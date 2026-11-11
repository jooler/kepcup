import { describe, expect, it } from 'vitest';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';
import { AppError } from '@kepcup/shared';
import type { ToolGateway } from '../../src/gateway/index.js';
import { buildResponseTools } from '../../src/tools/index.js';
import { executeToolSafely } from '../../src/agent/tool-execution.js';

/**
 * D123 ④: the step-0 write refusals of `gateway.checkPath` (declared write
 * domain, another task's claim, a read-only run) are fail-closed before any
 * grant, so `request_access` can never free them. The tool must answer with
 * what does work instead of throwing the raw gateway error at the model; the
 * grantable codes keep their own behaviour (PATH_OUT_OF_SCOPE surfaces, other
 * errors still throw).
 */

const identity: RunIdentity = {
  runId: 'run_task',
  botId: 'bot_x',
  conversationId: 'conv_x',
  loopType: 'task',
};

const ctx: ToolContext = {
  identity,
  signal: new AbortController().signal,
  terminate: () => {},
  progress: () => {},
};

function requestAccessTool(ensurePathAccess: () => Promise<string>): ToolDefinition {
  const tools = buildResponseTools({
    identity,
    deps: {
      gateway: { ensurePathAccess } as unknown as ToolGateway,
    } as never,
  });
  const tool = tools.find((candidate) => candidate.name === 'request_access');
  if (tool === undefined) throw new Error('request_access is not registered');
  return tool;
}

function refusing(code: string, message: string) {
  return async (): Promise<string> => {
    throw new AppError(code, message);
  };
}

describe('request_access on an ungrantable write refusal (D123 ④)', () => {
  it('a write-domain refusal sends the task to ask_user', async () => {
    const tool = requestAccessTool(refusing('WRITE_OUT_OF_DOMAIN', '写域之外的路径：/proj/x'));
    const result = await executeToolSafely(tool, { path: '/proj/x', access: 'write', reason: 'r' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('写域之外的路径：/proj/x');
    expect(result.content).toContain('request_access 不能解除写域限制');
    expect(result.content).toContain('ask_user');
  });

  it("another task's claim is not something request_access can lift", async () => {
    const tool = requestAccessTool(refusing('WRITE_CLAIMED', '已被任务 task_a 认领'));
    const result = await executeToolSafely(tool, { path: '/proj/x', access: 'write', reason: 'r' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('request_access 不能解除其他任务的认领');
    expect(result.content).toContain('等持有任务结束');
  });

  it('a read-only run offers a write task instead of a grant', async () => {
    const tool = requestAccessTool(refusing('RUN_READ_ONLY', '只读任务不能写'));
    const result = await executeToolSafely(tool, { path: '/proj/x', access: 'write', reason: 'r' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('request_access 不能让只读任务写入');
    expect(result.content).toContain('ask_user');
  });

  it('a path that is merely out of scope still surfaces PATH_OUT_OF_SCOPE', async () => {
    const tool = requestAccessTool(refusing('PATH_OUT_OF_SCOPE', '数据目录不可访问'));
    const result = await executeToolSafely(tool, { path: '/data/x', access: 'read', reason: 'r' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PATH_OUT_OF_SCOPE');
    expect(result.content).toContain('数据目录不可访问');
    expect(result.content).not.toContain('request_access 不能');
  });
});
