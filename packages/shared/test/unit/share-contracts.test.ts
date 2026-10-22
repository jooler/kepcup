import { describe, expect, it } from 'vitest';

import {
  APP_RPC_METHODS,
  ERROR_CODES,
  PLATFORM_RPC_METHODS,
  SHARE_FAILED_TTL_MS,
  SHARE_INTAKE_ID_PATTERN,
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  SHARE_NOTE_MAX_CHARS,
  SHARE_PROCESSING_STALE_MS,
  SHARE_TARGETS_STALE_MS,
  isShareIntakeId,
  messageContentSchema,
  rpcEventSchemas,
  rpcMethodSchemas,
  shareConsumeInputSchema,
  shareConsumeOutputSchema,
  shareFailedItemSchema,
  shareFailedListOutputSchema,
  shareFailedRetryInputSchema,
  shareManifestSchema,
  shareTargetSchema,
  shareTargetsChangedPayloadSchema,
  shareTargetsSchema,
} from '../../src/index.js';

const SHA = 'a'.repeat(64);
const INTAKE_ID = 'shr_01J8Z9K2QW3E4R5T6Y7U8I9O0P';

describe('shareManifestSchema（D94 §5.1）', () => {
  const base = {
    version: 1,
    intakeId: INTAKE_ID,
    createdAt: 1761196800000,
    target: { kind: 'bot', id: 'bot_x' },
    note: '帮我看下这个聊天记录',
    files: [
      {
        stagedName: '000-chat.zip',
        originalName: 'chat.zip',
        mime: 'application/zip',
        size: 12345678,
        sha256: SHA,
      },
    ],
  };

  it('接受合法 manifest', () => {
    const parsed = shareManifestSchema.parse(base);
    expect(parsed.intakeId).toBe(INTAKE_ID);
    expect(parsed.files).toHaveLength(1);
  });

  it('附言可为空', () => {
    expect(shareManifestSchema.parse({ ...base, note: '' }).note).toBe('');
  });

  it('intakeId 必须匹配 shr_ 前缀形状', () => {
    expect(shareManifestSchema.safeParse({ ...base, intakeId: 'x_1' }).success).toBe(false);
    expect(shareManifestSchema.safeParse({ ...base, intakeId: '../escape' }).success).toBe(false);
  });

  it('sha256 必须是 64 位十六进制', () => {
    expect(
      shareManifestSchema.safeParse({
        ...base,
        files: [{ ...base.files[0], sha256: 'nope' }],
      }).success,
    ).toBe(false);
  });

  it('文件数上限 10，且至少 1 个', () => {
    const many = Array.from({ length: SHARE_MAX_FILES + 1 }, (_, i) => ({
      ...base.files[0],
      stagedName: `${String(i).padStart(3, '0')}-f.zip`,
    }));
    expect(shareManifestSchema.safeParse({ ...base, files: many }).success).toBe(false);
    expect(shareManifestSchema.safeParse({ ...base, files: [] }).success).toBe(false);
  });

  it('附言超过 2000 字符拒绝', () => {
    expect(
      shareManifestSchema.safeParse({ ...base, note: 'x'.repeat(SHARE_NOTE_MAX_CHARS + 1) })
        .success,
    ).toBe(false);
  });

  it('stagedName 白名单：拒绝路径段与控制字符，放行 Unicode 文件名', () => {
    // 合法：序号 + 清洗后的名字——扩展 sanitizeName 保留 Unicode 字母数字与
    // 内部空格（CharacterSet.alphanumerics 含中文）。
    for (const stagedName of [
      '000-chat.zip',
      '001-photo.png',
      'a.txt',
      '002_wechat.zip',
      '000-聊天记录.zip',
      '003-my file.zip',
    ]) {
      expect(
        shareManifestSchema.safeParse({
          ...base,
          files: [{ ...base.files[0]!, stagedName }],
        }).success,
      ).toBe(true);
    }
    // 路径分隔符 / 控制字符 / `.` / `..` 段：全部拒绝（防路径注入，与 core /
    // 主进程 manifest 校验「basename 一致 + 拒绝 ..」同一口径）。
    for (const stagedName of ['a/b', 'a\\b', '..', '.', 'a..b', 'a\nb', '']) {
      expect(
        shareManifestSchema.safeParse({
          ...base,
          files: [{ ...base.files[0]!, stagedName }],
        }).success,
      ).toBe(false);
    }
  });
});

describe('shareTargetSchema / shareTargetsSchema', () => {
  it('目标只有 bot / project 两种', () => {
    expect(shareTargetSchema.parse({ kind: 'bot', id: 'bot_x' }).kind).toBe('bot');
    expect(shareTargetSchema.parse({ kind: 'project', id: 'conv_x' }).kind).toBe('project');
    expect(shareTargetSchema.safeParse({ kind: 'group', id: 'conv_x' }).success).toBe(false);
  });

  it('快照只含 id / 名称 / 类型 / 归档位', () => {
    const targets = shareTargetsSchema.parse({
      version: 1,
      generatedAt: 1761196800000,
      bots: [{ id: 'bot_x', name: '阿甲', kind: 'bot', archived: false }],
      projects: [{ id: 'conv_x', name: '项目讨论组', kind: 'project', archived: true }],
    });
    expect(targets.bots[0]).toEqual({
      id: 'bot_x',
      name: '阿甲',
      kind: 'bot',
      archived: false,
    });
  });
});

