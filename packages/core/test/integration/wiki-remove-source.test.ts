import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import { createTestStack, makeBot, step, waitForEvent, type TestStack } from '@kepcup/testkit';
import { commitWikiTree } from '../../src/wiki/git.js';
import { initWiki } from '../../src/wiki/init.js';
import {
  assetIdOf,
  ledgerPath,
  writeLedgerEntry,
  type WikiAssetEntry,
} from '../../src/wiki/assets.js';

/**
 * D92 T1b WP9 项目 wiki 的来源删除（D85 §6 `wiki.deleteAsset` 的文本子集，
 * `WikiService.removeSource`）：ACL 全表（用户 / 负责人删任意来源；成员仅删
 * 自建；Bot owner → NOT_SUPPORTED）、删除级联（原件 + 台账 + log.md + 提交 +
 * source_removed 体检去重 + wiki_changed + FTS 不动）、成员移出后其来源仍可
 * 被用户 / 负责人删除。RPC / 工具暴露面归 WP10，这里直接驱动服务层。
 */

let stack: TestStack;
let lead: string;
let memberM: string;
let memberN: string;
let project: Conversation;
const dir = mkdtempSync(path.join(tmpdir(), 'wiki-remove-source-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  return stack.cleanup();
});

function projectOwner(projectId: string): { kind: 'project'; id: string } {
  return { kind: 'project', id: projectId };
}
function wikiRootOf(projectId: string): string {
  return path.join(stack.core.services.paths.home, 'projects', projectId, 'wiki');
}
function ledgerFiles(projectId: string): string[] {
  const assetsDir = path.join(wikiRootOf(projectId), 'raw', '_assets');
  try {
    return readdirSync(assetsDir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
}

/** Seeds one ledgered source (raw file + ledger entry) and returns its entry. */
function seedSource(
  projectId: string,
  key: string,
  createdBy: WikiAssetEntry['createdBy'],
): WikiAssetEntry {
  const root = wikiRootOf(projectId);
  const content = `# ${key} 的原始资料\n\n${key}SourceKeyword：仅供删除测试的内容。`;
  const bytes = Buffer.from(content, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const rawRelPath = `raw/20261017-${sha256.slice(0, 12)}-${key}.md`;
  writeFileSync(path.join(root, rawRelPath), bytes);
  const entry: WikiAssetEntry = {
    id: assetIdOf(sha256),
    sha256,
    kind: 'text',
    fileName: `${key}.md`,
    bytes: bytes.length,
    storage: 'git',
    rawRelPath,
    createdBy,
    sources: [
      {
        type: 'attachment',
        ref: `att_${key}`,
        conversationId: projectId,
        at: stack.core.services.clock.now(),
      },
    ],
    status: 'maintained',
    createdAt: stack.core.services.clock.now(),
    updatedAt: stack.core.services.clock.now(),
  };
  writeLedgerEntry(root, entry);
  return entry;
}

async function commitCount(projectId: string): Promise<number> {
  const root = wikiRootOf(projectId);
  const { spawnSync } = await import('node:child_process');
  const rev = spawnSync(
    'git',
    ['--git-dir', path.join(root, '.git'), 'rev-list', '--count', 'HEAD'],
    {
      encoding: 'utf8',
    },
  );
  return Number(rev.stdout.trim()) || 0;
}

/** One pending wiki_lint decoy so a later enqueue with the same dedupe key is a no-op. */
function blockSourceRemovedLint(projectId: string): void {
  stack.core.services.domain!.jobs.enqueue({
    type: 'wiki_lint',
    botId: lead,
    conversationId: projectId,
    payload: { owner: projectOwner(projectId), trigger: 'decoy' },
    priority: 2,
    dedupeKey: `wiki_lint:project:${projectId}:source_removed`,
    runAfter: stack.core.services.clock.now() + 3_600_000, // pending, not claimable
  });
}

beforeAll(async () => {
  stack = await createTestStack();
  lead = (await makeBot(stack.core, '阿领')).id;
  memberM = (await makeBot(stack.core, '阿M')).id;
  memberN = (await makeBot(stack.core, '阿N')).id;
  project = await (async () => {
    const result = (await stack.core.rpc.call('projects.create', {
      title: '来源删除项目',
      leadBotId: lead,
      memberBotIds: [lead, memberM, memberN],
    })) as { conversation: Conversation };
    return result.conversation;
  })();
  // Seed the project wiki by hand (no maintenance loop needed for ACL tests).
  await initWiki(stack.core.services.paths, projectOwner(project.id), {
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as never);
  const root = wikiRootOf(project.id);
  writeFileSync(
    path.join(root, 'pages/seeded.md'),
    '# 已有页面\n\nSeededPageKeyword：删除来源不动 FTS 的对照页。',
    'utf8',
  );
  stack.core.services
    .wikiIndexes!.forProject(project.id)
    .wikiUpsertPage(
      'pages/seeded.md',
      '已有页面',
      '# 已有页面\n\nSeededPageKeyword：删除来源不动 FTS 的对照页。',
    );
  await commitWikiTree(root, 'seed');
});

describe('D92 T1b WP9：项目 wiki 来源删除（removeSource）', () => {
  it('ACL 全表：成员删自己成功；成员删他人 / 用户来源被拒；Bot owner → NOT_SUPPORTED', async () => {
    const mEntry = seedSource(project.id, 'm-doc', { kind: 'bot', id: memberM });
    const nEntry = seedSource(project.id, 'n-doc', { kind: 'bot', id: memberN });
    const userEntry = seedSource(project.id, 'user-doc', { kind: 'user' });

    // 成员删别人的 → 拒绝（INVALID_INPUT，不新增错误码）。
    await expect(
      stack.core.services.wiki!.removeSource({
        owner: projectOwner(project.id),
        sourceId: mEntry.id,
        actor: { role: 'member', botId: memberN },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 成员删用户来源 → 拒绝。
    await expect(
      stack.core.services.wiki!.removeSource({
        owner: projectOwner(project.id),
        sourceId: userEntry.id,
        actor: { role: 'member', botId: memberM },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 拒绝路径不删任何东西。
    expect(existsSync(path.join(wikiRootOf(project.id), mEntry.rawRelPath))).toBe(true);
    expect(existsSync(ledgerPath(wikiRootOf(project.id), mEntry.id))).toBe(true);

    // 成员删自己的 → 成功。
    await stack.core.services.wiki!.removeSource({
      owner: projectOwner(project.id),
      sourceId: nEntry.id,
      actor: { role: 'member', botId: memberN },
    });
    expect(existsSync(path.join(wikiRootOf(project.id), nEntry.rawRelPath))).toBe(false);
    expect(existsSync(ledgerPath(wikiRootOf(project.id), nEntry.id))).toBe(false);

    // Bot owner → NOT_SUPPORTED。
    await expect(
      stack.core.services.wiki!.removeSource({
        owner: { kind: 'bot', id: memberM },
        sourceId: mEntry.id,
        actor: { role: 'member', botId: memberM },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    // 不存在的来源 → NOT_FOUND。
    await expect(
      stack.core.services.wiki!.removeSource({
        owner: projectOwner(project.id),
        sourceId: 'ast_000000000000000000000000',
        actor: { role: 'user' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 清理剩余 seed（后续用例从干净台账计数）。
    await stack.core.services.wiki!.removeSource({
      owner: projectOwner(project.id),
      sourceId: mEntry.id,
      actor: { role: 'lead', botId: lead },
    });
    await stack.core.services.wiki!.removeSource({
      owner: projectOwner(project.id),
      sourceId: userEntry.id,
      actor: { role: 'user' },
    });
    expect(ledgerFiles(project.id)).toEqual([]);
  }, 60_000);

  it('删除级联：log.md 记录、新提交、source_removed 体检入队且去重、wiki_changed、FTS 不动', async () => {
    const entry = seedSource(project.id, 'cascade', { kind: 'bot', id: memberM });
    const commitsBefore = await commitCount(project.id);
    const ftsBefore = stack.core.services.wikiIndexes!.forProject(project.id).wikiPagePaths();

    // 体检 loop 需要模型：给 lint 模式一个直接完成的应答。
    stack.llm.script('mock-main', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('体检'))
        .replyText('项目 wiki 体检完成'),
    ]);
    const changedEvent = waitForEvent<{ owner: { kind: string; id: string } }>(
      stack.core,
      'wiki_changed',
      (p) => p.owner.kind === 'project' && p.owner.id === project.id,
      { timeoutMs: 30_000 },
    );

    await stack.core.services.wiki!.removeSource({
      owner: projectOwner(project.id),
      sourceId: entry.id,
      actor: { role: 'lead', botId: lead },
    });
    expect(await changedEvent).toEqual({ owner: projectOwner(project.id) });

    // 原件与台账文件消失；log.md 有「删除来源」行。
    expect(existsSync(path.join(wikiRootOf(project.id), entry.rawRelPath))).toBe(false);
    expect(existsSync(ledgerPath(wikiRootOf(project.id), entry.id))).toBe(false);
    const log = readFileSync(path.join(wikiRootOf(project.id), 'log.md'), 'utf8');
    expect(log).toContain('删除来源');
    expect(log).toContain(entry.fileName);
    // 新增一次提交（删除级联是追加式历史的一部分）。
    expect(await commitCount(project.id)).toBe(commitsBefore + 1);
    // source_removed 体检已入队：执行者是负责人、会话是项目 id。
    const lintJob = stack.core.services
      .mainDb!.prepare(
        'select bot_id, conversation_id, payload_json from jobs where dedupe_key = ? order by created_at desc limit 1',
      )
      .get(`wiki_lint:project:${project.id}:source_removed`) as {
      bot_id: string;
      conversation_id: string;
      payload_json: string;
    };
    expect(lintJob.bot_id).toBe(lead);
    expect(lintJob.conversation_id).toBe(project.id);
    expect(JSON.parse(lintJob.payload_json)).toMatchObject({
      owner: projectOwner(project.id),
      trigger: 'source_removed',
    });
    // FTS 行不变（索引只覆盖 pages/，不索引 raw/ 与台账）。
    expect(stack.core.services.wikiIndexes!.forProject(project.id).wikiPagePaths()).toEqual(
      ftsBefore,
    );

    // 去重：占住 pending 的同名去重键后再删一份，不再产生第二行。
    // 先冻住 jobs runner（500ms tick 在慢节点 / Windows fs 级联的秒级窗口内
    // 会抢走 pending 行，去重便没有对照对象了）——观察窗内行数不得增加。
    stack.core.services.jobsRunner!.stop();
    blockSourceRemovedLint(project.id);
    const rowsBefore = (
      stack.core.services
        .mainDb!.prepare('select count(*) as n from jobs where dedupe_key = ?')
        .get(`wiki_lint:project:${project.id}:source_removed`) as { n: number }
    ).n;
    const second = seedSource(project.id, 'cascade-2', { kind: 'bot', id: memberM });
    await stack.core.services.wiki!.removeSource({
      owner: projectOwner(project.id),
      sourceId: second.id,
      actor: { role: 'user' },
    });
    const rowsAfter = (
      stack.core.services
        .mainDb!.prepare('select count(*) as n from jobs where dedupe_key = ?')
        .get(`wiki_lint:project:${project.id}:source_removed`) as { n: number }
    ).n;
    expect(rowsAfter).toBe(rowsBefore);
  }, 90_000);

  it('成员被移出项目后其来源保留，仍可由用户 / 负责人删除', async () => {
    const mEntry = seedSource(project.id, 'left-member', { kind: 'bot', id: memberM });
    await stack.core.rpc.call('projects.removeMember', {
      conversationId: project.id,
      botId: memberM,
    });
    // 来源保留。
    expect(existsSync(path.join(wikiRootOf(project.id), mEntry.rawRelPath))).toBe(true);
    expect(existsSync(ledgerPath(wikiRootOf(project.id), mEntry.id))).toBe(true);
    expect(
      stack.core.services.wiki!.listSources(projectOwner(project.id)).map((s) => s.id),
    ).toContain(mEntry.id);
    // 用户仍可删。
    await stack.core.services.wiki!.removeSource({
      owner: projectOwner(project.id),
      sourceId: mEntry.id,
      actor: { role: 'user' },
    });
    expect(existsSync(ledgerPath(wikiRootOf(project.id), mEntry.id))).toBe(false);
  }, 60_000);
});
