import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';
import { commitWikiTree } from '../../src/wiki/git.js';
import { initWiki } from '../../src/wiki/init.js';
import { assetIdOf, writeLedgerEntry, type WikiAssetEntry } from '../../src/wiki/assets.js';

/**
 * D92 T1b WP9 项目 wiki 的生命周期级联：删除项目（目录 + wiki.db + 排队
 * wiki job + 连接）、移出成员（排队入库取消、已入库来源保留）、删除成员
 * Bot（来源与 createdBy 保留、排队 job 取消）。读路径在未初始化时的安全
 * 空返回已在 wiki-project.test.ts 覆盖。
 */

let stack: TestStack;
let lead: string;
let memberM: string;
let memberN: string;
const dir = mkdtempSync(path.join(tmpdir(), 'wiki-project-lifecycle-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  return stack.cleanup();
});

function makeOwner(projectId: string): { kind: 'project'; id: string } {
  return { kind: 'project', id: projectId };
}
function projectDir(projectId: string): string {
  return path.join(stack.core.services.paths.home, 'projects', projectId);
}
function wikiRootOf(projectId: string): string {
  return path.join(projectDir(projectId), 'wiki');
}
function ledgerIds(projectId: string): string[] {
  const assetsDir = path.join(wikiRootOf(projectId), 'raw', '_assets');
  try {
    return readdirSync(assetsDir).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Seeds one ledgered source for `botId` into the project wiki (no LLM). */
async function seedSource(projectId: string, key: string, botId: string): Promise<WikiAssetEntry> {
  const root = wikiRootOf(projectId);
  const content = `# ${key}\n\n${key}Keyword：生命周期测试来源。`;
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
    createdBy: { kind: 'bot', id: botId },
    sources: [{ type: 'attachment', ref: `att_${key}`, conversationId: projectId, at: stack.core.services.clock.now() }],
    status: 'maintained',
    createdAt: stack.core.services.clock.now(),
    updatedAt: stack.core.services.clock.now(),
  };
  writeLedgerEntry(root, entry);
  await commitWikiTree(root, `seed ${key}`);
  return entry;
}

/** A queued (pending, far run_after) wiki_ingest row attributed to `botId`. */
function enqueuePendingIngest(projectId: string, botId: string, ref: string): string {
  return stack.core.services.domain!.jobs.enqueue({
    type: 'wiki_ingest',
    botId,
    conversationId: projectId,
    payload: {
      owner: makeOwner(projectId),
      createdBy: { kind: 'bot', id: botId },
      sourceType: 'attachment',
      ref,
      note: '',
    },
    priority: 2,
    runAfter: stack.core.services.clock.now() + 3_600_000,
  });
}

beforeAll(async () => {
  stack = await createTestStack();
  lead = (await makeBot(stack.core, '阿领')).id;
  memberM = (await makeBot(stack.core, '阿M')).id;
  memberN = (await makeBot(stack.core, '阿N')).id;
});

describe('D92 T1b WP9：项目 wiki 生命周期', () => {
  it('删除项目组：projects/{id}/ 整个目录与 wiki.db 消失，wiki job 全部取消，连接关闭', async () => {
    const result = (await stack.core.rpc.call('projects.create', {
      title: '待删除项目',
      leadBotId: lead,
      memberBotIds: [lead, memberM, memberN],
    })) as { conversation: Conversation };
    const projectId = result.conversation.id;
    await initWiki(stack.core.services.paths, makeOwner(projectId), {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never);
    await seedSource(projectId, 'doomed', memberM);
    // 保证池里开着这个连接（wiki.db 由首次 open 创建），随后断言删除时文件与连接一起消失。
    stack.core.services.wikiIndexes!.forProject(projectId);
    const openBefore = stack.core.services.wikiIndexes!.openCount;
    expect(existsSync(path.join(projectDir(projectId), 'wiki.db'))).toBe(true);

    const queuedJob = enqueuePendingIngest(projectId, memberN, 'att_doomed');

    await stack.core.rpc.call('conversations.delete', { id: projectId });

    expect(existsSync(projectDir(projectId))).toBe(false);
    expect(existsSync(path.join(projectDir(projectId), 'wiki.db'))).toBe(false);
    const job = stack.core.services
      .mainDb!.prepare('select status from jobs where id = ?')
      .get(queuedJob) as { status: string };
    expect(job.status).toBe('cancelled');
    expect(stack.core.services.wikiIndexes!.openCount).toBe(openBefore - 1);
    // 目录没了之后读路径安全（不抛、不重建）。
    expect(stack.core.services.wiki!.tree(makeOwner(projectId))).toEqual([]);
    expect(stack.core.services.wiki!.sourceCount(makeOwner(projectId))).toBe(0);
  }, 60_000);

  it('移出成员：其排队中的入库 job 取消，已入库来源保留', async () => {
    const result = (await stack.core.rpc.call('projects.create', {
      title: '移出成员项目',
      leadBotId: lead,
      memberBotIds: [lead, memberM, memberN],
    })) as { conversation: Conversation };
    const projectId = result.conversation.id;
    await initWiki(stack.core.services.paths, makeOwner(projectId), {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never);
    const entry = await seedSource(projectId, 'kept', memberM);
    const queuedJob = enqueuePendingIngest(projectId, memberM, 'att_pending_m');

    await stack.core.rpc.call('projects.removeMember', {
      conversationId: projectId,
      botId: memberM,
    });

    const job = stack.core.services
      .mainDb!.prepare('select status from jobs where id = ?')
      .get(queuedJob) as { status: string };
    expect(job.status).toBe('cancelled');
    // 已入库来源与台账保留。
    expect(ledgerIds(projectId)).toContain(entry.id);
    expect(existsSync(path.join(wikiRootOf(projectId), entry.rawRelPath))).toBe(true);
    const stored = stack.core.services.wiki!.listSources(makeOwner(projectId)).find(
      (s) => s.id === entry.id,
    );
    expect(stored?.createdBy).toEqual({ kind: 'bot', id: memberM });
  }, 60_000);

  it('删除成员 Bot：项目 wiki 里它的来源保留（createdBy 不变），排队 job 取消', async () => {
    const result = (await stack.core.rpc.call('projects.create', {
      title: '删 Bot 项目',
      leadBotId: lead,
      memberBotIds: [lead, memberM, memberN],
    })) as { conversation: Conversation };
    const projectId = result.conversation.id;
    await initWiki(stack.core.services.paths, makeOwner(projectId), {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never);
    const entry = await seedSource(projectId, 'gone-bot', memberN);
    const queuedJob = enqueuePendingIngest(projectId, memberN, 'att_pending_n');

    await stack.core.rpc.call('bots.delete', { id: memberN });

    const job = stack.core.services
      .mainDb!.prepare('select status from jobs where id = ?')
      .get(queuedJob) as { status: string };
    expect(job.status).toBe('cancelled');
    expect(ledgerIds(projectId)).toContain(entry.id);
    const stored = stack.core.services.wiki!.listSources(makeOwner(projectId)).find(
      (s) => s.id === entry.id,
    );
    expect(stored?.createdBy).toEqual({ kind: 'bot', id: memberN });
    expect(existsSync(path.join(wikiRootOf(projectId), entry.rawRelPath))).toBe(true);
  }, 60_000);
});
