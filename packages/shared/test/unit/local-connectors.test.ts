import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  CONNECTOR_META_KEY,
  LOCAL_CONNECTOR_GATE,
  LOCAL_CONNECTOR_ICON,
  LOCAL_CONNECTOR_SLUG_PATTERN,
  connectorSlugSchema,
  createLocalConnectorRecordSchema,
  isSafeDocUrl,
  isSafeLocalConnectorUrl,
  localConnectorName,
  localConnectorOrigin,
  localConnectorRecordSchema,
  localConnectorSlug,
  rpcEventSchemas,
  rpcMethodSchemas,
  sanitizeLocalConnectorText,
  setupRequirementSchema,
  settingsSchema,
} from '../../src/index.js';

/**
 * 本机连接契约（todo/local-connector-authoring.md §2.1）：记录 schema 强制的字段、slug 派生、
 * URL 与文本清洗、setup 需求 / 设置 / RPC / 事件的接入。
 */

const URL_OK = 'https://mcp.example.com/mcp';

function record(overrides: { meta?: Record<string, unknown>; entry?: Record<string, unknown> } = {}) {
  const slug = localConnectorSlug(localConnectorOrigin(URL_OK)!);
  return {
    entry: {
      name: localConnectorName(slug),
      title: 'Example',
      description: '示例服务',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: URL_OK }],
      packages: [],
      _meta: {
        [CONNECTOR_META_KEY]: {
          slug,
          icon: LOCAL_CONNECTOR_ICON,
          category: 'other',
          tier: 'developer',
          auth: {
            kind: 'oauth',
            registration: 'auto',
            clientRef: null,
            scopes: { default: [], write: [] },
          },
          toolPolicy: {},
          skills: [],
          ui: false,
          privacyPolicy: 'https://mcp.example.com/',
          releaseGate: LOCAL_CONNECTOR_GATE,
          ...overrides.meta,
        },
      },
      ...overrides.entry,
    },
    addedAt: 1,
  };
}

describe('slug 派生', () => {
  it('l + 12 位十六进制，满足目录 slug 规则，且只取决于 origin', () => {
    const slug = localConnectorSlug('https://mcp.example.com');
    expect(slug).toMatch(LOCAL_CONNECTOR_SLUG_PATTERN);
    expect(connectorSlugSchema.safeParse(slug).success).toBe(true);
    expect(localConnectorSlug('https://mcp.example.com')).toBe(slug);
    expect(localConnectorSlug('https://mcp.example.org')).not.toBe(slug);
    // 路径不同、origin 相同 → 同一个 slug（同一服务只能有一条）。
    expect(localConnectorOrigin('https://mcp.example.com/a')).toBe(
      localConnectorOrigin('https://MCP.example.com:443/b'),
    );
    // 十六进制里没有 o，所以永远撞不上宿主自有的 `app_local_*` 工具前缀。
    expect(slug).not.toBe('local');
  });
});

describe('isSafeLocalConnectorUrl', () => {
  it('只接受不带凭据 / 查询 / 片段的 https 域名地址', () => {
    expect(isSafeLocalConnectorUrl(URL_OK)).toBe(true);
    expect(isSafeLocalConnectorUrl('https://mcp.example.com:8443/mcp')).toBe(true);
    for (const bad of [
      'http://mcp.example.com/mcp',
      'https://127.0.0.1/mcp',
      'https://10.0.0.5/mcp',
      'https://[::1]/mcp',
      'https://0x7f000001/mcp',
      'https://localhost/mcp',
      'https://printer.local/mcp',
      'https://intranet/mcp',
      'https://svc.internal/mcp',
      'https://user:pw@mcp.example.com/mcp',
      'https://mcp.example.com/mcp?key=abc',
      'https://mcp.example.com/mcp#frag',
      'https://mcp.example.com/mcp?',
      'ftp://mcp.example.com/mcp',
      'javascript:alert(1)',
      'https://mcp.example.com/a b',
      'not a url',
      '',
    ]) {
      expect(isSafeLocalConnectorUrl(bad), bad).toBe(false);
    }
  });

  it('文档链接只要求 https 且不带凭据', () => {
    expect(isSafeDocUrl('https://docs.example.com/mcp?x=1#a')).toBe(true);
    expect(isSafeDocUrl('http://docs.example.com')).toBe(false);
    expect(isSafeDocUrl('https://u:p@docs.example.com')).toBe(false);
    expect(isSafeDocUrl('https://docs.example.com/\n')).toBe(false);
  });
});

describe('sanitizeLocalConnectorText', () => {
  it('剔除控制 / 双向 / 零宽字符，折叠空白，按码点截断', () => {
    expect(sanitizeLocalConnectorText('  Hello\n\tWorld  ', 50)).toBe('Hello World');
    // U+202E（从右到左覆盖）+ U+200B（零宽空格）+ U+0007（响铃）
    const evil = `A${String.fromCodePoint(0x202e)}B${String.fromCodePoint(0x200b)}C${String.fromCodePoint(7)}D`;
    expect(sanitizeLocalConnectorText(evil, 50)).toBe('A B C D');
    expect(sanitizeLocalConnectorText('一二三四五六七八九十', 4)).toBe('一二三四');
    expect(sanitizeLocalConnectorText('😀😀😀😀', 2)).toBe('😀😀');
    expect(sanitizeLocalConnectorText(' \n ', 10)).toBe('');
  });
});

