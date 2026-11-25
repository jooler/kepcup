import { describe, expect, it } from 'vitest';
import {
  normalizeTeamServerAddress,
  probeFailureOf,
  type TeamServerProbeFailure,
} from './team-server-connect';

/**
 * 设置卡「团队服务器」第一步的纯逻辑：地址规范化 + 健康检查结果判定。
 * 组件行为（先探测、失败不 add、通过才出现登录表单）由这两个函数的返回值驱动。
 */

describe('normalizeTeamServerAddress', () => {
  it('接受 http / https，去掉 query 与 hash', () => {
    expect(normalizeTeamServerAddress(' https://team.example.com ')).toBe('https://team.example.com');
    expect(normalizeTeamServerAddress('http://127.0.0.1:8643/?x=1#y')).toBe('http://127.0.0.1:8643');
  });

  it('保留 path（反代子路径部署）', () => {
    expect(normalizeTeamServerAddress('https://example.com/kepcup/')).toBe(
      'https://example.com/kepcup/',
    );
  });

  it('拒绝空地址 / 非 http(s) / 内嵌凭据 / 非法 URL', () => {
    expect(normalizeTeamServerAddress('')).toBeNull();
    expect(normalizeTeamServerAddress('   ')).toBeNull();
    expect(normalizeTeamServerAddress('ftp://team.example.com')).toBeNull();
    expect(normalizeTeamServerAddress('https://alice:secret@team.example.com')).toBeNull();
    expect(normalizeTeamServerAddress('not a url')).toBeNull();
  });
});

describe('probeFailureOf', () => {
  it('团队服务器（含未认证）通过 → null', () => {
    expect(probeFailureOf({ reachable: true, kind: 'team', authenticated: false })).toBeNull();
    expect(
      probeFailureOf({
        reachable: true,
        kind: 'team',
        authenticated: true,
        member: { id: 'm1', displayName: 'Alice' },
      }),
    ).toBeNull();
  });

  it('不可达 → unreachable，带主进程原因', () => {
    const failure = probeFailureOf({
      reachable: false,
      kind: 'unknown',
      detail: 'fetch failed（getaddrinfo ENOTFOUND）',
    });
    expect(failure).toEqual({
      kind: 'unreachable',
      detail: 'fetch failed（getaddrinfo ENOTFOUND）',
    } satisfies TeamServerProbeFailure);
  });

  it('个人版服务器 → personal；其它响应 → unknown', () => {
    expect(probeFailureOf({ reachable: true, kind: 'personal', detail: 'HTTP 404' })).toEqual({
      kind: 'personal',
      detail: 'HTTP 404',
    });
    expect(probeFailureOf({ reachable: true, kind: 'unknown', detail: 'HTTP 502' })).toEqual({
      kind: 'unknown',
      detail: 'HTTP 502',
    });
  });

  it('没有 detail 时按 null 归一', () => {
    expect(probeFailureOf({ reachable: true, kind: 'unknown' })).toEqual({
      kind: 'unknown',
      detail: null,
    });
  });
});
