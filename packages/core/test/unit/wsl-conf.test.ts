import { describe, expect, it } from 'vitest';

import { buildWslConf } from '../../src/sandbox/wsl/conf.js';

/** /etc/wsl.conf 安全基线（design/10）：automount 与 interop 必须关闭，且
 * 生成器不提供任何开启它们的参数（无开关旁路）。 */
describe('buildWslConf', () => {
  it('disables automount and interop and sets the default user', () => {
    expect(buildWslConf()).toBe(
      [
        '[automount]',
        'enabled = false',
        'mountFsTab = false',
        '',
        '[interop]',
        'enabled = false',
        'appendWindowsPath = false',
        '',
        '[user]',
        'default = kepcup',
        '',
      ].join('\n'),
    );
  });

  it('accepts a custom default user', () => {
    expect(buildWslConf({ user: 'other' })).toContain('default = other');
  });

  it('never enables automount or interop (no escape hatch exists)', () => {
    const conf = buildWslConf({ user: 'x' });
    expect(conf).not.toMatch(/enabled = true/);
    expect(conf).not.toMatch(/appendWindowsPath = true/);
  });
});
