import { describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';
import { decideMcpTool, effectiveMcpApproval, isDeveloperTier } from '../../src/mcp/policy.js';
import { FlowEventLog, redactFlowPayload, scrubLogText } from '../../src/apps/auth/flow-log.js';

type PolicyServer = Pick<McpServer, 'autoApprove' | 'toolPolicies' | 'tier'>;
const base: PolicyServer = { autoApprove: false };
const developer: PolicyServer = { autoApprove: false, tier: 'developer' };

describe('effectiveMcpApproval: W5 defaults (non-developer)', () => {
  it('read → auto, write / destructive → ask; server autoApprove and tool policy relax', () => {
    expect(effectiveMcpApproval(base, 't', 'read')).toEqual({
      approval: 'auto',
      source: 'default',
    });
    expect(effectiveMcpApproval(base, 't', 'write').approval).toBe('ask');
    expect(effectiveMcpApproval({ ...base, autoApprove: true }, 't', 'destructive')).toEqual({
      approval: 'auto',
      source: 'server',
    });
  });
});

describe('effectiveMcpApproval: developer tier (design 29 §11.3)', () => {
  it('isDeveloperTier reads only tier "developer"', () => {
    expect(isDeveloperTier(developer)).toBe(true);
    expect(isDeveloperTier(base)).toBe(false);
  });

  it('asks for every risk by default, even read-only tools', () => {
    for (const risk of ['read', 'write', 'destructive'] as const) {
      expect(effectiveMcpApproval(developer, 't', risk)).toEqual({
        approval: 'ask',
        source: 'default',
      });
    }
  });

  it('a per-tool policy or server autoApprove relaxes read / write', () => {
    const relaxed: PolicyServer = { ...developer, toolPolicies: { t: { approval: 'auto' } } };
    expect(effectiveMcpApproval(relaxed, 't', 'read')).toEqual({
      approval: 'auto',
      source: 'policy',
    });
    expect(effectiveMcpApproval(relaxed, 't', 'write').approval).toBe('auto');
    expect(effectiveMcpApproval(relaxed, 'other', 'read').approval).toBe('ask');
    expect(effectiveMcpApproval({ ...developer, autoApprove: true }, 't', 'write')).toEqual({
      approval: 'auto',
      source: 'server',
    });
  });

  it('destructive stays "ask" whatever the user relaxed', () => {
    const relaxed: PolicyServer = {
      ...developer,
      autoApprove: true,
      toolPolicies: { t: { approval: 'auto' } },
    };
    expect(effectiveMcpApproval(relaxed, 't', 'destructive').approval).toBe('ask');
    const decision = decideMcpTool(relaxed, 't', { risk: 'destructive', source: 'annotation' });
    expect(decision.approval).toBe('ask');
  });

  it('a disabled tool stays disabled', () => {
    const decision = decideMcpTool({ ...developer, toolPolicies: { t: { enabled: false } } }, 't', {
      risk: 'read',
      source: 'annotation',
    });
    expect(decision.enabled).toBe(false);
  });
});

describe('flow log redaction', () => {
  it('keeps scheme://host/path of the authorization URL only', () => {
    const entry = redactFlowPayload(
      {
        flowId: 'f',
        phase: 'awaiting_consent',
        authorizationHost: 'as.example.com',
        authorizationUrl:
          'https://as.example.com/authorize?client_id=c&state=SECRETSTATE123&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789#frag',
      },
      5,
    );
    expect(entry.authorizationUrl).toBe('https://as.example.com/authorize');
    expect(JSON.stringify(entry)).not.toContain('SECRETSTATE123');
  });

  it('scrubs secret-looking parameters and long token runs from messages', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9abcdef0123456789ABCDEFGHIJ';
    const text = `bad request code=abc123 state=zzz access_token=${token} and ${token}`;
    const scrubbed = scrubLogText(text);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain('abc123');
    expect(scrubbed).toContain('bad request');
    // Ordinary hostnames / paths survive.
    expect(scrubLogText('https://mcp.example.com/v1/mcp 授权失败')).toBe(
      'https://mcp.example.com/v1/mcp 授权失败',
    );
  });

  it('scrubs JSON / colon forms, Bearer credentials, JWTs and long opaque runs (letters-only, hex)', () => {
    const lettersOnly = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP';
    const hex = 'deadbeef'.repeat(5);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const text = [
      '{"access_token":"tok-json-value","refresh_token": "rt json"}',
      'client_secret: topsecretvalue',
      'Authorization: Bearer bearer-secret-123',
      `jwt ${jwt}`,
      `letters ${lettersOnly}`,
      `hex ${hex}`,
    ].join(' | ');
    const scrubbed = scrubLogText(text);
    for (const leaked of [
      'tok-json-value',
      'rt json',
      'topsecretvalue',
      'bearer-secret-123',
      jwt,
      lettersOnly,
      hex,
    ]) {
      expect(scrubbed).not.toContain(leaked);
    }
  });

  it('runs messages through the injected secret redactor', () => {
    const entry = redactFlowPayload(
      {
        flowId: 'f',
        phase: 'failed',
        error: { code: 'X', message: 'bad stored-secret-value here' },
      },
      1,
      (text) => text.split('stored-secret-value').join('«secret»'),
    );
    expect(entry.errorMessage).toBe('bad «secret» here');
  });

  it('tracks a bounded number of servers (LRU)', () => {
    const log = new FlowEventLog(5, 2);
    log.record('a', { at: 1, flowId: 'f', phase: 'p' });
    log.record('b', { at: 2, flowId: 'f', phase: 'p' });
    log.record('a', { at: 3, flowId: 'f', phase: 'p' }); // a is now the most recent
    log.record('c', { at: 4, flowId: 'f', phase: 'p' }); // evicts b
    expect(log.size).toBe(2);
    expect(log.entries('b')).toEqual([]);
    expect(log.entries('a')).toHaveLength(2);
    expect(log.entries('c')).toHaveLength(1);
  });

  it('is a bounded ring buffer per server', () => {
    const log = new FlowEventLog(3);
    for (let i = 0; i < 5; i += 1) log.record('a', { at: i, flowId: 'f', phase: `p${i}` });
    log.record('b', { at: 9, flowId: 'g', phase: 'x' });
    expect(log.entries('a').map((e) => e.phase)).toEqual(['p2', 'p3', 'p4']);
    expect(log.entries('b')).toHaveLength(1);
    log.clear('a');
    expect(log.entries('a')).toEqual([]);
  });
});
