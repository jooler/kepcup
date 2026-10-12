import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { AttachmentsService, MAX_ATTACHMENT_BYTES } from '../../src/domain/attachments.js';
import { MessagesService, type AppendMessageInput } from '../../src/domain/messages.js';
import {
  createGeneratedMediaDelivery,
  mediaDeliveryResult,
} from '../../src/tools/media-delivery.js';
import type { AppPaths } from '../../src/infra/paths.js';
import type { ToolGateway } from '../../src/gateway/index.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * 生成产物投递（createGeneratedMediaDelivery / mediaDeliveryResult）：逐文件的
 * 失败原因（过大 / 无权限 / 读不了 / 无对话上下文 / 发消息失败）必须随结果返回，
 * 且失败时不得留下孤儿附件行。
 */

const root = mkdtempSync(path.join(tmpdir(), 'media-delivery-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'turn',
};

let db: SqliteDatabase;
let attachments: AttachmentsService;
let workspace: string;
let appended: unknown[];
let published: Message[];
let warnings: string[];
let realMessages: MessagesService;

function migrationsUpTo(maxVersion: number): string {
  const source = migrationsUrl('main');
  const target = mkdtempSync(path.join(root, 'migrations-'));
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

beforeEach(() => {
  const home = mkdtempSync(path.join(root, 'home-'));
  workspace = path.join(home, 'ws');
  mkdirSync(workspace, { recursive: true });
  db = openDatabase({
    path: path.join(root, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 5), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUpTo(31));
  db.prepare(
    "insert into conversations (id, type, created_at) values ('conv_1', 'group', 1)",
  ).run();
  db.pragma('foreign_keys = OFF');
  attachments = new AttachmentsService({
    db,
    paths: { home } as AppPaths,
    clock: { now: () => 1000 },
  });
  realMessages = new MessagesService(db, { now: () => 1000 });
  appended = [];
  published = [];
  warnings = [];
});

function gateway(denied: string[] = []): ToolGateway {
  return {
    checkPath: (_identity: RunIdentity, target: string) =>
      denied.includes(target)
        ? { kind: 'needs_grant', resolvedPath: target, reason: '需要授权', sensitive: false }
        : { kind: 'allowed', resolvedPath: target },
  } as unknown as ToolGateway;
}

function delivery(
  options: {
    denied?: string[];
    appendThrows?: boolean;
    publishThrows?: boolean;
    /** 在 append 真正执行前改动现场（模拟绑定附件时出错）。 */
    beforeAppend?: (input: AppendMessageInput) => void;
    id?: RunIdentity;
  } = {},
) {
  return createGeneratedMediaDelivery({
    identity: options.id ?? identity,
    gateway: gateway(options.denied),
    attachments,
    messages: {
      append: (input: AppendMessageInput) => {
        if (options.appendThrows === true) throw new Error('db locked');
        options.beforeAppend?.(input);
        appended.push(input);
        return realMessages.append(input);
      },
    },
    onBotMessage: (message) => {
      if (options.publishThrows === true) throw new Error('subscriber boom');
      published.push(message);
    },
    logger: { warn: (_fields, msg) => warnings.push(msg) },
    guessMime: () => 'application/octet-stream',
  });
}

function write(name: string, bytes: Buffer | string): string {
  const file = path.join(workspace, name);
  writeFileSync(file, bytes);
  return file;
}

function attachmentRows(): number {
  return (db.prepare('select count(*) as n from attachments').get() as { n: number }).n;
}

describe('createGeneratedMediaDelivery', () => {
  it('全部成功：一条消息带全部附件，delivered 列出原路径', () => {
    const a = write('a.png', 'aaa');
    const b = write('b.png', 'bbb');
    const outcome = delivery().send([a, b], '');
    expect(outcome).toEqual({ delivered: [a, b], failed: [] });
    expect(appended).toHaveLength(1);
    expect(published).toHaveLength(1);
    const bound = db.prepare('select message_id from attachments').all() as Array<{
      message_id: string | null;
    }>;
    const messageId = published[0]?.id;
    expect(messageId).toBeDefined();
    expect(bound.map((row) => row.message_id)).toEqual([messageId, messageId]);
    expect(published[0]?.attachments.map((att) => att.fileName)).toEqual(['a.png', 'b.png']);
  });

  it('超过附件上限：该文件进 failed（带 MB 说明），其余照常送达', () => {
    const big = write('big.mp4', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    const small = write('ok.png', 'ok');
    const outcome = delivery().send([big, small], '');
    expect(outcome.delivered).toEqual([small]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.path).toBe(big);
    expect(outcome.failed[0]?.reason).toContain('文件过大');
    expect(outcome.failed[0]?.reason).toContain('30.0MB');
    expect(attachmentRows()).toBe(1);
  });

  it('无读取权限 / 文件不存在 / 空文件：逐项失败并带原因，不发消息', () => {
    const denied = write('d.png', 'x');
    const empty = write('empty.png', '');
    const missing = path.join(workspace, 'missing.png');
    const outcome = delivery({ denied: [denied] }).send([denied, missing, empty], '');
    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed.map((f) => f.path)).toEqual([denied, missing, empty]);
    expect(outcome.failed[0]?.reason).toContain('没有读取权限');
    expect(outcome.failed[1]?.reason).toContain('读取文件失败');
    expect(outcome.failed[2]?.reason).toContain('上传附件失败');
    expect(appended).toHaveLength(0);
    expect(attachmentRows()).toBe(0);
  });

  it('没有对话上下文：全部失败', () => {
    const a = write('a.png', 'aaa');
    const outcome = delivery({ id: { ...identity, conversationId: null } }).send([a], '');
    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed[0]?.reason).toContain('没有对话上下文');
  });

  it('发消息失败：已上传的附件被回收（不留孤儿行/文件），全部记为失败', () => {
    const a = write('a.png', 'aaa');
    const outcome = delivery({ appendThrows: true }).send([a], '');
    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed[0]?.reason).toContain('消息发送失败');
    expect(attachmentRows()).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('事件发布抛错：消息已落库、附件已绑定，仍算投递成功（不让模型补发造成重复），只记日志', () => {
    const a = write('a.png', 'aaa');
    const outcome = delivery({ publishThrows: true }).send([a], '图');
    expect(outcome).toEqual({ delivered: [a], failed: [] });
    expect(warnings).toHaveLength(1);
    const messages = db.prepare('select id from messages').all() as Array<{ id: string }>;
    expect(messages).toHaveLength(1);
    const rows = db.prepare('select message_id from attachments').all() as Array<{
      message_id: string | null;
    }>;
    expect(rows.map((row) => row.message_id)).toEqual([messages[0]?.id]);
  });

  it('绑定附件失败（append 同事务回滚）：不留下无附件的空 caption 消息，附件被回收', () => {
    const a = write('a.png', 'aaa');
    const b = write('b.png', 'bbb');
    const outcome = delivery({
      beforeAppend: (input) => {
        // 模拟其中一个附件行在绑定前消失 → 绑定 update 命中 0 行。
        db.prepare('delete from attachments where id = ?').run(input.attachmentIds?.[1]);
      },
    }).send([a, b], '说明文字');
    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed.map((f) => f.path)).toEqual([a, b]);
    expect(outcome.failed[0]?.reason).toContain('消息发送失败');
    expect((db.prepare('select count(*) as n from messages').get() as { n: number }).n).toBe(0);
    expect((db.prepare('select count(*) as n from messages_fts').get() as { n: number }).n).toBe(0);
    expect(attachmentRows()).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('任务循环：消息归属当前任务', () => {
    const a = write('a.png', 'aaa');
    delivery({ id: { ...identity, loopType: 'task' } }).send([a], '');
    expect((appended[0] as { taskOrigin?: { taskId: string } }).taskOrigin).toEqual({
      taskId: 'run_1',
    });
  });
});

describe('mediaDeliveryResult', () => {
  it('全部送达：不回路径', () => {
    const result = mediaDeliveryResult({
      generated: '语音',
      saved: ['/ws/a.mp3'],
      outcome: { delivered: ['/ws/a.mp3'], failed: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已作为消息附件显示');
    expect(result.content).not.toContain('/ws/a.mp3');
  });

  it('未报告也未失败的文件（防御）：同样视为未送达', () => {
    const result = mediaDeliveryResult({
      generated: '2 张图片',
      saved: ['/ws/1.png', '/ws/2.png'],
      outcome: { delivered: ['/ws/1.png'], failed: [] },
    });
    expect(result.content).toContain('/ws/2.png');
    expect(result.content).not.toContain('已作为消息附件显示在用户的对话界面中。无需');
  });
});
