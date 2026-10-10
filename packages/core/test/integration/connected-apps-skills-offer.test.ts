import { afterEach, describe, expect, it } from 'vitest';
import type { AppSkillsOfferEvent, Approval, SkillEntry } from '@kepcup/shared';
import { createSkillRepo, skillFiles, waitFor, type SkillRepoFixture } from '@kepcup/testkit';
import { startCatalogEnv, type CatalogEnv } from '../support/catalog-connect-env.js';

/**
 * D73 P3 §7.6 随附技能：目录条目 `_meta.skills` → 连接完成后 `apps.skills_offer` → `apps.skills.install`
 * 走既有 `skill_import` 审批（D63）→ 批准后技能出现在该 Bot；拒绝则什么都不装；已安装则不再提示。
 * 夹具仓库是本机 git（目录 schema 不允许本机路径，经测试钩子 `appSkillSourceOverride` 映射）。
 */

const DECLARED_SOURCE = 'https://example.com/acme/skills.git';
const SKILL_NAME = 'acme-guide';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
  env: CatalogEnv;
  repo: SkillRepoFixture;
  offers: AppSkillsOfferEvent[];
  botId: string;
}

async function setup(
  skills: unknown[] | null = [
    { name: SKILL_NAME, source: DECLARED_SOURCE, description: 'How to use Acme' },
  ],
  repoSkillName: string = SKILL_NAME,
): Promise<Setup> {
  const repo = await createSkillRepo(
    skillFiles(repoSkillName, 'Acme 使用指南：连接 Acme 之后怎么用'),
  );
  cleanups.push(() => repo.cleanup());
  const env = await startCatalogEnv({
    entry: { slug: 'acme', tier: 'verified', ...(skills !== null ? { skills } : {}) },
    appSkillSourceOverride: (source) => (source === DECLARED_SOURCE ? repo.repoDir : source),
  });
  cleanups.push(() => env.cleanup());
  const offers: AppSkillsOfferEvent[] = [];
  env.core.onEvent('apps.skills_offer', (payload) => offers.push(payload));
  const bot = await env.makeBot('阿技');
  return { env, repo, offers, botId: bot.id };
}

async function skillsOf(env: CatalogEnv, botId: string): Promise<SkillEntry[]> {
  return ((await env.core.rpc.call('skills.list', { botId })) as { skills: SkillEntry[] }).skills;
}

async function approvalsOf(env: CatalogEnv, botId: string): Promise<Approval[]> {
  const all = (await env.core.rpc.call('approvals.list', {})) as { approvals: Approval[] };
  return all.approvals.filter((a) => a.kind === 'skill_import' && a.botId === botId);
}

