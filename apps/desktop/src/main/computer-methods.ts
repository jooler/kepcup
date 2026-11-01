import { z } from 'zod';
import type { COMPUTER_RPC_METHODS, ComputerInvokeMethod } from '@kepcup/shared';
import {
  computerCapabilitiesOutputSchema,
  computerInvokeInputSchema,
  computerInvokeOutputSchema,
  computerPermissionsOpenInputSchema,
  computerPermissionsStatusOutputSchema,
  computerStopInputSchema,
  computerStopOutputSchema,
  okOutputSchema,
  type RpcMethodSpec,
} from '@kepcup/shared';
import type { ComputerHost } from './computer-host';

const voidInput = z.void();

/**
 * Port B server side (D105, docs/design/52 §3)：core 的 computer_* 工具经
 * platform channel 调这些方法（镜像 browser-methods.ts）。main 只提供能力：
 * 审批 / 门控 / 脱敏都在 core（设计 §5——权限判断不在这里）。
 *
 * 返回类型按 shared 的 COMPUTER_RPC_METHODS 注册表键控：漏写或拼错即编译失败。
 * 无参方法的 input 用 z.void()——birpc 零参调用（`rpc.$call(method)`）必须能过。
 */
export function computerMethodSpecs(
  host: ComputerHost,
): Record<(typeof COMPUTER_RPC_METHODS)[number], RpcMethodSpec> {
  return {
    // 数据面：method 白名单 = sidecar 方法面（zod 枚举约束）；结果形态按方法
    // 各异，输出层 unknown 透传（core 工具层按需窄化）。
    'computer.invoke': {
      input: computerInvokeInputSchema,
      output: computerInvokeOutputSchema,
      handle: (input) =>
        host.invoke(
          (input as { method: ComputerInvokeMethod }).method,
          (input as { params?: Record<string, unknown> }).params ?? {},
        ),
    },
    'computer.capabilities': {
      input: voidInput,
      output: computerCapabilitiesOutputSchema,
      handle: () => host.capabilities(),
    },
    'computer.permissionsStatus': {
      input: voidInput,
      output: computerPermissionsStatusOutputSchema,
      handle: () => host.permissionsStatus(),
    },
    'computer.permissionsOpen': {
      input: computerPermissionsOpenInputSchema,
      output: okOutputSchema,
      handle: (input) =>
        host.permissionsOpen((input as { permission: 'accessibility' | 'screen-recording' }).permission),
    },
    'computer.stop': {
      input: computerStopInputSchema,
      output: computerStopOutputSchema,
      handle: (input) => Promise.resolve(host.stop((input as { reason?: string }).reason)),
    },
  };
}
