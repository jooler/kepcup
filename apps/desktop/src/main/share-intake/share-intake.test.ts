import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ShareConsumeInput, ShareConsumeOutput, ShareTargets } from '@kepcup/shared';

import { ShareIntakeCoordinator } from './coordinator';
import { listIntakeDirs, readStagedIntake } from './manifest';
import { parseShareUrl } from './url';
import { writeTargetsSnapshot } from './targets';
import { shareInboxDir, shareTargetsPath } from './app-group';

/**
 * D94 §7.3：主进程协调器——校验 App Group 里的批次、搬进 core inbox、调 core。
 * 重点：不丢文件、不重复消费、失败不静默丢弃。
 */

const root = mkdtempSync(path.join(tmpdir(), 'share-main-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let groupDir: string;
let coreHome: string;
let calls: Array<{ method: string; input: unknown }>;
let consumeResult: ShareConsumeOutput;
let coordinator: ShareIntakeCoordinator;

beforeEach(() => {
  groupDir = mkdtempSync(path.join(root, 'group-'));
  coreHome = mkdtempSync(path.join(root, 'home-'));
  calls = [];
  consumeResult = { state: 'done' };
  coordinator = new ShareIntakeCoordinator({
    groupDir,
    coreHome,
    logger: { info: () => {}, warn: () => {} },
    callPlatform: async <T>(method: string, input?: unknown): Promise<T> => {
      calls.push({ method, input });
      if (method === 'share.consume') return consumeResult as unknown as T;
      if (method === 'share.targets') {
        return {
          version: 1,
          generatedAt: 1,
          bots: [],
          projects: [],
        } as unknown as T;
      }
      throw new Error(`unexpected platform method ${method}`);
    },
  });
});

/** 在 App Group inbox 里造一个批次目录。 */
function stageIntake(
  intakeId: string,
  options: { note?: string; bytes?: Buffer; ready?: boolean } = {},
): void {
  const bytes = options.bytes ?? Buffer.from('zip');
  const dir = path.join(shareInboxDir(groupDir), intakeId);
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  writeFileSync(path.join(dir, 'files', '000-a.zip'), bytes);
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      intakeId,
      createdAt: 1,
      target: { kind: 'bot', id: 'bot_x' },
      note: options.note ?? '',
      files: [
        {
          stagedName: '000-a.zip',
          originalName: 'a.zip',
          mime: 'application/zip',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  );
  if (options.ready !== false) writeFileSync(path.join(dir, 'ready'), '');
}

describe('parseShareUrl', () => {
  it('接受 kepcup://share-intake?id=shr_…', () => {
    expect(parseShareUrl('kepcup://share-intake?id=shr_abcdefgh')).toEqual({
      kind: 'share-intake',
      intakeId: 'shr_abcdefgh',
    });
  });

  it('其它 scheme / 路径 / 非法 id 一律忽略', () => {
    expect(parseShareUrl('https://example.com/share-intake?id=shr_abcdefgh')).toBeNull();
    expect(parseShareUrl('kepcup://other?id=shr_abcdefgh')).toBeNull();
    expect(parseShareUrl('kepcup://share-intake?id=bad')).toBeNull();
    expect(parseShareUrl('not a url')).toBeNull();
  });
});

describe('readStagedIntake', () => {
  it('完整目录读出 manifest 与文件', () => {
    stageIntake('shr_readokay');
    const staged = readStagedIntake(path.join(shareInboxDir(groupDir), 'shr_readokay'));
    expect('error' in staged).toBe(false);
    if ('error' in staged) return;
    expect(staged.manifest.note).toBe('');
    expect(staged.files[0]?.originalName).toBe('a.zip');
  });

  it('没有 ready 标记 → not_ready（扩展还没写完）', () => {
    stageIntake('shr_notready', { ready: false });
    const staged = readStagedIntake(path.join(shareInboxDir(groupDir), 'shr_notready'));
    expect(staged).toEqual({ error: 'not_ready' });
  });

  it('目录名与 manifest id 不一致 → id_mismatch', () => {
    stageIntake('shr_mismatch');
    const dir = path.join(shareInboxDir(groupDir), 'shr_mismatch');
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.intakeId = 'shr_otherone';
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    expect(readStagedIntake(dir)).toEqual({ error: 'id_mismatch' });
  });

  it('hash 不符 → hash_mismatch', () => {
    stageIntake('shr_badhashx');
    const dir = path.join(shareInboxDir(groupDir), 'shr_badhashx');
    // 同长度改写：大小对得上，只有 sha256 不符。
    writeFileSync(path.join(dir, 'files', '000-a.zip'), 'zop');
    expect(readStagedIntake(dir)).toEqual({ error: 'hash_mismatch' });
  });

  // root 读权限检查不生效；Windows 的 chmod(0) 会把文件锁死，连 force rm 都 EPERM。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'staged 文件读不了（stat 与 read 之间被删 / 权限变化）→ files_missing，不抛异常',
    () => {
      stageIntake('shr_unreadab');
      const dir = path.join(shareInboxDir(groupDir), 'shr_unreadab');
      const staged = path.join(dir, 'files', '000-a.zip');
      chmodSync(staged, 0o000);
      try {
        expect(readStagedIntake(dir)).toEqual({ error: 'files_missing' });
      } finally {
        try {
          chmodSync(staged, 0o644);
        } catch {
          // ignore — best-effort unlock before cleanup
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('listIntakeDirs', () => {
  it('列出全部目录（含未写完的），不含文件', () => {
    stageIntake('shr_listready');
    stageIntake('shr_listnotok', { ready: false });
    const inbox = shareInboxDir(groupDir);
    writeFileSync(path.join(inbox, 'stray-file'), '');
    expect(listIntakeDirs(inbox)).toEqual(['shr_listnotok', 'shr_listready']);
  });

  it('目录不存在 → 空', () => {
    expect(listIntakeDirs(path.join(groupDir, 'nope'))).toEqual([]);
  });
});

describe('ShareIntakeCoordinator', () => {
  it('扫描 inbox：搬进 core inbox 并调 share.consume', async () => {
    stageIntake('shr_scanonex');
    const outcomes = await coordinator.scan();
    expect(outcomes).toEqual([{ intakeId: 'shr_scanonex', state: 'done' }]);
    const consume = calls.find((call) => call.method === 'share.consume');
    expect(consume).toBeDefined();
    const input = consume?.input as ShareConsumeInput;
    expect(input.intakeId).toBe('shr_scanonex');
    expect(input.target).toEqual({ kind: 'bot', id: 'bot_x' });
    // 文件路径落在 core inbox 下
    expect(input.files[0]?.path).toBe(
      path.join(coreHome, 'inbox', 'share', 'shr_scanonex', 'files', '000-a.zip'),
    );
    // App Group 里的原目录已清掉
    expect(existsSync(path.join(shareInboxDir(groupDir), 'shr_scanonex'))).toBe(false);
  });

  it('同一批次并发只消费一次（单飞）', async () => {
    stageIntake('shr_singleflight');
    const [a, b] = await Promise.all([
      coordinator.consume('shr_singleflight'),
      coordinator.consume('shr_singleflight'),
    ]);
    expect(a.state).toBe('done');
    expect(b.state).toBe('done');
    expect(calls.filter((call) => call.method === 'share.consume')).toHaveLength(1);
  });

  it('目标失效（failed_target）不自动重试，App Group 目录保留', async () => {
    stageIntake('shr_failedtarget');
    consumeResult = { state: 'failed_target', errorCode: 'SHARE_TARGET_NOT_FOUND' };
    const outcome = await coordinator.consume('shr_failedtarget');
    expect(outcome.state).toBe('failed_target');
    expect(outcome.errorCode).toBe('SHARE_TARGET_NOT_FOUND');
    // 批次已搬进 core inbox 并保留（等 core 的恢复面板重试 / 删除）
    expect(existsSync(path.join(coreHome, 'inbox', 'share', 'shr_failedtarget'))).toBe(true);
    expect(
      existsSync(path.join(coreHome, 'inbox', 'share', 'shr_failedtarget', 'files', '000-a.zip')),
    ).toBe(true);
  });

  it('core 未就绪：保留 core inbox，不删 App Group 目录', async () => {
    stageIntake('shr_coredown');
    const failing = new ShareIntakeCoordinator({
      groupDir,
      coreHome,
      logger: { info: () => {}, warn: () => {} },
      callPlatform: async () => {
        throw new Error('core platform port not connected');
      },
    });
    const outcome = await failing.consume('shr_coredown');
    expect(outcome.state).toBe('failed');
    expect(existsSync(path.join(coreHome, 'inbox', 'share', 'shr_coredown'))).toBe(true);
  });

  it('handleUrl 消费对应批次', async () => {
    stageIntake('shr_fromurlx');
    const outcome = await coordinator.handleUrl('kepcup://share-intake?id=shr_fromurlx');
    expect(outcome?.state).toBe('done');
    expect(calls.filter((call) => call.method === 'share.consume')).toHaveLength(1);
  });

  it('handleUrl 遇到非分享 URL 返回 null', async () => {
    expect(await coordinator.handleUrl('kepcup://other?id=x')).toBeNull();
  });

  it('扫描时清掉超过 24h 的批次目录（§6.7 TTL；不消费不重哈希）', async () => {
    stageIntake('shr_staleold');
    const dir = path.join(shareInboxDir(groupDir), 'shr_staleold');
    const dayMs = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - dayMs - 60_000);
    utimesSync(dir, old, old);
    const outcomes = await coordinator.scan();
    expect(outcomes).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(calls.filter((call) => call.method === 'share.consume')).toHaveLength(0);
  });

  it('24h 内、带 ready 但校验永久失败的批次立即删（不每轮整读重哈希）', async () => {
    stageIntake('shr_permbad1');
    const dir = path.join(shareInboxDir(groupDir), 'shr_permbad1');
    // 同长度改写：大小对得上，sha256 不符（永久性校验失败）。
    writeFileSync(path.join(dir, 'files', '000-a.zip'), 'zop');
    const outcomes = await coordinator.scan();
    expect(outcomes).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(calls.filter((call) => call.method === 'share.consume')).toHaveLength(0);
  });

  it('24h 内、不带 ready 的目录保留（扩展可能还在写）', async () => {
    stageIntake('shr_youngwri', { ready: false });
    await coordinator.scan();
    expect(existsSync(path.join(shareInboxDir(groupDir), 'shr_youngwri'))).toBe(true);
  });

  it('单个批次意外出错不拖垮本轮其它批次（scan 兜底 + #consumeOnce 捕获）', async () => {
    stageIntake('shr_boomxxxx');
    stageIntake('shr_okayxxxx');
    const mixed = new ShareIntakeCoordinator({
      groupDir,
      coreHome,
      logger: { info: () => {}, warn: () => {} },
      // callPlatform 对 shr_boomxxxx 同步抛错（最凶的失败形态：同步异常 +
      // rejection 两种都被兜住）。
      callPlatform: <T>(method: string, input?: unknown): Promise<T> => {
        if (
          method === 'share.consume' &&
          (input as { intakeId?: string } | undefined)?.intakeId === 'shr_boomxxxx'
        ) {
          throw new Error('sync boom');
        }
        calls.push({ method, input });
        return Promise.resolve(consumeResult) as unknown as Promise<T>;
      },
    });
    // scan 不 reject（单批次失败只降级为该批次的 failed outcome）。
    const outcomes = await mixed.scan();
    expect(outcomes).toEqual([
      { intakeId: 'shr_boomxxxx', state: 'failed' },
      { intakeId: 'shr_okayxxxx', state: 'done' },
    ]);
    expect(
      calls.filter(
        (call) =>
          call.method === 'share.consume' &&
          (call.input as ShareConsumeInput).intakeId === 'shr_okayxxxx',
      ),
    ).toHaveLength(1);
    // 失败批次的文件保留在 core inbox（等下次启动 / core 恢复重试）。
    expect(existsSync(path.join(coreHome, 'inbox', 'share', 'shr_boomxxxx'))).toBe(true);
  });

  it('refreshTargets 原子写 targets.v1.json', async () => {
    const ok = await coordinator.refreshTargets();
    expect(ok).toBe(true);
    const raw = JSON.parse(readFileSync(shareTargetsPath(groupDir), 'utf8')) as ShareTargets;
    expect(raw.version).toBe(1);
    expect(raw.bots).toEqual([]);
  });
});

describe('writeTargetsSnapshot', () => {
  it('写入并可被读回', () => {
    const result = writeTargetsSnapshot(groupDir, {
      version: 1,
      generatedAt: 1,
      bots: [{ id: 'bot_x', name: '阿甲', kind: 'bot', archived: false }],
      projects: [],
    });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(readFileSync(shareTargetsPath(groupDir), 'utf8')) as ShareTargets;
    expect(raw.bots[0]?.name).toBe('阿甲');
  });
});