describe('随附技能提示与安装', () => {
  it('连接（授权给 Bot）→ apps.skills_offer → install 提交 skill_import 审批 → 批准后技能在该 Bot 上', async () => {
    const { env, offers, botId } = await setup();
    const outcome = await env.connect({ grantBotId: botId });
    expect(outcome.last.phase).toBe('done');
    const connectionId = outcome.last.connectionId!;

    await waitFor(() => (offers.length > 0 ? offers : null), { label: 'skills offer event' });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      connectionId,
      connectorId: 'acme',
      botIds: [botId],
      skills: [{ name: SKILL_NAME, description: 'How to use Acme', source: DECLARED_SOURCE }],
    });
    // 提示本身什么都不装。
    expect(await skillsOf(env, botId)).toEqual([]);
    expect(await approvalsOf(env, botId)).toEqual([]);

    const pull = (await env.core.rpc.call('apps.skills.offers', { connectionId })) as {
      bots: Array<{ botId: string; skills: Array<{ name: string }> }>;
    };
    expect(pull.bots.map((b) => [b.botId, b.skills.map((s) => s.name)])).toEqual([
      [botId, [SKILL_NAME]],
    ]);

    // 接受 → 只提交审批，批准前不安装。
    const install = (await env.core.rpc.call('apps.skills.install', { connectionId, botId })) as {
      results: Array<{ name: string; status: string; approvalId?: string }>;
    };
    expect(install.results).toHaveLength(1);
    expect(install.results[0]).toMatchObject({ name: SKILL_NAME, status: 'submitted' });
    const approvalId = install.results[0]!.approvalId!;
    const [card] = await approvalsOf(env, botId);
    expect(card).toMatchObject({ id: approvalId, kind: 'skill_import', status: 'pending' });
    // 审批卡带来源与扫描结果（既有 payload）。
    expect(card?.payload['name']).toBe(SKILL_NAME);
    expect(card?.payload['scan']).toBeDefined();
    expect(await skillsOf(env, botId)).toEqual([]);

    // 重复点「安装」不会叠第二张卡。
    const again = (await env.core.rpc.call('apps.skills.install', { connectionId, botId })) as {
      results: Array<{ status: string; approvalId?: string }>;
    };
    expect(again.results).toEqual([{ name: SKILL_NAME, status: 'pending', approvalId }]);
    expect(await approvalsOf(env, botId)).toHaveLength(1);

    await env.core.rpc.call('approvals.decide', { id: approvalId, approve: true });
    const installed = await waitFor(
      async () => {
        const list = await skillsOf(env, botId);
        return list.length === 1 ? list : null;
      },
      { label: 'skill installed for the bot' },
    );
    expect(installed[0]).toMatchObject({ name: SKILL_NAME, kind: 'imported', status: 'active' });

    // 装好之后不再有缺口。
    const after = (await env.core.rpc.call('apps.skills.offers', { connectionId })) as {
      bots: unknown[];
    };
    expect(after.bots).toEqual([]);
  }, 60_000);

  it('拒绝审批：什么都没有安装，缺口仍在（可以再次提示）', async () => {
    const { env, offers, botId } = await setup();
    const connectionId = (await env.connect({ grantBotId: botId })).last.connectionId!;
    await waitFor(() => (offers.length > 0 ? offers : null), { label: 'skills offer event' });
    const install = (await env.core.rpc.call('apps.skills.install', { connectionId, botId })) as {
      results: Array<{ approvalId?: string }>;
    };
    await env.core.rpc.call('approvals.decide', {
      id: install.results[0]!.approvalId!,
      approve: false,
    });
    await waitFor(
      async () => ((await approvalsOf(env, botId))[0]?.status === 'denied' ? true : null),
      { label: 'approval denied' },
    );
    expect(await skillsOf(env, botId)).toEqual([]);
    const pull = (await env.core.rpc.call('apps.skills.offers', { connectionId })) as {
      bots: unknown[];
    };
    expect(pull.bots).toHaveLength(1);
  }, 60_000);

  it('该 Bot 已经装了同名技能：连接完成后不提示', async () => {
    const { env, repo, offers, botId } = await setup();
    // 先走一遍既有的 skills.import 把技能装上。
    const imported = (await env.core.rpc.call('skills.import', {
      botId,
      sourceUrl: repo.repoDir,
    })) as { approvalId: string };
    await env.core.rpc.call('approvals.decide', { id: imported.approvalId, approve: true });
    await waitFor(async () => ((await skillsOf(env, botId)).length === 1 ? true : null), {
      label: 'pre-installed',
    });

    const outcome = await env.connect({ grantBotId: botId });
    expect(outcome.last.phase).toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(offers).toEqual([]);
    const pull = (await env.core.rpc.call('apps.skills.offers', {
      connectionId: outcome.last.connectionId,
    })) as { bots: unknown[] };
    expect(pull.bots).toEqual([]);
    // 默认（不带 names）只装还缺的：已有就什么都不提交。
    const install = (await env.core.rpc.call('apps.skills.install', {
      connectionId: outcome.last.connectionId,
      botId,
    })) as { results: unknown[] };
    expect(install.results).toEqual([]);
    expect(await approvalsOf(env, botId)).toHaveLength(1); // 只有最初那张 skills.import 的卡
  }, 60_000);

  it('没有被授权的 Bot 时不提示，也不能为未持有该连接的 Bot 安装', async () => {
    const { env, offers, botId } = await setup();
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(offers).toEqual([]);
    const connectionId = outcome.last.connectionId!;
    // 没有 Bot 持有该连接：不能为任意 Bot 安装。
    await expect(
      env.core.rpc.call('apps.skills.install', { connectionId, botId }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 60_000);

  it('目录条目没有声明技能：不提示；声明之外的名字不能安装', async () => {
    const none = await setup(null);
    const outcome = await none.env.connect({ grantBotId: none.botId });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(none.offers).toEqual([]);
    await expect(
      none.env.core.rpc.call('apps.skills.install', {
        connectionId: outcome.last.connectionId,
        botId: none.botId,
        names: ['anything'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 60_000);

  it('无人值守：沿用 skill_import 既有规则（自动批准并装入）；没有开关时绝不自动安装', async () => {
    const { env, offers, botId } = await setup();
    const connectionId = (await env.connect({ grantBotId: botId })).last.connectionId!;
    await waitFor(() => (offers.length > 0 ? offers : null), { label: 'skills offer event' });
    // 提示 + 未安装：没有自动安装（无人值守关）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await skillsOf(env, botId)).toEqual([]);

    await env.core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    const install = (await env.core.rpc.call('apps.skills.install', { connectionId, botId })) as {
      results: Array<{ status: string }>;
    };
    expect(install.results[0]?.status).toBe('submitted');
    await waitFor(async () => ((await skillsOf(env, botId)).length === 1 ? true : null), {
      label: 'auto-approved install',
    });
    const [card] = await approvalsOf(env, botId);
    expect(card).toMatchObject({ kind: 'skill_import', status: 'approved', autoApproved: true });
  }, 60_000);

  it('来源里 SKILL.md 的名字与目录声明不符：不提交审批、标记 mismatch，之后不再提示也不再克隆', async () => {
    const { env, offers, botId } = await setup(undefined, 'some-other-name');
    const connectionId = (await env.connect({ grantBotId: botId })).last.connectionId!;
    await waitFor(() => (offers.length > 0 ? offers : null), { label: 'skills offer event' });

    const first = (await env.core.rpc.call('apps.skills.install', { connectionId, botId })) as {
      results: Array<{ name: string; status: string; error?: string }>;
    };
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ name: SKILL_NAME, status: 'mismatch' });
    expect(first.results[0]?.error).toContain('some-other-name');
    // nothing was submitted or installed
    expect(await approvalsOf(env, botId)).toEqual([]);
    expect(await skillsOf(env, botId)).toEqual([]);

    // no offer loop: the pull query is empty, a retry is answered without cloning again
    const pull = (await env.core.rpc.call('apps.skills.offers', { connectionId })) as {
      bots: unknown[];
    };
    expect(pull.bots).toEqual([]);
    const again = (await env.core.rpc.call('apps.skills.install', { connectionId, botId })) as {
      results: Array<{ status: string }>;
    };
    expect(again.results.map((r) => r.status)).toEqual(['mismatch']);
    const named = (await env.core.rpc.call('apps.skills.install', {
      connectionId,
      botId,
      names: [SKILL_NAME],
    })) as { results: Array<{ status: string }> };
    expect(named.results.map((r) => r.status)).toEqual(['mismatch']);
    expect(await approvalsOf(env, botId)).toEqual([]);
  }, 60_000);
});
