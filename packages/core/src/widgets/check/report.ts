import {
  WIDGET_CHECK_REPORT_MAX_CHARS,
  WIDGET_KNOWN_ISSUES_MAX,
  type WidgetAcceptanceItem,
  type WidgetAcceptanceResult,
  type WidgetCheckIssue,
  type WidgetCheckReport,
} from '@kepcup/shared';
import { WIDGET_CHECK_RULES } from './rules.js';

/**
 * 检查报告（设计 32 §11.6 / §11.8）：合并 S0 / S1 / S2 的问题 → 去重、排序、计分、判定；
 * 再转成给模型的中文文本（≤ {@link WIDGET_CHECK_REPORT_MAX_CHARS}）与卡片上给用户的「已知问题」。
 *
 * 计分（越小越好）：阻断项 ×100 + 其余 error ×10 + warning ×1 + 未通过的 must 验收点 ×50
 * （非 must ×5）。验收点在两个视口各跑一次，同一个 id 只要有一处失败就按一次计。
 * 报告里的 `errors` 计的是**不阻断**的 error（与计分口径一致），阻断项单独在 `blockers`。
 */

const FILE_ORDER: Record<WidgetCheckIssue['file'], number> = {
  'index.html': 0,
  'queries.json': 1,
  'acceptance.json': 2,
  'fixtures.json': 3,
};

function severityRank(issue: WidgetCheckIssue): number {
  if (issue.blocking) return 0;
  return issue.level === 'error' ? 1 : 2;
}

function compareIssues(a: WidgetCheckIssue, b: WidgetCheckIssue): number {
  return (
    severityRank(a) - severityRank(b) ||
    FILE_ORDER[a.file] - FILE_ORDER[b.file] ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.col ?? 0) - (b.col ?? 0) ||
    (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  );
}

function issueKey(issue: WidgetCheckIssue): string {
  return JSON.stringify([
    issue.rule,
    issue.level,
    issue.file,
    issue.line ?? null,
    issue.col ?? null,
    issue.message,
    issue.trigger ?? null,
    issue.viewport ?? null,
  ]);
}

/** 按 id 去重的失败验收点（任一视口失败即失败）。 */
function failedAcceptance(results: readonly WidgetAcceptanceResult[]): WidgetAcceptanceResult[] {
  const failed = new Map<string, WidgetAcceptanceResult>();
  for (const result of results) {
    if (!result.passed && !failed.has(result.id)) failed.set(result.id, result);
  }
  return [...failed.values()];
}

