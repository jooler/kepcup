import { describe, expect, it } from 'vitest';
import { PROJECT_GOAL_MAX_CHARS, PROJECT_TITLE_MAX } from '@kepcup/shared';
import { planGoalSave, planTitleSave } from './project-settings-model';

describe('planTitleSave（详情页标题失焦保存判定）', () => {
  it('空串还原已保存标题，不提交', () => {
    expect(planTitleSave('', '旧名')).toEqual({ kind: 'restore' });
    expect(planTitleSave('   ', '旧名')).toEqual({ kind: 'restore' });
  });

  it('与当前相同（含仅空白差异）不提交', () => {
    expect(planTitleSave('官网改版', '官网改版')).toEqual({ kind: 'skip' });
    expect(planTitleSave('  官网改版  ', '官网改版')).toEqual({ kind: 'skip' });
  });

  it('变化了才提交，且先 trim', () => {
    expect(planTitleSave(' 新名字 ', '旧名')).toEqual({ kind: 'save', value: '新名字' });
  });

  it('超长按上限截断', () => {
    const long = '长'.repeat(PROJECT_TITLE_MAX + 10);
    expect(planTitleSave(long, '旧名')).toEqual({
      kind: 'save',
      value: '长'.repeat(PROJECT_TITLE_MAX),
    });
  });
});

describe('planGoalSave（详情页目标失焦保存判定）', () => {
  it('清空 = 清除目标，提交 null', () => {
    expect(planGoalSave('', '原有目标')).toEqual({ kind: 'save', value: null });
    expect(planGoalSave('   ', '原有目标')).toEqual({ kind: 'save', value: null });
  });

  it('本来就是空目标，再清空不提交', () => {
    expect(planGoalSave('', null)).toEqual({ kind: 'skip' });
    expect(planGoalSave('  ', '')).toEqual({ kind: 'skip' });
  });

  it('与当前相同不提交；变化了提交 trim 后的值', () => {
    expect(planGoalSave(' 十一月前上线 ', '十一月前上线')).toEqual({ kind: 'skip' });
    expect(planGoalSave(' 十一月前上线 ', '旧目标')).toEqual({
      kind: 'save',
      value: '十一月前上线',
    });
  });

  it('超长按上限截断', () => {
    const long = '目'.repeat(PROJECT_GOAL_MAX_CHARS + 5);
    expect(planGoalSave(long, null)).toEqual({
      kind: 'save',
      value: '目'.repeat(PROJECT_GOAL_MAX_CHARS),
    });
  });
});
