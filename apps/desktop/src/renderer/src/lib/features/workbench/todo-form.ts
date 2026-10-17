import type { TodoAssignee } from '@kepcup/shared';
import { sameWhen, whenFromDraft, type WhenDraft } from './when-presets';

/** 抽屉表单的可提交部分（执行者已转成 RPC 形状）。 */
export interface TodoFormValues {
  title: string;
  notes: string;
  /** 内部编码 `''` / `bot:<id>` / `project:<id>`——只用来判断是否变了。 */
  assigneeKey: string;
  leadBotId: string;
  assignee: TodoAssignee | null;
  when: WhenDraft;
}

/**
 * `todos.update` 的入参：只含相对 `base` 改动过的字段；什么都没改返回 null。
 * - 时间只在草稿本身变了时才发（只改执行者时不重发 `when`，由 core 迁移原排期）；
 *   「立即」直接作为 `when:'now'` 提交（周期 / 单次排期的收尾由 core 负责），不再先存后 start；
 * - `planLocked`（已开始 / 已结束）与 `omitWhen`（「立即开始」只存其余字段）都不带时间。
 */
export function buildUpdateInput(
  id: string,
  base: Omit<TodoFormValues, 'assignee'>,
  form: TodoFormValues,
  options: { planLocked: boolean; omitWhen: boolean },
): Record<string, unknown> | null {
  const input: Record<string, unknown> = { id };
  if (form.title !== base.title) input.title = form.title.trim();
  if (form.notes !== base.notes) input.notes = form.notes;
  if (form.assigneeKey !== base.assigneeKey || form.leadBotId !== base.leadBotId) {
    input.assignee = form.assignee;
  }
  if (!options.omitWhen && !options.planLocked && !sameWhen(form.when, base.when)) {
    input.when = whenFromDraft(form.when);
  }
  return Object.keys(input).length === 1 ? null : input;
}

/**
 * `warnings` 里只是说明、不是问题的条目（排期落在免打扰时段：「不受免打扰限制，会照常发出」）：
 * 界面用中性样式，不渲染成警示。
 */
export function isInfoWarning(warning: string): boolean {
  return warning.includes('不受免打扰限制');
}
