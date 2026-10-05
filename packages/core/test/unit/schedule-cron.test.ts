import { describe, expect, it } from 'vitest';
import { isValidCron, nextCronFireAt } from '../../src/schedule/cron.js';

describe('P10：cron 下次触发时间（时区与夏令时）', () => {
  it('工作日 09:00（Asia/Shanghai）：按周几过滤、时刻精确', () => {
    // 2026-09-28T02:00Z = 周日 10:00 +08 → 下一个是周一 09:00 +08
    expect(nextCronFireAt('0 9 * * 1-5', 'Asia/Shanghai', Date.parse('2026-09-28T02:00:00Z'))).toBe(
      Date.parse('2026-09-29T01:00:00Z'),
    );
    // 周一 09:01 → 下一个是周二
    expect(nextCronFireAt('0 9 * * 1-5', 'Asia/Shanghai', Date.parse('2026-09-29T01:00:00Z'))).toBe(
      Date.parse('2026-09-30T01:00:00Z'),
    );
  });

  it('时区偏移换算正确（纽约 09:00 = 13:00Z 冬令时）', () => {
    expect(nextCronFireAt('0 9 * * *', 'America/New_York', Date.parse('2026-01-05T00:00:00Z'))).toBe(
      Date.parse('2026-01-05T14:00:00Z'),
    );
  });

  it('spring forward：被跳过的墙钟时刻落到跳变之后（每日报 02:30，纽约）', () => {
    // 2026-03-08 美东 02:00→03:00：02:30 不存在，解析为 03:30 EDT = 07:30Z
    expect(nextCronFireAt('30 2 * * *', 'America/New_York', Date.parse('2026-03-08T05:00:00Z'))).toBe(
      Date.parse('2026-03-08T07:30:00Z'),
    );
  });

  it('fall back：歧义墙钟时刻只触发一次（每日报 01:30，纽约）', () => {
    // 2026-11-01 美东 02:00 EDT 回拨 01:00 EST：01:30 出现两次但只触发第一次
    const parser = nextCronFireAt('30 1 * * *', 'America/New_York', Date.parse('2026-10-31T20:00:00Z'));
    expect(parser).toBe(Date.parse('2026-11-01T05:30:00Z')); // 01:30 EDT
    expect(nextCronFireAt('30 1 * * *', 'America/New_York', Date.parse('2026-11-01T05:30:00Z'))).toBe(
      Date.parse('2026-11-02T06:30:00Z'),
    );
  });

  it('非法表达式与 @ 快捷字', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 99 * * *')).toBe(false);
    expect(nextCronFireAt('not a cron', 'UTC', Date.now())).toBeNull();
  });

  it('严格晚于给定时刻', () => {
    const at = Date.parse('2026-10-01T01:00:00Z');
    expect(nextCronFireAt('0 * * * *', 'UTC', at)).toBe(at + 60 * 60 * 1000);
  });
});
