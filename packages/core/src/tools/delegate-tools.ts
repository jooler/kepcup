import { Type } from '@earendil-works/pi-ai';
import {
  SUBAGENT_BACKGROUND_CONCURRENCY,
  SUBAGENT_FANOUT_MAX,
  SUBAGENT_MAX_PER_RUN,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import type {
  CollectDelegateParams,
  DelegateTaskParams,
  SubagentToolFacade,
} from '../agent/subagent.js';

/**
 * delegate_task（D66，docs/design/23-mcp-and-subagent.md；D75 起是任务内部的
 * 嵌套子代理，设计 30 §1.2）：把「只要结论、材料很长」的研究型子任务委派给
 * 宿主 SubAgent。三种模式——前台同步（默认，阻塞等结论）、后台分支（立即
 * 返回 child_run_id，分支在本次执行内并行，结论用 collect_delegate_results
 * 取回）、tasks 多路并行 fan-out。结论只回到发起它的执行，不进对话。工具名
 * 与契约保持稳定——上游 pi 若日后提供一等 SubAgent API，再评估减薄封装。
 */

const modeSchema = Type.Union([Type.Literal('foreground'), Type.Literal('background')], {
  description:
    'foreground（默认）：阻塞等结论；background：立即返回 child_run_id，分支在本次执行内并行，需要结论时用 collect_delegate_results 取回',
});

const taskSchema = Type.Object(
  {
    task: Type.String({
      description: '子任务的完整说明（要什么结论、材料在哪、注意什么）；大段材料给 workspace 文件路径',
    }),
    mode: Type.Optional(modeSchema),
  },
  { additionalProperties: false },
);

export function buildDelegateTools(input: {
  identity: RunIdentity;
  subagent: SubagentToolFacade;
}): ToolDefinition[] {
  const delegateTask: ToolDefinition<DelegateTaskParams> = {
    name: 'delegate_task',
    description:
      `把「只要结论、材料很长」的研究型子任务委派给子代理执行（前台同步至多 ${SUBAGENT_MAX_PER_RUN} 次）。` +
      '适合：扫描大型目录/仓库并汇总、通读多份文件或长日志后给判断、检索多个来源只要要点。' +
      'task 里交代清楚：要什么样的结论（格式/重点/判断标准）、材料位置（路径/URL/关键词）。' +
      '大段材料先写入 workspace 文件再在 task 里给路径，不要整段塞进 task。' +
      '子代理只有只读研究工具（read/grep/find/ls、沙箱 bash、web_search/web_fetch），不能写文件也不能对话；' +
      '它的结论只回到你这里，不会出现在对话里。需要直接落地改文件的活不要委派。' +
      `多个相互独立的查询用 tasks 一次并行委派（至多 ${SUBAGENT_FANOUT_MAX} 路，各路不共享上下文）；` +
      '想让耗时的调研和你手头的工作并行时用 mode:"background"：工具立即返回 child_run_id，你可以继续用其他工具推进，' +
      `需要结论时调用 collect_delegate_results 取回（同时在跑的后台分支至多 ${SUBAGENT_BACKGROUND_CONCURRENCY} 个）；` +
      '本次执行结束时未取回的分支会被中止、结论作废。不要重复委派同一任务。',
    parameters: Type.Object(
      {
        task: Type.Optional(
          Type.String({
            description: '单个子任务的完整说明（与 tasks 二选一）',
          }),
        ),
        mode: Type.Optional(modeSchema),
        tasks: Type.Optional(
          Type.Array(taskSchema, {
            description: `多路并行 fan-out（≤ ${SUBAGENT_FANOUT_MAX} 路），所有路的 mode 必须一致`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (params, ctx) => input.subagent.delegate(params, ctx),
  };

  const collectResults: ToolDefinition<CollectDelegateParams> = {
    name: 'collect_delegate_results',
    description:
      '取回 delegate_task 后台分支（mode:"background"）的结论：等待指定分支（省略 child_run_ids 则为本次执行全部未取回的分支）结束，' +
      '按顺序返回各分支的压缩结论或失败原因。每个分支只能取回一次。' +
      '在给出最终结果之前取回你需要的结论——本次执行结束时未取回的分支会被中止。',
    parameters: Type.Object(
      {
        child_run_ids: Type.Optional(
          Type.Array(Type.String(), {
            description: 'delegate_task 返回的 child_run_id；省略 = 全部未取回的后台分支',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (params, ctx) => input.subagent.collect(params, ctx),
  };

  return [delegateTask, collectResults] as ToolDefinition[];
}
