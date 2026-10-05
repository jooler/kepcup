import { z } from 'zod';

/**
 * 国内厂商内置支持（阿里百炼 / 火山方舟）。
 *
 * 两家平台的对话接口都兼容 OpenAI `/chat/completions`（走 pi-ai 的
 * openai-completions，由 buildModelRegistry 注册）；其余模型能力（向量、
 * 重排、多模态、语音、图片、视频）的接口形态各异——这些由 core 侧
 * `media/` 适配层逐厂商实现（见 docs/design/16-capability-models.md），
 * 本模块只承载两边共享的描述性数据：能力矩阵、默认 baseUrl 与预置模型，
 * 供设置 UI 与路由层共用同一份事实。
 */

/** 模型能力。chat 走 pi 注册表，其余能力按 settings.capabilityModels 配置。 */
export const modelCapabilitySchema = z.enum([
  'chat',
  'embedding',
  'rerank',
  'multimodal',
  'image',
  'tts',
  'asr',
  'video',
]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

/** 内置国内厂商 id（也是 provider id 与模型引用的前缀段）。 */
export const vendorIdSchema = z.enum(['dashscope', 'volcengine']);
export type VendorId = z.infer<typeof vendorIdSchema>;

export interface VendorDescriptor {
  id: VendorId;
  /** 展示名（设置页厂商卡片 / 新增弹框）。 */
  name: string;
  /** OpenAI 兼容根（对话、embeddings、兼容形态的媒体接口都挂在这下面）。 */
  baseUrl: string;
  /**
   * 原生 API 根（非 OpenAI 形态的接口）。百炼的多模态/TTS/视频走
   * `{apiRoot}/api/v1/services/...`；方舟媒体接口与兼容根同源，
   * apiRoot 仅作兜底展示。
   */
  apiRoot: string;
  /** 该厂商实际提供的能力；不在列表中的能力在 UI 与运行时都不可配。 */
  capabilities: readonly ModelCapability[];
  /** 各能力的预置模型 id（新增弹框的候选，可自由输入其他 id）。 */
  presets: Readonly<Record<ModelCapability, readonly string[]>>;
  /** 获取 API Key 的控制台地址（设置页提示用）。 */
  consoleUrl: string;
}

export const VENDOR_DESCRIPTORS: Readonly<Record<VendorId, VendorDescriptor>> = {
  dashscope: {
    id: 'dashscope',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiRoot: 'https://dashscope.aliyuncs.com',
    capabilities: ['chat', 'embedding', 'rerank', 'multimodal', 'image', 'tts', 'asr', 'video'],
    presets: {
      chat: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'deepseek-v3.1', 'qwen3-vl-plus'],
      embedding: [
        'text-embedding-v4',
        'text-embedding-v3',
        // 多模态向量（兼容模式不支持，适配器走原生 multimodal-embedding 端点）。
        'tongyi-embedding-vision-plus-2026-03-06',
      ],
      // gte-rerank-v2 / qwen3.7-text-rerank 走原生 text-rerank 端点。
      rerank: ['gte-rerank-v2', 'qwen3.7-text-rerank'],
      // 图片理解走兼容根 chat + image_url 内容块（qwen-vl-max-latest 需单独
      // 开通，实测 Access denied；vl-plus 长期在售）。
      multimodal: ['qwen3-vl-plus', 'qwen-vl-plus'],
      // qwen-image 家族（含 edit）走原生 multimodal-generation 同步接口。
      image: ['qwen-image', 'qwen-image-plus', 'qwen-image-edit', 'qwen-image-edit-plus'],
      // 语音生成预置（HTTP 非实时通道实测可用）：qwen-audio-tts-next 为
      // 音频生成系（无音色参数）；qwen3-tts 系为音色驱动（默认 Cherry）；
      // flash 变体（qwen-audio-3.1-tts-flash）与 cosyvoice-v3.5-flash 均为
      // 实时（WebSocket）专用或不存在的型号，HTTP 通道不可用。
      tts: [
        'qwen-audio-3.1-tts-next',
        'qwen3-tts-flash',
        'qwen3-tts-instruct-flash',
        'cosyvoice-v3-flash',
        'cosyvoice-v2',
      ],
      asr: ['qwen3-asr-flash'],
      video: ['wan2.7-t2v', 'wan3.0-video', 'wan2.2-t2v-plus'],
    },
    consoleUrl: 'https://bailian.console.aliyun.com/',
  },
  volcengine: {
    id: 'volcengine',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiRoot: 'https://ark.cn-beijing.volces.com/api/v3',
    // 方舟数据面没有 Rerank / TTS / ASR 接口（重排在 VikingDB、语音属独立
    // 语音产品线），不开放配置。
    capabilities: ['chat', 'embedding', 'multimodal', 'image', 'video'],
    presets: {
      // 2026-10 官方模型列表在售（seed-1.6 系与 deepseek-v3 系已下线）。
      chat: [
        'doubao-seed-2-1-pro-260915',
        'doubao-seed-2-1-lite-260915',
        'doubao-seed-2-1-turbo-260628',
        'deepseek-v4-1-flash-260910',
      ],
      // 文本向量模型已全部下线，现役向量只有多模态 embedding-vision
      // （适配器走 /embeddings/multimodal 端点）。
      embedding: ['doubao-embedding-vision-251215'],
      rerank: [],
      // seed-2.1 系自带多模态理解能力标签。
      multimodal: ['doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915'],
      // 图片编辑同样走 /images/generations：带 image 参考图 + 编辑指令即可。
      image: ['doubao-seedream-4-0-250828', 'doubao-seedream-4-5-251128'],
      tts: [],
      asr: [],
      video: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-2-0-260128'],
    },
    consoleUrl: 'https://console.volcengine.com/ark/',
  },
};

