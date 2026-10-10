import { describe, expect, it } from 'vitest';
import {
  MCP_APP_MIME,
  checkUiResource,
  checkUiTools,
  externalHosts,
  judgeCspEntry,
  uiResourceUriOf,
  uiResourceUris,
  type UiResourceFacts,
} from '../src/checks/apps-ui.js';
import type { ToolLike } from '../src/checks/tools.js';
import { find, labels } from './support.js';

const URI = 'ui://acme/board.html';
const uiTool: ToolLike = { name: 'show_board', _meta: { ui: { resourceUri: URI } } };

function facts(content: Record<string, unknown>, meta?: Record<string, unknown>): UiResourceFacts {
  return {
    uri: URI,
    read: {
      ok: true,
      contents: [
        { uri: URI, mimeType: MCP_APP_MIME, text: '<html><body>hi</body></html>', ...content },
      ],
      ...(meta !== undefined ? { meta } : {}),
    },
  };
}

describe('uiResourceUriOf', () => {
  it('reads the nested and the legacy flat spelling', () => {
    expect(uiResourceUriOf(uiTool)).toBe(URI);
    expect(uiResourceUriOf({ name: 'x', _meta: { 'ui/resourceUri': URI } })).toBe(URI);
    expect(uiResourceUriOf({ name: 'x' })).toBeNull();
    expect(uiResourceUris([uiTool, uiTool, { name: 'y' }])).toEqual([URI]);
  });
});

describe('judgeCspEntry', () => {
  it('rejects wildcards, bare schemes and keywords', () => {
    for (const entry of ['*', 'https:', 'data:', "'unsafe-inline'", "'self'"]) {
      expect(judgeCspEntry('connectDomains', entry)?.id).toBe('ui.csp-wildcard');
    }
  });

  it('warns about wildcard hosts and plaintext origins, accepts exact https', () => {
    expect(judgeCspEntry('resourceDomains', 'https://*.cdn.example.com')?.id).toBe('ui.csp-broad');
    expect(judgeCspEntry('connectDomains', 'http://api.example.com')?.id).toBe('ui.csp-insecure');
    expect(judgeCspEntry('connectDomains', 'http://127.0.0.1:3000')).toBeNull();
    expect(judgeCspEntry('connectDomains', 'https://api.example.com')).toBeNull();
    expect(judgeCspEntry('connectDomains', 'wss://live.example.com')).toBeNull();
  });

  it('rejects junk', () => {
    expect(judgeCspEntry('connectDomains', 42)?.id).toBe('ui.csp-invalid');
    expect(judgeCspEntry('connectDomains', '')?.id).toBe('ui.csp-invalid');
    expect(judgeCspEntry('connectDomains', 'not an origin')?.id).toBe('ui.csp-invalid');
    expect(judgeCspEntry('connectDomains', 'ftp://x.example.com')?.id).toBe('ui.csp-invalid');
  });
});

describe('checkUiResource', () => {
  it('passes a resource with explicit allowlists', () => {
    const checks = checkUiResource(
      URI,
      uiTool,
      facts({
        _meta: {
          ui: { csp: { connectDomains: ['https://api.acme.example'], resourceDomains: [] } },
        },
      }),
    );
    expect(labels({ checks }, 'error')).toEqual([]);
    expect(labels({ checks }, 'warn')).toEqual([]);
    expect(find({ checks }, 'ui.csp')?.severity).toBe('info');
  });

  it('accepts an empty csp object (no external access) and finds csp on the tool', () => {
    expect(
      labels(
        { checks: checkUiResource(URI, uiTool, facts({ _meta: { ui: { csp: {} } } })) },
        'error',
      ),
    ).toEqual([]);
    const toolWithCsp: ToolLike = {
      name: 't',
      _meta: { ui: { resourceUri: URI, csp: { connectDomains: [] } } },
    };
    expect(labels({ checks: checkUiResource(URI, toolWithCsp, facts({})) }, 'error')).toEqual([]);
  });

  it('errors when the CSP is not declared or not an object', () => {
    expect(labels({ checks: checkUiResource(URI, uiTool, facts({})) }, 'error')).toEqual([
      `ui.csp-missing[${URI}]`,
    ]);
    expect(
      labels(
        {
          checks: checkUiResource(URI, uiTool, facts({ _meta: { ui: { csp: 'default-src *' } } })),
        },
        'error',
      ),
    ).toEqual([`ui.csp-missing[${URI}]`]);
  });

  it('errors on wildcard allowlists', () => {
    const checks = checkUiResource(
      URI,
      uiTool,
      facts({
        _meta: {
          ui: { csp: { connectDomains: ['*'], resourceDomains: ['https://cdn.example.com'] } },
        },
      }),
    );
    expect(labels({ checks }, 'error')).toEqual([`ui.csp-wildcard[${URI}]`]);
    expect(checks.some((c) => c.id === 'ui.csp')).toBe(false);
  });

  it('errors on a non-ui:// URI, a failed read, an empty or oversized page; warns on the mime type', () => {
    expect(
      labels({ checks: checkUiResource('https://x.example.com/a', uiTool, undefined) }, 'error'),
    ).toEqual(['ui.resource-uri[https://x.example.com/a]']);
    expect(
      labels(
        {
          checks: checkUiResource(URI, uiTool, {
            uri: URI,
            read: { ok: false, error: 'not found' },
          }),
        },
        'error',
      ),
    ).toEqual([`ui.resource-missing[${URI}]`]);
    expect(labels({ checks: checkUiResource(URI, uiTool, undefined) }, 'error')).toEqual([
      `ui.resource-missing[${URI}]`,
    ]);
    const csp = { _meta: { ui: { csp: {} } } };
    expect(
      labels({ checks: checkUiResource(URI, uiTool, facts({ text: '', ...csp })) }, 'error'),
    ).toEqual([`ui.html-size[${URI}]`]);
    expect(
      labels(
        {
          checks: checkUiResource(
            URI,
            uiTool,
            facts({ text: 'x'.repeat(11 * 1024 * 1024), ...csp }),
          ),
        },
        'error',
      ),
    ).toEqual([`ui.html-size[${URI}]`]);
    expect(
      labels(
        { checks: checkUiResource(URI, uiTool, facts({ mimeType: 'text/html', ...csp })) },
        'warn',
      ),
    ).toEqual([`ui.mime[${URI}]`]);
  });

  it('warns about page references outside the allowlists', () => {
    const html =
      '<html><script src="https://cdn.evil.example/x.js"></script><img src="https://ok.example/i.png"></html>';
    expect(externalHosts(html).sort()).toEqual(['https://cdn.evil.example', 'https://ok.example']);
    const checks = checkUiResource(
      URI,
      uiTool,
      facts({ text: html, _meta: { ui: { csp: { resourceDomains: ['https://ok.example'] } } } }),
    );
    expect(labels({ checks }, 'warn')).toEqual([`ui.csp-undeclared-origin[${URI}]`]);
  });
});

describe('checkUiTools', () => {
  it('checks each distinct resource once', () => {
    const map = new Map<string, UiResourceFacts>([[URI, facts({ _meta: { ui: { csp: {} } } })]]);
    const checks = checkUiTools([uiTool, { ...uiTool, name: 'other' }], map);
    expect(checks.filter((c) => c.id === 'ui.resource')).toHaveLength(1);
  });
});
