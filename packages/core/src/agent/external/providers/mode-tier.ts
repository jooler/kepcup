import { AppError } from '@kepcup/shared';
import type { PermissionTierContext } from '../types.js';

/**
 * 把会话切到档位映射出的模式（P5 新增 Provider 共用）：Agent 用 ACP session
 * modes 或 `mode` 类 config option（opencode 只有后者，Cursor / Antigravity 两者
 * 都给）暴露同一组预设。目标模式不存在即 fail closed——绝不在未知模式下开工。
 * 禁止模式的拦截在引擎的 `setMode` / `setConfigOption` 包装里（`isForbiddenAgentMode`）。
 */
export async function switchToMode(
  agentName: string,
  target: string,
  ctx: PermissionTierContext,
): Promise<void> {
  const modes = ctx.modes?.availableModes.map((mode) => mode.id) ?? [];
  if (modes.includes(target)) {
    if (ctx.modes?.currentModeId !== target) await ctx.setMode(target);
    return;
  }
  const option = ctx.configOptions.find((candidate) => candidate.category === 'mode');
  // Select options come flat or grouped.
  const entries =
    option !== undefined && option.type === 'select'
      ? (option.options as ReadonlyArray<{ value?: string; options?: Array<{ value: string }> }>)
      : [];
  const values = entries.flatMap((entry) =>
    entry.value !== undefined ? [entry.value] : (entry.options ?? []).map((inner) => inner.value),
  );
  if (option !== undefined && values.includes(target)) {
    if (option.currentValue !== target) await ctx.setConfigOption(option.id, target);
    return;
  }
  throw new AppError(
    'AGENT_INCOMPATIBLE',
    `${agentName} 未提供所需的权限模式「${target}」（可用：${[...modes, ...values].join(', ') || '无'}）`,
  );
}
