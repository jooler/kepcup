import { mkdirSync, writeFileSync } from 'node:fs';
import { untrustedBlock } from '../infra/data-boundary.js';
import { readBodyCapped, safeFetch } from '../infra/safe-dispatcher.js';
import path from 'node:path';
import { Type } from 'typebox';
import { AppError, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { MediaResolveOptions, MediaUsageContext } from '../media/service.js';
import type { ImageGenerationResult, MediaCallControls } from '../media/types.js';
import { formatPluginProgress } from '../media/plugin-progress.js';
import type { RunIdentity, ToolContext, ToolDefinition, ToolResult } from '../agent/types.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { ToolGateway } from '../gateway/index.js';
import {
  mediaDeliveryResult,
  recordUndeliveredFiles,
  type GeneratedMediaDelivery,
} from './media-delivery.js';
import { resolveMediaSource } from './media-source.js';
import { readOnlyRefusal } from './read-only.js';
import {
  ENTRY_CAPABILITY_LABELS,
  appendEntryHint,
  type MediaEntryHints,
} from './media-entry-hints.js';

/**
 * 图像生成的 Bot 工具（docs/design/18-inline-setup.md）：图像能力在
 * settings.capabilityModels.image 按厂商配置（MediaService 解析适配器）。
 * 生成的图片按来源落盘：执行型插件条目 → 该插件私有目录的 `artifacts/`；
 * 内置引擎 / 全局槽位 → workspace 的 `.generated/`（显式 `output_dir` 优先）。
 * 落盘后由 delivery **立即作为消息附件发进对话**（确定性投递，不再依赖模型
 * 记得调 send_message）。
 *
 * 未配置（能力缺失或厂商缺 Key）时返回 SETUP_REQUIRED 错误码——它对模型
 * 只是普通的失败结果，但 orchestrator 监听该错误码中断 run 并以结构化
 * setup 需求 settle，界面据此在消息列表内嵌图像模型设置卡片，完成后原
 * run 自动重试。
 */

/** 单张理解图片的字节上限（与 docs/design/20-conversation-media.md 视觉注入对齐）。 */
const UNDERSTAND_IMAGE_MAX_BYTES = 5_000_000;

/**
 * 单张生成图片的下载上限（D125 补丁）：执行型插件返回的 URL 是不可信输入，
 * 原先 `arrayBuffer()` 无上限——一个公网大文件就能把宿主内存打爆。与附件上限
 * 同量级（30MB）：更大的图既无法作为附件投递，也无必要落盘。
 */
const GENERATED_IMAGE_MAX_BYTES = 30_000_000;

/**
 * The slice of MediaService the media-generation tools consume (P15/P17/P25).
 * `resolve`（D124）由 orchestrator 的 facade 注入 botId / model——工具本身不传；
 * 接口与 MediaService 对应方法同形（第三参可选），保证 facade 就是 service 切片。
 * D125 P3：第四个参数（可选）携带工具 `ctx.signal` / `ctx.progress` 的桥，只有
 * 执行型插件条目消费（取消链 / 阶段文案）；数据型路径忽略。
 */
export interface MediaToolFacade {
  generateImage(
    input: {
      prompt: string;
      images?: string[];
      n?: number;
      /** D124：指定条目模型（匹配插件条目 model / displayName）；缺省用默认。 */
      model?: string;
    },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
    controls?: MediaCallControls,
  ): Promise<ImageGenerationResult>;
  /** 图片理解（understand_image，docs/design/25-capability-tools.md）。 */
  understandImage(
    input: { images: string[]; prompt: string },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
    controls?: MediaCallControls,
  ): Promise<{ text: string }>;
  /** 语音合成（generate_speech，docs/design/20-conversation-media.md）。 */
  synthesizeSpeech(
    input: {
      text: string;
      voice?: string;
      format?: 'mp3' | 'wav' | 'opus';
      speed?: number;
      /** D124：指定条目模型（匹配插件条目 model / displayName）；缺省用默认。 */
      model?: string;
    },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
    controls?: MediaCallControls,
  ): Promise<{ audioBase64: string; mimeType: string }>;
  /** 语音转写（transcribe_audio，docs/design/25-capability-tools.md）。 */
  transcribeSpeech(
    input: {
      audioBase64: string;
      audioMime: string;
      language?: string;
    },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
    controls?: MediaCallControls,
  ): Promise<{ text: string }>;
  /** 视频生成：提交返回 taskId，状态用 videoStatus 轮询。 */
  generateVideo(
    input: {
      prompt: string;
      /** D124：指定条目模型（匹配插件条目 model / displayName）；缺省用默认。 */
      model?: string;
    },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
    controls?: MediaCallControls,
  ): Promise<{ provider: string; taskId: string }>;
  videoStatus(
    provider: string,
    taskId: string,
    controls?: MediaCallControls,
  ): Promise<{
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    videoUrl?: string;
    error?: string;
  }>;
}

/**
 * D125 P3：工具 → facade 的取消 / 进度桥。插件 progress 帧收成一行状态行文案
 * （空文案跳过，不覆盖状态行）；`ctx.signal` 原样下传（托管适配器转 cancel 帧）。
 * D125 补丁：第三参透传 `onResolved`（工具据此知道本次是否由执行型插件出产物，
 * 决定默认落点）。
 */
export function mediaCallControls(
  ctx: Pick<ToolContext, 'signal' | 'progress'>,
  onPluginProgress?: () => void,
  onResolved?: (origin: { pluginId?: string }) => void,
): MediaCallControls {
  return {
    signal: ctx.signal,
    onProgress: (payload) => {
      const text = formatPluginProgress(payload);
      if (text.length === 0) return;
      onPluginProgress?.();
      ctx.progress(text);
    },
    ...(onResolved !== undefined ? { onResolved } : {}),
  };
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
  /** 产物落盘后的确定性投递（测试装配可缺省：走「请模型 send_message」旧路径）。 */
  delivery?: GeneratedMediaDelivery | undefined;
  /** 记录落盘产物（对话里的文件卡片）；测试装配可缺省。 */
  recordFile?: ((target: string) => void) | undefined;
  /** D123: front gate before saving a generated artifact (throws WRITE_OUT_OF_DOMAIN). */
  checkWritable?: ((target: string) => void) | undefined;
  /**
   * D125 补丁：执行型插件 id → 该插件的产物目录（私有数据目录下的
   * `artifacts/`）。提供且本次解析命中插件条目时，未显式指定 `output_dir` 的
   * 产物默认落这里（宿主管理，不经过任务写域门槛）。
   */
  pluginArtifactDir?: ((pluginId: string) => string) | undefined;
  /**
   * D125 补丁：`output_dir` 的写权限预检（调用厂商 / 插件之前）。返回解析后的
   * 绝对目录；无权 / 越界抛 AppError（错误码原样回给模型）。
   */
  resolveWritableTarget?: ((target: string) => string) | undefined;
  /** D124 P3：Bot 已勾选条目摘要（注入 generate_image 描述；缺省 / 空清单 = 描述逐字节不变）。 */
  entryHints?: MediaEntryHints | undefined;
}): ToolDefinition[] {
  const { identity, media, workspacePath } = input;

  const generateImage: ToolDefinition<{
    prompt: string;
    file_name?: string;
    output_dir?: string;
    n?: number;
    model?: string;
  }> = {
    name: 'generate_image',
    // D124 P3：Bot 绑定了模型条目时在描述尾部追加条目清单（appendEntryHint 空清单原样返回）。
    description: appendEntryHint(
      '生成图片（文生图）。用户要图片、图标、插画、海报等真实图片文件时必须调用本工具产出，不要用文字描述或字符画代替；图片保存后会自动作为消息附件发给用户，无需再调 send_message。可用 output_dir 指定保存目录（相对 workspace 或工作目录）；不指定时，执行型插件生成的图片保存到该插件的私有产物目录，内置引擎保存到 workspace 的 .generated/。未配置图像生成模型时本工具会返回「需要设置」，由系统引导用户完成配置并自动继续，不要因此改用文字方案或推荐外部工具。',
      ENTRY_CAPABILITY_LABELS.image,
      input.entryHints?.image,
    ),
    parameters: Type.Object({
      prompt: Type.String({ description: '图片描述（提示词），尽量具体：主体、风格、构图' }),
      file_name: Type.Optional(
        Type.String({ description: '保存的文件名（不含扩展名），缺省按时间戳命名' }),
      ),
      output_dir: Type.Optional(
        Type.String({
          description:
            '保存目录（相对 workspace 或工作目录；绝对路径需在可写范围内），可留空用默认落点',
          maxLength: 1000,
        }),
      ),
      n: Type.Optional(Type.Number({ description: '生成张数，默认 1' })),
      model: Type.Optional(
        Type.String({
          description: '指定模型（插件提供的模型条目名 / 模型 id），可留空用默认',
          maxLength: 200,
        }),
      ),
    }),
    execute: async (params, ctx) => {
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
        '生成的图片需要落盘，本次执行不能生成图片',
      );
      if (readOnly !== null) return readOnly;
      // D125 补丁：显式 output_dir 在**付费生成之前**解析并预检写权限——否则要等
      // 厂商出图后才发现目录不可写，图片字节只能丢弃。相对路径按网关规则解析
      // （绑定的工作目录 / workspace 为基准）。
      const outputDir = params.output_dir?.trim();
      let explicitDir: string | undefined;
      if (outputDir !== undefined && outputDir.length > 0) {
        try {
          explicitDir =
            input.resolveWritableTarget !== undefined
              ? input.resolveWritableTarget(outputDir)
              : path.resolve(workspacePath, outputDir);
        } catch (error) {
          if (error instanceof AppError) {
            return { ok: false, content: error.message, errorCode: error.code };
          }
          return {
            ok: false,
            content: `保存目录不可用：${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'INVALID_INPUT',
          };
        }
      }
      // D125 补丁：捕获本次解析的实际来源（执行型插件条目 → 产物默认落插件目录）。
      let artifactPluginId: string | undefined;
      // 未配置（能力缺失 / 厂商缺 Key）由 MediaService 抛
      // CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED——orchestrator 的
      // facade 借这两个错误码记下 setup 需求后原样抛回，这里转 SETUP_REQUIRED。
      let result: ImageGenerationResult;
      try {
        result = await media.generateImage(
          {
            prompt: params.prompt,
            ...(params.n !== undefined ? { n: params.n } : {}),
            ...(params.model !== undefined ? { model: params.model } : {}),
          },
          undefined,
          undefined,
          mediaCallControls(ctx, undefined, (origin) => {
            artifactPluginId = origin.pluginId;
          }),
        );
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return setupRequiredResult('图像生成模型未配置或 API Key 无效');
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
      // 保存目录选择（D125 补丁）：显式 output_dir → 预检过的目录；执行型插件条目
      // → 该插件的私有产物目录（宿主管理，不经过任务写域门槛）；否则维持
      // workspace/.generated（原 checkWritable 行为逐字节不变）。
      const usePluginDir =
        explicitDir === undefined &&
        artifactPluginId !== undefined &&
        input.pluginArtifactDir !== undefined;
      const dir =
        explicitDir ??
        (usePluginDir
          ? input.pluginArtifactDir!(artifactPluginId!)
          : path.join(workspacePath, '.generated'));
      if (!usePluginDir) {
        // Gate before creating the directory: a domain-scoped task must not
        // create a directory outside its domain (a pre-existing symlink there
        // would otherwise be followed). The explicit output_dir was resolved
        // before paying, but it is re-checked here and every target is gated
        // below: a pre-existing symlink at `<file_name>.png` must not become a
        // write-domain bypass for the fixed file name.
        input.checkWritable?.(dir);
      }
      if (usePluginDir) mkdirSync(dir, { recursive: true, mode: 0o700 });
      else mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = sanitizeFileName(params.file_name?.trim() || `image-${stamp}`);
      const saved: string[] = [];
      for (const [index, image] of images.entries()) {
        const bytes = await imageBytes(image);
        if (bytes === null) continue;
        const fileName = images.length > 1 ? `${base}-${index + 1}.png` : `${base}.png`;
        const target = path.join(dir, fileName);
        if (!usePluginDir) input.checkWritable?.(target);
        writeFileSync(target, bytes);
        saved.push(target);
      }
      if (saved.length === 0) {
        return {
          ok: false,
          content: '图片生成失败：未能保存任何图片文件（下载失败或单张超过 30MB 上限）',
          errorCode: 'INTERNAL',
        };
      }
      const paths = truncateToBudget(saved.join('\n'), TOOL_OUTPUT_MAX_CHARS).text;
      if (input.delivery !== undefined) {
        // 确定性投递：图片立即作为消息附件发进对话（任务内为进度消息），
        // 不依赖模型再调 send_message。全部送达才不回路径（模型只会向用户复述
        // 绝对路径）；有失败则把未送达的路径与原因交还模型补救。插件目录对网关
        // 不可读，用 hostOwned 显式放行该数据根。
        const outcome = input.delivery.send(saved, '', { hostOwned: usePluginDir });
        // 已贴进对话的不登记文件卡（附件是持久副本，workspace 源文件是临时产物）。
        // 插件私有目录的文件同样不登记：任务的文件卡打不开应用数据目录，投递失败
        // 也不是任务能用 send_message 补救的（见 mediaDeliveryResult 的私有产物文案）。
        if (!usePluginDir) recordUndeliveredFiles(saved, outcome, input.recordFile);
        return mediaDeliveryResult({
          generated: `${saved.length} 张图片`,
          saved,
          outcome,
          privateArtifacts: usePluginDir,
          successHint: '只需用一句话向用户确认生成结果。',
        });
      }
      if (!usePluginDir) recordUndeliveredFiles(saved, null, input.recordFile);
      if (usePluginDir) {
        return {
          ok: true,
          content: `已生成 ${saved.length} 张图片并保存到执行型插件的私有产物目录（由宿主投递，任务无需也不能用 send_message 读取）。`,
        };
      }
      return {
        ok: true,
        content: `已生成 ${saved.length} 张图片并保存到 workspace：\n${paths}\n请用 send_message 的 attachment_paths 把这些文件发给用户。`,
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
      prompt: Type.String({
        description: '对图片的问题或指令（如「描述这张图」「读出图里的表格数据」）',
      }),
    }),
    execute: async (params, ctx) => {
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
          const resolved = await resolveMediaSource({
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
        result = await media.understandImage(
          { images: dataUris, prompt: params.prompt },
          undefined,
          undefined,
          mediaCallControls(ctx),
        );
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return setupRequiredResult('图片理解模型未配置或 API Key 无效');
          }
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `图片理解失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INTERNAL',
        };
      }
      const note = skipped.length > 0 ? `\n（以下图片过大已跳过：${skipped.join('；')}）` : '';
      const truncated = truncateToBudget(result.text, TOOL_OUTPUT_MAX_CHARS).text;
      return { ok: true, content: `${untrustedBlock(truncated)}${note}` };
    },
  };

  return [generateImage, understandImage];
}

