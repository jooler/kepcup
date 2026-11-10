import { describe, expect, test } from 'vitest';
import type { ProviderInstance } from '@kepcup/shared';
import {
  fetchedToProviderModel,
  mergeFetchedProviderModels,
  PROVIDER_API_OPTIONS,
} from './provider-instances';

function instance(models: ProviderInstance['models']): ProviderInstance {
  return {
    id: 'custom:relay',
    vendor: null,
    name: 'Relay',
    baseUrl: 'https://api.example.com/v1',
    enabled: true,
    api: 'openai-completions',
    builtinCatalog: false,
    models,
  };
}

describe('provider fetched models merge', () => {
  test('拉取条目映射为对话模型：contextWindow 用远端提示，缺省 128k', () => {
    expect(
      fetchedToProviderModel({ id: 'm-1', contextWindow: 262_144 }),
    ).toEqual({ id: 'm-1', contextWindow: 262_144, capabilities: ['chat'] });
    expect(fetchedToProviderModel({ id: 'm-2' })).toEqual({
      id: 'm-2',
      contextWindow: 128_000,
      capabilities: ['chat'],
    });
    expect(fetchedToProviderModel({ id: 'm-3', name: 'Model 3' })).toEqual({
      id: 'm-3',
      name: 'Model 3',
      contextWindow: 128_000,
      capabilities: ['chat'],
    });
  });

  test('合并只新增不覆盖：已登记条目的手工编辑（上下文 / 能力）保持不变', () => {
    const current = instance([
      {
        id: 'm-1',
        contextWindow: 999_999,
        capabilities: ['chat', 'embedding'],
        input: ['text', 'image'],
      },
      { id: 'm-2', contextWindow: 4096, capabilities: ['chat'] },
    ]);
    const merged = mergeFetchedProviderModels(current, [
      { id: 'm-1', contextWindow: 65536, name: '远端展示名' },
      { id: 'm-3' },
    ]);
    expect(merged).toEqual([
      {
        id: 'm-1',
        contextWindow: 999_999,
        capabilities: ['chat', 'embedding'],
        input: ['text', 'image'],
      },
      { id: 'm-2', contextWindow: 4096, capabilities: ['chat'] },
      { id: 'm-3', contextWindow: 128_000, capabilities: ['chat'] },
    ]);
  });

  test('空实例全部按新条目并入；重复拉取幂等', () => {
    const empty = instance([]);
    const fetched = [{ id: 'a' }, { id: 'b' }];
    const once = mergeFetchedProviderModels(empty, fetched);
    expect(once.map((m) => m.id)).toEqual(['a', 'b']);
    expect(mergeFetchedProviderModels({ ...empty, models: once }, fetched)).toEqual(once);
  });

  test('数据风格选项固定为三种线协议（与 providerApiSchema 一致）', () => {
    expect(PROVIDER_API_OPTIONS).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });
});
