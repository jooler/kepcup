import type { CapabilityModelKey } from '@kepcup/shared';

/**
 * 能力槽位的展示顺序（settings.capabilityModels 的 key，不含 chat）。
 * 与 shared capabilityModelsSchema 的键一致，仅供设置页按固定顺序渲染。
 */
export const CAPABILITY_MODEL_KEYS = [
  'embedding',
  'rerank',
  'multimodal',
  'asr',
  'tts',
  'image',
  'video',
] as const satisfies readonly CapabilityModelKey[];
