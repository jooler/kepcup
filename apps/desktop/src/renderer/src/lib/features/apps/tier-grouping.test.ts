import { describe, expect, it } from 'vitest';
import type { AppCatalogEntry, AppConnectFlowPayload } from '@kepcup/shared';
import {
  catalogSections,
  catalogView,
  communityExpanded,
  directoryNoticeKey,
  isVerifiedTier,
  sortCatalog,
} from './app-catalog';
import { applyFlowEvent, confirmToolsDisabled, needsCommunityAck } from './connect-flow';

/** 分级信任的渲染端纯函数（D73 P3 §7.2）：目录分组 / 折叠、认证标识、社区首连确认。 */

function entry(
  connectorId: string,
  tier: AppCatalogEntry['tier'],
  overrides: Partial<AppCatalogEntry> = {},
): AppCatalogEntry {
  return {
    connectorId,
    name: `com.example/${connectorId}`,
    title: connectorId[0]!.toUpperCase() + connectorId.slice(1),
    description: `${connectorId} tools`,
    version: '1.0.0',
    privacyPolicy: 'https://example.com/privacy',
    category: 'productivity',
    tier,
    authKind: 'oauth',
    registration: 'auto',
    connectable: true,
    scopes: { default: [], write: [] },
    iconDataUri: null,
    connectedAccounts: 0,
    connectionIds: [],
    ...overrides,
  };
}

describe('catalogSections', () => {
  it('puts community entries in their own group and orders the rest builtin first', () => {
    const entries = [
      entry('zeta', 'verified'),
      entry('hobby', 'community'),
      entry('notion', 'builtin'),
      entry('acme', 'verified'),
      entry('wiki', 'community'),
      entry('linear', 'builtin'),
    ];
    const { main, community } = catalogSections(entries);
    expect(main.map((e) => e.connectorId)).toEqual(['notion', 'linear', 'zeta', 'acme']);
    expect(community.map((e) => e.connectorId)).toEqual(['hobby', 'wiki']);
  });

  it('keeps the caller order within a group and does not mutate the input', () => {
    const entries = [entry('b', 'verified'), entry('a', 'verified'), entry('c', 'community')];
    const copy = [...entries];
    const { main } = catalogSections(entries);
    expect(main.map((e) => e.connectorId)).toEqual(['b', 'a']);
    expect(entries).toEqual(copy);
  });

  it('works after search / category filtering and sorting (the view the grid uses)', () => {
    const entries = [
      entry('acme', 'verified', { category: 'development' }),
      entry('hobby', 'community', { category: 'development' }),
      entry('notion', 'builtin'),
      entry('bad', 'community', { connectable: false }),
    ];
    const view = catalogView(entries, { category: 'development' });
    const { main, community } = catalogSections(view);
    expect(main.map((e) => e.connectorId)).toEqual(['acme']);
    expect(community.map((e) => e.connectorId)).toEqual(['hobby']);
    // sorting puts unavailable entries last within the community group too
    const sorted = catalogSections(sortCatalog(entries)).community;
    expect(sorted.map((e) => e.connectorId)).toEqual(['hobby', 'bad']);
  });

  it('is empty-safe: no community entries means no community group', () => {
    expect(catalogSections([entry('notion', 'builtin')]).community).toEqual([]);
    expect(catalogSections([])).toEqual({ main: [], community: [] });
  });
});

describe('badges and notices', () => {
  it('only verified entries get the 认证 badge', () => {
    expect(isVerifiedTier('verified')).toBe(true);
    for (const tier of ['builtin', 'community', 'developer'] as const) {
      expect(isVerifiedTier(tier)).toBe(false);
    }
  });

  it('only a degraded directory sync nags the user', () => {
    expect(directoryNoticeKey('degraded')).toBe('apps.directory.degraded');
    for (const state of ['ok', 'stale', 'disabled'] as const) {
      expect(directoryNoticeKey(state)).toBeNull();
    }
  });
});

describe('community first-connect acknowledgement', () => {
  it('requires the checkbox only for community apps', () => {
    expect(needsCommunityAck('community')).toBe(true);
    for (const tier of ['builtin', 'verified', 'developer', undefined] as const) {
      expect(needsCommunityAck(tier)).toBe(false);
    }
  });

  it('keeps 确认并完成连接 disabled until acknowledged (and while busy)', () => {
    expect(confirmToolsDisabled({ busy: false, tier: 'community', acknowledged: false })).toBe(
      true,
    );
    expect(confirmToolsDisabled({ busy: false, tier: 'community', acknowledged: true })).toBe(
      false,
    );
    expect(confirmToolsDisabled({ busy: true, tier: 'community', acknowledged: true })).toBe(true);
    expect(confirmToolsDisabled({ busy: false, tier: 'verified', acknowledged: false })).toBe(
      false,
    );
    expect(confirmToolsDisabled({ busy: false, tier: undefined, acknowledged: false })).toBe(false);
  });

  it('carries the tier from the reviewing_tools event through later events of the flow', () => {
    const review: AppConnectFlowPayload = {
      flowId: 'f1',
      phase: 'reviewing_tools',
      tier: 'community',
      tools: [],
    };
    const flows = applyFlowEvent({}, review);
    expect(flows['f1']!.tier).toBe('community');
    const after = applyFlowEvent(flows, { flowId: 'f1', phase: 'done' });
    expect(after['f1']!.tier).toBe('community');
    expect(applyFlowEvent({}, { flowId: 'f2', phase: 'discovering' })['f2']!.tier).toBeUndefined();
  });
});

describe('communityExpanded', () => {
  const base = { open: false, query: '', mainCount: 3, communityCount: 2 };
  it('is collapsed by default and opens on demand', () => {
    expect(communityExpanded(base)).toBe(false);
    expect(communityExpanded({ ...base, open: true })).toBe(true);
  });
  it('opens while searching and when it is the only group with matches', () => {
    expect(communityExpanded({ ...base, query: 'hob' })).toBe(true);
    expect(communityExpanded({ ...base, query: '   ' })).toBe(false);
    expect(communityExpanded({ ...base, mainCount: 0 })).toBe(true);
  });
  it('never opens a group that has no entries', () => {
    expect(communityExpanded({ ...base, communityCount: 0, open: true, query: 'x' })).toBe(false);
  });
  it('the grid empty state depends on the filtered total across groups', () => {
    const none = catalogView([entry('a', 'community')], { query: 'zzz' });
    expect(none).toEqual([]);
    const only = catalogSections(catalogView([entry('a', 'community')], { query: 'a' }));
    expect(only.main).toEqual([]);
    expect(only.community).toHaveLength(1);
  });
});
