import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { AppError } from '@kepcup/shared';
import { TOOL_SETUP_REQUIRED, type MediaToolFacade } from './image-tools.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 语音合成与视频生成的 Bot 工具（docs/design/20-conversation-media.md）。
 * 与 generate_image 同一模式：能力按 settings.capabilityModels 配置，未配置
 * （能力缺失或厂商缺 Key）返回 SETUP_REQUIRED——orchestrator 监听后中断 run
 * 以结构化 setup 需求 settle，界面内嵌设置卡，完成后原 run 自动重试。
 *
 * 产物落盘 workspace 的 .generated/，由模型用 send_message 的 attachment_paths
 * 随消息发出。视频是异步任务：工具内轮询（约 5s）并以 progress 汇报阶段，
 * 总时限 10 分钟。
 */

const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_TIMEOUT_MS = 10 * 60_000;
const VIDEO_MAX_BYTES = 200_000_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

export function buildSpeechTools(input: {
  identity: RunIdentity;
  media: MediaToolFacade;
  workspacePath: string;
  /** 轮询间隔（测试注入缩短）；默认 5s。 */
  videoPollIntervalMs?: number;
}): ToolDefinition[] {
  const { identity, media, workspacePath } = input;
  const pollIntervalMs = input.videoPollIntervalMs ?? VIDEO_POLL_INTERVAL_MS;

  const generateSpeech: ToolDefinition<{
    text: string;
    file_name?: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
    speed?: number;
  }> = {
    name: 'generate_speech',
    description:
      '把文本合成为语音（TTS）。音频保存到 workspace 后返回文件路径，需用 send_message 的 attachment_paths 把文件发给用户。应用未配置语音合成模型时本工具不可用。',
    parameters: Type.Object({
      text: Type.String({ description: '要合成的文本（限一次可读的段落，过长请分段生成）' }),
      file_name: Type.Optional(
        Type.String({ description: '保存的文件名（不含扩展名），缺省按时间戳命名' }),
      ),
      voice: Type.Optional(Type.String({ description: '音色（按厂商支持的取值）' })),
      format: Type.Optional(
        Type.Union(
          ['mp3', 'wav', 'opus'].map((f) => Type.Literal(f)),
          {
            description: '音频格式，默认 mp3',
          },
        ),
      ),
      speed: Type.Optional(Type.Number({ description: '语速（如 0.8~2.0，按厂商支持范围）' })),
    }),
    execute: async (params) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法生成语音',
          errorCode: 'INVALID_INPUT',
        };
      }
      let result;
      try {
        result = await media.synthesizeSpeech({
          text: params.text,
          ...(params.voice !== undefined ? { voice: params.voice } : {}),
          ...(params.format !== undefined ? { format: params.format } : {}),
          ...(params.speed !== undefined ? { speed: params.speed } : {}),
        });
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return setupRequiredResult('语音合成模型未配置');
          }
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `语音合成失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INTERNAL',
        };
      }
      const ext = params.format === 'wav' ? 'wav' : params.format === 'opus' ? 'ogg' : 'mp3';
      const saved = saveGenerated(
        workspacePath,
        params.file_name ?? null,
        ext,
        Buffer.from(result.audioBase64, 'base64'),
      );
      if (saved === null) {
        return { ok: false, content: '语音保存失败：内容为空', errorCode: 'PROVIDER_UNAVAILABLE' };
      }
      return {
        ok: true,
        content: `已生成语音并保存到 workspace：\n${saved}\n请用 send_message 的 attachment_paths 把这个文件发给用户。`,
      };
    },
  };

  const generateVideo: ToolDefinition<{
    prompt: string;
    file_name?: string;
  }> = {
    name: 'generate_video',
    description:
      '根据文字描述生成一段短视频（文生视频，异步任务，通常需要几十秒到几分钟）。视频保存到 workspace 后返回文件路径，需用 send_message 的 attachment_paths 把文件发给用户。应用未配置视频生成模型时本工具不可用。',
    parameters: Type.Object({
      prompt: Type.String({ description: '视频内容描述（主体、动作、镜头、风格）' }),
      file_name: Type.Optional(
        Type.String({ description: '保存的文件名（不含扩展名），缺省按时间戳命名' }),
      ),
    }),
    execute: async (params, ctx) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法生成视频',
          errorCode: 'INVALID_INPUT',
        };
      }
      let submitted;
      try {
        submitted = await media.generateVideo({ prompt: params.prompt });
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return setupRequiredResult('视频生成模型未配置');
          }
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `视频任务提交失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INTERNAL',
        };
      }

      ctx.progress(`视频任务已提交（${submitted.taskId}），等待生成…`);
      const deadline = Date.now() + VIDEO_TIMEOUT_MS;
      let lastPhase = '';
      for (;;) {
        if (ctx.signal.aborted) {
          return { ok: false, content: '视频生成已取消', errorCode: 'CANCELLED' };
        }
        let status;
        try {
          status = await media.videoStatus(submitted.provider, submitted.taskId);
        } catch (error) {
          return {
            ok: false,
            content: `查询视频任务状态失败：${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'PROVIDER_UNAVAILABLE',
          };
        }
        if (status.status !== lastPhase) {
          lastPhase = status.status;
          if (status.status === 'queued') ctx.progress('视频排队中…');
          if (status.status === 'running') ctx.progress('视频生成中…');
        }
        if (status.status === 'failed') {
          return {
            ok: false,
            content: `视频生成失败：${status.error ?? '厂商未说明原因'}`,
            errorCode: 'PROVIDER_UNAVAILABLE',
          };
        }
        if (status.status === 'succeeded') {
          if (status.videoUrl === undefined || status.videoUrl.length === 0) {
            return {
              ok: false,
              content: '视频生成完成但厂商未返回视频地址',
              errorCode: 'PROVIDER_UNAVAILABLE',
            };
          }
          let bytes: Buffer;
          try {
            // 下载挂取消信号与独立超时：此前裸 fetch 既不响应 run 取消也无上限，
            // 慢速 CDN 可绕过 10 分钟轮询 deadline 把工具无限挂起。
            const response = await fetch(status.videoUrl, {
              signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS)]),
            });
            if (!response.ok) {
              return {
                ok: false,
                content: `下载生成视频失败（HTTP ${response.status}）`,
                errorCode: 'PROVIDER_UNAVAILABLE',
              };
            }
            const declared = Number(response.headers.get('content-length') ?? '0');
            if (declared > VIDEO_MAX_BYTES) {
              return {
                ok: false,
                content: `生成的视频过大（约 ${Math.round(declared / 1024 / 1024)}MB），已放弃下载`,
                errorCode: 'PROVIDER_UNAVAILABLE',
              };
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > VIDEO_MAX_BYTES) {
              return {
                ok: false,
                content: `生成的视频过大（${Math.round(buffer.length / 1024 / 1024)}MB），已放弃保存`,
                errorCode: 'PROVIDER_UNAVAILABLE',
              };
            }
            bytes = buffer;
          } catch (error) {
            return {
              ok: false,
              content: `下载生成视频失败：${error instanceof Error ? error.message : String(error)}`,
              errorCode: 'PROVIDER_UNAVAILABLE',
            };
          }
          const saved = saveGenerated(workspacePath, params.file_name ?? null, 'mp4', bytes);
          if (saved === null) {
            return { ok: false, content: '视频保存失败：内容为空', errorCode: 'INTERNAL' };
          }
          return {
            ok: true,
            content: `已生成视频并保存到 workspace：\n${saved}\n请用 send_message 的 attachment_paths 把这个文件发给用户。`,
          };
        }
        if (Date.now() + pollIntervalMs > deadline) {
          return {
            ok: false,
            content: `视频任务 ${submitted.taskId} 超时（10 分钟）未完成，已放弃等待；可稍后用 get_run 查看或重新生成`,
            errorCode: 'TIMEOUT',
          };
        }
        await sleep(pollIntervalMs, ctx.signal);
      }
    },
  };

  return [generateSpeech, generateVideo];
}

function setupRequiredResult(reason: string): ToolResult {
  return {
    ok: false,
    content: `${reason}：请告知用户需要先在应用中完成对应能力模型设置；设置完成后本次请求会自动继续。`,
    errorCode: TOOL_SETUP_REQUIRED,
  };
}

/** 落盘 .generated/{安全名}.{ext}，返回绝对路径；空内容返回 null。 */
function saveGenerated(
  workspacePath: string,
  fileName: string | null,
  ext: string,
  bytes: Buffer,
): string | null {
  if (bytes.length === 0) return null;
  const dir = path.join(workspacePath, '.generated');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = sanitizeFileName(fileName?.trim() || stamp);
  const target = path.join(dir, `${base}.${ext}`);
  writeFileSync(target, bytes);
  return target;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^\w\u4e00-\u9fff.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'media';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
