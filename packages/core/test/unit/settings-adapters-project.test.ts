import { describe, expect, it } from 'vitest';
import {
  effectiveMode,
  getSettingItem,
  type SettingItem,
  type SettingModeContext,
  type SettingValues,
} from '@kepcup/shared';
import { buildItemAdapters } from '../../src/settings/contributions/index.js';
import type { AdapterDeps, ItemAdapter } from '../../src/settings/adapters.js';

/**
 * WP4 §3.D.5 / §4.4：`project.title` / `project.goal` / `project.members` /
 * `project.lead` 四个适配器的读与提议；负责人对非成员 / 管家拒绝；四项
 * `effectiveMode` 都不会是 `direct`（maxMode = confirm）；非项目组会话拒绝。
 */

interface ConversationRow {
  id: string;
  type: string;
  title: string | null;
  goal: string | null;
  leadBotId: string | null;
  readOnly: boolean;
}

function harness(conversations: ConversationRow[], members: Record<string, string[]> = {}) {
  const bots = new Map<string, { id: string; name: string; status: string; systemRole: string | null }>(
    [
      ['bot_lead', { id: 'bot_lead', name: '负责人甲', status: 'active', systemRole: null }],
      ['bot_member', { id: 'bot_member', name: '成员乙', status: 'active', systemRole: null }],
      ['bot_butler', { id: 'bot_butler', name: '管家', status: 'active', systemRole: 'butler' }],
      ['bot_out', { id: 'bot_out', name: '组外人', status: 'active', systemRole: null }],
    ],
  );
  const updates: Array<{ conversationId: string; patch: Record<string, unknown> }> = [];
  const leads: Array<{ conversationId: string; botId: string }> = [];
  const deps: AdapterDeps = {
    settings: { get: () => ({}) as never, update: () => ({}) as never },
    secrets: { hasValue: () => false, setValue: () => undefined },
    providers: { list: () => [], setKey: () => undefined },
    bots: {
      get: (id) => (bots.get(id) as never) ?? null,
      listActive: () => [...bots.values()] as never,
    },
    botProfiles: { apply: () => ({ bot: {} as never, changedItemIds: [], settle: async () => undefined }) },
    conversations: {
      get: (id) => {
        const conversation = conversations.find((row) => row.id === id);
        return conversation ?? null;
      },
      memberBotIds: (id) => members[id] ?? [],
    },
    projects: {
      update: (conversationId, patch) => {
        updates.push({ conversationId, patch: { ...patch } });
      },
      setLead: (conversationId, botId) => {
        leads.push({ conversationId, botId });
      },
    },
    publish: () => undefined,
  };
  const adapters = buildItemAdapters(deps);
  const projectTarget = { botId: null, conversationId: 'conv_p', workdirId: null };
  return { adapters, projectTarget, updates, leads };
}

function item(id: string): SettingItem {
  const found = getSettingItem(id);
  if (found === null) throw new Error(`missing catalog item ${id}`);
  return found;
}

function adapterOf(adapters: ReturnType<typeof buildItemAdapters>, id: string): ItemAdapter {
  return adapters(item(id));
}

const project = (): ConversationRow => ({
  id: 'conv_p',
  type: 'project',
  title: '发布项目组',
  goal: '按时发布',
  leadBotId: 'bot_lead',
  readOnly: false,
});

describe('project.title / project.goal 适配器（WP4 §3.D.5）', () => {
  it('读：标题与目标（脱敏摘要）；写：经 projects.update', () => {
    const { adapters, projectTarget, updates } = harness([project()]);
    const title = adapterOf(adapters, 'project.title').read(item('project.title'), projectTarget);
    expect(title.status).toBe('configured');
    expect(title.values).toEqual({ title: '发布项目组' });
    const goal = adapterOf(adapters, 'project.goal').read(item('project.goal'), projectTarget);
    expect(goal.values).toEqual({ goal: '按时发布' });

    adapterOf(adapters, 'project.title').write?.(item('project.title'), {
      next: { title: '新名字' },
      secrets: {},
    }, projectTarget);
    adapterOf(adapters, 'project.goal').write?.(item('project.goal'), {
      next: { goal: '新目标' },
      secrets: {},
    }, projectTarget);
    expect(updates).toEqual([
      { conversationId: 'conv_p', patch: { title: '新名字' } },
      { conversationId: 'conv_p', patch: { goal: '新目标' } },
    ]);
  });

  it('写校验：空标题 / 空目标拒绝', () => {
    const { adapters, projectTarget } = harness([project()]);
    expect(
      adapterOf(adapters, 'project.title').normalize?.(item('project.title'), { title: '  ' }, projectTarget),
    ).toEqual({ ok: false, message: '项目名称不能为空' });
    expect(
      adapterOf(adapters, 'project.goal').normalize?.(item('project.goal'), { goal: '' }, projectTarget),
    ).toEqual({ ok: false, message: '项目目标不能为空' });
  });
});

