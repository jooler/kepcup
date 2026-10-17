import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  makeProject,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';
import { createMemoryKeystore, type CoreHarness } from '@kepcup/core';
import { assetIdOf } from '../../src/wiki/assets.js';

/**
 * D92 T1b WP9 项目 wiki 全链路（经完整 core + mock LLM）：项目组（负责人 L、
 * 成员 M、N）——成员入库（执行者付费）、串行维护队列、来源台账（createdBy /
 * 同内容去重追加 sources）、项目级索引库 wiki.db、用户来源与定期体检走负责人
 * 身份、Bot 个人 wiki 的存储与索引隔离。RPC / 工具面归 WP10，这里经服务层与
 * RPC 混合驱动。
 */

let stack: TestStack;
let lead: string;
let memberM: string;
let memberN: string;
let project: Conversation;

const dir = mkdtempSync(path.join(tmpdir(), 'wiki-project-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  return stack.cleanup();
});

function botOwner(botId: string): { kind: 'bot'; id: string } {
  return { kind: 'bot', id: botId };
}
function projectOwner(projectId: string): { kind: 'project'; id: string } {
  return { kind: 'project', id: projectId };
}
function projectWikiRoot(core: CoreHarness, projectId: string): string {
  return path.join(core.services.paths.home, 'projects', projectId, 'wiki');
}
function ledgerFiles(core: CoreHarness, projectId: string): string[] {
  const dirPath = path.join(projectWikiRoot(core, projectId), 'raw', '_assets');
  try {
    return readdirSync(dirPath).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}
async function commitCount(core: CoreHarness, projectId: string): Promise<number> {
  const root = projectWikiRoot(core, projectId);
  if (!existsSync(path.join(root, '.git'))) return 0;
  const { spawnSync } = await import('node:child_process');
  const rev = spawnSync('git', ['--git-dir', path.join(root, '.git'), 'rev-list', '--count', 'HEAD'], {
    encoding: 'utf8',
  });
  return Number(rev.stdout.trim()) || 0;
}
async function maintenanceRuns(
  core: CoreHarness,
  projectId: string,
): Promise<Array<{ bot_id: string; status: string; created_at: number }>> {
  return core.services
    .runsDb!.prepare(
      "select bot_id, status, created_at from runs where conversation_id = ? and loop_type = 'wiki_maintenance' order by created_at",
    )
    .all(projectId) as Array<{ bot_id: string; status: string; created_at: number }>;
}
async function waitJobDone(core: CoreHarness, type: string, count: number): Promise<void> {
  await waitFor(
    () => {
      const rows = core.services
        .mainDb!.prepare('select status from jobs where type = ? order by created_at')
        .all(type) as Array<{ status: string }>;
      return rows.length >= count && rows.every((row) => row.status === 'done') ? true : null;
    },
    { label: `${count} ${type} job(s) done`, timeoutMs: 90_000 },
  );
}
async function uploadAttachment(
  core: CoreHarness,
  conversationId: string,
  fileName: string,
  text: string,
): Promise<string> {
  const upload = (await core.rpc.call('attachments.upload', {
    conversationId,
    fileName,
    mime: 'text/markdown',
    bytesBase64: Buffer.from(text, 'utf8').toString('base64'),
  })) as { attachment: { id: string } };
  return upload.attachment.id;
}

beforeAll(async () => {
  stack = await createTestStack();
  lead = (await makeBot(stack.core, '阿领')).id;
  memberM = (await makeBot(stack.core, '阿M')).id;
  memberN = (await makeBot(stack.core, '阿N')).id;
  project = await makeProject(stack.core, '项目 Wiki', [lead, memberM, memberN], {
    leadBotId: lead,
  });
});

describe('D92 T1b WP9：项目 wiki 全链路', () => {
  it('成员 M 入库：job 的执行者是 M、会话是项目 id；维护串行（N 的入库等 M 提交后才进锁）', async () => {
    const attM = await uploadAttachment(
      stack.core,
      project.id,
      'm-doc.md',
      '# M 的资料\n\nMDocKeyword：只属于 M 的入库内容。',
    );
    const attN = await uploadAttachment(
      stack.core,
      project.id,
      'n-doc.md',
      '# N 的资料\n\nNDocKeyword：只属于 N 的入库内容。',
    );

    const enqueue = stack.core.services.wiki!.enqueueIngest({
      owner: projectOwner(project.id),
      botId: memberM,
      conversationId: project.id,
      source: { sourceType: 'attachment', ref: attM, note: 'M 的资料' },
      createdBy: { kind: 'bot', id: memberM },
    });
    expect(enqueue.ok).toBe(true);

    // N 的入库在 M 的维护持有互斥锁期间入队：观测第二个不并发进锁。
    stack.core.services.wiki!.enqueueIngest({
      owner: projectOwner(project.id),
      botId: memberN,
      conversationId: project.id,
      source: { sourceType: 'attachment', ref: attN, note: 'N 的资料' },
      createdBy: { kind: 'bot', id: memberN },
    });

    // M 的维护 loop：index.md 的 write 被挂起（锁保持占用）。
    const heldM = step()
      .expect((req) => JSON.stringify(req.body).includes('MDocKeyword'))
      .replyToolCall('write', {
        path: 'index.md',
        content: '# 目录\n\n- [M 的页面](pages/m-doc.md) — M 的摘要',
      })
      .hold();
    stack.llm.script('mock-main', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('MDocKeyword'))
        .replyToolCall('write', {
          path: 'pages/m-doc.md',
          content: '# M 的页面\n\nMDocKeyword 的内容。',
        }),
      heldM,
      step()
        .expect((req) => JSON.stringify(req.body).includes('MDocKeyword'))
        .replyToolCall('write', {
          path: 'log.md',
          content: '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->\n- 20261017 | 附件 m-doc.md | pages/m-doc.md',
        }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('MDocKeyword'))
        .replyText('M 的入库完成'),
      // N 的维护 loop（串行在 M 之后）：同样三个动作 + 收尾。
      step()
        .expect((req) => JSON.stringify(req.body).includes('NDocKeyword'))
        .replyToolCall('write', {
          path: 'pages/n-doc.md',
          content: '# N 的页面\n\nNDocKeyword 的内容。',
        }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('NDocKeyword'))
        .replyToolCall('write', {
          path: 'log.md',
          content: '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->\n- 20261017 | 附件 n-doc.md | pages/n-doc.md',
        }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('NDocKeyword'))
        .replyText('N 的入库完成'),
    ]);

    // 等到 M 的维护 run 开始（持有锁），随后 N 的 job 被认领但不进锁。
    await waitFor(
      async () => {
        const runs = await maintenanceRuns(stack.core, project.id);
        return runs.some((r) => r.bot_id === memberM && r.status === 'running') ? true : null;
      },
      { label: 'M maintenance running', timeoutMs: 60_000 },
    );
    const nClaimed = await waitFor(
      () => {
        const row = stack.core.services
          .mainDb!.prepare(
            "select status from jobs where type = 'wiki_ingest' and bot_id = ? order by created_at desc limit 1",
          )
          .get(memberN) as { status: string } | undefined;
        return row?.status === 'running' ? true : null;
      },
      { label: 'N ingest claimed', timeoutMs: 60_000 },
    ).catch(() => null);
    // N 的维护 loop 尚未创建（它还在互斥队列里），git 里也没有 N 的提交。
    const runsWhileHeld = await maintenanceRuns(stack.core, project.id);
    expect(runsWhileHeld.some((r) => r.bot_id === memberN)).toBe(false);
    void nClaimed;
    heldM.release();

    await waitJobDone(stack.core, 'wiki_ingest', 2);
    // 两次维护串行：N 的维护 run 在 M 的完成之后创建。
    const runs = await maintenanceRuns(stack.core, project.id);
    expect(runs.map((r) => r.bot_id)).toEqual([memberM, memberN]);
    expect(runs[1]!.created_at).toBeGreaterThanOrEqual(runs[0]!.created_at);
    // job 行：bot_id = 执行者，conversation_id = 项目 id。
    const jobs = stack.core.services
      .mainDb!.prepare("select bot_id, conversation_id from jobs where type = 'wiki_ingest' order by created_at")
      .all() as Array<{ bot_id: string; conversation_id: string }>;
    expect(jobs.map((j) => j.bot_id)).toEqual([memberM, memberN]);
    expect(jobs.every((j) => j.conversation_id === project.id)).toBe(true);
  }, 180_000);

  it('台账：两份来源各有 raw/_assets/ast_….json，createdBy 分别为 M / N；用量记在执行者名下', async () => {
    const files = ledgerFiles(stack.core, project.id);
    expect(files).toHaveLength(2);
    const entries = files.map((name) =>
      JSON.parse(
        readFileSync(path.join(projectWikiRoot(stack.core, project.id), 'raw', '_assets', name), 'utf8'),
      ) as {
        id: string;
        sha256: string;
        createdBy: { kind: string; id?: string };
        sources: Array<{ type: string; ref: string }>;
        storage: string;
        status: string;
      },
    );
    const byCreator = new Map(entries.map((e) => [e.createdBy.id ?? 'user', e]));
    expect(byCreator.get(memberM)!.createdBy).toEqual({ kind: 'bot', id: memberM });
    expect(byCreator.get(memberN)!.createdBy).toEqual({ kind: 'bot', id: memberN });
    for (const entry of entries) {
      expect(entry.id).toBe(assetIdOf(entry.sha256));
      expect(entry.storage).toBe('git');
      expect(entry.status).toBe('maintained');
      expect(entry.sources).toHaveLength(1);
    }
    // sha256 与原件内容对应（M 的资料哈希）。
    const mEntry = byCreator.get(memberM)!;
    const { createHash } = await import('node:crypto');
    const rawDir = path.join(projectWikiRoot(stack.core, project.id), 'raw');
    const rawNames = readdirSync(rawDir).filter((n) => !n.startsWith('_'));
    const rawBytes = rawNames.map((n) => readFileSync(path.join(rawDir, n)));
    expect(rawBytes.map((b) => createHash('sha256').update(b).digest('hex'))).toContain(mEntry.sha256);

    // 执行者付费：维护 run 的 bot_id / conversation_id 是执行者与项目 id；
    // usage_ledger 里 M 的维护用量记在 M 名下、N 的记在 N 名下。
    const usage = stack.core.services
      .mainDb!.prepare(
        "select bot_id, count(*) as n from usage_ledger where loop_type = 'wiki_maintenance' and conversation_id = ? group by bot_id",
      )
      .all(project.id) as Array<{ bot_id: string; n: number }>;
    expect(usage.map((u) => u.bot_id).sort()).toEqual([memberM, memberN].sort());
  }, 60_000);

  it('相同内容由 N 再次提交：不新建条目、不再维护，sources 追加一条，createdBy 仍是 M', async () => {
    const before = ledgerFiles(stack.core, project.id);
    const commitsBefore = await commitCount(stack.core, project.id);
    // N 用一个新附件上传同样的字节（不同 ref）再提交。
    const sameBytes = '# M 的资料\n\nMDocKeyword：只属于 M 的入库内容。';
    const attSame = await uploadAttachment(stack.core, project.id, 'same-doc.md', sameBytes);
    stack.core.services.wiki!.enqueueIngest({
      owner: projectOwner(project.id),
      botId: memberN,
      conversationId: project.id,
      source: { sourceType: 'attachment', ref: attSame, note: 'N 重复提交同一份' },
      createdBy: { kind: 'bot', id: memberN },
    });
    await waitJobDone(stack.core, 'wiki_ingest', 3);

    expect(ledgerFiles(stack.core, project.id)).toEqual(before);
    const mFile = before.find((name) => {
      const entry = JSON.parse(
        readFileSync(path.join(projectWikiRoot(stack.core, project.id), 'raw', '_assets', name), 'utf8'),
      ) as { createdBy: { id?: string } };
      return entry.createdBy.id === memberM;
    })!;
    const entry = JSON.parse(
      readFileSync(path.join(projectWikiRoot(stack.core, project.id), 'raw', '_assets', mFile), 'utf8'),
    ) as { createdBy: { id?: string }; sources: Array<{ ref: string }> };
    expect(entry.createdBy).toEqual({ kind: 'bot', id: memberM });
    expect(entry.sources).toHaveLength(2);
    expect(entry.sources.map((s) => s.ref)).toContain(attSame);
    // 跳过再维护：没有新提交（只有重复来源台账登记的那次小提交）。
    expect(await commitCount(stack.core, project.id)).toBe(commitsBefore + 1);
    expect((await maintenanceRuns(stack.core, project.id)).length).toBe(2);
  }, 90_000);

  it('索引：项目页面进 projects/{id}/wiki.db，成员的 memory.db 都没有；RPC 检索命中', async () => {
    expect(
      existsSync(path.join(stack.core.services.paths.home, 'projects', project.id, 'wiki.db')),
    ).toBe(true);
    for (const botId of [lead, memberM, memberN]) {
      expect(stack.core.services.memory!.storeFor(botId).wikiPagePaths()).toEqual([]);
    }
    const search = (await stack.core.rpc.call('wiki.search', {
      owner: projectOwner(project.id),
      query: 'MDocKeyword',
    })) as { hits: Array<{ path: string }> };
    expect(search.hits.map((h) => h.path)).toContain('pages/m-doc.md');
  }, 30_000);

  it('用户来源与定期体检都以负责人身份运行（执行者 = L）', async () => {
    const attUser = await uploadAttachment(
      stack.core,
      project.id,
      'user-doc.md',
      '# 用户资料\n\nUserDocKeyword：用户交给项目组的内容。',
    );
    stack.core.services.wiki!.enqueueIngest({
      owner: projectOwner(project.id),
      botId: lead,
      conversationId: project.id,
      source: { sourceType: 'attachment', ref: attUser, note: '用户的资料' },
      createdBy: { kind: 'user' },
    });
    stack.llm.script('mock-main', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('UserDocKeyword'))
        .replyToolCall('write', {
          path: 'pages/user-doc.md',
          content: '# 用户资料的页面\n\nUserDocKeyword 已整理。',
        }),
      step().replyToolCall('write', {
        path: 'log.md',
        content:
          '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->\n- 20261017 | 附件 user-doc.md | pages/user-doc.md',
      }),
      step().replyText('用户资料入库完成'),
    ]);
    await waitJobDone(stack.core, 'wiki_ingest', 4);
    const userJob = stack.core.services
      .mainDb!.prepare(
        "select bot_id from jobs where type = 'wiki_ingest' order by created_at desc limit 1",
      )
      .get() as { bot_id: string };
    expect(userJob.bot_id).toBe(lead);
    // 台账：createdBy 是用户。
    const userEntry = ledgerFiles(stack.core, project.id)
      .map((name) =>
        JSON.parse(
          readFileSync(path.join(projectWikiRoot(stack.core, project.id), 'raw', '_assets', name), 'utf8'),
        ) as { createdBy: { kind: string }; sources: Array<{ ref: string }> },
      )
      .find((entry) => entry.createdBy.kind === 'user');
    expect(userEntry).toBeDefined();
    expect(userEntry!.sources.map((s) => s.ref)).toContain(attUser);

    // 定期体检：项目 wiki 刚建（最老提交不足一周）不会到点——把上次体检
    // 回拨到八天前（done 行参与 lastDoneAtFor 基线），使本周体检到点。
    const eightDaysAgo = stack.core.services.clock.now() - 8 * 24 * 60 * 60 * 1000;
    stack.core.services
      .mainDb!.prepare(
        "insert into jobs (id, type, bot_id, conversation_id, payload_json, priority, status, attempts, run_after, dedupe_key, created_at, updated_at) values ('job_backdate_lint', 'wiki_lint', ?, ?, ?, 2, 'done', 1, 0, NULL, ?, ?)",
      )
      .run(
        lead,
        project.id,
        JSON.stringify({ owner: projectOwner(project.id), trigger: 'weekly' }),
        eightDaysAgo,
        eightDaysAgo,
      );
    const scheduled = await stack.core.services.wiki!.enqueueDueLints();
    expect(scheduled).toBeGreaterThanOrEqual(1);
    const lintJob = stack.core.services
      .mainDb!.prepare(
        "select bot_id, conversation_id, dedupe_key, payload_json from jobs where type = 'wiki_lint' and dedupe_key = ?",
      )
      .get(`wiki_lint:project:${project.id}:weekly`) as {
      bot_id: string;
      conversation_id: string;
      dedupe_key: string;
      payload_json: string;
    };
    expect(lintJob.bot_id).toBe(lead);
    expect(lintJob.conversation_id).toBe(project.id);
    expect(JSON.parse(lintJob.payload_json)).toMatchObject({
      owner: projectOwner(project.id),
      trigger: 'weekly',
    });
    // 体检跑完（lint 模式的维护 loop），页面体检提示词带项目检查。
    stack.llm.script('mock-main', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('对项目组共享的 Wiki 做一次体检'))
        .replyText('项目 wiki 体检完成'),
    ]);
    await waitJobDone(stack.core, 'wiki_lint', 1);
  }, 120_000);

  it('listSources / sourceCount：台账按 createdAt 倒序，计数与条目一致', async () => {
    const sources = stack.core.services.wiki!.listSources(projectOwner(project.id));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    const sorted = [...sources].sort((a, b) => b.createdAt - a.createdAt);
    expect(sources.map((s) => s.id)).toEqual(sorted.map((s) => s.id));
    expect(stack.core.services.wiki!.sourceCount(projectOwner(project.id))).toBe(sources.length);
    // Bot owner 没有台账。
    expect(stack.core.services.wiki!.listSources(botOwner(memberM))).toEqual([]);
    expect(stack.core.services.wiki!.sourceCount(botOwner(memberM))).toBe(0);
  }, 30_000);
});

