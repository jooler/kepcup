import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { resolvePaths, shareInboxDir, type AppPaths } from '../../src/infra/paths.js';
import { AttachmentsService } from '../../src/domain/attachments.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { ShareIntakeService } from '../../src/share/service.js';
import type { Orchestrator } from '../../src/dispatch/orchestrator.js';
import type { Clock } from '../../src/infra/clock.js';
import type { CoreLogger } from '../../src/infra/logger.js';
import {
  SHARE_INBOX_STALE_MS,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  type ShareConsumeInput,
  type ShareFailedChanged,
} from '@kepcup/shared';

/**
 * D94 分享接收（ShareIntakeService）：幂等、事务、目标解析、失败恢复。
 * 重点：不丢文件、不重复发消息、目标失效不静默丢弃。
 */

const root = mkdtempSync(path.join(tmpdir(), 'share-intake-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_700_000_000_000;
let now = NOW;
const clock: Clock = { now: () => now };

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as CoreLogger;

let db: SqliteDatabase;
let home: string;
let paths: AppPaths;
let conversations: ConversationsService;
let bots: BotsService;
let messages: MessagesService;
let attachments: AttachmentsService;
let service: ShareIntakeService;
let sent: Array<{
  conversationId: string;
  text: string;
  attachmentIds: string[];
  shareIntakeId: string;
}>;
let events: ShareFailedChanged[];

beforeEach(() => {
  now = NOW;
  home = mkdtempSync(path.join(root, 'home-'));
  paths = resolvePaths(home);
  db = openDatabase({
    path: path.join(root, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 5), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  conversations = new ConversationsService(db, clock);
  bots = new BotsService(db, clock);
  messages = new MessagesService(db, clock);
  attachments = new AttachmentsService({ db, paths, clock });
  sent = [];
  events = [];
  const orchestrator = {
    sendShareMessage: (
      conversationId: string,
      input: { text: string; attachmentIds: string[]; shareIntakeId: string },
    ) => {
      sent.push({ conversationId, ...input });
      const message = messages.append({
        conversationId,
        senderType: 'user',
        kind: 'text',
        text: input.text,
        attachmentIds: input.attachmentIds,
        shareIntakeId: input.shareIntakeId,
      });
      return {
        message,
        batchId: 'batch_test',
        conversation: conversations.getOrThrow(conversationId),
        wake: () => ({ runId: null }),
      };
    },
  } as unknown as Orchestrator;
  service = new ShareIntakeService({
    db,
    paths,
    clock,
    logger,
    attachments,
    conversations,
    bots,
    orchestrator,
    publish: (_event, payload) => events.push(payload),
  });
});

/** 在 core inbox 里造一个批次目录（模拟主进程搬过来的样子）。 */
function stageIntake(
  intakeId: string,
  options: {
    files?: Array<{ stagedName: string; originalName: string; mime: string; bytes: Buffer }>;
    note?: string;
    target?: { kind: 'bot' | 'project'; id: string };
  } = {},
): ShareConsumeInput {
  const files = options.files ?? [
    {
      stagedName: '000-a.zip',
      originalName: 'a.zip',
      mime: 'application/zip',
      bytes: Buffer.from('zip'),
    },
  ];
  const dir = shareInboxDir(paths, intakeId);
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(dir, 'files', file.stagedName), file.bytes);
  }
  const manifest = {
    version: 1,
    intakeId,
    createdAt: now,
    target: options.target ?? { kind: 'bot', id: 'bot_x' },
    note: options.note ?? '',
    files: files.map((file) => ({
      stagedName: file.stagedName,
      originalName: file.originalName,
      mime: file.mime,
      size: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return {
    intakeId,
    target: manifest.target,
    note: manifest.note,
    files: manifest.files.map((file) => ({
      path: path.join(dir, 'files', file.stagedName),
      originalName: file.originalName,
      mime: file.mime,
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

function intakeRow(id: string): { state: string; message_id: string | null; attempts: number } {
  return db
    .prepare('select state, message_id, attempts from share_intakes where id = ?')
    .get(id) as {
    state: string;
    message_id: string | null;
    attempts: number;
  };
}

describe('share.consume 正常投递', () => {
  it('Bot 目标：落到私聊，附件与消息同批落库', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_aaaaaaaa', { target: { kind: 'bot', id: bot.id } });
    const result = service.consume(input);
    expect(result.state).toBe('done');
    expect(result.messageId).toBeTruthy();
    expect(result.attachmentIds).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.conversationId).toBe(result.conversationId);
    // 消息内容：普通用户文本消息 + shareIntakeId
    const message = messages.getById(result.messageId!);
    expect(message?.senderType).toBe('user');
    expect(message?.kind).toBe('text');
    expect(message?.content).toMatchObject({ text: '', shareIntakeId: 'shr_aaaaaaaa' });
    // 附件已绑定消息
    expect(attachments.get(result.attachmentIds![0]!)?.messageId).toBe(result.messageId);
    expect(intakeRow('shr_aaaaaaaa').state).toBe('done');
  });

  it('附言进正文，正文只有附言', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_bbbbbbbb', {
      target: { kind: 'bot', id: bot.id },
      note: '帮我看下这个聊天记录',
    });
    const result = service.consume(input);
    const message = messages.getById(result.messageId!);
    expect(message?.content).toMatchObject({
      text: '帮我看下这个聊天记录',
      shareIntakeId: 'shr_bbbbbbbb',
    });
  });

  it('项目组目标：落到项目根会话', () => {
    const lead = bots.create({ identity: { name: '组长' } });
    db.prepare(
      "insert into conversations (id, type, title, lead_bot_id, created_at) values ('conv_p', 'project', '项目讨论组', ?, 1)",
    ).run(lead.id);
    const input = stageIntake('shr_cccccccc', { target: { kind: 'project', id: 'conv_p' } });
    const result = service.consume(input);
    expect(result.state).toBe('done');
    expect(result.conversationId).toBe('conv_p');
  });

  it('目标会话已归档 → 自动取消归档', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const { conversation } = conversations.openDirect(bot.id);
    conversations.setArchived(conversation.id, true);
    const input = stageIntake('shr_dddddddd', { target: { kind: 'bot', id: bot.id } });
    const result = service.consume(input);
    expect(result.state).toBe('done');
    expect(conversations.getOrThrow(result.conversationId!).archivedAt).toBeNull();
  });
});

describe('share.consume 幂等', () => {
  it('同一个 intake 消费两次只有一条消息', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_eeeeeeee', { target: { kind: 'bot', id: bot.id } });
    const first = service.consume(input);
    const second = service.consume(input);
    expect(second.state).toBe('done');
    expect(second.messageId).toBe(first.messageId);
    expect(sent).toHaveLength(1);
    const rows = db.prepare('select id from messages').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('processing 未超时时返回忙', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_ffffffff', { target: { kind: 'bot', id: bot.id } });
    db.prepare(
      "insert into share_intakes (id, state, target_kind, target_id, attempts, created_at, updated_at) values (?, 'processing', 'bot', ?, 1, ?, ?)",
    ).run('shr_ffffffff', bot.id, now, now);
    const result = service.consume(input);
    expect(result.state).toBe('processing');
    expect(sent).toHaveLength(0);
  });
});

describe('share.consume 目标失效', () => {
  it('Bot 已删除 → failed_target，文件保留', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_11111111', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    const result = service.consume(input);
    expect(result.state).toBe('failed_target');
    expect(result.errorCode).toBe('SHARE_TARGET_NOT_FOUND');
    expect(sent).toHaveLength(0);
    // 文件保留，等恢复面板重试
    expect(existsSync(path.join(shareInboxDir(paths, 'shr_11111111'), 'files', '000-a.zip'))).toBe(
      true,
    );
    expect(intakeRow('shr_11111111').state).toBe('failed_target');
  });

  it('项目组不存在 → failed_target', () => {
    const input = stageIntake('shr_22222222', { target: { kind: 'project', id: 'conv_nope' } });
    const result = service.consume(input);
    expect(result.state).toBe('failed_target');
    expect(result.errorCode).toBe('SHARE_TARGET_NOT_FOUND');
  });

  it('只读会话 → failed_target（不自动解除只读）', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_ro', 'direct', ?, 1, 1)",
    ).run(bot.id);
    const input = stageIntake('shr_33333333', { target: { kind: 'bot', id: bot.id } });
    const result = service.consume(input);
    expect(result.state).toBe('failed_target');
    expect(result.errorCode).toBe('SHARE_TARGET_READ_ONLY');
  });

  it('failed_target(NOT_FOUND) 同一个目标不自动重试，换目标才继续', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const other = bots.create({ identity: { name: '乙' } });
    const input = stageIntake('shr_44444444', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    expect(service.consume(input).state).toBe('failed_target');
    // 同一目标再来一次 → 仍是原失败（NOT_FOUND 是终态，重试必然再失败）
    expect(service.consume(input).state).toBe('failed_target');
    expect(sent).toHaveLength(0);
    // 换目标 → 继续
    const retried = service.consume({ ...input, target: { kind: 'bot', id: other.id } });
    expect(retried.state).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('failed_target(READ_ONLY) 同一目标也走重新校验：解除只读后重试成功', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_ro2', 'direct', ?, 1, 1)",
    ).run(bot.id);
    const input = stageIntake('shr_rorororo', { target: { kind: 'bot', id: bot.id } });
    const first = service.consume(input);
    expect(first.state).toBe('failed_target');
    expect(first.errorCode).toBe('SHARE_TARGET_READ_ONLY');
    expect(sent).toHaveLength(0);
    // 用户解除只读后，同一目标重试 → 完整重新校验并成功（READ_ONLY 不是终态）
    db.prepare('update conversations set read_only = 0 where id = ?').run('conv_ro2');
    const second = service.consume(input);
    expect(second.state).toBe('done');
    expect(sent).toHaveLength(1);
  });
});

describe('share.consume 文件校验', () => {
  it('hash 不符 → failed，文件保留', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_55555555', { target: { kind: 'bot', id: bot.id } });
    const bad = { ...input, files: [{ ...input.files[0]!, sha256: 'b'.repeat(64) }] };
    const result = service.consume(bad);
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SHARE_INTAKE_INVALID');
    expect(sent).toHaveLength(0);
    expect(existsSync(path.join(shareInboxDir(paths, 'shr_55555555'), 'files', '000-a.zip'))).toBe(
      true,
    );
  });

  it('路径越界（不在本批次目录内）→ failed', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const outside = path.join(home, 'secret.txt');
    writeFileSync(outside, 'x');
    const input = stageIntake('shr_66666666', { target: { kind: 'bot', id: bot.id } });
    const result = service.consume({
      ...input,
      files: [
        {
          ...input.files[0]!,
          path: outside,
          sha256: createHash('sha256').update('x').digest('hex'),
          size: 1,
        },
      ],
    });
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SHARE_INTAKE_INVALID');
  });

  it('符号链接 → failed', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_77777777', { target: { kind: 'bot', id: bot.id } });
    const dir = shareInboxDir(paths, 'shr_77777777');
    const real = path.join(dir, 'files', 'real.bin');
    writeFileSync(real, 'data');
    rmSync(path.join(dir, 'files', '000-a.zip'));
    symlinkSync(real, path.join(dir, 'files', '000-a.zip'));
    const result = service.consume(input);
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SHARE_INTAKE_INVALID');
  });

  it('目录冒充文件 → failed', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_88888888', { target: { kind: 'bot', id: bot.id } });
    const dir = shareInboxDir(paths, 'shr_88888888');
    rmSync(path.join(dir, 'files', '000-a.zip'));
    mkdirSync(path.join(dir, 'files', '000-a.zip'));
    const result = service.consume(input);
    expect(result.state).toBe('failed');
  });

  it('单文件超过 30MB → SHARE_FILE_TOO_LARGE，不发送', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_bigbigbig', {
      target: { kind: 'bot', id: bot.id },
      files: [
        {
          stagedName: '000-big.zip',
          originalName: 'big.zip',
          mime: 'application/zip',
          bytes: Buffer.alloc(SHARE_MAX_FILE_BYTES + 1, 7),
        },
      ],
    });
    const result = service.consume(input);
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SHARE_FILE_TOO_LARGE');
    expect(sent).toHaveLength(0);
  });

  it('总量超过 60MB → SHARE_FILE_TOO_LARGE，不发送', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    // 两个都顶到单文件上限（30,000,000 合法），第三个 1 字节把总量顶过 60,000,000。
    const edge = Buffer.alloc(SHARE_MAX_FILE_BYTES, 1);
    const input = stageIntake('shr_totalbig', {
      target: { kind: 'bot', id: bot.id },
      files: [
        { stagedName: '000-a.bin', originalName: 'a.bin', mime: 'application/octet-stream', bytes: edge },
        { stagedName: '001-b.bin', originalName: 'b.bin', mime: 'application/octet-stream', bytes: edge },
        {
          stagedName: '002-c.bin',
          originalName: 'c.bin',
          mime: 'application/octet-stream',
          bytes: Buffer.from('x'),
        },
      ],
    });
    expect(SHARE_MAX_TOTAL_BYTES).toBe(2 * SHARE_MAX_FILE_BYTES);
    const result = service.consume(input);
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SHARE_FILE_TOO_LARGE');
    expect(sent).toHaveLength(0);
  });

  it('intakeId 形状非法 → 抛错，不落库', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_99999999', { target: { kind: 'bot', id: bot.id } });
    expect(() => service.consume({ ...input, intakeId: '../escape' })).toThrow();
    const rows = db.prepare('select id from share_intakes').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });
});

