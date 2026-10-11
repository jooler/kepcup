import { createHash } from 'node:crypto';
import {
  AppError,
  BOT_WIDGET_CARDS_PER_RUN_MAX,
  BOT_WIDGET_CARD_TYPE,
  BOT_WIDGET_DESCRIPTION_MAX_CHARS,
  BOT_WIDGET_HTML_MAX_BYTES,
  BOT_WIDGET_QUERY_RESULT_MAX_BYTES,
  BOT_WIDGET_QUERY_ROWS_MAX,
  BOT_WIDGET_QUERY_SQL_MAX_BYTES,
  BOT_WIDGET_QUERIES_MAX,
  BOT_WIDGET_STORAGE_KEYS_MAX,
  BOT_WIDGET_STORAGE_QUOTA_BYTES,
  BOT_WIDGET_STORAGE_VALUE_MAX_BYTES,
  BOT_WIDGET_TITLE_MAX_CHARS,
  MCP_APP_SCHEME,
  buildAppCspHeader,
  newId,
  widgetCardSchema,
  widgetQueryDefSchema,
  type Message,
  type WidgetCard,
  type WidgetQueryDef,
  type WidgetScope,
  type WidgetsUiOpenOutput,
  type WidgetsUiQueryInput,
  type WidgetsUiQueryOutput,
  type WidgetsUiSourceOutput,
  type WidgetsUiStorageInput,
  type WidgetsUiStorageOutput,
  type WidgetsListItem,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import { WidgetResourceStore, widgetUiHostFor } from './resource-store.js';
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
 * - {@link WidgetService.query}：能力桥结构化查询（P2）——按名字执行**卡片钉住
 *   版本**登记的只读查询模板（`widget_queries`，0029）；SQL 在交付时随版本被
 *   人工预审，运行时输入只有参数（版本钉住：旧卡永远用旧模板）。
 * - {@link WidgetService.listForBot} / {@link WidgetService.delete} /
 *   {@link WidgetService.publish}：管理入口（P2，设计 32 §3）——Bot 详情「组件」
 *   Tab 的列表 / 删除，与跨对话引用（发卡到指定对话，工具 `widget_publish` 共用）。
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
  /** 该版本查询模板的摘要（0029 前的旧行 / 无模板为空串）。 */
  queries_sha256: string;
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
  /** 随版本登记的命名只读查询模板（缺省 = 该版本没有任何查询）；全量快照语义。 */
  queries?: WidgetQueryDef[];
  scope: WidgetScope;
  runId: string;
}

export interface WidgetUpdateInput {
  botId: string;
  widgetId: string;
  html: string;
  /** 同 create：新版本的完整查询模板清单（缺省 = 新版本没有任何查询）。 */
  queries?: WidgetQueryDef[];
  /**
   * 当前对话（卡片目的地之一）：会话级组件固定发回其归属对话；Bot 级组件（跨对话
   * 资产，P2 起）发到当前对话。
   */
  conversationId?: string | null;
  changeNote: string;
  runId: string;
}

