import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DELEGATION_RESULT_MAX_CHARS, type Message, type Run } from '@kepcup/shared';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { systemClock } from '../../src/infra/clock.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { DelegationsService } from '../../src/domain/delegations.js';
import { JobsService } from '../../src/domain/jobs.js';
import { DelegationHost, truncateDelegationResult } from '../../src/dispatch/delegation.js';
import type { RunIdentity } from '../../src/agent/types.js';
import type { RunsService } from '../../src/domain/runs.js';
import type { CoreLogger } from '../../src/infra/logger.js';
import { reflectionInput } from '../../src/memory/reflection.js';

/**
 * DelegationHost（D71）的拒绝清单 / 单跳 / 群降级 / 截断：真实 main.db +
 * 真实 domain 服务，mailbox 与 run 层以桩替代（投递返回固定 run id）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'delegation-host-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let rigCount = 0;

function makeRig() {
  const home = path.join(dir, `home-${rigCount++}`);
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const clock = systemClock;
  const bots = new BotsService(db, clock);
  const conversations = new ConversationsService(db, clock);
  const messages = new MessagesService(db, clock);
  const delegations = new DelegationsService(db, clock);
  const jobs = new JobsService(db, clock);
  const events: Array<{ event: string; payload: unknown }> = [];
  const delivered: Array<{ botId: string; message: Message }> = [];
  let runCounter = 0;
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
  const hostDeps = {
    delegations,
    bots,
    conversations,
    messages,
    runs: { get: () => null } as unknown as RunsService,
    jobs,
    db,
    clock,
    timeZone: 'UTC',
    logger: logger as unknown as CoreLogger,
    publish: (event, payload) => events.push({ event, payload }),
    isMailboxIdle: () => true,
    deliverToBot: (input) => {
      delivered.push({ botId: input.botId, message: input.message });
      runCounter += 1;
      return `run_b${runCounter}`;
    },
    cancelRun: () => {},
    deliverEvent: () => {},
  };
  const host = new DelegationHost(hostDeps);
  const a = bots.create({ identity: { name: '甲' } });
  const b = bots.create({ identity: { name: '乙' } });
  const aConv = conversations.openDirect(a.id).conversation.id;
  const identity = (runId: string, botId = a.id, conversationId = aConv): RunIdentity => ({
    runId,
    botId,
    conversationId,
    loopType: 'response',
  });
  return {
    db,
    bots,
    conversations,
    messages,
    delegations,
    host,
    hostDeps,
    a,
    b,
    aConv,
    identity,
    delivered,
  };
}

describe('DelegationHost (D71)', () => {
  it('投递：代发 user 消息带 origin / delegationId / delegatedBy，委派转 working 并记 run_id', () => {
    const rig = makeRig();
    const result = rig.host.delegate(rig.identity('run_a1'), { botId: rig.b.id, task: '帮我查一下' });
    expect(result.ok).toBe(true);
    const [row] = rig.delegations.listActive();
    expect(row).toMatchObject({ status: 'working', runId: 'run_b1', depth: 1, fromRunId: 'run_a1' });
    expect(rig.delivered).toHaveLength(1);
    expect(rig.delivered[0]!.message.senderType).toBe('user');
    expect(rig.delivered[0]!.message.content).toMatchObject({
      origin: 'delegation',
      delegationId: row!.id,
      delegatedBy: rig.a.id,
    });
    // A 侧发出卡已落。
    const aMessages = rig.messages.list(rig.aConv);
    expect(aMessages.some((m) => m.kind === 'card' && m.id === row!.sentMessageId)).toBe(true);
  });

  it('单跳：被委派 run 内再委派被拒（按 run_id 反查，与工具是否注册无关）', () => {
    const rig = makeRig();
    rig.host.delegate(rig.identity('run_a1'), { botId: rig.b.id, task: '任务一' });
    const c = rig.bots.create({ identity: { name: '丙' } });
    const bConv = rig.conversations.openDirect(rig.b.id).conversation.id;
    // B 在被委派的 run（run_b1）里试图再委派：拒绝，包括委派回 A。
    const again = rig.host.delegate(rig.identity('run_b1', rig.b.id, bConv), {
      botId: c.id,
      task: '再转一手',
    });
    expect(again.ok).toBe(false);
    expect(again.message).toContain('不能再委派');
    const back = rig.host.delegate(rig.identity('run_b1', rig.b.id, bConv), {
      botId: rig.a.id,
      task: '转回去',
    });
    expect(back.ok).toBe(false);
    // B 在自己别的 run 里仍可以委派（不是按 Bot 粒度摘除）。
    const own = rig.host.delegate(rig.identity('run_b_other', rig.b.id, bConv), {
      botId: c.id,
      task: '我自己的事',
    });
    expect(own.ok).toBe(true);
  });

  it('拒绝清单：自己 / 不存在 / 管家 / 访谈中 / 重复 / 空任务', () => {
    const rig = makeRig();
    const id = rig.identity('run_a1');
    expect(rig.host.delegate(id, { botId: rig.a.id, task: 'x' }).ok).toBe(false);
    expect(rig.host.delegate(id, { botId: 'bot_nope', task: 'x' }).ok).toBe(false);
    expect(rig.host.delegate(id, { botId: rig.b.id, task: '   ' }).ok).toBe(false);
    const butler = rig.bots.create({ identity: { name: '管家' } }, { systemRole: 'butler' });
    expect(rig.host.delegate(id, { botId: butler.id, task: 'x' }).message).toContain('管家');
    const fresh = rig.bots.create({ identity: { name: '' } }, { interview: true });
    expect(rig.host.delegate(id, { botId: fresh.id, task: 'x' }).message).toContain('访谈');
    expect(rig.host.delegate(id, { botId: rig.b.id, task: '第一件' }).ok).toBe(true);
    const dup = rig.host.delegate(rig.identity('run_a2'), { botId: rig.b.id, task: '第二件' });
    expect(dup.ok).toBe(false);
    expect(dup.message).toContain('不要重复委派');
    expect(rig.delegations.listActive()).toHaveLength(1);
  });

  it('群聊：B 在群里 → 指引改 @；B 不在群里 → 拒绝；都不写委派行', () => {
    const rig = makeRig();
    const c = rig.bots.create({ identity: { name: '丙' } });
    const groupId = 'conv_group_1';
    rig.db
      .prepare("insert into conversations (id, type, title, created_at) values (?, 'group', '群', 1)")
      .run(groupId);
    for (const botId of [rig.a.id, rig.b.id]) {
      rig.db
        .prepare('insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, 1)')
        .run(groupId, botId);
    }
    const inGroup = rig.host.delegate(rig.identity('run_g', rig.a.id, groupId), {
      botId: rig.b.id,
      task: 'x',
    });
    expect(inGroup.ok).toBe(false);
    expect(inGroup.message).toContain('mention_bot_ids');
    const outside = rig.host.delegate(rig.identity('run_g', rig.a.id, groupId), {
      botId: c.id,
      task: 'x',
    });
    expect(outside.ok).toBe(false);
    expect(outside.message).toContain('不在这个群里');
    expect(rig.delegations.listActive()).toHaveLength(0);
  });

  it('B 正忙：保持 submitted 且不落代发消息；cancel_delegation 只认发起方', () => {
    const rig = makeRig();
    const busyHost = new DelegationHost({
      ...rig.hostDeps,
      isMailboxIdle: () => false,
      publish: () => {},
      logger: { warn: () => {}, info: () => {} } as unknown as CoreLogger,
    });
    const result = busyHost.delegate(rig.identity('run_a1'), { botId: rig.b.id, task: '排队' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('空闲后自动发送');
    const [row] = rig.delegations.listActive();
    expect(row).toMatchObject({ status: 'submitted', runId: null, toMessageId: null });
    const bConv = rig.conversations.openDirect(rig.b.id).conversation.id;
    expect(rig.messages.list(bConv)).toHaveLength(0);

    const stranger = busyHost.cancelFromTool(rig.identity('run_x', rig.b.id), row!.id);
    expect(stranger.ok).toBe(false);
    const own = busyHost.cancelFromTool(rig.identity('run_a2'), row!.id);
    expect(own.ok).toBe(true);
    expect(rig.delegations.getOrThrow(row!.id).status).toBe('cancelled');
  });

  it('崩溃恢复：working 但 run_id 为空 → 复用既有代发消息重投，不重发', () => {
    const rig = makeRig();
    const busyHost = new DelegationHost({
      ...rig.hostDeps,
      isMailboxIdle: () => false,
      publish: () => {},
    });
    const result = busyHost.delegate(rig.identity('run_a1'), { botId: rig.b.id, task: '窗口里的任务' });
    expect(result.ok).toBe(true);
    const row = rig.delegations.listActive()[0]!;
    expect(row.status).toBe('submitted');
    // 手工复现崩溃窗口：事务已提交（消息落库 + 转 working），run_id 尚未回填。
    const bConv = rig.conversations.openDirect(rig.b.id).conversation.id;
    const message = rig.messages.append({
      conversationId: bConv,
      senderType: 'user',
      kind: 'text',
      text: row.taskText,
      delegation: { delegationId: row.id, delegatedBy: row.fromBotId },
    });
    rig.delegations.transition(row.id, ['submitted'], 'working', {
      toConversationId: bConv,
      toMessageId: message.id,
    });
    // 启动恢复：复用既有消息触发 B，B 私聊不出现第二条代发消息。
    rig.host.recover();
    const done = rig.delegations.getOrThrow(row.id);
    expect(done.status).toBe('working');
    expect(done.runId).toBe('run_b1');
    expect(rig.delivered).toHaveLength(1);
    expect(rig.delivered[0]!.message.id).toBe(message.id);
    const proxied = rig.messages
      .list(bConv)
      .filter((m) => m.senderType === 'user' && (m.content as { origin?: string }).origin === 'delegation');
    expect(proxied).toHaveLength(1);
    expect(proxied[0]!.id).toBe(message.id);
  });

  it('崩溃恢复：stalled 行的代发消息已不存在 → 落 failed', () => {
    const rig = makeRig();
    const busyHost = new DelegationHost({
      ...rig.hostDeps,
      isMailboxIdle: () => false,
      publish: () => {},
    });
    busyHost.delegate(rig.identity('run_a1'), { botId: rig.b.id, task: '会丢的任务' });
    const row = rig.delegations.listActive()[0]!;
    const bConv = rig.conversations.openDirect(rig.b.id).conversation.id;
    rig.delegations.transition(row.id, ['submitted'], 'working', {
      toConversationId: bConv,
      toMessageId: 'msg_gone',
    });
    rig.host.recover();
    const ended = rig.delegations.getOrThrow(row.id);
    expect(ended.status).toBe('failed');
    expect(ended.errorText).toContain('代发消息已不存在');
    expect(rig.delivered).toHaveLength(0);
  });

  it('结算按 run_id 匹配；非 working / 非 response 的 run 不处理', () => {
    const rig = makeRig();
    rig.host.delegate(rig.identity('run_a1'), { botId: rig.b.id, task: '任务' });
    const [row] = rig.delegations.listActive();
    const bConv = row!.toConversationId!;
    rig.messages.append({
      conversationId: bConv,
      senderType: 'bot',
      senderBotId: rig.b.id,
      kind: 'text',
      text: '完成了',
      runId: 'run_b1',
    });
    const run = { id: 'run_b1', loopType: 'response', status: 'completed', error: null } as Run;
    rig.host.onRunSettled({ ...run, loopType: 'reflection' });
    expect(rig.delegations.getOrThrow(row!.id).status).toBe('working');
    rig.host.onRunSettled(run);
    const done = rig.delegations.getOrThrow(row!.id);
    expect(done).toMatchObject({ status: 'completed', resultExcerpt: '完成了' });
    // 重复结算是空操作。
    rig.host.onRunSettled(run);
    expect(rig.messages.list(rig.aConv).filter((m) => m.kind === 'card')).toHaveLength(2);
  });

  it('截断：超过上限按字符截断并加省略号', () => {
    expect(truncateDelegationResult('短')).toBe('短');
    const long = '字'.repeat(DELEGATION_RESULT_MAX_CHARS + 50);
    const cut = truncateDelegationResult(long);
    expect(cut).toHaveLength(DELEGATION_RESULT_MAX_CHARS + 1);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('记忆反思：代发消息不渲染为「用户」', () => {
    const [message] = reflectionInput({
      triggerMessages: [
        {
          id: 'msg_1',
          createdAt: 1,
          senderType: 'user',
          senderBotId: null,
          content: { text: '帮我整理清单', origin: 'delegation', delegatedBy: 'bot_a' },
        },
      ],
      botMessages: [],
      runId: null,
      executionSteps: '',
      existingMemories: '',
      profileCard: '',
    });
    const text = JSON.stringify(message);
    expect(text).toContain('代用户转交');
    expect(text).not.toContain('msg_1 | 用户]');
  });
});
