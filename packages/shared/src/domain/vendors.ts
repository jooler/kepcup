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

/** 已适配某能力的厂商（能力槽位的候选过滤）。 */
export function vendorsForCapability(capability: ModelCapability): VendorDescriptor[] {
  return Object.values(VENDOR_DESCRIPTORS).filter((vendor) =>
    vendor.capabilities.includes(capability),
  );
}

// ---------------------------------------------------------------------------
// 「添加供应商」模板目录（v0.5.6）：完整搬运 ZCode 内置供应商目录的 34 张
// 模板卡（同供应商不同端点是独立卡片，参数为 ZCode 核验数据），再合并
// pi-ai 内置供应商目录（`builtinCatalog: true` 的模板创建「目录实例」——
// 模型清单直接用 pi 内置目录，注册表不覆盖 pi 的同名 provider）。去重后
// 共 46 张卡：ZCode 34 + 我们的 dashscope / volcengine 媒体厂商卡 + pi 12
// 家（ZCode 未覆盖的）。
//
// 对话注册表的线协议（`api`）：openai-completions / anthropic-messages /
// openai-responses，pi 对三种都有实现。媒体能力仍只覆盖
// dashscope / volcengine（vendor 映射到原生适配器的实例）。
// ---------------------------------------------------------------------------

/** 供应商实例 / 模板可用的对话线协议（pi-ai 实现）。 */
export const providerApiSchema = z.enum([
  'openai-completions',
  'anthropic-messages',
  'openai-responses',
]);
export type ProviderApi = z.infer<typeof providerApiSchema>;

