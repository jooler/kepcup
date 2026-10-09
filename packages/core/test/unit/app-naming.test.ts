import { describe, expect, it } from 'vitest';
import { APP_TOOL_NAME_MAX } from '@kepcup/shared';
import { appToolName } from '../../src/apps/naming.js';
import { mcpToolName } from '../../src/mcp/service.js';
import { fitToolName, MAX_AGENT_TOOL_NAME } from '../../src/agent/external/capabilities.js';
import { HOST_MCP_SERVER_PREFIX } from '../../src/agent/external/acp/client.js';

/** D73 P1 §5.7：`appToolName(slug, tool)` 命名规则与碰撞处理。 */

describe('appToolName', () => {
  it('is app_{slug}_{tool} for ordinary names', () => {
    expect(appToolName('github', 'create_issue')).toBe('app_github_create_issue');
    expect(appToolName('notion', 'search-pages')).toBe('app_notion_search-pages');
  });

  it('sanitizes to [A-Za-z0-9_-]', () => {
    const name = appToolName('github', 'repos/list.all items');
    expect(name).toBe('app_github_repos_list_all_items');
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps names within the limit; truncation adds a short hash of the full name', () => {
    const long = 'a'.repeat(80);
    const name = appToolName('github', long);
    expect(name.length).toBe(APP_TOOL_NAME_MAX);
    expect(name.startsWith('app_github_aaaa')).toBe(true);
    expect(name).toMatch(/_[0-9a-f]{8}$/);
    // Same prefix, different tails: the hash keeps them apart (no truncation collision).
    const other = appToolName('github', `${'a'.repeat(79)}b`);
    expect(other).not.toBe(name);
    expect(other.length).toBe(APP_TOOL_NAME_MAX);
    // Deterministic.
    expect(appToolName('github', long)).toBe(name);
  });

  it('a name that exactly fits is untouched', () => {
    const tool = 'x'.repeat(APP_TOOL_NAME_MAX - 'app_github_'.length);
    expect(appToolName('github', tool)).toBe(`app_github_${tool}`);
  });

  it('disambiguate forces the hash suffix (names that collide after sanitizing)', () => {
    const plain = appToolName('github', 'a.b');
    const underscored = appToolName('github', 'a_b');
    expect(plain).toBe(underscored); // lossy sanitize really collides
    const fixed = appToolName('github', 'a.b', { disambiguate: true });
    expect(fixed).not.toBe(underscored);
    expect(fixed).toMatch(/^app_github_a_b_[0-9a-f]{8}$/);
    expect(appToolName('github', 'a_b', { disambiguate: true })).not.toBe(fixed);
  });

  it('does not change the plain MCP naming', () => {
    expect(mcpToolName('srv', 'echo')).toBe('mcp_srv_echo');
    expect(mcpToolName('srv', 'a.b')).toBe('mcp_srv_a_b');
  });

  it('bridge names (mcp__kepcup…__ prefix) stay ≤ 64 after fitToolName, prefix app_ preserved', () => {
    const bridgePrefix = `mcp__${HOST_MCP_SERVER_PREFIX}_ab12cd34__`;
    const shortPrefix = 'mcp__kepcup__';
    for (const prefix of [shortPrefix, bridgePrefix]) {
      const max = MAX_AGENT_TOOL_NAME - prefix.length;
      for (const tool of ['list_repos', 'x'.repeat(120)]) {
        const name = fitToolName(appToolName('github', tool), max);
        expect(`${prefix}${name}`.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_NAME);
        expect(name.startsWith('app_github_')).toBe(true);
      }
    }
    // With the short documented prefix the 50-char names already fit untouched.
    const longApp = appToolName('github', 'x'.repeat(120));
    expect(`${shortPrefix}${longApp}`.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_NAME);
    expect(fitToolName(longApp, MAX_AGENT_TOOL_NAME - shortPrefix.length)).toBe(longApp);
  });
});
