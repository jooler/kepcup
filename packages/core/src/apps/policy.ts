/**
 * 连接应用的工具策略（D73 P1，design 29 §8.1 / §8.2）——实现已迁入 `@kepcup/shared`
 * （`policy/tool-policy.ts`，D73 P3 §7.4：校验器 CLI 复用）。这里只保留再导出，
 * 所有既有 import 与测试不变。
 */
export {
  applyCatalogOverlay,
  canonicalJson,
  classifyAppToolRisk,
  toolDefinitionHash,
} from '@kepcup/shared';
export type {
  AppToolRiskDetail,
  CatalogTier,
  CatalogToolPolicyInput,
  HashableTool,
  ToolRiskOverlay,
} from '@kepcup/shared';
