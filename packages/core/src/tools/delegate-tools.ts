import { Type } from '@earendil-works/pi-ai';
import { SUBAGENT_MAX_PER_RUN } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import type { SubagentToolFacade } from '../agent/subagent.js';

/**
 * delegate_task（D66，docs/design/23-mcp-and-subagent.md）：把「只要结论、
 * 材料很长」的研究型子任务委派给宿主 SubAgent。工具名与契约保持稳定——上游
 * pi 若日后提供一等 SubAgent API，再评估减薄封装。
 */
export function buildDelegateTools(input: {
  identity: RunIdentity;
  subagent: SubagentToolFacade;
}): ToolDefinition[] {
  const delegateTask: ToolDefinition<{ task: string }> = {
    name: 'delegate_task',
    description:
      `把一个「只要结论、材料很长」的研究型子任务委派给子代理执行（单次执行至多 ${SUBAGENT_MAX_PER_RUN} 次，串行）。` +
      '适合：扫描大型目录/仓库并汇总、通读多份文件或长日志后给判断、检索多个来源只要要点。' +
      'task 里交代清楚：要什么样的结论（格式/重点/判断标准）、材料位置（路径/URL/关键词）。' +
      '大段材料先写入 workspace 文件再在 task 里给路径，不要整段塞进 task。' +
      '子代理只有只读研究工具（read/grep/find/ls、沙箱 bash、web_search/web_fetch），不能写文件也不能对话；' +
      '它不会出现在对话里，由你决定是否转述结论。需要直接落地改文件的活不要委派，自己做。',
    parameters: Type.Object({
      task: Type.String({
        description:
          '子任务的完整说明（要什么结论、材料在哪、注意什么）；大段材料给 workspace 文件路径',
      }),
    }),
    execute: (params, ctx) => input.subagent.delegate(params, ctx),
  };
  return [delegateTask];
}
