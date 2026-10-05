/**
 * GPU/OS → ONNX 执行单元选型（DEV-007 落地，docs/design/16-capability-models.md
 * 「向量来源」）。onnxruntime-node 1.30 的发行包按平台携带 GPU 组件：macOS 的
 * CoreML EP 静态链接进 libonnxruntime，Windows 带 DirectML.dll（任意 DX12
 * 显卡：NVIDIA/AMD/Intel，无需 CUDA/cuDNN 运行库），Linux 包未携带 CUDA EP。
 * 因此「选包」发生在 catalog 的平台条目上，「选执行单元」发生在会话创建时——
 * 首选 EP 创建会话失败（驱动/硬件不支持）时逐级回退到 CPU，推理永不因此失败。
 */

export type EmbeddingAccelerator = 'coreml' | 'directml' | 'cpu';

/**
 * 有序执行单元候选：首项是首选 GPU 加速，末项恒为 'cpu' 兜底
 * （onnxruntime executionProviders 语义：按序尝试，EP 不可用节点回落 CPU）。
 */
export function executionProvidersFor(platform: string, arch: string): string[] {
  void arch;
  switch (platform) {
    case 'darwin':
      return ['coreml', 'cpu'];
    case 'win32':
      return ['dml', 'cpu'];
    default:
      // linux：npm 发行包未携带 CUDA EP（docs 记录的取舍，见 gpu.ts 头注释）。
      return ['cpu'];
  }
}

/** 首选加速器的展示名（设置页状态与文档用语）。 */
export function acceleratorLabel(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'CoreML';
    case 'win32':
      return 'DirectML';
    default:
      return 'CPU';
  }
}
