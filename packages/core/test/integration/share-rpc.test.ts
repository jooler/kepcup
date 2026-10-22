import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';
import type { ShareConsumeInput, ShareFailedItem, ShareTargets } from '@kepcup/shared';

/**
 * D94 分享接收的 RPC 口径：平台方法（share.targets / share.consume，主进程调
 * core）与 App 方法（share.failed.*，渲染层调 core）都可用，失败可恢复。
 */

let stack: TestStack;
let botA: string;
let botB: string;

beforeAll(async () => {
  stack = await createTestStack();
  botA = (await makeBot(stack.core, '阿甲')).id;
  botB = (await makeBot(stack.core, '阿乙')).id;
});

afterAll(async () => {
  await stack.cleanup();
});

function callPlatform<T>(method: string, input?: unknown): Promise<T> {
  const spec = stack.core.services.platformMethods[method];
  if (!spec) throw new Error(`platform method ${method} is not registered`);
  return spec.handle(input) as Promise<T>;
}

function callApp<T>(method: string, input?: unknown): Promise<T> {
  const spec = stack.core.services.appMethods[method];
  if (!spec) throw new Error(`app method ${method} is not registered`);
  return spec.handle(input) as Promise<T>;
}

/** 在 core inbox 里造一个批次目录（模拟主进程搬过来的样子）。 */
function stageIntake(
  intakeId: string,
  target: { kind: 'bot' | 'project'; id: string },
  bytes: Buffer,
): ShareConsumeInput {
  const home = stack.core.services.paths.home;
  const dir = path.join(home, 'inbox', 'share', intakeId);
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  writeFileSync(path.join(dir, 'files', '000-a.zip'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      intakeId,
      createdAt: Date.now(),
      target,
      note: '',
      files: [
        {
          stagedName: '000-a.zip',
          originalName: 'a.zip',
          mime: 'application/zip',
          size: bytes.length,
          sha256,
        },
      ],
    }),
  );
  return {
    intakeId,
    target,
    note: '',
    files: [
      {
        path: path.join(dir, 'files', '000-a.zip'),
        originalName: 'a.zip',
        mime: 'application/zip',
        size: bytes.length,
        sha256,
      },
    ],
  };
}

describe('分享目标快照（share.targets）', () => {
  it('返回 Bot 与项目组列表（只有 id / 名称 / 类型 / 归档位）', async () => {
    const targets = await callPlatform<ShareTargets>('share.targets');
    expect(targets.version).toBe(1);
    expect(targets.bots.map((bot) => bot.id)).toContain(botA);
    expect(targets.bots[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      kind: 'bot',
      archived: false,
    });
  });
});

describe('分享消费（share.consume）', () => {
  it('投递到 Bot 私聊，重复调用只有一条消息', async () => {
    const input = stageIntake('shr_rpconetest', { kind: 'bot', id: botA }, Buffer.from('zip'));
    const first = await callPlatform<{ state: string; messageId?: string }>('share.consume', input);
    expect(first.state).toBe('done');
    expect(first.messageId).toBeTruthy();

    const second = await callPlatform<{ state: string; messageId?: string }>(
      'share.consume',
      input,
    );
    expect(second.state).toBe('done');
    expect(second.messageId).toBe(first.messageId);
  });
});

describe('分享失败恢复（share.failed.*）', () => {
  it('目标失效后进恢复列表，可重选目标重试', async () => {
    const victim = (await makeBot(stack.core, '将被删')).id;
    const input = stageIntake('shr_rpctwotest', { kind: 'bot', id: victim }, Buffer.from('zip'));
    // Bot 删除 → 目标失效
    await stack.core.rpc.call('bots.delete', { id: victim });
    const result = await callPlatform<{ state: string; errorCode?: string }>(
      'share.consume',
      input,
    );
    expect(result.state).toBe('failed_target');
    expect(result.errorCode).toBe('SHARE_TARGET_NOT_FOUND');

    const list = await callApp<{ items: ShareFailedItem[] }>('share.failed.list');
    const item = list.items.find((entry) => entry.intakeId === 'shr_rpctwotest');
    expect(item).toBeDefined();
    expect(item?.target).toEqual({ kind: 'bot', id: victim });

    const retried = await callApp<{ state: string; messageId?: string }>('share.failed.retry', {
      intakeId: 'shr_rpctwotest',
      target: { kind: 'bot', id: botB },
    });
    expect(retried.state).toBe('done');
    expect(retried.messageId).toBeTruthy();

    const after = await callApp<{ items: ShareFailedItem[] }>('share.failed.list');
    expect(after.items.find((entry) => entry.intakeId === 'shr_rpctwotest')).toBeUndefined();
  });

  it('discard 删除失败批次', async () => {
    const victim = (await makeBot(stack.core, '将被删2')).id;
    const input = stageIntake('shr_rpcthreetest', { kind: 'bot', id: victim }, Buffer.from('zip'));
    await stack.core.rpc.call('bots.delete', { id: victim });
    await callPlatform('share.consume', input);
    const discarded = await callApp<{ ok: boolean }>('share.failed.discard', {
      intakeId: 'shr_rpcthreetest',
    });
    expect(discarded.ok).toBe(true);
    const list = await callApp<{ items: ShareFailedItem[] }>('share.failed.list');
    expect(list.items.find((entry) => entry.intakeId === 'shr_rpcthreetest')).toBeUndefined();
  });
});
