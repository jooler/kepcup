import type { z } from 'zod';
import {
  AppError,
  microAppCardSummaryOf,
  okOutputSchema,
  microAppsAiCancelInputSchema,
  microAppsAiChatInputSchema,
  microAppsAiChatOutputSchema,
  microAppsAiDisposeInputSchema,
  microAppsClearContextInputSchema,
  microAppsClearContextOutputSchema,
  microAppsCollectionsDeleteInputSchema,
  microAppsCollectionsGetInputSchema,
  microAppsCollectionsListInputSchema,
  microAppsCollectionsPutInputSchema,
  microAppsCollectionsQueryInputSchema,
  microAppsDocOutputSchema,
  microAppsDocsOutputSchema,
  microAppsContextClearInputSchema,
  microAppsContextUpdateInputSchema,
  microAppsDiagnosticsRecordInputSchema,
  microAppsListInputSchema,
  microAppsListOutputSchema,
  microAppsRollbackInputSchema,
  microAppsRollbackOutputSchema,
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
import { manifestOfRow } from '../micro-apps/manifest.js';
import type { MicroAppStore } from '../micro-apps/store.js';

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
let servicesRef: CoreServices;

export function bindMicroAppsMethods(services: CoreServices): {
  app: Record<string, RpcMethodSpec>;
} {
  servicesRef = services;
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
            contextHeadline: store().contextOf(effective.widgetId)?.headline ?? null,
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
        ai().disposeInstance(input.instanceId, input.resourceId);
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
      // --- P2：collections / context / diagnostics / 管理 ---------------------------------
      'microApps.collections.put': method(microAppsCollectionsPutInputSchema, okOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'storage.collection');
        store().collectionPut(ctx.widgetId, input.name, input.doc as Record<string, unknown>);
        return { ok: true as const };
      }),
      'microApps.collections.get': method(microAppsCollectionsGetInputSchema, microAppsDocOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'storage.collection');
        return store().collectionGet(ctx.widgetId, input.name, input.id);
      }),
      'microApps.collections.delete': method(microAppsCollectionsDeleteInputSchema, okOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'storage.collection');
        store().collectionDelete(ctx.widgetId, input.name, input.id);
        return { ok: true as const };
      }),
      'microApps.collections.list': method(microAppsCollectionsListInputSchema, microAppsDocsOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'storage.collection');
        return store().collectionList(ctx.widgetId, input.name);
      }),
      'microApps.collections.query': method(microAppsCollectionsQueryInputSchema, microAppsDocsOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'storage.collection');
        return store().collectionQuery(ctx.widgetId, input.name, input.where, input.limit);
      }),
      'microApps.context.update': method(microAppsContextUpdateInputSchema, okOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'context.update');
        if (ctx.conversationId === null) {
          throw new AppError('INVALID_INPUT', '这个微应用没有来源会话，无法同步摘要');
        }
        store().contextUpdate({
          widgetId: ctx.widgetId,
          conversationId: ctx.conversationId,
          version: ctx.version,
          summary: input.summary,
          reason: input.reason,
        });
        store().audit({
          widgetId: ctx.widgetId,
          version: ctx.version,
          instanceId: input.instanceId,
          capability: 'context.update',
          outcome: 'ok',
        });
        return { ok: true as const };
      }),
      'microApps.context.clear': method(microAppsContextClearInputSchema, okOutputSchema, async (input) => {
        const ctx = mediaUsage(input.resourceId);
        requireCapability(ctx, 'context.update');
        store().contextClear(ctx.widgetId);
        return { ok: true as const };
      }),
      'microApps.diagnostics.record': method(microAppsDiagnosticsRecordInputSchema, okOutputSchema, async (input) => {
        // 诊断尽力而为：资源过期 / 组件删除时静默丢弃（诊断本身不该抛错打扰运行）。
        try {
          const ctx = servicesRef.widgets?.microAppContextOf(input.resourceId) ?? null;
          if (ctx === null) return { ok: true as const };
          const outcome = store().diagnosticsRecord({
            widgetId: ctx.widgetId,
            version: ctx.version,
            phase: input.phase,
            code: input.code,
            detail: input.detail,
          });
          if (outcome.pushed) {
            store().pushDiagnosticMessage({
              widgetId: ctx.widgetId,
              version: ctx.version,
              code: input.code,
              detail: input.detail,
            });
          }
          return { ok: true as const };
        } catch {
          return { ok: true as const };
        }
      }),
      'microApps.list': method(microAppsListInputSchema, microAppsListOutputSchema, async (input) => {
        return { items: listMicroApps(input.botId) };
      }),
      'microApps.rollback': method(microAppsRollbackInputSchema, microAppsRollbackOutputSchema, async (input) => {
        const result = rollbackMicroApp(input.botId, input.widgetId, input.version);
        return result;
      }),
      'microApps.clearContext': method(microAppsClearContextInputSchema, microAppsClearContextOutputSchema, async (input) => {
        const widget = widgets();
        const owned = widget.listForBot(input.botId).some((item) => item.widgetId === input.widgetId);
        if (!owned) throw new AppError('FORBIDDEN', '这个微应用不属于该 Bot');
        store().contextClear(input.widgetId);
        return { ok: true as const };
      }),
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

