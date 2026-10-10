import { describe, expect, it } from 'vitest';
import { connectorMetaOf, type ConnectorCatalogEntry } from '@kepcup/shared';
import { ConnectorCatalog } from '../../src/apps/catalog.js';
import {
  compareConnectorVersions,
  isSafeDirectoryRemoteUrl,
} from '../../src/apps/directory-merge.js';
import { fakeCatalogEntry } from '../support/catalog-connect-env.js';

/**
 * 远端（已验签）目录条目与打包快照的合并规则（D73 P3 §7.1）：经 `ConnectorCatalog`，
 * 因为发行门禁过滤发生在合并之后——「远端不能放开门禁」只有在整条链上才有意义。
 */

const logger = { warn() {} };

type EntryInput = Parameters<typeof fakeCatalogEntry>[0];
const entry = (input: Partial<EntryInput> & { slug: string }): Record<string, unknown> =>
  fakeCatalogEntry({ url: `https://${input.slug}.example.com/mcp`, ...input });

function catalog(options: {
  bundled: unknown[];
  remote: unknown[];
  gates?: readonly string[] | null;
}): ConnectorCatalog {
  return new ConnectorCatalog({
    env: {},
    logger,
    source: { entries: options.bundled, iconsDir: null },
    approvedGates: options.gates === undefined ? null : options.gates,
    directory: { revision: () => 1, entries: () => options.remote },
  });
}

const byName = (list: readonly ConnectorCatalogEntry[], name: string) =>
  list.find((item) => item.name === name);

describe('compareConnectorVersions', () => {
  it('orders semver, pre-releases and ignores build metadata', () => {
    expect(compareConnectorVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareConnectorVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareConnectorVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareConnectorVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareConnectorVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareConnectorVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareConnectorVersions('nope', '1.0.0')).toBeNull();
  });
});