describe('share 目标快照与失败恢复', () => {
  it('targets 只含 id / 名称 / 类型 / 归档位', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    db.prepare(
      "insert into conversations (id, type, title, lead_bot_id, archived_at, created_at) values ('conv_p', 'project', '项目讨论组', ?, 5, 1)",
    ).run(bot.id);
    const targets = service.targets();
    expect(targets.version).toBe(1);
    expect(targets.bots).toEqual([{ id: bot.id, name: '阿甲', kind: 'bot', archived: false }]);
    expect(targets.projects).toEqual([
      { id: 'conv_p', name: '项目讨论组', kind: 'project', archived: true },
    ]);
  });

  it('listFailed 列出失败项并带过期时间', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_aaaaaaaaaa', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    service.consume(input);
    const items = service.listFailed();
    expect(items).toHaveLength(1);
    expect(items[0]?.intakeId).toBe('shr_aaaaaaaaaa');
    expect(items[0]?.errorCode).toBe('SHARE_TARGET_NOT_FOUND');
    expect(items[0]?.expiresAt).toBe(items[0]!.createdAt + 7 * 24 * 3600 * 1000);
    expect(items[0]?.files[0]?.originalName).toBe('a.zip');
  });

  it('retry 换目标后成功投递', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const other = bots.create({ identity: { name: '乙' } });
    const input = stageIntake('shr_bbbbbbbbbb', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    service.consume(input);
    const result = service.retry({
      intakeId: 'shr_bbbbbbbbbb',
      target: { kind: 'bot', id: other.id },
    });
    expect(result.state).toBe('done');
    expect(result.messageId).toBeTruthy();
    expect(service.listFailed()).toHaveLength(0);
  });

  it('discard 删除行与文件', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_ccccccccccc', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    service.consume(input);
    service.discard({ intakeId: 'shr_ccccccccccc' });
    expect(service.listFailed()).toHaveLength(0);
    expect(existsSync(shareInboxDir(paths, 'shr_ccccccccccc'))).toBe(false);
  });

  it('失败事件被发布', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_dddddddddddd', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    service.consume(input);
    expect(events.some((event) => event.state === 'failed_target')).toBe(true);
  });
});

