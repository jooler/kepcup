import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  makeProject,
  sendDrafts,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 回归（D92 T1b WP10 的收口修正）：项目组对话里 Bot 调 `wiki_enqueue` 不传
 * `scope` 时，资料沉淀到**共享的项目 wiki**，而不是散落到各 Bot 的个人 wiki
 * （群聊里的沉淀留在项目 wiki）。单聊里不传 scope 仍写自己的 wiki。
 *
 * 走完整 core + mock LLM：真实对话轮里工具调用 → 入库 job → 后台维护 loop →
 * 项目 wiki 的页面与台账；断言个人 wiki 全程没被写入。
 */

let stack: TestStack;
let lead: string;
let member: string;
let projectId: string;
let attachmentId: string;

const KEYWORD = 'ProjectScopeKeyword';

beforeAll(async () => {
  stack = await createTestStack();
  lead = (await makeBot(stack.core, '阿领')).id;
  member = (await makeBot(stack.core, '阿甲')).id;
  const project = await makeProject(stack.core, '项目组', [lead, member], { leadBotId: lead });
  projectId = project.id;
  const upload = (await stack.core.rpc.call('attachments.upload', {
    conversationId: projectId,
    fileName: 'shared.md',
    mime: 'text/markdown',
    bytesBase64: Buffer.from(`# 项目资料\n\n${KEYWORD}：项目组里的沉淀。`, 'utf8').toString(
      'base64',
    ),
  })) as { attachment: { id: string } };
  attachmentId = upload.attachment.id;
});

afterAll(async () => {
  await stack.cleanup();
});

function wikiRoot(botId: string): string {
  return path.join(stack.core.services.paths.home, 'bots', botId, 'wiki');
}

/** 反思的空输出（没有记忆 / 画像 / wiki 建议）。 */
function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

function projectWikiRoot(): string {
  return path.join(stack.core.services.paths.home, 'projects', projectId, 'wiki');
}

/** All `wiki_ingest` jobs (oldest first) with their owner / submitter payload. */
function ingestJobs(): Array<{
  bot_id: string;
  conversation_id: string;
  payload_json: string;
}> {
  return stack.core.services
    .mainDb!.prepare(
      "select bot_id, conversation_id, payload_json from jobs where type = 'wiki_ingest' order by created_at",
    )
    .all() as Array<{ bot_id: string; conversation_id: string; payload_json: string }>;
}

async function waitJobDone(type: string, count: number): Promise<void> {
  await waitFor(
    () => {
      const rows = stack.core.services
        .mainDb!.prepare('select status from jobs where type = ? order by created_at')
        .all(type) as Array<{ status: string }>;
      return rows.length >= count && rows.every((row) => row.status === 'done') ? true : null;
    },
    { label: `${count} ${type} job(s) done`, timeoutMs: 90_000 },
  );
}

