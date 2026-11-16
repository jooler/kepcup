import { describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { dashscopeAdapter } from '../../src/media/adapters/dashscope.js';
import { openAICompatibleAdapter } from '../../src/media/adapters/openai-compatible.js';
import { volcengineAdapter } from '../../src/media/adapters/volcengine.js';
import { VendorHttpError, vendorFetch } from '../../src/media/http.js';
import type { VendorCallContext } from '../../src/media/types.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
}

/**
 * 顺序消费脚本的 fetch 桩：每个调用匹配一个 handler，未匹配即失败
 * （宁可响亮失败，不留静默通过——与 mock-llm 同一原则）。
 */
function scriptedFetch(handlers: Array<(req: RecordedRequest) => Response>): typeof fetch {
  const queue = [...handlers];
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | FormData | undefined,
    };
    const handler = queue.shift();
    if (handler === undefined) throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
    return handler(req);
  }) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ctx(baseUrl: string, fetchImpl?: typeof fetch): VendorCallContext {
  return {
    vendor: 'dashscope',
    baseUrl,
    apiKey: 'sk-test',
    logger: LOGGER,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  } as VendorCallContext;
}

function readJson(req: RecordedRequest): Record<string, unknown> {
  return JSON.parse(req.body as string) as Record<string, unknown>;
}

describe('dashscope adapter（原生 multimodal-generation / SpeechSynthesizer）', () => {
  it('语音合成：默认音色按模型代际带后缀（parameters 下），audio.url 无鉴权下载并转 base64', async () => {
    const audioBytes = Buffer.from('fake-mp3-bytes');
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(
          'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
        );
        const body = readJson(req);
        // 音色/格式在 parameters 下（input 只有 text）；cosyvoice-v2 → _v2。
        expect(body.input).toEqual({ text: '你好' });
        expect(body.parameters).toMatchObject({ voice: 'longxiaochun_v2', format: 'mp3' });
        return jsonResponse({ output: { audio: { url: 'https://oss.example/audio.mp3' } } });
      },
      (req) => {
        // 结果直链不带 Authorization（带签名的 OSS 链接会被附加鉴权头拒绝）。
        expect(req.url).toBe('https://oss.example/audio.mp3');
        expect(req.headers.authorization).toBeUndefined();
        return new Response(audioBytes);
      },
    ]);
    const result = await dashscopeAdapter.synthesizeSpeech(
      ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
      'cosyvoice-v2',
      {
        text: '你好',
      },
    );
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.audioBase64).toBe(audioBytes.toString('base64'));
  });

  it('语音合成：qwen3-tts 系列分流到 multimodal-generation 端点，默认 Qwen 音色 Cherry', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(
          'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        );
        const body = readJson(req);
        expect(body.model).toBe('qwen3-tts-flash');
        expect(body.input).toEqual({ text: '你好' });
        expect(body.parameters).toMatchObject({ voice: 'Cherry' });
        return jsonResponse({ output: { audio: { url: 'https://oss.example/qwen.wav' } } });
      },
      () => new Response(Buffer.from('fake-wav-bytes')),
    ]);
    const result = await dashscopeAdapter.synthesizeSpeech(
      ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
      'qwen3-tts-flash',
      { text: '你好' },
    );
    expect(result.audioBase64).toBe(Buffer.from('fake-wav-bytes').toString('base64'));
  });

  it('语音合成：qwen-audio-tts 系列走 SpeechSynthesizer + input.text_prompt（不带 voice/parameters）', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(
          'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
        );
        const body = readJson(req);
        // 音频生成系：文本在 input.text_prompt 下，不接受 voice/parameters。
        expect(body.model).toBe('qwen-audio-3.1-tts-next');
        expect(body.input).toEqual({ text_prompt: '你好', format: 'mp3' });
        expect(body.parameters).toBeUndefined();
        return jsonResponse({ output: { audio: { url: 'https://oss.example/next.wav' } } });
      },
      () => new Response(Buffer.from('fake-next-bytes')),
    ]);
    const result = await dashscopeAdapter.synthesizeSpeech(
      ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
      'qwen-audio-3.1-tts-next',
      { text: '你好' },
    );
    expect(result.audioBase64).toBe(Buffer.from('fake-next-bytes').toString('base64'));
  });

  it('语音合成：实时专用型号（qwen-audio-*-tts-flash）直接给出可操作的提示', async () => {
    await expect(
      dashscopeAdapter.synthesizeSpeech(
        ctx('https://dashscope.aliyuncs.com/compatible-mode/v1'),
        'qwen-audio-3.1-tts-flash',
        { text: '你好' },
      ),
    ).rejects.toThrow('qwen-audio-3.1-tts-next');
  });

  it('语音识别：qwen3-asr 走兼容 chat/completions + input_audio data URI', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
        const body = readJson(req);
        const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
          .content;
        expect(content[0]!.type).toBe('input_audio');
        expect(String((content[0]!.input_audio as Record<string, string>).data)).toContain(
          'data:audio/wav;base64,',
        );
        return jsonResponse({ choices: [{ message: { content: '识别文本' } }] });
      },
    ]);
    const result = await dashscopeAdapter.transcribeSpeech(
      ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
      'qwen3-asr-flash',
      {
        audioBase64: Buffer.from('wav').toString('base64'),
        audioMime: 'audio/wav',
      },
    );
    expect(result.text).toBe('识别文本');
  });

  it('DEV-133：generateImage / submitVideo / videoStatus / cancelVideo 不再挂载（图像/视频生成归插件条目）', () => {
    expect(dashscopeAdapter.generateImage).toBeUndefined();
    expect(dashscopeAdapter.submitVideo).toBeUndefined();
    expect(dashscopeAdapter.videoStatus).toBeUndefined();
    expect(dashscopeAdapter.cancelVideo).toBeUndefined();
  });
});