describe('same name', () => {
  it('a strictly newer remote version wins; equal or older keeps the snapshot', () => {
    const bundled = entry({ slug: 'notion', version: '1.0.0', tier: 'builtin' });
    const newer = {
      ...entry({ slug: 'notion', version: '1.1.0', tier: 'builtin' }),
      title: 'Notion 2',
    };
    const same = { ...entry({ slug: 'notion', version: '1.0.0', tier: 'builtin' }), title: 'Same' };
    const older = {
      ...entry({ slug: 'notion', version: '0.9.0', tier: 'builtin' }),
      title: 'Older',
    };
    const get = (remote: unknown) =>
      byName(catalog({ bundled: [bundled], remote: [remote] }).list(), 'test.notion/mcp')!;
    expect(get(newer)).toMatchObject({ version: '1.1.0', title: 'Notion 2' });
    expect(get(same).title).toBe('Fake notion');
    expect(get(older).title).toBe('Fake notion');
  });

  it('never lowers a bundled builtin tier', () => {
    const bundled = entry({ slug: 'notion', version: '1.0.0', tier: 'builtin' });
    for (const tier of ['verified', 'community'] as const) {
      const remote = entry({ slug: 'notion', version: '2.0.0', tier });
      const merged = byName(
        catalog({ bundled: [bundled], remote: [remote] }).list(),
        'test.notion/mcp',
      )!;
      expect(merged.version).toBe('2.0.0');
      expect(connectorMetaOf(merged).tier).toBe('builtin');
    }
  });

  it('keeps the snapshot release gate: a remote entry cannot open a closed gate', () => {
    const bundled = entry({
      slug: 'notion',
      version: '1.0.0',
      tier: 'builtin',
      releaseGate: 'closed',
    });
    const remote = entry({
      slug: 'notion',
      version: '2.0.0',
      tier: 'builtin',
      releaseGate: 'open',
    });
    const gated = catalog({ bundled: [bundled], remote: [remote], gates: ['open'] });
    expect(gated.list()).toEqual([]);
    expect(gated.get('notion')).toBeNull();
    // ... and the closed gate in the snapshot stays authoritative even if later opened.
    const opened = catalog({ bundled: [bundled], remote: [remote], gates: ['closed'] });
    expect(connectorMetaOf(opened.get('notion')!).releaseGate).toBe('closed');
  });

  it('pins the endpoint, auth, whoami and icon of a bundled builtin entry', () => {
    const bundled = entry({
      slug: 'notion',
      version: '1.0.0',
      tier: 'builtin',
      whoami: { tool: 'me', labelPath: 'name' },
    });
    const remote = entry({
      slug: 'notion',
      version: '1.1.0',
      tier: 'builtin',
      registration: 'preregistered',
      whoami: { tool: 'evil', labelPath: 'x' },
    });
    (remote['remotes'] as Array<{ url: string }>)[0]!.url = 'https://evil.example.com/mcp';
    (remote['packages'] as unknown) = [
      { registryType: 'mcpb', identifier: 'https://evil.example.com/x.mcpb' },
    ];
    (remote['_meta'] as Record<string, Record<string, unknown>>)['app.kepcup/connector']!['icon'] =
      'other.svg';
    const merged = byName(
      catalog({ bundled: [bundled], remote: [remote] }).list(),
      'test.notion/mcp',
    )!;
    expect(merged.version).toBe('1.1.0');
    expect(merged.remotes[0]!.url).toBe('https://notion.example.com/mcp');
    expect(merged.packages).toEqual([]);
    const meta = connectorMetaOf(merged);
    expect(meta.auth.registration).toBe('auto');
    expect(meta.whoami?.tool).toBe('me');
    expect(meta.icon).toBe('notion.svg');
  });

  it('lets a remote toolPolicy only raise risk of snapshot tools; unknown tools only as destructive', () => {
    const bundled = entry({
      slug: 'notion',
      version: '1.0.0',
      tier: 'builtin',
      toolPolicy: { a: { risk: 'destructive' }, b: { risk: 'write' } },
    });
    const remote = entry({
      slug: 'notion',
      version: '1.1.0',
      tier: 'builtin',
      toolPolicy: {
        a: { risk: 'read' },
        b: { risk: 'destructive' },
        // not in the snapshot: only destructive is accepted (read / write would loosen W5's default)
        c: { risk: 'write' },
        delete_workspace: { risk: 'read' },
        wipe_all: { risk: 'destructive' },
      },
    });
    const merged = byName(
      catalog({ bundled: [bundled], remote: [remote] }).list(),
      'test.notion/mcp',
    )!;
    expect(connectorMetaOf(merged).toolPolicy).toEqual({
      a: { risk: 'destructive' },
      b: { risk: 'destructive' },
      wipe_all: { risk: 'destructive' },
    });
  });

  it('pins the bundled builtin skills (a remote entry cannot re-point the skill source)', () => {
    const skill = (source: string) => ({
      name: 'notion-helper',
      source,
      description: '',
    });
    const withSkills = (e: Record<string, unknown>, skills: unknown[]) => {
      (e['_meta'] as Record<string, Record<string, unknown>>)['app.kepcup/connector']!['skills'] =
        skills;
      return e;
    };
    const bundled = withSkills(entry({ slug: 'notion', version: '1.0.0', tier: 'builtin' }), [
      skill('https://github.com/kepcup/notion-skill'),
    ]);
    const remote = withSkills(entry({ slug: 'notion', version: '1.1.0', tier: 'builtin' }), [
      skill('https://evil.example.com/skill'),
    ]);
    const merged = byName(
      catalog({ bundled: [bundled], remote: [remote] }).list(),
      'test.notion/mcp',
    )!;
    expect(merged.version).toBe('1.1.0');
    expect(connectorMetaOf(merged).skills).toEqual([
      { name: 'notion-helper', source: 'https://github.com/kepcup/notion-skill', description: '' },
    ]);
  });

  it('ignores a remote entry that changes the slug of a known name', () => {
    const bundled = entry({ slug: 'notion', version: '1.0.0', tier: 'builtin' });
    const remote = {
      ...entry({ slug: 'notionx', version: '2.0.0', tier: 'builtin' }),
      name: 'test.notion/mcp',
    };
    const list = catalog({ bundled: [bundled], remote: [remote] }).list();
    expect(list).toHaveLength(1);
    expect(list[0]!.version).toBe('1.0.0');
  });
});

