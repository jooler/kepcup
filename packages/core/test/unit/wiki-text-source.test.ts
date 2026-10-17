import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WikiOwner } from '@kepcup/shared';
import { WIKI_TEXT_SOURCE_MAX_CHARS } from '@kepcup/shared';

import { resolvePaths } from '../../src/infra/paths.js';
import type { Clock } from '../../src/infra/clock.js';
import { WikiService } from '../../src/wiki/service.js';
import { ledgerRefOf, textSourceFileName } from '../../src/wiki/ingest.js';
import { writeLedgerEntry, type WikiAssetEntry } from '../../src/wiki/assets.js';

/**
 * D92 T1b WP10 步骤 1：`text` 来源（用户粘贴正文）。单测覆盖登记校验
 * （仅用户、非空、长度上限）、`enqueueRemoveSource` 的入队快速失败、
 * 台账 ref 预览与文件名格式；正文真正落库的链路在
 * test/integration/wiki-rpc.test.ts（经 wiki.addSource 走完整 core）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'wiki-text-source-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

interface Rig {
  wiki: WikiService;
  enqueued: Array<{
    type: string;
    botId?: string | null;
    conversationId?: string | null;
    payload: Record<string, unknown>;
    dedupeKey?: string | null;
  }>;
  conversations: Map<string, { id: string; type: 'direct' | 'project'; leadBotId?: string | null }>;
}

const PROJECT = 'conv_project';

function makeRig(): Rig {
  const home = path.join(dir, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const enqueued: Rig['enqueued'] = [];
  const conversations = new Map([
    [
      PROJECT,
      { id: PROJECT, type: 'project' as const, leadBotId: 'bot_lead' },
    ],
  ]);
  const members = new Set(['bot_lead', 'bot_member']);
  const clock: Clock = { now: () => Date.UTC(2026, 9, 17, 12, 34, 56) };
  const wiki = new WikiService({
    paths: resolvePaths(home),
    clock,
    logger: stubLogger,
    jobs: {
      enqueue: (input) => {
        enqueued.push(input);
        return 'job_x';
      },
      lastDoneAt: () => 0,
      lastDoneAtFor: () => 0,
    },
    bots: {
      get: (id) => (id === 'bot_lead' || id === 'bot_member' ? { id, status: 'active' } : null),
      listActive: () => [],
    },
    conversations: {
      get: (id) => conversations.get(id) ?? null,
      memberBotIds: (id) => (members.has(id) ? [...members] : []),
    },
    indexFor: () => {
      throw new Error('not needed here');
    },
    publish: () => {},
  });
  return { wiki, enqueued, conversations };
}

const projectOwner: WikiOwner = { kind: 'project', id: PROJECT };

function textSource(ref: string) {
  return { sourceType: 'text' as const, ref, note: '' };
}

describe('D92 T1b WP10：text 来源的登记校验（WikiService.enqueueIngest）', () => {
  it('用户提交：登记 wiki_ingest job，payload 带 text 与 owner', () => {
    const rig = makeRig();
    const outcome = rig.wiki.enqueueIngest({
      owner: projectOwner,
      botId: 'bot_lead',
      conversationId: PROJECT,
      source: textSource('这是用户粘贴的正文'),
      createdBy: { kind: 'user' },
    });
    expect(outcome.ok).toBe(true);
    expect(rig.enqueued).toHaveLength(1);
    expect(rig.enqueued[0]!.type).toBe('wiki_ingest');
    expect(rig.enqueued[0]!.payload).toMatchObject({
      owner: projectOwner,
      createdBy: { kind: 'user' },
      sourceType: 'text',
      ref: '这是用户粘贴的正文',
    });
    expect(rig.enqueued[0]!.dedupeKey).toBe(`wiki_ingest:project:${PROJECT}:text:这是用户粘贴的正文`);
  });

  it('createdBy 为 Bot 时直接拒绝（text 仅用户可用）', () => {
    const rig = makeRig();
    expect(() =>
      rig.wiki.enqueueIngest({
        owner: projectOwner,
        botId: 'bot_member',
        conversationId: PROJECT,
        source: textSource('Bot 想绕过界面粘贴文本'),
        createdBy: { kind: 'bot', id: 'bot_member' },
      }),
    ).toThrowError(/只能由用户提交/);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('空串与超长文本被拒', () => {
    const rig = makeRig();
    expect(
      rig.wiki.enqueueIngest({
        owner: projectOwner,
        botId: 'bot_lead',
        conversationId: PROJECT,
        source: textSource('   '),
        createdBy: { kind: 'user' },
      }),
    ).toMatchObject({ ok: false });
    const overlong = 'x'.repeat(WIKI_TEXT_SOURCE_MAX_CHARS + 1);
    expect(
      rig.wiki.enqueueIngest({
        owner: projectOwner,
        botId: 'bot_lead',
        conversationId: PROJECT,
        source: textSource(overlong),
        createdBy: { kind: 'user' },
      }),
    ).toMatchObject({ ok: false });
    expect(rig.enqueued).toHaveLength(0);
  });
});

describe('D92 T1b WP10：text 来源的文件名与台账预览（ingest.ts 纯函数）', () => {
  it('文件名形如 note-{yyyyMMdd-HHmmss}.md（UTC）', () => {
    expect(textSourceFileName(new Date('2026-10-17T12:34:56Z'))).toBe('note-20261017-123456.md');
    expect(textSourceFileName(new Date('2026-01-02T03:04:05Z'))).toBe('note-20260102-030405.md');
  });

  it('台账 ref 只存正文前 80 字预览；其它来源存完整引用', () => {
    const body = 'a'.repeat(200);
    expect(ledgerRefOf('text', body)).toBe('a'.repeat(80));
    expect(ledgerRefOf('text', `  ${'b'.repeat(100)}  `)).toBe('b'.repeat(80));
    expect(ledgerRefOf('url', 'https://example.com/page')).toBe('https://example.com/page');
    expect(ledgerRefOf('file', '/tmp/notes.md')).toBe('/tmp/notes.md');
  });
});

describe('D92 T1b WP10：enqueueRemoveSource 的入队快速失败', () => {
  function seedSource(rig: Rig, id: string, createdBy: WikiAssetEntry['createdBy']): void {
    const entry: WikiAssetEntry = {
      id,
      sha256: 'f'.repeat(64),
      kind: 'text',
      fileName: 'note-20261017-123456.md',
      bytes: 10,
      storage: 'git',
      rawRelPath: 'raw/20261017-abcdef123456-note-20261017-123456.md',
      createdBy,
      sources: [{ type: 'text', ref: '预览', conversationId: PROJECT, at: 0 }],
      status: 'maintained',
      createdAt: 0,
      updatedAt: 0,
    };
    writeLedgerEntry(rig.wiki.wikiRoot(projectOwner), entry);
  }

  it('Bot owner → NOT_SUPPORTED；会话不符 → INVALID_INPUT', () => {
    const rig = makeRig();
    expect(() =>
      rig.wiki.enqueueRemoveSource({
        owner: { kind: 'bot', id: 'bot_lead' },
        sourceId: 'ast_x',
        actor: { role: 'user' },
        leadBotId: 'bot_lead',
        conversationId: 'conv_direct',
      }),
    ).toThrowError(/没有来源台账/);
    expect(() =>
      rig.wiki.enqueueRemoveSource({
        owner: projectOwner,
        sourceId: 'ast_x',
        actor: { role: 'user' },
        leadBotId: 'bot_lead',
        conversationId: 'conv_other',
      }),
    ).toThrowError(/项目会话/);
  });

  it('来源不存在 → NOT_FOUND；ACL 不满足 → INVALID_INPUT，均不入队', () => {
    const rig = makeRig();
    seedSource(rig, 'ast_aaaaaaaaaaaaaaaaaaaaaaaa', { kind: 'bot', id: 'bot_member' });
    expect(() =>
      rig.wiki.enqueueRemoveSource({
        owner: projectOwner,
        sourceId: 'ast_000000000000000000000000',
        actor: { role: 'user' },
        leadBotId: 'bot_lead',
        conversationId: PROJECT,
      }),
    ).toThrowError(/不存在或已删除/);
    expect(() =>
      rig.wiki.enqueueRemoveSource({
        owner: projectOwner,
        sourceId: 'ast_aaaaaaaaaaaaaaaaaaaaaaaa',
        actor: { role: 'member', botId: 'bot_lead' },
        leadBotId: 'bot_lead',
        conversationId: PROJECT,
      }),
    ).toThrowError(/只能删除自己添加的来源/);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('通过校验 → 入队 wiki_remove_source（bot_id 为负责人，去重键含 owner 与来源）', () => {
    const rig = makeRig();
    seedSource(rig, 'ast_aaaaaaaaaaaaaaaaaaaaaaaa', { kind: 'bot', id: 'bot_member' });
    rig.wiki.enqueueRemoveSource({
      owner: projectOwner,
      sourceId: 'ast_aaaaaaaaaaaaaaaaaaaaaaaa',
      actor: { role: 'lead', botId: 'bot_lead' },
      leadBotId: 'bot_lead',
      conversationId: PROJECT,
    });
    expect(rig.enqueued).toHaveLength(1);
    expect(rig.enqueued[0]!.type).toBe('wiki_remove_source');
    expect(rig.enqueued[0]!.botId).toBe('bot_lead');
    expect(rig.enqueued[0]!.conversationId).toBe(PROJECT);
    expect(rig.enqueued[0]!.payload).toEqual({
      owner: projectOwner,
      sourceId: 'ast_aaaaaaaaaaaaaaaaaaaaaaaa',
      actor: { role: 'lead', botId: 'bot_lead' },
    });
    expect(rig.enqueued[0]!.dedupeKey).toBe(`wiki_remove_source:project:${PROJECT}:ast_aaaaaaaaaaaaaaaaaaaaaaaa`);
  });
});