describe('dashscope adapter 向量（按模型家族路由端点）', () => {
  const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  it('text-embedding-v4 → 兼容根 /embeddings，响应按 index 归位', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(`${BASE}/embeddings`);
        expect(readJson(req)).toEqual({ model: 'text-embedding-v4', input: ['你好', '世界'] });
        return jsonResponse({
          data: [
            { index: 1, embedding: [0.2, 0.2] },
            { index: 0, embedding: [0.1, 0.1] },
          ],
        });
      },
    ]);
    const vectors = await dashscopeAdapter.embed(ctx(BASE, fetchImpl), 'text-embedding-v4', [
      '你好',
      '世界',
    ]);
    expect(vectors).toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
  });

  it('多模态向量（tongyi-embedding-vision）→ 原生 multimodal-embedding 端点，contents 传参', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(
          'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',
        );
        expect(readJson(req)).toEqual({
          model: 'tongyi-embedding-vision-plus-2026-03-06',
          input: { contents: [{ text: '图片里有猫' }] },
        });
        return jsonResponse({
          output: { embeddings: [{ index: 0, embedding: [0.3], type: 'text' }] },
        });
      },
    ]);
    const vectors = await dashscopeAdapter.embed(
      ctx(BASE, fetchImpl),
      'tongyi-embedding-vision-plus-2026-03-06',
      ['图片里有猫'],
    );
    expect(vectors).toEqual([[0.3]]);
  });

  it('早期 text-embedding-v2 → 原生 text-embedding 端点（texts 传参）', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(
          'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
        );
        expect(readJson(req)).toEqual({ model: 'text-embedding-v2', input: { texts: ['旧模型'] } });
        return jsonResponse({ output: { embeddings: [{ index: 0, embedding: [0.9] }] } });
      },
    ]);
    const vectors = await dashscopeAdapter.embed(ctx(BASE, fetchImpl), 'text-embedding-v2', [
      '旧模型',
    ]);
    expect(vectors).toEqual([[0.9]]);
  });

  it('多模态向量 10 条/批分批，跨批保持输入顺序', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const batchSizes: number[] = [];
    const fetchImpl = scriptedFetch([
      (req) => {
        const body = readJson(req);
        batchSizes.push(body.input.contents.length);
        return jsonResponse({
          output: {
            embeddings: body.input.contents.map((_: unknown, i: number) => ({
              index: i,
              embedding: [1],
            })),
          },
        });
      },
      (req) => {
        const body = readJson(req);
        batchSizes.push(body.input.contents.length);
        return jsonResponse({
          output: {
            embeddings: body.input.contents.map((_: unknown, i: number) => ({
              index: i,
              embedding: [2],
            })),
          },
        });
      },
    ]);
    const vectors = await dashscopeAdapter.embed(
      ctx(BASE, fetchImpl),
      'multimodal-embedding-v1',
      texts,
    );
    expect(batchSizes).toEqual([10, 2]);
    // 前十条来自第一批（[1]），后两条来自第二批（[2]）。
    expect(vectors).toEqual([...Array.from({ length: 10 }, () => [1]), [2], [2]]);
  });
});

