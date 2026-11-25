import { beforeEach, describe, expect, it, vi } from 'vitest';


/**
 * 成员域团队设置（T7 步骤 5）：quietHours 表单语义（含跨午夜窗口）、
 * `team.settings.get / update` 的读写、`team.usage.mine` 拉取，以及免打扰
 * 时段内团队来源通知（提及提醒）的抑制（消息本体照常）。
 */

const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: toastMock }));

const h = vi.hoisted(() => ({
  teamCalls: [] as Array<{ method: string; input: unknown }>,
  teamResponder: null as null | ((method: string, input: unknown) => unknown),
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    connection: 'connected',
    onEvent: () => () => undefined,
    onConnected: () => () => undefined,
    call: async () => ({}),
    callTeam: async () => ({}),
  },
}));

vi.mock('$lib/rpc/connections.svelte', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 测试 mock 的模块类型标注。
  const actual = (await importOriginal()) as typeof import('$lib/rpc/connections.svelte');
  return {
    ...actual,
    connections: {
      sources: () => ['local', 'team:h1'],
      onSourcesChanged: (callback: () => void) => {
        queueMicrotask(callback);
        return () => undefined;
      },
      get: (source: string) => ({
        status: 'connected',
        memberId: source === 'team:h1' ? 'mbr_self' : null,
        onConnected: (handler: () => void) => {
          queueMicrotask(handler);
          return () => undefined;
        },
        callTeam: async (method: string, input?: unknown) => {
          h.teamCalls.push({ method, input });
          if (h.teamResponder === null) throw new Error('no responder');
          return h.teamResponder(method, input);
        },
        call: async (method: string, input?: unknown) => {
          h.teamCalls.push({ method, input });
          return {};
        },
      }),
    },
  };
});

const { withinQuietHours, teamSettings } = await import('./team-settings.svelte');
const { notifyTeamMessage } = await import('./team-notify');

function at(hour: number, minute = 0): Date {
  const date = new Date('2026-11-20T00:00:00');
  date.setHours(hour, minute, 0, 0);
  return date;
}

beforeEach(() => {
  h.teamCalls = [];
  h.teamResponder = () => ({ settings: {} });
  toastMock.info.mockClear();
  teamSettings.settingsBySource = {};
  teamSettings.usageBySource = {};
});

describe('withinQuietHours（窗口判定，客户端本地分钟）', () => {
  it('未启用恒 false', () => {
    expect(
      withinQuietHours({ enabled: false, startMinute: 0, endMinute: 1439 }, at(3)),
    ).toBe(false);
  });

  it('同日窗口：start <= minute < end', () => {
    const window = { enabled: true, startMinute: 13 * 60, endMinute: 15 * 60 };
    expect(withinQuietHours(window, at(12, 59))).toBe(false);
    expect(withinQuietHours(window, at(13))).toBe(true);
    expect(withinQuietHours(window, at(14, 30))).toBe(true);
    expect(withinQuietHours(window, at(15))).toBe(false);
  });

  it('跨午夜窗口（22:00–07:00）：晚间与凌晨都在窗内', () => {
    const window = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };
    expect(withinQuietHours(window, at(21, 59))).toBe(false);
    expect(withinQuietHours(window, at(22))).toBe(true);
    expect(withinQuietHours(window, at(23, 30))).toBe(true);
    expect(withinQuietHours(window, at(2))).toBe(true);
    expect(withinQuietHours(window, at(6, 59))).toBe(true);
    expect(withinQuietHours(window, at(7))).toBe(false);
  });

  it('同点窗口视为空窗', () => {
    expect(withinQuietHours({ enabled: true, startMinute: 600, endMinute: 600 }, at(10))).toBe(
      false,
    );
  });
});

describe('team.settings 读写', () => {
  it('连接后自动拉取 team.settings.get', async () => {
    h.teamResponder = () => ({
      settings: { quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 } },
    });
    teamSettings.start();
    await vi.waitFor(() =>
      expect(teamSettings.settingsOf('team:h1')?.quietHours?.enabled).toBe(true),
    );
    expect(teamSettings.quietHoursActive('team:h1')).toBe(
      withinQuietHours(
        { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 },
        new Date(),
      ),
    );
  });

  it('update 走 team.settings.update 并回填返回值', async () => {
    h.teamResponder = (_method, input) => ({
      settings: (input as { settings: unknown }).settings,
    });
    const ok = await teamSettings.update('team:h1', {
      quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 },
    });
    expect(ok).toBe(true);
    expect(h.teamCalls.map((call) => call.method)).toContain('team.settings.update');
    expect(teamSettings.settingsOf('team:h1')?.quietHours).toEqual({
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 8 * 60,
    });
  });
});

describe('team.usage.mine', () => {
  it('拉取 byDay 并按来源存放；失败落 null 占位', async () => {
    h.teamResponder = () => ({
      directTotal: 12.5,
      byDay: [
        { dayStart: Date.UTC(2026, 10, 19), total: 1.5 },
        { dayStart: Date.UTC(2026, 10, 20), total: 11 },
      ],
    });
    await teamSettings.loadUsage('team:h1');
    expect(teamSettings.usageBySource.h1?.byDay).toHaveLength(2);
    expect(teamSettings.usageBySource.h1?.directTotal).toBe(12.5);

    h.teamResponder = () => {
      throw new Error('boom');
    };
    await teamSettings.loadUsage('team:h1');
    expect(teamSettings.usageBySource.h1).toBeNull();
  });
});

describe('免打扰抑制（通知发送点：团队提及提醒）', () => {
  function mentionMessage(): Parameters<typeof notifyTeamMessage>[2] {
    return {
      id: 'm1',
      conversationId: 'dm_1',
      seq: 1,
      senderType: 'bot',
      senderBotId: 'b1',
      kind: 'text',
      content: { text: '@你 看一下这个' },
      replyTo: null,
      mentions: ['principal:mbr_self'],
      batchId: null,
      runId: null,
      status: 'normal',
      editedAt: null,
      createdAt: 1,
      attachments: [],
      ownerBotId: null,
      taskId: null,
    } as never;
  }

  it('非免打扰时段：提及照常提醒', () => {
    notifyTeamMessage('team:h1', { id: 'dm_1', title: '同事乙' }, mentionMessage());
    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it('免打扰时段内（当前时刻落在窗口）：声音 / 提醒抑制，消息本体不受影响', () => {
    const now = new Date();
    // 窗口覆盖当前时刻：起点在 5 分钟前，持续 2 小时。
    const start = (now.getHours() * 60 + now.getMinutes() - 5 + 1440) % 1440;
    const end = (start + 120) % 1440;
    teamSettings.settingsBySource = {
      h1: { quietHours: { enabled: true, startMinute: start, endMinute: end } },
    };
    expect(teamSettings.quietHoursActive('team:h1')).toBe(true);
    notifyTeamMessage('team:h1', { id: 'dm_1', title: '同事乙' }, mentionMessage());
    expect(toastMock.info).not.toHaveBeenCalled();
  });
});
