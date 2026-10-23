/**
 * 组件检查器（D87 P3a，设计 32 §11.8）：规则注册表 + S0 静态 / S1 JS 检查 + 报告 + 草稿目录入口。
 * S2 预览由 P3b 的桌面预览宿主经 {@link WidgetPreviewRunner} 接入。
 */
export {
  PREVIEW_OFFLINE_NETWORK_RULE_ID,
  WIDGET_CHECK_RULES,
  previewOfflineNetworkMessage,
  previewOfflineResourceLoadMessage,
  ruleIssue,
  sandboxPitfallsPrompt,
  widgetCheckRule,
  type WidgetCheckRule,
} from './rules.js';
export { staticCheck } from './static-check.js';
export { jsCheck } from './js-check.js';
export {
  buildCheckReport,
  formatCheckReport,
  issueSignature,
  knownIssuesForUser,
} from './report.js';
export {
  WIDGET_CHECKER_INTERNAL_ERROR_PREFIX,
  WIDGET_PREVIEW_UNAVAILABLE_REASON,
  runWidgetCheck,
  type WidgetPreviewOutcome,
  type WidgetPreviewRunner,
} from './run-check.js';
