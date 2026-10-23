import { createHash } from 'node:crypto';
import {
  AppError,
  BOT_WIDGET_BOT_BYTES_QUOTA,
  BOT_WIDGET_CARDS_PER_RUN_MAX,
  BOT_WIDGET_CARD_TYPE,
  BOT_WIDGET_DESCRIPTION_MAX_CHARS,
  BOT_WIDGET_HTML_MAX_BYTES,
  BOT_WIDGET_PER_BOT_MAX,
  BOT_WIDGET_QUERY_RESULT_MAX_BYTES,
  BOT_WIDGET_QUERY_ROWS_MAX,
  BOT_WIDGET_STORAGE_KEYS_MAX,
  BOT_WIDGET_STORAGE_QUOTA_BYTES,
  BOT_WIDGET_STORAGE_VALUE_MAX_BYTES,
  BOT_WIDGET_TITLE_MAX_CHARS,
  BOT_WIDGET_VERSIONS_KEPT,
  WIDGET_READ_STATE_MAX_BYTES,
  WIDGET_REPLY_COOLDOWN_MS,
  WIDGET_REPLY_MAX_CHARS,
  MCP_APP_SCHEME,
  buildWidgetRuntimeCspHeader,
  newId,
  widgetCardSchema,
  widgetCheckSummarySchema,
  type Message,
  type WidgetCard,
  type WidgetCheckStatus,
  type WidgetCheckSummary,
  type WidgetQueryDef,
  type WidgetScope,
  type WidgetTheme,
  type WidgetsUiOpenOutput,
  type WidgetsUiQueryInput,
  type WidgetsUiQueryOutput,
  type WidgetsUiPosterOutput,
  type WidgetsUiSourceOutput,
  type WidgetsUiStorageInput,
  type WidgetsUiStorageOutput,
  type WidgetsListItem,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import {
  WIDGET_QUERY_PHYSICAL_TABLES,
  WidgetQueryGate,
  explainBindings,
  widgetQueryViewsFor,
} from './query-gate.js';
import type { WidgetQueryExecutor } from './query-runner.js';
import { WidgetResourceStore, widgetUiHostFor, type WidgetResource } from './resource-store.js';
import { cleanWidgetQueries } from './query-validate.js';
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
 *   协议处理器按 host 前缀 `widget-` 分流到这里取 HTML 与响应头 CSP（完整 WebApp 档）。
 * - {@link WidgetService.storage} / {@link WidgetService.openLink}：能力桥（P1，
 *   设计 32 §6）——渲染端桥把 widget 的调用转发为 `widgets.ui.storage` /
 *   `widgets.ui.openLink`，这里以 resourceId 反查登记资源定命名空间，KV 落
 *   `widget_docs`（命名空间 = widgetId），外链 https-only 经主进程打开。
 * - {@link WidgetService.query}：能力桥结构化查询（P2）——按名字执行**卡片钉住
 *   版本**登记的只读查询模板（`widget_queries`，0029）；SQL 在交付时随版本被
 *   人工预审（含模板的版本必须在审查态展开过 SQL 才能 open，0032 起由 core 强制），
 *   运行时输入只有参数（版本钉住：旧卡永远用旧模板）。模板只看得见作用域视图
 *   （query-gate.ts），在独立只读子进程里带时限执行（query-runner.ts，设计 32 §6.1）。
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
  /** HTML 的 UTF-8 字节数（0032，存量回填）。 */
  size_bytes: number;
  /** 含模板的版本被用户展开审查 SQL 的时间（0032；未审查 / 无模板为 null）。 */
  queries_reviewed_at: number | null;
  /** D87 自检状态（0035；存量为 legacy）与检查摘要 JSON（存量为空串）。 */
  check_status: WidgetCheckStatus;
  check_summary_json: string;
  created_by_run: string;
  created_at: number;
}

/**
 * widget 的固定响应头 CSP：完整 WebApp 档——不限制资源与网络（sandbox 旗标与 iframe
 * 属性一致），隔离由 iframe sandbox 属性 + 宿主导航/权限守卫承担。
 */
const WIDGET_CSP = buildWidgetRuntimeCspHeader();

/** 海报截图的防御性上限（base64 字符数；S2 预览截图远小于此，超出视为异常丢弃）。 */
export const WIDGET_POSTER_MAX_CHARS = 4_000_000;

/** PNG 文件签名（base64 解码头 8 字节必须逐字节一致）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 落库侧的海报校验：非空 base64、不超上限，且解码头部是 PNG 签名（`preview.ts` 的
 * mimeType 是生产方自报的，存库前以字节为准——损坏数据 / data:URL 前缀形式都在这里
 * 丢弃，渲染端 `data:image/png;base64,` 前缀拼接后才不会出坏图）。不合格返回 undefined。
 */
