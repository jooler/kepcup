import type { AppToolDefinition, AppToolState, AppToolView, McpToolPolicy } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 连接详情页的工具视图纯函数（D73 §5.9）：待复核拆分、策略下拉 ⇄ `McpToolPolicy`、
 * 状态标签，以及复核用的「旧 / 新定义」行级对比。无 DOM 依赖，便于单测。
 */

// --- 工具列表 ------------------------------------------------------------------

/** 待复核（新增 / 定义变化）= `state !== 'approved'`，这些工具不会暴露给模型。 */
export function isPendingTool(tool: Pick<AppToolView, 'state'>): boolean {
  return tool.state !== 'approved';
}

export function splitTools(tools: readonly AppToolView[]): {
  approved: AppToolView[];
  pending: AppToolView[];
} {
  const approved: AppToolView[] = [];
  const pending: AppToolView[] = [];
  for (const tool of tools) (isPendingTool(tool) ? pending : approved).push(tool);
  const byName = (a: AppToolView, b: AppToolView): number => a.toolName.localeCompare(b.toolName);
  return { approved: approved.sort(byName), pending: pending.sort(byName) };
}

/** 复核「全部接受」要提交的工具名。 */
export function pendingToolNames(tools: readonly AppToolView[]): string[] {
  return tools.filter(isPendingTool).map((tool) => tool.toolName);
}

export const TOOL_STATE_LABEL_KEYS: Record<AppToolState, MessageKey> = {
  approved: 'apps.detail.toolState.approved',
  new: 'apps.detail.toolState.new',
  changed: 'apps.detail.toolState.changed',
};

// --- 策略 ----------------------------------------------------------------------

/** 下拉选项：default = 清除覆盖（按风险档默认）；disabled = 不暴露给模型。 */
export type ToolPolicyChoice = 'default' | 'auto' | 'ask' | 'disabled';

export const TOOL_POLICY_CHOICES: readonly ToolPolicyChoice[] = [
  'default',
  'auto',
  'ask',
  'disabled',
];

export function toolPolicyChoice(tool: Pick<AppToolView, 'policy'>): ToolPolicyChoice {
  if (tool.policy?.enabled === false) return 'disabled';
  return tool.policy?.approval ?? 'default';
}

/**
 * 下拉选择 → `apps.connections.setToolPolicy` 的 `policy`。该 RPC 整体替换策略，所以
 * 选 disabled 只写 `{ enabled: false }`，选 auto / ask 会同时清掉停用；default = `{}`（清除）。
 */
export function policyForChoice(choice: ToolPolicyChoice): McpToolPolicy {
  switch (choice) {
    case 'auto':
      return { approval: 'auto' };
    case 'ask':
      return { approval: 'ask' };
    case 'disabled':
      return { enabled: false };
    default:
      return {};
  }
}

// --- 定义对比 ------------------------------------------------------------------

export type DiffKind = 'same' | 'add' | 'del';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** 键排序的 JSON 行（缩进 2），保证同一定义的文本稳定、diff 不被键序干扰。 */
function stableJsonLines(value: unknown): string[] {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, sort(inner)]),
      );
    }
    return input;
  };
  return (JSON.stringify(sort(value), null, 2) ?? 'null').split('\n');
}

const HEAD_KEYS = ['title', 'description', 'annotations', 'inputSchema'];

/**
 * 工具定义 → 对比用的文本行：标题、描述（保留换行，逐行）、注解、入参 schema，
 * 其余字段（如 outputSchema）按键序追加；`name` 是行键、不参与。
 */
export function definitionLines(definition: AppToolDefinition): string[] {
  const record = definition as Record<string, unknown>;
  const rest = Object.keys(record)
    .filter((key) => key !== 'name' && !HEAD_KEYS.includes(key))
    .sort();
  const lines: string[] = [];
  for (const key of [...HEAD_KEYS, ...rest]) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === 'title') {
      lines.push(`title: ${String(value)}`);
    } else if (key === 'description') {
      lines.push('description:');
      for (const line of String(value).split('\n')) lines.push(`  ${line}`);
    } else {
      lines.push(`${key}:`);
      for (const line of stableJsonLines(value)) lines.push(`  ${line}`);
    }
  }
  return lines;
}

/** 行数乘积超过它时放弃 LCS，退化为整块删 / 增（防极端大 schema 卡住界面）。 */
const MAX_LCS_CELLS = 2_000_000;

/** 行级 diff（LCS）。输入为行数组；输出保序，same / del / add。 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const head = before.slice(0, start).map((text): DiffLine => ({ kind: 'same', text }));
  const tail = before.slice(endB).map((text): DiffLine => ({ kind: 'same', text }));
  const a = before.slice(start, endB);
  const b = after.slice(start, endA);

  let middle: DiffLine[];
  if (a.length * b.length > MAX_LCS_CELLS) {
    middle = [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  } else {
    // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度。
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i]![j] =
          a[i] === b[j]
            ? lcs[i + 1]![j + 1]! + 1
            : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ kind: 'same', text: a[i]! });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        middle.push({ kind: 'del', text: a[i]! });
        i++;
      } else {
        middle.push({ kind: 'add', text: b[j]! });
        j++;
      }
    }
    while (i < a.length) middle.push({ kind: 'del', text: a[i++]! });
    while (j < b.length) middle.push({ kind: 'add', text: b[j++]! });
  }
  return [...head, ...middle, ...tail];
}

/**
 * 待复核工具的新旧对比：从未批准（`new`，approvedDefinition 为 null）→ 全部为新增行；
 * 已批准但定义变了 → 旧 / 新的行级 diff。
 */
export function toolDefinitionDiff(
  tool: Pick<AppToolView, 'definition' | 'approvedDefinition'>,
): DiffLine[] {
  const after = definitionLines(tool.definition);
  const before = tool.approvedDefinition === null ? [] : definitionLines(tool.approvedDefinition);
  return diffLines(before, after);
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'del') removed++;
  }
  return { added, removed };
}

/** 事件 / 视图里的「待复核」计数 → 提示用总数。 */
export function pendingTotal(pending: { added: number; changed: number }): number {
  return pending.added + pending.changed;
}
