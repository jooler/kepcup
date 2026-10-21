import { Type } from '@earendil-works/pi-ai';
import {
  TASK_PLAN_EXPLANATION_MAX_CHARS,
  TASK_PLAN_MAX_STEPS,
  TASK_PLAN_STEP_MAX_CHARS,
} from '@kepcup/shared';
import type { ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * `update_plan`（D93，docs/design/43-task-loop-harness.md §4）。
 *
 * 只注册给内置 pi 任务：模型用它维护一份结构化执行计划，宿主把当前计划
 * 追加到下一轮系统提示词的 `<current_plan>` 里，并把进度写进 run_steps。
 * 外部智能体有各自的原生 todo / plan 工具，不注入本工具。
 */

export const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanEntry {
  step: string;
  status: PlanStatus;
}

export interface PlanState {
  explanation: string;
  plan: PlanEntry[];
  updatedAt: number;
}

export interface UpdatePlanParams {
  explanation?: string;
  plan: Array<{ step: string; status: PlanStatus }>;
}

export interface UpdatePlanToolInput {
  getPlan(): PlanState | null;
  setPlan(state: PlanState): void;
  /** 计划更新后的 progress 文本（任务卡与执行过程页可见）。 */
  onProgress?(text: string): void;
  now?: () => number;
}

type Validation = { ok: true; plan: PlanEntry[]; explanation: string } | { ok: false; message: string };

/** 计划参数校验（也供执行过程页解析时复用同一口径）。 */
export function validatePlanParams(params: UpdatePlanParams): Validation {
  const explanation = typeof params.explanation === 'string' ? params.explanation.trim() : '';
  if (explanation.length > TASK_PLAN_EXPLANATION_MAX_CHARS) {
    return {
      ok: false,
      message: `explanation 不能超过 ${TASK_PLAN_EXPLANATION_MAX_CHARS} 字`,
    };
  }
  if (!Array.isArray(params.plan) || params.plan.length === 0) {
    return { ok: false, message: 'plan 不能为空：至少给出一个步骤' };
  }
  if (params.plan.length > TASK_PLAN_MAX_STEPS) {
    return {
      ok: false,
      message: `plan 最多 ${TASK_PLAN_MAX_STEPS} 项（收到 ${params.plan.length} 项）`,
    };
  }
  let inProgress = 0;
  const plan: PlanEntry[] = [];
  for (const [index, entry] of params.plan.entries()) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, message: `第 ${index + 1} 项不是有效的计划项` };
    }
    const step = typeof entry.step === 'string' ? entry.step.trim() : '';
    if (step.length === 0) {
      return { ok: false, message: `第 ${index + 1} 项的 step 不能为空` };
    }
    if (step.length > TASK_PLAN_STEP_MAX_CHARS) {
      return {
        ok: false,
        message: `第 ${index + 1} 项的 step 不能超过 ${TASK_PLAN_STEP_MAX_CHARS} 字`,
      };
    }
    if (!PLAN_STATUSES.includes(entry.status)) {
      return {
        ok: false,
        message: `第 ${index + 1} 项的 status 只能是 pending / in_progress / completed`,
      };
    }
    if (entry.status === 'in_progress') inProgress += 1;
    plan.push({ step, status: entry.status });
  }
  if (inProgress > 1) {
    return { ok: false, message: '同一时间至多一个步骤是 in_progress' };
  }
  return { ok: true, plan, explanation };
}

/** 当前计划的一行摘要（progress / 任务卡）：「计划 2/5：当前步骤」。 */
export function planProgressText(state: PlanState): string {
  const total = state.plan.length;
  const currentIndex = state.plan.findIndex((entry) => entry.status === 'in_progress');
  const completed = state.plan.filter((entry) => entry.status === 'completed').length;
  if (currentIndex >= 0) {
    return `计划 ${currentIndex + 1}/${total}：${state.plan[currentIndex]!.step}`;
  }
  if (completed >= total) return `计划 ${total}/${total}：全部完成`;
  const lastCompleted = [...state.plan].reverse().find((entry) => entry.status === 'completed');
  return `计划 ${completed}/${total}：${lastCompleted?.step ?? state.plan[0]?.step ?? ''}`;
}

/** 系统提示词里的计划块（不含外层分隔，由 PiEngine 决定排布）。 */
export function currentPlanPrompt(state: PlanState | null): string {
  if (state === null || state.plan.length === 0) return '';
  const lines = state.plan.map(
    (entry, index) => `${index + 1}. [${entry.status}] ${entry.step}`,
  );
  return [
    '<current_plan>',
    ...lines,
    '</current_plan>',
    '计划是你自己的执行状态：完成一步立即标记；改方案时更新计划；不要把计划当作对用户的承诺。需要调整时调用 update_plan（全量替换）。',
  ].join('\n');
}

/** 摘要模型看到的纯文本计划（不带标签）。 */
export function currentPlanText(state: PlanState | null): string {
  if (state === null || state.plan.length === 0) return '';
  return state.plan.map((entry, index) => `${index + 1}. [${entry.status}] ${entry.step}`).join('\n');
}

function planBody(state: PlanState): string {
  return state.plan.map((entry, index) => `${index + 1}. [${entry.status}] ${entry.step}`).join('\n');
}

function invalid(message: string): ToolResult {
  return { ok: false, content: `计划未更新：${message}`, errorCode: 'INVALID_INPUT' };
}

export function buildUpdatePlanTool(input: UpdatePlanToolInput): ToolDefinition<UpdatePlanParams> {
  return {
    name: 'update_plan',
    description: [
      '维护当前任务的执行计划（全量替换）：多步工作（预计 ≥3 步）开始时先建计划，完成一步立即标记，偏航时更新计划。',
      '同一时间至多一个步骤是 in_progress；计划是执行状态，不是对用户的承诺。',
      '代码任务最后一步应包含验证（运行相关测试 / lint / build），并在最终结果里写明命令与结果。',
    ].join('\n'),
    parameters: Type.Object(
      {
        explanation: Type.Optional(
          Type.String({
            maxLength: TASK_PLAN_EXPLANATION_MAX_CHARS,
            description: '本次更新的原因（可选，≤ 300 字）',
          }),
        ),
        plan: Type.Array(
          Type.Object({
            step: Type.String({
              maxLength: TASK_PLAN_STEP_MAX_CHARS,
              description: '步骤说明（≤ 200 字）',
            }),
            status: Type.Union(
              [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')],
              { description: 'pending / in_progress / completed' },
            ),
          }),
          {
            minItems: 1,
            maxItems: TASK_PLAN_MAX_STEPS,
            description: '1–20 项，至多一个 in_progress',
          },
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const checked = validatePlanParams(params);
      if (!checked.ok) return invalid(checked.message);
      const state: PlanState = {
        explanation: checked.explanation,
        plan: checked.plan,
        updatedAt: (input.now ?? Date.now)(),
      };
      input.setPlan(state);
      const progress = planProgressText(state);
      input.onProgress?.(progress);
      return {
        ok: true,
        content: [
          planBody(state),
          progress,
          '下一步：把当前 in_progress 做完后立即更新状态；需要改方案时全量替换计划。',
        ].join('\n'),
      };
    },
  };
}

export { planBody };