export function isVendorId(id: string): id is VendorId {
  return id in VENDOR_DESCRIPTORS;
}

export function getVendorDescriptor(id: string): VendorDescriptor | undefined {
  return isVendorId(id) ? VENDOR_DESCRIPTORS[id] : undefined;
}

/** 已适配某能力的厂商（能力 section 的厂商下拉）。 */
export function vendorsForCapability(capability: ModelCapability): VendorDescriptor[] {
  return Object.values(VENDOR_DESCRIPTORS).filter((vendor) =>
    vendor.capabilities.includes(capability),
  );
}

/**
 * 一个已配置国内厂商的设置条目（settings.vendorProviders）。每家厂商
 * 至多一条；厂商条目只登记**对话**模型（进 pi 注册表），其余能力在
 * settings.capabilityModels 按能力各自配置厂商与模型。
 */
export const vendorModelSchema = z.object({
  /** 厂商侧模型 id。 */
  id: z.string().min(1).max(200),
  /** 展示名；缺省用 id。 */
  name: z.string().min(1).max(200).optional(),
  /** 上下文窗口。 */
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  /** 输入模态（含 image 的模型可接收浏览器截图）。 */
  input: z
    .array(z.enum(['text', 'image']))
    .min(1)
    .optional(),
});
export type VendorModel = z.infer<typeof vendorModelSchema>;

export const vendorProviderSchema = z.object({
  id: vendorIdSchema,
  /** 覆盖默认 OpenAI 兼容根（如切换地域）；空/缺省用厂商默认。 */
  baseUrl: z.string().url().optional(),
  /** 对话模型（可空：条目仅承载 baseUrl 覆盖与 Key 时，模型全在能力配置里）。 */
  models: z.array(vendorModelSchema).default([]),
});
export type VendorProvider = z.infer<typeof vendorProviderSchema>;

/** 厂商条目生效的 OpenAI 兼容根（覆盖值优先）。 */
export function vendorProviderBaseUrl(entry: VendorProvider): string {
  const override = entry.baseUrl?.trim();
  return override && override.length > 0 ? override : VENDOR_DESCRIPTORS[entry.id].baseUrl;
}
