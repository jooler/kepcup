import type { CapabilityModelKey } from '@kepcup/shared';

/**
 * 能力槽位的展示顺序（settings.capabilityModels 的 key，不含 chat）。
 * 与 shared capabilityModelsSchema 的键一致，仅供设置页按固定顺序渲染。
 * DEV-133：image / video 槽位已删——图像 / 视频生成由能力模型插件条目提供
 * （插件条目入口见扩展中心）。
 */
export const CAPABILITY_MODEL_KEYS = [
  'embedding',
  'rerank',
  'multimodal',
  'asr',
  'tts',
] as const satisfies readonly CapabilityModelKey[];
