import { z } from 'zod';
import { PLUGIN_MAX_INSTANCES } from '../domain/plugin-manifest.js';

/**
 * 插件运行时 IPC 协议（D125 P1，docs/design/61-plugin-runtime-platform.md §3.2）。
 *
 * 宿主（core PluginHost）与插件进程（@kepcup/plugin-sdk 客户端）之间 `fork` 内置 IPC
 * 上的全部帧。本文件是**单一事实来源**：两侧 import 同一个包，用 `parseFrame` /
 * `safeParseFrame` 做边界校验——宿主对插件输出校验失败 = `PLUGIN_CONTRACT_VIOLATION`，
 * 插件对宿主输入校验失败 = 拒绝并回 error 帧（61 §3.2）。所有对象一律 `strictObject`
 * （未知字段即拒绝，插件不能自我声明权限）。
 *
 * 帧判别字段是 `type`（`kind` 已被 event 帧的 progress / log 占用）。方向：
 * - host → plugin：init / invoke / cancel / shutdown
 * - plugin → host：ready / result / error / event / state
 *
 * 大产物一律按引用（厂商 URL 或经 host.net 拉取后的 base64，上限 20MB）；媒体产物
 * 下载与落附件永远 core 侧（60 §1 产物策略不变）。
 */

/** 当前 Host API 版本（61 §4 Host API v1）。握手 init / ready 各携带一次。 */
export const PLUGIN_RUNTIME_HOST_API_VERSION = 1;

/**
 * 能力契约注册表（61 §5）：协议层只认 id，类型化校验由契约 schema 提供。
 * v1 唯一契约 `media`；未来 `search-provider` / `wiki-derive` / `sensor` 注册即用。
 */
export const PLUGIN_RUNTIME_CONTRACTS = ['media'] as const;
export type PluginRuntimeContract = (typeof PLUGIN_RUNTIME_CONTRACTS)[number];

/**
 * 插件运行时错误码（61 §5）：本阶段只定义 / 登记（shared `ERROR_CODES` 同步登记），
 * 运行时消费在 P2。版本不匹配复用既有 `PLUGIN_UPGRADE_REQUIRED`（61 §3.1）。
 * 插件也可回 `PROVIDER_*` 族显式映射（auth / quota 分家语义不变，c0bf9168）——
 * 因此 error 帧的 code 是开放字符串，这里只登记宿主侧产生的运行时错误码。
 */
export const PLUGIN_RUNTIME_ERROR_CODES = [
  'PLUGIN_CRASHED',
  'PLUGIN_TIMEOUT',
  'PLUGIN_CONTRACT_VIOLATION',
  'PLUGIN_NETWORK_DENIED',
] as const;
export type PluginRuntimeErrorCode = (typeof PLUGIN_RUNTIME_ERROR_CODES)[number];

/**
 * 状态机值（61 §3.1）：core 固定契约同款。state 帧是插件主动上报自身状态
 * （ready ⇄ busy、error 带原因）；stopped / starting 主要由宿主侧产生。
 */
export const PLUGIN_RUNTIME_STATUS_VALUES = [
  'stopped',
  'starting',
  'ready',
  'busy',
  'error',
] as const;
export type PluginRuntimeStatus = (typeof PLUGIN_RUNTIME_STATUS_VALUES)[number];

/** 调用 id：宿主生成、插件原样回显（result / error / event）。 */
const callIdSchema = z.string().min(1).max(128);

/** init.manifestDigest：清单文本 sha256 的小写 hex（canonical 形态）。 */
const manifestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be lowercase sha256 hex');

// --- host → plugin ------------------------------------------------------------

/** 握手：宿主告知 Host API 版本、清单摘要与已供给的实例（含敏感字段键值）。 */
export const pluginRuntimeInitFrameSchema = z.strictObject({
  type: z.literal('init'),
  hostApiVersion: z.number().int().min(1),
  manifestDigest: manifestDigestSchema,
  instances: z
    .array(
      z.strictObject({
        instanceId: z.string().min(1).max(128),
        /** 实例字段键值（sensitive 字段在此注入；进程内存活，永不落盘、永不入日志）。 */
        fields: z.record(z.string(), z.string()),
      }),
    )
    .max(PLUGIN_MAX_INSTANCES),
});
export type PluginRuntimeInitFrame = z.infer<typeof pluginRuntimeInitFrameSchema>;

