import { describe, expect, it } from 'vitest';
import { buildUpdateInput, isInfoWarning, type TodoFormValues } from './todo-form';
import { draftFromSchedule, emptyWhenDraft, type WhenDraft } from './when-presets';

const base = (patch: Partial<TodoFormValues> = {}): TodoFormValues => ({
  title: 'T',
  notes: '',
  assigneeKey: 'bot:a',
  leadBotId: '',
  assignee: { kind: 'bot', botId: 'a' },
  when: emptyWhenDraft(),
  ...patch,
});
const withWhen = (when: WhenDraft, patch: Partial<TodoFormValues> = {}): TodoFormValues =>
  base({ when, ...patch });
const free = { planLocked: false, omitWhen: false };

describe('buildUpdateInput', () => {
  it('什么都没改：null', () => {
    expect(buildUpdateInput('t1', base(), base(), free)).toBeNull();
  });

  it('只带改动过的字段；标题 trim', () => {
    expect(buildUpdateInput('t1', base(), base({ title: ' New ', notes: 'n' }), free)).toEqual({
      id: 't1',
      title: 'New',
      notes: 'n',
    });
  });

  it('选「立即」：when:"now" 随同一次 update 提交，不再有单独的 start', () => {
    const form = withWhen({ ...emptyWhenDraft(), mode: 'now' });
    expect(buildUpdateInput('t1', base(), form, free)).toEqual({ id: 't1', when: 'now' });
  });

  it('周期 → 立即：when:"now" 覆盖原周期（由 core 收尾）', () => {
    const periodic = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
      'Asia/Shanghai',
    );
    const form = withWhen({ ...periodic, mode: 'now' });
    expect(buildUpdateInput('t1', withWhen(periodic), form, free)).toEqual({
      id: 't1',
      when: 'now',
    });
  });

  it('只改执行者：不重发 when（即使原本有排期）', () => {
    const periodic = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
      'Asia/Shanghai',
    );
    const form = withWhen(periodic, {
      assigneeKey: 'bot:b',
      assignee: { kind: 'bot', botId: 'b' },
    });
    expect(buildUpdateInput('t1', withWhen(periodic), form, free)).toEqual({
      id: 't1',
      assignee: { kind: 'bot', botId: 'b' },
    });
  });

  it('清掉时间：when:null；改成重复：cron', () => {
    const periodic = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
      'Asia/Shanghai',
    );
    expect(buildUpdateInput('t1', withWhen(periodic), base(), free)).toEqual({
      id: 't1',
      when: null,
    });
    const weekly = {
      ...emptyWhenDraft(),
      mode: 'repeat' as const,
      preset: { kind: 'weekdays' as const, time: '08:30' },
    };
    expect(buildUpdateInput('t1', base(), withWhen(weekly), free)).toEqual({
      id: 't1',
      when: '30 8 * * 1-5',
    });
  });

  it('立即开始（omitWhen）：时间草稿不带上，其余字段照存', () => {
    const form = withWhen(
      { ...emptyWhenDraft(), mode: 'once', onceLocal: '2099-01-01T09:00' },
      { title: 'X' },
    );
    expect(buildUpdateInput('t1', base(), form, { planLocked: false, omitWhen: true })).toEqual({
      id: 't1',
      title: 'X',
    });
    expect(
      buildUpdateInput('t1', base(), withWhen({ ...emptyWhenDraft(), mode: 'now' }), {
        planLocked: false,
        omitWhen: true,
      }),
    ).toBeNull();
  });

  it('已开始 / 已结束（planLocked）：不带时间', () => {
    const form = withWhen({ ...emptyWhenDraft(), mode: 'now' }, { notes: 'n' });
    expect(buildUpdateInput('t1', base(), form, { planLocked: true, omitWhen: false })).toEqual({
      id: 't1',
      notes: 'n',
    });
  });

  it('项目组执行者改负责 Bot：带整个 assignee', () => {
    const project = (lead: string): TodoFormValues =>
      base({
        assigneeKey: 'project:g',
        leadBotId: lead,
        assignee: { kind: 'project', projectId: 'g', leadBotId: lead === '' ? null : lead },
      });
    expect(buildUpdateInput('t1', project(''), project('b'), free)).toEqual({
      id: 't1',
      assignee: { kind: 'project', projectId: 'g', leadBotId: 'b' },
    });
  });
});

describe('isInfoWarning', () => {
  it('免打扰时段的说明是信息，其余是警示', () => {
    expect(isInfoWarning('该时间在 Bot 的免打扰时段内，不受免打扰限制，会照常发出')).toBe(true);
    expect(isInfoWarning('该 Bot 未配置可用模型')).toBe(false);
  });
});