export type WidgetWriteResult =
  | {
      ok: true;
      widgetId: string;
      title: string;
      version: number;
      message: string;
      /** 发出的卡片消息 id；缺省 = 落库成功但发卡失败（组件此刻在界面上不可见）。 */
      cardMessageId?: string;
    }
  | { ok: false; message: string; code?: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_INPUT' };

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
      const queries = this.#cleanQueries(input.queries);
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
        this.#insertVersion(widgetId, 1, html, sha256, queries, input.runId, now);
      });
      tx();
      const card = this.#emitCard({
        widgetId,
        version: 1,
        title,
        description,
        scope: input.scope,
        sha256,
        queriesSha256: queriesSha256Of(queries),
        queriesCount: queries.length,
        sizeBytes: Buffer.byteLength(html),
        botId: input.botId,
        createdAt: now,
        conversationId: input.conversationId,
        runId: input.runId,
      });
      return {
        ok: true,
        widgetId,
        title,
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
      const queries = this.#cleanQueries(input.queries);
      const now = this.#deps.clock.now();
      const version = widget.latest_version + 1;
      const sha256 = createHash('sha256').update(html).digest('hex');
      // 卡片目的地（P2 跨对话引用）：会话级组件固定发回归属对话；Bot 级组件是
      // 跨对话资产，发到当前对话。
      let conversationId: string | null = widget.conversation_id;
      if (conversationId === null) {
        conversationId = input.conversationId ?? null;
        if (conversationId === null) {
          return {
            ok: false,
            message: 'Bot 级组件的新版本卡片需要一个对话（当前没有对话上下文）',
            code: 'INVALID_INPUT',
          };
        }
      }
      // 名额在校验全部通过后扣减：无效调用不消耗本 run 的发卡额度（见 create 同名注释）。
      const run = this.#acquireRunSlot(input.runId);
      if (!run.ok) return run;
      const tx = this.#deps.db.transaction(() => {
        this.#insertVersion(widgetId, version, html, sha256, queries, input.runId, now);
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
        queriesSha256: queriesSha256Of(queries),
        queriesCount: queries.length,
        sizeBytes: Buffer.byteLength(html),
        botId: widget.bot_id,
        createdAt: now,
        conversationId,
        runId: input.runId,
      });
      return {
        ok: true,
        widgetId,
        title: widget.title,
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

  /**
   * 卡片钉住版本的完整性校验：HTML sha256 与查询模板摘要都要与卡片一致，且库里的
   * 查询模板内容要能复算出版本行记录的摘要——不一致说明库行被外力改动过（包括
   * 只改模板内容、版本行摘要没跟着变的「审查对象被偷换」），拒绝加载 / 展示。
   */
  #pinnedVersion(card: WidgetCard): WidgetVersionRow {
    const version = this.#versionOf(card.widgetId, card.version);
    if (version === null) throw new AppError('WIDGET_INVALID', '这个版本的组件已不存在');
    if (version.sha256 !== card.sha256) {
      throw new AppError('WIDGET_INVALID', '组件卡片与其版本记录不一致，拒绝加载');
    }
    if (
      version.queries_sha256 !== card.queriesSha256 ||
      queriesSha256Of(this.#queriesOf(card.widgetId, card.version)) !== version.queries_sha256
    ) {
      throw new AppError('WIDGET_INVALID', '组件卡片与其版本记录不一致，拒绝加载');
    }
    return version;
  }

  /** 查看源码（审查态）：HTML 原文与查询模板全文，不登记资源；与 open 同样校验卡片钉住的摘要。 */
  source(messageId: string): WidgetsUiSourceOutput {
    const { card } = this.cardOf(messageId);
    const version = this.#pinnedVersion(card);
    return {
      widgetId: card.widgetId,
      version: card.version,
      title: card.title,
      sha256: version.sha256,
      html: version.html,
      queries: this.#queriesOf(card.widgetId, card.version),
    };
  }

  // --- 挂载与协议服务 ------------------------------------------------------------

  /** 卡片挂载：登记内存资源，返回渲染端挂 iframe 所需的信息。 */
  open(input: { messageId: string }): WidgetsUiOpenOutput {
    const { message, card } = this.cardOf(input.messageId);
    // 卡片「钉住」某个版本的完整性校验（含查询模板摘要）。
    const version = this.#pinnedVersion(card);
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
   * 不会触发，这里显式清四表（versions / queries / docs 随 widgets 行级联），并
   * 摘除该 Bot 全部在途内存资源——已挂的 iframe 下一次桥调用即得
   * `WIDGET_RESOURCE_EXPIRED`，与管理入口 delete() 的失败模式一致，而不是让
   * 存活组件在 TTL 内打到已消失的库行、收到裸 SQLite 错误。返回删除数。
   */
  deleteForBot(botId: string): number {
    const rows = this.#deps.db
      .prepare('select id from widgets where bot_id = ?')
      .all(botId) as Array<{ id: string }>;
    const row = this.#deps.db
      .prepare('delete from widgets where bot_id = ?')
      .run(botId) as { changes: number | bigint };
    for (const { id } of rows) this.store.removeForWidget(id);
    return Number(row.changes);
  }

  // --- 管理入口（P2，设计 32 §3）-------------------------------------------------

  /** 管理 Tab 的列表：该 Bot 全部组件（含会话级）+ 最新版本的展示信息，按更新时间倒序。 */
  listForBot(botId: string): WidgetsListItem[] {
    const rows = this.#deps.db
      .prepare(
        `select w.id as widget_id, w.title, w.description, w.scope, w.conversation_id,
                w.latest_version, w.updated_at,
                v.sha256, length(cast(v.html as blob)) as size_bytes,
                (select count(*) from widget_versions vv where vv.widget_id = w.id) as version_count,
                (select count(*) from widget_queries q where q.widget_id = w.id and q.version = w.latest_version) as queries_count
         from widgets w
         join widget_versions v on v.widget_id = w.id and v.version = w.latest_version
         where w.bot_id = ?
         order by w.updated_at desc`,
      )
      .all(botId) as Array<{
      widget_id: string;
      title: string;
      description: string;
      scope: WidgetScope;
      conversation_id: string | null;
      latest_version: number;
      updated_at: number;
      sha256: string;
      size_bytes: number | bigint;
      version_count: number | bigint;
      queries_count: number | bigint;
    }>;
    return rows.map((row) => ({
      widgetId: row.widget_id,
      title: row.title,
      description: row.description,
      scope: row.scope,
      conversationId: row.conversation_id,
      version: row.latest_version,
      versionCount: Number(row.version_count),
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      queriesCount: Number(row.queries_count),
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 管理入口删除：仅限本 Bot 名下（botId 校验），versions / docs / queries 随行级联；
   * 在途内存资源一并摘除（已挂的 iframe 下一次桥调用即得 WIDGET_RESOURCE_EXPIRED），
   * 历史卡片按「版本已不存在」优雅报错。返回是否存在并已删除。
   */
  delete(botId: string, widgetId: string): boolean {
    const widget = this.#widgetOf(widgetId);
    if (widget === null || widget.bot_id !== botId) return false;
    this.#deps.db.prepare('delete from widgets where id = ?').run(widgetId);
    this.store.removeForWidget(widgetId);
    return true;
  }

  /**
   * 跨对话引用（P2）：把本 Bot 的**Bot 级组件**最新版本发卡到指定对话（工具
   * `widget_publish` 与管理 Tab「发到当前对话」共用）。不落新版本、不动库，卡片
   * 钉最新版并走既有审查态流程；会话级组件不外发（它们随归属对话生灭）。
   */
  publish(input: {
    botId: string;
    widgetId: string;
    conversationId: string;
    runId: string | null;
  }): WidgetWriteResult {
    const widget = this.#widgetOf(input.widgetId.trim());
    if (widget === null) {
      return { ok: false, message: '找不到这个组件（widgetId 不存在）', code: 'NOT_FOUND' };
    }
    if (widget.bot_id !== input.botId) {
      return { ok: false, message: '这个组件不是你创建的，不能引用', code: 'FORBIDDEN' };
    }
    if (widget.scope !== 'bot') {
      return {
        ok: false,
        message: '只能引用 Bot 级组件（跨对话资产）；会话级组件留在它的对话里',
        code: 'FORBIDDEN',
      };
    }
    const version = this.#versionOf(widget.id, widget.latest_version);
    if (version === null) {
      return { ok: false, message: '组件的最新版本已不存在', code: 'NOT_FOUND' };
    }
    const queriesCount = (
      this.#deps.db
        .prepare('select count(*) as n from widget_queries where widget_id = ? and version = ?')
        .get(widget.id, version.version) as { n: number | bigint }
    ).n;
    const run = this.#acquireRunSlot(input.runId ?? '');
    if (!run.ok) return run;
    const card = this.#emitCard({
      widgetId: widget.id,
      version: version.version,
      title: widget.title,
      description: widget.description,
      scope: widget.scope,
      sha256: version.sha256,
      queriesSha256: version.queries_sha256,
      queriesCount: Number(queriesCount),
      sizeBytes: Buffer.byteLength(version.html),
      botId: widget.bot_id,
      createdAt: version.created_at,
      conversationId: input.conversationId,
      runId: input.runId ?? '',
    });
    return {
      ok: true,
      widgetId: widget.id,
      title: widget.title,
      version: version.version,
      message: `组件「${widget.title}」（v${version.version}）已发卡到当前对话，等用户确认加载。`,
      ...(card !== null ? { cardMessageId: card.id } : {}),
    };
  }

  /**
   * 平台方法 `widgets.ui.resource`：id 存在、未过期、host 与登记一致（并复核 host
   * 确由 widgetId 派生——同 apps.ui.resource 的纵深校验）。
   */
  resource(input: { resourceId: string; host: string }): { html: string; csp: string } {
    const entry = this.store.get(input.resourceId);
    if (
      entry === undefined ||
      entry.host !== input.host ||
      entry.host !== widgetUiHostFor(entry.widgetId)
    ) {
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
        case 'set':
          return this.#storageSet(widgetId, input.key, input.value);
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

  /**
   * 能力桥结构化查询（P2，设计 32 §6）：按名字执行**本卡片版本**登记的只读查询模板。
   * 免审批的唯一理由是 SQL 在 widget_create / widget_update 时随版本被人工预审——
   * 运行时输入只有参数、没有 SQL；resourceId 反查拿 widgetId + version（版本钉住：
   * 旧卡永远用旧模板）。与 storage 同一限速器；执行前对库行再核一次只读门槛
   * （登记时的防御在库里，这里防外力改动）。
   *
   * 超时语义：better-sqlite3 同步执行、core 单线程，事件循环内无法真中断一条
   * 正在跑的 SQL——这里的「上限」是行数（`BOT_WIDGET_QUERY_ROWS_MAX`）与回执
   * 字节（`BOT_WIDGET_QUERY_RESULT_MAX_BYTES`，行数约束不了行宽），迭代触及即断
   * 并标记 truncated；扫描耗时无法限时，人工预审是耗时边界的主要防线
   * （设计 32 §6 已写明）。
   */
  query(input: WidgetsUiQueryInput): WidgetsUiQueryOutput {
    const entry = this.store.get(input.resourceId);
    if (entry === undefined) {
      throw new AppError('WIDGET_RESOURCE_EXPIRED', '组件界面已过期，请重新打开这张卡片');
    }
    const release = this.store.tryAcquireCall(entry.id);
    if (release === null) {
      throw new AppError('WIDGET_RATE_LIMITED', '组件调用宿主能力过于频繁，请稍后再试');
    }
    try {
      const row = this.#deps.db
        .prepare('select sql from widget_queries where widget_id = ? and version = ? and name = ?')
        .get(entry.widgetId, entry.version, input.name) as { sql: string } | undefined;
      if (row === undefined) {
        throw new AppError(
          'WIDGET_QUERY_UNKNOWN',
          `查询「${input.name}」没有在这个组件版本里登记（查询模板随版本声明；要新增或修改模板需用 widget_update 发新版本并请用户重新确认）`,
        );
      }
      let statement: SqlStatement;
      try {
        statement = this.#deps.db.prepare(row.sql);
      } catch (error) {
        throw new AppError(
          'WIDGET_QUERY_FAILED',
          `查询「${input.name}」无法编译，这个版本的模板可能已被外力改动：${errorMessage(error)}`,
        );
      }
      // stmt.readonly 对部分 PRAGMA / ATTACH 也返回 true（sqlite3_stmt_readonly 的已知
      // 行为），配合首关键词白名单双闸——登记与运行时同一门槛。
      if (statement.readonly !== true || !isReadOnlySelectSql(row.sql)) {
        throw new AppError('WIDGET_QUERY_FAILED', `查询「${input.name}」已不是只读语句，拒绝执行`);
      }
      const params = sanitizeQueryParams(input.name, input.params);
      const rows: Array<Record<string, unknown>> = [];
      let truncated = false;
      let resultBytes = 0;
      try {
        for (const raw of statement.iterate(params)) {
          const row = jsonSafeRow(raw as Record<string, unknown>);
          // 行数约束不了行宽（200 行宽文本列可达数十 MB）：逐行累计回执字节，
          // 超限截断（溢出的这一行不返回）。与桥消息的入站 1MB 上限对齐。
          resultBytes += Buffer.byteLength(JSON.stringify(row));
          if (resultBytes > BOT_WIDGET_QUERY_RESULT_MAX_BYTES) {
            truncated = true;
            break;
          }
          rows.push(row);
          if (rows.length >= BOT_WIDGET_QUERY_ROWS_MAX) {
            truncated = true;
            break;
          }
        }
      } catch (error) {
        throw new AppError('WIDGET_QUERY_FAILED', `查询「${input.name}」执行失败：${humanizeSqlError(error)}`);
      }
      return { rows, truncated };
    } finally {
      release();
    }
  }

  // --- 内部 ----------------------------------------------------------------------

  /**
   * KV 写入：单值体积 → 总配额（覆盖旧键释放旧值体积）→ 键数上限（覆盖不计新键），
   * 全部通过后才落库。同步 better-sqlite3 + core 单进程持库，检查与写入之间无并发。
   */
  #storageSet(widgetId: string, key: string, value: unknown): WidgetsUiStorageOutput {
    if (value === undefined) {
      throw new AppError('INVALID_INPUT', 'storage.set 需要一个 JSON 值（不支持 undefined）');
    }
    let valueJson: string | undefined;
    try {
      valueJson = JSON.stringify(value);
    } catch {
      // 循环引用 / BigInt 等：structured clone 能过桥，序列化必败。
      throw new AppError('INVALID_INPUT', 'storage.set 的值必须是可 JSON 序列化的');
    }
    if (valueJson === undefined) {
      throw new AppError('INVALID_INPUT', 'storage.set 的值必须是可 JSON 序列化的');
    }
    const valueBytes = Buffer.byteLength(valueJson);
    if (valueBytes > BOT_WIDGET_STORAGE_VALUE_MAX_BYTES) {
      throw new AppError(
        'WIDGET_STORAGE_QUOTA',
        `单个值过大（上限 ${BOT_WIDGET_STORAGE_VALUE_MAX_BYTES} 字节）`,
      );
    }
    const existing = this.#deps.db
      .prepare('select value_json from widget_docs where widget_id = ? and key = ?')
      .get(widgetId, key) as { value_json: string } | undefined;
    const usage = this.#deps.db
      .prepare(
        'select count(*) as n, coalesce(sum(length(cast(value_json as blob))), 0) as bytes from widget_docs where widget_id = ?',
      )
      .get(widgetId) as { n: number | bigint; bytes: number | bigint };
    const nextBytes =
      Number(usage.bytes) - (existing !== undefined ? Buffer.byteLength(existing.value_json) : 0) +
      valueBytes;
    if (nextBytes > BOT_WIDGET_STORAGE_QUOTA_BYTES) {
      throw new AppError(
        'WIDGET_STORAGE_QUOTA',
        `这个组件的存储空间已用完（上限 ${BOT_WIDGET_STORAGE_QUOTA_BYTES} 字节），先删除一些键再试`,
      );
    }
    if (existing === undefined && Number(usage.n) >= BOT_WIDGET_STORAGE_KEYS_MAX) {
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
      .run(widgetId, key, valueJson, this.#deps.clock.now());
    return { op: 'set' };
  }

  #insertVersion(
    widgetId: string,
    version: number,
    html: string,
    sha256: string,
    queries: WidgetQueryDef[],
    runId: string,
    now: number,
  ): void {
    this.#deps.db
      .prepare(
        'insert into widget_versions (widget_id, version, html, sha256, queries_sha256, created_by_run, created_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(widgetId, version, html, sha256, queriesSha256Of(queries), runId, now);
    const insert = this.#deps.db.prepare(
      'insert into widget_queries (widget_id, version, name, sql) values (?, ?, ?, ?)',
    );
    for (const def of queries) {
      insert.run(widgetId, version, def.name, def.sql);
    }
  }

  #widgetOf(widgetId: string): WidgetRow | null {
    return (this.#deps.db.prepare('select * from widgets where id = ?').get(widgetId) ??
      null) as WidgetRow | null;
  }

  /** 某个版本的查询模板（按名字序；source 展示与摘要的规范序）。 */
  #queriesOf(widgetId: string, version: number): WidgetQueryDef[] {
    const rows = this.#deps.db
      .prepare('select name, sql from widget_queries where widget_id = ? and version = ? order by name')
      .all(widgetId, version) as Array<{ name: string; sql: string }>;
    return rows;
  }

  /**
   * 交付侧的查询模板校验（widget_create / widget_update）：形状 / 数量 / 名字唯一 /
   * 体积，再逐条 prepare + 只读门槛——SQL 语法错误、表不存在、写语句在交付时即被
   * 拒绝（Bot 拿到可行动的错误，用户也不会看到注定跑不通的模板）。
   */
  #cleanQueries(raw: WidgetQueryDef[] | undefined): WidgetQueryDef[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw new AppError('INVALID_INPUT', 'queries 必须是模板数组');
    }
    if (raw.length > BOT_WIDGET_QUERIES_MAX) {
      throw new AppError('INVALID_INPUT', `查询模板最多 ${BOT_WIDGET_QUERIES_MAX} 条`);
    }
    const seen = new Set<string>();
    const defs = raw.map((def) => {
      const parsed = widgetQueryDefSchema.safeParse(def);
      if (!parsed.success) {
        throw new AppError(
          'INVALID_INPUT',
          '查询模板不合法：name 需为 1–64 个字母/数字/-/_，sql 不能为空且 ≤64KB',
        );
      }
      const { name, sql } = parsed.data;
      if (seen.has(name)) throw new AppError('INVALID_INPUT', `查询模板名重复：${name}`);
      seen.add(name);
      if (Buffer.byteLength(sql) > BOT_WIDGET_QUERY_SQL_MAX_BYTES) {
        throw new AppError(
          'INVALID_INPUT',
          `查询「${name}」的 SQL 过大（上限 ${BOT_WIDGET_QUERY_SQL_MAX_BYTES} 字节）`,
        );
      }
      // __proto__ 作为命名参数永远绑不上（对象键赋值是原型操作不是 own key），人审
      // 会放行一个运行时必败的模板——交付时即拒，让 Bot 改名。
      if (/[:@?$]__proto__\b/i.test(sql)) {
        throw new AppError(
          'INVALID_INPUT',
          `查询「${name}」的参数名不能是 __proto__（保留字，参数绑定会静默失败），请换一个名字`,
        );
      }
      this.#gateReadonlyQuery(name, sql);
      return parsed.data;
    });
    return defs;
  }

  /** 交付时的只读门槛：prepare（语法 / 表存在性）+ 首关键词白名单 + stmt.readonly。 */
  #gateReadonlyQuery(name: string, sql: string): void {
    try {
      const statement = this.#deps.db.prepare(sql);
      if (statement.readonly === true && isReadOnlySelectSql(sql)) return;
    } catch (error) {
      throw new AppError(
        'INVALID_INPUT',
        `查询「${name}」无法编译（只支持单条 SELECT / WITH…SELECT，表名与 :参数 语法会在交付时校验）：${errorMessage(error)}`,
      );
    }
    throw new AppError(
      'INVALID_INPUT',
      `查询「${name}」必须是单条只读 SELECT（或 WITH…SELECT）——不能写库，也不能是 PRAGMA / ATTACH 等改连接状态的语句`,
    );
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

/** better-sqlite3 的预编译语句（query 只用到 readonly 与 iterate）。 */
type SqlStatement = ReturnType<SqliteDatabase['prepare']>;

/**
 * 查询模板的首关键词白名单：只放行 SELECT / WITH（WITH…INSERT/UPDATE/DELETE 由
 * `stmt.readonly` 拦）。单独需要它是因为 sqlite3_stmt_readonly 对 PRAGMA / ATTACH
 * 也返回 true——其中 `pragma foreign_keys=off`、`attach …` 这类语句能改变整个
 * core 连接的状态，必须挡在门外。跳过前导空白与 SQL 注释后比对首词。
 */
export function isReadOnlySelectSql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trimStart();
  return /^(select|with)\b/i.test(stripped);
}

/** 查询模板清单的规范摘要：按名字排序后 JSON 序列化取 sha256；空清单 = 空串。 */
export function queriesSha256Of(defs: WidgetQueryDef[]): string {
  if (defs.length === 0) return '';
  const canonical = [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** 查询参数只允许 JSON 标量（SQLite 能绑定的）；boolean 归一为 1/0，其余拒绝。 */
function sanitizeQueryParams(
  queryName: string,
  params: Record<string, unknown>,
): Record<string, string | number | bigint | null> {
  const out: Record<string, string | number | bigint | null> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || value === null) {
      out[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'bigint') {
      // better-sqlite3 非 safeIntegers 模式把 bigint 按 double 绑：超出安全整数会
      // 静默失真（查错行），宁可响亮拒绝。
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
        throw new AppError(
          'INVALID_INPUT',
          `查询「${queryName}」的参数「${key}」超出安全整数范围（±2^53），会丢失精度；改用字符串传递或让 Bot 调整模板`,
        );
      }
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value ? 1 : 0;
    } else {
      throw new AppError(
        'INVALID_INPUT',
        `查询「${queryName}」的参数「${key}」只支持 string / number / boolean / null`,
      );
    }
  }
  return out;
}

/** 行值归一为 JSON 安全类型：BLOB（Buffer）→ base64 字符串，其余（number/string/null）原样。 */
function jsonSafeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
  }
  return out;
}

/** 常见绑定错误的人话化（其余原样透出，都包在「执行失败：…」里）。 */
function humanizeSqlError(error: unknown): string {
  const message = errorMessage(error);
  const missing = /^Missing named parameter "(.+)"$/.exec(message);
  if (missing !== null) {
    return `缺少参数「${missing[1]}」（模板里的 :${missing[1]} 没有在 params 里给值）`;
  }
  return message;
}
