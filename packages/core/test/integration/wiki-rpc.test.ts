import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation, WikiSourceView } from '@kepcup/shared';
import { WIKI_TEXT_SOURCE_MAX_CHARS } from '@kepcup/shared';
import { createTestStack, makeBot, makeProject, step, waitFor, type TestStack } from '@kepcup/testkit';
import { initWiki } from '../../src/wiki/init.js';
import { ledgerPath, writeLedgerEntry, type WikiAssetEntry } from '../../src/wiki/assets.js';

/**
 * D92 T1b WP10 步骤 3：来源面板的三个 RPC——`wiki.sources`（台账视图 + Bot
 * 名字解析，已删除 Bot 显示 null）、`wiki.addSource`（用户来源：url / text，
 * 执行者是项目负责人；text 正文走完整入库链路）、`wiki.deleteSource`（异步
 * 托管登记）。错误路径：Bot owner、未知项目、text 超长、未知来源。
 */

let stack: TestStack;
let lead: string;
let project: Conversation;
const dir = mkdtempSync(path.join(tmpdir(), 'wiki-rpc-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  return stack.cleanup();
});

function projectOwner(): { kind: 'project'; id: string } {
  return { kind: 'project', id: project.id };
}
function wikiRootOf(): string {
  return path.join(stack.core.services.paths.home, 'projects', project.id, 'wiki');
}

function seedLedger(
  id: string,
  createdBy: WikiAssetEntry['createdBy'],
  createdAt: number,
): WikiAssetEntry {
  const entry: WikiAssetEntry = {
    id,
    sha256: '5'.repeat(64),
    kind: 'text',
    fileName: `${id}.md`,
    bytes: 12,
    storage: 'git',
    rawRelPath: `raw/20261018-555555555555-${id}.md`,
    createdBy,
    sources: [{ type: 'url', ref: `https://example.com/${id}`, conversationId: project.id, at: createdAt }],
    status: 'maintained',
    createdAt,
    updatedAt: createdAt,
  };
  writeFileSync(path.join(wikiRootOf(), entry.rawRelPath), `# ${id}\n\n内容`, 'utf8');
  writeLedgerEntry(wikiRootOf(), entry);
  return entry;
}

async function sourcesOf(): Promise<WikiSourceView[]> {
  const result = (await stack.core.rpc.call('wiki.sources', { owner: projectOwner() })) as {
    sources: WikiSourceView[];
  };
  return result.sources;
}

async function expectRpcError(method: string, input: unknown, code: string): Promise<void> {
  await expect(stack.core.rpc.call(method, input)).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  stack = await createTestStack();
  lead = (await makeBot(stack.core, '负责人甲')).id;
  const member = (await makeBot(stack.core, '成员乙')).id;
  project = await makeProject(stack.core, '来源面板项目', [lead, member], { leadBotId: lead });
  await initWiki(stack.core.services.paths, projectOwner(), {
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as never);
});

