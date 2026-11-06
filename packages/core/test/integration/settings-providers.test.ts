import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskApiKey } from '@kepcup/shared';
import { createMemoryKeystore } from '@kepcup/core';
import { createTestStack, makeBot, openDirect, type TestStack } from '@kepcup/testkit';
import { startMockLlm, step } from '@kepcup/testkit';
import { createTestCore } from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

const KEY = 'sk-persistence-check-123';

describe('settings and provider key persistence', () => {
  it('an API key stays usable across a core restart; the key value is never returned', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-key-'));
    const keystore = createMemoryKeystore();
    const llm = await startMockLlm();
    try {
      const first = await createTestCore({
        home,
        keystore,
        env: { KEPCUP_MOCK_LLM_URL: llm.url },
      });
      await first.rpc.call('providers.setKey', { provider: 'custom:mock', key: KEY });

      const before = (await first.rpc.call('providers.list')) as {
        providers: Array<{ id: string; hasKey: boolean }>;
      };
      expect(before.providers.find((p) => p.id === 'custom:mock')?.hasKey).toBe(true);
      expect(JSON.stringify(before).includes(KEY)).toBe(false);
      await first.close();

      const second = await createTestCore({
        home,
        keystore,
        env: { KEPCUP_MOCK_LLM_URL: llm.url },
      });
      try {
        const after = (await second.rpc.call('providers.list')) as {
          providers: Array<{ id: string; hasKey: boolean }>;
        };
        expect(after.providers.find((p) => p.id === 'custom:mock')?.hasKey).toBe(true);
        expect(JSON.stringify(after).includes(KEY)).toBe(false);
      } finally {
        await second.close();
      }
    } finally {
      await llm.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('一个供应商可保存多个 Key：列表只回掩码预览，可按下标删除', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;

    const first = 'sk-first-1234';
    const second = 'sk-proj-second-9876';
    await core.rpc.call('providers.setKey', { provider: 'custom:mock', key: first });
    await core.rpc.call('providers.addKey', { provider: 'custom:mock', key: second });

    const list = (await core.rpc.call('providers.list')) as {
      providers: Array<{ id: string; hasKey: boolean; keyPreviews: string[] }>;
    };
    const info = list.providers.find((p) => p.id === 'custom:mock');
    expect(info).toMatchObject({
      hasKey: true,
      keyPreviews: [maskApiKey(first), maskApiKey(second)],
    });
    const serialized = JSON.stringify(list);
    expect(serialized.includes(first)).toBe(false);
    expect(serialized.includes(second)).toBe(false);

    await core.rpc.call('providers.removeKeyAt', { provider: 'custom:mock', index: 0 });
    const after = (await core.rpc.call('providers.list')) as {
      providers: Array<{ id: string; keyPreviews: string[] }>;
    };
    expect(after.providers.find((p) => p.id === 'custom:mock')?.keyPreviews).toEqual([
      maskApiKey(second),
    ]);
  });

  it('providers.test succeeds against the mock and reports PROVIDER_AUTH_FAILED on 401', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;

    llm.script('mock-main', [step().replyText('pong')]);
    await expect(core.rpc.call('providers.test', { provider: 'custom:mock' })).resolves.toEqual({
      ok: true,
    });

    llm.script('mock-light', [step().failWith(401, 'Incorrect API key provided')]);
    await expect(
      core.rpc.call('providers.test', { provider: 'custom:mock', model: 'mock-light' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });

  it('国内厂商：条目经 settings.update 持久化，providers.test 缺省按对话/能力配置路由（不误报 Unknown provider）', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;

    // baseUrl 指向必拒端口：探测拿到连接错误，错误码即可证明路由正确。
    const next = (await core.rpc.call('settings.update', {
      modelProviders: [
        {
          id: 'dashscope',
          vendor: 'dashscope',
          name: '阿里云百炼',
          baseUrl: 'http://127.0.0.1:9',
          enabled: true,
          models: [{ id: 'qwen-plus' }],
        },
      ],
    })) as { modelProviders?: Array<Record<string, unknown>> };
    expect(next.modelProviders).toEqual([
      {
        id: 'dashscope',
        vendor: 'dashscope',
        name: '阿里云百炼',
        baseUrl: 'http://127.0.0.1:9',
        enabled: true,
        api: 'openai-completions',
        builtinCatalog: false,
        models: [{ id: 'qwen-plus', contextWindow: 128_000, capabilities: ['chat'] }],
      },
    ]);
    await core.rpc.call('providers.setKey', { provider: 'dashscope', key: 'sk-dash' });

    const list = (await core.rpc.call('providers.list')) as {
      providers: Array<{
        id: string;
        kind: string;
        enabled: boolean;
        hasKey: boolean;
        models: Array<{ id: string; name: string; contextWindow: number; capabilities: string[] }>;
      }>;
    };
    const dashscope = list.providers.find((p) => p.id === 'dashscope');
    expect(dashscope).toMatchObject({ kind: 'vendor', hasKey: true, enabled: true });
    expect(dashscope?.models).toEqual([
      { id: 'qwen-plus', name: 'qwen-plus', contextWindow: 128_000, capabilities: ['chat'] },
    ]);

    // 显式 capability=chat → 注册表对话探测：连接被拒（PROVIDER_UNAVAILABLE），
    // 而非 NOT_FOUND「Unknown provider」。
    await expect(
      core.rpc.call('providers.test', {
        provider: 'dashscope',
        model: 'qwen-plus',
        capability: 'chat',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    // 缺省 capability（「更换 Key」弹框形态）→ 条目有对话模型，走对话探测。
    await expect(core.rpc.call('providers.test', { provider: 'dashscope' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('国内厂商：无对话条目但配置了能力模型时，缺省测试按该能力路由；能力配置独立于条目', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;

    // 厂商兼容根指向 mock LLM（其 /v1/embeddings 返回确定性向量）：
    // embedding 能力探测打到 mock 端点，返回 ok 即证明按能力路由。
    // modelProviders 是整体覆盖 patch：读最新设置、map/filter 后回写。
    const dashscopeInstance = {
      id: 'dashscope',
      vendor: 'dashscope' as const,
      name: '阿里云百炼',
      baseUrl: llm.url,
      enabled: true,
      models: [],
    };
    await core.rpc.call('providers.setKey', { provider: 'dashscope', key: 'sk-ds' });
    const before = (await core.rpc.call('settings.get')) as {
      modelProviders: Array<{ id: string }>;
    };
    await core.rpc.call('settings.update', {
      modelProviders: [
        ...before.modelProviders.filter((p) => p.id !== 'dashscope'),
        dashscopeInstance,
      ],
      capabilityModels: {
        embedding: { provider: 'dashscope', model: 'text-embedding-v4' },
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
        image: null,
        video: null,
      },
    });

    // 缺省 capability 且实例无对话模型 → 按 embedding 能力探测。
    await expect(core.rpc.call('providers.test', { provider: 'dashscope' })).resolves.toEqual({
      ok: true,
    });

    // 能力配置独立于对话模型登记：重写实例（仍不登记对话模型）后能力配置与 key 仍生效。
    await core.rpc.call('settings.update', {
      modelProviders: [
        ...before.modelProviders.filter((p) => p.id !== 'dashscope'),
        dashscopeInstance,
      ],
    });
    const settings = (await core.rpc.call('settings.get')) as {
      capabilityModels: { embedding: { provider: string; model: string } | null };
      modelProviders: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(settings.capabilityModels.embedding).toEqual({
      provider: 'dashscope',
      model: 'text-embedding-v4',
    });
    expect(settings.modelProviders.find((p) => p.id === 'dashscope')!.models).toEqual([]);
  });

  it('联网检索：provider 经 settings.update 持久化，key 经 websearch.setKey 落 secrets 不回流；清除置 null', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;

    // 回归：settingsUpdateInputSchema 曾漏声明 webSearch，zod 静默剥键——
    // 保存「成功」但重新读取仍为未配置。
    const updated = (await core.rpc.call('settings.update', {
      webSearch: { provider: 'tavily' },
    })) as { webSearch: { provider: string | null }; launchAtLogin: boolean };
    expect(updated.webSearch.provider).toBe('tavily');
    // 整覆盖 patch 只换 webSearch 对象，其余字段原样保留。
    expect(updated.launchAtLogin).toBe(true);

    const reread = (await core.rpc.call('settings.get')) as {
      webSearch: { provider: string | null };
    };
    expect(reread.webSearch.provider).toBe('tavily');

    // key 落 secrets（websearch:{provider}），任何 settings 读取都不含明文。
    await core.rpc.call('websearch.setKey', { provider: 'tavily', key: 'tvly-secret-1' });
    const afterKey = (await core.rpc.call('settings.get')) as { webSearch: unknown };
    expect(JSON.stringify(afterKey).includes('tvly-secret-1')).toBe(false);

    // 清除（设置页「清除」按钮）：provider 置 null，未配置徽章恢复。
    await core.rpc.call('settings.update', { webSearch: { provider: null } });
    const cleared = (await core.rpc.call('settings.get')) as {
      webSearch: { provider: string | null };
    };
    expect(cleared.webSearch.provider).toBeNull();
  });

  it('opening the direct chat twice returns the same conversation', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;
    const bot = await makeBot(core, '小艾');
    const first = await openDirect(core, bot.id);
    const second = await openDirect(core, bot.id);
    expect(second.id).toBe(first.id);
    const list = (await core.rpc.call('conversations.list')) as {
      conversations: Array<{ id: string }>;
    };
    expect(list.conversations).toHaveLength(1);
  });
});
