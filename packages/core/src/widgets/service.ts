import { createHash } from 'node:crypto';
import {
  AppError,
  BOT_WIDGET_CARDS_PER_RUN_MAX,
  BOT_WIDGET_CARD_TYPE,
  BOT_WIDGET_DESCRIPTION_MAX_CHARS,
  BOT_WIDGET_HTML_MAX_BYTES,
  BOT_WIDGET_STORAGE_KEYS_MAX,
  BOT_WIDGET_STORAGE_QUOTA_BYTES,
  BOT_WIDGET_STORAGE_VALUE_MAX_BYTES,
  BOT_WIDGET_TITLE_MAX_CHARS,
  MCP_APP_SCHEME,
  buildAppCspHeader,
  newId,
  widgetCardSchema,
  type Message,
  type WidgetCard,
  type WidgetScope,
  type WidgetsUiOpenOutput,
  type WidgetsUiSourceOutput,
  type WidgetsUiStorageInput,
  type WidgetsUiStorageOutput,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import { WidgetResourceStore } from './resource-store.js';
import { injectWidgetSdk } from './sdk-injection.js';

/**
 * Bot 自制交互组件（D81，docs/design/32-bot-widgets.md）。
 *
 * - {@link WidgetService.create} / {@link WidgetService.update}：任务工具
 *   `widget_create` / `widget_update` 的落库侧——版本只增不改，每次落版本都在
 *   对话里发一张 `bot_widget` 卡片（描述符，不含 HTML；每 run 有上限防刷屏）。
 * - {@link WidgetService.source}：审查态「查看源码」（不登记资源、不挂 iframe）。
 * - {@link WidgetService.open} / {@link WidgetService.close}：卡片挂载 / 卸载，
 *   把该卡版本的 HTML 登记成内存资源（前置 SDK 垫片，见 sdk-injection.ts），返回
 *   `kepcup-app://widget-{hash}/{id}`。
 * - {@link WidgetService.resource}：平台方法 `widgets.ui.resource` 的实现——主进程
 *   协议处理器按 host 前缀 `widget-` 分流到这里取 HTML 与响应头 CSP（固定禁网）。
 * - {@link WidgetService.storage} / {@link WidgetService.openLink}：能力桥（P1，
 *   设计 32 §6）——渲染端桥把 widget 的调用转发为 `widgets.ui.storage` /
 *   `widgets.ui.openLink`，这里以 resourceId 反查登记资源定命名空间，KV 落
 *   `widget_docs`（命名空间 = widgetId），外链 https-only 经主进程打开。
 *
 * HTML 永不进模型上下文（卡片在 `renderCard` 里只渲染一行固定文案，见
 * orchestrator），也永不发给除 `kepcup-app://` 协议处理器与「查看源码」以外的消费者。
 */

interface WidgetRow {
  id: string;
  bot_id: string;
  conversation_id: string | null;
  scope: WidgetScope;
  title: string;
  description: string;
  latest_version: number;
  created_at: number;
  updated_at: number;
}

interface WidgetVersionRow {
  widget_id: string;
  version: number;
  html: string;
  sha256: string;
  created_by_run: string;
  created_at: number;
}

/** widget 的固定响应头 CSP：没有任何网络与资源域（禁网）。 */
const WIDGET_CSP = buildAppCspHeader({ connectDomains: [], resourceDomains: [] });

export interface WidgetServiceDeps {
  db: SqliteDatabase;
  messages: {
    append(input: {
      conversationId: string;
      senderType: 'system';
      kind: 'card';
      cardType: string;
      cardWidget: WidgetCard;
      runId?: string | null;
    }): Message;
    getById(id: string): Message | null;
  };
  publishMessage(message: Message): void;
  secrets: { redact(text: string): string };
  /** 能力桥外链（P1）：主进程 `shell.openExternal`（白名单再核一次）。 */
  shell: { openExternal(input: { url: string }): Promise<{ ok: boolean }> };
  clock: Clock;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
}

export interface WidgetCreateInput {
  botId: string;
  conversationId: string;
  title: string;
  description: string;
  html: string;
  scope: WidgetScope;
  runId: string;
}

export interface WidgetUpdateInput {
  botId: string;
  widgetId: string;
  html: string;
  changeNote: string;
  runId: string;
}

export type WidgetWriteResult =
  | {
      ok: true;
      widgetId: string;
      version: number;
      message: string;
      /** 发出的卡片消息 id；缺省 = 落库成功但发卡失败（组件此刻在界面上不可见）。 */
      cardMessageId?: string;
    }
  | { ok: false; message: string; code?: 'NOT_FOUND' | 'FORBIDDEN' };

export class WidgetService {
  readonly store: WidgetResourceStore;
  readonly #deps: WidgetServiceDeps;
  readonly #cardsByRun = new Map<string, number>();

  constructor(deps: WidgetServiceDeps, store?: WidgetResourceStore) {
    this.#deps = deps;
    this.store = store ?? new WidgetResourceStore({ clock: deps.clock });
  }

  // --- 工具落库（widget_create / widget_update） --------------------------------

  create(input: WidgetCreateInput): WidgetWriteResult {
    try {
      const title = this.#cleanText(input.title, BOT_WIDGET_TITLE_MAX_CHARS, '标题');
      const description = this.#redactText(input.description, '说明');
      const html = this.#cleanHtml(input.html);
      const now = this.#deps.clock.now();
      const widgetId = newId('wgt');
      const sha256 = createHash('sha256').update(html).digest('hex');
      // 发卡名额在事务前扣减且不回滚：多扣只损失本 run 的剩余卡数（安全方向），
      // 换取不把发卡计数嵌进存储事务。
      const run = this.#acquireRunSlot(input.runId);
      if (!run.ok) return run;
      const tx = this.#deps.db.transaction(() => {
        this.#deps.db
          .prepare(
            'insert into widgets (id, bot_id, conversation_id, scope, title, description, latest_version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
          )
          .run(
            widgetId,
            input.botId,
            input.scope === 'conversation' ? input.conversationId : null,
            input.scope,
            title,
            description,
            now,
            now,
          );
        this.#insertVersion(widgetId, 1, html, sha256, input.runId, now);
      });
      tx();
      const card = this.#emitCard({
        widgetId,
        version: 1,
        title,
        description,
        scope: input.scope,
        sha256,
        sizeBytes: Buffer.byteLength(html),
        botId: input.botId,
        createdAt: now,
        conversationId: input.conversationId,
        runId: input.runId,
      });
      return {
        ok: true,
        widgetId,
        version: 1,
        message: `组件「${title}」（v1）已作为卡片发进对话，等用户确认加载。不要用文字复述代码；之后要改动用它的新版本时调 widget_update（返回里带 widgetId）。`,
        ...(card !== null ? { cardMessageId: card.id } : {}),
      };
    } catch (error) {
      return { ok: false, message: `组件未能创建：${errorMessage(error)}` };
    }
  }

  update(input: WidgetUpdateInput): WidgetWriteResult {
    try {
      const widgetId = input.widgetId.trim();
      if (widgetId === '') {
        return { ok: false, message: '需要提供 widgetId（widget_create 返回的）' };
      }
      const widget = this.#widgetOf(widgetId);
      if (widget === null) {
        return { ok: false, message: '找不到这个组件（widgetId 不存在）', code: 'NOT_FOUND' };
      }
      if (widget.bot_id !== input.botId) {
        return { ok: false, message: '这个组件不是你创建的，不能修改', code: 'FORBIDDEN' };
      }
      const html = this.#cleanHtml(input.html);
      const changeNote = this.#redactText(input.changeNote, '改动说明');
      const now = this.#deps.clock.now();
      const version = widget.latest_version + 1;
      const sha256 = createHash('sha256').update(html).digest('hex');
      const conversationId = widget.conversation_id;
      if (conversationId === null) {
        return {
          ok: false,
          message: '这个组件不是在本对话创建的（Bot 级组件的更新入口尚未开放）',
          code: 'FORBIDDEN',
        };
      }
      // 名额在校验全部通过后扣减：无效调用不消耗本 run 的发卡额度（见 create 同名注释）。
      const run = this.#acquireRunSlot(input.runId);
      if (!run.ok) return run;
      const tx = this.#deps.db.transaction(() => {
        this.#insertVersion(widgetId, version, html, sha256, input.runId, now);
        this.#deps.db
          .prepare('update widgets set latest_version = ?, updated_at = ? where id = ?')
          .run(version, now, widgetId);
      });
      tx();
      this.#emitCard({
        widgetId,
        version,
        title: widget.title,
        description:
          changeNote !== '' ? changeNote : widget.description,
        scope: widget.scope,
        sha256,
        sizeBytes: Buffer.byteLength(html),
        botId: widget.bot_id,
        createdAt: now,
        conversationId,
        runId: input.runId,
      });
      return {
        ok: true,
        widgetId,
        version,
        message: `组件「${widget.title}」已更新到 v${version}，新版本以新卡片发进对话（旧卡仍是旧版本）；把改动告诉用户并请其加载新卡。`,
      };
    } catch (error) {
      return { ok: false, message: `组件未能更新：${errorMessage(error)}` };
    }
  }

  // --- 卡片与审查 ----------------------------------------------------------------

  /** 卡片消息里的描述符（校验过；不是 `bot_widget` 卡则抛 NOT_FOUND）。 */
  cardOf(messageId: string): { message: Message; card: WidgetCard } {
    const message = this.#deps.messages.getById(messageId);
    const content = message?.content as { cardType?: unknown; widget?: unknown } | undefined;
    if (
      message === null ||
      message.kind !== 'card' ||
      content?.cardType !== BOT_WIDGET_CARD_TYPE ||
      content.widget === undefined
    ) {
      throw new AppError('NOT_FOUND', '找不到这张组件卡片');
    }
    const parsed = widgetCardSchema.safeParse(content.widget);
    if (!parsed.success) throw new AppError('WIDGET_INVALID', '组件卡片的内容已损坏');
    return { message, card: parsed.data };
  }

  /** 查看源码（审查态）：HTML 原文，不登记资源；与 open 同样校验卡片钉住的 sha256。 */
  source(messageId: string): WidgetsUiSourceOutput {
    const { card } = this.cardOf(messageId);
    const version = this.#versionOf(card.widgetId, card.version);
    if (version === null) throw new AppError('WIDGET_INVALID', '这个版本的组件已不存在');
    if (version.sha256 !== card.sha256) {
      throw new AppError('WIDGET_INVALID', '组件卡片与其版本记录不一致，拒绝加载');
    }
    return {
      widgetId: card.widgetId,
      version: card.version,
      title: card.title,
      sha256: version.sha256,
      html: version.html,
    };
  }

  // --- 挂载与协议服务 ------------------------------------------------------------

  /** 卡片挂载：登记内存资源，返回渲染端挂 iframe 所需的信息。 */
  open(input: { messageId: string }): WidgetsUiOpenOutput {
    const { message, card } = this.cardOf(input.messageId);
    const version = this.#versionOf(card.widgetId, card.version);
    if (version === null) throw new AppError('WIDGET_INVALID', '这个版本的组件已不存在');
    // 卡片「钉住」某个版本的完整性校验：sha256 不一致说明库行被外力改动过，拒绝加载。
    if (version.sha256 !== card.sha256) {
      throw new AppError('WIDGET_INVALID', '组件卡片与其版本记录不一致，拒绝加载');
    }
    const entry = this.store.put({
      widgetId: card.widgetId,
      version: card.version,
      messageId: message.id,
      conversationId: message.conversationId,
      botId: card.botId,
      // 登记的是「垫片版」HTML（仅内存资源；widget_versions 里的原文不动，
      // 审查态 source 看到的仍是 Bot 写的原文）。
      html: injectWidgetSdk(version.html),
      csp: WIDGET_CSP,
    });
    return {
      resourceId: entry.id,
      url: `${MCP_APP_SCHEME}://${entry.host}/${entry.id}`,
      widgetId: card.widgetId,
      version: card.version,
      title: card.title,
      description: card.description,
      scope: card.scope,
      sha256: card.sha256,
    };
  }

  close(resourceId: string): void {
    this.store.remove(resourceId);
  }

  /**
   * 删除 Bot 的级联（lifecycle 调用）：bots 行删除时改占位、`bot_id` 的 FK 级联
   * 不会触发，这里显式清三表（versions / docs 随 widgets 行级联）。返回删除数。
   */
  deleteForBot(botId: string): number {
    const row = this.#deps.db
      .prepare('delete from widgets where bot_id = ?')
      .run(botId) as { changes: number | bigint };
    return Number(row.changes);
  }

  /**
   * 平台方法 `widgets.ui.resource`：id 存在、未过期、host 与登记一致。
   */
  resource(input: { resourceId: string; host: string }): { html: string; csp: string } {
    const entry = this.store.get(input.resourceId);
    if (entry === undefined || entry.host !== input.host) {
      throw new AppError('NOT_FOUND', '组件界面资源不存在或已过期');
    }
    return { html: entry.html, csp: entry.csp };
  }

  // --- 能力桥（P1，设计 32 §6）---------------------------------------------------

  /**
   * 能力桥 KV：命名空间 = resourceId 反查出的 widgetId（组件之间互不可见）。
   * 免审批（作用域天然隔离），但按资源限速；resourceId 过期 / 不存在即拒绝。
   */
  storage(input: WidgetsUiStorageInput): WidgetsUiStorageOutput {
    const entry = this.store.get(input.resourceId);
    if (entry === undefined) {
      throw new AppError('WIDGET_RESOURCE_EXPIRED', '组件界面已过期，请重新打开这张卡片');
    }
    const release = this.store.tryAcquireCall(entry.id);
    if (release === null) {
      throw new AppError('WIDGET_RATE_LIMITED', '组件调用宿主能力过于频繁，请稍后再试');
    }
    try {
      const widgetId = entry.widgetId;
      switch (input.op) {
        case 'get': {
          const row = this.#deps.db
            .prepare('select value_json from widget_docs where widget_id = ? and key = ?')
            .get(widgetId, input.key) as { value_json: string } | undefined;
          if (row === undefined) return { op: 'get', found: false };
          try {
            return { op: 'get', found: true, value: JSON.parse(row.value_json) as unknown };
          } catch {
            // 库行被外力损坏：宁缺勿错，按不存在返回（写入会覆盖坏值）。
            return { op: 'get', found: false };
          }
        }
        case 'set': {
          if (input.value === undefined) {
            throw new AppError('INVALID_INPUT', 'storage.set 需要一个 JSON 值（不支持 undefined）');
          }
          let valueJson: string;
          try {
            valueJson = JSON.stringify(input.value) ?? '';
          } catch {
            throw new AppError('INVALID_INPUT', 'storage.set 的值必须是可 JSON 序列化的');
          }
          if (Buffer.byteLength(valueJson) > BOT_WIDGET_STORAGE_VALUE_MAX_BYTES) {
            throw new AppError(
              'WIDGET_STORAGE_QUOTA',
              `单个值过大（上限 ${BOT_WIDGET_STORAGE_VALUE_MAX_BYTES} 字节）`,
            );
          }
          const usage = this.#docsUsage(widgetId);
          const exists = usage.keys.has(input.key);
          const valueBytes = Buffer.byteLength(valueJson);
          const nextBytes =
            usage.bytes - (exists ? (usage.sizes.get(input.key) ?? 0) : 0) + valueBytes;
          if (nextBytes > BOT_WIDGET_STORAGE_QUOTA_BYTES) {
            throw new AppError(
              'WIDGET_STORAGE_QUOTA',
              `这个组件的存储空间已用完（上限 ${BOT_WIDGET_STORAGE_QUOTA_BYTES} 字节），先删除一些键再试`,
            );
          }
          if (!exists && usage.keys.size >= BOT_WIDGET_STORAGE_KEYS_MAX) {
            throw new AppError(
              'WIDGET_STORAGE_QUOTA',
              `这个组件的键数量已达上限（${BOT_WIDGET_STORAGE_KEYS_MAX} 个），先删除一些键再试`,
            );
          }
          this.#deps.db
            .prepare(
              'insert into widget_docs (widget_id, key, value_json, updated_at) values (?, ?, ?, ?) ' +
                'on conflict(widget_id, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at',
            )
            .run(widgetId, input.key, valueJson, this.#deps.clock.now());
          return { op: 'set' };
        }
        case 'delete': {
          this.#deps.db
            .prepare('delete from widget_docs where widget_id = ? and key = ?')
            .run(widgetId, input.key);
          return { op: 'delete' };
        }
        case 'list': {
          const rows = this.#deps.db
            .prepare('select key from widget_docs where widget_id = ? order by key')
            .all(widgetId) as Array<{ key: string }>;
          return { op: 'list', keys: rows.map((row) => row.key) };
        }
      }
    } finally {
      release();
    }
  }

  /** 能力桥外链：渲染端已出确认条征得同意，这里再核 https-only / 无凭据后经主进程打开。 */
  async openLink(input: { resourceId: string; url: string }): Promise<{ ok: boolean }> {
    if (this.store.get(input.resourceId) === undefined) {
      throw new AppError('WIDGET_RESOURCE_EXPIRED', '组件界面已过期，请重新打开这张卡片');
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false };
    }
    // 只放行 https；不带凭据（同 apps.ui.openLink）。
    if (
      url.protocol !== 'https:' ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return { ok: false };
    }
    return this.#deps.shell.openExternal({ url: url.toString() });
  }

  // --- 内部 ----------------------------------------------------------------------

  /** 该组件 KV 的当前占用：键集合、总字节、每键字节（≤1000 键，全量读入即可）。 */
  #docsUsage(widgetId: string): { keys: Set<string>; bytes: number; sizes: Map<string, number> } {
    const rows = this.#deps.db
      .prepare('select key, value_json from widget_docs where widget_id = ?')
      .all(widgetId) as Array<{ key: string; value_json: string }>;
    const keys = new Set<string>();
    const sizes = new Map<string, number>();
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.value_json);
      keys.add(row.key);
      sizes.set(row.key, size);
      bytes += size;
    }
    return { keys, bytes, sizes };
  }

  #insertVersion(
    widgetId: string,
    version: number,
    html: string,
    sha256: string,
    runId: string,
    now: number,
  ): void {
    this.#deps.db
      .prepare(
        'insert into widget_versions (widget_id, version, html, sha256, created_by_run, created_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(widgetId, version, html, sha256, runId, now);
  }

  #widgetOf(widgetId: string): WidgetRow | null {
    return (this.#deps.db.prepare('select * from widgets where id = ?').get(widgetId) ??
      null) as WidgetRow | null;
  }

  #versionOf(widgetId: string, version: number): WidgetVersionRow | null {
    return (this.#deps.db
      .prepare('select * from widget_versions where widget_id = ? and version = ?')
      .get(widgetId, version) ?? null) as WidgetVersionRow | null;
  }

  #cleanText(raw: string, max: number, label: string): string {
    const text = this.#redactText(raw, label);
    if (text === '') throw new AppError('INVALID_INPUT', `${label}不能为空`);
    if (text.length > max) {
      throw new AppError('INVALID_INPUT', `${label}过长（最多 ${max} 字）`);
    }
    return text;
  }

  #redactText(raw: string, label: string): string {
    const text = this.#deps.secrets.redact(String(raw ?? '').trim());
    if (text.length > BOT_WIDGET_DESCRIPTION_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', `${label}过长（最多 ${BOT_WIDGET_DESCRIPTION_MAX_CHARS} 字）`);
    }
    return text;
  }

  #cleanHtml(raw: string): string {
    if (raw.trim() === '') throw new AppError('INVALID_INPUT', 'html 不能为空');
    if (Buffer.byteLength(raw) > BOT_WIDGET_HTML_MAX_BYTES) {
      throw new AppError('INVALID_INPUT', `html 过大（上限 ${BOT_WIDGET_HTML_MAX_BYTES} 字节）`);
    }
    return raw;
  }

  /** 每个 run 的发卡上限（防循环刷屏）；超限返回失败说明。 */
  #acquireRunSlot(runId: string): { ok: true } | { ok: false; message: string } {
    if (runId === '') return { ok: true };
    const emitted = this.#cardsByRun.get(runId) ?? 0;
    if (emitted >= BOT_WIDGET_CARDS_PER_RUN_MAX) {
      return { ok: false, message: `一次执行里最多发布 ${BOT_WIDGET_CARDS_PER_RUN_MAX} 张组件卡片` };
    }
    if (this.#cardsByRun.size > 1000) this.#cardsByRun.clear();
    this.#cardsByRun.set(runId, emitted + 1);
    return { ok: true };
  }

  #emitCard(card: WidgetCard & { conversationId: string; runId: string }): Message | null {
    const { conversationId, runId, ...descriptor } = card;
    try {
      const message = this.#deps.messages.append({
        conversationId,
        senderType: 'system',
        kind: 'card',
        cardType: BOT_WIDGET_CARD_TYPE,
        cardWidget: descriptor,
        runId,
      });
      this.#deps.publishMessage(message);
      return message;
    } catch (error) {
      // 组件已落库：发卡失败只记日志，不让工具报错（下次 widget_update 可再发）。
      this.#deps.logger.warn(
        { widgetId: descriptor.widgetId, error: errorMessage(error) },
        'bot widget card failed',
      );
      return null;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
