import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      vendorProviders: [
        {
          id: 'dashscope',
          baseUrl: 'http://127.0.0.1:9',
          models: [{ id: 'qwen-plus' }],
        },
      ],
    })) as { vendorProviders?: Array<{ id: string }> };
    expect(next.vendorProviders).toEqual([
      {
        id: 'dashscope',
        baseUrl: 'http://127.0.0.1:9',
        models: [{ id: 'qwen-plus' }],
      },
    ]);
    await core.rpc.call('providers.setKey', { provider: 'dashscope', key: 'sk-dash' });

    const list = (await core.rpc.call('providers.list')) as {
      providers: Array<{
        id: string;
        kind: string;
        hasKey: boolean;
        models: Array<{ id: string }>;
      }>;
    };
    const dashscope = list.providers.find((p) => p.id === 'dashscope');
    expect(dashscope).toMatchObject({ kind: 'vendor', hasKey: true });
    expect(dashscope?.models).toEqual([
      { id: 'qwen-plus', name: 'qwen-plus', contextWindow: 131_072 },
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
    await core.rpc.call('providers.setKey', { provider: 'dashscope', key: 'sk-ds' });
    await core.rpc.call('settings.update', {
      vendorProviders: [
        {
          id: 'dashscope',
          baseUrl: llm.url,
          models: [],
        },
      ],
      capabilityModels: {
        embedding: { vendor: 'dashscope', model: 'text-embedding-v4' },
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
        image: null,
        video: null,
      },
    });

    // 缺省 capability 且条目无对话模型 → 按 embedding 能力探测。
    await expect(core.rpc.call('providers.test', { provider: 'dashscope' })).resolves.toEqual({
      ok: true,
    });

    // 能力配置独立于厂商条目：清空条目后能力配置与 key 仍生效。
    await core.rpc.call('settings.update', {
      vendorProviders: [{ id: 'dashscope', baseUrl: llm.url, models: [] }],
    });
    const settings = (await core.rpc.call('settings.get')) as {
      capabilityModels: { embedding: { vendor: string; model: string } | null };
      vendorProviders: Array<{ models: Array<{ id: string }> }>;
    };
    expect(settings.capabilityModels.embedding).toEqual({
      vendor: 'dashscope',
      model: 'text-embedding-v4',
    });
    expect(settings.vendorProviders[0]!.models).toEqual([]);
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
