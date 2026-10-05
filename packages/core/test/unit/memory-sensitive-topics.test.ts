import { describe, expect, it } from 'vitest';

import { mentionsSensitiveTopic } from '../../src/memory/sensitive-topics.js';

describe('sensitive topic pre-screen (BR-P07-011: 敏感类别默认不进共享层)', () => {
  it('flags health, finance and relationship facts', () => {
    expect(mentionsSensitiveTopic('用户正在接受失眠治疗')).toBe(true);
    expect(mentionsSensitiveTopic('用户每月工资是三万元')).toBe(true);
    expect(mentionsSensitiveTopic('用户去年离婚了')).toBe(true);
    expect(mentionsSensitiveTopic('用户在做心理咨询')).toBe(true);
  });

  it('leaves ordinary facts alone', () => {
    expect(mentionsSensitiveTopic('用户是后端工程师，主要写 Go')).toBe(false);
    expect(mentionsSensitiveTopic('用户偏好简洁的回复')).toBe(false);
    expect(mentionsSensitiveTopic('用户住在苏州工业园区')).toBe(false);
    expect(mentionsSensitiveTopic('用户在医院工作，是一名护士')).toBe(false);
  });
});
