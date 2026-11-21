import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 62.11 C9（CoreServicesOptions.workdirRoots）：workdir 绑定只接受根之下的路径
 * （select 校验、任务 cwd 同口径）；provisionWorkdir 在 roots[0] 建目录并绑定；
 * 未配置根 = 现状（任何目录都可绑定）。
 */

describe('62.11 C9 workdir 根约束', () => {
  let stack: TestStack;
  let root: string;
  let outside: string;
  let conversationId: string;

  beforeAll(async () => {
    // macOS /var is a symlink to /private/var: compare canonical (realpath'd)
    // paths, exactly like the runtime does.
    root = realpathSync(await mkdtemp(path.join(tmpdir(), 'kepcup-roots-')));
    outside = realpathSync(await mkdtemp(path.join(tmpdir(), 'kepcup-outside-')));
    stack = await createTestStack({ workdirRoots: [root] });
    const bot = await makeBot(stack.core, '根内甲');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('根外路径 select 被拒（PATH_OUT_OF_SCOPE），且不留 workdirs 行', async () => {
    await expect(
      stack.core.rpc.call('workdirs.select', { conversationId, path: outside }),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });
    const recent = (await stack.core.rpc.call('workdirs.list')) as {
      workdirs: Array<{ path: string }>;
    };
    expect(recent.workdirs.map((w) => w.path)).not.toContain(outside);
  });

  it('根内路径 select 正常绑定（子目录新建也行）', async () => {
    const inner = path.join(root, 'project-alpha');
    await mkdir(inner, { recursive: true });
    const result = (await stack.core.rpc.call('workdirs.select', {
      conversationId,
      path: inner,
    })) as { workdir: { path: string; id: string } };
    expect(result.workdir.path.startsWith(root)).toBe(true);
  });

  it('start_task 的 cwd（绑定 workdir）越根被拒：任务不被创建', async () => {
    // 直接走 domain 落一个根外的绑定（绕过 select 的校验，模拟宿主配置变更 /
    // 既有数据），start_task 以 cwd:'workdir' 派任务时被 resolveCwd 断言拦下。
    const domain = stack.core.services.domain!;
    const workdir = domain.workdirs.ensureByPath(outside, stack.core.services.paths.home);
    domain.conversations.setWorkdir(conversationId, workdir.id);

    const before = (await stack.core.rpc.call('runs.list', { conversationId, limit: 50 })) as {
      runs: Array<{ loopType: string }>;
    };
    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .replyToolCall('start_task', {
          instruction: '看看目录里有什么',
          source_message_ids: [],
          cwd: 'workdir',
          writes: false,
        }),
      step().inTurn().replyText('任务派失败了，我直接说明。'),
    ]);
    await sendBatch(stack.core, conversationId, ['看看目录']);
    await waitForRun(stack.core, conversationId, 'completed');

    const after = (await stack.core.rpc.call('runs.list', { conversationId, limit: 50 })) as {
      runs: Array<{ loopType: string }>;
    };
    expect(
      after.runs.filter((r) => r.loopType === 'task').length,
    ).toBe(before.runs.filter((r) => r.loopType === 'task').length);
  });

  it('provisionWorkdir：在 roots[0] 下建目录并绑定', () => {
    const ops = stack.core.services.principalOps!;
    const workdir = ops.provisionWorkdir(conversationId, '报表 项目!');
    expect(workdir.path.startsWith(root)).toBe(true);
    expect(workdir.status).toBe('available');
    const bound = stack.core.services.domain!.conversations.get(conversationId);
    expect(bound?.workdirId).toBe(workdir.id);
  });
});

describe('62.11 C9 未配置根 = 现状', () => {
  let stack: TestStack;
  let outside: string;
  let conversationId: string;

  beforeAll(async () => {
    outside = realpathSync(await mkdtemp(path.join(tmpdir(), 'kepcup-free-')));
    stack = await createTestStack();
    const bot = await makeBot(stack.core, '自由乙');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
    await rm(outside, { recursive: true, force: true });
  });

  it('任意目录都可绑定；provisionWorkdir 无根抛 INVALID_INPUT', async () => {
    const result = (await stack.core.rpc.call('workdirs.select', {
      conversationId,
      path: outside,
    })) as { workdir: { path: string } };
    expect(result.workdir.path).toBe(outside);
    try {
      stack.core.services.principalOps!.provisionWorkdir(conversationId, '随便');
      expect.unreachable('provisionWorkdir should fail without roots');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_INPUT');
    }
  });
});
