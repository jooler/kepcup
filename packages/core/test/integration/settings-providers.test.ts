import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskApiKey } from '@kepcup/shared';
import { createMemoryKeystore } from '@kepcup/core';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
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
      providers: Array<{ id: string; hasKey: boolean; keyPreviews: Array<{ mask: string }> }>;
    };
    const info = list.providers.find((p) => p.id === 'custom:mock');
    expect(info).toMatchObject({
      hasKey: true,
      keyPreviews: [{ mask: maskApiKey(first) }, { mask: maskApiKey(second) }],
    });
    const serialized = JSON.stringify(list);
    expect(serialized.includes(first)).toBe(false);
    expect(serialized.includes(second)).toBe(false);

    await core.rpc.call('providers.removeKeyAt', { provider: 'custom:mock', index: 0 });
    const after = (await core.rpc.call('providers.list')) as {
      providers: Array<{ id: string; keyPreviews: Array<{ mask: string }> }>;
    };
    expect(after.providers.find((p) => p.id === 'custom:mock')?.keyPreviews).toEqual([
      { mask: maskApiKey(second), enabled: true },
    ]);
  });

  it('Key 标注：别名与启停经 providers.setKeyMeta 生效，删除其余 Key 时标注保留', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;

    await core.rpc.call('providers.setKey', { provider: 'custom:mock', key: 'sk-alpha-1111' });
    await core.rpc.call('providers.addKey', { provider: 'custom:mock', key: 'sk-beta-2222' });
    await core.rpc.call('providers.setKeyMeta', {
      provider: 'custom:mock',
      index: 1,
      alias: '备用渠道',
      enabled: false,
    });

    const list = (await core.rpc.call('providers.list')) as {
      providers: Array<{
        id: string;
        hasKey: boolean;
        keyPreviews: Array<{ mask: string; alias?: string; enabled: boolean }>;
      }>;
    };
    const previews = list.providers.find((p) => p.id === 'custom:mock')?.keyPreviews ?? [];
    // 首条启用无别名；第二条带别名且停用——全部启用 Key 为零时 hasKey 视为 false。
    expect(previews).toEqual([
      { mask: maskApiKey('sk-alpha-1111'), enabled: true },
      { mask: maskApiKey('sk-beta-2222'), alias: '备用渠道', enabled: false },
    ]);
    expect(list.providers.find((p) => p.id === 'custom:mock')?.hasKey).toBe(true);
    await core.rpc.call('providers.setKeyMeta', { provider: 'custom:mock', index: 0, enabled: false });
    const allDisabled = (await core.rpc.call('providers.list')) as {
      providers: Array<{ id: string; hasKey: boolean }>;
    };
    expect(allDisabled.providers.find((p) => p.id === 'custom:mock')?.hasKey).toBe(false);

    // 删除首条后重编号：剩余条目的别名与停用状态原样保留；别名可清除（空串）。
    await core.rpc.call('providers.removeKeyAt', { provider: 'custom:mock', index: 0 });
    await core.rpc.call('providers.setKeyMeta', { provider: 'custom:mock', index: 0, alias: '' });
    const after = (await core.rpc.call('providers.list')) as {
      providers: Array<{ keyPreviews: Array<{ alias?: string; enabled: boolean }> }>;
    };
    expect(after.providers.find((p) => p.id === 'custom:mock')?.keyPreviews).toEqual([
      { mask: maskApiKey('sk-beta-2222'), enabled: false },
    ]);

    // 非法下标报 INVALID_INPUT。
    await expect(
      core.rpc.call('providers.setKeyMeta', { provider: 'custom:mock', index: 9, enabled: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('停用的 Key 不参与 Bot 实际调用：请求头只出现启用中的 Key', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;

    await core.rpc.call('providers.setKey', { provider: 'custom:mock', key: 'sk-disabled-1111' });
    await core.rpc.call('providers.addKey', { provider: 'custom:mock', key: 'sk-enabled-2222' });
    await core.rpc.call('providers.setKeyMeta', {
      provider: 'custom:mock',
      index: 0,
      enabled: false,
    });

    llm.script('mock-main', [
      step().replyTextAndToolCall('查询一下', 'search_messages', { query: 'x' }),
      step().replyText('完成'),
    ]);
    const bot = await makeBot(core, '小研');
    const conv = await openDirect(core, bot.id);
    await sendBatch(core, conv.id, ['你好']);
    await waitForRun(core, conv.id, 'completed');

    const requests = llm.requestsFor('mock-main');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((r) => r.authorization)).toEqual(
      requests.map(() => 'Bearer sk-enabled-2222'),
    );
  });

  it('全部 Key 停用时调用失败，且请求不会带着占位 / 环境变量凭据发出', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;

    await core.rpc.call('providers.setKey', { provider: 'custom:mock', key: 'sk-only-1111' });
    await core.rpc.call('providers.setKeyMeta', {
      provider: 'custom:mock',
      index: 0,
      enabled: false,
    });

    // 「测试连接」同样失败，且是鉴权错误（不是网络 / 未知错误）。
    await expect(core.rpc.call('providers.test', { provider: 'custom:mock' })).rejects.toMatchObject(
      { code: 'PROVIDER_AUTH_FAILED' },
    );

    llm.script('mock-main', [step().replyText('不应到达')]);
    const bot = await makeBot(core, '小研');
    const conv = await openDirect(core, bot.id);
    await sendBatch(core, conv.id, ['你好']);
    const run = await waitForRun(core, conv.id, 'failed');

    expect(llm.requests()).toHaveLength(0);
    expect(run.error ?? '').toMatch(/全部停用/);
  }, 30_000);

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

  it('OpenAI 兼容实例不发 store 字段（Gemini 等严格校验端点会因未知字段 400）', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;

    // Gemini（AI Studio OpenAI 兼容层）对请求体做严格字段校验：pi-ai 缺省
    // 会带 OpenAI 专有的 store=false，兼容实例的 compat 必须把它关掉。
    llm.script('mock-main', [step().replyText('pong')]);
    const before = (await core.rpc.call('settings.get')) as {
      modelProviders: Array<Record<string, unknown>>;
    };
    await core.rpc.call('settings.update', {
      modelProviders: [
        ...before.modelProviders,
        {
          id: 'custom:gemini',
          vendor: null,
          name: 'Gemini（OpenAI 兼容）',
          baseUrl: llm.url,
          enabled: true,
          api: 'openai-completions',
          models: [{ id: 'mock-main' }],
        },
      ],
    });
    await core.rpc.call('providers.setKey', { provider: 'custom:gemini', key: 'sk-gemini' });

    await expect(
      core.rpc.call('providers.test', { provider: 'custom:gemini', model: 'mock-main' }),
    ).resolves.toEqual({ ok: true });

    const requests = llm.requestsFor('mock-main');
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect('store' in req.body).toBe(false);
    }
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