describe('new remote entries', () => {
  it('adds verified and community entries to the catalog', () => {
    const bundled = entry({ slug: 'notion', tier: 'builtin' });
    const list = catalog({
      bundled: [bundled],
      remote: [
        entry({ slug: 'acme', tier: 'verified' }),
        entry({ slug: 'hobby', tier: 'community' }),
      ],
    }).list();
    expect(list.map((item) => [connectorMetaOf(item).slug, connectorMetaOf(item).tier])).toEqual([
      ['notion', 'builtin'],
      ['acme', 'verified'],
      ['hobby', 'community'],
    ]);
  });

  it('clamps a self-declared builtin to verified and drops developer tier', () => {
    const list = catalog({
      bundled: [],
      remote: [
        entry({ slug: 'sneaky', tier: 'builtin' }),
        entry({ slug: 'local', tier: 'developer' }),
      ],
    }).list();
    expect(list.map((item) => [connectorMetaOf(item).slug, connectorMetaOf(item).tier])).toEqual([
      ['sneaky', 'verified'],
    ]);
  });

  it('refuses a slug already owned by a bundled entry (impersonation) or by another remote entry', () => {
    const bundled = entry({ slug: 'notion', tier: 'builtin' });
    const squatter = { ...entry({ slug: 'notion', tier: 'verified' }), name: 'com.evil/notion' };
    const first = entry({ slug: 'acme', tier: 'verified' });
    const second = { ...entry({ slug: 'acme', tier: 'verified' }), name: 'com.other/acme' };
    const list = catalog({ bundled: [bundled], remote: [squatter, first, second] }).list();
    expect(list.map((item) => item.name)).toEqual(['test.notion/mcp', 'test.acme/mcp']);
  });

  it('skips invalid remote entries individually and keeps the rest', () => {
    const list = catalog({
      bundled: [],
      remote: [{ name: 'broken' }, entry({ slug: 'acme', tier: 'verified' })],
    }).list();
    expect(list.map((item) => item.name)).toEqual(['test.acme/mcp']);
  });

  it('remote-only entries are not subject to the vendor gates: the verified signature is the authority', () => {
    const remote = [
      entry({ slug: 'acme', tier: 'verified', releaseGate: 'unlisted' }),
      // copying a bundled gate string neither helps nor hurts: the declared gate is ignored
      entry({ slug: 'copycat', tier: 'community', releaseGate: 'notion' }),
    ];
    const bundled = [entry({ slug: 'notion', tier: 'builtin', releaseGate: 'notion' })];
    const closed = catalog({ bundled, remote, gates: [] }).list();
    // the bundled entry is gated out; the remote-only ones are shown
    expect(closed.map((e) => e.name)).toEqual(['test.acme/mcp', 'test.copycat/mcp']);
    expect(closed.every((e) => connectorMetaOf(e).releaseGate === 'directory')).toBe(true);
    const open = catalog({ bundled, remote, gates: ['notion'] });
    expect(open.list().map((e) => e.name)).toEqual([
      'test.notion/mcp',
      'test.acme/mcp',
      'test.copycat/mcp',
    ]);
    expect(open.isDirectorySourced('acme')).toBe(true);
    expect(open.isDirectorySourced('notion')).toBe(false);
  });

  it('rejects remote entries whose endpoint is not a public https hostname', () => {
    const urls = [
      'http://example.com/mcp',
      'https://127.0.0.1/mcp',
      'https://localhost/mcp',
      'https://app.localhost/mcp',
      'https://[::1]/mcp',
      'https://10.0.0.5/mcp',
      'https://user:pw@example.com/mcp',
      'https://intranet/mcp',
    ];
    for (const url of urls) {
      expect(isSafeDirectoryRemoteUrl(url), url).toBe(false);
      const bad = entry({ slug: 'bad', tier: 'verified', url });
      expect(catalog({ bundled: [], remote: [bad] }).list(), url).toEqual([]);
    }
    expect(isSafeDirectoryRemoteUrl('https://mcp.example.com:8443/v1')).toBe(true);
    // a loopback endpoint is also refused for a same-name update of a bundled entry
    const bundled = entry({ slug: 'notion', version: '1.0.0', tier: 'builtin' });
    const evil = entry({
      slug: 'notion',
      version: '2.0.0',
      tier: 'builtin',
      url: 'http://127.0.0.1:9/mcp',
    });
    expect(catalog({ bundled: [bundled], remote: [evil] }).list()[0]!.version).toBe('1.0.0');
  });

  it('gives remote-only entries no bundled icon (cannot borrow another app icon by filename)', () => {
    const c = new ConnectorCatalog({
      env: {},
      logger,
      source: {
        entries: [entry({ slug: 'notion', tier: 'builtin' })],
        iconsDir: '/definitely/missing',
      },
      approvedGates: null,
      directory: { revision: () => 1, entries: () => [entry({ slug: 'acme', tier: 'verified' })] },
    });
    expect(c.get('acme')).not.toBeNull();
    expect(c.iconSvg('acme')).toBeNull();
  });
});

describe('refresh', () => {
  it('re-merges when the directory revision changes', () => {
    let revision = 1;
    let remote: unknown[] = [];
    const c = new ConnectorCatalog({
      env: {},
      logger,
      source: { entries: [entry({ slug: 'notion', tier: 'builtin' })], iconsDir: null },
      approvedGates: null,
      directory: { revision: () => revision, entries: () => remote },
    });
    expect(c.list()).toHaveLength(1);
    remote = [entry({ slug: 'acme', tier: 'verified' })];
    expect(c.list()).toHaveLength(1); // revision unchanged: cached
    revision = 2;
    expect(c.list()).toHaveLength(2);
    expect(c.get('acme')).not.toBeNull();
  });
});
