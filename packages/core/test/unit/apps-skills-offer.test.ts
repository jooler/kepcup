import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  CONNECTOR_META_KEY,
  appSkillsOfferEventSchema,
  connectorCatalogEntrySchema,
  connectorInstallableSkills,
  connectorMetaOf,
  type AppConnectFlowPayload,
  type Bot,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';
import {
  AppSkillsOffers,
  declaredSkills,
  missingSkillsByBot,
  type SkillsOfferDeps,
} from '../../src/apps/skills-offer.js';

/**
 * D73 P3 §7.6：目录条目 `_meta.skills`（兼容旧字符串形态）+ 提示逻辑——只有「声明了带来源的技能 ∧
 * 有被授权的 Bot ∧ 该 Bot 还没有同名技能」才出现提示；安装只走 `SkillImporter.import`
 * （skill_import 审批），来源取自目录。
 */

const SKILL = {
  name: 'acme-guide',
  source: 'https://example.com/acme/skills.git',
  description: 'How to use Acme',
};

function entry(skills: unknown[]): ConnectorCatalogEntry {
  return connectorCatalogEntrySchema.parse({
    name: 'com.acme/mcp',
    title: 'Acme',
    description: 'Acme test connector',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.test/mcp' }],
    _meta: {
      [CONNECTOR_META_KEY]: {
        slug: 'acme',
        icon: 'acme.svg',
        category: 'other',
        tier: 'community',
        auth: { kind: 'oauth', registration: 'auto', clientRef: null },
        skills,
        privacyPolicy: 'https://acme.test/privacy',
        releaseGate: 'acme',
      },
    },
  });
}

describe('catalog skills schema', () => {
  it('stays backwards compatible: string entries parse but are not installable', () => {
    const legacy = entry(['some-library-skill']);
    expect(connectorMetaOf(legacy).skills).toEqual(['some-library-skill']);
    expect(connectorInstallableSkills(connectorMetaOf(legacy))).toEqual([]);
    expect(declaredSkills(legacy)).toEqual([]);
    const mixed = entry(['legacy', SKILL]);
    expect(declaredSkills(mixed)).toHaveLength(1);
    expect(entry([]).name).toBe('com.acme/mcp');
  });

  it('defaults description and keeps ref / subdirectory', () => {
    const parsed = entry([
      { name: 'a-b', source: 'https://example.com/x/y.git', ref: 'v1', subdirectory: 'skills/a-b' },
    ]);
    expect(declaredSkills(parsed)[0]).toEqual({
      name: 'a-b',
      source: 'https://example.com/x/y.git',
      ref: 'v1',
      subdirectory: 'skills/a-b',
      description: '',
    });
  });

  it.each([
    ['http source', { ...SKILL, source: 'http://example.com/x.git' }],
    ['local path', { ...SKILL, source: '/home/me/skills' }],
    ['file url', { ...SKILL, source: 'file:///home/me/skills' }],
    ['bad name', { ...SKILL, name: 'Acme Guide' }],
    ['traversing subdirectory', { ...SKILL, subdirectory: '../outside' }],
    ['absolute subdirectory', { ...SKILL, subdirectory: '/etc' }],
  ])('rejects %s', (_label, skill) => {
    expect(() => entry([skill])).toThrow();
  });
});

describe('missingSkillsByBot', () => {
  const holders = [
    { botId: 'b1', botName: 'One', installed: new Set<string>() },
    { botId: 'b2', botName: 'Two', installed: new Set(['acme-guide']) },
  ];

  it('lists only the bots that miss a declared skill', () => {
    const result = missingSkillsByBot(entry([SKILL]), holders);
    expect(result).toEqual([
      {
        botId: 'b1',
        botName: 'One',
        skills: [{ name: 'acme-guide', description: 'How to use Acme', source: SKILL.source }],
      },
    ]);
  });

  it('offers nothing without declared skills or without holders', () => {
    expect(missingSkillsByBot(entry([]), holders)).toEqual([]);
    expect(missingSkillsByBot(entry(['legacy']), holders)).toEqual([]);
    expect(missingSkillsByBot(entry([SKILL]), [])).toEqual([]);
  });

  it('only offers the missing part of several skills', () => {
    const two = entry([SKILL, { ...SKILL, name: 'acme-extra' }]);
    const result = missingSkillsByBot(two, [
      { botId: 'b1', botName: 'One', installed: new Set(['acme-guide']) },
    ]);
    expect(result[0]?.skills.map((s) => s.name)).toEqual(['acme-extra']);
  });
});

interface Harness {
  service: AppSkillsOffers;
  emitted: Array<{ name: string; payload: unknown }>;
  importer: { import: ReturnType<typeof vi.fn> };
  installed: Map<string, string[]>;
  holders: Set<string>;
  pendingApprovals: unknown[];
  fire(payload: Partial<AppConnectFlowPayload>): void;
}