describe('D92 T1b WP9：Bot 个人 wiki 隔离与未初始化读路径', () => {
  it('M 的个人 wiki 入库、检索照旧；存储与索引与项目 wiki 完全隔离', async () => {
    const directM = (
      (await stack.core.rpc.call('conversations.openDirect', { botId: memberM })) as {
        conversation: Conversation;
      }
    ).conversation.id;
    const attPrivate = await uploadAttachment(
      stack.core,
      directM,
      'private.md',
      '# 私有资料\n\nPrivateDocKeyword：M 自己的知识库内容。',
    );
    stack.core.services.wiki!.enqueueIngest({
      owner: botOwner(memberM),
      botId: memberM,
      conversationId: directM,
      source: { sourceType: 'attachment', ref: attPrivate, note: '私有资料' },
      createdBy: { kind: 'bot', id: memberM },
    });
    stack.llm.script('mock-main', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('整理进你的 Wiki'))
        .replyToolCall('write', {
          path: 'pages/private.md',
          content: '# 私有页面\n\nPrivateDocKeyword 已整理。',
        }),
      step().replyToolCall('write', {
        path: 'log.md',
        content:
          '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->\n- 20261017 | 附件 private.md | pages/private.md',
      }),
      step().replyText('私有资料入库完成'),
    ]);
    await waitJobDone(stack.core, 'wiki_ingest', 5);

    // 存储隔离：目录与索引库不同。
    const botWiki = path.join(stack.core.services.paths.home, 'bots', memberM, 'wiki');
    expect(existsSync(path.join(botWiki, 'pages/private.md'))).toBe(true);
    expect(
      existsSync(path.join(projectWikiRoot(stack.core, project.id), 'pages/private.md')),
    ).toBe(false);
    // 项目 wiki 的页面不在 M 的 memory.db（那里只有 M 自己的私有页面）；
    // 私有页面不在项目的 wiki.db。
    expect(stack.core.services.memory!.storeFor(memberM).wikiPagePaths()).toEqual([
      'pages/private.md',
    ]);
    const projectSearch = (await stack.core.rpc.call('wiki.search', {
      owner: projectOwner(project.id),
      query: 'PrivateDocKeyword',
    })) as { hits: unknown[] };
    expect(projectSearch.hits).toHaveLength(0);
    const botSearch = (await stack.core.rpc.call('wiki.search', {
      owner: botOwner(memberM),
      query: 'PrivateDocKeyword',
    })) as { hits: Array<{ path: string }> };
    expect(botSearch.hits.map((h) => h.path)).toEqual(['pages/private.md']);
  }, 120_000);

  it('项目 wiki 未初始化时读路径安全返回空（tree / search / sourceCount）', async () => {
    const fresh = await makeProject(stack.core, '空项目', [lead, memberM], { leadBotId: lead });
    expect(
      ((await stack.core.rpc.call('wiki.tree', { owner: projectOwner(fresh.id) })) as { pages: unknown[] })
        .pages,
    ).toEqual([]);
    expect(
      ((await stack.core.rpc.call('wiki.search', {
        owner: projectOwner(fresh.id),
        query: ' anything ',
      })) as { hits: unknown[] }).hits,
    ).toEqual([]);
    expect(stack.core.services.wiki!.sourceCount(projectOwner(fresh.id))).toBe(0);
    // 读路径不创建 wiki 目录 / 索引库。
    expect(existsSync(projectWikiRoot(stack.core, fresh.id))).toBe(false);
    expect(
      existsSync(path.join(stack.core.services.paths.home, 'projects', fresh.id, 'wiki.db')),
    ).toBe(false);
  }, 60_000);
});