/**
 * 能力调用：`contract` 是契约 id（v1 = 'media'），`method` 是契约方法面里的方法名
 * （协议层对契约零知识，不做方法名枚举——61 §5）；`params` 是方法 wire 参数（media
 * 契约下恒为 JSON 对象，见 shared `media/types.ts`）；`context` 携带条目与实例上下文
 * （credentials 为该实例 sensitive 字段键值，调用时注入）。
 */
export const pluginRuntimeInvokeFrameSchema = z.strictObject({
  type: z.literal('invoke'),
  callId: callIdSchema,
  contract: z.enum(PLUGIN_RUNTIME_CONTRACTS),
  method: z.string().min(1).max(64),
  params: z.unknown(),
  context: z.strictObject({
    /** 条目 id（contributions.capabilityModels[].id）。 */
    entryId: z.string().min(1).max(128),
    /** 厂商模型 id（条目 model）。 */
    model: z.string().min(1).max(200),
    locale: z.string().min(1).max(35),
    credentials: z.record(z.string(), z.string()),
    /** 条目 params 合并（引擎逐键白名单消费，60 §7 原则）。 */
    params: z.record(z.string(), z.unknown()),
  }),
});
export type PluginRuntimeInvokeFrame = z.infer<typeof pluginRuntimeInvokeFrameSchema>;

/** 取消在途调用：插件侧 abort 对应 `host.signal`，调用应尽快返回。 */
export const pluginRuntimeCancelFrameSchema = z.strictObject({
  type: z.literal('cancel'),
  callId: callIdSchema,
});
export type PluginRuntimeCancelFrame = z.infer<typeof pluginRuntimeCancelFrameSchema>;

/** 优雅停机（空闲回收 / 卸载前）：插件应尽快退出；超时宿主强杀（61 §3.1）。 */
export const pluginRuntimeShutdownFrameSchema = z.strictObject({
  type: z.literal('shutdown'),
});
export type PluginRuntimeShutdownFrame = z.infer<typeof pluginRuntimeShutdownFrameSchema>;

// --- plugin → host ------------------------------------------------------------

/** 握手应答：插件声明的 Host API 版本与其实现的契约 id 列表。 */
export const pluginRuntimeReadyFrameSchema = z.strictObject({
  type: z.literal('ready'),
  hostApiVersion: z.number().int().min(1),
  /** 开放字符串：老宿主忽略不认识的契约 id（前向兼容），只调用自己认识的。 */
  contracts: z.array(z.string().min(1).max(64)).max(16),
});
export type PluginRuntimeReadyFrame = z.infer<typeof pluginRuntimeReadyFrameSchema>;

/** 调用成功结果（output 是契约方法面的 wire 输出）。 */
export const pluginRuntimeResultFrameSchema = z.strictObject({
  type: z.literal('result'),
  callId: callIdSchema,
  output: z.unknown(),
});
export type PluginRuntimeResultFrame = z.infer<typeof pluginRuntimeResultFrameSchema>;

/**
 * 调用级 / 连接级错误。`callId` 可省略：省略 = 连接级错误（如握手版本不匹配回
 * `PLUGIN_UPGRADE_REQUIRED`，61 §3.1——init 帧没有 callId 可回显）。`code` 是开放
 * 字符串：宿主运行时错误码见 {@link PLUGIN_RUNTIME_ERROR_CODES}，插件可显式回
 * `PROVIDER_*` 族声明 auth / quota 映射（61 §5）。
 */