describe('localConnectorRecordSchema', () => {
  it('接受合规记录', () => {
    expect(localConnectorRecordSchema.safeParse(record()).success).toBe(true);
  });

  it.each([
    ['tier 不是 developer', { meta: { tier: 'builtin' } }],
    ['认证不是 oauth', { meta: { auth: { kind: 'none', registration: 'auto', clientRef: null } } }],
    [
      '预注册客户端',
      {
        meta: {
          auth: {
            kind: 'oauth',
            registration: 'preregistered',
            clientRef: 'x',
            scopes: { default: [], write: [] },
          },
        },
      },
    ],
    ['releaseGate 不是 local（想借某个放行门禁混进发行目录）', { meta: { releaseGate: 'notion' } }],
    ['带 toolPolicy', { meta: { toolPolicy: { t: { risk: 'read' } } } }],
    ['带 whoami', { meta: { whoami: { tool: 't', labelPath: 'a' } } }],
    ['带随附技能', { meta: { skills: ['x'] } }],
    ['有界面', { meta: { ui: true } }],
    ['图标不是占位', { meta: { icon: 'notion.svg' } }],
    ['slug 与 origin 不符', { meta: { slug: 'lffffffffffff' } }],
    ['name 不在本机命名空间', { entry: { name: 'com.notion/mcp' } }],
    ['版本被改', { entry: { version: '9.9.9' } }],
    ['有 packages', { entry: { packages: [{ registryType: 'mcpb', identifier: 'x' }] } }],
    [
      '两个远端',
      {
        entry: {
          remotes: [
            { type: 'streamable-http', url: URL_OK },
            { type: 'streamable-http', url: 'https://other.example.com/mcp' },
          ],
        },
      },
    ],
    ['旧版 sse 远端', { entry: { remotes: [{ type: 'sse', url: URL_OK }] } }],
    ['http 远端', { entry: { remotes: [{ type: 'streamable-http', url: 'http://mcp.example.com/mcp' }] } }],
    ['标题含控制字符', { entry: { title: 'bad\ntitle' } }],
  ])('拒绝：%s', (_label, overrides) => {
    expect(localConnectorRecordSchema.safeParse(record(overrides)).success).toBe(false);
  });

  it('文档链接必须是 https', () => {
    expect(
      localConnectorRecordSchema.safeParse({ ...record(), sourceDocUrl: 'http://docs.example.com' })
        .success,
    ).toBe(false);
    expect(
      localConnectorRecordSchema.safeParse({ ...record(), sourceDocUrl: 'https://docs.example.com' })
        .success,
    ).toBe(true);
  });

  it('回环白名单只在显式注入时放行明文主机（生产 schema 永远严格）', () => {
    const loopbackUrl = 'http://127.0.0.1:4321/mcp';
    const slug = localConnectorSlug(localConnectorOrigin(loopbackUrl)!);
    const raw = record({
      meta: { slug },
      entry: {
        name: localConnectorName(slug),
        remotes: [{ type: 'streamable-http', url: loopbackUrl }],
      },
    });
    expect(localConnectorRecordSchema.safeParse(raw).success).toBe(false);
    expect(
      createLocalConnectorRecordSchema({ allowInsecureHosts: ['127.0.0.1'] }).safeParse(raw)
        .success,
    ).toBe(true);
    expect(
      createLocalConnectorRecordSchema({ allowInsecureHosts: ['127.0.0.2'] }).safeParse(raw).success,
    ).toBe(false);
  });
});

describe('接入点', () => {
  it('confirm-local-connector 是合法的 setup 需求，card 字段齐全才通过', () => {
    const card = {
      proposalId: 'p',
      title: 'Example',
      description: 'd',
      category: 'other',
      mcpUrl: URL_OK,
      mcpHost: 'mcp.example.com',
      authKind: 'oauth',
      registration: 'dcr',
      issuerHost: 'auth.example.com',
      scopes: [],
      tier: 'developer',
      warnings: ['w'],
      expiresAt: 1,
    };
    expect(
      setupRequirementSchema.safeParse({ kind: 'confirm-local-connector', proposalId: 'p', card })
        .success,
    ).toBe(true);
    expect(
      setupRequirementSchema.safeParse({
        kind: 'confirm-local-connector',
        proposalId: 'p',
        card: { ...card, tier: 'builtin' },
      }).success,
    ).toBe(false);
  });

  it('settings.apps.localConnectors 缺省为空，坏值回退为空而不让整个设置解析失败', () => {
    expect(settingsSchema.parse({}).apps.localConnectors).toEqual({});
    expect(settingsSchema.parse({ apps: { localConnectors: 'oops' } }).apps.localConnectors).toEqual(
      {},
    );
    expect(
      settingsSchema.parse({ apps: { localConnectors: { l1: { anything: true } } } }).apps
        .localConnectors,
    ).toEqual({ l1: { anything: true } });
  });

  it('RPC 与事件已登记；渲染端可调用，但 settings.update 不接受 localConnectors', () => {
    for (const name of [
      'apps.localConnectors.list',
      'apps.localConnectors.confirm',
      'apps.localConnectors.reject',
      'apps.localConnectors.remove',
    ] as const) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
    }
    expect(rpcEventSchemas['apps.catalog_changed']).toBeDefined();
    const patch = rpcMethodSchemas['settings.update'].input.parse({
      apps: { developerMode: true, localConnectors: { l1: {} } },
    });
    expect(patch.apps).toEqual({ developerMode: true });
  });
});
