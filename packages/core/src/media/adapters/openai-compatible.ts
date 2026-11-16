import { AppError } from '@kepcup/shared';
import { Buffer } from 'node:buffer';
import { trimTrailingSlash, vendorFetch, VendorHttpError, vendorErrorMessage } from '../http.js';
import { speechMimeType, type VendorAdapter, type VendorCallContext } from '../types.js';

/**
 * 自定义供应商（任意 OpenAI 兼容端点）的通用适配器：只实现有事实标准的
 * 能力——
 * - 文本向量：POST `{baseUrl}/embeddings`（OpenAI 格式）
 * - 语音合成（TTS）：POST `{baseUrl}/audio/speech`（OpenAI 格式，mp3/wav/opus
 *   即 response_format；响应是二进制音频）
 * - 语音识别（ASR）：POST `{baseUrl}/audio/transcriptions`（OpenAI 格式
 *   multipart：file + model (+ language)，响应 `{text}`）
 *
 * DEV-133：TTS / ASR 的 de-facto 标准接口补齐后，任意自定义 OpenAI 兼容
 * 供应商都能提供语音槽位；重排 / 图片 / 视频仍没有跨厂商的事实标准，不
 * 实现，网关层给出明确提示（图像 / 视频生成统一走能力模型插件条目）。
 */

interface OpenAIEmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

/** 音频 MIME → multipart 文件名扩展（transcriptions 端点按扩展名嗅探格式）。 */
function audioFileExtension(mime: string): string {
  const normalized = mime.startsWith('data:') ? mime.slice(5).split(';')[0] ?? '' : mime;
  const sub = normalized.split('/')[1] ?? '';
  // 参数化 / 非典型形态归位：x- 前缀与 code 冗余参数去掉。
  const bare = sub.split(';')[0]?.replace(/^x-/, '') ?? '';
  const table: Record<string, string> = {
    mpeg: 'mp3',
    mp3: 'mp3',
    wav: 'wav',
    'x-wav': 'wav',
    wave: 'wav',
    ogg: 'ogg',
    opus: 'ogg',
    webm: 'webm',
    mp4: 'm4a',
    'x-m4a': 'm4a',
    m4a: 'm4a',
    aac: 'aac',
    flac: 'flac',
    'x-flac': 'flac',
  };
  return table[bare] ?? 'bin';
}

/**
 * multipart 的错误归一与 vendorFetch 同族（http.ts 的既有语义原样复用，
 * 不改动 http.ts）：网络失败 → PROVIDER_UNREACHABLE；非 2xx → 按状态码与
 * 响应体归一（VendorHttpError）。
 */
async function multipartFetch(
  url: string,
  apiKey: string,
  form: FormData,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('PROVIDER_UNREACHABLE', `厂商接口请求失败：${message}`);
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new VendorHttpError(
      response.status,
      vendorErrorMessage(bodyText) || `HTTP ${response.status}`,
      bodyText,
      { url, status: response.status, body: bodyText.slice(0, 500) },
    );
  }
  return response;
}

export const openAICompatibleAdapter: VendorAdapter = {
  async embed(ctx: VendorCallContext, model: string, texts: string[]): Promise<number[][]> {
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/embeddings`,
      ctx.apiKey,
      { json: { model, encoding_format: 'float', input: texts }, timeoutMs: 60_000 },
      ctx.fetchImpl,
    );
    const data = response.json() as OpenAIEmbeddingsResponse;
    const rows = Array.isArray(data.data) ? data.data : [];
    const vectors: number[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new AppError('PROVIDER_UNAVAILABLE', '向量接口返回了无效向量', {
          body: response.bodyText.slice(0, 300),
        });
      }
      vectors.push(row.embedding);
    }
    if (vectors.length !== texts.length) {
      throw new AppError('PROVIDER_UNAVAILABLE', '向量接口未返回与输入等量的向量', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return vectors;
  },

  async synthesizeSpeech(ctx, model, params) {
    // OpenAI TTS 标准接口：请求体 {model, input, voice?, response_format,
    // speed?}；响应是二进制音频（vendorFetch 已缓存原始字节 → base64 直取）。
    const format = params.format ?? 'mp3';
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/audio/speech`,
      ctx.apiKey,
      {
        json: {
          model,
          input: params.text,
          voice: params.voice ?? 'alloy',
          response_format: format,
          ...(params.speed !== undefined ? { speed: params.speed } : {}),
        },
        timeoutMs: 120_000,
      },
      ctx.fetchImpl,
    );
    if (response.base64.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', '语音合成接口未返回音频', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return { audioBase64: response.base64, mimeType: speechMimeType(format) };
  },

  async transcribeSpeech(ctx, model, params) {
    // OpenAI ASR 标准接口：multipart（file + model (+ language)），响应 {text}。
    const bytes = Buffer.from(params.audioBase64, 'base64');
    const mime = params.audioMime.startsWith('data:')
      ? (params.audioMime.slice(5).split(';')[0] ?? 'audio/wav')
      : params.audioMime;
    const extension = audioFileExtension(mime);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `audio.${extension}`);
    form.append('model', model);
    if (params.language !== undefined && params.language.length > 0) {
      form.append('language', params.language);
    }
    const response = await multipartFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/audio/transcriptions`,
      ctx.apiKey,
      form,
      ctx.fetchImpl ?? fetch,
      120_000,
    );
    const bodyText = await response.text();
    let text = '';
    try {
      const data = JSON.parse(bodyText) as { text?: unknown };
      if (typeof data.text === 'string') text = data.text;
    } catch {
      // 非 JSON 响应体按无文本处理（与探针的 PROVIDER_UNAVAILABLE 语义对齐）。
    }
    return { text };
  },
};
