import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, Message } from '@kepcup/shared';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { resolvePaths, type AppPaths } from '../../src/infra/paths.js';
import { AttachmentsService } from '../../src/domain/attachments.js';
import { ensureShareAttachmentCopy } from '../../src/share/materialize.js';
import {
  renderMessageLine,
  type RenderMessageOptions,
} from '../../src/agent/context/conversation.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * D94 §5.7：分享附件的 workspace 副本与上下文附件行。
 * 重点：路径只给 workspace 副本；不含原始分享源路径；普通上传附件行不变。
 */

const root = mkdtempSync(path.join(tmpdir(), 'share-copy-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const clock: Clock = { now: () => 1_700_000_000_000 };

let db: SqliteDatabase;
let home: string;
let paths: AppPaths;
let attachments: AttachmentsService;

beforeEach(() => {
  home = mkdtempSync(path.join(root, 'home-'));
  paths = resolvePaths(home);
  db = openDatabase({
    path: path.join(root, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 3), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  db.prepare(
    "insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1)",
  ).run();
  attachments = new AttachmentsService({ db, paths, clock });
});

function upload(bytes: Buffer, fileName = 'chat.zip', mime = 'application/zip'): Attachment {
  return attachments.upload({ conversationId: 'conv_1', fileName, mime, bytes });
}

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: '' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1_700_000_000_000,
    attachments: [],
    ...overrides,
  };
}

describe('ensureShareAttachmentCopy', () => {
  it('物化到 workspace 的 .attachments 目录，权限 0444', () => {
    const attachment = upload(Buffer.from('zip-bytes'));
    const workspacePath = path.join(home, 'bots', 'bot_a', 'workspaces', 'conv_1');
    const copy = ensureShareAttachmentCopy({ attachments, workspacePath, attachment });
    expect(copy.path).toBe(path.join(workspacePath, '.attachments', `${attachment.id}_chat.zip`));
    expect(existsSync(copy.path)).toBe(true);
    expect(readFileSync(copy.path).toString()).toBe('zip-bytes');
    // 0444（只读语义）
    expect(statSync(copy.path).mode & 0o777).toBe(0o444);
  });

  it('第二次调用复用同一份副本', () => {
    const attachment = upload(Buffer.from('zip-bytes'));
    const workspacePath = path.join(home, 'bots', 'bot_a', 'workspaces', 'conv_1');
    const first = ensureShareAttachmentCopy({ attachments, workspacePath, attachment });
    const second = ensureShareAttachmentCopy({ attachments, workspacePath, attachment });
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it('副本被改写后重建并恢复原始字节', () => {
    const attachment = upload(Buffer.from('zip-bytes'));
    const workspacePath = path.join(home, 'bots', 'bot_a', 'workspaces', 'conv_1');
    const first = ensureShareAttachmentCopy({ attachments, workspacePath, attachment });
    chmodSync(first.path, 0o644);
    writeFileSync(first.path, 'tampered');
    const second = ensureShareAttachmentCopy({ attachments, workspacePath, attachment });
    expect(second.reused).toBe(false);
    expect(readFileSync(second.path).toString()).toBe('zip-bytes');
    expect(statSync(second.path).mode & 0o777).toBe(0o444);
  });

  it('内容与记录的 sha256 不符 → 抛 SHARE_MATERIALIZE_FAILED', () => {
    const attachment = upload(Buffer.from('zip-bytes'));
    const broken: Attachment = { ...attachment, sha256: 'c'.repeat(64) };
    const workspacePath = path.join(home, 'bots', 'bot_a', 'workspaces', 'conv_1');
    expect(() =>
      ensureShareAttachmentCopy({ attachments, workspacePath, attachment: broken }),
    ).toThrow(/sha256/);
  });

  it('项目组里不同 Bot 各有一份副本，路径互不相同', () => {
    const attachment = upload(Buffer.from('zip-bytes'));
    const a = ensureShareAttachmentCopy({
      attachments,
      workspacePath: path.join(home, 'bots', 'bot_a', 'workspaces', 'conv_1'),
      attachment,
    });
    const b = ensureShareAttachmentCopy({
      attachments,
      workspacePath: path.join(home, 'bots', 'bot_b', 'workspaces', 'conv_1'),
      attachment,
    });
    expect(a.path).not.toBe(b.path);
    expect(a.path).toContain(path.join('bot_a', 'workspaces', 'conv_1'));
    expect(b.path).toContain(path.join('bot_b', 'workspaces', 'conv_1'));
  });

  it('文件名清洗：路径分隔符与控制字符被替换', () => {
    const attachment = upload(Buffer.from('x'), '../etc/passwd');
    const workspacePath = path.join(home, 'bots', 'bot_a', 'workspaces', 'conv_1');
    const copy = ensureShareAttachmentCopy({ attachments, workspacePath, attachment });
    expect(copy.path.startsWith(path.join(workspacePath, '.attachments'))).toBe(true);
    expect(copy.path).not.toContain('..');
  });
});

describe('上下文附件行（D94 §5.7）', () => {
  const options: RenderMessageOptions = {
    selfBotId: 'bot_a',
    timeZone: 'Asia/Shanghai',
    botNames: new Map([['bot_a', '阿甲']]),
    shareAttachmentPath: () =>
      '/Users/me/.kepcup/bots/bot_a/workspaces/conv_1/.attachments/att_x_chat.zip',
  };

  it('分享消息的附件行带 path', () => {
    const message = makeMessage({
      id: 'msg_1',
      content: { text: '', shareIntakeId: 'shr_abc' },
      attachments: [
        {
          id: 'att_x',
          conversationId: 'conv_1',
          messageId: 'msg_1',
          fileName: 'chat.zip',
          mime: 'application/zip',
          size: 2048 * 1024,
          sha256: 'a'.repeat(64),
          relPath: 'att_x_chat.zip',
          createdAt: 0,
        },
      ],
    });
    const line = renderMessageLine(message, options);
    expect(line).toContain('att_x chat.zip [application/zip] 2048KB');
    expect(line).toContain(
      'path="/Users/me/.kepcup/bots/bot_a/workspaces/conv_1/.attachments/att_x_chat.zip"',
    );
  });

  it('普通上传附件行保持原格式（不带 path）', () => {
    const message = makeMessage({
      id: 'msg_2',
      content: { text: '看看这个' },
      attachments: [
        {
          id: 'att_y',
          conversationId: 'conv_1',
          messageId: 'msg_2',
          fileName: 'a.pdf',
          mime: 'application/pdf',
          size: 1024,
          sha256: 'a'.repeat(64),
          relPath: 'att_y_a.pdf',
          createdAt: 0,
        },
      ],
    });
    const line = renderMessageLine(message, options);
    expect(line).toContain('att_y a.pdf [application/pdf] 1KB');
    expect(line).not.toContain('path=');
  });

  it('物化失败 → path=unavailable（仍带 id 与元数据）', () => {
    const message = makeMessage({
      id: 'msg_3',
      content: { text: '', shareIntakeId: 'shr_abc' },
      attachments: [
        {
          id: 'att_z',
          conversationId: 'conv_1',
          messageId: 'msg_3',
          fileName: 'a.zip',
          mime: 'application/zip',
          size: 10,
          sha256: 'a'.repeat(64),
          relPath: 'att_z_a.zip',
          createdAt: 0,
        },
      ],
    });
    const line = renderMessageLine(message, {
      ...options,
      shareAttachmentPath: () => null,
    });
    expect(line).toContain('att_z a.zip [application/zip] 1KB path=unavailable');
  });

  it('上下文里不出现原始分享源路径，也不预灌文件正文', () => {
    const message = makeMessage({
      id: 'msg_4',
      content: { text: '', shareIntakeId: 'shr_abc' },
      attachments: [
        {
          id: 'att_w',
          conversationId: 'conv_1',
          messageId: 'msg_4',
          fileName: 'chat.zip',
          mime: 'application/zip',
          size: 10,
          sha256: createHash('sha256').update('zip').digest('hex'),
          relPath: 'att_w_chat.zip',
          createdAt: 0,
        },
      ],
    });
    const line = renderMessageLine(message, options);
    expect(line).not.toContain('000-chat.zip');
    expect(line).not.toContain('聊天记录全文');
    expect(line).not.toContain('以下');
  });
});
