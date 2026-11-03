import type { MicroAppsPreflightItem } from '@kepcup/shared';

/**
 * 微应用能力可用性预检（D112，设计 55 §5.2 / §15 第 15 条）：出卡前对清单声明的每个
 * 能力问一句「这台机器现在能不能跑」。预检**不改变指纹、不写版本**——它描述的是宿主
 * 当前的配置状态，不是微应用要什么。
 *
 * 探针按能力注册（P0：本机能力恒可用；P1 起：模型 / ASR / TTS 解析 + 传感器总闸由
 * 渲染端补充）。未注册探针的能力视为可用（新增能力落地时忘了探针不该挡住交付——
 * 真正的运行期还有 `MICRO_APP_CAPABILITY_NOT_CONFIGURED` 兜底）。
 */

export interface MicroAppPreflightProbeResult {
  available: boolean;
  reason?: string;
  /** 设置页深链（缺什么指向哪一条设置项）。 */
  settingDeepLink?: { section: string; anchor?: string };
}

export type MicroAppPreflightProbe = () => MicroAppPreflightProbeResult;

export function runMicroAppPreflight(
  permissions: readonly string[],
  probes: Partial<Record<string, MicroAppPreflightProbe>>,
): MicroAppsPreflightItem[] {
  return permissions.map((capability) => {
    const probe = probes[capability];
    if (probe === undefined) return { capability, available: true };
    const result = probe();
    if (result.available) return { capability, available: true };
    return {
      capability,
      available: false,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.settingDeepLink !== undefined ? { settingDeepLink: result.settingDeepLink } : {}),
    };
  });
}
