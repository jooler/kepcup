import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  makeProject,
  sendDrafts,
  step,
  waitFor,
  waitForRun,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * A card chat uses its parent project's wiki, memory origin, reflection
 * owner, and workdir. The same bot's direct chat does not.
 */

let stack: TestStack;
let leadId: string;
let memberId: string;
let outsiderId: string;
let projectId: string;
let cardId: string;
let directId: string;
let todoId: string;
const TOPIC = '卡片作用域主题';

beforeAll(async () => {
  stack = await createTestStack({ env: { KEPCUP_REFLECTION_DEBOUNCE_MS: '0' } });
  leadId = (await makeBot(stack.core, 'Lead')).id;
  memberId = (await makeBot(stack.core, 'Member')).id;
  outsiderId = (await makeBot(stack.core, 'Outsider')).id;
  projectId = (await makeProject(stack.core, 'Scope project', [leadId, memberId], { leadBotId: leadId }))
    .id;
  const columnId = stack.core.services.board!.get(projectId, ['Todo'], 'user').columns[0]!.id;
  const card = stack.core.services.board!.createCard(projectId, columnId, 'Scope the card', undefined, 'user');
  todoId = card.id;
  cardId = stack.core.services.domain!.conversations.ensureCardConversation({
    projectId,
    todoId: card.id,
    botId: memberId,
    title: 'Scope the card',
  }).conversation.id;
  directId = (
    (await stack.core.rpc.call('conversations.openDirect', { botId: memberId })) as {
      conversation: { id: string };
    }
  ).conversation.id;

  const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-card-scope-'));
  await stack.core.rpc.call('workdirs.select', { conversationId: projectId, path: dir });
  const indexDir = path.join(stack.core.services.paths.home, 'projects', projectId, 'wiki');
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(path.join(indexDir, 'index.md'), `- [${TOPIC}](pages/scope.md) 卡片对话要看到的主题\n`, 'utf8');
}, 60_000);

afterAll(() => stack.cleanup());

function systemText(request: MockChatRequest): string {
  const first = request.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
}

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

function ingestJobs(): Array<{ bot_id: string; conversation_id: string | null; payload_json: string }> {
  return stack.core.services.mainDb!.prepare(
    "select bot_id, conversation_id, payload_json from jobs where type = 'wiki_ingest' order by created_at",
  ).all() as Array<{ bot_id: string; conversation_id: string | null; payload_json: string }>;
}

