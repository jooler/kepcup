import { afterEach, describe, expect, it } from 'vitest';

import { REDACT_ONLY_MAX } from '../../src/domain/secrets.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

function open(): RealMainDb {
  env = openRealMainDb();
  return env;
}

describe('SecretsService 脱敏（D73 §4.4）', () => {
  it('令牌轮换：旧值、新值都被 redact 掩码', () => {
    const { secrets } = open();
    secrets.setValue('conn:abc:access', 'tok-old-1111');
    secrets.setValue('conn:abc:access', 'tok-new-2222');
    const masked = secrets.redact('a tok-old-1111 b tok-new-2222 c');
    expect(masked).toBe('a [REDACTED] b [REDACTED] c');
    // 存储里只剩新值。
    expect(secrets.getValue('conn:abc:access')).toBe('tok-new-2222');
  });

  it('进程重启后（缓存为空）覆盖也能掩码旧值', () => {
    const e = open();
    e.secrets.setValue('conn:abc:access', 'tok-before-restart');
    const restarted = e.makeSecrets();
    restarted.setValue('conn:abc:access', 'tok-after-restart');
    expect(restarted.redact('tok-before-restart tok-after-restart')).toBe('[REDACTED] [REDACTED]');
  });

  it('覆盖为相同的值不产生仅脱敏条目，名称仍可读', () => {
    const { secrets } = open();
    secrets.setValue('conn:abc:access', 'same-value-1');
    secrets.setValue('conn:abc:access', 'same-value-1');
    expect(secrets.getValue('conn:abc:access')).toBe('same-value-1');
    expect(secrets.redact('x same-value-1 y')).toBe('x [REDACTED] y');
  });

  it('removeValue 后该值仍被掩码（含重启后未缓存的值）', () => {
    const e = open();
    e.secrets.setValue('conn:abc:refresh', 'refresh-aaaa');
    e.secrets.removeValue('conn:abc:refresh');
    expect(e.secrets.hasValue('conn:abc:refresh')).toBe(false);
    expect(e.secrets.redact('r=refresh-aaaa')).toBe('r=[REDACTED]');

    e.secrets.setValue('conn:abc:refresh', 'refresh-bbbb');
    const restarted = e.makeSecrets();
    restarted.removeValue('conn:abc:refresh');
    expect(restarted.redact('r=refresh-bbbb')).toBe('r=[REDACTED]');
  });

  it('removeValue 对不存在的名称是无操作', () => {
    const { secrets } = open();
    expect(() => secrets.removeValue('conn:none:access')).not.toThrow();
  });

  it('removeByPrefix 返回被删名称、只删该前缀，被删值仍被掩码', () => {
    const { secrets } = open();
    secrets.setValue('conn:abc:access', 'abc-access-val');
    secrets.setValue('conn:abc:refresh', 'abc-refresh-val');
    secrets.setValue('conn:abcd:access', 'abcd-access-val');
    secrets.setValue('conn:xyz:access', 'xyz-access-val');
    // `_` 不是通配符：不会误删 conn:a_c: 之外的名称。
    secrets.setValue('mcp:a_c:env:k', 'underscore-val');
    secrets.setValue('mcp:abc:env:k', 'letter-val');

    expect(secrets.removeByPrefix('conn:abc:')).toEqual(['conn:abc:access', 'conn:abc:refresh']);
    expect(secrets.names()).toEqual([
      'conn:abcd:access',
      'conn:xyz:access',
      'mcp:a_c:env:k',
      'mcp:abc:env:k',
    ]);
    expect(secrets.redact('abc-access-val abc-refresh-val')).toBe('[REDACTED] [REDACTED]');

    expect(secrets.removeByPrefix('mcp:a_c:')).toEqual(['mcp:a_c:env:k']);
    expect(secrets.getValue('mcp:abc:env:k')).toBe('letter-val');
    expect(secrets.removeByPrefix('conn:nothing:')).toEqual([]);
  });

  it('removeByPrefix 拒绝空前缀与非法前缀', () => {
    const { secrets } = open();
    secrets.setValue('conn:abc:access', 'v-1');
    expect(() => secrets.removeByPrefix('')).toThrow(/Invalid secret name prefix/);
    expect(() => secrets.removeByPrefix('%')).toThrow(/Invalid secret name prefix/);
    expect(secrets.hasValue('conn:abc:access')).toBe(true);
  });

  it('仅脱敏集合有上限（LRU）：最旧的先淘汰，最近的仍掩码', () => {
    const { secrets } = open();
    const total = REDACT_ONLY_MAX + 20;
    for (let i = 0; i <= total; i += 1) {
      secrets.setValue('conn:rot:access', `rotating-token-${String(i).padStart(5, '0')}`);
    }
    // 最后一个是当前值；之前 total 个是仅脱敏值，只保留最近 REDACT_ONLY_MAX 个。
    const oldest = 'rotating-token-00000';
    const evictedEdge = `rotating-token-${String(total - REDACT_ONLY_MAX - 1).padStart(5, '0')}`;
    const keptEdge = `rotating-token-${String(total - REDACT_ONLY_MAX).padStart(5, '0')}`;
    expect(secrets.redact(oldest)).toBe(oldest);
    expect(secrets.redact(evictedEdge)).toBe(evictedEdge);
    expect(secrets.redact(keptEdge)).toBe('[REDACTED]');
    expect(secrets.redact(`rotating-token-${String(total).padStart(5, '0')}`)).toBe('[REDACTED]');
  });

  it('名称正则不变：conn:/oauth:client: 名称合法，含 URL 的名称仍被拒绝', () => {
    const { secrets } = open();
    secrets.setValue('conn:conn_01abc:access', 'a');
    secrets.setValue('oauth:client:0123456789abcdef01234567:secret', 'b');
    expect(() => secrets.setValue('oauth:client:https://x.com:id', 'c')).toThrow(
      /Invalid secret name/,
    );
  });
});
