import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import { createTestStack, makeBot, waitForEvent, type TestStack } from '@kepcup/testkit';
import { commitWikiTree } from '../../src/wiki/git.js';
import { initWiki } from '../../src/wiki/init.js';
import { ledgerPath, writeLedgerEntry, type WikiAssetEntry } from '../../src/wiki/assets.js';

/**
 * D92 T1b WP10 步骤 1：`wiki_remove_source` job（异步托管动作）。入队即时的
 * ACL 快速失败；job 执行真正删除（互斥锁内、wiki_changed 事件）；执行时 ACL
 * 因身份变化失败 → 终结为 done 不重试（该 job 不调用任何模型）。
 */

let stack: TestStack;
let lead: string;
let memberM: string;
let memberN: string;
let project: Conversation;
const dir = mkdtempSync(path.join(tmpdir(), 'wiki-remove-source-job-'));

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

/** Deterministic distinct asset ids (hex, 24 chars) for seeded sources. */
let seedSeq = 0;
function seedAssetId(): string {
  seedSeq += 1;
  return `ast_${seedSeq.toString(16).padStart(24, '0')}`;
}

function seedSource(
  projectId: string,
  key: string,
  createdBy: WikiAssetEntry['createdBy'],
): WikiAssetEntry {
  const root = wikiRootOf(projectId);
  const rawRelPath = `raw/20261018-000000000000-${key}.md`;
  writeFileSync(path.join(root, rawRelPath), `# ${key}\n\n${key} 的原始内容。`, 'utf8');
  const entry: WikiAssetEntry = {
    id: seedAssetId(),
    sha256: '0'.repeat(64),
    kind: 'text',
    fileName: `${key}.md`,
    bytes: 16,
    storage: 'git',
    rawRelPath,
    createdBy,
    sources: [
      { type: 'url', ref: `https://example.com/${key}`, conversationId: projectId, at: 0 },
    ],
    status: 'maintained',
    createdAt: 0,
    updatedAt: 0,
  };
  writeLedgerEntry(root, entry);
  return entry;
}

function enqueueRemoval(input: {
  sourceId: string;
  actor: { role: 'user' | 'lead' | 'member'; botId?: string };
}): void {
  stack.core.services.wiki!.enqueueRemoveSource({
    owner: projectOwner(project.id),
    sourceId: input.sourceId,
    actor: input.actor,
    leadBotId: lead,
    conversationId: project.id,
  });
}

/** The jobs row of one dedupe key (null when absent). */
function jobRow(dedupeKey: string): { status: string; attempts: number } | null {
  return (
    (stack.core.services.mainDb!
      .prepare('select status, attempts from jobs where dedupe_key = ? order by created_at desc limit 1')
      .get(dedupeKey) as { status: string; attempts: number } | undefined) ?? null
  );
}

async function waitForJobDone(dedupeKey: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = jobRow(dedupeKey);
    if (row !== null && row.status !== 'pending' && row.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`job ${dedupeKey} did not settle within ${timeoutMs}ms (last: ${JSON.stringify(jobRow(dedupeKey))})`);
}

beforeAll(async () => {
  stack = await createTestStack();
  lead = (await makeBot(stack.core, '领队')).id;
  memberM = (await makeBot(stack.core, '阿M')).id;
  memberN = (await makeBot(stack.core, '阿N')).id;
  project = await (async () => {
    const result = (await stack.core.rpc.call('projects.create', {
      title: '删除来源作业项目',
      leadBotId: lead,
      memberBotIds: [lead, memberM, memberN],
    })) as { conversation: Conversation };
    return result.conversation;
  })();
  await initWiki(stack.core.services.paths, projectOwner(project.id), {
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as never);
  await commitWikiTree(wikiRootOf(project.id), 'seed');
});

describe('D92 T1b WP10：wiki_remove_source job', () => {
  it('入队即时 ACL 失败：成员删他人来源直接抛错，不产生 job 行', () => {
    const entry = seedSource(project.id, 'ownedbym', { kind: 'bot', id: memberM });
    expect(() =>
      enqueueRemoval({ sourceId: entry.id, actor: { role: 'member', botId: memberN } }),
    ).toThrowError(/只能删除自己添加的来源/);
    expect(jobRow(`wiki_remove_source:project:${project.id}:${entry.id}`)).toBeNull();
    expect(existsSync(ledgerPath(wikiRootOf(project.id), entry.id))).toBe(true);
  }, 30_000);

  it('job 执行删除成功：来源与原件消失，wiki_changed 带 owner', async () => {
    const entry = seedSource(project.id, 'jobdeletesme', { kind: 'bot', id: memberM });
    const changed = waitForEvent<{ owner: { kind: string; id: string } }>(
      stack.core,
      'wiki_changed',
      (p) => p.owner.kind === 'project' && p.owner.id === project.id,
      { timeoutMs: 30_000 },
    );
    // 用户可删全部来源（RPC 路径的 actor 形态）。
    enqueueRemoval({ sourceId: entry.id, actor: { role: 'user' } });
    expect(await changed).toEqual({ owner: projectOwner(project.id) });
    await waitForJobDone(`wiki_remove_source:project:${project.id}:${entry.id}`);
    expect(existsSync(path.join(wikiRootOf(project.id), entry.rawRelPath))).toBe(false);
    expect(existsSync(ledgerPath(wikiRootOf(project.id), entry.id))).toBe(false);
    // 执行者是 job.bot_id = 负责人（仅记账）。
    const row = stack.core.services.mainDb!
      .prepare('select bot_id, conversation_id from jobs where dedupe_key = ? order by created_at desc limit 1')
      .get(`wiki_remove_source:project:${project.id}:${entry.id}`) as { bot_id: string; conversation_id: string };
    expect(row.bot_id).toBe(lead);
    expect(row.conversation_id).toBe(project.id);
  }, 60_000);

  it('执行时 ACL 因身份变化失败：终结为 done，不重试，来源保留', async () => {
    // 台账归属在入队后发生变化（此处直接构造 actor 已不再匹配的行——等价于
    // 入队时身份合法、执行时已失效的竞态）。job 必须终结为 done 而非重试三次。
    const entry = seedSource(project.id, 'aclflips', { kind: 'bot', id: memberM });
    stack.core.services.domain!.jobs.enqueue({
      type: 'wiki_remove_source',
      botId: lead,
      conversationId: project.id,
      payload: {
        owner: projectOwner(project.id),
        sourceId: entry.id,
        // memberN 对 memberM 的来源没有条目级权限。
        actor: { role: 'member', botId: memberN },
      },
      priority: 2,
      dedupeKey: `wiki_remove_source:project:${project.id}:${entry.id}`,
    });
    await waitForJobDone(`wiki_remove_source:project:${project.id}:${entry.id}`);
    const row = jobRow(`wiki_remove_source:project:${project.id}:${entry.id}`)!;
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
    // 来源原样保留。
    expect(existsSync(ledgerPath(wikiRootOf(project.id), entry.id))).toBe(true);
    expect(existsSync(path.join(wikiRootOf(project.id), entry.rawRelPath))).toBe(true);
  }, 60_000);

  it('收尾：剩余 seed 清理后台账为空', async () => {
    for (const file of ledgerFiles(project.id)) {
      const id = file.replace(/\.json$/, '');
      await stack.core.services.wiki!.removeSource({
        owner: projectOwner(project.id),
        sourceId: id,
        actor: { role: 'user' },
      });
    }
    expect(ledgerFiles(project.id)).toEqual([]);
  }, 60_000);
});