function harness(
  skills: unknown[],
  options: { catalogHasEntry?: boolean; entryOverride?: ConnectorCatalogEntry } = {},
): Harness {
  const installed = new Map<string, string[]>([
    ['b1', []],
    ['b2', []],
  ]);
  const holders = new Set(['b1']);
  const listeners: Array<(payload: AppConnectFlowPayload) => void> = [];
  const emitted: Harness['emitted'] = [];
  const pendingApprovals: unknown[] = [];
  const importer = {
    import: vi.fn(async () => ({ status: 'submitted' as const, approvalId: 'appr_1' })),
  };
  const bot = (id: string): Bot => ({ id, name: `Bot ${id}` }) as unknown as Bot;
  const deps: SkillsOfferDeps = {
    catalog: {
      get: (id) =>
        id === 'acme' && options.catalogHasEntry !== false
          ? (options.entryOverride ?? entry(skills))
          : null,
    },
    store: {
      get: (id) =>
        id === 'conn_1'
          ? ({ id, connectorId: 'acme' } as unknown as ReturnType<SkillsOfferDeps['store']['get']>)
          : null,
    },
    skills: {
      listForBot: (botId) => (installed.get(botId) ?? []).map((name) => ({ name }) as never),
    },
    importer: importer as unknown as SkillsOfferDeps['importer'],
    approvals: { list: () => pendingApprovals as never },
    bots: {
      get: (id) => (installed.has(id) ? bot(id) : null),
      listAppConnectionHolders: () => [...holders].map(bot),
    },
    conversations: { openDirect: (botId) => ({ conversation: { id: `conv_${botId}` } }) },
    events: {
      on: ((name: string, handler: (payload: AppConnectFlowPayload) => void) => {
        if (name === 'apps.connect_flow') listeners.push(handler);
        return () => undefined;
      }) as never,
      emit: ((name: string, payload: unknown) => {
        emitted.push({ name, payload });
      }) as never,
    },
    logger: { warn: () => undefined },
    clock: { now: () => 0 } as never,
  };
  return {
    service: new AppSkillsOffers(deps),
    emitted,
    importer,
    installed,
    holders,
    pendingApprovals,
    fire: (payload) =>
      listeners.forEach((l) =>
        l({ flowId: 'f', phase: 'done', ...payload } as AppConnectFlowPayload),
      ),
  };
}

describe('AppSkillsOffers: offer logic', () => {
  it('emits apps.skills_offer once connect is done when a granted bot misses a declared skill', () => {
    const h = harness([SKILL]);
    h.service.start();
    h.fire({ connectionId: 'conn_1' });
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.name).toBe('apps.skills_offer');
    const payload = appSkillsOfferEventSchema.parse(h.emitted[0]?.payload);
    expect(payload).toMatchObject({ connectionId: 'conn_1', connectorId: 'acme', botIds: ['b1'] });
    expect(payload.skills.map((s) => s.name)).toEqual(['acme-guide']);
  });

  it('stays quiet without declared skills', () => {
    const h = harness([]);
    h.service.start();
    h.fire({ connectionId: 'conn_1' });
    expect(h.emitted).toEqual([]);
  });

  it('stays quiet when no bot is granted the connection', () => {
    const h = harness([SKILL]);
    h.holders.clear();
    h.service.start();
    h.fire({ connectionId: 'conn_1' });
    expect(h.emitted).toEqual([]);
  });

  it('stays quiet when the granted bot already has the skill', () => {
    const h = harness([SKILL]);
    h.installed.set('b1', ['acme-guide']);
    h.service.start();
    h.fire({ connectionId: 'conn_1' });
    expect(h.emitted).toEqual([]);
  });

  it('ignores flows that are not done or carry no connection, and stops after stop()', () => {
    const h = harness([SKILL]);
    h.service.start();
    h.fire({ phase: 'reviewing_tools', connectionId: 'conn_1' });
    h.fire({ phase: 'failed', connectionId: 'conn_1' });
    h.fire({});
    expect(h.emitted).toEqual([]);
    h.service.start(); // idempotent
    h.fire({ connectionId: 'conn_1' });
    expect(h.emitted).toHaveLength(1);
  });

  it('survives an unknown connection in the event (logged, not thrown)', () => {
    const h = harness([SKILL]);
    h.service.start();
    expect(() => h.fire({ connectionId: 'conn_gone' })).not.toThrow();
    expect(h.emitted).toEqual([]);
  });

  it('offersFor: empty when the entry left the catalog', () => {
    const h = harness([SKILL], { catalogHasEntry: false });
    expect(h.service.offersFor('conn_1')).toMatchObject({ connectorId: 'acme', bots: [] });
  });
});

