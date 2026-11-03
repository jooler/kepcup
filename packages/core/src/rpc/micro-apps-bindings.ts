import type { z } from 'zod';
import {
  AppError,
  microAppCardSummaryOf,
  okOutputSchema,
  microAppsAiCancelInputSchema,
  microAppsAiChatInputSchema,
  microAppsAiChatOutputSchema,
  microAppsAiDisposeInputSchema,
  microAppsAiSessionCreateInputSchema,
  microAppsAiSessionCreateOutputSchema,
  microAppsAiSessionHistoryInputSchema,
  microAppsAiSessionHistoryOutputSchema,
  microAppsAiSessionResetInputSchema,
  microAppsAiSessionSendInputSchema,
  microAppsAiSessionSendOutputSchema,
  microAppsMediaSynthesizeInputSchema,
  microAppsMediaSynthesizeOutputSchema,
  microAppsMediaTranscribeInputSchema,
  microAppsMediaTranscribeOutputSchema,
  microAppsPreflightInputSchema,
  microAppsPreflightOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';
import {
  runMicroAppPreflight,
  type MicroAppPreflightProbe,
  type MicroAppPreflightProbeResult,
} from '../micro-apps/preflight.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * 按能力注册的预检探针（D112 §5.2 / §15 第 15 条）：打开**之前**标出「当前不可用」。
 * P1：`ai.chat` 走模型路由解析；`media.listen` / `media.speak` 走 ASR / TTS 能力配置。
 * 缺配置给 reason + 设置深链（模型 → default-models；语音 → capability 槽位）。
 */
function microAppPreflightProbes(
  services: CoreServices,
): Partial<Record<string, MicroAppPreflightProbe>> {
  const probes: Partial<Record<string, MicroAppPreflightProbe>> = {};
  if (services.microAppAi !== null) {
    probes['ai.chat'] = (): MicroAppPreflightProbeResult => {
      const available = services.microAppAi!.modelAvailable();
      return available
        ? { available: true }
        : {
            available: false,
            reason: '没有可用的内置模型（未配置模型）',
            settingDeepLink: { section: 'models', anchor: 'default-models' },
          };
    };
  }
  if (services.media !== null) {
    const asr = (): MicroAppPreflightProbeResult =>
      services.media!.capabilityConfigured('asr')
        ? { available: true }
        : {
            available: false,
            reason: '未配置语音识别（ASR）模型',
            settingDeepLink: { section: 'models', anchor: 'capability-asr' },
          };
    const tts = (): MicroAppPreflightProbeResult =>
      services.media!.capabilityConfigured('tts')
        ? { available: true }
        : {
            available: false,
            reason: '未配置语音合成（TTS）模型',
            settingDeepLink: { section: 'models', anchor: 'capability-tts' },
          };
    probes['media.listen'] = asr;
    probes['media.speak'] = tts;
  }
  return probes;
}

/** WAV 16k/mono/16bit 的时长估算（毫秒）：PCM 数据字节数 / 32（= 16000 * 2 / 1000）。 */
function wavDurationMsOf(audioBase64: string): number {
  try {
    const bytes = Buffer.from(audioBase64, 'base64').byteLength;
    return Math.max(0, Math.round(((bytes - 44) / 32) * 1));
  } catch {
    return 0;
  }
}

/**
 * `microApps.*`（D112）：`preflight`（能力可用性预检）、`ai.*`（模型平面：隔离 / 流式 /
 * 三级预算 / 记账归 Bot）、`media.transcribe / synthesize`（ASR / TTS 经宿主代理，
 * 记账归微应用与 Bot）。能力桥的存储 / 查询运行期调用仍走 `widgets.ui.*`。
 */
export function bindMicroAppsMethods(services: CoreServices): {
  app: Record<string, RpcMethodSpec>;
} {
  const ai = () => {
    if (services.microAppAi === null) throw new AppError('NOT_IMPLEMENTED', '微应用模型模块未就绪');
    return services.microAppAi;
  };
  const widgets = () => {
    if (services.widgets === null) throw new AppError('NOT_IMPLEMENTED', '微应用模块未就绪');
    return services.widgets;
  };
  const mediaUsage = (resourceId: string) => {
    const ctx = widgets().microAppContextOf(resourceId);
    if (ctx === null) {
      throw new AppError('MICRO_APP_CAPABILITY_NOT_DECLARED', '这张卡不是微应用（无媒体面）');
    }
    return ctx;
  };
  return {
    app: {
      'microApps.preflight': method(
        microAppsPreflightInputSchema,
        microAppsPreflightOutputSchema,
        async (input) => {
          if (services.widgets === null) {
            throw new AppError('NOT_IMPLEMENTED', '微应用模块未就绪');
          }
          const effective = services.widgets.effectiveMicroAppOf(input.messageId);
          if (effective === null) {
            throw new AppError('NOT_FOUND', '这张卡片不是微应用（无预检面）');
          }
          return {
            widgetId: effective.widgetId,
            version: effective.version,
            capabilityFingerprint: effective.microApp.fingerprint,
            bundleSha256: effective.bundleSha256,
            microApp: microAppCardSummaryOf(effective.microApp.manifest),
            queriesNeedReview: effective.queriesNeedReview,
            queriesCount: effective.queriesCount,
            items: runMicroAppPreflight(
              effective.microApp.manifest.permissions,
              microAppPreflightProbes(services),
            ),
          };
        },
      ),
      'microApps.ai.chat': method(microAppsAiChatInputSchema, microAppsAiChatOutputSchema, (input) =>
        ai().chat(input),
      ),
      'microApps.ai.sessionCreate': method(
        microAppsAiSessionCreateInputSchema,
        microAppsAiSessionCreateOutputSchema,
        async (input) => ai().sessionCreate(input),
      ),
      'microApps.ai.sessionSend': method(
        microAppsAiSessionSendInputSchema,
        microAppsAiSessionSendOutputSchema,
        (input) => ai().sessionSend(input),
      ),
      'microApps.ai.sessionHistory': method(
        microAppsAiSessionHistoryInputSchema,
        microAppsAiSessionHistoryOutputSchema,
        async (input) => ({ messages: ai().sessionHistory(input) }),
      ),
      'microApps.ai.sessionReset': method(microAppsAiSessionResetInputSchema, okOutputSchema, async (input) => {
        ai().sessionReset(input);
        return { ok: true as const };
      }),
      'microApps.ai.cancel': method(microAppsAiCancelInputSchema, okOutputSchema, async (input) => {
        ai().cancel(input);
        return { ok: true as const };
      }),
      'microApps.ai.dispose': method(microAppsAiDisposeInputSchema, okOutputSchema, async (input) => {
        ai().disposeInstance(input.instanceId);
        return { ok: true as const };
      }),
      'microApps.media.transcribe': method(
        microAppsMediaTranscribeInputSchema,
        microAppsMediaTranscribeOutputSchema,
        async (input) => {
          if (services.media === null) throw new AppError('NOT_IMPLEMENTED', '媒体模块未就绪');
          const ctx = mediaUsage(input.resourceId);
          if (!ctx.permissions.includes('media.listen')) {
            throw new AppError('MICRO_APP_CAPABILITY_NOT_DECLARED', '这个微应用没有声明能力 media.listen');
          }
          const result = await services.media.transcribeSpeech(
            {
              audioBase64: input.audioBase64,
              audioMime: input.audioMime,
              ...(input.language !== undefined ? { language: input.language } : {}),
            },
            { botId: ctx.botId, conversationId: null, loopType: 'micro_app' },
          );
          services.microAppAi?.recordMediaUsage(ctx.widgetId, {
            asrMs: wavDurationMsOf(input.audioBase64),
          });
          return { text: result.text };
        },
      ),
      'microApps.media.synthesize': method(
        microAppsMediaSynthesizeInputSchema,
        microAppsMediaSynthesizeOutputSchema,
        async (input) => {
          if (services.media === null) throw new AppError('NOT_IMPLEMENTED', '媒体模块未就绪');
          const ctx = mediaUsage(input.resourceId);
          if (!ctx.permissions.includes('media.speak')) {
            throw new AppError('MICRO_APP_CAPABILITY_NOT_DECLARED', '这个微应用没有声明能力 media.speak');
          }
          const result = await services.media.synthesizeSpeech(
            {
              text: input.text,
              ...(input.voice !== undefined ? { voice: input.voice } : {}),
              ...(input.rate !== undefined ? { speed: input.rate } : {}),
            },
            { botId: ctx.botId, conversationId: null, loopType: 'micro_app' },
          );
          services.microAppAi?.recordMediaUsage(ctx.widgetId, { ttsChars: input.text.length });
          return { audioBase64: result.audioBase64, mimeType: result.mimeType };
        },
      ),
    },
  };
}
