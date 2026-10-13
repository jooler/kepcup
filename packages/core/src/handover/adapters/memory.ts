import {
  HANDOVER_MEMORY_QUERY_LIMIT,
  type Bot,
  type HandoverAction,
  type MemoryItem,
  type MemoryKind,
} from '@kepcup/shared';
import type { NewMemoryItem } from '../../memory/store.js';
import type { HandoverAdapter, HandoverContext, HandoverEntry, InventoryQuery } from '../types.js';
import { keyId } from './common.js';

/**
 * 记忆（D88 P1，设计 37 §3.1）：按条复制，A 不变。
 *
 * - 选择：盘点默认只给数量与按 kind 的分布（`summary`）；给了 `memory_query` 才列候选条目
 *   （关键词检索；`*` = 最近的），每条带 id 与内容预览。
 * - 永不提供：`private_to_bot`（用户说过「只告诉你」）、`self_note`（A 关于自己的笔记）、
 *   非 active / 已过期的；承诺（commitment）也不单独复制——它是待办责任，跟着关联的定时
 *   任务走（schedule 适配器）。盘点、提议（`refusal` → 退回）与执行（`validate` → 跳过）
 *   三处都过滤。
 * - 敏感（`sensitivity='sensitive'`）：卡上标「敏感」，默认不勾。
 * - 写入 B：新 id；kind / content / subject / source / confidence / sensitivity / due_at /
 *   valid_until / origin 照搬；`evidence_json` 只记来源 `{handoverId, fromBotId, fromItemId}`；
 *   `origin_conversation_id` 置空；写入后 `embedItem`（失败不阻塞，向量重建路径补齐）。
 *   幂等：B 里已有本次移交从同一条复制来的，就不再写。
 */

export interface HandoverMemoryPort {
  get(botId: string, itemId: string): MemoryItem | null;
  activeItems(botId: string): MemoryItem[];
  search(botId: string, query: string, limit: number): MemoryItem[];
  /** The copy a handover wrote (active first, else the latest; any status). */
  findCopy(botId: string, handoverId: string, fromItemId: string): MemoryItem | null;
  activeWithContent(botId: string, content: string): MemoryItem | null;
  insertCopy(botId: string, item: NewMemoryItem): MemoryItem;
  /** Best-effort vector sync (never throws). */
  embed(botId: string, item: MemoryItem): Promise<void>;
  voidCommitment(botId: string, itemId: string): boolean;
}

export interface MemoryAdapterDeps {
  memory: HandoverMemoryPort;
  clock: () => number;
}

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  commitment: '承诺',
  feedback: '反馈',
  episode: '经历',
  lesson: '经验',
  self_note: '自我笔记',
};