describe('D92 T1b WP9：项目 wiki 启动 FTS 对账', () => {
  it('磁盘页面与项目索引库不一致时，重启后对账重建', async () => {
    const keystore = createMemoryKeystore();
    const home = mkdtempSync(path.join(tmpdir(), 'wiki-project-reconcile-'));
    const first = await createTestStack({ home, keystore });
    try {
      const l = (await makeBot(first.core, '阿领')).id;
      const m = (await makeBot(first.core, '阿M')).id;
      const proj = await makeProject(first.core, '对账项目', [l, m], { leadBotId: l });
      const att = await uploadAttachment(
        first.core,
        proj.id,
        'reconcile.md',
        '# 对账资料\n\nReconcileDocKeyword：对账内容。',
      );
      first.core.services.wiki!.enqueueIngest({
        owner: projectOwner(proj.id),
        botId: m,
        conversationId: proj.id,
        source: { sourceType: 'attachment', ref: att, note: '对账资料' },
        createdBy: { kind: 'bot', id: m },
      });
      first.llm.script('mock-main', [
        step()
          .expect((req) => JSON.stringify(req.body).includes('ReconcileDocKeyword'))
          .replyToolCall('write', {
            path: 'pages/reconcile.md',
            content: '# 对账页面\n\nReconcileDocKeyword 的内容。',
          }),
        step().replyText('对账资料入库完成'),
      ]);
      await waitJobDone(first.core, 'wiki_ingest', 1);
      // 模拟提交与 FTS 更新之间中断：清空项目索引库的行。
      first.core.services.wikiIndexes!.forProject(proj.id).wikiClearPages();
      await first.cleanup();

      // 重启：启动对账发现磁盘 pages 与项目索引库不符，全量重建。
      const second = await createTestStack({ home, keystore });
      try {
        const search = (await second.core.rpc.call('wiki.search', {
          owner: projectOwner(proj.id),
          query: 'ReconcileDocKeyword',
        })) as { hits: Array<{ path: string }> };
        expect(search.hits.map((h) => h.path)).toEqual(['pages/reconcile.md']);
      } finally {
        await second.cleanup();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 150_000);
});
