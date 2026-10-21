import { describe, expect, it, vi } from 'vitest';
import {
  buildUpdatePlanTool,
  currentPlanPrompt,
  planProgressText,
  type PlanState,
  type UpdatePlanParams,
} from '../../src/tools/plan-tools.js';
import type { ToolContext } from '../../src/agent/types.js';

/** D93 P1：update_plan 工具契约与计划注入文本。 */

const ctx = { signal: new AbortController().signal } as ToolContext;

function makeTool() {
  let state: PlanState | null = null;
  const onProgress = vi.fn();
  const tool = buildUpdatePlanTool({
    getPlan: () => state,
    setPlan: (next) => {
      state = next;
    },
    onProgress,
    now: () => 1_000,
  });
  return { tool, onProgress, plan: () => state };
}

describe('update_plan', () => {
  it('replaces the plan and emits the progress line', async () => {
    const { tool, onProgress, plan } = makeTool();
    const params: UpdatePlanParams = {
      explanation: '拆分一下',
      plan: [
        { step: '检查项目', status: 'completed' },
        { step: '运行测试', status: 'in_progress' },
        { step: '汇报结果', status: 'pending' },
      ],
    };
    const result = await tool.execute(params, ctx);
    expect(result.ok).toBe(true);
    expect(plan()).toMatchObject({
      explanation: '拆分一下',
      plan: params.plan,
      updatedAt: 1_000,
    });
    expect(onProgress).toHaveBeenCalledWith('计划 2/3：运行测试');
    expect(result.content).toContain('2. [in_progress] 运行测试');
  });

  it('rejects invalid plans without touching the previous one', async () => {
    const { tool, plan } = makeTool();
    await tool.execute(
      { plan: [{ step: '旧计划', status: 'in_progress' }] },
      ctx,
    );
    const previous = plan();

    const invalidPlans: UpdatePlanParams['plan'] = [];
    const cases: UpdatePlanParams[] = [
      { plan: invalidPlans },
      {
        plan: [
          { step: 'a', status: 'in_progress' },
          { step: 'b', status: 'in_progress' },
        ],
      },
      { plan: [{ step: 'x'.repeat(201), status: 'pending' }] },
      { plan: [{ step: 'ok', status: 'done' as never }] },
      { plan: Array.from({ length: 21 }, (_, index) => ({ step: `s${index}`, status: 'pending' as const })) },
      { explanation: 'x'.repeat(301), plan: [{ step: 'ok', status: 'pending' }] },
    ];
    for (const params of cases) {
      const result = await tool.execute(params, ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('INVALID_INPUT');
      expect(plan()).toEqual(previous);
    }
  });

  it('formats the plan block and progress for the prompt', () => {
    const state: PlanState = {
      explanation: '',
      updatedAt: 0,
      plan: [
        { step: '检查项目', status: 'completed' },
        { step: '运行测试', status: 'completed' },
      ],
    };
    expect(planProgressText(state)).toBe('计划 2/2：全部完成');
    expect(currentPlanPrompt(state)).toContain('<current_plan>');
    expect(currentPlanPrompt(state)).toContain('1. [completed] 检查项目');
    expect(currentPlanPrompt(state)).toContain('2. [completed] 运行测试');
    expect(currentPlanPrompt(null)).toBe('');
  });
});
