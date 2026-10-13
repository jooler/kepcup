import {
  AppError,
  SETTING_CARDS_PER_RUN_MAX,
  SETTING_CARD_DECLINE_MAX,
  SETTING_CARD_DECLINE_WINDOW_MS,
  SETTING_CARD_EVENT,
  SETTING_RECEIPT_UNDO_WINDOW_MS,
  SETTINGS_READ_MAX_BYTES,
  SETTINGS_READ_OPTIONS_MAX,
  SETTINGS_SEARCH_MAX_BYTES,
  checkProposedValues,
  closestSettingItemIds,
  effectiveMode,
  getSettingItem,
  groupOverview,
  sanitizeDisplayText,
  searchSettingItems,
  sensitiveFieldNames,
  type LoopType as SharedLoopType,
  type Message,
  type SettingCardContent,
  type SettingCardResolved,
  type SettingCardState,
  type SettingItem,
  type SettingModeContext,
  type SettingModeDecision,
  type SettingTarget,
  type SettingValues,
  type SettingsCardsUndoOutput,
  type SettingsItemsApplyOutput,
  type SetupRequirement,
  type TriggerReason,
} from '@kepcup/shared';
import type { RunIdentity, ToolResult } from '../agent/types.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { MessagesService } from '../domain/messages.js';
import { untrustedBlock } from '../infra/data-boundary.js';
import { TOOL_SETUP_REQUIRED } from '../tools/image-tools.js';
import type { SettingsToolFacade } from '../tools/settings-tools.js';
import {
  buildItemAdapters,
  type AdapterDeps,
  type ItemAdapter,
  type ItemSnapshot,
  type SettingTargetRef,
} from './adapters.js';
import { SETTING_MODE_WORDS, settingTitle, settingValueText, settingValuesText } from './render.js';
import type { SettingsWriteLock } from './write-lock.js';

/**
 * 对话内应用设置的宿主（todo/conversational-app-setup.md §4.1 适配器 / §5 三个工具 / §6 卡片）：
 *
 * - 工具门面（`forRun`）：按 run 绑定档位裁定的上下文（触发源、是否读过不可信内容、群聊、管家……）；
 * - 条目级 CAS 写入（`#writeItem`）：设置写锁内「读 → 只比对本条目字段 → 只改本条目字段 → 写回」，
 *   成功后广播 `settings.changed`；
 * - 卡片（system_event `setting_card`，写回方式同 D80 `schedule_offer`）：出卡、顶替、过期、
 *   防刷屏（每 run 上限、按条目的拒绝退避）、回执卡撤销；卡片不是审批，不进 approvals 表；
 * - 提议卡落定（应用 / 不用了 / 我已设置好）后写一次性内部事件 `setting_card_resolved`
 *   唤醒出卡 Bot 的对话轮（§6.2，已定：唤醒）；撤销回执卡不唤醒，只在上下文回放里留一行。
 */

/** pending 卡多久没人处理算过期（P0 取与拒绝窗口相同的 7 天）。 */
export const SETTING_CARD_PENDING_TTL_MS = SETTING_CARD_DECLINE_WINDOW_MS;

const REASON_MAX = 200;
const TEXT_MAX = 120;

export interface SettingsCatalogHostDeps extends AdapterDeps {
  /** main.db（messages 表上的卡片查询与状态写回）。 */
  db: SqliteDatabase;
  messages: MessagesService;
  clock: Clock;
  logger: CoreLogger;
  lock: SettingsWriteLock;
  /** 群聊 / 项目范围的对象（scope = group / project）。 */
  conversations: {
    get(id: string): { title: string | null; type: string; projectId: string | null } | null;
  };
  /** D73 污点（按（Bot, 对话）计）：与本 run 的「接触过不可信内容」取并集。 */
  taint?: { isTainted(botId: string, conversationId: string): boolean } | undefined;
  /**
   * 唤醒出卡 Bot 的对话轮（orchestrator.deliverEventToBot，晚绑定）：内部事件
   * `setting_card_resolved`，带结构化的 `settingResolved`。
   */
  wake?: (input: {
    botId: string;
    conversationId: string;
    text: string;
    resolved: SettingCardResolved;
  }) => void;
}

/** orchestrator 给一个 run 的裁定上下文（§5.3）。 */
export interface SettingsRunContext {
  identity: RunIdentity;
  triggerReason: TriggerReason | null;
  /** 触发批的发送者是用户本人（`triggerFromUser`，settings/context.ts）。 */
  triggerFromUser: boolean;
  isGroup: boolean;
  isButler: boolean;
  /** 本 run 已调用过读取不可信内容的工具（随 run 推进而变）。 */
  touchedUntrusted: () => boolean;
  /** 任务里 `required: true` 且需要用户处理：写进本 run 的 setupHit（失败续跑链）。 */
  onSetupRequired?: (requirement: SetupRequirement) => void;
}

interface CardRow {
  message: Message;
  card: SettingCardContent;
}