describe('shareConsumeInputSchema / shareConsumeOutputSchema', () => {
  const input = {
    intakeId: INTAKE_ID,
    target: { kind: 'bot', id: 'bot_x' },
    note: '',
    files: [
      {
        path: '/tmp/inbox/share/shr_x/files/000-a.zip',
        originalName: 'a.zip',
        mime: 'application/zip',
        size: 10,
        sha256: SHA,
      },
    ],
  };

  it('接受合法 consume 输入', () => {
    expect(shareConsumeInputSchema.parse(input).files[0]?.path).toContain('000-a.zip');
  });

  it('intakeId 形状非法拒绝', () => {
    expect(shareConsumeInputSchema.safeParse({ ...input, intakeId: 'bad' }).success).toBe(false);
  });

  it('输出状态只在四种之间', () => {
    for (const state of ['done', 'processing', 'failed_target', 'failed']) {
      expect(shareConsumeOutputSchema.parse({ state }).state).toBe(state);
    }
    expect(shareConsumeOutputSchema.safeParse({ state: 'received' }).success).toBe(false);
  });
});

describe('shareFailed* schema', () => {
  const item = {
    intakeId: INTAKE_ID,
    createdAt: 1761196800000,
    expiresAt: 1761196800000 + SHARE_FAILED_TTL_MS,
    errorCode: 'SHARE_TARGET_NOT_FOUND',
    errorMessage: '目标已删除',
    target: { kind: 'bot', id: 'bot_x' },
    files: [{ originalName: 'a.zip', size: 10, mime: 'application/zip' }],
  };

  it('列表项与列表输出', () => {
    expect(shareFailedItemSchema.parse(item).errorCode).toBe('SHARE_TARGET_NOT_FOUND');
    expect(shareFailedListOutputSchema.parse({ items: [item] }).items).toHaveLength(1);
  });

  it('重试必须带目标', () => {
    expect(shareFailedRetryInputSchema.safeParse({ intakeId: INTAKE_ID }).success).toBe(false);
    expect(
      shareFailedRetryInputSchema.parse({
        intakeId: INTAKE_ID,
        target: { kind: 'project', id: 'conv_x' },
      }).target.kind,
    ).toBe('project');
  });
});

describe('文本消息带 shareIntakeId（D94-4）', () => {
  it('可选字段，旧消息照常解析；形状必须匹配 shr_ 前缀', () => {
    const parsed = messageContentSchema.parse({ text: 'hi' });
    expect('shareIntakeId' in parsed).toBe(false);
    const withShare = messageContentSchema.parse({ text: '', shareIntakeId: INTAKE_ID });
    expect('shareIntakeId' in withShare && withShare.shareIntakeId).toBe(INTAKE_ID);
    // 契约与 SHARE_INTAKE_ID_PATTERN 收紧到同一形状，不收任意字符串。
    expect(messageContentSchema.safeParse({ text: '', shareIntakeId: 'bogus' }).success).toBe(
      false,
    );
    expect(
      messageContentSchema.safeParse({ text: '', shareIntakeId: '../escape' }).success,
    ).toBe(false);
  });
});

describe('分享的错误码与常量', () => {
  it('5 个错误码都登记了', () => {
    for (const code of [
      'SHARE_INTAKE_INVALID',
      'SHARE_TARGET_NOT_FOUND',
      'SHARE_TARGET_READ_ONLY',
      'SHARE_FILE_TOO_LARGE',
      'SHARE_MATERIALIZE_FAILED',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('上限常量与设计一致', () => {
    expect(SHARE_MAX_FILES).toBe(10);
    expect(SHARE_MAX_FILE_BYTES).toBe(30_000_000);
    expect(SHARE_MAX_TOTAL_BYTES).toBe(60_000_000);
    expect(SHARE_NOTE_MAX_CHARS).toBe(2000);
    expect(SHARE_FAILED_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SHARE_PROCESSING_STALE_MS).toBe(10 * 60 * 1000);
    expect(SHARE_TARGETS_STALE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('intakeId 形状检查', () => {
    expect(SHARE_INTAKE_ID_PATTERN.test(INTAKE_ID)).toBe(true);
    expect(isShareIntakeId('shr_')).toBe(false);
    expect(isShareIntakeId('shr_abcdefgh')).toBe(true);
  });
});

describe('分享的 RPC 与事件登记', () => {
  it('平台方法只在 port B', () => {
    for (const name of ['share.targets', 'share.consume'] as const) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(PLATFORM_RPC_METHODS).toContain(name);
      expect(APP_RPC_METHODS).not.toContain(name);
    }
  });

  it('失败恢复方法只在 port A', () => {
    for (const name of [
      'share.failed.list',
      'share.failed.retry',
      'share.failed.discard',
    ] as const) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
      expect(PLATFORM_RPC_METHODS).not.toContain(name);
    }
  });

  it('事件登记：app 事件 + platform 事件', () => {
    expect(rpcEventSchemas['share.failed.changed']).toBeDefined();
    expect(
      rpcEventSchemas['share.failed.changed'].parse({ intakeId: INTAKE_ID, state: 'failed' }),
    ).toEqual({ intakeId: INTAKE_ID, state: 'failed' });
  });

  it('targets.changed 的 reason 只有 bot / project（发射方只有这两种）', () => {
    expect(shareTargetsChangedPayloadSchema.parse({ reason: 'bot' }).reason).toBe('bot');
    expect(shareTargetsChangedPayloadSchema.parse({ reason: 'project' }).reason).toBe('project');
    // 'archive' / 'startup' 从未有发射方：归档变化走 conversation.updated（project），
    // 启动刷新由主进程 core-ready 主动拉，不走该事件。
    expect(shareTargetsChangedPayloadSchema.safeParse({ reason: 'archive' }).success).toBe(false);
    expect(shareTargetsChangedPayloadSchema.safeParse({ reason: 'startup' }).success).toBe(false);
  });
});