function setupRequiredResult(reason: string): ToolResult {
  return {
    // understand_image 也走这里（图片理解 ≠ 图像生成），措辞不能写死能力名。
    ok: false,
    content: `${reason}：请告知用户需要先在应用中完成对应能力模型设置；设置完成后本次请求会自动继续。`,
    errorCode: TOOL_SETUP_REQUIRED,
  };
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^\w\u4e00-\u9fff.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'image';
}

/**
 * 上限内的下载读取（超过即取消流并返回 null，不把整份大响应读进内存）。
 * 实现与视频下载共用 `readBodyCapped`（content-length 预检 + 流式累计）。
 */
async function readCappedImage(response: Response): Promise<Buffer | null> {
  return readBodyCapped(response, GENERATED_IMAGE_MAX_BYTES);
}

/** 适配器返回 b64 或 url 二选一；url 需要拉取字节。 */
async function imageBytes(image: { b64?: string; url?: string }): Promise<Buffer | null> {
  if (image.b64 !== undefined && image.b64.length > 0) {
    return Buffer.from(image.b64, 'base64');
  }
  if (image.url !== undefined && image.url.length > 0) {
    // D125 P4：产物 URL 可能来自执行型插件——统一走 SSRF 守卫（私网 / 元数据拒绝，
    // 重定向逐跳复检）；公网厂商 URL 行为不变。D125 补丁：字节数同样设上限。
    try {
      const response = await safeFetch(image.url);
      if (!response.ok) return null;
      return await readCappedImage(response);
    } catch {
      return null;
    }
  }
  return null;
}
