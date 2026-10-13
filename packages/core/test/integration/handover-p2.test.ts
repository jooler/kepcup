import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepository } from 'es-git';
import {
  BOT_HANDOVER_EVENT,
  BOT_HANDOVER_FOLLOWUP_EVENT,
  type Approval,
  type Bot,
  type HandoverView,
  type Message,
} from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  makeBot,
  openDirect,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';
import { botWikiRoot, botWikiStoreRoot } from '../../src/infra/paths.js';
import { initWiki } from '../../src/wiki/init.js';
import { commitWikiTree } from '../../src/wiki/git.js';
import { formatInspection } from '../../src/tools/handover-tools.js';
import { JobRetryLaterError } from '../../src/domain/jobs.js';

/**
 * D88 P2（docs/design/37 §3.2、§6；todo/bot-handover.md §5）：Wiki 与组件在后台
 * `handover_copy` 作业里复制——作业完成前卡片保持「执行中」、交接说明不写；页面 + 引用的
 * 原件 + D85 资产进 B 的 Wiki，一次提交，B 能检索到；同路径页不覆盖并列出；组件连同全部
 * 版本 / 查询模板 / 存储数据复制、确认相关的摘要与预审时间照搬；作业崩溃后按 jobs 机制恢复、
 * 不重复；作业多次中断 → 条目失败；「退役」按钮只在全部完成、来源不是管家时给出。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

type Identity = Parameters<NonNullable<TestStack['core']['services']['handover']>['propose']>[0];

function identityOf(botId: string, conversationId: string): Identity {
  return { botId, conversationId, runId: 'run_p2', loopType: 'turn' } as Identity;
}

function write(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

const ASSET = 'ast_00112233445566778899aabb';

/** A wiki with pages (one in a topic directory), raw originals and a D85 asset. */
async function seedWiki(stack: TestStack, bot: Bot): Promise<void> {
  const paths = stack.core.services.paths;
  await initWiki(paths, bot.id, { info() {}, warn() {}, error() {}, debug() {} } as never);
  const root = botWikiRoot(paths, bot.id);
  write(
    root,
    'pages/guide.md',
    `# 部署指南\n\nGuideKeyword 的步骤见 [原文](../raw/20261001-aaaaaaaaaaaa-guide.md)，[源：deck.pdf](../raw/_assets/${ASSET}.json)。\n`,
  );
  write(
    root,
    'pages/ops/runbook.md',
    '# 值班手册\n\nRunbookKeyword 见 [规则](../../raw/20261002-bbbbbbbbbbbb-rules.md)。\n',
  );
  write(root, 'pages/shared.md', `# 共享\n\n${bot.name} 写的版本。\n`);
  write(root, 'raw/20261001-aaaaaaaaaaaa-guide.md', '指南原文');
  write(root, 'raw/20261002-bbbbbbbbbbbb-rules.md', '规则原文');
  write(root, `raw/_assets/${ASSET}.json`, JSON.stringify({ id: ASSET, storage: 'store' }));
  write(root, `raw/_derived/${ASSET}/full.md`, 'deck 全文');
  write(path.join(botWikiStoreRoot(paths, bot.id), ASSET), 'original', Buffer.from('%PDF-1.7'));
  await commitWikiTree(root, 'seed');
  stack.core.services.wiki!.reconcileFtsFor(bot.id);
}

/** B's own wiki: a different page at a path A also has. */
async function seedTargetWiki(stack: TestStack, bot: Bot): Promise<void> {
  const paths = stack.core.services.paths;
  await initWiki(paths, bot.id, { info() {}, warn() {}, error() {}, debug() {} } as never);
  const root = botWikiRoot(paths, bot.id);
  write(root, 'pages/shared.md', `# 共享\n\n${bot.name} 自己的版本。\n`);
  await commitWikiTree(root, 'b seed');
  stack.core.services.wiki!.reconcileFtsFor(bot.id);
}

