import { describe, expect, it } from 'vitest';
import { interpretAppConnectionSelection, type CatalogConnectionRef } from '../../src/index.js';

const rows: CatalogConnectionRef[] = [
  { id: 'conn_nt', connectorId: 'notion', label: 'Notion' },
  { id: 'conn_cf', connectorId: 'cloudflare', label: 'Cloudflare' },
];

describe('interpretAppConnectionSelection', () => {
  it('adds a connector slug onto the grants the bot already has', () => {
    expect(interpretAppConnectionSelection(['conn_nt'], ['cloudflare'], rows)).toEqual({
      ok: true,
      ids: ['conn_nt', 'conn_cf'],
    });
    expect(interpretAppConnectionSelection(['conn_nt'], ['Cloudflare'], rows)).toEqual({
      ok: true,
      ids: ['conn_nt', 'conn_cf'],
    });
  });

  it('replaces the list when every value is already a connection id', () => {
    expect(interpretAppConnectionSelection(['conn_nt', 'conn_cf'], ['conn_cf'], rows)).toEqual({
      ok: true,
      ids: ['conn_cf'],
    });
    expect(interpretAppConnectionSelection(['conn_nt'], [], rows)).toEqual({ ok: true, ids: [] });
  });

  it('swaps the bot’s existing account of the same app instead of keeping both', () => {
    const two = [...rows, { id: 'conn_cf_2', connectorId: 'cloudflare', label: '其他账号' }];
    expect(
      interpretAppConnectionSelection(['conn_cf', 'conn_nt'], ['conn_cf_2', 'notion'], two),
    ).toEqual({
      ok: true,
      ids: ['conn_cf_2', 'conn_nt'],
    });
  });

  it('does not guess when a slug matches more than one account', () => {
    const two = [...rows, { id: 'conn_cf_2', connectorId: 'cloudflare', label: '其他账号' }];
    expect(interpretAppConnectionSelection(['conn_nt'], ['cloudflare'], two)).toEqual({
      ok: false,
      connectionId: 'cloudflare',
      reason: 'ambiguous',
    });
  });

  it('reports a ref that matches nothing', () => {
    expect(interpretAppConnectionSelection([], ['github'], rows)).toEqual({
      ok: false,
      connectionId: 'github',
      reason: 'missing',
    });
  });
});