export function buildCheckReport(input: {
  issues: WidgetCheckIssue[];
  acceptance?: WidgetAcceptanceResult[];
  outline?: string;
  stages: WidgetCheckReport['stages'];
  htmlSha256: string;
  queriesSha256: string;
  now: number;
}): WidgetCheckReport {
  const unique = new Map<string, WidgetCheckIssue>();
  for (const issue of input.issues) {
    const key = issueKey(issue);
    if (!unique.has(key)) unique.set(key, issue);
  }
  const issues = [...unique.values()].sort(compareIssues);
  const acceptance = input.acceptance ?? [];
  const blockers = issues.filter((issue) => issue.blocking).length;
  const errors = issues.filter((issue) => !issue.blocking && issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  const failed = failedAcceptance(acceptance);
  const failedMust = failed.filter((result) => result.must).length;
  const failedOther = failed.length - failedMust;
  const score = blockers * 100 + errors * 10 + warnings + failedMust * 50 + failedOther * 5;
  const verdict =
    blockers > 0 || failedMust > 0
      ? 'blocked'
      : issues.length > 0 || failedOther > 0
        ? 'issues'
        : 'pass';
  return {
    htmlSha256: input.htmlSha256,
    queriesSha256: input.queriesSha256,
    stages: input.stages,
    issues,
    acceptance,
    outline: input.outline ?? '',
    score,
    blockers,
    errors,
    warnings,
    verdict,
    createdAt: input.now,
  };
}

/** 问题签名（规则 + 文件 + 位置）：连续两次 GATE 出现同一组签名即进入收缩模式（防震荡）。 */
export function issueSignature(issue: WidgetCheckIssue): string {
  return `${issue.rule}@${issue.file}:${issue.line ?? ''}:${issue.col ?? ''}`;
}

const VERDICT_TEXT: Record<WidgetCheckReport['verdict'], string> = {
  pass: '通过',
  issues: '可交付但有问题',
  blocked: '不合格（有阻断项，必须修）',
};

const STAGE_TEXT = { S0: '静态检查', S1: '脚本检查', S2: '运行预览' } as const;

function issueLine(issue: WidgetCheckIssue, hintShown: Set<string>): string {
  const where =
    issue.file === 'index.html'
      ? issue.line !== undefined
        ? ` 第 ${issue.line} 行${issue.col !== undefined ? `:${issue.col} 列` : ''}`
        : ''
      : ` ${issue.file}${issue.line !== undefined ? ` 第 ${issue.line} 行` : ''}`;
  const context: string[] = [];
  if (issue.viewport !== undefined) context.push(`视口 ${issue.viewport}`);
  if (issue.trigger !== undefined) context.push(`触发：${issue.trigger}`);
  const ctx = context.length > 0 ? `（${context.join('，')}）` : '';
  // 同一规则的改法只写一次，后面的条目写「改法同上」——省出篇幅给更多条目。
  let hint = '';
  if (issue.hint !== '') {
    hint = hintShown.has(issue.rule) ? ' — 改法同上' : ` — ${issue.hint}`;
    hintShown.add(issue.rule);
  }
  return `[${issue.rule}]${where} — ${issue.message}${ctx}${hint}`;
}

/**
 * 给模型的报告文本：首行判定与计数，按「阻断 → 错误 → 警告」分组逐条列出，再列未通过的验收点
 * 与跳过的阶段。超长时整行截断，末尾写明「…另有 N 条未列出」，保证不超过 `maxChars`。
 */
export function formatCheckReport(
  report: WidgetCheckReport,
  maxChars: number = WIDGET_CHECK_REPORT_MAX_CHARS,
): string {
  const failed = failedAcceptance(report.acceptance);
  const failedMust = failed.filter((result) => result.must).length;
  const head =
    `检查结果：${VERDICT_TEXT[report.verdict]}｜阻断 ${report.blockers} · 错误 ${report.errors} · ` +
    `警告 ${report.warnings}` +
    (failed.length > 0 ? ` · 验收未过 ${failed.length}（must ${failedMust}）` : '') +
    `｜评分 ${report.score}（越小越好）`;

  const fixed: string[] = [head];
  for (const stage of ['S0', 'S1', 'S2'] as const) {
    const run = report.stages[stage];
    if (run.status === 'skipped') {
      fixed.push(
        `${stage} ${STAGE_TEXT[stage]}：已跳过${run.reason !== '' ? `（${run.reason}）` : ''}`,
      );
    }
  }
  if (report.stages.S2.status === 'ran') {
    fixed.push(
      '注意：S2 预览环境不联网——组件的联网请求会失败（preview.offline-network，不算缺陷），依赖真实网络的验收点也会失败：这类数据与断言请改用 fixtures（kepcup.storage / kepcup.query）或容错展示。',
    );
  }

  const body: string[] = [];
  const hintShown = new Set<string>();
  const groups: Array<[string, WidgetCheckIssue[]]> = [
    ['■ 阻断项（必须修好才能交付）', report.issues.filter((issue) => issue.blocking)],
    ['■ 错误', report.issues.filter((issue) => !issue.blocking && issue.level === 'error')],
    ['■ 警告', report.issues.filter((issue) => issue.level === 'warning')],
  ];
  /** body 里每行对应的条目数（标题行为 0），截断时据此算「另有 N 条」。 */
  const weights: number[] = [];
  for (const [title, list] of groups) {
    if (list.length === 0) continue;
    body.push(title);
    weights.push(0);
    for (const issue of list) {
      body.push(issueLine(issue, hintShown));
      weights.push(1);
    }
  }
  if (failed.length > 0) {
    body.push('■ 未通过的验收点');
    weights.push(0);
    for (const result of failed) {
      const where = result.viewport !== undefined ? `（视口 ${result.viewport}）` : '';
      body.push(
        `[${result.must ? 'must' : '可选'}] ${result.id}${where}${result.detail !== '' ? ` — ${result.detail}` : ''}`,
      );
      weights.push(1);
    }
  }
  if (body.length === 0 && report.verdict === 'pass') {
    body.push('没有发现问题。');
    weights.push(0);
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const out: string[] = [];
  let used = 0;
  const fits = (line: string, reserve: number): boolean =>
    used + (out.length > 0 ? 1 : 0) + line.length + reserve <= maxChars;
  const append = (line: string): void => {
    used += (out.length > 0 ? 1 : 0) + line.length;
    out.push(line);
  };
  for (const line of fixed) {
    if (fits(line, 0)) append(line);
    else if (out.length === 0) return line.slice(0, Math.max(0, maxChars));
  }
  let listed = 0;
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i] ?? '';
    const remaining = total - listed - (weights[i] ?? 0);
    const tail = remaining > 0 ? `…另有 ${remaining} 条未列出` : '';
    // 放下这一行之后还要放得下尾注（若之后还有条目）。
    if (fits(line, tail === '' ? 0 : tail.length + 1)) {
      append(line);
      listed += weights[i] ?? 0;
      continue;
    }
    const left = total - listed;
    const note = `…另有 ${left} 条未列出`;
    if (left > 0 && fits(note, 0)) append(note);
    break;
  }
  return out.join('\n');
}

/**
 * 卡片「已知问题」（≤ {@link WIDGET_KNOWN_ISSUES_MAX} 条、面向用户的中文）：按严重度取规则的
 * userText 去重，未通过的验收点用其描述（`items` 提供验收点定义时）或 id。只关乎制作过程的规则
 * （userText 为空，如 acceptance.invalid）不上卡。
 */
export function knownIssuesForUser(
  report: WidgetCheckReport,
  max: number = WIDGET_KNOWN_ISSUES_MAX,
  items?: readonly WidgetAcceptanceItem[],
): string[] {
  const userText = new Map(WIDGET_CHECK_RULES.map((rule) => [rule.id, rule.userText]));
  const failed = failedAcceptance(report.acceptance);
  const describe = (result: WidgetAcceptanceResult): string => {
    const desc = items?.find((item) => item.id === result.id)?.desc;
    return `未通过验收：${desc ?? result.id}`;
  };
  const ordered: string[] = [];
  const fromIssues = (filter: (issue: WidgetCheckIssue) => boolean): void => {
    for (const issue of report.issues) {
      if (!filter(issue)) continue;
      const text = userText.get(issue.rule) ?? '';
      if (text !== '') ordered.push(text);
    }
  };
  fromIssues((issue) => issue.blocking);
  for (const result of failed) if (result.must) ordered.push(describe(result));
  fromIssues((issue) => !issue.blocking && issue.level === 'error');
  for (const result of failed) if (!result.must) ordered.push(describe(result));
  fromIssues((issue) => issue.level === 'warning');
  return [...new Set(ordered)].slice(0, Math.max(0, Math.min(max, WIDGET_KNOWN_ISSUES_MAX)));
}
