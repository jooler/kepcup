import { rm } from 'node:fs/promises';
import { BUILTIN_AGENT_RUNTIME, type Bot, type Conversation, type Draft, type Message, type Run } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';
import { startMockLlm, type MockLlmServer } from './mock-llm.js';
import { createTestCore, createTestHome, type CreateTestCoreOptions } from './fixtures.js';
import type { Keystore } from '@kepcup/core';
import type { TimerScheduler } from '@kepcup/core';

export { startMockLlm };
export type { MockLlmServer };

export interface TestStack {
  core: CoreHarness;
  llm: MockLlmServer;
  cleanup(): Promise<void>;
}

/**
 * Mock model service + a core wired to it via KEPCUP_MOCK_LLM_URL
 * (seeded as the default main/light provider, see core start.ts
 * `seedMockLlm`). Script responses with `llm.script('mock-main', ...)`.
 */
export async function createTestStack(
  options: {
    home?: string;
    keystore?: Keystore;
    env?: NodeJS.ProcessEnv;
    /** P06 test hook: replaces the pinned catalog (never hits real servers). */
    envCatalog?: unknown;
    /** P06 test hooks: system-item action/detection overrides. */
    envManagerHooks?: unknown;
    /** P07 test hook: replaces the configured embedder (deterministic vectors). */
    memoryEmbedder?: unknown;
    /** P10: controllable clock + its paired virtual timer scheduler. */
    clock?: unknown;
    timers?: TimerScheduler;
    /** P11 test hook: fake browser host (see createFakeBrowserHost). */
    browserRpc?: unknown;
    /** P12 test hook: replaces the enhanced-level backend (Lima/Podman stub). */
    enhancedSandbox?: unknown;
    /** P12 test hook: fake distro-internal toolchain installer (Windows flows). */
    distroInstaller?: unknown;
    /** P12 test hook: platform override for the environment manager. */
    platform?: string;
    /** D72 test hooks (see CreateTestCoreOptions). */
    agentCatalog?: CreateTestCoreOptions['agentCatalog'];
    agentLaunch?: CreateTestCoreOptions['agentLaunch'];
    agentSpawn?: CreateTestCoreOptions['agentSpawn'];
  } = {},
): Promise<TestStack> {
  const llm = await startMockLlm();
  const tempHome = options.home ? null : await createTestHome();
  const core = await createTestCore({
    home: options.home ?? tempHome?.home,
    env: { KEPCUP_MOCK_LLM_URL: llm.url, ...options.env },
    ...(options.keystore ? { keystore: options.keystore } : {}),
    ...(options.envCatalog !== undefined ? { envCatalog: options.envCatalog } : {}),
    ...(options.envManagerHooks !== undefined ? { envManagerHooks: options.envManagerHooks } : {}),
    ...(options.memoryEmbedder !== undefined ? { memoryEmbedder: options.memoryEmbedder } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.timers !== undefined ? { timers: options.timers } : {}),
    ...(options.browserRpc !== undefined ? { browserRpc: options.browserRpc } : {}),
    ...(options.enhancedSandbox !== undefined ? { enhancedSandbox: options.enhancedSandbox } : {}),
    ...(options.distroInstaller !== undefined ? { distroInstaller: options.distroInstaller } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.agentCatalog !== undefined ? { agentCatalog: options.agentCatalog } : {}),
    ...(options.agentLaunch !== undefined ? { agentLaunch: options.agentLaunch } : {}),
    ...(options.agentSpawn !== undefined ? { agentSpawn: options.agentSpawn } : {}),
  });
  return {
    core,
    llm,
    async cleanup() {
      await core.close();
      await llm.stop();
      if (tempHome) await rm(tempHome.home, { recursive: true, force: true });
    },
  };
}

// --- fixtures (docs/dev/05-testing.md "工厂函数") -----------------------------

export function botProfile(overrides: { name: string } & Partial<Bot['profile']>): Bot['profile'] {
  return {
    identity: {
      name: overrides.name,
      avatar: overrides.identity?.avatar,
      bio: overrides.identity?.bio ?? '测试 Bot',
    },
    persona: {
      personality: overrides.persona?.personality ?? '',
      tone: overrides.persona?.tone ?? '',
      style: overrides.persona?.style ?? '',
      values: overrides.persona?.values ?? '',
      sample_dialogues: overrides.persona?.sample_dialogues ?? '',
    },
    role: {
      expertise: overrides.role?.expertise ?? '',
      responsibilities: overrides.role?.responsibilities ?? '',
    },
    boundaries: overrides.boundaries ?? [],
    runtime: {
      model: overrides.runtime?.model ?? '',
      light_model: overrides.runtime?.light_model ?? '',
      network_policy: overrides.runtime?.network_policy ?? 'open',
      network_allowlist: overrides.runtime?.network_allowlist ?? [],
      mcp_server_ids: overrides.runtime?.mcp_server_ids ?? [],
      agent: { ...BUILTIN_AGENT_RUNTIME, ...overrides.runtime?.agent },
    },
    // P10 guardrails: default profile keeps proactive on; tests override.
    behavior:
      overrides.behavior !== undefined
        ? {
            proactive: overrides.behavior.proactive ?? true,
            quiet_hours: overrides.behavior.quiet_hours ?? null,
            max_proactive_per_day: overrides.behavior.max_proactive_per_day ?? null,
          }
        : { proactive: true, quiet_hours: null, max_proactive_per_day: null },
  };
}

