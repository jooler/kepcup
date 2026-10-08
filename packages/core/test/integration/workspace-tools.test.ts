import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { step } from '@kepcup/testkit';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<TestStack> {
  const stack = await createTestStack({ env });
  stacks.push(stack);
  return stack;
}

function workspaceOf(stack: { core: TestStack['core'] }, botId: string, conversationId: string): string {
  return workspacePathFor(resolvePaths(stack.core.services.paths.home), botId, conversationId);
}

async function stepsOf(core: TestStack['core'], runId: string) {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps;
}

describe('workspace and coding tools', () => {
  it('writes a script, executes it in the sandbox and reads the output', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('write', {
        path: 'hello.sh',
        content: '#!/bin/sh\necho "hello-from-workspace"\n',
      }),
      step().replyToolCall('edit', {
        path: 'hello.sh',
        edits: [{ oldText: 'hello-from-workspace', newText: 'edited-from-workspace' }],
      }),
      step().replyToolCall('bash', { command: 'sh hello.sh' }),
      step().replyText('脚本执行完成'),
    ]);
    const bot = await makeBot(core, '小码');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['写个脚本跑一下']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    const workspace = workspaceOf({ core }, bot.id, conv.id);
    expect(existsSync(path.join(workspace, 'hello.sh'))).toBe(true);

    const steps = await stepsOf(core, run.id);
    const bashResult = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'bash',
    );
    expect(bashResult).toBeDefined();
    expect(String(bashResult!.payload['content'])).toContain('edited-from-workspace');

    // The command description reached the status line as a progress step.
    const progress = steps.find(
      (s) => s.type === 'progress' && String(s.payload['text']).startsWith('正在执行命令'),
    );
    expect(progress).toBeDefined();
    expect(String(progress!.payload['text'])).toContain('sh hello.sh');

    // The <workspace> section reached the model.
    expect(llm.requestBodiesContain('<workspace>')).toBe(true);
  }, 180_000);

  it('redacts stored secret values from coding tool output before it reaches the model', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小密');
    const conv = await openDirect(core, bot.id);
    const workspace = workspaceOf({ core }, bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    const secretValue = 'sk-test-leaked-value-0123456789abcdef';
    writeFileSync(path.join(workspace, 'key.txt'), `token=${secretValue}\n`);
    core.services.domain!.secrets.setValue('test-leak', secretValue);

    llm.script('mock-main', [
      step().replyToolCall('read', { path: 'key.txt' }),
      step().replyText('读完了'),
    ]);
    await sendBatch(core, conv.id, ['看看配置']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    // The raw value never enters a model request body (BR-P02-003).
    expect(llm.requestBodiesContain(secretValue)).toBe(false);
    // The persisted tool result is redacted like every other step payload.
    const steps = await stepsOf(core, run.id);
    const readResult = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'read',
    );
    expect(readResult).toBeDefined();
    expect(String(readResult!.payload['content'])).toContain('[REDACTED]');
    expect(String(readResult!.payload['content'])).not.toContain(secretValue);
  }, 180_000);

  it('denies file-tool access to another conversation workspace', async () => {    const { core, llm } = await start();
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const wsA = workspaceOf({ core }, botA.id, convA.id);
    const wsB = workspaceOf({ core }, botB.id, convB.id);
    expect(wsA).not.toBe(wsB);
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    writeFileSync(path.join(wsB, 'private.txt'), 'secret-of-b');

    llm.script('mock-main', [
      step().replyToolCall('read', { path: wsB }),
      step().replyText('读不到就算了'),
    ]);
    await sendBatch(core, convA.id, ['看看乙的目录']);
    await waitForRun(core, convA.id, 'completed', { timeoutMs: 60_000 });

    // P07：runs.list 里还有后台反思 run，取最新的响应 run。
    const runsA = (await core.rpc.call('runs.list', { conversationId: convA.id, limit: 5 }) as { runs: Array<{ id: string; loopType: string }> }).runs;
    const steps = await stepsOf(core, runsA.find((r) => r.loopType === 'turn')!.id);
    const readResult = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'read',
    );
    expect(readResult).toBeDefined();
    expect(readResult!.payload['ok']).toBe(false);
    expect(String(readResult!.payload['content'])).toContain('PATH_OUT_OF_SCOPE');
    // The secret never reached the model.
    expect(llm.requestBodiesContain('secret-of-b')).toBe(false);
  }, 90_000);

  it('routes commands into confirm mode when the sandbox is disabled (P03)', async () => {
    const { core, llm } = await start({ KEPCUP_SANDBOX: 'off' });
    llm.script('mock-main', [
      step().replyToolCall('bash', { command: 'touch sandbox-off-marker' }),
      step().replyText('好的'),
    ]);
    const bot = await makeBot(core, '小停');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['执行一条命令']);
    // The command needs a `command` approval now; the run pauses.
    const approval = await waitFor(
      async () => {
        const result = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Array<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>;
        };
        return result.approvals.find((a) => a.kind === 'command' && a.status === 'pending') ?? null;
      },
      { label: 'command approval', timeoutMs: 30_000 },
    );
    expect(String(approval!.payload['command'])).toBe('touch sandbox-off-marker');

    // Deny: the tool reports APPROVAL_DENIED and nothing executes.
    await core.rpc.call('approvals.decide', { id: approval!.id, approve: false });
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const bashResult = steps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'bash',
    );
    expect(bashResult).toBeDefined();
    expect(String(bashResult!.payload['content'])).toContain('APPROVAL_DENIED');
    expect(bashResult!.payload['ok']).toBe(false);

    // The workspace contains no marker file: the command never ran.
    const workspace = workspaceOf({ core }, bot.id, conv.id);
    expect(existsSync(path.join(workspace, 'sandbox-off-marker'))).toBe(false);
  }, 90_000);

  it('records exec and fs_write entries in audit_log', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('write', { path: 'a.txt', content: 'x' }),
      step().replyToolCall('bash', { command: 'true' }),
      step().replyText('完成'),
    ]);
    const bot = await makeBot(core, '小记');
    const conv = await openDirect(core, bot.id);
    await sendBatch(core, conv.id, ['记录审计']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    const rows = core.services.domain!.audit.listByConversation(conv.id, 50);
    expect(rows.some((r) => r.action === 'fs_write' && String(r.detail['path']).endsWith('a.txt'))).toBe(true);
    expect(rows.some((r) => r.action === 'exec' && r.detail['command'] === 'true')).toBe(true);
    expect(rows.every((r) => r.botId === bot.id)).toBe(true);
  }, 180_000);

  it('sends workspace files as attachments and copies non-textual attachments into the workspace', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小邮');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().replyToolCall('write', { path: 'report.txt', content: '报告内容' }),
      step().replyToolCall('send_message', {
        text: '报告好了',
        attachment_paths: ['report.txt'],
      }),
      step().replyText('发完了'),
    ]);
    await sendBatch(core, conv.id, ['把报告发我']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });
    void 0;

    const messages = await listMessages(core, conv.id);
    const botMessage = messages.find(
      (m) => m.senderBotId === bot.id && m.attachments && m.attachments.length > 0,
    );
    expect(botMessage).toBeDefined();
    const attachment = botMessage!.attachments![0]!;
    expect(attachment.fileName).toBe('report.txt');
    const stored = path.join(
      resolvePaths(core.services.paths.home).home,
      'conversations',
      conv.id,
      'attachments',
    );
    expect(readFileSync(path.join(stored, attachment.relPath), 'utf8')).toBe('报告内容');

    // Non-textual attachment: upload a small png, then let the bot fetch it —
    // get_attachment copies it into the workspace instead of returning text.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
        '0d0a2db40000000049454e44ae426082',
      'hex',
    );
    const uploaded = (await core.rpc.call('attachments.upload', {
      conversationId: conv.id,
      fileName: 'diag.png',
      mime: 'image/png',
      bytesBase64: png.toString('base64'),
    })) as { attachment: { id: string } };

    llm.script('mock-main', [
      step().replyToolCall('get_attachment', { attachment_id: uploaded.attachment.id }),
      step().replyText('图片已拿到'),
    ]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '给我那张图' });
    const flushed = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as { runId: string | null };
    await waitFor(
      async () => {
        const run = ((await core.rpc.call('runs.list', { conversationId: conv.id, limit: 10 })) as { runs: Run[] }).runs.find((r) => r.id === flushed.runId);
        return run && (run.status === 'completed' || run.status === 'failed') ? run : null;
      },
      { timeoutMs: 120_000, label: 'attachment run settles' },
    );
    const steps = await stepsOf(core, flushed.runId!);
    const copyResult = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'get_attachment',
    );
    expect(copyResult, JSON.stringify(steps.map((s) => ({ t: s.type, name: s.payload['toolName'], ok: s.payload['ok'] })))).toBeDefined();
    expect(String(copyResult!.payload['content'])).toContain('已复制到 workspace');

    const workspace = workspaceOf({ core }, bot.id, conv.id);
    const copied = readdirOne(path.join(workspace, '.attachments'));
    expect(copied).toContain('diag.png');
    expect(readFileSync(path.join(workspace, '.attachments', copied)).subarray(0, 4)).toEqual(png.subarray(0, 4));
  }, 240_000);

  it('surfaces sandbox violations inside the bash tool result step', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小违');
    const conv = await openDirect(core, bot.id);
    const dbPath = core.services.paths.mainDbPath;
    llm.script('mock-main', [
      step().replyToolCall('bash', { command: `cat "${dbPath}"` }),
      step().replyText('读不了'),
    ]);
    await sendBatch(core, conv.id, ['读读数据库']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    const steps = await stepsOf(core, run.id);
    const bashResult = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'bash',
    );
    expect(bashResult).toBeDefined();
    const content = String(bashResult!.payload['content']);
    // The violation summary reaches the model through the tool result.
    expect(content).toContain('被沙箱拦截');
    expect(bashResult!.payload['ok']).toBe(false);
  }, 180_000);

  it('removes every workspace of a conversation on delete and all workspaces of a bot on bot delete', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);

    llm.script('mock-main', [step().replyText('好'), step().replyText('好')]);
    await sendBatch(core, convA.id, ['建目录']);
    await sendBatch(core, convB.id, ['建目录']);
    await waitForRun(core, convA.id, 'completed', { timeoutMs: 60_000 });
    await waitForRun(core, convB.id, 'completed', { timeoutMs: 60_000 });

    const wsA = workspaceOf({ core }, botA.id, convA.id);
    const wsB = workspaceOf({ core }, botB.id, convB.id);
    expect(existsSync(wsA)).toBe(true);
    expect(existsSync(wsB)).toBe(true);

    await core.rpc.call('conversations.delete', { id: convA.id });
    expect(existsSync(wsA)).toBe(false);
    expect(existsSync(wsB)).toBe(true); // other conversation untouched

    await core.rpc.call('bots.delete', { id: botB.id });
    expect(existsSync(wsB)).toBe(false);
    expect(existsSync(path.dirname(wsB))).toBe(false); // bots/{id}/ removed entirely
    void llm;
  }, 120_000);
});

function readdirOne(dir: string): string {
  const entries = readdirSync(dir);
  expect(entries.length).toBeGreaterThan(0);
  return entries[0]!;
}