describe('适配器 rerank / understandImage（新增能力）', () => {
  it('dashscope：原生 text-rerank 端点，query/documents 在 input 下、top_n 在 parameters 下', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(
          'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
        );
        const body = readJson(req);
        expect(body.model).toBe('gte-rerank-v2');
        expect(body.input).toEqual({ query: '查询', documents: ['甲', '乙'] });
        expect(body.parameters).toEqual({ top_n: 2, return_documents: false });
        return jsonResponse({
          output: {
            results: [
              { index: 1, relevance_score: 0.8 },
              { index: 0, relevance_score: 0.2 },
            ],
          },
        });
      },
    ]);
    const result = await dashscopeAdapter.rerank!(
      ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
      'gte-rerank-v2',
      { query: '查询', documents: ['甲', '乙'], topN: 2 },
    );
    expect(result.results).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.2 },
    ]);
  });

  it('understandImage：兼容根 chat + image_url 内容块；分段 content 拼接 text', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
        const body = readJson(req) as {
          messages: Array<{ content: Array<Record<string, unknown>> }>;
        };
        expect(body.messages[0]!.content[0]).toMatchObject({
          type: 'image_url',
          image_url: { url: 'https://pic.example/a.png' },
        });
        return jsonResponse({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: '一只' },
                  { type: 'text', text: '猫' },
                ],
              },
            },
          ],
        });
      },
    ]);
    const result = await dashscopeAdapter.understandImage!(
      ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
      'qwen3-vl-plus',
      { images: ['https://pic.example/a.png'], prompt: '图中是什么' },
    );
    expect(result.text).toBe('一只猫');
  });

  it('rerank 空结果抛 PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ output: { results: [] } })]);
    await expect(
      dashscopeAdapter.rerank!(
        ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', fetchImpl),
        'gte-rerank-v2',
        { query: 'q', documents: ['d'] },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('volcengine adapter（embeddings/multimodal + chat 视觉）', () => {
  const C = {
    vendor: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'sk-test',
    logger: LOGGER,
  } as VendorCallContext;

  it('DEV-133：generateImage / submitVideo / videoStatus / cancelVideo 不再挂载（图像/视频生成归插件条目）', () => {
    expect(volcengineAdapter.generateImage).toBeUndefined();
    expect(volcengineAdapter.submitVideo).toBeUndefined();
    expect(volcengineAdapter.videoStatus).toBeUndefined();
    expect(volcengineAdapter.cancelVideo).toBeUndefined();
  });

  it('无 TTS / ASR 能力（适配器不挂方法）', () => {
    expect(volcengineAdapter.synthesizeSpeech).toBeUndefined();
    expect(volcengineAdapter.transcribeSpeech).toBeUndefined();
    // 方舟数据面没有 rerank 接口（重排在 VikingDB）。
    expect(volcengineAdapter.rerank).toBeUndefined();
  });

  it('向量：POST /embeddings/multimodal（文本向量端点已下线），逐条请求按序归位', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal');
        expect(readJson(req)).toEqual({
          model: 'doubao-embedding-vision-251215',
          encoding_format: 'float',
          input: [{ type: 'text', text: '检索文本' }],
        });
        return jsonResponse({ data: { embedding: [0.5, 0.25], object: 'embedding' } });
      },
      (req) => {
        expect(readJson(req).input).toEqual([{ type: 'text', text: '另一条' }]);
        return jsonResponse({ data: { embedding: [0.1] } });
      },
    ]);
    const vectors = await volcengineAdapter.embed(
      { ...C, fetchImpl },
      'doubao-embedding-vision-251215',
      ['检索文本', '另一条'],
    );
    expect(vectors).toEqual([[0.5, 0.25], [0.1]]);
  });
});

