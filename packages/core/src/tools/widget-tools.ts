import { Type } from '@earendil-works/pi-ai';
import type { WidgetScope } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import type {
  WidgetCreateInput,
  WidgetUpdateInput,
  WidgetWriteResult,
} from '../widgets/service.js';

/**
 * Bot 自制交互组件工具（D81，docs/design/32-bot-widgets.md）：`widget_create` /
 * `widget_update` / `widget_publish`——任务把单文件 HTML 组件落库（版本只增不改）
 * 并以 `bot_widget` 卡片发进对话，用户按版本确认后在沙箱 iframe 里操作。仅任务面
 * 注册（对话轮只读纪律）；副作用是本机库写入，记 `local`（不进外部副作用台账）。
 */

export const WIDGET_CREATE_TOOL = 'widget_create';
export const WIDGET_UPDATE_TOOL = 'widget_update';
export const WIDGET_PUBLISH_TOOL = 'widget_publish';

/** The slice of WidgetService the tools need. */
export interface WidgetToolFacade {
  create(input: WidgetCreateInput): WidgetWriteResult;
  update(input: WidgetUpdateInput): WidgetWriteResult;
  publish(input: {
    botId: string;
    widgetId: string;
    conversationId: string;
    runId: string | null;
  }): WidgetWriteResult;
}

const WIDGET_HTML_GUIDE =
  '单文件 HTML（含内联 CSS/JS），不用外链资源、不发网络请求、不用 localStorage/fetch（沙箱里不可用）。' +
  '需要持久化用宿主桥 window.kepcup.storage.get/set/delete/list(key,value)（每组件独立命名空间的 JSON KV，' +
  '数据只存本机、重启仍在；单值 ≤256KB、总量 ≤1MB/1000 键，不要存敏感信息）；需要读本机数据（统计、记录）' +
  '就在 queries 参数里随版本声明命名只读查询模板（单条 SELECT 或 WITH…SELECT，:name 占位参数），组件里用 ' +
  'window.kepcup.query(name, params) 调用，返回 { rows, truncated }（rows 是「列名→值」对象数组，最多 200 行、' +
  '回执总量约 1MB，超出任一上限时 truncated=true；BLOB 列以 base64 字符串返回，超过 ±2^53 的整数会失去精度，' +
  '超大数值请以文本列处理）。SQL 全文会展示给用户审查（运行时免审批）；模板' +
  '随版本生效，每次交付都要给完整 queries 清单（不传 = 该版本没有任何查询）。需要打开网页用 ' +
  'window.kepcup.openLink(url)（仅 https，会先请用户确认）；window.kepcup.theme() 可取当前明暗主题，' +
  'window.kepcup.setHeight(像素) 让卡片高度自适应内容。这些 API 都是异步的（返回 Promise）；被拒绝时 ' +
  'Promise reject，error.code 可程序化区分（WIDGET_RATE_LIMITED=调用太频繁、WIDGET_STORAGE_QUOTA=存储满了、' +
  'WIDGET_RESOURCE_EXPIRED=请用户重新打开卡片、WIDGET_QUERY_UNKNOWN=查询模板名在这个版本没登记、' +
  'WIDGET_QUERY_FAILED=参数不对或执行出错、INVALID_INPUT=参数不对），error.message 是可直接展示的中文。' +
  '组件初始高约 380px，宽度自适应。scope="bot" 的组件是你的跨对话资产（不随对话删除）：' +
  '可在任何对话里用 widget_update 更新（新卡发给当前对话），或用 widget_publish 把最新版发卡到当前对话。';

const QUERIES_PARAM_DESCRIPTION =
  '随版本登记的命名只读查询模板（每次交付都给完整清单，不传 = 该版本没有查询）。' +
  '单条 SELECT/WITH…SELECT，用 :参数名 占位；SQL 会展示给用户审查，组件内用 window.kepcup.query(name, params) 调用';

