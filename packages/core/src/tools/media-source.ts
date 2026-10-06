import { readFileSync } from 'node:fs';
import { AppError, type Attachment } from '@kepcup/shared';
import type { ToolGateway } from '../gateway/index.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { RunIdentity } from '../agent/types.js';

/**
 * Bot 工具的媒体素材解析（docs/design/25-capability-tools.md）：understand_image
 * 与 transcribe_audio 的来源二选一——对话附件 id（`att_` 前缀，校验归属当前
 * 对话）或 workspace/project 内路径（走网关读权限检查）。附件 mime 自带，路径
 * 按扩展名推断。
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.amr': 'audio/amr',
  '.speex': 'audio/speex',
};

export function guessMediaMime(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export interface ResolvedMediaSource {
  bytes: Buffer;
  mime: string;
  /** 来源描述（attachment id 或路径），错误信息与追溯用。 */
  label: string;
}

export function resolveMediaSource(input: {
  identity: RunIdentity;
  gateway: ToolGateway;
  attachments: AttachmentsService;
  source: string;
}): ResolvedMediaSource {
  const { identity, gateway, attachments, source } = input;
  if (source.startsWith('att_')) {
    const attachment: Attachment | null = attachments.get(source);
    if (!attachment || attachment.conversationId !== identity.conversationId) {
      throw new AppError('NOT_FOUND', `附件不存在或不属于当前对话：${source}`);
    }
    return {
      bytes: attachments.readBytes(attachment),
      // 附件自带 mime 优先；声明为通用二进制时按扩展名兜底。
      mime:
        attachment.mime && attachment.mime !== 'application/octet-stream'
          ? attachment.mime
          : guessMediaMime(attachment.fileName || ''),
      label: source,
    };
  }
  const decision = gateway.checkPath(identity, source, 'read');
  if (decision.kind === 'forbidden') {
    throw new AppError(
      'PATH_OUT_OF_SCOPE',
      `来源不在可访问范围内：${source}（${decision.reason}）`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(decision.resolvedPath);
  } catch (error) {
    throw new AppError(
      'INVALID_INPUT',
      `读取文件失败：${source}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  return { bytes, mime: guessMediaMime(decision.resolvedPath), label: decision.resolvedPath };
}