export function posterPngOf(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > WIDGET_POSTER_MAX_CHARS) {
    return undefined;
  }
  try {
    const head = Buffer.from(value.slice(0, 16), 'base64');
    return head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? value : undefined;
  } catch {
    return undefined;
  }
}

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
  /**
   * 查询模板的执行边界（生产 = {@link WidgetQueryRunner}：独立只读子进程 + 时限 / 内存
   * 上限；设计 32 §6.1）。模板永不在 `db`（core 主库连接）上执行。
   */
  queryRunner: WidgetQueryExecutor;
  clock: Clock;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
}

/**
 * D87 交付时的自检结论（制作 loop 凭检查回执给出，设计 32 §11.12）：落版本行并带进卡片。
 * 缺省 = `legacy`（服务层直接调用，如测试装配）。
 */
export interface WidgetDeliveryCheck {
  status: Exclude<WidgetCheckStatus, 'legacy'>;
  summary: WidgetCheckSummary;
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
  check?: WidgetDeliveryCheck;
  /** 自检 S2 预览的首视口截图（base64 PNG）；对话卡片海报用，缺省 = 无海报。 */
  posterPng?: string | undefined;
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
  check?: WidgetDeliveryCheck;
  /** 同 create。 */
  posterPng?: string | undefined;
}