describe('AppSkillsOffers.install', () => {
  it('submits one skill_import via the importer, with the catalog source (not caller input)', async () => {
    const h = harness([{ ...SKILL, ref: 'v1', subdirectory: 'skills/acme-guide' }]);
    const out = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(out.results).toEqual([
      { name: 'acme-guide', status: 'submitted', approvalId: 'appr_1' },
    ]);
    expect(h.importer.import).toHaveBeenCalledWith({
      botId: 'b1',
      conversationId: 'conv_b1',
      sourceUrl: SKILL.source,
      ref: 'v1',
      subdirectory: 'skills/acme-guide',
      expectedName: 'acme-guide',
    });
  });

  it('a skill whose SKILL.md name differs is reported as mismatch, never re-offered or retried', async () => {
    const h = harness([SKILL]);
    h.importer.import.mockRejectedValueOnce(
      new AppError('SKILL_IMPORT_FAILED', '来源里的技能叫 other，与目录声明的 acme-guide 不一致', {
        nameMismatch: true,
        expected: 'acme-guide',
        actual: 'other',
      }),
    );
    expect(h.service.offersFor('conn_1').bots).toHaveLength(1);
    const first = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(first.results).toEqual([
      { name: 'acme-guide', status: 'mismatch', error: expect.stringContaining('不一致') },
    ]);
    // the offer is gone (no offer loop), the event is quiet, and a retry does not clone again
    expect(h.service.offersFor('conn_1').bots).toEqual([]);
    expect(h.service.offerAfterConnect('conn_1')).toBe(false);
    h.importer.import.mockClear();
    const second = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(second.results[0]?.status).toBe('mismatch');
    expect(h.importer.import).not.toHaveBeenCalled();
  });

  it('a different failure is not remembered as a mismatch', async () => {
    const h = harness([SKILL]);
    h.importer.import.mockRejectedValueOnce(new AppError('SKILL_IMPORT_FAILED', '克隆失败'));
    const first = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(first.results[0]?.status).toBe('failed');
    expect(h.service.offersFor('conn_1').bots).toHaveLength(1);
  });

  it('re-checks the source at install time (remote directory entries / stale caches)', async () => {
    const unsafe = [
      'https://user:pw@example.com/acme/skills.git',
      'https://127.0.0.1/acme/skills.git',
      'https://localhost/acme/skills.git',
      'http://example.com/acme/skills.git',
    ];
    for (const source of unsafe) {
      // bypass the schema the way a stale cache / bug could: patch the already-parsed entry
      const patched = entry([SKILL]);
      (connectorMetaOf(patched).skills[0] as { source: string }).source = source;
      const h = harness([SKILL], { entryOverride: patched });
      const out = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
      expect(out.results[0]?.status, source).toBe('failed');
      expect(h.importer.import, source).not.toHaveBeenCalled();
    }
  });

  it('refuses a bot that does not hold the connection, an unknown connection and unknown names', async () => {
    const h = harness([SKILL]);
    await expect(h.service.install({ connectionId: 'conn_1', botId: 'b2' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(h.service.install({ connectionId: 'nope', botId: 'b1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      h.service.install({ connectionId: 'conn_1', botId: 'b1', names: ['not-declared'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.importer.import).not.toHaveBeenCalled();
  });

  it('skips skills the bot already has and honours names', async () => {
    const h = harness([SKILL, { ...SKILL, name: 'acme-extra' }]);
    h.installed.set('b1', ['acme-guide']);
    const all = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(all.results.map((r) => [r.name, r.status])).toEqual([['acme-extra', 'submitted']]);
    h.importer.import.mockClear();
    const named = await h.service.install({
      connectionId: 'conn_1',
      botId: 'b1',
      names: ['acme-guide'],
    });
    expect(named.results).toEqual([{ name: 'acme-guide', status: 'installed' }]);
    expect(h.importer.import).not.toHaveBeenCalled();
  });

  it('does not stack a second card for a source that is already waiting', async () => {
    const h = harness([SKILL]);
    h.pendingApprovals.push({
      id: 'appr_old',
      kind: 'skill_import',
      status: 'pending',
      botId: 'b1',
      payload: { sourceUrl: SKILL.source },
    });
    const out = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(out.results).toEqual([
      { name: 'acme-guide', status: 'pending', approvalId: 'appr_old' },
    ]);
    expect(h.importer.import).not.toHaveBeenCalled();
  });

  it('reports importer failures and multi-skill repositories per skill', async () => {
    const h = harness([SKILL, { ...SKILL, name: 'acme-extra' }]);
    h.importer.import
      .mockRejectedValueOnce(new Error('clone failed'))
      .mockResolvedValueOnce({ status: 'candidates', candidates: [] });
    const out = await h.service.install({ connectionId: 'conn_1', botId: 'b1' });
    expect(out.results[0]).toMatchObject({
      name: 'acme-guide',
      status: 'failed',
      error: 'clone failed',
    });
    expect(out.results[1]).toMatchObject({ name: 'acme-extra', status: 'failed' });
    expect(out.results[1]?.error).toContain('subdirectory');
  });
});
