import {
  MEDIA_CONTRACT_METHODS,
  MEDIA_CONTRACT_METHOD_WIRE,
  type MediaContractMethod,
} from '@kepcup/shared';
import type { ZodType } from 'zod';

/**
 * 能力契约注册表（D125 P2，docs/design/61-plugin-runtime-platform.md §5）。
 *
 * 运行时对契约**零知识**：它只做进程 / 协议 / 资源治理，方法面与双向 schema 全部由
 * 契约在这里登记。v1 唯一契约 `media`——方法面 = core `VendorAdapter` 的七个可选方法
 * （`embed` / `rerank` 不开放，60 §10 Q4 维持）；params / output schema 直接取 shared
 * `media/schema.ts` 的 `MEDIA_CONTRACT_METHOD_WIRE`（两侧共用的单一事实来源，宿主侧
 * 输出校验失败 = `PLUGIN_CONTRACT_VIOLATION`）。
 *
 * 未来契约（`search-provider` / `wiki-derive` / `sensor`）注册即用：加一条登记，
 * 不改 PluginHost / 能力桥 / 协议。
 */

/** 契约方法的三件套：输入 schema、输出 schema、调用级超时（看门狗击杀阈值）。 */
export interface CapabilityContractMethod {
  readonly params: ZodType;
  readonly output: ZodType;
  /** 调用级超时（毫秒）；超时 = cancel → 宽限 → 击杀 → PLUGIN_TIMEOUT（61 §3.1）。 */
  readonly timeoutMs: number;
}

/** 一个能力契约（窄接口）：运行时按 id 查找，按方法取 schema 与超时。 */
export interface CapabilityContract {
  readonly id: string;
  readonly methods: Readonly<Record<string, CapabilityContractMethod>>;
  /**
   * 契约错误的归一命名空间：media 契约的厂商错误族是 `PROVIDER_*`
   * （`media/http.ts` 的既有语义，HostedAdapter 据此分流「插件显式声明」与
   * 「运行时故障」）。运行时本身不改写插件错误码。
   */
  readonly errorNamespace: string;
}

/**
 * media 契约的调用级超时（61 §3.1：图片 / TTS 120s、ASR 300s、视频 15 分钟——与
 * 现有视频工具轮询上限对齐）。`videoStatus` / `cancelVideo` 与提交同属视频类目，
 * 共用 900s；判定进程是否还活着由 15s 心跳（×2）独立负责，不依赖调用超时。
 */
export const MEDIA_CONTRACT_TIMEOUT_MS: Readonly<Record<MediaContractMethod, number>> = {
  generateImage: 120_000,
  synthesizeSpeech: 120_000,
  transcribeSpeech: 300_000,
  understandImage: 120_000,
  submitVideo: 900_000,
  videoStatus: 900_000,
  cancelVideo: 900_000,
};

function mediaMethods(): Record<string, CapabilityContractMethod> {
  const methods: Record<string, CapabilityContractMethod> = {};
  for (const method of MEDIA_CONTRACT_METHODS) {
    const wire = MEDIA_CONTRACT_METHOD_WIRE[method];
    methods[method] = {
      params: wire.params,
      output: wire.output,
      timeoutMs: MEDIA_CONTRACT_TIMEOUT_MS[method],
    };
  }
  return methods;
}

/** 能力契约注册表（固定契约名）：v1 仅 `media`。 */
export const CAPABILITY_CONTRACTS: Readonly<Record<string, CapabilityContract>> = {
  media: {
    id: 'media',
    methods: mediaMethods(),
    errorNamespace: 'PROVIDER',
  },
};

/** 已注册契约 id 列表（握手 / 诊断 / 错误信息用）。 */
export function capabilityContractIds(): string[] {
  return Object.keys(CAPABILITY_CONTRACTS);
}

/** 按 id 取契约（未知 = null，调用方给出可读错误）。 */
export function capabilityContract(id: string): CapabilityContract | null {
  return CAPABILITY_CONTRACTS[id] ?? null;
}

/** 按契约 + 方法取方法规格（未知契约 / 方法 = null）。 */
export function capabilityContractMethod(
  contractId: string,
  method: string,
): CapabilityContractMethod | null {
  return capabilityContract(contractId)?.methods[method] ?? null;
}