/** A bot-scope widget with two versions (v2 has a query template), docs and a conversation widget. */
function seedWidgets(stack: TestStack, botId: string, conversationId: string): string {
  const widgets = stack.core.services.widgets!;
  const created = widgets.create({
    botId,
    conversationId,
    title: '记账本',
    description: '每月开销',
    html: '<!doctype html><p>v1</p>',
    scope: 'bot',
    runId: 'run_w1',
  });
  if (!created.ok) throw new Error(created.message);
  const updated = widgets.update({
    botId,
    widgetId: created.widgetId,
    html: '<!doctype html><p>v2</p>',
    queries: [{ name: 'all', sql: 'select key, value_json from widget_kv' }],
    conversationId,
    changeNote: '加查询',
    runId: 'run_w2',
  });
  if (!updated.ok) throw new Error(updated.message);
  const db = stack.core.services.mainDb!;
  db.prepare(
    "update widget_versions set queries_reviewed_at = 12345, check_status = 'passed' where widget_id = ? and version = 2",
  ).run(created.widgetId);
  db.prepare(
    "insert into widget_docs (widget_id, key, value_json, updated_at) values (?, 'rent', '3000', 1)",
  ).run(created.widgetId);
  const scoped = widgets.create({
    botId,
    conversationId,
    title: '临时计算器',
    description: '',
    html: '<!doctype html><p>tmp</p>',
    scope: 'conversation',
    runId: 'run_w3',
  });
  if (!scoped.ok) throw new Error(scoped.message);
  return created.widgetId;
}

function handoverApprovals(stack: TestStack, conversationId: string): Approval[] {
  return stack.core.services
    .domain!.approvals.list(conversationId)
    .filter((approval) => approval.kind === 'bot_handover');
}

async function settled(stack: TestStack, approvalId: string): Promise<HandoverView> {
  const host = stack.core.services.handover!;
  return waitFor(
    () => {
      const view = host.view(approvalId);
      return view !== null && view.status !== 'proposed' && view.status !== 'applying'
        ? view
        : null;
    },
    { label: 'handover settled', timeoutMs: 30_000 },
  );
}

function eventsOf(messages: Message[], event: string): Message[] {
  return messages.filter(
    (message) =>
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === event,
  );
}

function copyJobs(stack: TestStack): Array<{ id: string; status: string; attempts: number }> {
  return stack.core.services
    .mainDb!.prepare(
      "select id, status, attempts from jobs where type = 'handover_copy' order by created_at",
    )
    .all() as Array<{ id: string; status: string; attempts: number }>;
}

async function headMessages(root: string): Promise<string[]> {
  const repo = await openRepository(root);
  const walk = repo.revwalk();
  walk.push(repo.head().target()!);
  const out: string[] = [];
  for (let oid = walk.next(); oid; oid = walk.next()) out.push(repo.getCommit(oid).summary() ?? '');
  return out;
}

/** Proposes (host directly) and returns the pending card. */
function propose(
  stack: TestStack,
  from: Bot,
  conversationId: string,
  to: Bot,
  keys: string[],
): Approval {
  const result = stack.core.services.handover!.propose(identityOf(from.id, conversationId), {
    fromBotId: from.id,
    target: { kind: 'existing', botId: to.id },
    items: keys.map((key) => ({ key })),
    handoverNote: '资料都在 Wiki 里。',
    note: '',
  });
  expect(result, result.message).toMatchObject({ ok: true });
  return handoverApprovals(stack, conversationId).find((a) => a.status === 'pending')!;
}

/** The proposer's follow-up turn replies (predicate: never consumed by B's wiki lint). */
function scriptFollowUp(stack: TestStack): void {
  stack.llm.script('mock-main', [
    step()
      .expect((req) => JSON.stringify(req.body.messages).includes('移交处理结果'))
      .replyText('移交做完了。'),
  ]);
}

