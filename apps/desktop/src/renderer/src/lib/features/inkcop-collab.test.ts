import { describe, expect, it } from 'vitest';
import {
  inkcopCollabEnabled,
  isHiddenInkcopBot,
  isHiddenInkcopConversation,
  isInkcopLocalBot,
} from './inkcop-collab-prefs';
import type { Bot, Settings } from '@kepcup/shared';

function settings(partial: Partial<Settings['inkcopLocalCollab']>): Settings {
  return {
    inkcopLocalCollab: {
      enabled: false,
      systemBotId: '',
      ...partial,
    },
  } as Settings;
}

function bot(id: string, transport: '' | 'inkcop-local' = ''): Bot {
  return {
    id,
    name: id,
    avatar: null,
    bio: '',
    profile: {
      identity: { name: id, bio: '', avatar: '' },
      persona: {
        personality: '',
        tone: '',
        style: '',
        values: '',
        sample_dialogues: '',
      },
      role: { expertise: '', responsibilities: '' },
      boundaries: [],
      runtime: {
        model: '',
        light_model: '',
        network_policy: 'open',
        network_allowlist: [],
        mcp_server_ids: [],
        app_connection_ids: [],
        browser_profile: '',
        message_transport: transport,
        inkcop_agent_keys: [],
        agent: {
          id: '',
          model: '',
          effort: '',
          permission: 'workspace',
          capabilities: null,
        },
      },
      behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: null },
    },
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('inkcop-collab prefs', () => {
  it('detects inkcop-local bots and enabled flag', () => {
    expect(isInkcopLocalBot(bot('a', 'inkcop-local'))).toBe(true);
    expect(isInkcopLocalBot(bot('a'))).toBe(false);
    expect(inkcopCollabEnabled(settings({ enabled: true }))).toBe(true);
    expect(inkcopCollabEnabled(settings({ enabled: false }))).toBe(false);
    expect(inkcopCollabEnabled(null)).toBe(false);
  });

  it('hides system / inkcop-local bots when collab is off', () => {
    const off = settings({ enabled: false, systemBotId: 'sys' });
    const on = settings({ enabled: true, systemBotId: 'sys' });
    expect(isHiddenInkcopBot(bot('sys', 'inkcop-local'), off)).toBe(true);
    expect(isHiddenInkcopBot(bot('other'), off)).toBe(false);
    expect(isHiddenInkcopBot(bot('sys', 'inkcop-local'), on)).toBe(false);
    expect(
      isHiddenInkcopConversation(
        { type: 'direct', directBotId: 'sys', bot: bot('sys', 'inkcop-local') },
        off,
      ),
    ).toBe(true);
    expect(
      isHiddenInkcopConversation(
        { type: 'direct', directBotId: 'sys', bot: bot('sys', 'inkcop-local') },
        on,
      ),
    ).toBe(false);
  });
});
