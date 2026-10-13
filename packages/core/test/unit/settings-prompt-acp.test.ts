import { describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import {
  AGENT_CATALOG,
  resolveCapabilities,
  resolveCapabilityOptIns,
  type Bot,
  type Conversation,
} from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';
import {
  buildAgentSessionPrompt,
  buildSystemPrompt,
} from '../../src/agent/context/system-prompt.js';
import { buildExternalAgentTools, hostToolNamer } from '../../src/agent/external/capabilities.js';
import { claudeProvider } from '../../src/agent/external/providers/claude.js';
import { SETTINGS_READ_ONLY_RULE, SETTINGS_RULE } from '../../src/settings/prompt.js';
import type { ToolDefinition } from '../../src/agent/types.js';

/**
 * 对话内应用设置的提示词规则（§5.1：只此一条，与工具注册同源）与 ACP 能力包（§5.3 第 7 条：
 * 默认不注入 settings_change，按 Bot 开启 `settings:change`）。
 */

const CLAUDE = AGENT_CATALOG.find((entry) => entry.id === 'claude-acp')!;

const BOT = {
  id: 'bot_1',
  name: '助手',
  bio: '',
  systemRole: null,
  setupState: 'done',
  profile: botProfile({ name: '助手' }),
} as unknown as Bot;
const CONV = {
  id: 'conv_1',
  type: 'direct',
  title: null,
  description: null,
} as unknown as Conversation;

function stub(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 原描述`,
    parameters: Type.Object({}),
    execute: async () => ({ ok: true, content: '' }),
  };
}

describe('settings prompt rule', () => {
  const input = { bot: BOT, conversation: CONV, timeZone: 'UTC', now: new Date(0) };

  it('appears (numbered) in turn and task rules only when the settings tools are registered', () => {
    for (const loop of ['turn', 'task'] as const) {
      const withTools = buildSystemPrompt({ ...input, loop, hasSettingsTools: true });
      expect(withTools).toMatch(new RegExp(`\\n\\d+\\. ${SETTINGS_RULE.slice(0, 20)}`));
      expect(withTools.split(SETTINGS_RULE)).toHaveLength(2);
      const without = buildSystemPrompt({ ...input, loop });
      expect(without).not.toContain('settings_search');
      expect(without).not.toContain('settings_change');
    }
  });

  it('never lists catalog items in the prompt', () => {
    const prompt = buildSystemPrompt({ ...input, loop: 'turn', hasSettingsTools: true });
    expect(prompt).not.toContain('models.default-main');
    expect(prompt).not.toContain('capability.image');
  });
});

describe('ACP settings pack', () => {
  const responseTools = ['send_message', 'settings_search', 'settings_read', 'settings_change'].map(
    stub,
  );

  it('injects search / read by default, settings_change only with the settings:change opt-in', () => {
    const capabilities = resolveCapabilities(null, CLAUDE, { isButler: false });
    expect(capabilities).toContain('settings');
    const byDefault = buildExternalAgentTools({
      responseTools,
      capabilities,
      optIns: resolveCapabilityOptIns(null, capabilities),
    }).map((tool) => tool.name);
    expect(byDefault).toEqual(expect.arrayContaining(['settings_search', 'settings_read']));
    expect(byDefault).not.toContain('settings_change');
    // Omitted opt-ins behave like none.
    expect(
      buildExternalAgentTools({ responseTools, capabilities }).map((tool) => tool.name),
    ).not.toContain('settings_change');

    const selected = [...capabilities, 'settings:change'];
    const optedIn = buildExternalAgentTools({
      responseTools,
      capabilities: resolveCapabilities(selected, CLAUDE, { isButler: false }),
      optIns: resolveCapabilityOptIns(
        selected,
        resolveCapabilities(selected, CLAUDE, { isButler: false }),
      ),
    }).map((tool) => tool.name);
    expect(optedIn).toContain('settings_change');
  });

  it('session prompt: the read-only rule without settings_change, the full rule with it', () => {
    const namer = hostToolNamer(claudeProvider, 'kepcup');
    const promptFor = (names: string[]) =>
      buildAgentSessionPrompt({
        bot: BOT,
        conversation: CONV,
        tools: { toolNames: names, nativeCapabilities: CLAUDE.nativeCapabilities, toolName: namer },
      });
    const readOnly = promptFor(['send_message', 'settings_search', 'settings_read']);
    expect(readOnly).toContain('你在这里不能修改设置');
    expect(readOnly).toContain('mcp__kepcup__settings_search');
    expect(readOnly).not.toContain('settings_change');
    const full = promptFor(['send_message', 'settings_search', 'settings_read', 'settings_change']);
    expect(full).toContain('mcp__kepcup__settings_change');
    expect(full).not.toContain('你在这里不能修改设置');
    const none = promptFor(['send_message']);
    expect(none).not.toContain('settings_search');
    expect(SETTINGS_READ_ONLY_RULE).not.toContain('settings_change');
  });
});