describe('share 清扫', () => {
  it('processing 超时重置为 received', () => {
    db.prepare(
      "insert into share_intakes (id, state, target_kind, target_id, attempts, created_at, updated_at) values ('shr_stale', 'processing', 'bot', 'bot_x', 1, ?, ?)",
    ).run(now - 60 * 60 * 1000, now - 60 * 60 * 1000);
    const result = service.sweep();
    expect(result.resetProcessing).toBe(1);
    expect(intakeRow('shr_stale').state).toBe('received');
  });

  it('失败超过 7 天清理（行与文件）', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_oldoldold', { target: { kind: 'bot', id: bot.id } });
    bots.markDeleted(bot.id);
    service.consume(input);
    now += 8 * 24 * 3600 * 1000;
    const result = service.sweep();
    expect(result.expiredFailed).toBe(1);
    expect(service.listFailed()).toHaveLength(0);
    expect(existsSync(shareInboxDir(paths, 'shr_oldoldold'))).toBe(false);
  });

  it('received 超过 7 天也清理（行与目录一并删，不滞留）', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    stageIntake('shr_ttlreceived', { target: { kind: 'bot', id: bot.id } });
    db.prepare(
      "insert into share_intakes (id, state, target_kind, target_id, attempts, created_at, updated_at) values (?, 'received', 'bot', ?, 1, ?, ?)",
    ).run('shr_ttlreceived', bot.id, now - 8 * 24 * 3600 * 1000, now - 8 * 24 * 3600 * 1000);
    const result = service.sweep();
    expect(result.expiredReceived).toBe(1);
    expect(
      db.prepare('select id from share_intakes where id = ?').get('shr_ttlreceived'),
    ).toBeUndefined();
    expect(existsSync(shareInboxDir(paths, 'shr_ttlreceived'))).toBe(false);
  });

  it('core inbox 里无 DB 行且未过期的目录不清理', () => {
    const dir = shareInboxDir(paths, 'shr_orphanxxx');
    mkdirSync(dir, { recursive: true });
    const result = service.sweep();
    expect(result.orphanInboxDirs).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('core inbox 里无 DB 行且超过 24 小时的目录被删除', () => {
    const dir = shareInboxDir(paths, 'shr_orphanold');
    mkdirSync(dir, { recursive: true });
    // 目录 mtime 是真实文件系统时间：把可控时钟推到未来 25 小时，让
    // now - mtime 越过 24 小时阈值（mtime 不受测试时钟控制）。
    now = Date.now() + SHARE_INBOX_STALE_MS + 60 * 60 * 1000;
    const result = service.sweep();
    expect(result.orphanInboxDirs).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('share 启动补消费', () => {
  it('主进程移动后崩溃留下的批次被补消费', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    stageIntake('shr_crashcrash', { target: { kind: 'bot', id: bot.id } });
    const recovered = service.scanInbox();
    expect(recovered).toEqual(['shr_crashcrash']);
    expect(sent).toHaveLength(1);
    expect(intakeRow('shr_crashcrash').state).toBe('done');
  });

  it('sweep 打回的 received 行 + 目录仍在 → scanInbox 重新消费（恢复闭环）', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    stageIntake('shr_recvrecv', { target: { kind: 'bot', id: bot.id } });
    // 模拟 sweep 把超时 processing 打回 received 后进程崩溃/重启：
    // 行是 received（不在恢复面板里），目录还在 core inbox。
    db.prepare(
      "insert into share_intakes (id, state, target_kind, target_id, attempts, created_at, updated_at) values (?, 'received', 'bot', ?, 1, ?, ?)",
    ).run('shr_recvrecv', bot.id, now, now);
    const recovered = service.scanInbox();
    expect(recovered).toEqual(['shr_recvrecv']);
    expect(sent).toHaveLength(1);
    expect(intakeRow('shr_recvrecv').state).toBe('done');
  });

  it('done 行的目录不再被 scanInbox 重新消费', () => {
    const bot = bots.create({ identity: { name: '阿甲' } });
    const input = stageIntake('shr_donedirx', { target: { kind: 'bot', id: bot.id } });
    expect(service.consume(input).state).toBe('done');
    // 目录残留（清理失败等场景）：done 行必须跳过，不重复发消息。
    stageIntake('shr_donedirx', { target: { kind: 'bot', id: bot.id } });
    expect(service.scanInbox()).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});
