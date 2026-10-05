import { AppError } from '@kepcup/shared';
import { trimTrailingSlash, vendorFetch } from './http.js';
import type { UnderstandImageParams, VendorCallContext } from './types.js';

/**
 * OpenAI 兼容的图片理解（多模态视觉问答）。三家国内厂商的视觉模型都挂在
 * 各自 OpenAI 兼容根的 `/chat/completions` 上：图片以 `image_url` 内容块
 * 传入（URL 或 data URI），回复即理解文本。个别模型把 content 拆成分段
 * 数组，这里把其中的 text 段拼接回纯文本。
 */
export async function openAICompatibleUnderstandImage(
  ctx: VendorCallContext,
  model: string,
  params: UnderstandImageParams,
): Promise<{ text: string }> {
  const response = await vendorFetch(
    `${trimTrailingSlash(ctx.baseUrl)}/chat/completions`,
    ctx.apiKey,
    {
      json: {
        model,
        messages: [
          {
            role: 'user',
            content: [
              ...params.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              { type: 'text', text: params.prompt },
            ],
          },
        ],
      },
      timeoutMs: 120_000,
    },
    ctx.fetchImpl,
  );
  const data = response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.length > 0) return { text: content };
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
    if (text.length > 0) return { text };
  }
  throw new AppError('PROVIDER_UNAVAILABLE', '图片理解接口未返回文本', {
    body: response.bodyText.slice(0, 300),
  });
}