describe('project.members 适配器（WP4 §3.D.5）', () => {
  it('读：现有成员；提议 = 现有成员 ∪ 提议的 Bot（预填不删人）；选项不含管家', () => {
    const { adapters, projectTarget } = harness([project()], {
      conv_p: ['bot_lead', 'bot_member'],
    });
    const adapter = adapterOf(adapters, 'project.members');
    const snapshot = adapter.read(item('project.members'), projectTarget);
    expect(snapshot.values).toEqual({ bots: ['bot_lead', 'bot_member'] });

    const proposed = adapter.proposal?.(
      item('project.members'),
      { bots: ['bot_out', 'bot_lead'] },
      { status: 'configured', values: { bots: ['bot_lead', 'bot_member'] }, secrets: {}, summary: '' },
    ) as SettingValues;
    expect(proposed).toEqual({ bots: ['bot_lead', 'bot_member', 'bot_out'] });

    const options = adapter.options?.(item('project.members').fields[0]!, item('project.members'), projectTarget) ?? [];
    const ids = options.map((option) => option.value).sort();
    expect(ids).toEqual(['bot_lead', 'bot_member', 'bot_out']);
    expect(ids).not.toContain('bot_butler');
  });
});

describe('project.lead 适配器（WP4 §3.D.5）', () => {
  it('读：当前负责人名；写：经 projects.setLead', () => {
    const { adapters, projectTarget, leads } = harness([project()], {
      conv_p: ['bot_lead', 'bot_member'],
    });
    const adapter = adapterOf(adapters, 'project.lead');
    const snapshot = adapter.read(item('project.lead'), projectTarget);
    expect(snapshot.summary).toBe('负责人甲');
    expect(snapshot.values).toEqual({ botId: 'bot_lead' });

    adapter.normalize?.(item('project.lead'), { botId: 'bot_member' }, projectTarget);
    adapter.write?.(item('project.lead'), { next: { botId: 'bot_member' }, secrets: {} }, projectTarget);
    expect(leads).toEqual([{ conversationId: 'conv_p', botId: 'bot_member' }]);
  });

  it('normalize：非成员 / 管家 / 不存在的 Bot 拒绝', () => {
    const { adapters, projectTarget } = harness([project()], {
      conv_p: ['bot_lead', 'bot_member'],
    });
    const adapter = adapterOf(adapters, 'project.lead');
    expect(
      adapter.normalize?.(item('project.lead'), { botId: 'bot_out' }, projectTarget),
    ).toEqual({ ok: false, message: '负责人必须是项目组成员' });
    expect(
      adapter.normalize?.(item('project.lead'), { botId: 'bot_butler' }, projectTarget),
    ).toEqual({ ok: false, message: '管家不能当项目负责人' });
    expect(
      adapter.normalize?.(item('project.lead'), { botId: 'bot_gone' }, projectTarget),
    ).toEqual({ ok: false, message: '负责人 Bot 不存在' });
  });
});

describe('非项目组会话拒绝（WP4 §3.D.5）', () => {
  it('direct 会话：读回 unknown「该会话不是项目组」', () => {
    const { adapters, projectTarget } = harness([
      { id: 'conv_p', type: 'direct', title: null, goal: null, leadBotId: null, readOnly: false },
    ]);
    for (const id of ['project.title', 'project.goal', 'project.members', 'project.lead']) {
      const snapshot = adapterOf(adapters, id).read(item(id), projectTarget);
      expect(snapshot.status).toBe('unknown');
      expect(snapshot.summary).toBe('该会话不是项目组');
    }
  });
});

describe('effectiveMode：四项都不会是 direct（WP4 陷阱）', () => {
  const ctx: SettingModeContext = {
    triggerReason: 'direct',
    triggerFromUser: true,
    runTouchedUntrusted: false,
    tainted: false,
    isProject: true,
    targetsOtherBot: false,
    isButler: false,
    loopType: 'turn',
  };
  it('用户本人 direct 触发也只是 confirm', () => {
    for (const id of ['project.title', 'project.goal', 'project.members', 'project.lead']) {
      const decision = effectiveMode(item(id), ctx);
      expect(decision.mode).toBe('confirm');
    }
  });

  it('非用户触发也不会放宽到 direct', () => {
    const decision = effectiveMode(item('project.goal'), { ...ctx, triggerFromUser: false });
    expect(decision.mode).toBe('confirm');
    expect(decision.acceptValues).toBe(true);
  });
});
