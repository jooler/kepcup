import { describe, expect, it } from 'vitest';
import { conditionLabel, intervalMinutes, watchActions } from './watch-view';

describe('watch-view', () => {
  it('maps conditions to i18n keys with their parameters', () => {
    expect(conditionLabel({ kind: 'changed' })).toEqual({
      key: 'watches.condition.changed',
      params: {},
    });
    expect(conditionLabel({ kind: 'contains', text: '有货' })).toEqual({
      key: 'watches.condition.contains',
      params: { text: '有货' },
    });
    expect(conditionLabel({ kind: 'number_below', value: 95 })).toEqual({
      key: 'watches.condition.number_below',
      params: { value: 95 },
    });
  });

  it('interval in minutes', () => {
    expect(intervalMinutes({ intervalSec: 1800 })).toBe(30);
  });

  it('actions follow the status', () => {
    expect(watchActions({ status: 'active' })).toEqual({ pause: true, resume: false, stop: true });
    expect(watchActions({ status: 'paused' })).toEqual({ pause: false, resume: true, stop: true });
    expect(watchActions({ status: 'stopped' })).toEqual({
      pause: false,
      resume: false,
      stop: false,
    });
  });
});
