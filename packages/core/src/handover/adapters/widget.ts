import type { Bot, HandoverAction, WidgetCheckStatus } from '@kepcup/shared';
import type { WidgetHandoverCandidate } from '../../widgets/service.js';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId } from './common.js';
import { formatBytes } from './wiki.js';

/**
 * 组件（D88 P2，设计 37 §3）：只有 Bot 级组件（`scope='bot'`）可以复制，A 不变；后台
 * `handover_copy` 作业里执行（`background`，与 Wiki 同一作业）。
 *
 * - 复制组件与全部版本（HTML、自检状态与摘要照搬）、查询模板、storage 文档；新 id、不发卡。
 * - 确认状态：渲染端的加载确认按「HTML sha256 + 查询摘要」记（同一用户、不分组件），副本
 *   的摘要与原版相同，原版已确认的版本在 B 那里同样免确认；SQL 预审时间照搬。
 * - 会话级组件不移交：它们只属于所在对话（卡片钉在那里、查询模板读那个对话的消息），随
 *   对话生灭；盘点只给条数。
 * - B 已有同名组件 / 数量或字节上限 → 置灰（执行时 → 跳过）。幂等：B 已有同名且版本序列
 *   完全相同的组件 = 已复制。
 */

export interface HandoverWidgetPort {
  candidates(botId: string): WidgetHandoverCandidate[];
  conversationScopedCount(botId: string): number;
  findCopy(widgetId: string, toBotId: string): string | null;
  blocker(widgetId: string, toBotId: string, toName: string): string | null;
  copy(widgetId: string, toBotId: string, toName: string): { widgetId: string; versions: number };
}

export interface WidgetAdapterDeps {
  widgets: HandoverWidgetPort;
}

const CHECK_TEXT: Record<WidgetCheckStatus, string> = {
  legacy: '',
  passed: '自检通过',
  issues: '自检有已知问题',
  unverified: '未经运行验证',
};

export class WidgetAdapter implements HandoverAdapter {
  readonly type = 'widget' as const;
  readonly stage = 3;
  readonly background = true;
  readonly #deps: WidgetAdapterDeps;

  constructor(deps: WidgetAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'widget') !== null;
  }

  #candidate(botId: string, key: string): WidgetHandoverCandidate | null {
    const id = keyId(key, 'widget') ?? '';
    return this.#deps.widgets.candidates(botId).find((w) => w.widgetId === id) ?? null;
  }

  #entry(widget: WidgetHandoverCandidate): HandoverEntry {
    const parts = [
      `${widget.versionCount} 个版本，${formatBytes(widget.bytes)}`,
      widget.queriesCount > 0 ? `${widget.queriesCount} 个查询模板` : '',
      widget.docsCount > 0 ? `${widget.docsCount} 条存储数据` : '',
      CHECK_TEXT[widget.checkStatus],
      widget.description,
    ];
    return {
      key: `widget:${widget.widgetId}`,
      type: 'widget',
      label: widget.title,
      detail: parts.filter((part) => part.length > 0).join('；'),
      actions: ['copy'],
      defaultAction: 'copy',
      // 标题 / 说明由模型写。
      external: true,
    };
  }

  inventory(botId: string): HandoverEntry[] {
    return this.#deps.widgets.candidates(botId).map((widget) => this.#entry(widget));
  }

  summary(botId: string): string | null {
    const scoped = this.#deps.widgets.conversationScopedCount(botId);
    return scoped > 0
      ? `另有 ${scoped} 个会话级组件只属于所在对话，不移交（只有 Bot 级组件可以复制）`
      : null;
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'copy') return '组件只能复制';
    const widget = this.#candidate(ctx.fromBot.id, key);
    if (widget === null) return `${ctx.fromBot.name} 已没有这个 Bot 级组件`;
    if (ctx.toBot === null) return null;
    return this.#deps.widgets.blocker(widget.widgetId, ctx.toBot.id, ctx.toName);
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const id = keyId(key, 'widget') ?? '';
    const copy = this.#deps.widgets.copy(id, ctx.toBot.id, ctx.toName);
    return { result: { widgetId: copy.widgetId, copiedCount: copy.versions } };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string): boolean {
    return this.#deps.widgets.findCopy(keyId(key, 'widget') ?? '', ctx.toBot.id) !== null;
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    return `把组件「${entry.label}」（${entry.detail}）连同全部版本、查询模板与存储数据复制一份给 ${toName}（之后两边各改各的）；已确认加载过的版本在 ${toName} 那里不用再确认`;
  }
}