describe('HTTP 错误映射', () => {
  it('401/403 → PROVIDER_AUTH_FAILED；429 → PROVIDER_RATE_LIMITED；网络失败 → PROVIDER_UNREACHABLE', async () => {
    const unauthorized = scriptedFetch([() => jsonResponse({ message: 'InvalidApiKey' }, 401)]);
    await expect(
      dashscopeAdapter.synthesizeSpeech(
        ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', unauthorized),
        'cosyvoice-v2',
        { text: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });

    const limited = scriptedFetch([() => jsonResponse({ message: 'rate limit' }, 429)]);
    await expect(
      dashscopeAdapter.synthesizeSpeech(
        ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', limited),
        'cosyvoice-v2',
        { text: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });

    const dead = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      dashscopeAdapter.synthesizeSpeech(
        ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', dead),
        'cosyvoice-v2',
        { text: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
  });

  it('空音频结果 → PROVIDER_UNAVAILABLE；VendorHttpError 携带厂商 message', async () => {
    const empty = scriptedFetch([() => jsonResponse({ output: {} })]);
    await expect(
      dashscopeAdapter.synthesizeSpeech(
        ctx('https://dashscope.aliyuncs.com/compatible-mode/v1', empty),
        'cosyvoice-v2',
        { text: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    const error = new VendorHttpError(500, 'InternalError');
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('vendorFetch 错误分类：配额 / 欠费与认证失败分家（PROVIDER_QUOTA）', () => {
  /** 直连 vendorFetch 的响应桩：单次请求返回给定 status + JSON body。 */
  function statusFetch(status: number, payload: unknown): typeof fetch {
    return (async () => {
      const body = JSON.stringify(payload);
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  const call = (status: number, payload: unknown) =>
    vendorFetch('https://vendor.example/api', 'sk-test', {}, statusFetch(status, payload)).then(
      () => {
        throw new Error('expected the request to be rejected');
      },
      (error: AppError) => error.code,
    );

  it('403 免费额度用尽（百炼 AllocationQuota.FreeTierOnly）→ PROVIDER_QUOTA，不再误判为认证失败', async () => {
    expect(
      await call(403, {
        code: 'AllocationQuota.FreeTierOnly',
        message:
          'Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the "use free tier only" mode in the management console.',
        request_id: 'x',
      }),
    ).toBe('PROVIDER_QUOTA');
  });

  it('403 权限拒绝（无配额字样）→ 仍是 PROVIDER_AUTH_FAILED', async () => {
    expect(await call(403, { code: 'AccessDenied', message: 'no permission' })).toBe(
      'PROVIDER_AUTH_FAILED',
    );
  });

  it('401 恒为 PROVIDER_AUTH_FAILED（即使响应体带 quota 字样）', async () => {
    expect(await call(401, { message: 'invalid api key (quota check failed)' })).toBe(
      'PROVIDER_AUTH_FAILED',
    );
  });

  it('402 Payment Required → PROVIDER_QUOTA', async () => {
    expect(await call(402, { error: { message: 'Insufficient credits' } })).toBe('PROVIDER_QUOTA');
  });

  it('429 配额耗尽（OpenAI insufficient_quota）→ PROVIDER_QUOTA', async () => {
    expect(
      await call(429, {
        error: {
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      }),
    ).toBe('PROVIDER_QUOTA');
  });

  it('429 限流 → PROVIDER_RATE_LIMITED（Throttling.RateQuota 带 quota 字样也算限流）', async () => {
    expect(
      await call(429, { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }),
    ).toBe('PROVIDER_RATE_LIMITED');
    expect(await call(429, { message: 'Too many requests' })).toBe('PROVIDER_RATE_LIMITED');
  });

  it('端到端：语音合成收到 403 免费额度用尽 → 调用方拿到 PROVIDER_QUOTA（不进「未配置」引导）', async () => {
    await expect(
      dashscopeAdapter.synthesizeSpeech(
        ctx(
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
          statusFetch(403, {
            code: 'AllocationQuota.FreeTierOnly',
            message: 'Free quota exhausted.',
          }),
        ),
        'cosyvoice-v2',
        { text: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_QUOTA' });
  });
});

describe('openai-compatible adapter（DEV-133：标准 TTS / ASR 端点）', () => {
  const BASE = 'https://mine.example/v1';

  it('synthesizeSpeech：POST /audio/speech（model/input/voice/response_format/speed），二进制响应转 base64', async () => {
    const audioBytes = Buffer.from('fake-opus-bytes');
    const fetchImpl = scriptedFetch([
      (req) => {
        expect(req.url).toBe(`${BASE}/audio/speech`);
        expect(req.headers.authorization).toBe('Bearer sk-test');
        const body = readJson(req);
        expect(body).toEqual({
          model: 'tts-1',
          input: '你好，世界',
          voice: 'alloy',
          response_format: 'opus',
          speed: 1.2,
        });
        return new Response(audioBytes);
      },
    ]);
    const result = await openAICompatibleAdapter.synthesizeSpeech(
      ctx(BASE, fetchImpl),
      'tts-1',
      { text: '你好，世界', format: 'opus', speed: 1.2 },
    );
    expect(result.audioBase64).toBe(audioBytes.toString('base64'));
    expect(result.mimeType).toBe('audio/ogg');
  });

  it('synthesizeSpeech：voice 缺省 alloy、format 缺省 mp3；空响应报 PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = scriptedFetch([
      (req) => {
        const body = readJson(req);
        expect(body.voice).toBe('alloy');
        expect(body.response_format).toBe('mp3');
        return new Response(Buffer.alloc(0));
      },
    ]);
    await expect(
      openAICompatibleAdapter.synthesizeSpeech(ctx(BASE, fetchImpl), 'tts-1', { text: 'x' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('transcribeSpeech：multipart（file Blob + model + language），响应 {text}', async () => {
    const audioBytes = Buffer.from('fake-wav-bytes');
    const fetchImpl = scriptedFetch([
      async (req) => {
        expect(req.url).toBe(`${BASE}/audio/transcriptions`);
        expect(req.method).toBe('POST');
        expect(req.headers.authorization).toBe('Bearer sk-test');
        const form = req.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        const file = form.get('file');
        expect(file).toBeInstanceOf(Blob);
        expect((file as Blob).type).toBe('audio/wav');
        expect((file as File).name).toBe('audio.wav');
        expect(Buffer.from(await (file as Blob).arrayBuffer())).toEqual(audioBytes);
        expect(form.get('model')).toBe('whisper-1');
        expect(form.get('language')).toBe('zh');
        return jsonResponse({ text: '识别结果' });
      },
    ]);
    const result = await openAICompatibleAdapter.transcribeSpeech(
      ctx(BASE, fetchImpl),
      'whisper-1',
      {
        audioBase64: audioBytes.toString('base64'),
        audioMime: 'audio/wav',
        language: 'zh',
      },
    );
    expect(result.text).toBe('识别结果');
  });

  it('transcribeSpeech：MIME → 文件扩展名归位（mp4 → m4a、x- 前缀去噪、未知 → bin）；缺省不带 language', async () => {
    const seen: string[] = [];
    const fetchImpl = scriptedFetch([
      (req) => {
        seen.push(String(((req.body as FormData).get('file') as File).name));
        seen.push(String((req.body as FormData).get('language')));
        return jsonResponse({ text: 'ok' });
      },
      (req) => {
        seen.push(String(((req.body as FormData).get('file') as File).name));
        return jsonResponse({ text: 'ok' });
      },
      (req) => {
        seen.push(String(((req.body as FormData).get('file') as File).name));
        return jsonResponse({ text: 'ok' });
      },
    ]);
    const c = ctx(BASE, fetchImpl);
    await openAICompatibleAdapter.transcribeSpeech(c, 'm', {
      audioBase64: Buffer.from('a').toString('base64'),
      audioMime: 'audio/mp4',
    });
    await openAICompatibleAdapter.transcribeSpeech(c, 'm', {
      audioBase64: Buffer.from('b').toString('base64'),
      audioMime: 'audio/x-flac',
    });
    await openAICompatibleAdapter.transcribeSpeech(c, 'm', {
      audioBase64: Buffer.from('c').toString('base64'),
      audioMime: 'audio/weird',
    });
    expect(seen).toEqual(['audio.m4a', 'null', 'audio.flac', 'audio.bin']);
  });

  it('transcribeSpeech：非 2xx 归一同族错误（401 → PROVIDER_AUTH_FAILED；网络失败 → PROVIDER_UNREACHABLE）', async () => {
    const unauthorized = scriptedFetch([() => jsonResponse({ error: { message: 'bad key' } }, 401)]);
    await expect(
      openAICompatibleAdapter.transcribeSpeech(ctx(BASE, unauthorized), 'whisper-1', {
        audioBase64: Buffer.from('a').toString('base64'),
        audioMime: 'audio/wav',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });

    const dead = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      openAICompatibleAdapter.transcribeSpeech(ctx(BASE, dead), 'whisper-1', {
        audioBase64: Buffer.from('a').toString('base64'),
        audioMime: 'audio/wav',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
  });
});
