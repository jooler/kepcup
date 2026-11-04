import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { systemClock } from '../../src/infra/clock.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { DelegationsService } from '../../src/domain/delegations.js';
import { ApprovalsService } from '../../src/permissions/approvals.js';
import type { RunIdentity } from '../../src/agent/types.js';
import type { CoreLogger } from '../../src/infra/logger.js';
import type { Paths } from '../../src/infra/paths.js';

/**
 * v2.3 §3.7 执行归属映射（approvals 侧）：委派执行的审批行与卡片（含中途
 * 权限弹窗的数据源）落在**发起方 A** 与用户的私聊——谁发出委派，用户就在
 * 谁的对话里操作。委派轮与委派任务都住交换会话，按会话（byExchange）即可
 * 命中同一行；TaskHost 侧的提问归属由集成测试断言（delegation.test.ts）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'delegation-home-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('approvals 执行归属映射（v2.3 §3.7）', () => {
  it('委派轮与委派任务的审批行与卡片落 A 的用户私聊；非委派 run 不受影响', () => {
    const db: SqliteDatabase = openDatabase({
      path: path.join(dir, 'main.db'),
      key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
    });
    runMigrations(db, migrationsUrl('main'));
    const clock = systemClock;
    const bots = new BotsService(db, clock);
    const conversations = new ConversationsService(db, clock);
    const messages = new MessagesService(db, clock);
    const delegations = new DelegationsService(db, clock);
    const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
    const approvals = new ApprovalsService({
      db,
      clock,
      logger: logger as unknown as CoreLogger,
      paths: { home: dir } as unknown as Paths,
      homeDir: dir,
      messages,
      conversations,
      bots,
      runs: { get: () => null, update: () => null } as never,
      secrets: { redact: (input: string) => input } as never,
      publish: () => {},
      notify: () => {},
      audit: () => {},
    });
    const a = bots.create({ identity: { name: '甲' } });
    const b = bots.create({ identity: { name: '乙' } });
    const aConv = conversations.openDirect(a.id).conversation.id;
    const bConv = conversations.openDirect(b.id).conversation.id;

    // 委派：B 的委派轮与它派的任务都住交换会话（v2.3）。
    const exchange = conversations.openExchange(a.id, b.id);
    const created = delegations.create({
      fromBotId: a.id,
      toBotId: b.id,
      fromConversationId: aConv,
      taskText: '需要审批的任务',
      depth: 1,
      fromRunId: null,
    });
    delegations.patch(created.id, { exchangeConversationId: exchange.id });
    delegations.transition(created.id, ['submitted'], 'working', {
      toConversationId: bConv,
      runId: 'run_b1',
    });

    // 注册归属映射（orchestrator 的接线同一形状：byExchange 优先、workingByRun 兜底）。
    approvals.setUserConversationResolver((identity: RunIdentity) => {
      if (identity.conversationId === null) return null;
      const delegation =
        delegations.byExchange(identity.conversationId) ?? delegations.workingByRun(identity.runId);
      return delegation?.fromConversationId ?? identity.conversationId;
    });

    // 委派轮（run_b1，会话 = 交换会话）提交一张持久审批卡 → 落 A 的私聊。
    const delegated = approvals.submitNonBlocking(
      { runId: 'run_b1', botId: b.id, conversationId: exchange.id, loopType: 'turn' },
      'environment',
      { needs: ['node'] },
      () => {},
    );
    expect(delegated.conversationId).toBe(aConv);
    const cards = messages.list(aConv).filter((m) => m.kind === 'card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toMatchObject({ approvalId: delegated.id });
    // 交换会话与执行方 B 的私聊里都没有卡片。
    expect(messages.list(exchange.id).filter((m) => m.kind === 'card')).toHaveLength(0);
    expect(messages.list(bConv).filter((m) => m.kind === 'card')).toHaveLength(0);

    // 委派任务（run_t1，会话 = 交换会话，任务住交换会话）→ 同样落 A 的私聊。
    const fromTask = approvals.submitNonBlocking(
      { runId: 'run_t1', botId: b.id, conversationId: exchange.id, loopType: 'task' },
      'environment',
      { needs: ['python'] },
      () => {},
    );
    expect(fromTask.conversationId).toBe(aConv);
    // 按会话检索（dock 的数据源）只看 A 的私聊。
    const pending = approvals.list(aConv);
    expect(pending.map((row) => row.id).sort()).toEqual([delegated.id, fromTask.id].sort());
    expect(approvals.list(exchange.id)).toHaveLength(0);
    expect(approvals.list(bConv)).toHaveLength(0);

    // 非委派 run：保持 run 自己的会话（B 的私聊）。
    const plain = approvals.submitNonBlocking(
      { runId: 'run_plain', botId: b.id, conversationId: bConv, loopType: 'turn' },
      'environment',
      { needs: ['node'] },
      () => {},
    );
    expect(plain.conversationId).toBe(bConv);
    closeDatabase(db);
  });

  it('v1 存量轮（workingByRun 兜底）与更新轮重绑窗口同样落 A 的私聊', () => {
    const db: SqliteDatabase = openDatabase({
      path: path.join(dir, 'main.db'),
      key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
    });
    runMigrations(db, migrationsUrl('main'));
    const clock = systemClock;
    const bots = new BotsService(db, clock);
    const conversations = new ConversationsService(db, clock);
    const messages = new MessagesService(db, clock);
    const delegations = new DelegationsService(db, clock);
    const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
    const approvals = new ApprovalsService({
      db,
      clock,
      logger: logger as unknown as CoreLogger,
      paths: { home: dir } as unknown as Paths,
      homeDir: dir,
      messages,
      conversations,
      bots,
      runs: { get: () => null, update: () => null } as never,
      secrets: { redact: (input: string) => input } as never,
      publish: () => {},
      notify: () => {},
      audit: () => {},
    });
    const a = bots.create({ identity: { name: '甲' } });
    const b = bots.create({ identity: { name: '乙' } });
    const aConv = conversations.openDirect(a.id).conversation.id;
    const bConv = conversations.openDirect(b.id).conversation.id;

    // v1 存量：无交换会话，代发消息在 B 的私聊里。
    const created = delegations.create({
      fromBotId: a.id,
      toBotId: b.id,
      fromConversationId: aConv,
      taskText: '存量委派',
      depth: 1,
      fromRunId: null,
    });
    delegations.transition(created.id, ['submitted'], 'working', {
      toConversationId: bConv,
      runId: 'run_legacy',
    });
    approvals.setUserConversationResolver((identity: RunIdentity) => {
      if (identity.conversationId === null) return null;
      const delegation =
        delegations.byExchange(identity.conversationId) ?? delegations.workingByRun(identity.runId);
      return delegation?.fromConversationId ?? identity.conversationId;
    });
    const legacy = approvals.submitNonBlocking(
      { runId: 'run_legacy', botId: b.id, conversationId: bConv, loopType: 'turn' },
      'environment',
      { needs: ['node'] },
      () => {},
    );
    expect(legacy.conversationId).toBe(aConv);
    expect(messages.list(bConv).filter((m) => m.kind === 'card')).toHaveLength(0);
    closeDatabase(db);
  });
});
