import { describe, expect, it } from 'vitest';
import {
  PLUGIN_MARKET_ICON_MAX_BYTES,
  isPluginIconDataUri,
  pluginIconDataUriFromBytes,
} from '../../src/index.js';

/**
 * Shared icon codec: the same extension / magic-byte / size rules back the installed-tree
 * projection (PluginSummary.iconDataUri) and the signed marketplace index (summary.icon).
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('pluginIconDataUriFromBytes', () => {
  it('inlines SVG and PNG bytes as data URIs', () => {
    expect(pluginIconDataUriFromBytes('icon.svg', Buffer.from(SVG))).toBe(
      `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`,
    );
    expect(pluginIconDataUriFromBytes('ICON.PNG', PNG)).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`,
    );
  });

  it('rejects an unsupported extension, bad magic bytes and an empty payload', () => {
    expect(pluginIconDataUriFromBytes('icon.gif', Buffer.from(SVG))).toBeNull();
    expect(pluginIconDataUriFromBytes('icon.png', Buffer.from(SVG))).toBeNull();
    expect(pluginIconDataUriFromBytes('icon.svg', Buffer.from('not an svg'))).toBeNull();
    expect(pluginIconDataUriFromBytes('icon.svg', Buffer.alloc(0))).toBeNull();
  });

  it('honors the market cap independently of the installed cap', () => {
    const icon = Buffer.from(`<svg>${'x'.repeat(PLUGIN_MARKET_ICON_MAX_BYTES)}</svg>`);
    expect(pluginIconDataUriFromBytes('icon.svg', icon)).not.toBeNull();
    expect(
      pluginIconDataUriFromBytes('icon.svg', icon, {
        maxBytes: PLUGIN_MARKET_ICON_MAX_BYTES,
      }),
    ).toBeNull();
  });
});

describe('isPluginIconDataUri', () => {
  it('accepts only image data URIs with a base64 body', () => {
    expect(
      isPluginIconDataUri(
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      ),
    ).toBe(true);
    expect(isPluginIconDataUri('https://example.com/icon.svg')).toBe(false);
    expect(isPluginIconDataUri('javascript:alert(1)')).toBe(false);
    expect(isPluginIconDataUri('data:text/html;base64,PGgxPnhpPC9oMT4=')).toBe(false);
    expect(isPluginIconDataUri('data:image/svg+xml;base64,not base64!')).toBe(false);
  });
});
