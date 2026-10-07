import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentCatalogEntry } from '@kepcup/shared';
import {
  serializeFakeAgentScript,
  startFakeAcpAgent,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from './fake-acp-agent.js';

/**
 * 把假 ACP 智能体接进 core 的测试缝（D72）：目录条目（纯数据）、子进程启动
 * 目标（core `agentLaunch`）与进程内 spawner（core `agentSpawn`）。
 */

/** Executable entry of the subprocess fake agent. */
export const FAKE_ACP_AGENT_BIN = fileURLToPath(
  new URL('../bin/fake-acp-agent.mjs', import.meta.url),
);

/**
 * Launch target (core `LaunchTarget` shape) running the fake agent as a child
 * of this runtime — Electron's Node in tests, hence ELECTRON_RUN_AS_NODE.
 */
export function fakeAcpAgentLaunch(
  scriptFile: string,
  recordFile?: string,
): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [FAKE_ACP_AGENT_BIN, scriptFile, ...(recordFile !== undefined ? [recordFile] : [])],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export function writeFakeAgentScript(file: string, script: FakeAgentScript): void {
  writeFileSync(file, serializeFakeAgentScript(script));
}

/**
 * core `agentSpawn` hook backed by in-process fake agents, keyed by catalog
 * id. An array gives one script per process start (crash → restart tests);
 * the last one is reused. Every started handle is pushed to `started`.
 */
export function fakeAgentSpawner(
  scripts: Record<string, FakeAgentScript | FakeAgentScript[]>,
  started: FakeAcpAgentHandle[] = [],
): (input: { entry: { id: string } }) => Pick<FakeAcpAgentHandle, 'channel' | 'exited' | 'kill'> {
  const starts = new Map<string, number>();
  return ({ entry }) => {
    const configured = scripts[entry.id];
    if (configured === undefined) throw new Error(`no fake agent script for ${entry.id}`);
    const count = starts.get(entry.id) ?? 0;
    starts.set(entry.id, count + 1);
    const script = Array.isArray(configured)
      ? configured[Math.min(count, configured.length - 1)]!
      : configured;
    const handle = startFakeAcpAgent(script);
    started.push(handle);
    return { channel: handle.channel, exited: handle.exited, kill: handle.kill };
  };
}

/**
 * A catalog entry for an extra fake agent — pure data on the generic ACP
 * provider (the extensibility check: a new entry needs no core code).
 */
export function fakeAgentEntry(
  id: string,
  overrides: Partial<AgentCatalogEntry> = {},
): AgentCatalogEntry {
  return {
    id,
    name: `Fake Agent ${id}`,
    version: '0.0.1',
    description: 'testkit 假智能体（扩展性验证）',
    authors: ['KepCup'],
    license: 'MIT',
    icon: 'fake.svg',
    distribution: { system: { cmd: `kepcup-${id}`, detect: ['--version'] } },
    provider: 'generic-acp',
    transport: 'acp',
    tier: 'preview',
    nativeCapabilities: {},
    auth: { kinds: [], note: '无需登录' },
    releaseGate: 'testkit',
    ...overrides,
  };
}