describe('bot asset handover P2 (D88)', () => {
  it('Wiki + 组件：后台作业完成前卡片保持执行中；页 / 原件 / 资产进 B、一次提交、可检索；同路径不覆盖并列出；组件版本与确认摘要照搬；有跳过的页不给退役', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    const betaDirect = (await openDirect(core, beta.id)).id;
    await seedWiki(stack, alpha);
    await seedTargetWiki(stack, beta);
    const widgetId = seedWidgets(stack, alpha.id, alphaDirect);
    const host = core.services.handover!;
    const paths = core.services.paths;
    const alphaRoot = botWikiRoot(paths, alpha.id);
    const betaRoot = botWikiRoot(paths, beta.id);
    const alphaHistory = await headMessages(alphaRoot);

    // 盘点：整本 / 目录条目 + wiki_query 列页；只有 Bot 级组件；标题包 untrusted。
    const inspected = host.inspect(identityOf(alpha.id, alphaDirect), {
      botId: '',
      wikiQuery: '*',
    });
    expect(inspected.ok).toBe(true);
    const text = formatInspection((inspected as { ok: true; inspection: never }).inspection);
    for (const key of [
      'wiki:pages/',
      'wiki:pages/ops/',
      'wiki:pages/guide.md',
      'wiki:pages/ops/runbook.md',
      `widget:${widgetId}`,
    ]) {
      expect(text, key).toContain(key);
    }
    expect(text).toContain('<untrusted>部署指南</untrusted>');
    expect(text).toContain('另有 1 个会话级组件');
    expect(text).not.toContain('临时计算器');

    const approval = propose(stack, alpha, alphaDirect, beta, [
      'wiki:pages/',
      `widget:${widgetId}`,
    ]);
    const payload = approval.payload as {
      items: Array<{ key: string; warnings: string[]; detail: string }>;
    };
    const wikiItem = payload.items.find((item) => item.key === 'wiki:pages/')!;
    expect(wikiItem.warnings.join()).toContain('pages/shared.md');
    expect(wikiItem.detail).toContain('3 页');

    // 作业先不跑：确认后同步阶段做完，移交仍是 applying，条目 pending，交接说明还没写。
    core.services.jobsRunner!.stop();
    scriptFollowUp(stack);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitFor(() => (copyJobs(stack).length > 0 ? true : null), { label: 'handover_copy job' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const during = host.view(approval.id)!;
    expect(during.status).toBe('applying');
    expect(during.items.find((item) => item.key === 'wiki:pages/')!.status).toBe('pending');
    expect(during.items.find((item) => item.key === `widget:${widgetId}`)!.status).toBe('pending');
    expect(during.retire).toBeNull();
    expect(eventsOf(await listAllMessages(core, betaDirect), BOT_HANDOVER_EVENT)).toHaveLength(0);
    expect(copyJobs(stack)).toEqual([expect.objectContaining({ status: 'pending' })]);

    core.services.jobsRunner!.start();
    const view = await settled(stack, approval.id);
    // 同路径的页被跳过、列出——条目仍算完成，但不给「退役」（A 的那页没到 B 那里）。
    expect(view.status).toBe('completed');
    expect(view.items.find((item) => item.key === 'wiki:pages/')).toMatchObject({
      status: 'done',
      copiedCount: 2,
      skippedPaths: ['pages/shared.md'],
    });
    expect(view.items.find((item) => item.key === `widget:${widgetId}`)).toMatchObject({
      status: 'done',
      copiedCount: 2,
    });
    expect(view.retire).toBeNull();
    expect(copyJobs(stack)).toEqual([expect.objectContaining({ status: 'done' })]);

    // Wiki：页、引用的原件与 D85 资产到了 B；B 自己的同路径页没被覆盖；一次提交；B 能检索。
    for (const rel of [
      'pages/guide.md',
      'pages/ops/runbook.md',
      'raw/20261001-aaaaaaaaaaaa-guide.md',
      'raw/20261002-bbbbbbbbbbbb-rules.md',
      `raw/_assets/${ASSET}.json`,
      `raw/_derived/${ASSET}/full.md`,
    ]) {
      expect(readFileSync(path.join(betaRoot, rel), 'utf8'), rel).toBe(
        readFileSync(path.join(alphaRoot, rel), 'utf8'),
      );
    }
    expect(existsSync(path.join(botWikiStoreRoot(paths, beta.id), ASSET, 'original'))).toBe(true);
    expect(readFileSync(path.join(betaRoot, 'pages/shared.md'), 'utf8')).toContain(
      '贝塔 自己的版本',
    );
    const betaHistory = await headMessages(betaRoot);
    expect(betaHistory[0]).toBe('从 阿尔法 复制 2 页');
    expect(betaHistory.filter((message) => message.startsWith('从 阿尔法'))).toHaveLength(1);
    expect(await headMessages(alphaRoot)).toEqual(alphaHistory);
    const hits = (await core.rpc.call('wiki.search', {
      botId: beta.id,
      query: 'RunbookKeyword',
    })) as {
      hits: Array<{ path: string }>;
    };
    expect(hits.hits.map((hit) => hit.path)).toEqual(['pages/ops/runbook.md']);
    const lint = core.services
      .mainDb!.prepare("select payload_json from jobs where type = 'wiki_lint' and bot_id = ?")
      .all(beta.id) as Array<{ payload_json: string }>;
    expect(lint.map((row) => JSON.parse(row.payload_json).trigger)).toContain('handover');

    // 组件：新 id、仍为 Bot 级、两个版本的摘要与自检 / 预审照搬、查询模板与存储数据复制；
    // 会话级组件没过去；A 的不变。
    const betaWidgets = core.services.widgets!.listForBot(beta.id);
    expect(betaWidgets).toHaveLength(1);
    const copy = betaWidgets[0]!;
    expect(copy).toMatchObject({
      title: '记账本',
      scope: 'bot',
      versionCount: 2,
      version: 2,
      checkStatus: 'passed',
    });
    expect(copy.widgetId).not.toBe(widgetId);
    const db = core.services.mainDb!;
    const versions = (id: string) =>
      db
        .prepare(
          'select version, sha256, queries_sha256, queries_reviewed_at, check_status from widget_versions where widget_id = ? order by version',
        )
        .all(id);
    expect(versions(copy.widgetId)).toEqual(versions(widgetId));
    expect(
      db.prepare('select name, sql from widget_queries where widget_id = ?').all(copy.widgetId),
    ).toEqual(db.prepare('select name, sql from widget_queries where widget_id = ?').all(widgetId));
    expect(
      db.prepare('select key, value_json from widget_docs where widget_id = ?').all(copy.widgetId),
    ).toEqual([{ key: 'rent', value_json: '3000' }]);
    expect(core.services.widgets!.listForBot(alpha.id)).toHaveLength(2);

    // 交接说明在作业完成后才写；结果通知列出没覆盖的页。
    expect(eventsOf(await listAllMessages(core, betaDirect), BOT_HANDOVER_EVENT)).toHaveLength(1);
    const followUp = await waitFor(
      async () =>
        eventsOf(await listAllMessages(core, alphaDirect), BOT_HANDOVER_FOLLOWUP_EVENT)[0] ?? null,
    );
    const followText = (followUp.content as { text: string }).text;
    expect(followText).toContain('没有覆盖');
    expect(followText).toContain('pages/shared.md');
    expect(followText).not.toContain('删除 阿尔法');
  }, 60_000);

  it('作业崩溃恢复：执行到一半中断（页已落盘未提交）→ jobs 恢复 + recover() 续跑，不重复提交 / 复制；全部完成给出退役，删除后不再给', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    await seedWiki(stack, alpha);
    const widgetId = seedWidgets(stack, alpha.id, alphaDirect);
    const host = core.services.handover!;
    const jobs = core.services.domain!.jobs;
    const betaRoot = botWikiRoot(core.services.paths, beta.id);

    const approval = propose(stack, alpha, alphaDirect, beta, [
      'wiki:pages/guide.md',
      `widget:${widgetId}`,
    ]);
    core.services.jobsRunner!.stop();
    scriptFollowUp(stack);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitFor(() => (copyJobs(stack).length > 0 ? true : null), { label: 'handover_copy job' });

    // 模拟「作业认领后、复制到一半时进程崩溃」：作业 running，页已经落进 B 的 Wiki 但没提交；
    // 组件已复制（事务提交了、还没来得及记账）。
    const job = copyJobs(stack)[0]!;
    core.services
      .mainDb!.prepare("update jobs set status = 'running', attempts = 1 where id = ?")
      .run(job.id);
    await initWiki(core.services.paths, beta.id, {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never);
    write(
      betaRoot,
      'pages/guide.md',
      readFileSync(path.join(botWikiRoot(core.services.paths, alpha.id), 'pages/guide.md')),
    );
    core.services.widgets!.copyForHandover(widgetId, beta.id, '贝塔');

    // 「重启」：jobs 表把 running 改回 pending，移交恢复不另登记作业，作业重跑。
    expect(jobs.resetRunningToPending()).toBe(1);
    host.recover();
    expect(copyJobs(stack)).toHaveLength(1);
    core.services.jobsRunner!.start();
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');
    expect(view.items.every((item) => item.status === 'done')).toBe(true);
    expect(view.retire).toEqual({
      botId: alpha.id,
      botName: '阿尔法',
      // 3 页里复制了 1 页；会话级组件没复制。
      remaining: { memory: 0, wikiPages: 2, skills: 0, widgets: 1 },
    });
    const history = await headMessages(betaRoot);
    expect(history.filter((message) => message === '从 阿尔法 复制 1 页')).toHaveLength(1);
    expect(existsSync(path.join(betaRoot, 'raw/20261001-aaaaaaaaaaaa-guide.md'))).toBe(true);
    const hits = (await core.rpc.call('wiki.search', {
      botId: beta.id,
      query: 'GuideKeyword',
    })) as {
      hits: Array<{ path: string }>;
    };
    expect(hits.hits.map((hit) => hit.path)).toEqual(['pages/guide.md']);
    expect(core.services.widgets!.listForBot(beta.id)).toHaveLength(1);
    const followUp = await waitFor(
      async () =>
        eventsOf(await listAllMessages(core, alphaDirect), BOT_HANDOVER_FOLLOWUP_EVENT)[0] ?? null,
    );
    expect((followUp.content as { text: string }).text).toContain('删除 阿尔法');
    expect((followUp.content as { text: string }).text).toContain('Wiki 2 页、组件 1 个');

    // RPC 视图同样给出退役；删除 A（D18 路径）之后不再给。
    const viaRpc = (await core.rpc.call('handovers.get', { approvalId: approval.id })) as {
      handover: HandoverView;
    };
    expect(viaRpc.handover.retire).toEqual(view.retire);
    await core.rpc.call('bots.delete', { id: alpha.id });
    expect(host.view(approval.id)!.retire).toBeNull();
  }, 60_000);

  it('独立审查 #1 / #2：来源还有移交类资产（定时任务）时不给退役，取消后才给；接手方被删后不再给', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    await seedWiki(stack, alpha);
    const daily = core.services.schedules!.createFromWhen({
      botId: alpha.id,
      conversationId: alphaDirect,
      when: '0 9 * * *',
      title: '日报',
      note: '写日报',
      origin: 'tool',
    });
    scriptFollowUp(stack);
    const approval = propose(stack, alpha, alphaDirect, beta, ['wiki:pages/']);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');
    // 阿尔法还负责「日报」（没交出去）：删除它会让定时任务消失，不给退役。
    expect(view.retire).toBeNull();
    const followText = (
      (
        await waitFor(
          async () =>
            eventsOf(await listAllMessages(core, alphaDirect), BOT_HANDOVER_FOLLOWUP_EVENT)[0] ??
            null,
        )
      ).content as { text: string }
    ).text;
    expect(followText).not.toContain('删除 阿尔法');
    // 定时任务取消后（A 名下已没有移交类资产），重新读视图就给退役；Wiki 全部复制过去了。
    core.services.schedules!.cancel(daily.id);
    expect(core.services.handover!.view(approval.id)!.retire).toEqual({
      botId: alpha.id,
      botName: '阿尔法',
      remaining: { memory: 0, wikiPages: 0, skills: 0, widgets: 0 },
    });
    // 接手方被删除：交出去的东西随它没了，不再引导删 A。
    await core.rpc.call('bots.delete', { id: beta.id });
    expect(core.services.handover!.view(approval.id)!.retire).toBeNull();
  }, 60_000);

  it('独立审查 #4：复制途中删除接手方——不重建 bots/{B}/、不给它插组件行，移交随后跳过并结算', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    await seedWiki(stack, alpha);
    const widgetId = seedWidgets(stack, alpha.id, alphaDirect);
    const host = core.services.handover!;
    const approval = propose(stack, alpha, alphaDirect, beta, [
      'wiki:pages/',
      `widget:${widgetId}`,
    ]);
    core.services.jobsRunner!.stop();
    scriptFollowUp(stack);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitFor(() => (copyJobs(stack).length > 0 ? true : null), { label: 'handover_copy job' });
    const payloadJson = (
      core.services
        .mainDb!.prepare("select payload_json from jobs where type = 'handover_copy'")
        .get() as { payload_json: string }
    ).payload_json;

    // Hold B's wiki maintenance lock so the copy's phase 2 queues behind it.
    let release!: () => void;
    const gate = core.services.wiki!.runExclusively(
      beta.id,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const copying = host.runCopyJob({ payload_json: payloadJson, attempts: 1 }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof JobRetryLaterError ? 'retry-later' : String(error)),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deleting = core.rpc.call('bots.delete', { id: beta.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await gate;
    await deleting;
    expect(await copying).toBe('retry-later');
    const betaHome = path.join(core.services.paths.home, 'bots', beta.id);
    expect(existsSync(betaHome)).toBe(false);
    const widgetRows = () =>
      (
        core.services
          .mainDb!.prepare('select count(*) as n from widgets where bot_id = ?')
          .get(beta.id) as { n: number }
      ).n;
    expect(widgetRows()).toBe(0);

    // The retried job sees B deleted: items skipped, the handover settles, still no orphans.
    await host.runCopyJob({ payload_json: payloadJson, attempts: 2 });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('failed');
    expect(view.items.find((item) => item.key === 'wiki:pages/')!.status).toBe('skipped');
    expect(existsSync(betaHome)).toBe(false);
    expect(widgetRows()).toBe(0);
    expect(existsSync(path.join(core.services.paths.cacheDir, 'handover-staging', view.id))).toBe(
      false,
    );
  }, 60_000);

  it('作业多次中断而失败：恢复时条目记失败（不无限重登），移交结算为失败、不给退役', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    await seedWiki(stack, alpha);
    const approval = propose(stack, alpha, alphaDirect, beta, ['wiki:pages/ops/']);
    core.services.jobsRunner!.stop();
    scriptFollowUp(stack);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitFor(() => (copyJobs(stack).length > 0 ? true : null), { label: 'handover_copy job' });
    const job = copyJobs(stack)[0]!;
    core.services
      .mainDb!.prepare(
        "update jobs set status = 'failed', attempts = 3, last_error = 'process died' where id = ?",
      )
      .run(job.id);
    core.services.handover!.recover();
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('failed');
    expect(view.items.find((item) => item.key === 'wiki:pages/ops/')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('后台复制多次中断'),
    });
    expect(view.retire).toBeNull();
    expect(copyJobs(stack)).toHaveLength(1);
    expect(
      existsSync(path.join(botWikiRoot(core.services.paths, beta.id), 'pages/ops/runbook.md')),
    ).toBe(false);
    core.services.jobsRunner!.start();
  }, 60_000);

  it('后台批量暂时失败：作业推迟重试（不在下一次轮询就耗尽次数）、条目留 pending；末次记失败并结算，不卡在执行中', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    await seedWiki(stack, alpha);
    const host = core.services.handover!;
    const approval = propose(stack, alpha, alphaDirect, beta, ['wiki:pages/ops/']);
    core.services.jobsRunner!.stop();
    scriptFollowUp(stack);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitFor(() => (copyJobs(stack).length > 0 ? true : null), { label: 'handover_copy job' });
    // B's wiki root is a plain file: placing anything there fails (initWiki throws).
    const betaHome = path.join(core.services.paths.home, 'bots', beta.id);
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(path.join(betaHome, 'wiki'), 'not a directory');

    // The real runner: the first attempt fails and is postponed (attempts = 1, run_after
    // pushed out), the items stay pending and the handover stays applying.
    const startedAt = Date.now();
    core.services.jobsRunner!.start();
    const row = await waitFor(
      () => {
        const job = core.services
          .mainDb!.prepare(
            "select status, attempts, run_after, payload_json from jobs where type = 'handover_copy'",
          )
          .get() as { status: string; attempts: number; run_after: number; payload_json: string };
        return job.attempts === 1 && job.status === 'pending' ? job : null;
      },
      { label: 'postponed handover_copy' },
    );
    core.services.jobsRunner!.stop();
    expect(row.run_after).toBeGreaterThan(startedAt + 20_000);
    expect(host.view(approval.id)).toMatchObject({ status: 'applying' });
    expect(host.view(approval.id)!.items.find((i) => i.key === 'wiki:pages/ops/')!.status).toBe(
      'pending',
    );
    // Not the last attempt → the host asks for a later retry.
    await expect(
      host.runCopyJob({ payload_json: row.payload_json, attempts: 2 }),
    ).rejects.toBeInstanceOf(JobRetryLaterError);
    // Last attempt → the items fail and the handover settles (no stuck「执行中」).
    await host.runCopyJob({ payload_json: row.payload_json, attempts: 3 });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('failed');
    expect(view.items.find((item) => item.key === 'wiki:pages/ops/')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('ENOTDIR'),
    });
    expect(view.retire).toBeNull();
  }, 60_000);

  it('来源是管家：全部完成也不给退役；同路径单页条目在卡上置灰', async () => {
    const stack = await start();
    const { core } = stack;
    const ensured = (await core.rpc.call('butler.ensure', {})) as {
      bot: Bot;
      conversationId: string;
    };
    const butler = ensured.bot;
    const beta = await makeBot(core, '贝塔');
    await seedWiki(stack, butler);
    await seedTargetWiki(stack, beta);
    scriptFollowUp(stack);
    const approval = propose(stack, butler, ensured.conversationId, beta, [
      'wiki:pages/guide.md',
      'wiki:pages/shared.md',
    ]);
    const payload = approval.payload as { items: Array<{ key: string; blocked?: string }> };
    expect(payload.items.find((item) => item.key === 'wiki:pages/shared.md')!.blocked).toContain(
      '同路径',
    );
    expect(
      payload.items.find((item) => item.key === 'wiki:pages/guide.md')!.blocked,
    ).toBeUndefined();
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');
    expect(view.items.find((item) => item.key === 'wiki:pages/guide.md')!.status).toBe('done');
    expect(view.retire).toBeNull();
  }, 60_000);
});
