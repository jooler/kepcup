import { describe, expect, it } from 'vitest';
import { connectorSkillSchema, isSafeSkillSourceUrl } from '../../src/index.js';

/** Catalog skill sources are cloned *before* the user approves, so only plain public https git hosts pass. */
describe('isSafeSkillSourceUrl', () => {
  it.each([
    'https://github.com/acme/skills.git',
    'https://gitlab.example.com/group/sub/repo',
    'https://git.example.co.uk/a/b.git',
  ])('accepts %s', (url) => {
    expect(isSafeSkillSourceUrl(url)).toBe(true);
    expect(connectorSkillSchema.safeParse({ name: 'a-b', source: url }).success).toBe(true);
  });

  it.each([
    ['userinfo', 'https://user:pass@github.com/acme/skills.git'],
    ['token userinfo', 'https://token@github.com/acme/skills.git'],
    ['http', 'http://github.com/acme/skills.git'],
    ['file', 'file:///srv/skills'],
    ['ssh', 'ssh://git@github.com/acme/skills.git'],
    ['git protocol', 'git://github.com/acme/skills.git'],
    ['local path', '/home/me/skills'],
    ['localhost', 'https://localhost/acme/skills.git'],
    ['subdomain of localhost', 'https://app.localhost/acme/skills.git'],
    ['ipv4 literal', 'https://127.0.0.1/acme/skills.git'],
    ['private ipv4', 'https://10.0.0.5/acme/skills.git'],
    ['metadata ip', 'https://169.254.169.254/latest'],
    ['decimal ipv4', 'https://2130706433/acme/skills.git'],
    ['hex ipv4', 'https://0x7f000001/acme/skills.git'],
    ['ipv6 literal', 'https://[::1]/acme/skills.git'],
    ['.local', 'https://git.local/acme/skills.git'],
    ['.internal', 'https://git.corp.internal/acme/skills.git'],
    ['single label', 'https://git/acme/skills.git'],
    ['explicit port', 'https://github.com:8443/acme/skills.git'],
    ['query', 'https://github.com/acme/skills.git?x=1'],
    ['fragment', 'https://github.com/acme/skills.git#main'],
    ['whitespace', 'https://github.com/acme/my skills.git'],
    ['newline', 'https://github.com/acme/skills.git\n'],
    ['no path', 'https://github.com'],
    ['backslash host trick', 'https://github.com\\@evil.example/x'],
    ['too long', `https://github.com/${'a'.repeat(600)}`],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isSafeSkillSourceUrl(url)).toBe(false);
    expect(connectorSkillSchema.safeParse({ name: 'a-b', source: url }).success).toBe(false);
  });
});
