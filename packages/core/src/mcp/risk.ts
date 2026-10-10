/**
 * MCP 工具风险分级（W5）——实现已迁入 `@kepcup/shared`（`policy/risk.ts`，D73 P3 §7.4：
 * 校验器 CLI 不能依赖 Electron / core）。这里只保留再导出，所有既有 import 与测试不变。
 */
export {
  classifyRisk,
  classifyRiskDetailed,
  nameLooksMutating,
  nameLooksReadOnly,
  normalizeToolName,
} from '@kepcup/shared';
export type {
  ToolAnnotationsLike,
  ToolRisk,
  ToolRiskDetail,
  ToolRiskInput,
  ToolRiskSource,
} from '@kepcup/shared';
