import { describe, expect, it } from 'vitest';
import { episodeLimitsFromEnv } from '../../src/dispatch/episodes.js';

/**
 * e2e seam `KEPCUP_TEST_EPISODE_LIMITS`（D92 T1a WP8）："hops,pair" 两个正整
 * 数覆盖熔断阈值。缺省 / 非法 / 非正数的部分被忽略（该部分回落到 shared
 * 常量）；start.ts 只在 `__KEPCUP_TEST_HOOKS__` 为真时读它。
 */
describe('episodeLimitsFromEnv', () => {
  it('合法值："2,2" 同时覆盖 hops 与 pair（ flooring 小数）', () => {
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '2,2' })).toEqual({
      hops: 2,
      pair: 2,
    });
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '3.9,5.1' })).toEqual({
      hops: 3,
      pair: 5,
    });
  });

  it('缺省 / 空字符串：不覆盖任何阈值', () => {
    expect(episodeLimitsFromEnv({})).toEqual({});
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '' })).toEqual({});
  });

  it('非法值：整个或单个部分被忽略', () => {
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: 'abc,x' })).toEqual({});
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: 'x,3' })).toEqual({ pair: 3 });
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '4,y' })).toEqual({ hops: 4 });
    // 允许前后空白（shell 环境变量常见的松弛解析）。
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: ' 2, 2 ' })).toEqual({
      hops: 2,
      pair: 2,
    });
  });

  it('非正数：被忽略（0 与负数都不是合法阈值）', () => {
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '0,0' })).toEqual({});
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '-1,2' })).toEqual({ pair: 2 });
    expect(episodeLimitsFromEnv({ KEPCUP_TEST_EPISODE_LIMITS: '2,-3' })).toEqual({ hops: 2 });
  });
});
