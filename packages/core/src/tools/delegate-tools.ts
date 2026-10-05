import { Type } from '@earendil-works/pi-ai';
import { SUBAGENT_FANOUT_MAX, SUBAGENT_MAX_PER_RUN } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import type { DelegateTaskParams, SubagentToolFacade } from '../agent/subagent.js';

/**
 * delegate_task（D66，docs/design/23-mcp-and-subagent.md）：把「只要结论、
 * 材料很长」的研究型子任务委派给宿主 SubAgent。三种模式——前台同步（默认，
 * 阻塞等结论）、后台委派（立即返回 child_run_id，结论完成后由宿主注入）、
 * tasks 多路并行 fan-out（前台等全部 settle / 后台逐路注入）。工具名与契约
 * 保持稳定——上游 pi 若日后提供一等 SubAgent API，再评估减薄封装。
 */

const modeSchema = Type.Union([Type.Literal('foreground'), Type.Literal('background')], {
  description:
    'foreground（默认）：阻塞等结论；background：立即返回 child_run_id 不阻塞本轮，结论完成后由宿主自动注入对话',
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
      '它不会出现在对话里，由你决定是否转述结论。需要直接落地改文件的活不要委派。' +
      `多个相互独立的查询用 tasks 一次并行委派（至多 ${SUBAGENT_FANOUT_MAX} 路，各路不共享上下文）；` +
      '耗时的调研想边等边聊时用 mode:"background"：工具立即返回，你可以继续与用户对话或追问约束，' +
      '结论完成后由宿主自动注入对话（多路结论可能分批到达），不要轮询、不要重复委派。',
    parameters: Type.Object(
      {
        task: Type.Optional(
          Type.String({
            description: '单个子任务的完整说明（与 tasks 二选一）',
          }),
        ),
        mode: Type.Optional(modeSchema),
        tasks: Type.Optional(Type.Array(taskSchema, { description: `多路并行 fan-out（≤ ${SUBAGENT_FANOUT_MAX} 路），所有路的 mode 必须一致` }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (params, ctx) => input.subagent.delegate(params, ctx),
  };
  return [delegateTask];
}
