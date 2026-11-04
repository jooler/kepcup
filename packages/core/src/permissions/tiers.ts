import type { ApprovalKind, PermissionMode } from '@kepcup/shared';

/**
 * 自动授权档（`auto`）自动批准的类别：文件访问（含 workspace 以外的写入）
 * 与常规的环境安装 / 技能装载。命令、沙箱外执行、git 远程、MCP 工具、外发
 * 与外部智能体仍按各自规则确认——自动授权档不脱离沙箱。
 */
export const AUTO_APPROVED_KINDS: ReadonlySet<ApprovalKind> = new Set([
  'access',
  'environment',
  'skill_import',
  'skill_preset',
]);

/** True when the level decides this approval without asking the user. */
export function tierAutoDecides(mode: PermissionMode, kind: ApprovalKind): boolean {
  if (mode === 'bypass') return true;
  if (mode === 'auto') return AUTO_APPROVED_KINDS.has(kind);
  return false;
}