type WriteOutcome =
  | { status: 'applied'; before: SettingValues | null; after: SettingValues | null }
  | { status: 'conflict'; current: SettingValues | null };

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function clip(text: string, max = TEXT_MAX): string {
  return sanitizeDisplayText(text, max);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 逐行累积，超出字节上限就停并注明。 */
function withinBytes(lines: readonly string[], max: number, more: string): string {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = byteLength(line) + 1;
    if (size + cost > max - byteLength(more) - 1) {
      out.push(more);
      break;
    }
    out.push(line);
    size += cost;
  }
  return out.join('\n');
}

const MODE_ACTIONS: Readonly<Record<SettingModeDecision['mode'], string>> = {
  direct: '可直接修改',
  confirm: '出确认卡',
  form: '出待填卡',
  'user-only': '出卡由用户亲手设置',
  link: '出跳转卡',
  redirect: '改用专门工具',
  refused: '不能修改',
};

const STATUS_WORDS: Readonly<Record<ItemSnapshot['status'], string>> = {
  configured: '已配置',
  unconfigured: '未配置',
  partial: '部分可用',
  unknown: '状态未知',
  readonly: '只读',
};

export class SettingsCatalogHost {
  readonly #deps: SettingsCatalogHostDeps;
  readonly #adapterOf: (item: SettingItem) => ItemAdapter;

  constructor(deps: SettingsCatalogHostDeps) {
    this.#deps = deps;
    this.#adapterOf = buildItemAdapters(deps);
  }

  /**
   * 在设置写锁里执行（设置页的 `settings.update` 与条目适配器的写入串行，见 write-lock.ts）。
   * 锁内不要再调用本宿主的写入方法（不可重入）。
   */
  runLocked<T>(task: () => T | Promise<T>): Promise<T> {
    return this.#deps.lock.run(task);
  }

  /** 设置页原有保存路径补发事件用（rpc 包装）；空列表不发。 */
  publishChanged(itemIds: readonly string[]): void {
    const unique = [...new Set(itemIds)];
    if (unique.length > 0) this.#deps.publish('settings.changed', { itemIds: unique });
  }

  /** 条目当前状态（脱敏）。 */
  read(itemId: string, target: SettingTargetRef): ItemSnapshot | null {
    const item = getSettingItem(itemId);
    return item === null ? null : this.#adapterOf(item).read(item, target);
  }

  // --- 工具门面 -------------------------------------------------------------------

  forRun(ctx: SettingsRunContext): SettingsToolFacade {
    return {
      search: (query) => this.#search(ctx, query),
      read: (id, botId) => this.#readTool(ctx, id, botId),
      change: (input) => this.#change(ctx, input),
    };
  }

