import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG, filterReleasedAgents, type AgentCatalogEntry } from '@kepcup/shared';
import { PROVIDERS } from '../../src/agent/external/providers/index.js';
import { devinProvider } from '../../src/agent/external/providers/devin.js';
import { kimiProvider } from '../../src/agent/external/providers/kimi.js';

/**
 * D118 新目标（todo/acp-hardening-and-new-targets.md §3）：Cline、GitHub
 * Copilot、goose、Qwen Code、Kimi CLI、Grok Build、Devin 的目录条目与 Provider
 * 差异。真机 spike 前只锁「结构正确」：条目过 schema、provider 已登记、
 * 发行门禁不放行（fail-closed）、sessionNotFound 形态按 OpenBot 观察值匹配。
 */

const D118_IDS = [
  'cline',
  'github-copilot-cli',
  'goose',
  'qwen-code',
  'kimi',
  'grok-build',
  'devin',
] as const;

const entry = (id: string): AgentCatalogEntry => {
  const hit = AGENT_CATALOG.find((candidate) => candidate.id === id);
  expect(hit, id).toBeDefined();
  return hit!;
};

describe('D118 catalog entries', () => {
  it('all seven targets exist as preview entries with release gates', () => {
    for (const id of D118_IDS) {
      const target = entry(id);
      expect(target.tier, id).toBe('preview');
      expect(target.releaseGate, id).toBe(id);
      expect(target.transport, id).toBe('acp');
      expect(target.auth.note.length, id).toBeGreaterThan(0);
      expect(target.terms?.noticeKey.startsWith('agents.terms.'), id).toBe(true);
    }
  });

  it('none of them is released by the current gate list (fail-closed)', () => {
    const released = filterReleasedAgents(AGENT_CATALOG, [
      'claude',
      'codex',
      'opencode',
      'dsh',
      'cursor',
      'antigravity',
    ]);
    for (const id of D118_IDS) {
      expect(
        released.some((candidate) => candidate.id === id),
        id,
      ).toBe(false);
    }
  });

  it('the shipped agent-release-gates.json does not include any of them', () => {
    // Hard constraint (todo §3): preview targets stay out of the release gate
    // file until a real-device spike and compliance sign-off — this reads the
    // real file, not a hand-copied list (审查 D118).
    const gates = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '../../../../apps/desktop/agent-release-gates.json'),
        'utf8',
      ),
    ) as { approved: string[] };
    for (const id of D118_IDS) {
      expect(gates.approved, id).not.toContain(id);
    }
    expect(gates.approved).not.toContain('inkcop');
    const catalogGates = new Set(
      AGENT_CATALOG.filter((candidate) => candidate.releaseGate !== 'testkit').map(
        (candidate) => candidate.releaseGate,
      ),
    );
    for (const gate of gates.approved) expect(catalogGates, gate).toContain(gate);
  });

  it('every entry resolves to a dedicated registered provider', () => {
    for (const id of D118_IDS) {
      expect(PROVIDERS[entry(id).provider], id).toBeDefined();
      expect(entry(id).provider, id).not.toBe('generic-acp');
    }
    expect(entry('kimi').provider).toBe('kimi');
    expect(entry('devin').provider).toBe('devin');
    expect(entry('cline').provider).toBe('cline');
    expect(entry('github-copilot-cli').provider).toBe('copilot');
    expect(entry('goose').provider).toBe('goose');
    expect(entry('qwen-code').provider).toBe('qwen');
    expect(entry('grok-build').provider).toBe('grok');
  });

  it('pins the npx launchers and their self-update flags', () => {
    expect(entry('cline').distribution.npx).toMatchObject({
      package: 'cline@3.0.76',
      args: ['--acp'],
    });
    expect(entry('github-copilot-cli').distribution.npx).toMatchObject({
      package: '@github/copilot@1.0.116',
      args: ['--acp', '--no-auto-update'],
    });
    expect(entry('qwen-code').distribution.npx).toMatchObject({
      package: '@qwen-code/qwen-code@0.28.6',
      args: ['--acp'],
    });
    expect(entry('kimi').distribution.npx).toMatchObject({
      package: '@moonshot-ai/kimi-code@2.8.1',
      args: ['acp'],
    });
    expect(entry('grok-build').distribution.npx).toMatchObject({
      package: '@xai-official/grok@1.0.92',
      args: ['--no-auto-update', 'agent', 'stdio'],
    });
  });
});

describe('D118 provider sessionNotFound shapes (OpenBot-observed, unverified)', () => {
  it('kimi: 40404, or -32602 with data.sessionId', () => {
    expect(kimiProvider.sessionNotFound?.({ code: 40404, message: 'Session not found' })).toBe(
      true,
    );
    expect(kimiProvider.sessionNotFound?.({ code: -32602, data: { sessionId: 'sess_1' } })).toBe(
      true,
    );
    expect(kimiProvider.sessionNotFound?.({ code: -32602, data: {} })).toBe(false);
    expect(kimiProvider.sessionNotFound?.({ code: -32602 })).toBe(false);
    expect(kimiProvider.sessionNotFound?.({ code: -32002 })).toBe(false);
  });

  it('devin: -32016 with cognition.ai/errorKind session_not_found', () => {
    expect(
      devinProvider.sessionNotFound?.({
        code: -32016,
        data: { 'cognition.ai/errorKind': 'session_not_found' },
      }),
    ).toBe(true);
    expect(
      devinProvider.sessionNotFound?.({
        code: -32016,
        data: { 'cognition.ai/errorKind': 'other' },
      }),
    ).toBe(false);
    expect(devinProvider.sessionNotFound?.({ code: -32016 })).toBe(false);
  });

  it('generic-acp has no private shape (protocol -32002 only)', () => {
    expect(PROVIDERS['generic-acp']?.sessionNotFound).toBeUndefined();
  });
});