const PREVIEW_MAX_CHARS = 120;

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS)}…` : flat;
}

/**
 * Why an item may never be copied by a handover (null = it may). Shared by the memory
 * adapter and the schedule adapter's commitment check (`private_to_bot`).
 */
export function memoryRefusal(item: MemoryItem, now: number, ownerName: string): string | null {
  if (item.privateToBot) return `用户说过这条只告诉 ${ownerName}，不能移交`;
  if (item.kind === 'self_note') return `这是 ${ownerName} 关于自己的笔记，不能移交`;
  if (item.kind === 'commitment') {
    return '承诺不单独复制：它跟着关联的定时任务一起移交（移交那条定时任务）';
  }
  if (item.status !== 'active') return '这条记忆已失效（被撤回、已过时或已作废）';
  if (item.validUntil !== null && item.validUntil <= now) return '这条记忆已过期';
  return null;
}

/**
 * Vector sync of a copied entry: never blocks or fails the copy (设计 37 §7 风险——向量模型
 * 未就绪 / 出错时由既有的向量重建路径补齐)。`MemoryService.embedItem` already swallows its
 * own errors; this guards the port contract too.
 */
export async function embedBestEffort(
  memory: Pick<HandoverMemoryPort, 'embed'>,
  botId: string,
  item: MemoryItem,
): Promise<void> {
  try {
    await memory.embed(botId, item);
  } catch {
    // Left for the vector rebuild path.
  }
}

/** The copy written into the target (new id; provenance instead of message evidence). */
export function handoverMemoryCopy(
  item: MemoryItem,
  provenance: { handoverId: string; fromBotId: string },
  originConversationId: string | null = null,
): NewMemoryItem {
  return {
    kind: item.kind,
    content: item.content,
    subject: item.subject,
    source: item.source,
    evidence: [
      {
        messageId: null,
        conversationId: null,
        runId: null,
        handoverId: provenance.handoverId,
        fromBotId: provenance.fromBotId,
        fromItemId: item.id,
      },
    ],
    origin: item.origin,
    originConversationId,
    confidence: item.confidence,
    sensitivity: item.sensitivity,
    privateToBot: false,
    dueAt: item.dueAt,
    validUntil: item.validUntil,
  };
}

export class MemoryAdapter implements HandoverAdapter {
  readonly type = 'memory' as const;
  readonly stage = 3;
  readonly #deps: MemoryAdapterDeps;

  constructor(deps: MemoryAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'memory') !== null;
  }

  #eligible(item: MemoryItem): boolean {
    return memoryRefusal(item, this.#deps.clock(), '') === null;
  }

  #entry(item: MemoryItem): HandoverEntry {
    const sensitive = item.sensitivity === 'sensitive';
    return {
      key: `memory:${item.id}`,
      type: 'memory',
      label: preview(item.content),
      detail: `${KIND_LABELS[item.kind]}${item.source === 'explicit' ? '，用户明确说过' : '，推断'}${
        sensitive ? '，敏感' : ''
      }`,
      actions: ['copy'],
      defaultAction: 'copy',
      external: true,
      marks: sensitive ? ['sensitive'] : [],
      defaultSelected: !sensitive,
    };
  }

  /** Candidates only for a query (`*` = the most recent); counts go to `summary`. */
  inventory(botId: string, query?: InventoryQuery): HandoverEntry[] {
    const text = query?.memoryQuery?.trim() ?? '';
    if (text.length === 0) return [];
    const limit = HANDOVER_MEMORY_QUERY_LIMIT;
    const items =
      text === '*'
        ? this.#deps.memory.activeItems(botId)
        : // Over-fetch: ineligible hits are dropped below.
          this.#deps.memory.search(botId, text, limit * 2);
    const excludeSensitive = query?.excludeSensitiveMemory === true;
    return items
      .filter((item) => this.#eligible(item))
      .filter((item) => !excludeSensitive || item.sensitivity !== 'sensitive')
      .slice(0, limit)
      .map((item) => this.#entry(item));
  }

  summary(botId: string): string | null {
    const items = this.#deps.memory.activeItems(botId).filter((item) => this.#eligible(item));
    if (items.length === 0) return '可复制的记忆：0 条';
    const byKind = new Map<MemoryKind, number>();
    for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    const sensitive = items.filter((item) => item.sensitivity === 'sensitive').length;
    const kinds = [...byKind.entries()].map(([kind, n]) => `${KIND_LABELS[kind]} ${n}`).join('、');
    return `可复制的记忆：${items.length} 条（${kinds}${sensitive > 0 ? `；其中敏感 ${sensitive} 条，卡上默认不勾` : ''}）。用 memory_query 检索候选条目（"*" 列最近的）。`;
  }

  refusal(fromBotId: string, key: string): string | null {
    const item = this.#deps.memory.get(fromBotId, keyId(key, 'memory') ?? '');
    if (item === null) return null;
    return memoryRefusal(item, this.#deps.clock(), '来源 Bot');
  }

  /** Any eligible item of the source is a valid key, listed by a query or not. */
  resolve(fromBotId: string, key: string): HandoverEntry | null {
    const item = this.#deps.memory.get(fromBotId, keyId(key, 'memory') ?? '');
    return item !== null && this.#eligible(item) ? this.#entry(item) : null;
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'copy') return '记忆只能复制';
    const item = this.#deps.memory.get(ctx.fromBot.id, keyId(key, 'memory') ?? '');
    if (item === null) return '这条记忆已被删除';
    const refused = memoryRefusal(item, this.#deps.clock(), ctx.fromBot.name);
    if (refused !== null) return refused;
    if (ctx.toBot !== null && this.#deps.memory.activeWithContent(ctx.toBot.id, item.content)) {
      return `${ctx.toName} 已经记着同样的内容`;
    }
    return null;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const itemId = keyId(key, 'memory') ?? '';
    const existing = this.#deps.memory.findCopy(ctx.toBot.id, ctx.handoverId, itemId);
    if (existing !== null) return { result: { itemId: existing.id } };
    const item = this.#deps.memory.get(ctx.fromBot.id, itemId);
    if (item === null) throw new Error('这条记忆已被删除');
    const copy = this.#deps.memory.insertCopy(
      ctx.toBot.id,
      handoverMemoryCopy(item, { handoverId: ctx.handoverId, fromBotId: ctx.fromBot.id }),
    );
    await embedBestEffort(this.#deps.memory, ctx.toBot.id, copy);
    return { result: { itemId: copy.id } };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string): boolean {
    return (
      this.#deps.memory.findCopy(ctx.toBot.id, ctx.handoverId, keyId(key, 'memory') ?? '') !== null
    );
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    return `复制给 ${toName}（${entry.detail}）`;
  }
}
