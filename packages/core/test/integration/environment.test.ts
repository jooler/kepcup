import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listAllMessages,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  startFileServer,
  step,
  waitFor,
  waitForEvent,
  waitForMessage,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { Approval, EnvInstall, Run } from '@kepcup/shared';
import type { Catalog } from '../../src/env/catalog.js';
import { resolvePaths, toolchainPathFor } from '../../src/infra/paths.js';

const stacks: TestStack[] = [];
const fileServers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const server of fileServers.splice(0)) await server.stop();
});

const FAKE_VERSION = '1.0.0';
const FAKE_ITEM = 'fakeuv';

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Builds a tar.gz whose single root dir holds one executable shell script. */
function fakeToolchainArchive(dir: string): { buffer: Buffer; sha256: string } {
  const root = path.join(dir, `${FAKE_ITEM}-${FAKE_VERSION}-bin`);
  mkdirSync(root, { recursive: true });
  const script = path.join(root, FAKE_ITEM);
  writeFileSync(script, '#!/bin/sh\necho "fakeuv 1.0.0"\n');
  chmodSync(script, 0o755);
  const archive = path.join(dir, `${FAKE_ITEM}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, `${FAKE_ITEM}-${FAKE_VERSION}-bin`]);
  const buffer = execFileSync('cat', [archive]);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

interface FakeEnv {
  catalog: Catalog;
  archiveUrl: string;
}

/** Fake catalog + local file server (tests never hit real release pages). */
async function startFakeEnv(
  overrides: { sha256?: string; sizeBytes?: number } = {},
): Promise<FakeEnv> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-env-fixture-'));
  const { buffer, sha256 } = fakeToolchainArchive(dir);
  const server = await startFileServer({
    [`${FAKE_ITEM}-${FAKE_VERSION}-${platformKey()}.tar.gz`]: buffer,
  });
  fileServers.push(server);
  const archiveUrl = `${server.url}/${FAKE_ITEM}-${FAKE_VERSION}-${platformKey()}.tar.gz`;
  const catalog: Catalog = [
    {
      item: FAKE_ITEM,
      version: FAKE_VERSION,
      displayName: 'FakeUV',
      source: 'http://127.0.0.1/fake-release',
      install: { via: 'archive' },
      platforms: {
        [platformKey()]: {
          url: archiveUrl,
          sha256: overrides.sha256 ?? sha256,
          sizeBytes: overrides.sizeBytes ?? buffer.byteLength,
          kind: 'archive',
        },
      },
      verify: { command: '"{bin}" --version', expect: 'fakeuv 1.0.0' },
    },
  ];
  return { catalog, archiveUrl };
}

async function envList(core: TestStack['core']): Promise<EnvInstall[]> {
  const result = (await core.rpc.call('environment.list')) as { installs: EnvInstall[] };
  return result.installs;
}

async function installOf(core: TestStack['core'], item: string): Promise<EnvInstall> {
  return waitFor(
    async () => {
      const installs = await envList(core);
      return (
        installs.find((install) => install.item === item && install.status !== 'installing') ?? null
      );
    },
    { label: `install row for ${item}` },
  );
}

async function pendingEnvironmentApproval(
  core: TestStack['core'],
  conversationId: string,
): Promise<Approval> {
  return waitFor(
    async () => {
      const result = (await core.rpc.call('approvals.list', { conversationId })) as {
        approvals: Approval[];
      };
      return (
        result.approvals.find((a) => a.kind === 'environment' && a.status === 'pending') ?? null
      );
    },
    { label: 'pending environment approval' },
  );
}

async function lastToolResult(
  core: TestStack['core'],
  conversationId: string,
): Promise<Record<string, unknown>> {
  const runs = (await core.rpc.call('runs.list', { conversationId, limit: 30 })) as { runs: Run[] };
  // created_at 同毫秒并列时 order by 不稳定；run id 是 ULID，字典序即时间序。
  const run = runs.runs
    .filter((r) => r.loopType === 'response' && r.triggerReason !== 'event')
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0]!;
  const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return steps.steps.filter((s) => s.type === 'tool_result').at(-1)?.payload ?? {};
}

describe('environment manager (P06)', () => {
  it('approval → download → verify → install → event delivery to the requesting bot', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小环');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().replyToolCall('request_environment', { item: FAKE_ITEM, reason: '构建需要' }),
      step().replyText('已申请，等通知'),
      step().replyText('装好了，继续干活'),
    ]);
    await sendBatch(core, conv.id, ['装一下 fakeuv']);

    // 工具立即返回，不阻塞 run（任务书：提交后立即返回）。
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const submitted = await lastToolResult(core, conv.id);
    expect(submitted['ok']).toBe(true);
    expect(String(submitted['content'])).toContain('已提交');

    const approval = await pendingEnvironmentApproval(core, conv.id);
    expect(approval.payload['item']).toBe(FAKE_ITEM);
    expect(approval.payload['sizeBytes']).toBeGreaterThan(0);
    expect(String(approval.payload['source'])).toContain('127.0.0.1');
    // 卡片消息进了对话。
    const messages = await listMessages(core, conv.id);
    expect(messages.some((m) => m.kind === 'card' && m.content['approvalId'] === approval.id)).toBe(
      true,
    );

    const changedPromise = waitForEvent<{ installs: EnvInstall[] }>(
      core,
      'environment.changed',
      (payload) => payload.installs.some((i) => i.item === FAKE_ITEM && i.status === 'installed'),
      { timeoutMs: 60_000 },
    );
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const changed = await changedPromise;
    const install = changed.installs.find((i) => i.item === FAKE_ITEM)!;
    expect(install.version).toBe(FAKE_VERSION);
    expect(install.relPath).toBe(`${FAKE_ITEM}/${FAKE_VERSION}`);
    expect(install.sizeBytes).toBeGreaterThan(0);
    expect(install.binDirs.length).toBeGreaterThan(0);
    expect(install.requestedBy).toBe(bot.id);

    const paths = resolvePaths(core.services.paths.home);
    expect(existsSync(toolchainPathFor(paths, FAKE_ITEM, FAKE_VERSION))).toBe(true);
    // 目录留在 toolchains/ 下，下载缓存清空（无残留）。
    expect(readdirSync(paths.toolchainsDir)).toContain(FAKE_ITEM);
    expect(readdirSync(paths.cacheDownloadsDir)).toEqual([]);

    // 安装完成 → event 触发的 run，Bot 继续工作。
    const eventRun = await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 20 })) as {
          runs: Run[];
        };
        return runs.runs.find((r) => r.triggerReason === 'event') ?? null;
      },
      { label: 'event-triggered run', timeoutMs: 30_000 },
    );
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    expect(eventRun.triggerReason).toBe('event');
    const continueMessage = await waitForMessage(
      core,
      conv.id,
      (m) =>
        m.kind === 'text' && m.senderBotId === bot.id && m.content['text'] === '装好了，继续干活',
    );
    expect(continueMessage.runId).toBe(eventRun.id);
  }, 120_000);

  it('checksum mismatch fails the install, leaves no residue and notifies the bot', async () => {
    const { catalog } = await startFakeEnv({ sha256: '0'.repeat(64) });
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小校');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().replyToolCall('request_environment', { item: FAKE_ITEM, reason: '需要' }),
      step().replyText('已申请'),
      step().replyText('好的，失败了我知道了'),
    ]);
    await sendBatch(core, conv.id, ['装 fakeuv']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const approval = await pendingEnvironmentApproval(core, conv.id);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });

    const install = await installOf(core, FAKE_ITEM);
    expect(install.status).toBe('failed');

    const paths = resolvePaths(core.services.paths.home);
    // 不留残留：目标目录与下载缓存都干净。
    expect(existsSync(toolchainPathFor(paths, FAKE_ITEM, FAKE_VERSION))).toBe(false);
    expect(existsSync(path.join(paths.toolchainsDir, FAKE_ITEM))).toBe(false);
    expect(readdirSync(paths.cacheDownloadsDir)).toEqual([]);

    // 失败也投递事件给申请的 Bot（任务 4：成功或失败后投递）。
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 20 })) as {
      runs: Run[];
    };
    expect(runs.runs.filter((r) => r.triggerReason === 'event').length).toBe(1);
  }, 120_000);

  it('re-requesting an installed item returns the path immediately without a new approval', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小重');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('装一下 fakeuv'))
        .replyToolCall('request_environment', { item: FAKE_ITEM, reason: '第一次' }),
      step()
        .expect((req) => req.lastUserText().includes('装一下 fakeuv'))
        .replyText('第一次申请'),
      // event 触发的续跑（安装完成通知）。
      step()
        .expect((req) => req.lastUserText().includes('environment_installed'))
        .replyText('装好了，继续干活'),
      step()
        .expect((req) => req.lastUserText().includes('再要一次 fakeuv'))
        .replyToolCall('request_environment', { item: FAKE_ITEM, reason: '第二次' }),
      step()
        .expect((req) => req.lastUserText().includes('再要一次 fakeuv'))
        .replyText('第二次直接拿到'),
    ]);
    await sendBatch(core, conv.id, ['装一下 fakeuv']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const approval = await pendingEnvironmentApproval(core, conv.id);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await installOf(core, FAKE_ITEM);

    // 等事件 run 结束且 mailbox 真正释放（runningBotIds 会漏掉注册/收尾窗口，
    // 那两个窗口里投递会变成 steer 而不是新 run）。谓词必须映射成 true/null：
    // waitFor 把任何非 null/undefined 值（包括 false）当作已满足。
    await waitFor(
      async () =>
        (core.services.orchestrator?.isMailboxIdle(bot.id, conv.id) ?? false) ? true : null,
      { label: 'mailbox idle', timeoutMs: 30_000 },
    );
    await sendBatch(core, conv.id, ['再要一次 fakeuv']);
    // 等第二个响应 run 走到终态（waitForRun 会被 run1 的 completed 提前满足）。
    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 20 })) as {
          runs: Run[];
        };
        const mine = runs.runs
          .filter((r) => r.loopType === 'response' && r.triggerReason !== 'event')
          .sort((a, b) => (a.id < b.id ? 1 : -1));
        return mine.length >= 2 && ['completed', 'failed'].includes(mine[0]!.status)
          ? mine[0]
          : null;
      },
      { label: 'second run terminal', timeoutMs: 60_000 },
    );
    const second = await lastToolResult(core, conv.id);
    expect(second['ok']).toBe(true);
    expect(String(second['content'])).toContain('已可用');
    // 没有新的审批卡片。
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(approvals.approvals.filter((a) => a.kind === 'environment').length).toBe(1);
  }, 120_000);

  it(
    'unknown items return ENV_ITEM_UNKNOWN with the offered list',
    { timeout: 60_000 },
    async () => {
      const { catalog } = await startFakeEnv();
      const stack = await createTestStack({ envCatalog: catalog });
      stacks.push(stack);
      const { core, llm } = stack;
      const bot = await makeBot(core, '小知');
      const conv = await openDirect(core, bot.id);

      llm.script('mock-main', [
        step().replyToolCall('request_environment', {
          item: 'definitely-not-a-tool',
          reason: '试试',
        }),
        step().replyText('好吧'),
      ]);
      await sendBatch(core, conv.id, ['装个不存在的']);
      await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
      const result = await lastToolResult(core, conv.id);
      expect(result['ok']).toBe(false);
      expect(result['errorCode']).toBe('ENV_ITEM_UNKNOWN');
      expect(String(result['content'])).toContain(FAKE_ITEM);
      // 没有产生审批。
      const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
        approvals: Approval[];
      };
      expect(approvals.approvals.filter((a) => a.kind === 'environment').length).toBe(0);
    },
    60_000,
  );

  it('unattended mode auto-approves environment requests', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小无');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });

    llm.script('mock-main', [
      step().replyToolCall('request_environment', { item: FAKE_ITEM, reason: '无人值守' }),
      step().replyText('已自动提交'),
      step().replyText('无人值守装好了'),
    ]);
    await sendBatch(core, conv.id, ['装 fakeuv']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

    // 不做任何人工决定，安装照样完成。
    const install = await installOf(core, FAKE_ITEM);
    expect(install.status).toBe('installed');
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    const envApproval = approvals.approvals.find((a) => a.kind === 'environment')!;
    expect(envApproval.autoApproved).toBe(true);
    expect(envApproval.status).toBe('approved');
  }, 120_000);

  it('the environment approval survives the requesting run settling', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小存');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().replyToolCall('request_environment', { item: FAKE_ITEM, reason: '申请后立刻结束' }),
      step().replyText('先走了'),
      step().replyText('回来了'),
    ]);
    await sendBatch(core, conv.id, ['装 fakeuv']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

    // run 已结束，审批仍然 pending（非阻塞路径；run 终态不取消 environment 审批）。
    const approval = await pendingEnvironmentApproval(core, conv.id);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const install = await installOf(core, FAKE_ITEM);
    expect(install.status).toBe('installed');
  }, 120_000);

  it('python via uv: ensures uv first, then installs into UV_PYTHON_INSTALL_DIR', async () => {
    // 假 uv：处理 python install/find，落位 cpython-*/bin/python3（真 uv 的布局）。
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-env-fixture-'));
    const triple =
      process.platform === 'darwin'
        ? `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-none`
        : `${process.platform}-${process.arch}-gnu`;
    const pythonRelBin = `cpython-3.12.11-${triple}/bin`;
    const uvRoot = path.join(dir, 'uv-1.0.0-bin');
    mkdirSync(uvRoot, { recursive: true });
    const uvScript = path.join(uvRoot, 'uv');
    writeFileSync(
      uvScript,
      [
        '#!/bin/sh',
        'if [ "$1" = "python" ] && [ "$2" = "install" ]; then',
        '  mkdir -p "$UV_PYTHON_INSTALL_DIR/' + pythonRelBin + '"',
        '  printf "#!/bin/sh\necho \'Python 3.12.11\'\n" > "$UV_PYTHON_INSTALL_DIR/' +
          pythonRelBin +
          '/python3"',
        '  chmod +x "$UV_PYTHON_INSTALL_DIR/' + pythonRelBin + '/python3"',
        '  exit 0',
        'fi',
        'if [ "$1" = "python" ] && [ "$2" = "find" ]; then',
        '  echo "$UV_PYTHON_INSTALL_DIR/' + pythonRelBin + '/python3"',
        '  exit 0',
        'fi',
        'echo "uv 1.0.0"',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(uvScript, 0o755);
    const pyRoot = path.join(dir, 'fakepy-3.12.11-bin');
    mkdirSync(pyRoot, { recursive: true });
    // fakepy 包内容不重要（uv python install 才产出 python），占位即可。
    writeFileSync(path.join(pyRoot, 'placeholder'), 'x');
    const uvArchive = path.join(dir, 'uv.tar.gz');
    execFileSync('tar', ['-czf', uvArchive, '-C', dir, 'uv-1.0.0-bin']);
    const uvBytes = execFileSync('cat', [uvArchive]);
    const server = await startFileServer({ 'uv.tar.gz': uvBytes });
    fileServers.push(server);
    const key = platformKey();
    const catalog: Catalog = [
      {
        item: 'uv',
        version: '1.0.0',
        displayName: 'uv',
        source: 'http://127.0.0.1/fake-release',
        install: { via: 'archive' },
        platforms: {
          [key]: {
            url: `${server.url}/uv.tar.gz`,
            sha256: createHash('sha256').update(uvBytes).digest('hex'),
            sizeBytes: uvBytes.byteLength,
            kind: 'archive',
          },
        },
        verify: { command: '"{bin}" --version', expect: 'uv 1.0.0' },
      },
      {
        item: 'fakepy',
        version: '3.12.11',
        displayName: 'FakePython',
        source: 'http://127.0.0.1/fake-release',
        install: { via: 'uv-python', pythonVersion: '3.12.11' },
        platforms: {
          [key]: { url: '', sha256: '', sizeBytes: 12_345, kind: 'uv-python' },
        },
        verify: { command: '"{bin}" --version', expect: 'Python 3.12.11' },
      },
    ];

    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core } = stack;
    const bot = await makeBot(core, '小链');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    await core.services.environment!.request(
      { runId: 'run_uvpy', botId: bot.id, conversationId: conv.id, loopType: 'response' },
      { item: 'fakepy', reason: '链式安装' },
    );

    const install = await waitFor(
      async () => {
        const installs = await envList(core);
        return installs.find((i) => i.item === 'fakepy' && i.status !== 'installing') ?? null;
      },
      { label: 'fakepy install row', timeoutMs: 60_000 },
    );
    expect(install.status).toBe('installed');
    // uv 作为前置依赖先装好。
    const uvRow = (await envList(core)).find((i) => i.item === 'uv');
    expect(uvRow?.status).toBe('installed');
    // python 的 bin 目录来自 uv python find（cpython-*/bin）。
    expect(install.binDirs[0]).toContain(`cpython-3.12.11-${triple}/bin`);
    const paths = resolvePaths(core.services.paths.home);
    expect(existsSync(toolchainPathFor(paths, 'fakepy', '3.12.11'))).toBe(true);
  }, 120_000);

  it('system item (BR-P06-001): approval runs the OS action, never the archive installer; recheck resolves the waiter', async () => {
    // fixture 目录初始没有可执行文件 → 检测「未安装」。
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-env-system-'));
    const actions: string[] = [];
    const key = platformKey();
    const catalog: Catalog = [
      {
        item: 'fakegit',
        version: '2.0.0',
        displayName: 'FakeGit',
        source: 'http://127.0.0.1/fake-release',
        install: { via: 'system', macAction: 'xcode-select', linuxGuide: true },
        platforms: {
          [key]: { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
        },
        verify: { command: '"{bin}" --version', expect: 'fakegit version' },
      },
    ];
    const stack = await createTestStack({
      envCatalog: catalog,
      envManagerHooks: {
        runSystemAction: async (entry) => {
          actions.push(entry.item);
        },
        systemDetectionPath: fixtureDir,
      },
    });
    stacks.push(stack);
    const { core } = stack;
    const bot = await makeBot(core, '小系');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    await core.services.environment!.request(
      { runId: 'run_sys', botId: bot.id, conversationId: conv.id, loopType: 'response' },
      { item: 'fakegit', reason: '系统引导' },
    );
    await waitFor(
      async () =>
        (await listAllMessages(core, conv.id)).some(
          (m) =>
            (m.content as { event?: string; internal?: boolean }).event ===
              'environment_pending_system' &&
            (m.content as { internal?: boolean }).internal === true,
        ),
      { label: 'internal environment_pending_system event', timeoutMs: 30_000 },
    );

    // 不建 toolchains 行、不进 archive 安装器（无假失败行）。
    const installs = await envList(core);
    expect(installs.filter((i) => i.item === 'fakegit').length).toBe(0);
    // macOS 上打开了系统安装器（可注入记录）；Linux 无动作（卡片已给命令）。
    if (process.platform === 'darwin') {
      expect(actions).toEqual(['fakegit']);
    } else {
      expect(actions).toEqual([]);
    }

    // 用户完成安装（fixture 出现可执行文件）→ 设置页「重新检测」→ waiter 收到通知。
    const binDir = path.join(fixtureDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, 'fakegit');
    writeFileSync(exe, '#!/bin/sh\necho "fakegit version 2.0.0"\n');
    chmodSync(exe, 0o755);
    await core.rpc.call('environment.recheck');
    await waitFor(
      async () =>
        (await listAllMessages(core, conv.id)).some(
          (m) => (m.content as { event?: string }).event === 'environment_installed',
        ),
      { label: 'internal environment_installed event after recheck', timeoutMs: 30_000 },
    );
  }, 60_000);

  it('orchestration failure (BR-P06-002): a thrown prerequisite still notifies the requesting bot', async () => {
    // uv-python 项但 catalog 没有 uv 条目 → #ensureUv 抛 ENV_ITEM_UNKNOWN → catch。
    const key = platformKey();
    const catalog: Catalog = [
      {
        item: 'orphanpy',
        version: '3.11.0',
        displayName: 'OrphanPython',
        source: 'http://127.0.0.1/fake-release',
        install: { via: 'uv-python', pythonVersion: '3.11.0' },
        platforms: {
          [key]: { url: '', sha256: '', sizeBytes: 10_000, kind: 'uv-python' },
        },
        verify: { command: '"{bin}" --version', expect: 'Python 3.11.0' },
      },
    ];
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core } = stack;
    const bot = await makeBot(core, '小孤');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    await core.services.environment!.request(
      { runId: 'run_orphan', botId: bot.id, conversationId: conv.id, loopType: 'response' },
      { item: 'orphanpy', reason: '前置失败' },
    );
    const install = await waitFor(
      async () => {
        const installs = await envList(core);
        return installs.find((i) => i.item === 'orphanpy' && i.status !== 'installing') ?? null;
      },
      { label: 'orphanpy install row', timeoutMs: 30_000 },
    );
    expect(install.status).toBe('failed');
    // catch 路径也必须投递失败事件（internal：只进 Bot 的上下文）。
    await waitFor(
      async () =>
        (await listAllMessages(core, conv.id)).some(
          (m) =>
            (m.content as { event?: string }).event === 'environment_install_failed' &&
            ((m.content as { text?: string }).text ?? '').includes('OrphanPython'),
        ),
      { label: 'internal environment_install_failed event', timeoutMs: 30_000 },
    );
  }, 60_000);

  it('denial (BR-P06-003): refusing the approval notifies the bot', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小拒');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('装一下 fakeuv'))
        .replyToolCall('request_environment', { item: FAKE_ITEM, reason: '会被拒' }),
      step()
        .expect((req) => req.lastUserText().includes('装一下 fakeuv'))
        .replyText('已申请'),
      step()
        .expect((req) => req.lastUserText().includes('environment_install_denied'))
        .replyText('知道了，不装了'),
    ]);
    await sendBatch(core, conv.id, ['装一下 fakeuv']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const approval = await pendingEnvironmentApproval(core, conv.id);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: false });

    // 拒绝也投递事件（internal，用户在卡片上做的决定无需再播报）；不产生安装行。
    await waitFor(
      async () =>
        (await listAllMessages(core, conv.id)).some(
          (m) => (m.content as { event?: string }).event === 'environment_install_denied',
        ),
      { label: 'internal environment_install_denied event', timeoutMs: 30_000 },
    );
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    expect((await envList(core)).filter((i) => i.item === FAKE_ITEM).length).toBe(0);
  }, 120_000);

  it('duplicate request (BR-P06-004): a second request reuses the pending approval', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小复');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('第一次'))
        .replyToolCall('request_environment', { item: FAKE_ITEM, reason: '第一次' }),
      step()
        .expect((req) => req.lastUserText().includes('第一次'))
        .replyText('第一次申请'),
      step()
        .expect((req) => req.lastUserText().includes('第二次'))
        .replyToolCall('request_environment', { item: FAKE_ITEM, reason: '第二次' }),
      step()
        .expect((req) => req.lastUserText().includes('第二次'))
        .replyText('第二次复用'),
    ]);
    await sendBatch(core, conv.id, ['第一次申请环境']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const first = await pendingEnvironmentApproval(core, conv.id);

    // 首张卡未决定时再次申请：复用同一审批，不开新卡。
    await sendBatch(core, conv.id, ['第二次申请环境']);
    // 等第二个响应 run 走到终态（waitForRun 会被 run1 提前满足）。
    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 20 })) as {
          runs: Run[];
        };
        const mine = runs.runs
          .filter((r) => r.loopType === 'response')
          .sort((a, b) => (a.id < b.id ? 1 : -1));
        return mine.length >= 2 && ['completed', 'failed'].includes(mine[0]!.status)
          ? mine[0]
          : null;
      },
      { label: 'second run terminal', timeoutMs: 60_000 },
    );
    const second = await lastToolResult(core, conv.id);
    expect(String(second['content'])).toContain(first.id);
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(approvals.approvals.filter((a) => a.kind === 'environment').length).toBe(1);
  }, 120_000);

  it(
    'startup recovery marks interrupted installs failed',
    { timeout: 60_000 },
    async () => {
      const { catalog } = await startFakeEnv();
      const stack = await createTestStack({ envCatalog: catalog });
      stacks.push(stack);
      const { core } = stack;

      // 伪造一次崩溃残留：一行 installing + 半个目录。
      const mainDb = core.services.mainDb!;
      mainDb
        .prepare(
          "insert into env_installs (id, item, version, rel_path, status, requested_by) values ('env_TEST00000000000000000000', 'fakeuv', '1.0.0', 'fakeuv/1.0.0', 'installing', 'bot_X')",
        )
        .run();
      const paths = resolvePaths(core.services.paths.home);
      mkdirSync(toolchainPathFor(paths, 'fakeuv', '1.0.0'), { recursive: true });

      const recovered = core.services.environment!.recoverInterrupted();
      expect(recovered).toBe(1);
      const installs = await envList(core);
      expect(installs.find((i) => i.id === 'env_TEST00000000000000000000')?.status).toBe('failed');
      // 残留目录被清理。
      expect(existsSync(toolchainPathFor(paths, 'fakeuv', '1.0.0'))).toBe(false);
    },
    60_000,
  );

  it('settings operations: remove deletes the directory, reinstall works, doctor flags a broken install', async () => {
    const { catalog } = await startFakeEnv();
    const stack = await createTestStack({ envCatalog: catalog });
    stacks.push(stack);
    const { core } = stack;
    const bot = await makeBot(core, '小设');
    const conv = await openDirect(core, bot.id);

    // 无人值守下经工具路径申请（自动批准 → 安装完成）。
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    await core.services.environment!.request(
      { runId: 'run_seed', botId: bot.id, conversationId: conv.id, loopType: 'response' },
      { item: FAKE_ITEM, reason: 'seed' },
    );
    const install = await installOf(core, FAKE_ITEM);
    expect(install.status).toBe('installed');
    const paths = resolvePaths(core.services.paths.home);
    expect(existsSync(toolchainPathFor(paths, FAKE_ITEM, FAKE_VERSION))).toBe(true);

    // 删除：状态 removed + 目录删除（删除级联：Bot/对话删除不删共享工具链，
    // environment.remove 是唯一删除入口）。
    await core.rpc.call('environment.remove', { id: install.id });
    expect((await envList(core)).find((i) => i.id === install.id)?.status).toBe('removed');
    expect(existsSync(toolchainPathFor(paths, FAKE_ITEM, FAKE_VERSION))).toBe(false);

    // reinstall（用户即确认）：重装成功。
    await core.rpc.call('environment.reinstall', { id: install.id });
    await waitFor(
      async () => {
        const rows = await envList(core);
        return rows.find((i) => i.id === install.id && i.status === 'installed') ?? null;
      },
      { label: 'reinstalled', timeoutMs: 60_000 },
    );

    // 体检：删掉可执行文件后 recheck 判为异常（failed），设置页可再次重装。
    rmSync(path.join(toolchainPathFor(paths, FAKE_ITEM, FAKE_VERSION), FAKE_ITEM));
    await core.rpc.call('environment.recheck');
    const unhealthy = await waitFor(
      async () => {
        const rows = await envList(core);
        return rows.find((i) => i.id === install.id && i.status === 'failed') ?? null;
      },
      { label: 'doctor marks broken install failed' },
    );
    expect(unhealthy.status).toBe('failed');
  }, 120_000);
});