function store(): MicroAppStore {
  if (servicesRef.microAppStore === null) throw new AppError('NOT_IMPLEMENTED', '微应用数据模块未就绪');
  return servicesRef.microAppStore;
}

function requireCapability(ctx: { permissions: readonly string[] }, capability: string): void {
  if (!ctx.permissions.includes(capability)) {
    throw new AppError(
      'MICRO_APP_CAPABILITY_NOT_DECLARED',
      `这个微应用没有声明能力 ${capability}`,
    );
  }
}

function listMicroApps(botId: string) {
  const db = servicesRef.mainDb!;
  const day = dayKeyOf(Date.now());
  const rows = db
    .prepare(
      `select w.id, w.title, w.description, w.scope, w.conversation_id, w.latest_version, w.updated_at,
              w.next_version, v.manifest_json
       from widgets w join widget_versions v
         on v.widget_id = w.id and v.version = coalesce(w.next_version, w.latest_version)
       where w.bot_id = ? order by w.updated_at desc`,
    )
    .all(botId) as Array<{
    id: string;
    title: string;
    description: string;
    scope: 'conversation' | 'bot';
    conversation_id: string | null;
    latest_version: number;
    updated_at: number;
    next_version: number | null;
    manifest_json: string;
  }>;
  return rows.flatMap((row) => {
    const manifest = manifestOfRow(row.manifest_json);
    if (manifest === null) return [];
    const usage = db
      .prepare('select ai_calls, ai_tokens, asr_ms, tts_chars from micro_app_usage where widget_id = ? and day = ?')
      .get(row.id, day) as
      | { ai_calls: number; ai_tokens: number; asr_ms: number; tts_chars: number }
      | undefined;
    return [
      {
        widgetId: row.id,
        title: row.title,
        description: row.description,
        scope: row.scope,
        conversationId: row.conversation_id,
        version: row.next_version ?? row.latest_version,
        nextVersion: row.next_version,
        latestVersion: row.latest_version,
        permissions: [...manifest.manifest.permissions],
        netMode: manifest.manifest.net.mode,
        netAllowlist: [...manifest.manifest.net.allowlist],
        usage: {
          aiCalls: Number(usage?.ai_calls ?? 0),
          aiTokens: Number(usage?.ai_tokens ?? 0),
          asrMs: Number(usage?.asr_ms ?? 0),
          ttsChars: Number(usage?.tts_chars ?? 0),
        },
        diagnostics24h: store().diagnosticsCounts24h(row.id),
        contextHeadline: store().contextOf(row.id)?.headline ?? null,
        updatedAt: row.updated_at,
      },
    ];
  });
}

function rollbackMicroApp(botId: string, widgetId: string, version: number): { ok: boolean; message?: string } {
  const widget = servicesRef.widgets!;
  const owned = widget.listForBot(botId).some((item) => item.widgetId === widgetId);
  if (!owned) return { ok: false, message: '这个微应用不属于该 Bot' };
  const db = servicesRef.mainDb!;
  const row = db
    .prepare('select version from widget_versions where widget_id = ? and version = ?')
    .get(widgetId, version) as { version: number } | undefined;
  if (row === undefined) {
    return { ok: false, message: '目标版本已不存在（被修剪的版本不可回退）' };
  }
  db.prepare('update widgets set next_version = ?, updated_at = ? where id = ?').run(
    version,
    Date.now(),
    widgetId,
  );
  return { ok: true };
}

function dayKeyOf(now: number): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
