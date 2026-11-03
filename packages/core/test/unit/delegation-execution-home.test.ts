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
 * D113 §3.7 执行归属映射（approvals 侧）：委派 run 跑在交换会话里，但审批行
 * 与卡片（含中途权限弹窗的数据源）落在执行方与用户的私聊。TaskHost 侧的同一
 * 映射由集成测试断言（delegation.test.ts W6：任务落在 B 私聊）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'delegation-home-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('approvals 执行归属映射（D113 §3.7）', () => {
  it('委派 run 的审批行与卡片落 B 的用户私聊；非委派 run 不受影响', () => {
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
      unattended: { effective: () => ({ enabled: false }) } as never,
      publish: () => {},
      notify: () => {},
      audit: () => {},
    });
    const a = bots.create({ identity: { name: '甲' } });
    const b = bots.create({ identity: { name: '乙' } });
    const aConv = conversations.openDirect(a.id).conversation.id;
    const bConv = conversations.openDirect(b.id).conversation.id;

    // 委派：B 的委派轮跑在交换会话里（构造一个 working 委派行）。
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

    // 注册归属映射（orchestrator 的接线同一形状）。
    approvals.setUserConversationResolver((identity: RunIdentity) => {
      if (identity.conversationId === null) return null;
      const delegation = delegations.workingByRun(identity.runId);
      return delegation?.toConversationId ?? identity.conversationId;
    });

    // 委派轮（run_b1，会话 = 交换会话）提交一张持久审批卡。
    const delegated = approvals.submitNonBlocking(
      { runId: 'run_b1', botId: b.id, conversationId: exchange.id, loopType: 'turn' },
      'environment',
      { needs: ['node'] },
      () => {},
    );
    expect(delegated.conversationId).toBe(bConv);
    const cards = messages.list(bConv).filter((m) => m.kind === 'card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toMatchObject({ approvalId: delegated.id });
    // 交换会话里没有卡片。
    expect(messages.list(exchange.id).filter((m) => m.kind === 'card')).toHaveLength(0);

    // 非委派 run：保持 run 自己的会话。
    const plain = approvals.submitNonBlocking(
      { runId: 'run_plain', botId: b.id, conversationId: bConv, loopType: 'turn' },
      'environment',
      { needs: ['python'] },
      () => {},
    );
    expect(plain.conversationId).toBe(bConv);
    // 按会话检索（dock 的数据源）只看 B 的私聊。
    const pending = approvals.list(bConv);
    expect(pending.map((row) => row.id).sort()).toEqual([delegated.id, plain.id].sort());
    expect(approvals.list(exchange.id)).toHaveLength(0);
    closeDatabase(db);
  });
});