describe('项目组里的 wiki 默认归属（D92 T1b WP10 收口）', () => {
  it('成员在项目组里 wiki_enqueue 不传 scope：入库落在项目 wiki，个人 wiki 全程没被写', async () => {
    // 该轮的反思（空反思，避免反思 job 悬着）。
    stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
    stack.llm.script('mock-main', [
      // ① 成员的一轮：把资料沉淀进 wiki（不传 scope）。
      step()
        .expect((req) => String(req.lastUserText()).includes('沉淀到项目 wiki'))
        .inTurn()
        .replyToolCall('wiki_enqueue', {
          source_type: 'attachment',
          ref: attachmentId,
          note: '项目组的资料',
        }),
      // ② 工具结果回来后的收尾。
      step()
        .expect((req) => String(req.lastUserText()).includes('已登记入库任务'))
        .inTurn()
        .replyText('已登记入库。'),
      // ③ 后台维护 loop：读资料 → 写页面 → 记日志 → 收尾。
      step()
        .expect((req) => String(req.lastUserText()).includes(KEYWORD))
        .replyToolCall('write', {
          path: 'pages/shared.md',
          content: `# 项目资料页\n\n${KEYWORD} 已整理。`,
        }),
      step()
        .expect((req) => String(req.lastUserText()).includes(KEYWORD))
        .replyToolCall('write', {
          path: 'log.md',
          content:
            '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->\n- 20261021 | 附件 shared.md | pages/shared.md',
        }),
      step()
        .expect((req) => String(req.lastUserText()).includes(KEYWORD))
        .replyText('项目资料入库完成'),
    ]);

    await sendDrafts(stack.core, projectId, [
      { text: '把这份资料沉淀到项目 wiki', mentions: [member] },
    ]);

    // 入库 job 的 owner 是项目（不是成员的个人 wiki）。
    await waitFor(
      () => {
        const rows = stack.core.services
          .mainDb!.prepare(
            "select bot_id, conversation_id, payload_json from jobs where type = 'wiki_ingest'",
          )
          .all() as Array<{ bot_id: string; conversation_id: string; payload_json: string }>;
        return rows.length > 0 ? rows : null;
      },
      { label: 'wiki_ingest job enqueued', timeoutMs: 30_000 },
    );
    const jobs = stack.core.services
      .mainDb!.prepare(
        "select bot_id, conversation_id, payload_json from jobs where type = 'wiki_ingest'",
      )
      .all() as Array<{ bot_id: string; conversation_id: string; payload_json: string }>;
    expect(jobs).toHaveLength(1);
    // 执行者是成员（executor-pays），会话是项目 id，owner 是项目 wiki。
    expect(jobs[0]!.bot_id).toBe(member);
    expect(jobs[0]!.conversation_id).toBe(projectId);
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({
      owner: { kind: 'project', id: projectId },
      sourceType: 'attachment',
      createdBy: { kind: 'bot', id: member },
    });

    // 维护 loop 跑完：页面与台账都在项目 wiki 里。
    await waitJobDone('wiki_ingest', 1);
    expect(existsSync(path.join(projectWikiRoot(), 'pages', 'shared.md'))).toBe(true);
    const ledger = readdirSync(path.join(projectWikiRoot(), 'raw', '_assets')).filter((name) =>
      name.endsWith('.json'),
    );
    expect(ledger).toHaveLength(1);
    const entry = JSON.parse(
      readFileSync(path.join(projectWikiRoot(), 'raw', '_assets', ledger[0]!), 'utf8'),
    ) as { createdBy: { kind: string; id?: string } };
    expect(entry.createdBy).toEqual({ kind: 'bot', id: member });

    // 成员的个人 wiki 里什么都没有（没有页面、没有台账、索引库为空）。
    expect(existsSync(path.join(wikiRoot(member), 'pages'))).toBe(false);
    expect(existsSync(path.join(wikiRoot(member), 'raw', '_assets'))).toBe(false);
    expect(stack.core.services.memory!.storeFor(member).wikiPagePaths()).toEqual([]);
    expect(stack.core.services.wiki!.listSources({ kind: 'bot', id: member })).toEqual([]);
  }, 180_000);

  it('单聊里 wiki_enqueue 不传 scope：仍写自己的 wiki（默认行为不被项目组改动波及）', async () => {
    const direct = (
      (await stack.core.rpc.call('conversations.openDirect', { botId: member })) as {
        conversation: { id: string };
      }
    ).conversation.id;
    const upload = (await stack.core.rpc.call('attachments.upload', {
      conversationId: direct,
      fileName: 'private.md',
      mime: 'text/markdown',
      bytesBase64: Buffer.from(`# 私有资料\n\n${KEYWORD}：我自己的知识库。`, 'utf8').toString(
        'base64',
      ),
    })) as { attachment: { id: string } };

    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('学一下这份资料'))
        .inTurn()
        .replyToolCall('wiki_enqueue', {
          source_type: 'attachment',
          ref: upload.attachment.id,
          note: '私有资料',
        }),
      step()
        .expect((req) => String(req.lastUserText()).includes('已登记入库任务'))
        .inTurn()
        .replyText('已登记入库。'),
    ]);

    await stack.core.rpc.call('messages.send', {
      conversationId: direct,
      text: '学一下这份资料',
    });

    await waitFor(
      () => {
        const rows = stack.core.services
          .mainDb!.prepare(
            "select bot_id, payload_json from jobs where type = 'wiki_ingest' order by created_at",
          )
          .all() as Array<{ bot_id: string; payload_json: string }>;
        const mine = rows.filter((row) => JSON.parse(row.payload_json).owner?.kind === 'bot');
        return mine.length > 0 ? mine : null;
      },
      { label: 'wiki_ingest job for the bot owner', timeoutMs: 30_000 },
    );
    const mine = (
      stack.core.services
        .mainDb!.prepare(
          "select bot_id, payload_json from jobs where type = 'wiki_ingest' order by created_at",
        )
        .all() as Array<{ bot_id: string; payload_json: string }>
    ).filter((row) => JSON.parse(row.payload_json).owner?.kind === 'bot');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.bot_id).toBe(member);
    expect(JSON.parse(mine[0]!.payload_json)).toMatchObject({
      owner: { kind: 'bot', id: member },
    });
  }, 120_000);

  it('项目组里的反思建议（wiki_suggestion）同样落进项目 wiki，不进成员的个人 wiki', async () => {
    const before = (
      stack.core.services
        .mainDb!.prepare("select count(*) as n from jobs where type = 'wiki_ingest'")
        .get() as { n: number }
    ).n;
    // 成员的一轮（正文）+ 该轮的反思（带一条 wiki 建议）。
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('这份接口文档'))
        .inTurn()
        .replyText('好的，我记下了。'),
    ]);
    stack.llm.script('mock-light', [
      step().replyJson({
        runSummary: '用户提到一份接口文档',
        memories: [],
        profileProposals: [],
        wikiSuggestions: [
          { sourceType: 'url', ref: 'https://example.com/api-doc', note: '接口文档值得入库' },
        ],
        skillSuggestion: null,
      }),
    ]);

    await sendDrafts(stack.core, projectId, [
      { text: '这份接口文档放项目 wiki 里', mentions: [member] },
    ]);

    await waitFor(
      () => {
        const rows = ingestJobs();
        const fresh = rows.slice(before);
        return fresh.some((row) => JSON.parse(row.payload_json).owner?.kind === 'project')
          ? fresh
          : null;
      },
      { label: 'wiki_ingest job for the project owner', timeoutMs: 60_000 },
    );
    const fresh = ingestJobs().slice(before);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    const suggestion = fresh.find((row) => JSON.parse(row.payload_json).owner?.kind === 'project')!;
    // 反思建议的来源也落在项目 wiki（执行者仍是提出建议的成员）。
    expect(suggestion.bot_id).toBe(member);
    expect(suggestion.conversation_id).toBe(projectId);
    expect(JSON.parse(suggestion.payload_json)).toMatchObject({
      owner: { kind: 'project', id: projectId },
      sourceType: 'url',
      createdBy: { kind: 'bot', id: member },
    });
    // 个人 wiki 里没有这条建议。
    expect(stack.core.services.wiki!.listSources({ kind: 'bot', id: member })).toEqual([]);
  }, 120_000);
});
