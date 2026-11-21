/**
 * 画像上行的敏感规则（T7 步骤 5，62.05 §1「类别过滤」）：`boundaries` 类与命中
 * 凭据模式 / 敏感话题的条目默认不上行（成员可手动勾选）。
 *
 * 口径与 core 的写入校验一致（`packages/core/src/memory/credential-patterns.ts`
 * 的 `containsCredential` 与 `sensitive-topics.ts` 的 `mentionsSensitiveTopic`）
 * ——core 是 Node 包（better-sqlite3 等原生依赖），渲染层不能直接引入，这里
 * 按「同一权利人的同口径移植」复制规则；上游调整时须同步（团队域默认不勾选
 * 只是体验层，服务端的写入校验才是边界）。
 */

interface PatternRule {
  name: string;
  regex: RegExp;
}

const API_KEY_PREFIXES = [
  'sk-[A-Za-z0-9_-]{16,}',
  'sk-proj-[A-Za-z0-9_-]{16,}',
  'ghp_[A-Za-z0-9]{20,}',
  'gho_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'glpat-[A-Za-z0-9_-]{16,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{30,}',
  'ya29\\.[0-9A-Za-z_-]{20,}',
  'eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // JWT
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
  'hf_[A-Za-z0-9]{30,}',
];

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/;

const KEYWORD_VALUE =
  /(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:：=]\s*['"]?([^\s'"，。；,;]{4,})['"]?|(?:密码|口令|密钥|令牌|访问令牌)(?:是|为|[:：=])\s*['"]?([^\s'"，。；,;]*[A-Za-z0-9][^\s'"，。；,;]*)['"]?/i;

const CREDENTIAL_PATTERNS: readonly PatternRule[] = [
  ...API_KEY_PREFIXES.map((body) => ({ name: 'api_key_prefix', regex: new RegExp(body) })),
  { name: 'private_key_block', regex: PRIVATE_KEY_BLOCK },
  { name: 'keyword_value_pair', regex: KEYWORD_VALUE },
];

/** True when the text looks like it contains a credential (never uploaded by default). */
export function containsCredential(text: string): boolean {
  if (text.length === 0) return false;
  return CREDENTIAL_PATTERNS.some((rule) => rule.regex.test(text));
}

const SENSITIVE_HINTS: readonly RegExp[] = [
  // 健康（含心理）
  /失眠|抑郁|焦虑症|确诊|化疗|放疗|用药史|处方药|诊断书|体检报告|心理咨询|艾滋|传染病|残疾|流产|怀孕|备孕|绝症/,
  // 财务
  /月薪|年薪|工资|存款|负债|欠债|欠款|公积金|银行卡号|征信|破产/,
  // 感情 / 家庭隐私
  /离婚|出轨|外遇|分手|家暴|监护权|亲子鉴定/,
];

/** True when the text looks like a sensitive-category fact (health / finance / family). */
export function mentionsSensitiveTopic(text: string): boolean {
  return SENSITIVE_HINTS.some((pattern) => pattern.test(text));
}

/**
 * 上行确认清单的默认勾选规则（62.05 §1）：`boundaries` 类、命中凭据模式或
 * 敏感话题的条目默认不勾选，其余默认勾选。
 */
export function profilePushCheckedByDefault(
  category: string,
  content: string,
): boolean {
  if (category === 'boundaries') return false;
  if (containsCredential(content)) return false;
  if (mentionsSensitiveTopic(content)) return false;
  return true;
}
