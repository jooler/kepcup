import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectorCatalogEntrySchema, connectorMetaOf } from '@kepcup/shared';
import { extractPath } from '../../src/apps/connections.js';

/**
 * 目录里 `whoami` 的字段路径要和真实工具的返回结构对得上（2026-10-10 用户在真实账号上调用
 * `notion-get-self` / `get_user` 得到的结构；下面是**结构相同、值为虚构**的样本，不含真实账号信息）。
 * 路径写错只会退回自动编号，但 `subjectPath` 取错会把不同账号并成一行，所以钉死。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalog = JSON.parse(
  readFileSync(path.join(repoRoot, 'apps/desktop/resources/connectors/catalog.json'), 'utf8'),
) as { connectors: unknown[] };

function whoamiOf(slug: string) {
  for (const raw of catalog.connectors) {
    const meta = connectorMetaOf(connectorCatalogEntrySchema.parse(raw));
    if (meta.slug === slug) return meta.whoami;
  }
  return undefined;
}

const NOTION_SELF = {
  workspace: { id: 'ws-0001', name: 'Example Workspace' },
  user: { type: 'person', id: 'user-0001', name: 'Alex Example', email: 'alex@example.com' },
};
const LINEAR_ME = {
  id: 'lin-user-0001',
  name: 'Alex Example',
  email: 'alex@example.com',
  displayName: 'alex',
  isAdmin: true,
  teams: [{ id: 'team-0001', name: 'Example', key: 'EXA' }],
};

describe('catalog whoami paths match the real tool output shapes', () => {
  it('notion: the account is the workspace (the token is bound to it), labelled by its name', () => {
    const who = whoamiOf('notion');
    expect(who?.tool).toBe('notion-get-self');
    expect(extractPath(NOTION_SELF, who?.labelPath ?? '')).toBe('Example Workspace');
    expect(extractPath(NOTION_SELF, who?.subjectPath ?? '')).toBe('ws-0001');
  });

  it('linear: get_user {"query":"me"}, labelled by email, keyed by the user id', () => {
    const who = whoamiOf('linear');
    expect(who?.tool).toBe('get_user');
    expect(who?.arguments).toEqual({ query: 'me' });
    expect(extractPath(LINEAR_ME, who?.labelPath ?? '')).toBe('alex@example.com');
    expect(extractPath(LINEAR_ME, who?.subjectPath ?? '')).toBe('lin-user-0001');
  });

  it('a result without the path yields undefined (falls back to the auto label)', () => {
    expect(extractPath({ unrelated: true }, whoamiOf('notion')?.subjectPath ?? '')).toBeUndefined();
  });
});