export const pluginRuntimeErrorFrameSchema = z.strictObject({
  type: z.literal('error'),
  callId: callIdSchema.optional(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  details: z.unknown().optional(),
});
export type PluginRuntimeErrorFrame = z.infer<typeof pluginRuntimeErrorFrameSchema>;

/** host.progress 的 wire 载荷（61 §4）：宿主限速 ≤1 次/秒后透传进 run 进度通道。 */
export const pluginRuntimeProgressPayloadSchema = z.strictObject({
  /** 自由阶段词（如 'queued' / 'generating' / 'downloading'，宿主不做枚举约束）。 */
  phase: z.string().min(1).max(64).optional(),
  percent: z.number().min(0).max(100).optional(),
  message: z.string().min(1).max(500).optional(),
});
export type PluginRuntimeProgressPayload = z.infer<typeof pluginRuntimeProgressPayloadSchema>;

/** host.log 的 wire 载荷：进 core logger（插件前缀）与诊断包，宿主侧限速截断。 */
export const pluginRuntimeLogPayloadSchema = z.strictObject({
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().min(1).max(4000),
  data: z.unknown().optional(),
});
export type PluginRuntimeLogPayload = z.infer<typeof pluginRuntimeLogPayloadSchema>;

/**
 * 过程事件帧：progress / log 两种 kind 的载荷形状不同，拆成两个 strictObject 成员
 * （zod 的 discriminatedUnion 不允许外层重复字面量，外层联合因此用 z.union——类型层
 * 仍是判别联合）。两者都必须携带 callId（事件永远属于某次调用）。
 */
export const pluginRuntimeEventFrameSchema = z.union([
  z.strictObject({
    type: z.literal('event'),
    callId: callIdSchema,
    kind: z.literal('progress'),
    payload: pluginRuntimeProgressPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('event'),
    callId: callIdSchema,
    kind: z.literal('log'),
    payload: pluginRuntimeLogPayloadSchema,
  }),
]);
export type PluginRuntimeEventFrame = z.infer<typeof pluginRuntimeEventFrameSchema>;

/** 插件主动上报状态迁移（core 广播 `plugin.runtime` 事件的来源，P2 接线）。 */
export const pluginRuntimeStateFrameSchema = z.strictObject({
  type: z.literal('state'),
  status: z.enum(PLUGIN_RUNTIME_STATUS_VALUES),
  /** 错误原因 / 附加说明（显示用文本，进状态徽标与活动抽屉）。 */
  detail: z.string().min(1).max(2000).optional(),
});
export type PluginRuntimeStateFrame = z.infer<typeof pluginRuntimeStateFrameSchema>;

// --- 联合与解析入口 ------------------------------------------------------------

/** host → plugin 方向帧（插件侧客户端只接受这一半）。 */
export const pluginRuntimeHostToPluginFrameSchema = z.union([
  pluginRuntimeInitFrameSchema,
  pluginRuntimeInvokeFrameSchema,
  pluginRuntimeCancelFrameSchema,
  pluginRuntimeShutdownFrameSchema,
]);
export type HostToPluginFrame = z.infer<typeof pluginRuntimeHostToPluginFrameSchema>;

/** plugin → host 方向帧（宿主侧 PluginHost 只接受这一半）。 */
export const pluginRuntimePluginToHostFrameSchema = z.union([
  pluginRuntimeReadyFrameSchema,
  pluginRuntimeResultFrameSchema,
  pluginRuntimeErrorFrameSchema,
  pluginRuntimeEventFrameSchema,
  pluginRuntimeStateFrameSchema,
]);
export type PluginToHostFrame = z.infer<typeof pluginRuntimePluginToHostFrameSchema>;

/**
 * 全部帧的判别联合（固定契约名）。zod 层是 `z.union`（zod 4 不允许 discriminatedUnion
 * 出现重复判别值——event 的 progress / log 两个成员共享 `type: 'event'`）；类型层仍是
 * 判别联合，消费方按 `frame.type` switch。
 */
export const pluginRuntimeFrameSchema = z.union([
  pluginRuntimeInitFrameSchema,
  pluginRuntimeInvokeFrameSchema,
  pluginRuntimeCancelFrameSchema,
  pluginRuntimeShutdownFrameSchema,
  pluginRuntimeReadyFrameSchema,
  pluginRuntimeResultFrameSchema,
  pluginRuntimeErrorFrameSchema,
  pluginRuntimeEventFrameSchema,
  pluginRuntimeStateFrameSchema,
]);
export type PluginRuntimeFrame = z.infer<typeof pluginRuntimeFrameSchema>;

/** 安全解析入口（宿主 / 插件两侧共用）：校验并返回帧，非法输入抛 zod 错误。 */
export function parseFrame(input: unknown): PluginRuntimeFrame {
  return pluginRuntimeFrameSchema.parse(input);
}

/** 同 {@link parseFrame}，但不抛错——返回 zod 的 safeParse 结果。 */
export function safeParseFrame(input: unknown): SafeParsedFrame {
  return pluginRuntimeFrameSchema.safeParse(input);
}

/** zod safeParse 的结果类型（zod v4 不再导出独立别名，从 schema 推导）。 */
export type SafeParsedFrame = ReturnType<typeof pluginRuntimeFrameSchema.safeParse>;

// --- 类型守卫 ------------------------------------------------------------------

export function isPluginRuntimeFrame(input: unknown): input is PluginRuntimeFrame {
  return pluginRuntimeFrameSchema.safeParse(input).success;
}

export function isHostToPluginFrame(input: unknown): input is HostToPluginFrame {
  return pluginRuntimeHostToPluginFrameSchema.safeParse(input).success;
}

export function isPluginToHostFrame(input: unknown): input is PluginToHostFrame {
  return pluginRuntimePluginToHostFrameSchema.safeParse(input).success;
}
