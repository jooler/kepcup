import { mkdirSync, writeFileSync } from 'node:fs';
import { untrustedBlock } from '../infra/data-boundary.js';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { AppError, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { ImageGenerationResult } from '../media/types.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { ToolGateway } from '../gateway/index.js';
import { resolveMediaSource } from './media-source.js';
import { readOnlyRefusal } from './read-only.js';

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

/** 单张理解图片的字节上限（与 docs/design/20-conversation-media.md 视觉注入对齐）。 */
const UNDERSTAND_IMAGE_MAX_BYTES = 5_000_000;

/** The slice of MediaService the media-generation tools consume (P15/P17/P25). */
export interface MediaToolFacade {
  generateImage(input: {
    prompt: string;
    images?: string[];
    n?: number;
  }): Promise<ImageGenerationResult>;
  /** 图片理解（understand_image，docs/design/25-capability-tools.md）。 */
  understandImage(input: { images: string[]; prompt: string }): Promise<{ text: string }>;
  /** 语音合成（generate_speech，docs/design/20-conversation-media.md）。 */
  synthesizeSpeech(input: {
    text: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
    speed?: number;
  }): Promise<{ audioBase64: string; mimeType: string }>;
  /** 语音转写（transcribe_audio，docs/design/25-capability-tools.md）。 */
  transcribeSpeech(input: {
    audioBase64: string;
    audioMime: string;
    language?: string;
  }): Promise<{ text: string }>;
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
  /** 素材来源解析（understand_image）：附件字节与路径权限检查。 */
  attachments: AttachmentsService;
  gateway: ToolGateway;
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
      // The image is saved into the workspace: refused before paying for it.
      const readOnly = readOnlyRefusal(
        input.gateway,
        identity,
        '生成的图片要保存到 workspace，本次执行不能生成图片',
      );
      if (readOnly !== null) return readOnly;
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

  /**
   * 图片理解（docs/design/25-capability-tools.md）：主模型看不了图时用它
   * 回答关于图片的问题；素材为对话附件或 workspace 内路径，转 data URI 走
   * 厂商视觉端点。未配置 multimodal 能力时同 SETUP_REQUIRED 流程。
   */
  const understandImage: ToolDefinition<{
    images: string[];
    prompt: string;
  }> = {
    name: 'understand_image',
    description:
      '用图片理解（多模态）模型回答关于图片的问题。当前对话模型无法直接看图时必须用本工具识别图片（用户消息提示图片未注入、或需要读取 workspace 里的截图/照片时）；能直接看图的模型优先直接看，不要绕路。来源为对话附件 id（att_…）或文件路径，1-4 张。',
    parameters: Type.Object({
      images: Type.Array(Type.String({ description: '图片来源：附件 id（att_…）或文件路径' }), {
        minItems: 1,
        maxItems: 4,
        description: '要理解的图片，1-4 张',
      }),
      prompt: Type.String({ description: '对图片的问题或指令（如「描述这张图」「读出图里的表格数据」）' }),
    }),
    execute: async (params) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法理解图片',
          errorCode: 'INVALID_INPUT',
        };
      }
      const dataUris: string[] = [];
      const skipped: string[] = [];
      for (const source of params.images) {
        let bytes: Buffer;
        let mime: string;
        try {
          const resolved = resolveMediaSource({
            identity,
            gateway: input.gateway,
            attachments: input.attachments,
            source,
          });
          bytes = resolved.bytes;
          mime = resolved.mime;
        } catch (error) {
          return {
            ok: false,
            content: error instanceof AppError ? error.message : String(error),
            errorCode: error instanceof AppError ? error.code : 'INVALID_INPUT',
          };
        }
        if (bytes.length > UNDERSTAND_IMAGE_MAX_BYTES) {
          skipped.push(`${source}（约 ${Math.round(bytes.length / 1024 / 1024)}MB，上限 5MB）`);
          continue;
        }
        dataUris.push(`data:${mime};base64,${bytes.toString('base64')}`);
      }
      if (dataUris.length === 0) {
        return {
          ok: false,
          content: `没有可用的图片：${skipped.join('；')}`,
          errorCode: 'INVALID_INPUT',
        };
      }
      let result: { text: string };
      try {
        result = await media.understandImage({ images: dataUris, prompt: params.prompt });
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return setupRequiredResult('图片理解模型未配置');
          }
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `图片理解失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INTERNAL',
        };
      }
      const note =
        skipped.length > 0 ? `\n（以下图片过大已跳过：${skipped.join('；')}）` : '';
      const truncated = truncateToBudget(result.text, TOOL_OUTPUT_MAX_CHARS).text;
      return { ok: true, content: `${untrustedBlock(truncated)}${note}` };
    },
  };

  return [generateImage, understandImage];
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
