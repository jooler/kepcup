import { describe, expect, test } from 'vitest';
import {
  blockReasonText,
  classifyAddress,
  decideBrowserRequest,
  isLoopbackHostname,
  parseIpv6,
  type BrowserNetworkContext,
} from '@kepcup/shared';

const ALLOWED: BrowserNetworkContext = { allowLoopback: true };
const BLOCKED: BrowserNetworkContext = { allowLoopback: false };

describe('classifyAddress', () => {
  test('IPv4 classes', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('127.255.0.7')).toBe('loopback');
    expect(classifyAddress('0.0.0.0')).toBe('loopback');
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('172.31.255.255')).toBe('private');
    expect(classifyAddress('172.32.0.1')).toBe('public');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('100.64.0.1')).toBe('private'); // carrier-grade NAT
    expect(classifyAddress('169.254.1.1')).toBe('linkLocal');
    expect(classifyAddress('169.254.169.254')).toBe('metadata'); // AWS/GCP/Azure
    expect(classifyAddress('100.100.100.200')).toBe('metadata'); // Alibaba
    expect(classifyAddress('168.63.129.16')).toBe('metadata'); // Azure
    expect(classifyAddress('192.0.0.192')).toBe('metadata');
    expect(classifyAddress('8.8.8.8')).toBe('public');
    expect(classifyAddress('1.1.1.1')).toBe('public');
  });

  test('IPv6 classes', () => {
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('::')).toBe('loopback');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback'); // v4-mapped
    expect(classifyAddress('::ffff:192.168.1.1')).toBe('private'); // v4-mapped
    expect(classifyAddress('fe80::1')).toBe('linkLocal');
    expect(classifyAddress('fd12::1')).toBe('private'); // unique local
    expect(classifyAddress('fd00:ec2::25')).toBe('metadata'); // AWS ULA
    expect(classifyAddress('fd20:ce::254')).toBe('metadata');
    expect(classifyAddress('2620:0:ccc::2')).toBe('public');
  });

  test('unrecognized input', () => {
    expect(classifyAddress('not-an-ip')).toBe('unrecognized');
    expect(classifyAddress('999.1.1.1')).toBe('unrecognized');
    expect(classifyAddress('1.2.3')).toBe('unrecognized');
  });

  test('parseIpv6 accepts compressed and v4-tailed forms', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::ffff:192.168.1.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x101]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toHaveLength(8);
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6('::1::2')).toBeNull();
  });
});

describe('isLoopbackHostname', () => {
  test('localhost forms', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('api.localhost')).toBe(true);
    expect(isLoopbackHostname('localhost.example.com')).toBe(false);
    expect(isLoopbackHostname('example.com')).toBe(false);
  });
});

describe('decideBrowserRequest', () => {
  test('public addresses always allowed', () => {
    const decision = decideBrowserRequest({
      host: 'example.com',
      addresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
      scheme: 'https:',
      context: BLOCKED,
    });
    expect(decision.action).toBe('allow');
  });

  test('loopback allowed only with a bound project', () => {
    const request = {
      host: '127.0.0.1',
      addresses: ['127.0.0.1'],
      scheme: 'http:',
    } as const;
    expect(decideBrowserRequest({ ...request, context: ALLOWED }).action).toBe('allow');
    const blocked = decideBrowserRequest({ ...request, context: BLOCKED });
    expect(blocked.action).toBe('cancel');
    expect(blocked.reason).toBe('loopback-not-allowed');
  });

  test('localhost hostname resolves to loopback semantics', () => {
    const blocked = decideBrowserRequest({
      host: 'localhost',
      addresses: ['127.0.0.1', '::1'],
      scheme: 'http:',
      context: BLOCKED,
    });
    expect(blocked.reason).toBe('loopback-not-allowed');
    expect(
      decideBrowserRequest({
        host: 'localhost',
        addresses: ['127.0.0.1', '::1'],
        scheme: 'http:',
        context: ALLOWED,
      }).action,
    ).toBe('allow');
  });

  test('private, link-local and metadata addresses always blocked', () => {
    for (const [address, reason] of [
      ['192.168.1.1', 'private-address'],
      ['10.0.0.5', 'private-address'],
      ['172.20.0.9', 'private-address'],
      ['169.254.1.1', 'link-local-address'],
      ['169.254.169.254', 'metadata-address'],
      ['fd00:ec2::25', 'metadata-address'],
      ['fe80::1', 'link-local-address'],
    ] as const) {
      const decision = decideBrowserRequest({
        host: address,
        addresses: [address],
        scheme: 'http:',
        context: ALLOWED, // even a bound project never unlocks these
      });
      expect(decision.action).toBe('cancel');
      expect(decision.reason).toBe(reason);
    }
  });

  test('one blocked address among many cancels (DNS rebinding fail-closed)', () => {
    const decision = decideBrowserRequest({
      host: 'rebind.example',
      addresses: ['93.184.216.34', '10.0.0.1'],
      scheme: 'http:',
      context: ALLOWED,
    });
    expect(decision.action).toBe('cancel');
    expect(decision.reason).toBe('private-address');
  });

  test('unresolvable hosts and unsupported schemes are blocked', () => {
    expect(
      decideBrowserRequest({ host: 'nx.example', addresses: [], scheme: 'https:', context: ALLOWED }),
    ).toMatchObject({ action: 'cancel', reason: 'unresolvable-host' });
    expect(
      decideBrowserRequest({ host: 'x', addresses: ['127.0.0.1'], scheme: 'file:', context: ALLOWED }),
    ).toMatchObject({ action: 'cancel', reason: 'unsupported-scheme' });
  });

  test('blockReasonText renders stable Chinese reasons', () => {
    expect(blockReasonText('loopback-not-allowed')).toContain('project');
    expect(blockReasonText('metadata-address')).toContain('元数据');
  });
});