export type WidgetWriteResult =
  | {
      ok: true;
      widgetId: string;
      title: string;
      version: number;
      message: string;
      /**
       * 发出的卡片消息 id；`null` = 落库成功但发卡失败（组件此刻在界面上不可见）。
       * 必填而非可选：每条成功路径都必须显式交代发卡结果（曾因 update 漏带而让
       * 工具层把每次成功的更新都报成「发卡失败」）。
       */
      cardMessageId: string | null;
    }
  | { ok: false; message: string; code?: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_INPUT' | 'WIDGET_LIMIT' };

/** 移交盘点的一行（D88 P2）：Bot 级组件。 */
export interface WidgetHandoverCandidate {
  widgetId: string;
  title: string;
  description: string;
  latestVersion: number;
  versionCount: number;
  /** 全部版本 HTML 的字节数。 */
  bytes: number;
  /** 最新版本的查询模板数。 */
  queriesCount: number;
  /** storage 文档（widget_docs）的键数。 */
  docsCount: number;
  /** 最新版本的 D87 自检状态。 */
  checkStatus: WidgetCheckStatus;
}

/** widget_read_state 里放不下的大值给出的开头片段长度（字符）。 */
const READ_STATE_PREVIEW_CHARS = 1_000;

export class WidgetService {
  readonly store: WidgetResourceStore;
  readonly #deps: WidgetServiceDeps;
  readonly #cardsByRun = new Map<string, number>();
  /** 回传冷却：卡片消息 id → 上次回传时间（按卡，不按资源：重开 / 重载 / 重新挂载换资源 id）。 */
  readonly #lastReplyAt = new Map<string, number>();
  readonly #gate = new WidgetQueryGate();
  /** Bots whose widgets were cleared for deletion (handover copies into / from them refuse). */
  readonly #deletedBots = new Set<string>();

  constructor(deps: WidgetServiceDeps, store?: WidgetResourceStore) {
    this.#deps = deps;
    this.store = store ?? new WidgetResourceStore({ clock: deps.clock });
  }

  /** core 关闭：杀掉查询子进程、关掉名字闸的桩库。 */
  dispose(): void {
    this.#deps.queryRunner.dispose();
    this.#gate.dispose();
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
      const sizeBytes = Buffer.byteLength(html);
      const owned = Number(
        (
          this.#deps.db.prepare('select count(*) as n from widgets where bot_id = ?').get(input.botId) as {
            n: number | bigint;
          }
        ).n,
      );
      if (owned >= BOT_WIDGET_PER_BOT_MAX) {
        return {
          ok: false,
          code: 'WIDGET_LIMIT',
          message: `你已有 ${owned} 个组件（上限 ${BOT_WIDGET_PER_BOT_MAX}）：改已有组件请用 widget_craft 并传 widget_id；如需新组件，请用户在 Bot 详情「组件」里删除不再使用的组件后再试`,
        };
      }
      const overQuota = this.#bytesQuotaError(input.botId, sizeBytes, 0);
      if (overQuota !== null) return overQuota;
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
        this.#insertVersion(
          widgetId,
          1,
          html,
          sha256,
          queries,
          input.runId,
          now,
          input.check,
          posterPngOf(input.posterPng),
        );
      });
      tx();
      const card = this.#emitCard({
        ...cardCheckFields(input.check),
        widgetId,
        version: 1,
        title,
        description,
        scope: input.scope,
        sha256,
        queriesSha256: queriesSha256Of(queries),
        queriesCount: queries.length,
        sizeBytes,
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
        message: `组件「${title}」（v1）已作为卡片发进对话，等用户确认加载。不要用文字复述代码；之后要修改时用 widget_craft 并传 widget_id。`,
        cardMessageId: card?.id ?? null,
      };
    } catch (error) {
      return { ok: false, message: `组件未能创建：${errorMessage(error)}` };
    }
  }

  update(input: WidgetUpdateInput): WidgetWriteResult {
    try {
      const widgetId = input.widgetId.trim();
      if (widgetId === '') {
        return { ok: false, message: '需要提供 widgetId' };
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
      const sizeBytes = Buffer.byteLength(html);
      // 版本保留：落新版本后只留最近 BOT_WIDGET_VERSIONS_KEPT 个，更早的（含查询模板）修剪；
      // 配额按修剪后的占用计（被修剪的旧版本不该挡住新版本）。
      const pruneThrough = version - BOT_WIDGET_VERSIONS_KEPT;
      const prunedBytes =
        pruneThrough >= 1
          ? Number(
              (
                this.#deps.db
                  .prepare(
                    'select coalesce(sum(size_bytes), 0) as bytes from widget_versions where widget_id = ? and version <= ?',
                  )
                  .get(widgetId, pruneThrough) as { bytes: number | bigint }
              ).bytes,
            )
          : 0;
      const overQuota = this.#bytesQuotaError(widget.bot_id, sizeBytes, prunedBytes);
      if (overQuota !== null) return overQuota;
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
        this.#insertVersion(
          widgetId,
          version,
          html,
          sha256,
          queries,
          input.runId,
          now,
          input.check,
          posterPngOf(input.posterPng),
        );
        this.#deps.db
          .prepare('update widgets set latest_version = ?, updated_at = ? where id = ?')
          .run(version, now, widgetId);
        if (pruneThrough >= 1) {
          // widget_queries 没有指向版本行的外键，两表一起修剪。
          this.#deps.db
            .prepare('delete from widget_versions where widget_id = ? and version <= ?')
            .run(widgetId, pruneThrough);
          this.#deps.db
            .prepare('delete from widget_queries where widget_id = ? and version <= ?')
            .run(widgetId, pruneThrough);
        }
      });
      tx();
      // 钉着被修剪版本的在途资源一并摘除（下一次桥调用即 WIDGET_RESOURCE_EXPIRED，
      // 重开时得「这个版本的组件已不存在」）。
      if (pruneThrough >= 1) this.store.removeForWidget(widgetId, pruneThrough);
      const card = this.#emitCard({
        ...cardCheckFields(input.check),
        widgetId,
        version,
        title: widget.title,
        description:
          changeNote !== '' ? changeNote : widget.description,
        scope: widget.scope,
        sha256,
        queriesSha256: queriesSha256Of(queries),
        queriesCount: queries.length,
        sizeBytes,
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
        cardMessageId: card?.id ?? null,
      };
    } catch (error) {
      return { ok: false, message: `组件未能更新：${errorMessage(error)}` };
    }
  }

  /**
   * 制作 loop 修改已有组件的起点（D87，设计 32 §11.5）：本 Bot 名下组件最新版的 HTML 与查询
   * 模板（草稿的 index.html / queries.json 由它初始化）。只给制作 loop 用，内容不进任务上下文。
   */
  craftSource(
    botId: string,
    widgetId: string,
  ):
    | {
        ok: true;
        title: string;
        description: string;
        scope: WidgetScope;
        version: number;
        html: string;
        queries: WidgetQueryDef[];
      }
    | { ok: false; message: string; code: 'NOT_FOUND' | 'FORBIDDEN' } {
    const widget = this.#widgetOf(widgetId.trim());
    if (widget === null) {
      return { ok: false, message: '找不到这个组件（widget_id 不存在）', code: 'NOT_FOUND' };
    }
    if (widget.bot_id !== botId) {
      return { ok: false, message: '这个组件不是你创建的，不能修改', code: 'FORBIDDEN' };
    }
    const version = this.#versionOf(widget.id, widget.latest_version);
    if (version === null) {
      return { ok: false, message: '组件的最新版本已不存在', code: 'NOT_FOUND' };
    }
    return {
      ok: true,
      title: widget.title,
      description: widget.description,
      scope: widget.scope,
      version: version.version,
      html: version.html,
      queries: this.#queriesOf(widget.id, version.version),
    };
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

  /**
   * 查看源码（审查态）：HTML 原文与查询模板全文，不登记资源；与 open 同样校验卡片钉住的摘要。
   * 含查询模板的版本在这里记下「已展开审查」（`queries_reviewed_at`）——open 据此强制预审。
   */
  source(messageId: string): WidgetsUiSourceOutput {
    const { card } = this.cardOf(messageId);
    const version = this.#pinnedVersion(card);
    const queries = this.#queriesOf(card.widgetId, card.version);
    if (queries.length > 0 && version.queries_reviewed_at === null) {
      this.#deps.db
        .prepare(
          'update widget_versions set queries_reviewed_at = ? where widget_id = ? and version = ? and queries_reviewed_at is null',
        )
        .run(this.#deps.clock.now(), card.widgetId, card.version);
    }
    return {
      widgetId: card.widgetId,
      version: card.version,
      title: card.title,
      sha256: version.sha256,
      html: version.html,
      queries,
    };
  }

  /**
   * 海报截图（对话卡片静态展示用，懒加载）：取卡片钉住版本的自检截图。只读展示——
   * 不做 `#pinnedVersion` 的摘要强校验（截图损坏不至于挂不上组件，回退占位即可）。
   */
  poster(messageId: string): WidgetsUiPosterOutput {
    const { card } = this.cardOf(messageId);
    const row = this.#deps.db
      .prepare('select poster_png from widget_versions where widget_id = ? and version = ?')
      .get(card.widgetId, card.version) as { poster_png: string | null } | undefined;
    return { posterPng: row?.poster_png ?? null };
  }

  // --- 挂载与协议服务 ------------------------------------------------------------

  /** 卡片挂载：登记内存资源，返回渲染端挂 iframe 所需的信息。 */
  open(input: { messageId: string; theme?: WidgetTheme | undefined }): WidgetsUiOpenOutput {
    const { message, card } = this.cardOf(input.messageId);
    // 卡片「钉住」某个版本的完整性校验（含查询模板摘要）。
    const version = this.#pinnedVersion(card);
    // 预审强制化：带查询模板的版本，用户没在审查态展开过 SQL 全文就不许加载——
    // 渲染端按钮也会门控，这里是不依赖 UI 的那一侧。
    if (version.queries_sha256 !== '' && version.queries_reviewed_at === null) {
      throw new AppError(
        'WIDGET_REVIEW_REQUIRED',
        '这个组件版本带数据库查询模板，加载前需要先在「查看源码」里展开审查查询 SQL',
      );
    }
    const entry = this.store.put({
      widgetId: card.widgetId,
      version: card.version,
      messageId: message.id,
      conversationId: message.conversationId,
      botId: card.botId,
      // 登记的是「垫片版」HTML（仅内存资源；widget_versions 里的原文不动，
      // 审查态 source 看到的仍是 Bot 写的原文）。
      // 主题按卡片打开时的明暗设好（D87 P3b）；之后的切换由卡片推送主题事件。
      html: injectWidgetSdk(version.html, input.theme !== undefined ? { theme: input.theme } : {}),
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
    // D88 P2: a handover copy that runs after this point must not insert rows for the bot.
    this.#deletedBots.add(botId);
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
                v.sha256, v.size_bytes, v.check_status,
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
      check_status: WidgetCheckStatus;
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
      checkStatus: row.check_status,
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
    // 只取描述符要的列：发卡用不着把最多 2MB 的 html 读出来。
    const version = (this.#deps.db
      .prepare(
        'select version, sha256, queries_sha256, size_bytes, created_at, check_status, check_summary_json from widget_versions where widget_id = ? and version = ?',
      )
      .get(widget.id, widget.latest_version) ?? null) as Pick<
      WidgetVersionRow,
      | 'version'
      | 'sha256'
      | 'queries_sha256'
      | 'size_bytes'
      | 'created_at'
      | 'check_status'
      | 'check_summary_json'
    > | null;
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
    // widget_publish 发出的卡沿用该版本的自检状态（设计 32 §11.12）。
    const card = this.#emitCard({
      checkStatus: version.check_status,
      knownIssues: knownIssuesOf(version.check_summary_json),
      widgetId: widget.id,
      version: version.version,
      title: widget.title,
      description: widget.description,
      scope: widget.scope,
      sha256: version.sha256,
      queriesSha256: version.queries_sha256,
      queriesCount: Number(queriesCount),
      sizeBytes: version.size_bytes,
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
      cardMessageId: card?.id ?? null,
    };
  }

  // --- Bot 资产移交（D88 P2，设计 37 §3）--------------------------------------------

  /**
   * 可移交的组件：只有 Bot 级（`scope='bot'`，跨对话资产）。会话级组件随所在对话生灭、
   * 卡片钉在那个对话里，不移交（盘点只给条数）。
   */
  handoverCandidates(botId: string): WidgetHandoverCandidate[] {
    const rows = this.#deps.db
      .prepare(
        `select w.id, w.title, w.description, w.latest_version,
                (select count(*) from widget_versions v where v.widget_id = w.id) as versions,
                (select coalesce(sum(v.size_bytes), 0) from widget_versions v where v.widget_id = w.id) as bytes,
                (select count(*) from widget_queries q where q.widget_id = w.id and q.version = w.latest_version) as queries,
                (select count(*) from widget_docs d where d.widget_id = w.id) as docs,
                (select v.check_status from widget_versions v where v.widget_id = w.id and v.version = w.latest_version) as check_status
         from widgets w where w.bot_id = ? and w.scope = 'bot'
         order by w.updated_at desc`,
      )
      .all(botId) as Array<{
      id: string;
      title: string;
      description: string;
      latest_version: number;
      versions: number | bigint;
      bytes: number | bigint;
      queries: number | bigint;
      docs: number | bigint;
      check_status: WidgetCheckStatus | null;
    }>;
    return rows.map((row) => ({
      widgetId: row.id,
      title: row.title,
      description: row.description,
      latestVersion: row.latest_version,
      versionCount: Number(row.versions),
      bytes: Number(row.bytes),
      queriesCount: Number(row.queries),
      docsCount: Number(row.docs),
      checkStatus: row.check_status ?? 'legacy',
    }));
  }

  /** 会话级组件的条数（盘点说明「不移交」用）。 */
  conversationScopedCount(botId: string): number {
    return Number(
      (
        this.#deps.db
          .prepare("select count(*) as n from widgets where bot_id = ? and scope = 'conversation'")
          .get(botId) as { n: number | bigint }
      ).n,
    );
  }

  /** 版本指纹序列（版本号 + HTML 摘要 + 查询摘要）：判定「同一组件的副本」。 */
  #versionPrint(widgetId: string): string {
    const rows = this.#deps.db
      .prepare(
        'select version, sha256, queries_sha256 from widget_versions where widget_id = ? order by version',
      )
      .all(widgetId) as Array<{ version: number; sha256: string; queries_sha256: string }>;
    return rows.map((row) => `${row.version}:${row.sha256}:${row.queries_sha256}`).join('|');
  }

  /**
   * 接手方名下与来源组件完全相同的副本（同名 Bot 级组件、版本序列一致）：移交复制的幂等
   * 判据（崩溃在复制事务提交与记账之间时，重跑认它为已完成）。
   */
  findHandoverCopy(widgetId: string, toBotId: string): string | null {
    const source = this.#widgetOf(widgetId);
    if (source === null) return null;
    const print = this.#versionPrint(widgetId);
    const candidates = this.#deps.db
      .prepare("select id from widgets where bot_id = ? and scope = 'bot' and title = ? and id <> ?")
      .all(toBotId, source.title, widgetId) as Array<{ id: string }>;
    return candidates.find((row) => this.#versionPrint(row.id) === print)?.id ?? null;
  }

  /** 复制给接手方的阻断原因（同名、数量上限、字节配额）；null = 可以复制。 */
  handoverCopyBlocker(widgetId: string, toBotId: string, toName: string): string | null {
    const source = this.#widgetOf(widgetId);
    if (source === null || source.scope !== 'bot') return '这个组件已不存在';
    const sameName = this.#deps.db
      .prepare('select 1 from widgets where bot_id = ? and title = ? limit 1')
      .get(toBotId, source.title);
    if (sameName !== undefined) return `${toName} 已有同名组件「${source.title}」`;
    const owned = Number(
      (
        this.#deps.db.prepare('select count(*) as n from widgets where bot_id = ?').get(toBotId) as {
          n: number | bigint;
        }
      ).n,
    );
    if (owned >= BOT_WIDGET_PER_BOT_MAX) {
      return `${toName} 的组件已达上限（${BOT_WIDGET_PER_BOT_MAX} 个）`;
    }
    const bytes = Number(
      (
        this.#deps.db
          .prepare('select coalesce(sum(size_bytes), 0) as bytes from widget_versions where widget_id = ?')
          .get(widgetId) as { bytes: number | bigint }
      ).bytes,
    );
    if (this.#bytesQuotaError(toBotId, bytes, 0) !== null) {
      return `${toName} 的组件存储空间不够放下这个组件（含历史版本）`;
    }
    return null;
  }

  /**
   * 把一个 Bot 级组件连同全部版本（HTML、摘要、自检状态与摘要、查询模板的人工预审时间、
   * 海报截图照搬）、查询模板与 storage 文档复制给接手方：新 id、仍为 Bot 级、不发卡（接手方之后用
   * `widget_publish` 发到需要的对话）。一个事务；阻断条件在事务内复查。
   *
   * 确认状态：渲染端按「HTML sha256 + 查询摘要」记忆用户的加载确认（不分组件 / Bot），
   * 副本的每个版本两项摘要都与原版相同，所以原版已确认过的版本在接手方那里同样免确认；
   * 未确认过的仍要确认。`queries_reviewed_at`（core 强制的 SQL 预审）同样照搬。
   */
  copyForHandover(widgetId: string, toBotId: string, toName: string): { widgetId: string; versions: number } {
    const newWidgetId = newId('wgt');
    let versions = 0;
    this.#deps.db.transaction(() => {
      // Both bots must still be live inside the transaction (a deletion clears widgets and
      // only later tombstones the row: never insert rows for a bot being deleted).
      const owner = this.#widgetOf(widgetId);
      for (const botId of [toBotId, owner?.bot_id ?? '']) {
        const row = this.#deps.db.prepare('select status from bots where id = ?').get(botId) as
          | { status: string }
          | undefined;
        if (row?.status !== 'active' || this.#deletedBots.has(botId)) {
          throw new AppError('NOT_FOUND', '来源或接手方 Bot 已被删除');
        }
      }
      const blocked = this.handoverCopyBlocker(widgetId, toBotId, toName);
      if (blocked !== null) throw new AppError('INVALID_INPUT', blocked);
      const source = this.#widgetOf(widgetId)!;
      const now = this.#deps.clock.now();
      this.#deps.db
        .prepare(
          "insert into widgets (id, bot_id, conversation_id, scope, title, description, latest_version, created_at, updated_at) values (?, ?, null, 'bot', ?, ?, ?, ?, ?)",
        )
        .run(newWidgetId, toBotId, source.title, source.description, source.latest_version, now, now);
      versions = Number(
        this.#deps.db
          .prepare(
            `insert into widget_versions (widget_id, version, html, sha256, created_by_run, created_at,
               queries_sha256, size_bytes, queries_reviewed_at, check_status, check_summary_json, poster_png)
             select ?, version, html, sha256, created_by_run, created_at,
               queries_sha256, size_bytes, queries_reviewed_at, check_status, check_summary_json, poster_png
             from widget_versions where widget_id = ?`,
          )
          .run(newWidgetId, widgetId).changes,
      );
      this.#deps.db
        .prepare(
          'insert into widget_queries (widget_id, version, name, sql) select ?, version, name, sql from widget_queries where widget_id = ?',
        )
        .run(newWidgetId, widgetId);
      this.#deps.db
        .prepare(
          'insert into widget_docs (widget_id, key, value_json, updated_at) select ?, key, value_json, updated_at from widget_docs where widget_id = ?',
        )
        .run(newWidgetId, widgetId);
    })();
    return { widgetId: newWidgetId, versions };
  }

  /**
   * 平台方法 `widgets.ui.resource`：id 存在、未过期、host 与登记一致（并复核 host
   * 确由 widgetId 派生——同 apps.ui.resource 的纵深校验），且钉住的版本仍在库里。
   */
  resource(input: { resourceId: string; host: string }): { html: string; csp: string } {
    const entry = this.#liveEntry(input.resourceId);
    if (
      entry === null ||
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
   * 免审批（作用域天然隔离），但按资源限速；resourceId 过期 / 不存在 / 组件已被删除
   * 即拒绝（WIDGET_RESOURCE_EXPIRED）。
   */
  storage(input: WidgetsUiStorageInput): WidgetsUiStorageOutput {
    const entry = this.#requireLiveEntry(input.resourceId);
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

  /**
   * 回传（D87 P4 L3，设计 32 §12.3）：用户在卡内确认条上同意后，取组件文字要发往的对话与来源。
   * 资源必须存活；每张卡（按卡片消息，资源重开不重置）至少间隔 WIDGET_REPLY_COOLDOWN_MS（渲染端
   * 也有冷却，这里是不依赖 UI 的那一侧）。真正发消息由绑定层调 orchestrator.sendMessage（带 `origin: 'widget'`）。
   */
  prepareReply(input: { resourceId: string; text: string }): {
    conversationId: string;
    widgetId: string;
    version: number;
    text: string;
  } {
    const entry = this.#requireLiveEntry(input.resourceId);
    const text = input.text.trim();
    if (text === '') throw new AppError('INVALID_INPUT', '回传的内容不能为空');
    if (text.length > WIDGET_REPLY_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', `回传的内容过长（最多 ${WIDGET_REPLY_MAX_CHARS} 字）`);
    }
    const now = this.#deps.clock.now();
    const last = this.#lastReplyAt.get(entry.messageId);
    if (last !== undefined && now - last < WIDGET_REPLY_COOLDOWN_MS) {
      throw new AppError('WIDGET_RATE_LIMITED', '组件回传太频繁，请稍后再试');
    }
    if (this.#lastReplyAt.size > 1000) {
      // 只清已过冷却的项（全清会让正在冷却的卡也解禁）。
      for (const [key, at] of this.#lastReplyAt) {
        if (now - at >= WIDGET_REPLY_COOLDOWN_MS) this.#lastReplyAt.delete(key);
      }
    }
    this.#lastReplyAt.set(entry.messageId, now);
    return { conversationId: entry.conversationId, widgetId: entry.widgetId, version: entry.version, text };
  }

  /**
   * `widget_read_state`（D87 P4 L3）：Bot 读自己组件的 KV（全部或指定键），回执上限
   * WIDGET_READ_STATE_MAX_BYTES；只能读本 Bot 的组件。返回的 JSON 已把 `<` 转成 `\u003c`（仍是合法
   * JSON，字节数按转义后计），由工具层包 <untrusted>。单个值放不下时**跳过并报告**（键、字节数、
   * 开头片段），不中断——单值上限 256KB 大于回执上限，否则一个大键会让整份数据都读不到。
   */
  readState(input: { botId: string; widgetId: string; keys?: string[] }):
    | {
        ok: true;
        json: string;
        truncated: boolean;
        count: number;
        skipped: Array<{ key: string; bytes: number; preview: string }>;
      }
    | { ok: false; message: string; code: 'NOT_FOUND' | 'FORBIDDEN' } {
    const widget = this.#widgetOf(input.widgetId.trim());
    if (widget === null) return { ok: false, message: '找不到这个组件（widget_id 不存在）', code: 'NOT_FOUND' };
    if (widget.bot_id !== input.botId) {
      return { ok: false, message: '这个组件不是你创建的，不能读取它的数据', code: 'FORBIDDEN' };
    }
    const rows = this.#deps.db
      .prepare('select key, value_json from widget_docs where widget_id = ? order by key')
      .all(widget.id) as Array<{ key: string; value_json: string }>;
    const wanted = input.keys !== undefined && input.keys.length > 0 ? new Set(input.keys) : null;
    const escape = (text: string): string => text.replace(/</g, '\\u003c');
    const pieces: string[] = [];
    const skipped: Array<{ key: string; bytes: number; preview: string }> = [];
    let bytes = 2;
    let truncated = false;
    for (const row of rows) {
      if (wanted !== null && !wanted.has(row.key)) continue;
      let value: string;
      try {
        value = escape(JSON.stringify(JSON.parse(row.value_json) as unknown));
      } catch {
        continue;
      }
      const piece = `${escape(JSON.stringify(row.key))}:${value}`;
      const size = Buffer.byteLength(piece) + 1;
      if (bytes + size > WIDGET_READ_STATE_MAX_BYTES) {
        truncated = true;
        // 片段也占预算；预算不够时只报键名与大小。
        const preview = value.slice(0, READ_STATE_PREVIEW_CHARS);
        const previewSize = Buffer.byteLength(preview) + row.key.length + 32;
        if (bytes + previewSize <= WIDGET_READ_STATE_MAX_BYTES) {
          bytes += previewSize;
          skipped.push({ key: row.key, bytes: Buffer.byteLength(row.value_json), preview });
        } else {
          skipped.push({ key: row.key, bytes: Buffer.byteLength(row.value_json), preview: '' });
        }
        continue;
      }
      bytes += size;
      pieces.push(piece);
    }
    return { ok: true, json: `{${pieces.join(',')}}`, truncated, count: pieces.length, skipped };
  }

  /** 能力桥外链：渲染端已出确认条征得同意，这里再核 https-only / 无凭据后经主进程打开。 */
  async openLink(input: { resourceId: string; url: string }): Promise<{ ok: boolean }> {
    this.#requireLiveEntry(input.resourceId);
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
   * 能力桥结构化查询（P2，设计 32 §6 / §6.1）：按名字执行**本卡片版本**登记的只读
   * 查询模板。免审批的理由是 SQL 在 widget_create / widget_update 时随版本被人工预审
   * （open 强制要求展开过 SQL）；运行时输入只有参数、没有 SQL；resourceId 反查拿
   * widgetId + version（版本钉住：旧卡永远用旧模板）。与 storage 同一限速器。
   *
   * 纵深防御（预审之外不再假设人审得出耗时与数据范围问题）：
   * - 名字闸（交付时与这里各一次）：模板只能引用作用域视图（本组件 KV、卡片所在对话
   *   的文字消息），读 schema / pragma 表值函数 / 任何其他表都拒绝；
   * - 执行在独立只读子进程里：只读连接 + `query_only`，视图按本卡片作用域现建，
   *   EXPLAIN 物理闸核对每个 OpenRead 落在白名单表上；超过时限 / 内存上限即杀进程
   *   （`WIDGET_QUERY_TIMEOUT`），core 的事件循环与主库连接不受影响；
   * - 行数（多取一行判定截断）与回执字节上限。
   */
  async query(input: WidgetsUiQueryInput): Promise<WidgetsUiQueryOutput> {
    const entry = this.#requireLiveEntry(input.resourceId);
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
          `查询「${input.name}」没有在这个组件版本里登记（查询模板随版本声明；要新增或修改模板需让 Bot 发新版本并请用户重新确认）`,
        );
      }
      // 运行时复核（防库行被外力改动 / schema 变化）：与交付时同一道名字闸。
      const denied = this.#gate.check(row.sql);
      if (denied !== null) {
        throw new AppError('WIDGET_QUERY_FAILED', `查询「${input.name}」被拒绝执行：${denied}`);
      }
      const params = sanitizeQueryParams(input.name, input.params);
      try {
        return await this.#deps.queryRunner.run({
          // 公平性 / 熔断按组件计（同一组件的多个资源共用额度，设计 32 §6.1）。
          owner: entry.widgetId,
          sql: row.sql,
          params,
          views: widgetQueryViewsFor({ widgetId: entry.widgetId, conversationId: entry.conversationId }),
          tables: WIDGET_QUERY_PHYSICAL_TABLES,
          explainArgs: explainBindings(row.sql),
          rowsMax: BOT_WIDGET_QUERY_ROWS_MAX,
          bytesMax: BOT_WIDGET_QUERY_RESULT_MAX_BYTES,
        });
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError(error.code, `查询「${input.name}」${error.message}`);
        }
        throw new AppError('WIDGET_QUERY_FAILED', `查询「${input.name}」执行失败：${errorMessage(error)}`);
      }
    } finally {
      release();
    }
  }

  // --- 内部 ----------------------------------------------------------------------

  /**
   * 取存活的登记资源：内存里有、未过期，**且钉住的版本行仍在库里**。组件被会话删除
   * 的 FK 级联、Bot 删除、管理入口删除、版本修剪带走时，内存资源不会自己知道——
   * 这里统一识别并摘除，桥调用得 WIDGET_RESOURCE_EXPIRED（渲染端据此重开卡片），
   * 而不是打到已消失的行上收裸 `FOREIGN KEY constraint failed`。
   */
  #liveEntry(resourceId: string): WidgetResource | null {
    const entry = this.store.get(resourceId);
    if (entry === undefined) return null;
    const alive = this.#deps.db
      .prepare('select 1 from widget_versions where widget_id = ? and version = ?')
      .get(entry.widgetId, entry.version);
    if (alive === undefined) {
      this.store.remove(entry.id);
      return null;
    }
    return entry;
  }

  #requireLiveEntry(resourceId: string): WidgetResource {
    const entry = this.#liveEntry(resourceId);
    if (entry === null) {
      throw new AppError('WIDGET_RESOURCE_EXPIRED', '组件界面已过期，请重新打开这张卡片');
    }
    return entry;
  }

  /** 每 Bot 版本总字节配额：新增 `addBytes`、同时修剪掉 `freedBytes` 后是否超限。 */
  #bytesQuotaError(
    botId: string,
    addBytes: number,
    freedBytes: number,
  ): { ok: false; code: 'WIDGET_LIMIT'; message: string } | null {
    const used = Number(
      (
        this.#deps.db
          .prepare(
            'select coalesce(sum(v.size_bytes), 0) as bytes from widget_versions v join widgets w on w.id = v.widget_id where w.bot_id = ?',
          )
          .get(botId) as { bytes: number | bigint }
      ).bytes,
    );
    if (used - freedBytes + addBytes <= BOT_WIDGET_BOT_BYTES_QUOTA) return null;
    const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      code: 'WIDGET_LIMIT',
      message: `你的组件（含历史版本）已占用 ${mb(used)}MB，加上这次的 ${mb(addBytes)}MB 会超过上限 ${mb(BOT_WIDGET_BOT_BYTES_QUOTA)}MB：请精简 HTML，或请用户在 Bot 详情「组件」里删除不再使用的组件后再试`,
    };
  }

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
    check: WidgetDeliveryCheck | undefined,
    posterPng: string | undefined,
  ): void {
    this.#deps.db
      .prepare(
        'insert into widget_versions (widget_id, version, html, sha256, queries_sha256, size_bytes, created_by_run, created_at, check_status, check_summary_json, poster_png) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        widgetId,
        version,
        html,
        sha256,
        queriesSha256Of(queries),
        Buffer.byteLength(html),
        runId,
        now,
        check?.status ?? 'legacy',
        check !== undefined ? JSON.stringify(check.summary) : '',
        posterPng ?? null,
      );
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

  /** 交付侧的查询模板校验（与制作 loop 检查器的 `query.invalid` 同一份代码，query-validate.ts）。 */
  #cleanQueries(raw: WidgetQueryDef[] | undefined): WidgetQueryDef[] {
    return cleanWidgetQueries(raw, this.#gate);
  }

  /**
   * 制作 loop 检查器用的查询校验（设计 32 §11.8.1 `query.invalid`）：与交付侧同一道校验，
   * 通过返回 null，否则返回原样的人话报错。
   */
  validateQueries(raw: WidgetQueryDef[]): string | null {
    try {
      cleanWidgetQueries(raw, this.#gate);
      return null;
    } catch (error) {
      return errorMessage(error);
    }
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

/** 卡片描述符里的自检字段（缺省 = 存量语义 legacy，不显示徽标）。 */
function cardCheckFields(
  check: WidgetDeliveryCheck | undefined,
): Pick<WidgetCard, 'checkStatus' | 'knownIssues'> {
  if (check === undefined) return { checkStatus: 'legacy', knownIssues: [] };
  return { checkStatus: check.status, knownIssues: check.summary.knownIssues };
}

/** 版本行的检查摘要里的已知问题（存量空串 / 损坏 → 空）。 */
function knownIssuesOf(summaryJson: string): string[] {
  if (summaryJson === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(summaryJson) as unknown;
  } catch {
    return [];
  }
  const parsed = widgetCheckSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data.knownIssues : [];
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
