import { describe, expect, it } from 'vitest';
import {
  failureText,
  promptStateOf,
  visibleBots,
  type SkillInstallResult,
} from './connected-skills';

describe('connected-skills 纯函数', () => {
  const ok: SkillInstallResult = { name: 'a', status: 'submitted', approvalId: 'x' };
  it('promptStateOf：失败优先，其次新提交，其次待确认', () => {
    expect(promptStateOf(undefined)).toBe('idle');
    expect(promptStateOf([])).toBe('idle');
    expect(promptStateOf([ok])).toBe('submitted');
    expect(promptStateOf([ok, { name: 'b', status: 'failed', error: 'boom' }])).toBe('failed');
    expect(promptStateOf([{ name: 'b', status: 'pending', approvalId: 'y' }])).toBe('pending');
    expect(promptStateOf([{ name: 'b', status: 'installed' }])).toBe('idle');
  });

  it('failureText 只列失败项并去重', () => {
    expect(
      failureText([
        ok,
        { name: 'b', status: 'failed', error: '克隆失败' },
        { name: 'b', status: 'failed', error: '克隆失败' },
        { name: 'c', status: 'failed' },
      ]),
    ).toBe('b：克隆失败；c');
    expect(failureText(undefined)).toBe('');
  });

  it('visibleBots 去掉用户点了「稍后」的 Bot', () => {
    const bots = [
      {
        botId: 'b1',
        botName: '一',
        skills: [{ name: 'a', description: '', source: 'https://x/y' }],
      },
      {
        botId: 'b2',
        botName: '二',
        skills: [{ name: 'a', description: '', source: 'https://x/y' }],
      },
    ];
    expect(visibleBots(bots, new Set(['b1'])).map((b) => b.botId)).toEqual(['b2']);
    expect(visibleBots(bots, new Set())).toHaveLength(2);
  });
});
