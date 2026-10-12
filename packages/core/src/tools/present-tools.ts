import { Type } from '@earendil-works/pi-ai';
import {
  PRESENT_CARDS_PER_RUN_MAX,
  PRESENT_DATA_MAX_BYTES,
  PRESENT_TITLE_MAX_CHARS,
  presentKindSchema,
  validatePresent,
  type PresentKind,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';

/**
 * `present`（D87 P4 L1，设计 32 §12.1）：Bot 只给数据，宿主渲染展示卡——表格、柱 / 折 / 饼图、指标卡、
 * 步骤、时间线、方案对比。对话轮与任务都注册：它只发一条卡片消息，没有其他副作用（不写文件、不调
 * 外部服务），对话轮的只读纪律不受影响。校验失败返回「哪一字段、期望什么」，模型改了重试即可。
 */

export const PRESENT_TOOL = 'present';

/** 发卡的落点（orchestrator 装配：消息落库 + 推送）；返回卡片消息 id。 */
export interface PresentToolFacade {
  emit(input: {
    identity: RunIdentity;
    kind: PresentKind;
    title: string;
    data: unknown;
  }): { ok: true; messageId: string } | { ok: false; message: string };
}

const KIND_GUIDE = [
  'table：{columns: [列名…], rows: [[单元格…]…]}（每行单元格数 = 列数；单元格是文字 / 数字 / 布尔 / null）',
  'bar / line：{categories: [类目…], series: [{name, values: [数字…]}…], unit?}（每组 values 数 = 类目数，至多 8 组）',
  'pie：{slices: [{label, value}…], unit?}（value ≥ 0，至多 12 份）',
  'kpi：{items: [{label, value, unit?, change?（相对变化百分比，如 12.5）, note?}…]}',
  'steps：{steps: [{title, detail?, status?: done|current|todo}…]}',
  'timeline：{events: [{time（给人看的时间文本）, title, detail?}…]}',
  'compare：{options: [方案名…], criteria: [{name, values: [每个方案一格…]}…], recommended?}',
].join('；');

export function buildPresentTools(input: {
  identity: RunIdentity;
  present: PresentToolFacade;
}): ToolDefinition[] {
  const { identity, present } = input;
  // 工具按 run 装配，闭包计数即每 run 上限（防模型循环刷卡）。
  let emitted = 0;
  const tool: ToolDefinition<{ kind?: unknown; title?: unknown; data?: unknown }> = {
    name: PRESENT_TOOL,
    description:
      '把结构化结果展示成卡片（宿主渲染，无需写代码）：表格、柱状图 / 折线图 / 饼图、指标卡、步骤、时间线、方案对比。展示类结果优先用它；用户要能操作的界面（输入、保存、交互）才用 widget_craft。' +
      `只给数据，不要写 HTML；data ≤ ${Math.round(PRESENT_DATA_MAX_BYTES / 1024)}KB。各 kind 的 data：${KIND_GUIDE}。卡片发出后不用再用文字复述全部数据，点出要点即可。`,
    parameters: Type.Object({
      kind: Type.Union(
        presentKindSchema.options.map((kind) => Type.Literal(kind)),
        { description: '展示形式' },
      ),
      title: Type.Optional(
        Type.String({ description: `卡片标题（≤${PRESENT_TITLE_MAX_CHARS} 字）` }),
      ),
      data: Type.Unknown({ description: '按 kind 的结构给数据（见工具说明）' }),
    }),
    execute: async (params) => {
      if (identity.conversationId === null) {
        return { ok: false, content: '当前没有对话，无法发展示卡', errorCode: 'INVALID_INPUT' };
      }
      if (emitted >= PRESENT_CARDS_PER_RUN_MAX) {
        return {
          ok: false,
          content: `一次执行里最多发 ${PRESENT_CARDS_PER_RUN_MAX} 张展示卡；把要展示的合并到已有的卡里，或用文字说明`,
          errorCode: 'INVALID_INPUT',
        };
      }
      const title = String(params.title ?? '')
        .trim()
        .slice(0, PRESENT_TITLE_MAX_CHARS);
      const checked = validatePresent(params.kind, params.data);
      if (!checked.ok) {
        return {
          ok: false,
          content: `展示卡没有发出：${checked.message}。改正后重试。`,
          errorCode: 'INVALID_INPUT',
        };
      }
      const result = present.emit({ identity, kind: checked.kind, title, data: checked.data });
      if (!result.ok) return { ok: false, content: result.message, errorCode: 'INVALID_INPUT' };
      emitted += 1;
      return {
        ok: true,
        content: `展示卡（${checked.kind}${title !== '' ? `「${title}」` : ''}）已发进对话。不用再用文字复述全部数据，点出要点即可。`,
      };
    },
  };
  return [tool as ToolDefinition];
}
