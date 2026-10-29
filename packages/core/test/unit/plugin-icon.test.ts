import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pluginIconDataUri } from '../../src/plugins/icon.js';

/**
 * Plugin summary icon projection: a declared icon is inlined as a data URI, and every
 * unusable case (no declaration, missing file, wrong format, oversized, escapes the
 * plugin directory) degrades to null so the renderer shows its default icon.
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-icon-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function pluginDir(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('pluginIconDataUri', () => {
  it('inlines an SVG icon declared in the manifest', () => {
    const dir = pluginDir('svg');
    writeFileSync(path.join(dir, 'icon.svg'), SVG);
    const uri = pluginIconDataUri(dir, { icon: 'icon.svg' });
    expect(uri).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
  });

  it('inlines a PNG icon (magic bytes checked, not just the extension)', () => {
    const dir = pluginDir('png');
    writeFileSync(path.join(dir, 'icon.png'), PNG);
    expect(pluginIconDataUri(dir, { icon: 'icon.png' })).toMatch(/^data:image\/png;base64,/);
  });

  it('returns null without a declaration, a missing file, a bad payload or an escape', () => {
    const dir = pluginDir('bad');
    writeFileSync(path.join(dir, 'icon.svg'), 'not an svg');
    expect(pluginIconDataUri(dir, null)).toBeNull();
    expect(pluginIconDataUri(dir, { icon: undefined })).toBeNull();
    expect(pluginIconDataUri(dir, { icon: 'missing.svg' })).toBeNull();
    expect(pluginIconDataUri(dir, { icon: 'icon.svg' })).toBeNull();
    const outside = path.join(root, 'outside.svg');
    writeFileSync(outside, SVG);
    expect(pluginIconDataUri(dir, { icon: '../outside.svg' })).toBeNull();
  });

  it('ignores oversized icons', () => {
    const dir = pluginDir('huge');
    writeFileSync(path.join(dir, 'icon.svg'), `<svg>${'x'.repeat(300 * 1024)}</svg>`);
    expect(pluginIconDataUri(dir, { icon: 'icon.svg' })).toBeNull();
  });
});