export async function makeBot(core: CoreHarness, name: string): Promise<Bot> {
  const result = (await core.rpc.call('bots.create', {
    profile: botProfile({ name }),
  })) as { bot: Bot };
  return result.bot;
}

export async function openDirect(core: CoreHarness, botId: string): Promise<Conversation> {
  const result = (await core.rpc.call('conversations.openDirect', { botId })) as {
    conversation: Conversation;
  };
  return result.conversation;
}

export async function makeGroup(
  core: CoreHarness,
  title: string,
  botIds: string[],
): Promise<Conversation> {
  const result = (await core.rpc.call('groups.create', {
    title,
    memberBotIds: botIds,
  })) as { conversation: Conversation };
  return result.conversation;
}

export interface GroupDraft {
  text: string;
  mentions?: string[];
  replyTo?: string | null;
}

/** Queues drafts (with optional structured mentions / replyTo) and flushes. */
export async function sendDrafts(
  core: CoreHarness,
  conversationId: string,
  drafts: GroupDraft[],
): Promise<Message[]> {
  for (const draft of drafts) {
    await core.rpc.call('drafts.add', {
      conversationId,
      text: draft.text,
      ...(draft.mentions !== undefined ? { mentions: draft.mentions } : {}),
      ...(draft.replyTo !== undefined ? { replyTo: draft.replyTo } : {}),
    });
  }
  const result = (await core.rpc.call('drafts.flush', { conversationId })) as {
    messages: Message[];
  };
  return result.messages;
}

export async function listMembers(core: CoreHarness, conversationId: string) {
  const result = (await core.rpc.call('conversations.members', { conversationId })) as {
    members: Array<{ bot: Bot; joinedAt: number }>;
  };
  return result.members;
}

/** Queues a batch of drafts and flushes them as a single batch. */
export async function sendBatch(
  core: CoreHarness,
  conversationId: string,
  texts: string[],
): Promise<Message[]> {
  for (const text of texts) {
    await core.rpc.call('drafts.add', { conversationId, text });
  }
  const result = (await core.rpc.call('drafts.flush', { conversationId })) as {
    messages: Message[];
  };
  return result.messages;
}

export async function listDrafts(core: CoreHarness, conversationId: string): Promise<Draft[]> {
  const result = (await core.rpc.call('drafts.list', { conversationId })) as { drafts: Draft[] };
  return result.drafts;
}

export async function listMessages(core: CoreHarness, conversationId: string): Promise<Message[]> {
  const result = (await core.rpc.call('messages.list', {
    conversationId,
    limit: 200,
  })) as { messages: Message[] };
  return result.messages;
}

/**
 * Domain-level listing: includes the bot-internal system events
 * (INTERNAL_SYSTEM_EVENTS / `internal` 标记) that messages.list filters out
 * — 用户可见性断言走 listMessages，内部事务断言走这里。
 */
export async function listAllMessages(
  core: CoreHarness,
  conversationId: string,
): Promise<Message[]> {
  const domain = core.services.domain;
  if (domain === null) throw new Error('core domain services unavailable');
  return domain.messages.list(conversationId, { limit: 200 });
}

// --- waiting helpers ----------------------------------------------------------

export class TestTimeoutError extends Error {}

export async function waitFor<T>(
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeout = options.timeoutMs ?? 15_000;
  const interval = options.intervalMs ?? 25;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new TestTimeoutError(`Timed out waiting for ${options.label ?? 'condition'}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function listRuns(core: CoreHarness, conversationId: string): Promise<Run[]> {
  const result = (await core.rpc.call('runs.list', {
    conversationId,
    limit: 50,
  })) as { runs: Run[] };
  return result.runs;
}

/**
 * Waits for a run in `status`. Defaults to supervisor TURNS (D75; formerly
 * response runs): since P07 every completed turn also spawns a fast `reflection` run, and since P01 the
 * summary/triage loops create rows too — an unfiltered status match would be
 * satisfied by those instead of the run under test.
 */
export function waitForRun(
  core: CoreHarness,
  conversationId: string,
  status: Run['status'],
  options: { timeoutMs?: number; loopType?: Run['loopType'] } = {},
): Promise<Run> {
  const loopType = options.loopType ?? 'turn';
  return waitFor(
    async () =>
      (await listRuns(core, conversationId)).find(
        (r) => r.status === status && r.loopType === loopType,
      ) ?? null,
    { ...options, label: `run in status ${status}` },
  );
}

export function waitForMessage(
  core: CoreHarness,
  conversationId: string,
  predicate: (message: Message) => boolean,
  options: { timeoutMs?: number } = {},
): Promise<Message> {
  return waitFor(async () => (await listMessages(core, conversationId)).find(predicate) ?? null, {
    ...options,
    label: 'matching message',
  });
}

/** Resolves when a matching event arrives on the core event bus. */
export function waitForEvent<P>(
  core: CoreHarness,
  event: Parameters<CoreHarness['onEvent']>[0],
  predicate: (payload: P) => boolean,
  options: { timeoutMs?: number } = {},
): Promise<P> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new TestTimeoutError(`Timed out waiting for event ${String(event)}`));
    }, options.timeoutMs ?? 15_000);
    timer.unref?.();
    const unsubscribe = core.onEvent(event, (payload) => {
      if (predicate(payload as P)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(payload as P);
      }
    });
  });
}
