import { describe, expect, it } from 'vitest';
import { HARD_CONSTRAINT_MAX_ITEMS, type MemoryItem, type ProfileItem } from '@kepcup/shared';
import {
  collectHardConstraints,
  matchesBoundaryClassConstraint,
  matchesHardConstraint,
} from '../../src/memory/constraints.js';

function profileItem(overrides: Partial<ProfileItem> & { id: string }): ProfileItem {
  return {
    category: 'basic',
    content: '用户是后端工程师',
    source: 'explicit',
    evidence: [],
    contributedBy: null,
    confidence: 1,
    validUntil: null,
    status: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function memoryItem(overrides: Partial<MemoryItem> & { id: string }): MemoryItem {
  return {
    botId: 'bot_1',
    kind: 'fact',
    content: '我对坚果过敏',
    subject: null,
    source: 'explicit',
    evidence: [],
    origin: 'private',
    originConversationId: 'conv_1',
    confidence: 1,
    sensitivity: 'normal',
    dueAt: null,
    validUntil: null,
    status: 'active',
    supersedes: null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('hard constraints (D-memory hard_constraints)', () => {
  it('takes every boundaries entry, but ordinary facts only when they match the word list', () => {
    const constraints = collectHardConstraints({
      profileItems: [
        profileItem({ id: 'prf_boundary', category: 'boundaries', content: '不在深夜打扰' }),
        profileItem({ id: 'prf_fact', category: 'basic', content: '用户是后端工程师' }),
      ],
      privateItems: [],
      isProject: false,
      now: 100,
    });
    expect(constraints.map((entry) => entry.id)).toEqual(['prf_boundary']);
  });

  it('keeps allergy / prohibition facts out of the privacy word list', () => {
    expect(matchesHardConstraint('我对坚果过敏')).toBe(true);
    expect(matchesHardConstraint('不吃香菜')).toBe(true);
    expect(matchesHardConstraint('禁止在群里提这件事')).toBe(true);
    expect(matchesHardConstraint('务必在早上九点前提醒我')).toBe(true);
    // Privacy words alone are not hard constraints.
    expect(matchesHardConstraint('月薪 3 万')).toBe(false);
    expect(matchesHardConstraint('用户是后端工程师')).toBe(false);

    const constraints = collectHardConstraints({
      profileItems: [],
      privateItems: [
        memoryItem({ id: 'mem_allergy', content: '我对坚果过敏' }),
        memoryItem({ id: 'mem_salary', content: '用户月薪 3 万' }),
      ],
      isProject: false,
      now: 100,
    });
    expect(constraints.map((entry) => entry.id)).toEqual(['mem_allergy']);
  });

  it('two-tier word list: strong words apply everywhere, weak words are boundaries-only', () => {
    // 强词：任何来源命中即入选；高频弱词单独出现只是普通偏好，不再入选。
    expect(matchesHardConstraint('回复不要太长')).toBe(false);
    expect(matchesHardConstraint('避免在早上发消息')).toBe(false);
    expect(matchesHardConstraint('不能在会前打断我')).toBe(false);
    // 弱词仍属边界类口径（boundaries 条目按此识别；它们本来无条件入选）。
    expect(matchesBoundaryClassConstraint('回复不要太长')).toBe(true);
    expect(matchesBoundaryClassConstraint('避免在早上发消息')).toBe(true);
    expect(matchesBoundaryClassConstraint('我对坚果过敏')).toBe(true);
    expect(matchesBoundaryClassConstraint('用户是后端工程师')).toBe(false);

    const constraints = collectHardConstraints({
      profileItems: [
        profileItem({ id: 'prf_boundary', category: 'boundaries', content: '不要在晚上九点后发消息' }),
        profileItem({ id: 'prf_pref', category: 'communication', content: '回复不要太长' }),
      ],
      privateItems: [memoryItem({ id: 'mem_pref', content: '避免在早上发消息' })],
      isProject: false,
      now: 100,
    });
    // 负向断言：普通偏好（profile 非 boundaries / 私有记忆）只认强词。
    expect(constraints.map((entry) => entry.id)).toEqual(['prf_boundary']);
  });

  it('filters expired entries and excludes bot-private sensitive entries in projects', () => {
    const constraints = collectHardConstraints({
      profileItems: [profileItem({ id: 'prf_expired', category: 'boundaries', validUntil: 100 })],
      privateItems: [
        memoryItem({ id: 'mem_sensitive', sensitivity: 'sensitive' }),
        memoryItem({ id: 'mem_expired', validUntil: 50 }),
        memoryItem({ id: 'mem_ok', validUntil: 150 }),
      ],
      isProject: true,
      now: 100,
    });
    expect(constraints.map((entry) => entry.id)).toEqual(['mem_ok']);
  });

  it('keeps the private-origin origin annotation for the group-chat warning', () => {
    const constraints = collectHardConstraints({
      profileItems: [],
      privateItems: [
        memoryItem({ id: 'mem_private', content: '务必提前提醒' }),
        memoryItem({ id: 'mem_project', content: '不吃香菜', origin: 'project' }),
      ],
      isProject: false,
      now: 100,
    });
    expect(constraints.find((entry) => entry.id === 'mem_private')).toMatchObject({
      source: 'private',
      origin: 'private',
    });
    expect(constraints.find((entry) => entry.id === 'mem_project')).toMatchObject({
      origin: 'project',
    });
  });

  it('dedupes by content with the shared layer winning, caps entries and content length', () => {
    // 固化上限取值：200 token 预算下单条 CJK 条目（≤120 字 ≈ 100+ token）
    // 只装得下 4-6 条，上限须与预算自洽，不能无意识调大。
    expect(HARD_CONSTRAINT_MAX_ITEMS).toBe(6);
    const long = '不'.repeat(200);
    const constraints = collectHardConstraints({
      profileItems: [
        profileItem({ id: 'prf_dup', category: 'boundaries', content: '我对坚果过敏' }),
        profileItem({ id: 'prf_long', category: 'boundaries', content: long }),
      ],
      privateItems: [memoryItem({ id: 'mem_dup', content: '我对坚果过敏' })],
      isProject: false,
      now: 100,
      maxItems: 2,
    });
    expect(constraints.map((entry) => entry.id)).toEqual(['prf_dup', 'prf_long']);
    expect(constraints[1]!.content).toHaveLength(120);

    const many = collectHardConstraints({
      profileItems: Array.from({ length: HARD_CONSTRAINT_MAX_ITEMS + 3 }, (_, index) =>
        profileItem({ id: `prf_${index}`, category: 'boundaries', content: `约束 ${index}` }),
      ),
      privateItems: [],
      isProject: false,
      now: 100,
    });
    expect(many).toHaveLength(HARD_CONSTRAINT_MAX_ITEMS);
  });
});