  #targetFor(
    item: SettingItem,
    ctx: SettingsRunContext,
    botId: string | undefined,
  ): SettingTargetRef {
    const conversationId = ctx.identity.conversationId;
    const conversation =
      conversationId !== null ? this.#deps.conversations.get(conversationId) : null;
    return {
      botId: item.scope === 'bot' ? (botId ?? ctx.identity.botId) : null,
      conversationId: item.scope === 'group' || item.scope === 'bot' ? conversationId : null,
      projectId: item.scope === 'project' ? (conversation?.projectId ?? null) : null,
    };
  }

  #decide(
    item: SettingItem,
    ctx: SettingsRunContext,
    target: SettingTargetRef,
    snapshot: ItemSnapshot,
    proposed: SettingValues | null,
  ): SettingModeDecision {
    const adapter = this.#adapterOf(item);
    const { botId, conversationId } = ctx.identity;
    const tainted =
      botId !== null && conversationId !== null
        ? (this.#deps.taint?.isTainted(botId, conversationId) ?? false)
        : false;
    const needsSensitiveInput =
      adapter.needsSensitiveInput !== undefined
        ? adapter.needsSensitiveInput(item, proposed ?? {}, snapshot)
        : sensitiveFieldNames(item).some((name) => snapshot.secrets[name] !== true);
    const modeCtx: SettingModeContext = {
      triggerReason: ctx.triggerReason,
      triggerFromUser: ctx.triggerFromUser,
      runTouchedUntrusted: ctx.touchedUntrusted(),
      tainted,
      isGroup: ctx.isGroup,
      targetsOtherBot: item.scope === 'bot' && target.botId !== null && target.botId !== botId,
      isButler: ctx.isButler,
      loopType: ctx.identity.loopType as SharedLoopType,
      needsSensitiveInput,
      ...(proposed !== null && adapter.valuesWiden !== undefined
        ? { valuesWiden: adapter.valuesWiden(item, snapshot.values, proposed) }
        : {}),
    };
    return effectiveMode(item, modeCtx);
  }

  #search(ctx: SettingsRunContext, query: string | undefined): string {
    if (query === undefined) {
      const lines = groupOverview().map((group) => {
        const parts: Record<string, string[]> = {};
        for (const itemId of group.itemIds) {
          const item = getSettingItem(itemId)!;
          if (item.write.via !== 'catalog' && !item.readOnly) continue;
          const status = this.#adapterOf(item).read(
            item,
            this.#targetFor(item, ctx, undefined),
          ).status;
          (parts[status] ??= []).push(item.title);
        }
        const summary = (['configured', 'partial', 'unconfigured', 'unknown', 'readonly'] as const)
          .filter((status) => (parts[status]?.length ?? 0) > 0)
          .map((status) => `${STATUS_WORDS[status]}：${parts[status]!.join('、')}`)
          .join('；');
        return `- ${group.title}：${clip(summary.length > 0 ? summary : '由专门工具管理', 150)}`;
      });
      return withinBytes(
        ['各类设置的就绪概况（用 settings_search 加关键词查具体项）：', ...lines],
        SETTINGS_SEARCH_MAX_BYTES,
        '（其余略）',
      );
    }
    const hits = searchSettingItems(query);
    if (hits.length === 0) {
      return `没有找到与「${clip(query, 40)}」相关的设置项。换个说法再查，或不带 query 看概览。`;
    }
    const lines = hits.map((item) => {
      const target = this.#targetFor(item, ctx, undefined);
      const snapshot = this.#adapterOf(item).read(item, target);
      const decision = this.#decide(item, ctx, target, snapshot, null);
      const action =
        decision.mode === 'redirect' && decision.tool !== null
          ? `改用 ${decision.tool}`
          : MODE_ACTIONS[decision.mode];
      return `- ${item.id}｜${item.title}｜${item.summary}｜${STATUS_WORDS[snapshot.status]}｜本次：${action}`;
    });
    return withinBytes(
      [
        `与「${clip(query, 40)}」相关的设置项（id｜标题｜作用｜当前状态｜本次可用的修改方式）：`,
        ...lines,
      ],
      SETTINGS_SEARCH_MAX_BYTES,
      '（其余略）',
    );
  }

  #readTool(ctx: SettingsRunContext, id: string, botId: string | undefined): ToolResult {
    const item = getSettingItem(id);
    if (item === null) {
      return {
        ok: false,
        content: `没有设置项「${clip(id, 60)}」。最接近的：${closestSettingItemIds(id).join('、')}`,
        errorCode: 'NOT_FOUND',
      };
    }
    const target = this.#targetFor(item, ctx, botId);
    const adapter = this.#adapterOf(item);
    const snapshot = adapter.read(item, target);
    const decision = this.#decide(item, ctx, target, snapshot, null);
    const head = [
      `设置项 ${item.id}「${item.title}」：${item.summary}`,
      `当前状态：${STATUS_WORDS[snapshot.status]}`,
    ];
    if (item.write.via !== 'catalog') {
      head.push(
        `修改方式：这一项由 ${item.write.via.tool} 工具负责，请改用它（settings_change 不代为调用）。`,
      );
      return { ok: true, content: [...head, untrustedBlock(snapshot.summary)].join('\n') };
    }
    const fieldLines = item.fields.map((field) => {
      const parts = [
        `- ${field.name}（${field.label}，${field.type}${field.multiple === true ? '，多选' : ''}${field.sensitive ? '，敏感：只能由用户在卡片里填' : ''}）`,
      ];
      if (field.sensitive) {
        const configured = snapshot.secrets[field.name];
        parts.push(configured === undefined ? '' : configured ? '：已配置' : '：未配置');
      } else if (snapshot.values !== null && field.name in snapshot.values) {
        parts.push(`：当前 ${clip(settingValueText(snapshot.values[field.name]), 100)}`);
      }
      const options = (
        field.options === 'static'
          ? (field.staticOptions ?? [])
          : (adapter.options?.(field, item, target) ?? [])
      ).slice(0, SETTINGS_READ_OPTIONS_MAX);
      if (options.length > 0) {
        parts.push(
          `；可选：${options.map((option) => (option.value === option.label ? option.value : `${option.value}（${clip(option.label, 40)}）`)).join('、')}`,
        );
      }
      return parts.join('');
    });
    const modeLine =
      decision.mode === 'refused'
        ? `本次修改方式：不能修改——${decision.reason ?? ''}`
        : `本次修改方式：${MODE_ACTIONS[decision.mode]}${decision.reason !== null ? `（${decision.reason}）` : ''}${decision.acceptValues ? '' : '；你给的 values 不会被采用'}`;
    const body = untrustedBlock(
      withinBytes(
        [`概况：${snapshot.summary}`, ...(fieldLines.length > 0 ? ['字段：', ...fieldLines] : [])],
        SETTINGS_READ_MAX_BYTES - 600,
        '（字段过多，其余略）',
      ),
    );
    return { ok: true, content: [...head, body, modeLine].join('\n') };
  }

  async #change(
    ctx: SettingsRunContext,
    input: {
      id: string;
      values?: Record<string, unknown> | undefined;
      reason: string;
      required?: boolean | undefined;
      botId?: string | undefined;
    },
  ): Promise<ToolResult> {
    const reject = (content: string, errorCode = 'INVALID_INPUT'): ToolResult => ({
      ok: false,
      content,
      errorCode,
    });
    const { identity } = ctx;
    if (identity.botId === null || identity.conversationId === null) {
      return reject('当前执行没有对话上下文，不能修改设置');
    }
    const item = getSettingItem(input.id);
    if (item === null) {
      return reject(
        `没有设置项「${clip(input.id, 60)}」。最接近的：${closestSettingItemIds(input.id).join('、')}`,
        'NOT_FOUND',
      );
    }
    if (item.write.via !== 'catalog') {
      return reject(`这一项请改用 ${item.write.via.tool} 工具（settings_change 不代为调用）。`);
    }
    const raw = input.values ?? {};
    const checked = checkProposedValues(item, raw);
    if (checked.sensitive.length > 0) {
      return reject(
        `values 里不能带敏感字段（${checked.sensitive.join('、')}）：密钥、密码、登录只能由用户在卡片里填。去掉它们再调用，不要向用户索要。`,
      );
    }
    if (checked.unknown.length > 0) {
      return reject(
        `「${item.title}」没有字段 ${checked.unknown.join('、')}；可用字段：${
          item.fields
            .filter((field) => !field.sensitive)
            .map((field) => field.name)
            .join('、') || '（无）'
        }`,
      );
    }
    const reason = clip(input.reason, REASON_MAX);
    if (reason.length === 0) return reject('reason 不能为空：用一句话说明为什么要改');

    const target = this.#targetFor(item, ctx, input.botId);
    const adapter = this.#adapterOf(item);
    const snapshot = adapter.read(item, target);
    let values: SettingValues | null = Object.keys(raw).length > 0 ? { ...raw } : null;
    if (values !== null && adapter.normalize !== undefined) {
      const normalized = adapter.normalize(item, values, target);
      if (!normalized.ok) return reject(normalized.message);
      values = normalized.values;
    }
    const decision = this.#decide(item, ctx, target, snapshot, values);
    if (decision.mode === 'refused')
      return reject(`不能修改「${item.title}」：${decision.reason ?? ''}`);
    if (decision.mode === 'redirect') {
      return reject(`这一项请改用 ${decision.tool ?? '专门'} 工具（settings_change 不代为调用）。`);
    }

    // 已经是想要的状态：不出卡。
    const unchanged =
      values !== null &&
      snapshot.values !== null &&
      Object.entries(values).every(([key, value]) => jsonEqual(snapshot.values![key], value));
    if (unchanged && snapshot.status === 'configured') {
      return { ok: true, content: `「${item.title}」当前已经是这个值，无需修改。` };
    }
    const isTask = identity.loopType === 'task';
    if (values === null && input.required === true && isTask && snapshot.status === 'configured') {
      return {
        ok: true,
        content: `「${item.title}」已经配置好了（${snapshot.summary}），可以继续。`,
      };
    }

    // 任务里缺了就做不下去：走失败续跑链（不出消息流里的卡）。
    if (
      decision.mode !== 'direct' &&
      input.required === true &&
      isTask &&
      ctx.onSetupRequired !== undefined
    ) {
      ctx.onSetupRequired({
        kind: 'setting',
        itemId: item.id,
        ...(decision.acceptValues && values !== null ? { prefill: values } : {}),
        reason,
      });
      return {
        ok: false,
        content: `已请用户完成「${item.title}」的设置：本次任务暂停，用户在对话里的设置卡完成后会自动继续。`,
        errorCode: TOOL_SETUP_REQUIRED,
      };
    }

    const conversationId = identity.conversationId;
    if (this.#countRunCards(identity.runId) >= SETTING_CARDS_PER_RUN_MAX) {
      return reject(
        `本轮已经出了 ${SETTING_CARDS_PER_RUN_MAX} 张设置卡，不能再出。先等用户处理已有的卡，或在回复里说明还需要改什么。`,
        'LIMIT_REACHED',
      );
    }

    if (decision.mode === 'direct') {
      if (values === null) return reject('直接修改需要给出 values（要改成的值）');
      let outcome: WriteOutcome;
      try {
        outcome = await this.#writeItem(item, target, values, {}, snapshot.values);
      } catch (error) {
        return reject(`修改失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (outcome.status === 'conflict') {
        return reject(
          `「${item.title}」刚在别处被修改过，没有覆盖。用 settings_read 看最新状态后再决定。`,
          'CONFLICT',
        );
      }
      this.#expireStale(conversationId);
      this.#supersedePending(conversationId, item.id, target, null);
      const now = this.#deps.clock.now();
      const card: SettingCardContent = {
        botId: identity.botId,
        runId: identity.runId,
        itemId: item.id,
        mode: 'direct',
        target: this.#cardTarget(target),
        proposed: values,
        before: outcome.before,
        beforeText: this.#valuesLabel(item, outcome.before, target),
        proposedText: this.#valuesLabel(item, outcome.after, target),
        reason,
        state: 'applied',
        ...(outcome.after !== null ? { applied: outcome.after } : {}),
        undoUntil: now + SETTING_RECEIPT_UNDO_WINDOW_MS,
        decidedAt: now,
      };
      const message = this.#appendCard(conversationId, identity.runId, card);
      return {
        ok: true,
        content: `已把「${item.title}」从 ${card.beforeText} 改为 ${card.proposedText}（回执卡 ${message.id}，用户 24 小时内可在卡上撤销）。回复里一句话告诉用户即可。`,
      };
    }

    // 出卡（confirm / form / user-only / link）。
    const declined = this.#recentDeclines(identity.botId, conversationId, item.id);
    if (declined >= SETTING_CARD_DECLINE_MAX) {
      return reject(
        `用户最近 7 天已在本对话拒绝 ${declined} 次「${item.title}」的设置卡，不能再出。不要再提这一项；用户之后想改可以自己去设置页。`,
        'LIMIT_REACHED',
      );
    }
    this.#expireStale(conversationId);
    this.#supersedePending(conversationId, item.id, target, null);
    const proposed = decision.acceptValues ? values : null;
    const mode = decision.mode;
    const card: SettingCardContent = {
      botId: identity.botId,
      runId: identity.runId,
      itemId: item.id,
      mode,
      target: this.#cardTarget(target),
      proposed,
      before: snapshot.values,
      beforeText: snapshot.summary,
      ...(proposed !== null
        ? {
            proposedText: this.#valuesLabel(
              item,
              { ...(snapshot.values ?? {}), ...proposed },
              target,
            ),
          }
        : {}),
      reason,
      ...(decision.reason !== null ? { modeReason: decision.reason } : {}),
      state: 'pending',
    };
    const message = this.#appendCard(conversationId, identity.runId, card);
    const ignored = values !== null && proposed === null;
    const lead =
      mode === 'user-only'
        ? `这一项由用户亲手设置，已出空白卡（${message.id}）${ignored ? '，你给的 values 没有采用' : ''}`
        : mode === 'link'
          ? `这一项暂时不能在对话里直接设置，已出跳转卡（${message.id}），用户会在设置页完成${ignored ? '；你给的 values 没有采用' : ''}`
          : `已在对话里出设置卡（${message.id}，${SETTING_MODE_WORDS[mode]}${decision.reason !== null ? `：${decision.reason}` : ''}）`;
    return {
      ok: true,
      content: `${lead}。不要再用文字重复问；用户处理后你会收到通知，届时接着做原来的事${isTask ? '（这张卡不阻塞本任务，先继续做能做的部分）' : ''}。`,
    };
  }

  // --- 条目级 CAS 写入 ---------------------------------------------------------------

  /**
   * 写锁内：读当前值 → `expected` 非 null 时只比对本条目的非敏感字段 → 与当前值合并 → 写 → 再读。
   * 成功后广播 `settings.changed`。没有写入实现的条目抛 INVALID_INPUT。
   */
  async #writeItem(
    item: SettingItem,
    target: SettingTargetRef,
    values: SettingValues,
    secrets: Readonly<Record<string, string>>,
    expected: SettingValues | null,
  ): Promise<WriteOutcome> {
    const adapter = this.#adapterOf(item);
    const write = adapter.write;
    if (write === undefined) {
      throw new AppError('INVALID_INPUT', `「${item.title}」暂不支持在对话里保存，请在设置页修改`);
    }
    const outcome = await this.#deps.lock.run((): WriteOutcome => {
      const current = adapter.read(item, target);
      if (expected !== null) {
        const sensitive = new Set(sensitiveFieldNames(item));
        const mismatch = Object.entries(expected).some(
          ([key, value]) => !sensitive.has(key) && !jsonEqual(current.values?.[key], value),
        );
        if (mismatch) return { status: 'conflict', current: current.values };
      }
      write(item, { next: { ...(current.values ?? {}), ...values }, secrets }, target);
      return {
        status: 'applied',
        before: current.values,
        after: adapter.read(item, target).values,
      };
    });
    if (outcome.status === 'applied') this.publishChanged([item.id]);
    return outcome;
  }

  /**
   * `settings.items.apply`（§4.1）：卡片 / 设置页按目录条目保存。`values` 可含敏感字段（用户
   * 亲手填的 Key），按适配器分发到 secrets，永不回显。带 `messageId` 时成功后卡片标 applied 并
   * 唤醒出卡 Bot 一次（§6.2）。
   */
  async applyItem(input: {
    itemId: string;
    values: SettingValues;
    expected: SettingValues | null;
    target?: SettingTarget | undefined;
    messageId?: string | undefined;
  }): Promise<SettingsItemsApplyOutput> {
    const item = getSettingItem(input.itemId);
    if (item === null) throw new AppError('NOT_FOUND', `没有设置项「${input.itemId}」`);
    if (item.write.via !== 'catalog') {
      throw new AppError(
        'INVALID_INPUT',
        `「${item.title}」由 ${item.write.via.tool} 负责，不经设置目录保存`,
      );
    }
    if (item.readOnly) throw new AppError('INVALID_INPUT', `「${item.title}」是只读项`);
    const row = input.messageId !== undefined ? this.#pendingCard(input.messageId) : null;
    if (row !== null && row.card.itemId !== item.id) {
      throw new AppError('INVALID_INPUT', '设置卡与设置项不一致');
    }
    const target = this.#resolveTarget(
      item,
      input.target ?? row?.card.target ?? {},
      row?.message.conversationId ?? null,
    );
    const known = new Map(item.fields.map((field) => [field.name, field]));
    const plain: SettingValues = {};
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.values)) {
      const field = known.get(key);
      if (field === undefined)
        throw new AppError('INVALID_INPUT', `「${item.title}」没有字段 ${key}`);
      if (field.sensitive) {
        if (typeof value === 'string' && value.length > 0) secrets[key] = value;
      } else {
        plain[key] = value;
      }
    }

    let before: SettingValues | null;
    let after: SettingValues;
    if (item.owner === 'renderer') {
      // core 写不了渲染层条目：渲染层自己保存，这里只结卡。
      before = null;
      after = plain;
      this.publishChanged([item.id]);
    } else {
      const adapter = this.#adapterOf(item);
      let values = plain;
      if (Object.keys(values).length > 0 && adapter.normalize !== undefined) {
        const normalized = adapter.normalize(item, values, target);
        if (!normalized.ok) throw new AppError('INVALID_INPUT', normalized.message);
        values = normalized.values;
      }
      const outcome = await this.#writeItem(item, target, values, secrets, input.expected);
      if (outcome.status === 'conflict') {
        return { status: 'conflict', itemId: item.id, current: outcome.current };
      }
      before = outcome.before;
      after = outcome.after ?? values;
    }
    if (row !== null) {
      // 写入期间卡片可能已被别处结掉（顶替 / 过期）：只结仍在 pending 的。
      const latest = this.#cardRow(row.message.id);
      if (latest !== null && latest.card.state === 'pending') {
        this.#resolveCard(latest, 'applied', {
          applied: after,
          before: before ?? latest.card.before,
        });
      }
    }
    return { status: 'applied', itemId: item.id, before, values: after };
  }

  /** 「不用了」（§6.2）：卡片标 dismissed、唤醒 Bot 一次；已落定的卡原样返回其状态。 */
  dismissCard(messageId: string): { state: SettingCardState } {
    const row = this.#cardOrThrow(messageId);
    const current = this.#expireIfStale(row);
    if (current.card.state !== 'pending') return { state: current.card.state };
    this.#resolveCard(current, 'dismissed');
    return { state: 'dismissed' };
  }

  /**
   * 「我已设置好」（link 卡 / 渲染层条目，§6.1）：能核对的用适配器核对一次。核对不通过 → 卡片保持
   * pending（verified false）；无法核对（渲染层 / 只读）→ 按用户所说标 applied（verified null）。
   */
  completeCard(messageId: string): { state: SettingCardState; verified: boolean | null } {
    const row = this.#cardOrThrow(messageId);
    const current = this.#expireIfStale(row);
    if (current.card.state !== 'pending') return { state: current.card.state, verified: null };
    const item = getSettingItem(current.card.itemId);
    if (item === null || item.owner === 'renderer' || item.readOnly) {
      this.#resolveCard(current, 'applied');
      return { state: 'applied', verified: null };
    }
    const target = this.#resolveTarget(item, current.card.target, current.message.conversationId);
    const snapshot = this.#adapterOf(item).read(item, target);
    if (snapshot.status === 'unknown' || snapshot.status === 'readonly') {
      this.#resolveCard(current, 'applied');
      return { state: 'applied', verified: null };
    }
    const { proposed, before } = current.card;
    const verified =
      proposed !== null
        ? Object.entries(proposed).every(([key, value]) => jsonEqual(snapshot.values?.[key], value))
        : snapshot.status === 'configured' ||
          (before !== null && snapshot.values !== null && !jsonEqual(before, snapshot.values));
    if (!verified) return { state: 'pending', verified: false };
    this.#resolveCard(
      current,
      'applied',
      snapshot.values !== null ? { applied: snapshot.values } : {},
    );
    return { state: 'applied', verified: true };
  }

  /**
   * 回执卡「撤销」（§5.3）：用卡上的旧值经同一套 CAS 写回——当前值已不是回执上的新值 → conflict、
   * 不覆盖。成功后卡片标 reverted，不唤醒 Bot（上下文回放里留一行）。
   */
  async undoCard(messageId: string): Promise<SettingsCardsUndoOutput> {
    const row = this.#cardOrThrow(messageId);
    const { card } = row;
    if (card.mode !== 'direct') throw new AppError('INVALID_INPUT', '只有回执卡可以撤销');
    if (card.state !== 'applied') throw new AppError('INVALID_INPUT', '这张回执卡已经处理过了');
    if (card.undoUntil === undefined || this.#deps.clock.now() > card.undoUntil) {
      throw new AppError('INVALID_INPUT', '撤销已过期');
    }
    if (card.before === null || card.applied === undefined) {
      throw new AppError('INVALID_INPUT', '这张回执卡没有可恢复的旧值');
    }
    const item = getSettingItem(card.itemId);
    if (item === null) throw new AppError('NOT_FOUND', `没有设置项「${card.itemId}」`);
    const target = this.#resolveTarget(item, card.target, row.message.conversationId);
    const outcome = await this.#writeItem(item, target, card.before, {}, card.applied);
    if (outcome.status === 'conflict') return { status: 'conflict', current: outcome.current };
    const latest = this.#cardRow(messageId) ?? row;
    this.#writeCard(latest.message, {
      ...latest.card,
      state: 'reverted',
      decidedAt: this.#deps.clock.now(),
    });
    return { status: 'reverted', values: outcome.after ?? card.before };
  }

  // --- 卡片持久化 -------------------------------------------------------------------

  #cardTarget(target: SettingTargetRef): SettingTarget {
    return {
      ...(target.botId !== null ? { botId: target.botId } : {}),
      ...(target.conversationId !== null ? { conversationId: target.conversationId } : {}),
      ...(target.projectId !== null ? { projectId: target.projectId } : {}),
    };
  }

  #resolveTarget(
    item: SettingItem,
    target: SettingTarget,
    conversationId: string | null,
  ): SettingTargetRef {
    const conversation =
      (target.conversationId ?? conversationId) !== null
        ? this.#deps.conversations.get((target.conversationId ?? conversationId)!)
        : null;
    if (item.scope === 'bot' && target.botId === undefined) {
      throw new AppError('INVALID_INPUT', `「${item.title}」需要指定 Bot（target.botId）`);
    }
    return {
      botId: target.botId ?? null,
      conversationId: target.conversationId ?? conversationId,
      projectId: target.projectId ?? conversation?.projectId ?? null,
    };
  }

  #valuesLabel(item: SettingItem, values: SettingValues | null, target: SettingTargetRef): string {
    if (values === null) return '（未知）';
    // 模型类字段用适配器的人话（「厂商 · 模型」）；其余按字段名拼。
    const model = typeof values.model === 'string' ? values.model : null;
    if (
      model !== null &&
      item.fields.some((field) => field.name === 'model' && field.type === 'model')
    ) {
      const label = this.#adapterOf(item)
        .options?.(
          item.fields.find((field) => field.name === 'model')!,
          item,
          target,
        )
        .find((option) => option.value === model)?.label;
      if (model.length === 0) return item.id.startsWith('bot.') ? '跟随默认' : '（空）';
      return clip(label ?? model, 80);
    }
    return settingValuesText(item.id, values);
  }

  #cardText(card: SettingCardContent): string {
    const title = settingTitle(card.itemId);
    if (card.mode === 'direct') {
      return card.state === 'reverted'
        ? `已撤销「${title}」的修改`
        : `已把「${title}」改为 ${card.proposedText ?? ''}`;
    }
    const words: Record<SettingCardState, string> = {
      pending: '等用户处理',
      applied: '已应用',
      dismissed: '用户没有修改',
      superseded: '已被新的设置卡取代',
      expired: '已过期',
      reverted: '已撤销',
    };
    return `设置卡「${title}」：${words[card.state]}`;
  }

  #appendCard(conversationId: string, runId: string, card: SettingCardContent): Message {
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'system_event',
      event: SETTING_CARD_EVENT,
      text: this.#cardText(card),
      setting: card,
      runId,
    });
    this.#deps.publish('message.created', { conversationId, message });
    return message;
  }

  #writeCard(message: Message, card: SettingCardContent): void {
    this.#deps.db
      .prepare(
        `update messages set content_json = json_set(content_json, '$.setting', json(?), '$.text', ?) where id = ?`,
      )
      .run(JSON.stringify(card), this.#cardText(card), message.id);
    const updated = this.#deps.messages.getById(message.id);
    if (updated !== null) {
      this.#deps.publish('message.updated', {
        conversationId: updated.conversationId,
        message: updated,
      });
    }
  }

  #cardRow(messageId: string): CardRow | null {
    const message = this.#deps.messages.getById(messageId);
    const content = message?.content as
      { event?: string; setting?: SettingCardContent } | undefined;
    if (
      message === null ||
      content?.event !== SETTING_CARD_EVENT ||
      content.setting === undefined
    ) {
      return null;
    }
    return { message, card: content.setting };
  }

  #cardOrThrow(messageId: string): CardRow {
    const row = this.#cardRow(messageId);
    if (row === null) throw new AppError('INVALID_INPUT', '不是设置卡');
    return row;
  }

  #pendingCard(messageId: string): CardRow {
    const row = this.#expireIfStale(this.#cardOrThrow(messageId));
    if (row.card.state !== 'pending') {
      throw new AppError('INVALID_INPUT', `这张设置卡已经处理过了（${row.card.state}）`);
    }
    return row;
  }

  #expireIfStale(row: CardRow): CardRow {
    if (row.card.state !== 'pending' || row.card.mode === 'direct') return row;
    if (this.#deps.clock.now() - row.message.createdAt <= SETTING_CARD_PENDING_TTL_MS) return row;
    const card: SettingCardContent = {
      ...row.card,
      state: 'expired',
      decidedAt: this.#deps.clock.now(),
    };
    this.#writeCard(row.message, card);
    return { message: row.message, card };
  }

  /** 卡片落定（applied / dismissed）：写回状态并唤醒出卡 Bot 一次。 */
  #resolveCard(
    row: CardRow,
    state: 'applied' | 'dismissed',
    extra: { applied?: SettingValues; before?: SettingValues | null } = {},
  ): void {
    const card: SettingCardContent = {
      ...row.card,
      state,
      ...(extra.before !== undefined ? { before: extra.before } : {}),
      ...(extra.applied !== undefined ? { applied: extra.applied } : {}),
      decidedAt: this.#deps.clock.now(),
    };
    this.#writeCard(row.message, card);
    const title = settingTitle(card.itemId);
    const text =
      state === 'applied'
        ? `设置卡结果（宿主系统注入，不是用户消息）：用户已应用「${title}」。接着处理用户原来的请求；不要再为这一项出卡。`
        : `设置卡结果（宿主系统注入，不是用户消息）：用户没有修改「${title}」（点了「不用了」）。不要再为这一项出卡，按用户原来的请求给替代做法或询问下一步。`;
    try {
      this.#deps.wake?.({
        botId: card.botId,
        conversationId: row.message.conversationId,
        text,
        resolved: {
          cardMessageId: row.message.id,
          itemId: card.itemId,
          outcome: state,
          before: card.before,
          after: state === 'applied' ? (card.applied ?? card.proposed) : null,
        },
      });
    } catch (error) {
      this.#deps.logger.warn(
        {
          messageId: row.message.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'setting card wake failed',
      );
    }
  }

  #countRunCards(runId: string): number {
    const row = this.#deps.db
      .prepare(
        `select count(*) as n from messages
         where run_id = ? and kind = 'system_event' and json_extract(content_json, '$.event') = ?`,
      )
      .get(runId, SETTING_CARD_EVENT) as { n: number };
    return row.n;
  }

  /** 同一 Bot 在同一对话里对同一项窗口内被拒的次数（§6.1，参照 D80 按条目计）。 */
  #recentDeclines(botId: string, conversationId: string, itemId: string): number {
    const since = this.#deps.clock.now() - SETTING_CARD_DECLINE_WINDOW_MS;
    const row = this.#deps.db
      .prepare(
        `select count(*) as n from messages
         where conversation_id = ? and kind = 'system_event'
           and json_extract(content_json, '$.event') = ?
           and json_extract(content_json, '$.setting.botId') = ?
           and json_extract(content_json, '$.setting.itemId') = ?
           and json_extract(content_json, '$.setting.state') = 'dismissed'
           and coalesce(json_extract(content_json, '$.setting.decidedAt'), created_at) >= ?`,
      )
      .get(conversationId, SETTING_CARD_EVENT, botId, itemId, since) as { n: number };
    return row.n;
  }

  #pendingIds(conversationId: string, itemId: string | null): string[] {
    const rows = this.#deps.db
      .prepare(
        `select id from messages
         where conversation_id = ? and kind = 'system_event'
           and json_extract(content_json, '$.event') = ?
           and json_extract(content_json, '$.setting.state') = 'pending'
           and (? is null or json_extract(content_json, '$.setting.itemId') = ?)`,
      )
      .all(conversationId, SETTING_CARD_EVENT, itemId, itemId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** 同一对话里同一项（同一作用对象）只保留最新一张 pending 卡：旧卡标 superseded。 */
  #supersedePending(
    conversationId: string,
    itemId: string,
    target: SettingTargetRef,
    keepId: string | null,
  ): void {
    const wanted = this.#cardTarget(target);
    for (const id of this.#pendingIds(conversationId, itemId)) {
      if (id === keepId) continue;
      const row = this.#cardRow(id);
      if (row === null || !jsonEqual(row.card.target ?? {}, wanted)) continue;
      this.#writeCard(row.message, {
        ...row.card,
        state: 'superseded',
        decidedAt: this.#deps.clock.now(),
      });
    }
  }

  /** 本对话里放太久的 pending 卡标 expired（出新卡时顺手清）。 */
  #expireStale(conversationId: string): void {
    for (const id of this.#pendingIds(conversationId, null)) {
      const row = this.#cardRow(id);
      if (row !== null) this.#expireIfStale(row);
    }
  }
}
