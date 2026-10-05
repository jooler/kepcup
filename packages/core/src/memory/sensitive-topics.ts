/**
 * Lexical pre-screen for sensitive profile topics (design/04-memory.md:
 * 敏感类别「即使记住也默认不进共享层」; review BR-P07-011). remember has no
 * sensitivity parameter, so an explicitly remembered fact/preference about the
 * user would always enter the shared layer. Matching text proposes with
 * sensitivity='sensitive' and checkProfileCandidate then downgrades the entry
 * to the proposing bot's private memory — the fail-safe direction (a false
 * positive keeps an entry private; a false negative would share it).
 */

const SENSITIVE_HINTS: readonly RegExp[] = [
  // 健康（含心理）
  /失眠|抑郁|焦虑症|确诊|化疗|放疗|用药史|处方药|诊断书|体检报告|心理咨询|艾滋|传染病|残疾|流产|怀孕|备孕|绝症/,
  // 财务
  /月薪|年薪|工资|存款|负债|欠债|欠款|公积金|银行卡号|征信|破产/,
  // 感情 / 家庭隐私
  /离婚|出轨|外遇|分手|家暴|监护权|亲子鉴定/,
];

/** True when the text looks like a sensitive-category fact about the user. */
export function mentionsSensitiveTopic(text: string): boolean {
  return SENSITIVE_HINTS.some((pattern) => pattern.test(text));
}
