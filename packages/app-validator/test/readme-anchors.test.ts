import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Every check id used in src/ has an anchor in README.md, and every README anchor is a real id. */
const root = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('README check list', () => {
  const idPattern = /'((?:manifest|remote|auth|tool|tools|ui|mcp)\.[a-z0-9-]+)'/g;
  const ids = new Set<string>();
  for (const file of sourceFiles(join(root, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(idPattern)) ids.add(match[1] as string);
  }
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const anchors = new Set(
    [...readme.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map((m) => m[1] as string),
  );

  it('documents every check id', () => {
    const missing = [...ids].filter((id) => !anchors.has(id.replaceAll('.', '-')));
    expect(missing).toEqual([]);
    expect(ids.size).toBeGreaterThan(40);
  });

  it('has no anchor for a check that does not exist', () => {
    const known = new Set([...ids].map((id) => id.replaceAll('.', '-')));
    expect([...anchors].filter((anchor) => !known.has(anchor))).toEqual([]);
  });
});