describe('D92 T1b WP10：wiki.sources / addSource / deleteSource', () => {
  it('wiki.sources：台账视图按 createdAt 倒序；Bot 名字解析、已删除 Bot 为 null；用户来源 kind=user', async () => {
    const botEntry = seedLedger('ast_bbbbbbbbbbbbbbbbbbbbbbbb', { kind: 'bot', id: lead }, 1_000);
    const goneBotEntry = seedLedger(
      'ast_cccccccccccccccccccccccc',
      { kind: 'bot', id: 'bot_never_existed' },
      2_000,
    );
    const userEntry = seedLedger('ast_dddddddddddddddddddddddd', { kind: 'user' }, 3_000);

    const sources = await sourcesOf();
    expect(sources.map((source) => source.id)).toEqual([
      userEntry.id,
      goneBotEntry.id,
      botEntry.id,
    ]);
    expect(sources[0]).toMatchObject({
      fileName: userEntry.fileName,
      bytes: userEntry.bytes,
      kind: 'text',
      createdBy: { kind: 'user' },
      createdAt: 3_000,
    });
    expect(sources[1]!.createdBy).toEqual({ kind: 'bot', id: 'bot_never_existed', name: null });
    expect(sources[2]!.createdBy).toEqual({ kind: 'bot', id: lead, name: '负责人甲' });
    // 子来源记录形态（type / ref / at）。
    expect(sources[2]!.sources).toEqual([
      { type: 'url', ref: `https://example.com/${botEntry.id}`, at: 1_000 },
    ]);

    // Bot owner → NOT_SUPPORTED（Bot wiki 没有台账）。
    await expectRpcError('wiki.sources', { owner: { kind: 'bot', id: lead } }, 'NOT_SUPPORTED');
    // 未知项目 → NOT_FOUND。
    await expectRpcError(
      'wiki.sources',
      { owner: { kind: 'project', id: 'conv_missing' } },
      'NOT_FOUND',
    );
  }, 60_000);

  it('wiki.addSource（text）：登记后维护 loop 落页；台账 ref 是预览、创建者是用户', async () => {
    const body = '用户粘贴的文本正文：TextSourceKeyword 项目 wiki 文本入库验证。';
    stack.llm.script('mock-main', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('TextSourceKeyword'))
        .replyToolCall('write', {
          path: 'pages/text-note.md',
          content: '# 文本页\n\nTextSourceKeyword 的整理结果。',
        }),
      step().replyToolCall('write', {
        path: 'index.md',
        content: '# 目录\n\n- [文本页](pages/text-note.md) — 粘贴文本的整理',
      }),
      step().replyToolCall('write', {
        path: 'log.md',
        content: '# 变更日志\n\n<!-- 只追加 -->\n- 20261018 | 粘贴文本 | pages/text-note.md',
      }),
      step().replyText('整理完成'),
    ]);

    const add = (await stack.core.rpc.call('wiki.addSource', {
      owner: projectOwner(),
      sourceType: 'text',
      ref: body,
      note: '粘贴的文本',
    })) as { ok: true };
    expect(add.ok).toBe(true);

    // 执行者是负责人（用户来源，执行者付费），载荷带 createdBy=user 与 text。
    const job = await waitFor(
      () => {
        const row = stack.core.services.mainDb!
          .prepare(
            "select bot_id, conversation_id, payload_json from jobs where type = 'wiki_ingest' and json_extract(payload_json, '$.sourceType') = 'text' order by created_at desc limit 1",
          )
          .get() as { bot_id: string; conversation_id: string; payload_json: string } | undefined;
        return row ?? null;
      },
      { label: 'text ingest job', timeoutMs: 30_000 },
    );
    expect(job.bot_id).toBe(lead);
    expect(job.conversation_id).toBe(project.id);
    expect(JSON.parse(job.payload_json)).toMatchObject({
      owner: projectOwner(),
      createdBy: { kind: 'user' },
      sourceType: 'text',
    });

    // 维护 loop 写出页面（真实管线）。
    await waitFor(
      async () => {
        const tree = (await stack.core.rpc.call('wiki.tree', { owner: projectOwner() })) as {
          pages: Array<{ path: string }>;
        };
        return tree.pages.some((page) => page.path === 'pages/text-note.md') ? true : null;
      },
      { label: 'text page appears', timeoutMs: 60_000 },
    );

    // 台账：type=text、ref 只存预览、创建者是用户。
    const sources = await sourcesOf();
    const textSource = sources.find((source) =>
      source.sources.some((record) => record.type === 'text'),
    );
    expect(textSource).toBeDefined();
    expect(textSource!.createdBy).toEqual({ kind: 'user' });
    expect(textSource!.fileName).toMatch(/^note-\d{8}-\d{6}\.md$/);
    const textRecord = textSource!.sources.find((record) => record.type === 'text')!;
    expect(textRecord.ref).toBe(body.slice(0, 80));
    // 原件存在。
    expect(existsSync(path.join(wikiRootOf(), 'raw'))).toBe(true);
  }, 120_000);

  it('wiki.addSource 错误路径：text 超长 / 非 http(s) URL / Bot owner / 未知项目', async () => {
    await expectRpcError(
      'wiki.addSource',
      {
        owner: projectOwner(),
        sourceType: 'text',
        ref: 'x'.repeat(WIKI_TEXT_SOURCE_MAX_CHARS + 1),
      },
      'INVALID_INPUT',
    );
    await expectRpcError(
      'wiki.addSource',
      { owner: projectOwner(), sourceType: 'text', ref: '   ' },
      'INVALID_INPUT',
    );
    await expectRpcError(
      'wiki.addSource',
      { owner: projectOwner(), sourceType: 'url', ref: 'ftp://example.com/x' },
      'INVALID_INPUT',
    );
    await expectRpcError(
      'wiki.addSource',
      { owner: { kind: 'bot', id: lead }, sourceType: 'url', ref: 'https://example.com/' },
      'NOT_SUPPORTED',
    );
    await expectRpcError(
      'wiki.addSource',
      {
        owner: { kind: 'project', id: 'conv_missing' },
        sourceType: 'text',
        ref: '正文',
      },
      'NOT_FOUND',
    );
  }, 60_000);

  it('wiki.deleteSource：登记 wiki_remove_source（actor=user）；未知来源 NOT_FOUND；Bot owner NOT_SUPPORTED', async () => {
    const entry = seedLedger('ast_eeeeeeeeeeeeeeeeeeeeeeee', { kind: 'bot', id: lead }, 4_000);
    const remove = (await stack.core.rpc.call('wiki.deleteSource', {
      owner: projectOwner(),
      sourceId: entry.id,
    })) as { ok: true };
    expect(remove.ok).toBe(true);
    const row = stack.core.services.mainDb!
      .prepare('select bot_id, payload_json from jobs where type = ? and dedupe_key = ?')
      .get('wiki_remove_source', `wiki_remove_source:project:${project.id}:${entry.id}`) as {
      bot_id: string;
      payload_json: string;
    };
    expect(row.bot_id).toBe(lead);
    expect(JSON.parse(row.payload_json)).toMatchObject({
      owner: projectOwner(),
      sourceId: entry.id,
      actor: { role: 'user' },
    });

    await expectRpcError(
      'wiki.deleteSource',
      { owner: projectOwner(), sourceId: 'ast_000000000000000000000000' },
      'NOT_FOUND',
    );
    await expectRpcError(
      'wiki.deleteSource',
      { owner: { kind: 'bot', id: lead }, sourceId: entry.id },
      'NOT_SUPPORTED',
    );
  }, 60_000);

  it('收尾：log.md 存在（initWiki 的模板），seed 的 raw 文件在', () => {
    const log = readFileSync(path.join(wikiRootOf(), 'log.md'), 'utf8');
    expect(log).toContain('变更日志');
    expect(existsSync(ledgerPath(wikiRootOf(), 'ast_bbbbbbbbbbbbbbbbbbbbbbbb'))).toBe(true);
  }, 30_000);
});