describe('card project scope', () => {
  it('resolves the workdir through the parent project and leaves the direct chat alone', () => {
    const project = stack.core.services.workdirRuntime!.boundWorkdir(projectId);
    const card = stack.core.services.workdirRuntime!.boundWorkdir(cardId);
    expect(project).not.toBeNull();
    expect(card?.id).toBe(project!.id);
    expect(card?.path).toBe(project!.path);
    expect(stack.core.services.workdirRuntime!.boundWorkdir(directId)).toBeNull();
  });

  it('writes memory with project origin in the card chat and private origin in the direct chat', async () => {
    const cardMessage = stack.core.services.domain!.messages.append({
      conversationId: cardId,
      senderType: 'user',
      kind: 'text',
      text: '记住：卡片里的事实',
    });
    const directMessage = stack.core.services.domain!.messages.append({
      conversationId: directId,
      senderType: 'user',
      kind: 'text',
      text: '记住：单聊里的事实',
    });
    const fromCard = await stack.core.services.memory!.writeMemory(memberId, cardId, {
      content: '卡片里的事实要进项目口径',
      kind: 'fact',
      triggerMessages: [cardMessage],
    });
    const fromDirect = await stack.core.services.memory!.writeMemory(memberId, directId, {
      content: '单聊里的事实保持私有',
      kind: 'fact',
      triggerMessages: [directMessage],
    });
    expect(fromCard.ok).toBe(true);
    expect(fromCard.item?.origin).toBe('project');
    expect(fromDirect.ok).toBe(true);
    expect(fromDirect.item?.origin).toBe('private');
  });

  it('labels an in-flight card run as a card chat and a direct run as a direct chat', () => {
    const runs = stack.core.services.domain!.runs;
    const cardRun = runs.create({
      botId: memberId,
      conversationId: cardId,
      loopType: 'turn',
      triggerReason: 'direct',
      triggerMessageIds: [],
    });
    runs.update(cardRun.id, { status: 'running' });
    const fromDirect = stack.core.services.memory!.myStateSection(memberId, directId);
    expect(fromDirect).toContain('项目组卡片对话');
    runs.update(cardRun.id, { status: 'completed' });

    const directRun = runs.create({
      botId: memberId,
      conversationId: directId,
      loopType: 'turn',
      triggerReason: 'direct',
      triggerMessageIds: [],
    });
    runs.update(directRun.id, { status: 'running' });
    const fromCard = stack.core.services.memory!.myStateSection(memberId, cardId);
    expect(fromCard).toContain('与用户的单聊');
    expect(fromCard).not.toContain('项目组卡片对话');
    runs.update(directRun.id, { status: 'completed' });
  });

  it('injects the project wiki topics and enqueues wiki_enqueue into the project wiki', async () => {
    const before = ingestJobs().length;
    stack.llm.script('mock-main', [
      step()
        .expect((req) => {
          const system = systemText(req);
          return system.includes('<project_wiki_topics>') && system.includes(TOPIC);
        })
        .inTurn()
        .replyToolCall('wiki_enqueue', {
          source_type: 'url',
          ref: 'https://example.com/card-scope',
          note: '卡片对话的默认入库',
        }),
      step().inTurn().replyText('已登记。'),
    ]);
    stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
    await sendDrafts(stack.core, cardId, [{ text: '把这份资料放进项目 wiki' }]);
    await waitFor(
      () => {
        const fresh = ingestJobs().slice(before);
        return fresh.some((row) => {
          const payload = JSON.parse(row.payload_json) as { owner?: { kind?: string; id?: string } };
          return payload.owner?.kind === 'project' && payload.owner.id === projectId;
        })
          ? fresh
          : null;
      },
      { label: 'project wiki ingest from the card chat', timeoutMs: 40_000 },
    );
  }, 60_000);

  it('keeps the direct chat on the bot wiki and out of the project topic section', async () => {
    const before = ingestJobs().length;
    stack.llm.script('mock-main', [
      step()
        .expect((req) => !systemText(req).includes('<project_wiki_topics>'))
        .inTurn()
        .replyToolCall('wiki_enqueue', {
          source_type: 'url',
          ref: 'https://example.com/direct-scope',
          note: '单聊默认入库',
        }),
      step().inTurn().replyText('已登记。'),
    ]);
    stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
    await sendDrafts(stack.core, directId, [{ text: '把这份资料放进我自己的 wiki' }]);
    const fresh = await waitFor(
      () => {
        const rows = ingestJobs().slice(before);
        return rows.length > 0 ? rows : null;
      },
      { label: 'bot wiki ingest from the direct chat', timeoutMs: 40_000 },
    );
    expect(JSON.parse(fresh[0]!.payload_json)).toMatchObject({
      owner: { kind: 'bot', id: memberId },
    });
  }, 60_000);

  it('files a reflection wiki suggestion on the project wiki', async () => {
    const before = ingestJobs().length;
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('接口说明'))
        .inTurn()
        .replyText('好的。'),
    ]);
    stack.llm.script('mock-light', [
      step().replyJson({
        runSummary: '用户提到接口说明',
        memories: [],
        profileProposals: [],
        wikiSuggestions: [
          { sourceType: 'url', ref: 'https://example.com/card-api', note: '卡片对话的建议' },
        ],
        skillSuggestion: null,
      }),
    ]);
    await sendDrafts(stack.core, cardId, [{ text: '接口说明值得沉淀' }]);
    await waitFor(
      () => {
        const fresh = ingestJobs().slice(before);
        return fresh.some((row) => {
          const payload = JSON.parse(row.payload_json) as {
            owner?: { kind?: string; id?: string };
            ref?: string;
          };
          return (
            payload.owner?.kind === 'project' &&
            payload.owner.id === projectId &&
            payload.ref === 'https://example.com/card-api'
          );
        })
          ? fresh
          : null;
      },
      { label: 'reflection suggestion on the project wiki', timeoutMs: 40_000 },
    );
    expect(stack.core.services.wiki!.listSources({ kind: 'bot', id: memberId })).toEqual([]);
  }, 60_000);

  it('refuses project wiki writes from a card chat whose bot is not a member', async () => {
    const outsiderCardId = stack.core.services.domain!.conversations.ensureCardConversation({
      projectId,
      todoId,
      botId: outsiderId,
      title: 'Scope the card',
    }).conversation.id;
    const before = ingestJobs().length;
    // 上一条用例的收尾请求如果落在 script() 之后，会吃掉没有 expect 的第一步，
    // 本轮就只剩文本回复，断言里找不到 wiki_enqueue 的 tool_result。两步都钉住
    // 这条用户消息，迟到请求对不上就不会消费队列。
    const outsiderTurn = (req: MockChatRequest) => req.lastUserText().includes('也帮我入库');
    stack.llm.script('mock-main', [
      step()
        .expect(outsiderTurn)
        .inTurn()
        .replyToolCall('wiki_enqueue', {
          source_type: 'url',
          ref: 'https://example.com/outsider',
          note: '非成员',
        }),
      step().expect(outsiderTurn).inTurn().replyText('做不到。'),
    ]);
    stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
    await sendDrafts(stack.core, outsiderCardId, [{ text: '也帮我入库' }]);
    const run = await waitForRun(stack.core, outsiderCardId, 'completed');
    const steps = (
      (await stack.core.rpc.call('runs.steps', { runId: run.id })) as {
        steps: Array<{ type: string; payload: Record<string, unknown> }>;
      }
    ).steps;
    const result = steps.find(
      (entry) => entry.type === 'tool_result' && entry.payload['toolName'] === 'wiki_enqueue',
    );
    expect(JSON.stringify(result?.payload ?? {})).toContain('你不是该项目组的成员');
    expect(ingestJobs().length).toBe(before);
  }, 60_000);
});

