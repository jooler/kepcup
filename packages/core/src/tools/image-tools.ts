import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { AppError, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { ImageGenerationResult } from '../media/types.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 图像生成的 Bot 工具（docs/design/18-inline-setup.md）：图像能力在
 * settings.capabilityModels.image 按厂商配置（MediaService 解析适配器）。
 * 生成的图片落盘到 workspace 的 .generated/ 下，由 Bot 用 send_message
 * 的 attachment_paths 随消息发出。
 *
 * 未配置（能力缺失或厂商缺 Key）时返回 SETUP_REQUIRED 错误码——它对模型
 * 只是普通的失败结果，但 orchestrator 监听该错误码中断 run 并以结构化
 * setup 需求 settle，界面据此在消息列表内嵌图像模型设置卡片，完成后原
 * run 自动重试。
 */

/** The slice of MediaService the media-generation tools consume (P15/P17). */
export interface MediaToolFacade {
  generateImage(input: {
    prompt: string;
    images?: string[];
    n?: number;
  }): Promise<ImageGenerationResult>;
  /** 语音合成（generate_speech，docs/design/20-conversation-media.md）。 */
  synthesizeSpeech(input: {
    text: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
    speed?: number;
  }): Promise<{ audioBase64: string; mimeType: string }>;
  /** 视频生成：提交返回 taskId，状态用 videoStatus 轮询。 */
  generateVideo(input: { prompt: string }): Promise<{ provider: string; taskId: string }>;
  videoStatus(
    provider: string,
    taskId: string,
  ): Promise<{
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    videoUrl?: string;
    error?: string;
  }>;
}

/** 工具向模型返回的「需要用户设置」错误码；orchestrator 据此中断并改判。 */
export const TOOL_SETUP_REQUIRED = 'SETUP_REQUIRED';

export function buildImageTools(input: {
  identity: RunIdentity;
  media: MediaToolFacade;
  workspacePath: string;
}): ToolDefinition[] {
  const { identity, media, workspacePath } = input;

  const generateImage: ToolDefinition<{
    prompt: string;
    file_name?: string;
    n?: number;
  }> = {
    name: 'generate_image',
    description:
      '生成图片（文生图）。图片保存到 workspace 后返回文件路径，需用 send_message 的 attachment_paths 把文件发给用户。应用未配置图像生成模型时本工具不可用。',
    parameters: Type.Object({
      prompt: Type.String({ description: '图片描述（提示词），尽量具体：主体、风格、构图' }),
      file_name: Type.Optional(
        Type.String({ description: '保存的文件名（不含扩展名），缺省按时间戳命名' }),
      ),
      n: Type.Optional(Type.Number({ description: '生成张数，默认 1' })),
    }),
    execute: async (params) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法生成图片',
          errorCode: 'INVALID_INPUT',
        };
      }
      // 未配置（能力缺失 / 厂商缺 Key）由 MediaService 抛
      // CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED——orchestrator 的
      // facade 借这两个错误码记下 setup 需求后原样抛回，这里转 SETUP_REQUIRED。
      let result: ImageGenerationResult;
      try {
        result = await media.generateImage({
          prompt: params.prompt,
          ...(params.n !== undefined ? { n: params.n } : {}),
        });
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return setupRequiredResult('图像生成模型未配置');
          }
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `图片生成失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INTERNAL',
        };
      }
      const images = result.images ?? [];
      if (images.length === 0) {
        return {
          ok: false,
          content: '图片生成失败：厂商未返回图片',
          errorCode: 'PROVIDER_UNAVAILABLE',
        };
      }
      const dir = path.join(workspacePath, '.generated');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = sanitizeFileName(params.file_name?.trim() || `image-${stamp}`);
      const saved: string[] = [];
      for (const [index, image] of images.entries()) {
        const bytes = await imageBytes(image);
        if (bytes === null) continue;
        const fileName = images.length > 1 ? `${base}-${index + 1}.png` : `${base}.png`;
        const target = path.join(dir, fileName);
        writeFileSync(target, bytes);
        saved.push(target);
      }
      if (saved.length === 0) {
        return { ok: false, content: '图片生成失败：未能保存任何图片文件', errorCode: 'INTERNAL' };
      }
      const truncated = truncateToBudget(saved.join('\n'), TOOL_OUTPUT_MAX_CHARS).text;
      return {
        ok: true,
        content: `已生成 ${saved.length} 张图片并保存到 workspace：\n${truncated}\n请用 send_message 的 attachment_paths 把这些文件发给用户。`,
      };
    },
  };

  return [generateImage];
}

function setupRequiredResult(reason: string): ToolResult {
  return {
    ok: false,
    content: `${reason}：请告知用户需要先在应用中完成图像生成模型设置；设置完成后本次请求会自动继续。`,
    errorCode: TOOL_SETUP_REQUIRED,
  };
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^\w\u4e00-\u9fff.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'image';
}

/** 适配器返回 b64 或 url 二选一；url 需要拉取字节。 */
async function imageBytes(image: { b64?: string; url?: string }): Promise<Buffer | null> {
  if (image.b64 !== undefined && image.b64.length > 0) {
    return Buffer.from(image.b64, 'base64');
  }
  if (image.url !== undefined && image.url.length > 0) {
    const response = await fetch(image.url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }
  return null;
}