export interface ProviderTemplate {
  /** 模板 id，也是首个实例的默认 id。 */
  id: string;
  /** 展示名（zh-CN；en-US 用 nameEn）。 */
  name: string;
  nameEn?: string;
  /** 对话线协议。 */
  api: ProviderApi;
  /** OpenAI 兼容 / 厂商协议根；builtinCatalog 实例不需要（pi 目录自带）。 */
  baseUrl?: string;
  /** 预置对话模型 id（可自由输入其他 id）。 */
  presets: readonly string[];
  /** 获取 API Key 的控制台地址（详情区提示用）。 */
  consoleUrl?: string;
  /** 供应商图标资产文件名（assets/provider-icons/ 下）。 */
  logo?: string;
  /** 媒体能力厂商（仅 dashscope / volcengine；其余实例走通用兼容适配器）。 */
  vendor?: VendorId;
  /** pi 内置目录实例：模型清单来自 pi 的同名 provider，注册表不覆盖。 */
  builtinCatalog?: boolean;
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  // --- 我们自己的媒体厂商卡（OpenAI 兼容根 + 原生媒体适配器） ----------------
  {
    id: 'dashscope',
    name: '阿里云百炼',
    nameEn: 'Alibaba Cloud Model Studio',
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    presets: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash'],
    consoleUrl: 'https://bailian.console.aliyun.com/',
    logo: 'model-provider-alibaba-cloud.png',
    vendor: 'dashscope',
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    nameEn: 'Volcano Ark',
    api: 'openai-completions',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    presets: [
      'doubao-seed-evolving',
      'doubao-seed-2-1-pro-260915',
      'doubao-seed-2-1-lite-260915',
      'doubao-seed-2-1-turbo-260628',
    ],
    consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    logo: 'model-provider-volcengine.png',
    vendor: 'volcengine',
  },
  // --- ZCode 内置目录（完整搬运；同供应商不同端点为独立卡片） ----------------
  {
    id: 'zai-api',
    name: 'Z.ai Coding Plan',
    nameEn: 'Z.ai Coding Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://api.z.ai/api/anthropic',
    presets: ['GLM-5.3', 'GLM-5.3-Flash'],
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    logo: 'model-provider-zai-app.png',
  },
  {
    id: 'zai-standard-api',
    name: 'Z.ai API',
    nameEn: 'Z.ai API',
    api: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    presets: [
      'GLM-5.3',
      'GLM-5.3-Flash',
      'glm-5.3-flashx',
      'GLM-5V-Turbo',
      'GLM-5.1',
      'GLM-5.1-Highspeed',
      'GLM-5',
      'GLM-5-Turbo',
      'GLM-4.7',
      'GLM-4.7-FlashX',
    ],
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    logo: 'model-provider-zai.png',
  },
  {
    id: 'bigmodel-api',
    name: 'BigModel Coding Plan',
    nameEn: 'BigModel Coding Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    presets: ['GLM-5.3', 'GLM-5.3-Flash'],
    consoleUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
    logo: 'logo-bigmodel.svg',
  },
  {
    id: 'bigmodel-standard-api',
    name: 'BigModel API',
    nameEn: 'BigModel API',
    api: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    presets: [
      'GLM-5.3',
      'GLM-5.3-Flash',
      'GLM-5V-Turbo',
      'GLM-5.1',
      'GLM-5.1-Highspeed',
      'GLM-5',
      'GLM-5-Turbo',
      'GLM-4.7',
      'GLM-4.7-FlashX',
      'GLM-4.7-Flash',
    ],
    consoleUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    logo: 'logo-bigmodel.svg',
  },
  {
    id: 'moonshot-kimi',
    name: 'Kimi',
    nameEn: 'Kimi',
    api: 'anthropic-messages',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    presets: [
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.7-code-highspeed',
      'k3',
      'k3-256k',
    ],
    consoleUrl: 'https://platform.kimi.com/console/api-keys',
    logo: 'model-provider-moonshot-kimi.png',
  },
  {
    id: 'kimi-code-cn',
    name: 'Kimi Code（国内）',
    nameEn: 'Kimi Code (China)',
    api: 'openai-completions',
    baseUrl: 'https://api.kimi.com/coding/v1',
    presets: [
      'k3.1-pro',
      'k3.1-pro-highspeed',
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ],
    consoleUrl: 'https://www.kimi.com/code/console',
    logo: 'model-provider-moonshot-kimi.png',
  },
  {
    id: 'kimi-code-intl',
    name: 'Kimi Code（国际）',
    nameEn: 'Kimi Code (International)',
    api: 'openai-completions',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    presets: [
      'k3.1-pro',
      'k3.1-pro-highspeed',
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ],
    consoleUrl: 'https://www.kimi.com/code/console',
    logo: 'model-provider-moonshot-kimi.png',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    nameEn: 'MiniMax',
    api: 'anthropic-messages',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    presets: [
      'MiniMax-M3.1-Flash',
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ],
    consoleUrl: 'https://platform.minimaxi.com/console/access?tab=api-keys',
    logo: 'model-provider-minimax.png',
  },
  {
    id: 'minimax-m-plan-cn',
    name: 'MiniMax M Plan（中国）',
    nameEn: 'MiniMax M Plan (China)',
    api: 'anthropic-messages',
    baseUrl: 'https://api.minimax.cn/anthropic',
    presets: ['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview'],
    consoleUrl: 'https://platform.minimax.cn/console/plan',
    logo: 'model-provider-minimax.png',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    api: 'anthropic-messages',
    baseUrl: 'https://api.deepseek.com/anthropic',
    presets: ['deepseek-flash', 'deepseek-v4-pro'],
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    logo: 'model-provider-deepseek.png',
  },
  {
    id: 'qwen-alibaba-model-studio-intl',
    name: '阿里云百炼（国际）',
    nameEn: 'Alibaba Cloud (Global)',
    api: 'openai-completions',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    presets: [
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.8-omni-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.7-flash',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'qwen3.5-plus',
      'qwen3.5-flash',
    ],
    consoleUrl: 'https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard',
    logo: 'model-provider-alibaba-cloud.png',
  },
  {
    id: 'qwen-coding-plan-cn',
    name: '阿里云百炼 Coding Plan（中国）',
    nameEn: 'Alibaba Coding Plan (China)',
    api: 'openai-completions',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    presets: ['qwen3.7-plus'],
    consoleUrl: 'https://bailian.console.aliyun.com/cn-beijing/?tab=coding-plan',
    logo: 'model-provider-alibaba-cloud.png',
  },
  {
    id: 'qwen-token-plan-team-cn',
    name: '阿里云百炼 Token Plan 团队版（中国）',
    nameEn: 'Alibaba Token Plan Team (China)',
    api: 'openai-completions',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    presets: ['qwen3.8-max', 'qwen3.8-flash'],
    consoleUrl: 'https://bailian.console.aliyun.com/',
    logo: 'model-provider-alibaba-cloud.png',
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo API',
    nameEn: 'Xiaomi MiMo API',
    api: 'anthropic-messages',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    presets: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.5'],
    consoleUrl: 'https://platform.xiaomimimo.com/',
    logo: 'model-provider-xiaomi-mimo.png',
  },
  {
    id: 'xiaomi-mimo-token-plan',
    name: 'Xiaomi MiMo Token Plan',
    nameEn: 'Xiaomi MiMo Token Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    presets: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    consoleUrl: 'https://platform.xiaomimimo.com/',
    logo: 'model-provider-xiaomi-mimo.png',
  },
  {
    id: 'tencent-tokenhub-cn',
    name: '腾讯 TokenHub 广州 API（中国站）',
    nameEn: 'Tencent TokenHub Guangzhou API (China account)',
    api: 'openai-completions',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    presets: ['hy3', 'hy4-preview'],
    consoleUrl: 'https://console.cloud.tencent.com/tokenhub',
    logo: 'model-provider-tencent-cloud.png',
  },
  {
    id: 'tencent-tokenhub-intl',
    name: '腾讯 TokenHub 新加坡 API（中国站）',
    nameEn: 'Tencent TokenHub Singapore API (China account)',
    api: 'openai-completions',
    baseUrl: 'https://tokenhub-intl.tencentmaas.com/v1',
    presets: ['hy3', 'hy4-preview'],
    consoleUrl: 'https://console.cloud.tencent.com/tokenhub',
    logo: 'model-provider-tencent-cloud.png',
  },
  {
    id: 'volcengine-coding-plan',
    name: '火山方舟 Coding Plan',
    nameEn: 'Volcano Ark Coding Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    presets: ['doubao-seed-2.1-pro', 'doubao-seed-2.1-lite'],
    consoleUrl: 'https://ark.volcengine.com/region:cn-beijing',
    logo: 'model-provider-volcengine.png',
  },
  {
    id: 'volcengine-agent-plan',
    name: '火山方舟 Agent Plan',
    nameEn: 'Volcano Ark Agent Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
    presets: ['doubao-seed-2.1-pro', 'doubao-seed-2.1-lite'],
    consoleUrl: 'https://ark.volcengine.com/region:cn-beijing',
    logo: 'model-provider-volcengine.png',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 API',
    nameEn: 'StepFun API',
    api: 'anthropic-messages',
    baseUrl: 'https://api.stepfun.com',
    presets: ['step-5-preview', 'step-3.7-flash'],
    consoleUrl: 'https://platform.stepfun.com/interface-key',
    logo: 'model-provider-stepfun.png',
  },
  {
    id: 'stepfun-step-plan',
    name: '阶跃星辰 Step Plan',
    nameEn: 'StepFun Step Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://api.stepfun.com/step_plan',
    presets: ['step-5-preview', 'step-3.7-flash'],
    consoleUrl: 'https://platform.stepfun.com/interface-key',
    logo: 'model-provider-stepfun.png',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    nameEn: 'OpenAI',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    presets: [
      'gpt-6-astra',
      'gpt-5.6-terra',
      'gpt-6.1-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6',
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5.4-mini',
    ],
    consoleUrl: 'https://platform.openai.com/api-keys',
    logo: 'model-provider-openai.png',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    nameEn: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    presets: [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ],
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    logo: 'model-provider-anthropic.png',
  },
  {
    id: 'xai',
    name: 'xAI',
    nameEn: 'xAI',
    api: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    presets: ['grok-build-0.1', 'grok-4.7', 'grok-4.6', 'grok-4.3'],
    consoleUrl: 'https://console.x.ai',
    logo: 'model-provider-xai.png',
  },
  {
    id: 'siliconflow-cn',
    name: '硅基流动 API（中国）',
    nameEn: 'SiliconFlow API (China)',
    api: 'openai-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    presets: ['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4-Flash', 'moonshotai/Kimi-K2.7-Code'],
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    logo: 'model-provider-siliconflow.png',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameEn: 'OpenRouter',
    api: 'anthropic-messages',
    baseUrl: 'https://openrouter.ai/api',
    presets: [
      'minimax/minimax-m3.1-flash',
      'moonshotai/kimi-k3.1-pro',
      'anthropic/claude-fable-5.1',
      'openai/gpt-6-astra',
      'deepseek/deepseek-v4-pro',
      'moonshotai/kimi-k3',
      'z-ai/glm-5.3',
      'qwen/qwen3.8-max',
      'minimax/minimax-m3',
      'openai/gpt-6.1-sol',
    ],
    consoleUrl: 'https://openrouter.ai/keys',
    logo: 'model-provider-openrouter-light.svg',
  },
  {
    id: 'opencode-go-responses',
    name: 'OpenCode Go (Responses)',
    nameEn: 'OpenCode Go (Responses)',
    api: 'openai-responses',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    presets: ['gpt-6-luna', 'grok-4.7', 'gpt-5.6-luna', 'grok-4.6'],
    consoleUrl: 'https://opencode.ai/auth',
    logo: 'model-provider-opencode-light.svg',
  },
  {
    id: 'opencode-go-messages',
    name: 'OpenCode Go (Anthropic)',
    nameEn: 'OpenCode Go (Anthropic)',
    api: 'anthropic-messages',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    presets: [
      'minimax-m3',
      'qwen3.8-max',
      'qwen3.8-flash',
      'claude-haiku-5-5',
      'minimax-m2.7',
      'minimax-m2.5',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
    ],
    consoleUrl: 'https://opencode.ai/auth',
    logo: 'model-provider-opencode-light.svg',
  },
  {
    id: 'opencode-go-chat',
    name: 'OpenCode Go (Chat)',
    nameEn: 'OpenCode Go (Chat)',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    presets: [
      'minimax-m3.1-flash',
      'kimi-k3.1-pro',
      'glm-5.3-flash',
      'glm-5.3',
      'kimi-k3',
      'kimi-k2.7-code',
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'mimo-v2.6-pro',
      'mimo-v2.6-flash',
    ],
    consoleUrl: 'https://opencode.ai/auth',
    logo: 'model-provider-opencode-light.svg',
  },
  {
    id: 'opencode-zen-responses',
    name: 'OpenCode Zen (Responses)',
    nameEn: 'OpenCode Zen (Responses)',
    api: 'openai-responses',
    baseUrl: 'https://opencode.ai/zen/v1',
    presets: [
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-luna',
      'grok-4.7',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
    ],
    consoleUrl: 'https://opencode.ai/auth',
    logo: 'model-provider-opencode-light.svg',
  },
  {
    id: 'opencode-zen-messages',
    name: 'OpenCode Zen (Anthropic)',
    nameEn: 'OpenCode Zen (Anthropic)',
    api: 'anthropic-messages',
    baseUrl: 'https://opencode.ai/zen/v1',
    presets: [
      'claude-fable-5-1',
      'qwen3.7-max',
      'qwen3.6-plus',
      'qwen3.5-plus',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
    ],
    consoleUrl: 'https://opencode.ai/auth',
    logo: 'model-provider-opencode-light.svg',
  },
  {
    id: 'opencode-zen-chat',
    name: 'OpenCode Zen (Chat)',
    nameEn: 'OpenCode Zen (Chat)',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/v1',
    presets: [
      'kimi-k3',
      'minimax-m3',
      'deepseek-v4-pro',
      'glm-5.2',
      'big-pickle',
      'mimo-v2.5-free',
      'hy3-free',
      'ling-3.0-flash-fin-free',
      'nemotron-3-ultra-free',
      'muse-spark-1.2-contributor-free',
    ],
    consoleUrl: 'https://opencode.ai/auth',
    logo: 'model-provider-opencode-light.svg',
  },
  // --- pi-ai 内置目录（ZCode 未覆盖的供应商；模型清单来自 pi 目录） ----------
  {
    id: 'google',
    name: 'Google Gemini',
    nameEn: 'Google Gemini',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://aistudio.google.com/apikey',
    logo: 'model-provider-google-gemini.png',
    builtinCatalog: true,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    nameEn: 'Mistral',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://console.mistral.ai/api-keys',
    logo: 'model-provider-mistral.webp',
    builtinCatalog: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    nameEn: 'Groq',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://console.groq.com/keys',
    logo: 'model-provider-groq.webp',
    builtinCatalog: true,
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    nameEn: 'Fireworks',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://fireworks.ai/account/api-keys',
    logo: 'model-provider-fireworks.webp',
    builtinCatalog: true,
  },
  {
    id: 'together',
    name: 'Together',
    nameEn: 'Together',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://api.together.ai/settings/api-keys',
    logo: 'model-provider-together.png',
    builtinCatalog: true,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    nameEn: 'NVIDIA',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://build.nvidia.com/settings/api-keys',
    logo: 'model-provider-nvidia.png',
    builtinCatalog: true,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    nameEn: 'Cerebras',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://cloud.cerebras.ai',
    logo: 'model-provider-cerebras.png',
    builtinCatalog: true,
  },
  {
    id: 'baseten',
    name: 'Baseten',
    nameEn: 'Baseten',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://app.baseten.co',
    logo: 'model-provider-baseten.png',
    builtinCatalog: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    nameEn: 'Hugging Face',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://huggingface.co/settings/tokens',
    logo: 'model-provider-huggingface.webp',
    builtinCatalog: true,
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    nameEn: 'Vercel AI Gateway',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://vercel.com/d?to=https://vercel.com/ai-gateway',
    logo: 'model-provider-vercel.webp',
    builtinCatalog: true,
  },
  {
    id: 'moonshotai',
    name: 'Kimi（国际 OpenAI 端点）',
    nameEn: 'Kimi (Moonshot OpenAI)',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://platform.moonshot.ai/console/api-keys',
    logo: 'model-provider-moonshot-kimi.png',
    builtinCatalog: true,
  },
  {
    id: 'moonshotai-cn',
    name: 'Kimi（国内 OpenAI 端点）',
    nameEn: 'Kimi CN (OpenAI)',
    api: 'openai-completions',
    presets: [],
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    logo: 'model-provider-moonshot-kimi.png',
    builtinCatalog: true,
  },
  {
    id: 'ant-ling',
    name: 'Ant Ling',
    nameEn: 'Ant Ling',
    api: 'openai-completions',
    presets: [],
    logo: 'model-provider-ant-ling.webp',
    builtinCatalog: true,
  },
];

export function getProviderTemplate(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((template) => template.id === id);
}