/** 模型给的 queries 条目归一为 {name, sql} 字符串（残缺条目交服务层拒绝并给出人话）。 */
function normalizeQueries(raw: Array<{ name?: string; sql?: string }> | undefined):
  | Array<{ name: string; sql: string }>
  | undefined {
  if (raw === undefined) return undefined;
  return raw.map((def) => ({ name: String(def?.name ?? ''), sql: String(def?.sql ?? '') }));
}

export function buildWidgetTools(input: {
  identity: RunIdentity;
  widgets: WidgetToolFacade;
}): ToolDefinition[] {
  const { identity, widgets } = input;

  const create: ToolDefinition<{
    title?: string;
    description?: string;
    html?: string;
    queries?: Array<{ name?: string; sql?: string }>;
    scope?: WidgetScope;
  }> = {
    name: WIDGET_CREATE_TOOL,
    description:
      '给用户做一个可直接操作的交互组件（计算器、追踪表、小工具、可视化等）：写一个完整的单文件 HTML，用户在对话里点「加载」即可使用。用户明确想要「能点的」「做个小工具」「帮我做个页面」时用它；纯文字能说清的不要做组件。' +
      WIDGET_HTML_GUIDE,
    parameters: Type.Object({
      title: Type.String({ description: '组件名，简短（≤120 字），如「费用分摊计算器」' }),
      description: Type.String({ description: '一句话说明它能做什么（给用户看）' }),
      html: Type.String({ description: '完整的单文件 HTML 源码（<!DOCTYPE html> 开头）' }),
      queries: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: '查询名（字母/数字/-/_，≤64 字符），如 by_month' }),
            sql: Type.String({ description: '单条只读 SELECT（或 WITH…SELECT），用 :参数名 占位' }),
          }),
          { description: QUERIES_PARAM_DESCRIPTION },
        ),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal('conversation'), Type.Literal('bot')], {
          description: '作用域：仅本对话（默认）或保存为你的跨对话资产',
        }),
      ),
    }),
    execute: async (params) => {
      const botId = identity.botId;
      const conversationId = identity.conversationId;
      if (botId === null || conversationId === null) {
        return { ok: false, content: '组件必须发给一个对话（当前没有对话上下文）', errorCode: 'INVALID_INPUT' };
      }
      const title = params.title?.trim() ?? '';
      const html = params.html ?? '';
      if (title === '' || html.trim() === '') {
        return { ok: false, content: '需要提供 title 和 html', errorCode: 'INVALID_INPUT' };
      }
      const result = widgets.create({
        botId,
        conversationId,
        title,
        description: params.description?.trim() ?? '',
        html,
        ...(params.queries !== undefined ? { queries: normalizeQueries(params.queries) } : {}),
        scope: params.scope ?? 'conversation',
        runId: identity.runId,
      });
      if (!result.ok) {
        return { ok: false, content: result.message, errorCode: result.code ?? 'INVALID_INPUT' };
      }
      // 落库成功但发卡失败（cardMessageId 缺省）：组件此刻在界面上不可见，不能让
      // 模型引导用户去找一张不存在的卡。
      if (result.cardMessageId === undefined) {
        return {
          ok: true,
          content: `组件「${title}」已保存，但卡片消息发送失败，用户暂时看不到它；请如实告知用户组件未能送达，之后用 widget_update 重新发布（会发新卡）。（widgetId: ${result.widgetId}）`,
        };
      }
      return { ok: true, content: `${result.message}（widgetId: ${result.widgetId}）` };
    },
  };

  const update: ToolDefinition<{
    widget_id?: string;
    html?: string;
    queries?: Array<{ name?: string; sql?: string }>;
    change_note?: string;
  }> = {
    name: WIDGET_UPDATE_TOOL,
    description:
      '更新你之前创建的交互组件：整体给出修改后的完整 HTML，生成新版本卡片（旧卡仍是旧版本，用户加载新卡看到新版）。用户对组件提出修改意见时用它。' +
      WIDGET_HTML_GUIDE,
    parameters: Type.Object({
      widget_id: Type.String({ description: 'widget_create 返回的组件 ID' }),
      html: Type.String({ description: '修改后的完整单文件 HTML（不是差异）' }),
      queries: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: '查询名（字母/数字/-/_，≤64 字符），如 by_month' }),
            sql: Type.String({ description: '单条只读 SELECT（或 WITH…SELECT），用 :参数名 占位' }),
          }),
          { description: QUERIES_PARAM_DESCRIPTION },
        ),
      ),
      change_note: Type.Optional(
        Type.String({ description: '一句话改动说明，显示在卡片上（给用户看）' }),
      ),
    }),
    execute: async (params) => {
      const botId = identity.botId;
      if (botId === null) {
        return { ok: false, content: '没有执行身份，无法更新组件', errorCode: 'INVALID_INPUT' };
      }
      // Bot 级组件（跨对话资产）的新卡发到当前对话；会话级组件不受它影响。
      const conversationId = identity.conversationId;
      const widgetId = params.widget_id?.trim() ?? '';
      const html = params.html ?? '';
      if (widgetId === '' || html.trim() === '') {
        return { ok: false, content: '需要提供 widget_id 和 html', errorCode: 'INVALID_INPUT' };
      }
      const result: WidgetWriteResult = widgets.update({
        botId,
        widgetId,
        html,
        ...(params.queries !== undefined ? { queries: normalizeQueries(params.queries) } : {}),
        conversationId,
        changeNote: params.change_note?.trim() ?? '',
        runId: identity.runId,
      });
      if (!result.ok) {
        return { ok: false, content: result.message, errorCode: result.code ?? 'INVALID_INPUT' };
      }
      if (result.cardMessageId === undefined) {
        return {
          ok: true,
          content: `组件已更新到 v${result.version}，但卡片消息发送失败，用户暂时看不到新版本；请如实告知用户，之后用 widget_update 重新发布（会发新卡）。（widgetId: ${result.widgetId}）`,
        };
      }
      return { ok: true, content: `${result.message}（widgetId: ${result.widgetId}）` };
    },
  };

  const publish: ToolDefinition<{ widget_id?: string }> = {
    name: WIDGET_PUBLISH_TOOL,
    description:
      '把你创建的 Bot 级组件（跨对话资产，widget_create 时 scope="bot"）的最新版本发卡到当前对话，让本对话的用户加载使用；不产生新版本。组件已在本对话或有会话级组件时不需要用它。',
    parameters: Type.Object({
      widget_id: Type.String({ description: 'widget_create 返回的组件 ID' }),
    }),
    execute: async (params) => {
      const botId = identity.botId;
      const conversationId = identity.conversationId;
      if (botId === null || conversationId === null) {
        return { ok: false, content: '组件必须发给一个对话（当前没有对话上下文）', errorCode: 'INVALID_INPUT' };
      }
      const widgetId = params.widget_id?.trim() ?? '';
      if (widgetId === '') {
        return { ok: false, content: '需要提供 widget_id', errorCode: 'INVALID_INPUT' };
      }
      const result = widgets.publish({ botId, widgetId, conversationId, runId: identity.runId });
      if (!result.ok) {
        return { ok: false, content: result.message, errorCode: result.code ?? 'INVALID_INPUT' };
      }
      if (result.cardMessageId === undefined) {
        return {
          ok: true,
          content: `组件「${result.title}」（v${result.version}）已引用，但卡片消息发送失败，用户暂时看不到它；请如实告知用户，稍后重试 widget_publish。（widgetId: ${result.widgetId}）`,
        };
      }
      return { ok: true, content: `${result.message}（widgetId: ${result.widgetId}）` };
    },
  };

  return [create, update, publish] as ToolDefinition[];
}
