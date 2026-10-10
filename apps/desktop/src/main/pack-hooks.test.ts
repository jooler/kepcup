import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const hooks = require('../../scripts/pack-hooks.cjs') as {
  FORBIDDEN_MARKERS: string[];
  findForbiddenMarker(text: string): string | null;
};

describe('afterPack forbidden markers', () => {
  test('the page-level core RPC e2e seam is forbidden in packaged bundles', () => {
    expect(hooks.FORBIDDEN_MARKERS).toContain('__kepcupRpc');
    // A renderer bundle that still contains the seam is caught; a clean one is not.
    const leaked = 'a.b(function(){window.__kepcupRpc=(e,t)=>core.call(e,t)})';
    expect(hooks.findForbiddenMarker(leaked)).toBe('__kepcupRpc');
    expect(hooks.findForbiddenMarker('console.log("clean bundle")')).toBeNull();
  });

  test('the existing seams stay forbidden', () => {
    for (const marker of [
      'KEPCUP_MOCK_LLM_URL',
      'KEPCUP_ONBOARDING',
      'KEPCUP_FILE_KEYSTORE_PATH',
    ]) {
      expect(hooks.findForbiddenMarker(`x ${marker} y`), marker).toBe(marker);
    }
  });
});
