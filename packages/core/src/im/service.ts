import {
  AppError,
  imAlertDedupeKey,
  imAlertsExceeded,
  imForwardDedupeKey,
  imForwardsExceeded,
  imSnippet,
  newId,
  recentImAlerts,
  recentImForwards,
  IM_ALERT_EVENT,
  IM_CARD_TYPE,
  type AppNoticePayload,
  type ImAccount,
  type ImTransport,
  type Message,
  type PluginInstanceSummary,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { SqliteDatabase } from '../infra/db.js';
import { untrustedBlock } from '../infra/data-boundary.js';
import type { SecretsService } from '../domain/secrets.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import { ILinkClient, ILinkSessionExpiredError, ilinkMessageId, ilinkMessageText, type ILinkMessage } from './ilink.js';
import { ImStore, type ImAccountRecord, type ImBindingRecord } from './store.js';
import { ImSessionHub } from './session.js';

/**
 * IM 通道服务（D107–D111，54 号文档）。
 *
 * 入站（§5）：每账号一条长轮询（ImSessionHub）→ ingest 去重 + 会话范围过滤 →
 * 按绑定扇出持久作业 im_alert → runAlertJob 贴卡 + 污点 + 唤醒私聊。
 * 出站（§6，D110）：转发器订阅 message.created（forwarder.ts）→ 对开启了同步的
 * 账号入队 im_forward → runForwardJob 发送 + D78 台账。Bot 全程无感、无工具面。
 * 绑定即入站，勾选才出站；开关关闭时收到入站自动补勾 + 一次性提示（D111）。
 *
 * bot_token 只进实例 secrets（`plugin:{pluginId}:instance:{id}:bot_token`），
 * 只在 core 发请求那一刻取用；扫码登录的确认载荷只存在于本服务的内存 pending
 * 表（十分钟 TTL），永不出 core。
 */

/** 扫码登录确认后的待落地载荷（core 内存，不落库）。 */
interface PendingLogin {
  sessionKey: string;
  pluginId: string;
  /** 绑定到既有实例 = 重扫（update）；null = 新建。 */
  instanceId: string | null;
  /** 非空 = 已确认（token 在 core 内存，等 create / reauthorize 消费）。 */
  token: string;
  apiBase: string;
  ilinkBotId: string;
  ilinkUserId: string;
  /** 确认前的轮询键（get_bot_qrcode 的 qrcode）。 */
  qrcode: string | null;
  createdAt: number;
}

const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

/** 连接中断提示：连续失败达到这个次数才提示一次，恢复时撤掉（mail 同纪律）。 */
const CONNECTION_NOTICE_STREAK = 3;

/** 转发限流窗口 / 失败上限（54 §6）。 */
const FORWARD_RETRY_MAX = 3;
/** 转发失败提示的节流键周期（连续失败 3 轮才提示一次）。 */
const FORWARD_NOTICE_STREAK = 3;

function connectionNoticeKey(accountId: string): string {
  return `im-conn:${accountId}`;
}

function unboundNoticeKey(accountId: string): string {
  return `im-unbound:${accountId}`;
}

function forwardFailNoticeKey(accountId: string): string {
  return `im-forward:${accountId}`;
}

export function imConfig(account: ImAccountRecord): {
  ilinkBotId: string;
  ilinkUserId: string;
  loggedInAt: number | null;
  cursor: string;
  forwardTimes: number[];
  forwardFailures: number;
} {
  try {
    const raw = JSON.parse(account.configJson) as Record<string, unknown>;
    return {
      ilinkBotId: typeof raw.ilink_bot_id === 'string' ? raw.ilink_bot_id : '',
      ilinkUserId: typeof raw.ilink_user_id === 'string' ? raw.ilink_user_id : '',
      loggedInAt: typeof raw.logged_in_at === 'number' ? raw.logged_in_at : null,
      cursor: typeof raw.cursor === 'string' ? raw.cursor : '',
      forwardTimes: Array.isArray(raw.forward_times)
        ? raw.forward_times.filter((item): item is number => typeof item === 'number')
        : [],
      forwardFailures: typeof raw.forward_failures === 'number' ? raw.forward_failures : 0,
    };
  } catch {
    return { ilinkBotId: '', ilinkUserId: '', loggedInAt: null, cursor: '', forwardTimes: [], forwardFailures: 0 };
  }
}

export interface ImInstanceOwnerPort {
  /** 实例所属插件；实例不存在 / 已删 = null。 */
  ownerOf(instanceId: string): { pluginId: string } | null;
  /** 插件展示名（账号列表的归属显示）。 */
  pluginName(pluginId: string): string | null;
  /** 实例账号的 token secret 名。 */
  botTokenSecretName(pluginId: string, instanceId: string): string;
}

export interface ImServiceDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  secrets: SecretsService;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  jobs: JobsService;
  taint: { mark(botId: string, conversationId: string): void };
  deliverAlert: (input: { botId: string; conversationId: string; text: string }) => void;
  publishAccount: (accountId: string) => void;
  publishMessage: (message: Message) => void;
  /** 应用状态提示（连接中断、同步开启、转发失败）：弹一条轻量提示，不落库。 */
  notice: (notice: AppNoticePayload) => void;
  /** D78 外发台账（start.ts 注入 audit.recordSystem）；缺省不记。 */
  recordEgress?: ((detail: Record<string, unknown>) => void) | undefined;
  /** 实例归属解析（start.ts 注入，同 mail 的 instanceOwner）。 */
  instanceOwner: ImInstanceOwnerPort;
  /** 实例生命周期（createFromQrcode / reauthorize 走插件实例流程）。 */
  instances: {
    create(pluginId: string, values: Record<string, never>, kind: 'im'): Promise<PluginInstanceSummary>;
    update(id: string, values: Record<string, never>): Promise<PluginInstanceSummary>;
  };
  /** 有效启用集（54 §5：属主插件未启用的绑定对唤醒与转发不可见）。 */
  pluginEnabledForBot: (botId: string, pluginId: string) => boolean;
  /** 测试注入：客户端与会话节奏。 */
  openClient?: ((account: ImAccountRecord) => ILinkClient) | undefined;
  backoffMs?: (streak: number) => number;
  sessionPauseMs?: number | undefined;
}

interface AlertPayload {
  accountId: string;
  botId: string;
  msgId: string;
  key: string;
  channel: string;
  summary: string;
}

interface ForwardPayload {
  accountId: string;
  botId: string;
  conversationId: string;
  messageId: string;
  text: string;
}

function parseAlert(json: string): AlertPayload | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof raw.accountId !== 'string' ||
      typeof raw.botId !== 'string' ||
      typeof raw.msgId !== 'string' ||
      typeof raw.key !== 'string'
    ) {
      return null;
    }
    return {
      accountId: raw.accountId,
      botId: raw.botId,
      msgId: raw.msgId,
      key: raw.key,
      channel: typeof raw.channel === 'string' ? raw.channel : 'IM',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
    };
  } catch {
    return null;
  }
}

function parseForward(json: string): ForwardPayload | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof raw.accountId !== 'string' ||
      typeof raw.botId !== 'string' ||
      typeof raw.conversationId !== 'string' ||
      typeof raw.messageId !== 'string' ||
      typeof raw.text !== 'string'
    ) {
      return null;
    }
    return {
      accountId: raw.accountId,
      botId: raw.botId,
      conversationId: raw.conversationId,
      messageId: raw.messageId,
      text: raw.text,
    };
  } catch {
    return null;
  }
}

export class ImService {
  readonly store: ImStore;
  readonly #deps: ImServiceDeps;
  readonly #hub: ImSessionHub;
  readonly #pendingLogins = new Map<string, PendingLogin>();
  /** 已经提示过「连接中断」、还没恢复的账号：恢复时撤掉那条提示。 */
  readonly #connectionNoticeShown = new Set<string>();

  constructor(deps: ImServiceDeps) {
    this.#deps = deps;
    this.store = new ImStore(deps.db);
    this.#hub = new ImSessionHub({
      load: (accountId) => this.store.get(accountId),
      token: (accountId) => this.tokenOf(accountId),
      saveCursor: (accountId, cursor) => this.#saveCursor(accountId, cursor),
      onReady: (accountId) => this.#onSessionReady(accountId),
      onMessages: (accountId, messages) => this.ingest(accountId, messages),
      onFailure: (accountId, error, streak) => this.#onSessionFailure(accountId, error, streak),
      onSessionExpired: (accountId) => this.#onSessionExpired(accountId),
      onAuthFailed: (accountId) => this.#onAuthFailed(accountId),
      openClient: deps.openClient ?? ((account) => new ILinkClient({ apiBase: account.apiBase, logger: deps.logger })),
      backoffMs: deps.backoffMs,
      sessionPauseMs: deps.sessionPauseMs,
    });
  }

  // --- 生命周期 -------------------------------------------------------------------

  start(): void {
    this.#hub.startAll(this.store.listActive());
  }

  stop(): void {
    this.#hub.stopAll();
  }

  wake(): void {
    this.#hub.wake();
  }

  /** 每次发请求那一刻才取 token；错误一律脱敏为「不可用」。 */
  tokenOf(accountId: string): string | null {
    const account = this.store.get(accountId);
    if (account === null) return null;
    const owner = this.#deps.instanceOwner.ownerOf(account.instanceId);
    if (owner === null) return null;
    try {
      return this.#deps.secrets.getValue(
        this.#deps.instanceOwner.botTokenSecretName(owner.pluginId, account.instanceId),
      );
    } catch {
      return null;
    }
  }

  pluginIdOf(account: ImAccountRecord): string | null {
    return this.#deps.instanceOwner.ownerOf(account.instanceId)?.pluginId ?? null;
  }

  // --- 扫码登录（core 内存 pending，token 不出 core） -------------------------------

  async beginQrcodeLogin(pluginId: string, instanceId: string | null = null): Promise<{ sessionKey: string; qrcodeContent: string }> {
    if (instanceId !== null && this.store.idByInstance(instanceId) === null) {
      throw new AppError('NOT_FOUND', '该实例的 IM 账号已不存在');
    }
    // apiBase 来自插件贡献（锁定端点）；首发 ilink 固定端点（54 §4）。
    const apiBase = await this.#apiBaseForPlugin(pluginId);
    const client = new ILinkClient({ apiBase, logger: this.#deps.logger });
    const qrcode = await client.getQrcode();
    const sessionKey = newId('imq');
    this.#pendingLogins.set(sessionKey, {
      sessionKey,
      pluginId,
      instanceId,
      token: '',
      apiBase,
      ilinkBotId: '',
      ilinkUserId: '',
      qrcode: qrcode.qrcode,
      createdAt: Date.now(),
    });
    // 惰性过期清理。
    for (const [key, pending] of this.#pendingLogins) {
      if (Date.now() - pending.createdAt > PENDING_LOGIN_TTL_MS) this.#pendingLogins.delete(key);
    }
    return { sessionKey, qrcodeContent: qrcode.qrcode_img_content };
  }

  async pollQrcodeLogin(
    sessionKey: string,
  ): Promise<{ status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'failed'; label: string | null }> {
    const pending = this.#pendingLogins.get(sessionKey);
    if (pending === undefined) throw new AppError('NOT_FOUND', '扫码会话不存在或已过期，请重新获取二维码');
    if (pending.token !== '') return { status: 'confirmed', label: null };
    if (pending.qrcode === null) throw new AppError('INTERNAL', '扫码会话状态损坏');
    const client = new ILinkClient({ apiBase: pending.apiBase, logger: this.#deps.logger });
    const status = await client.pollQrcodeStatus(pending.qrcode);
    if (status.status === 'confirmed') {
      if (typeof status.bot_token !== 'string' || status.bot_token === '') {
        this.#pendingLogins.delete(sessionKey);
        throw new AppError('INTERNAL', '扫码确认响应缺少凭据');
      }
      pending.token = status.bot_token;
      pending.ilinkBotId = status.ilink_bot_id ?? '';
      pending.ilinkUserId = status.ilink_user_id ?? '';
      if (typeof status.baseurl === 'string' && status.baseurl !== '') pending.apiBase = status.baseurl;
      pending.qrcode = null;
      return { status: 'confirmed', label: null };
    }
    if (status.status === 'expired' || status.status === 'verify_code_blocked') {
      this.#pendingLogins.delete(sessionKey);
      return { status: 'expired', label: null };
    }
    if (status.status === 'need_verifycode' || status.status === 'scaned_but_redirect' || status.status === 'binded_redirect') {
      return { status: 'failed', label: null };
    }
    return { status: status.status === 'scaned' ? 'scaned' : 'wait', label: null };
  }

  /** materializer.create 消费口：取出（并移除）该插件新建流程的确认载荷。 */
  takePendingLoginForCreate(pluginId: string): { token: string; apiBase: string; ilinkBotId: string; ilinkUserId: string } {
    for (const [key, pending] of this.#pendingLogins) {
      if (pending.pluginId !== pluginId || pending.instanceId !== null) continue;
      if (pending.token === '') continue;
      this.#pendingLogins.delete(key);
      return { token: pending.token, apiBase: pending.apiBase, ilinkBotId: pending.ilinkBotId, ilinkUserId: pending.ilinkUserId };
    }
    throw new AppError('INVALID_INPUT', '尚未完成扫码确认，请先扫码');
  }

  /** materializer.update 消费口：该实例的确认载荷存在 = 用户重扫了。 */
  takePendingLoginForUpdate(
    pluginId: string,
    instanceId: string,
  ): { token: string; apiBase: string; ilinkBotId: string; ilinkUserId: string } | null {
    for (const [key, pending] of this.#pendingLogins) {
      if (pending.pluginId !== pluginId || pending.instanceId !== instanceId) continue;
      if (pending.token === '') continue;
      this.#pendingLogins.delete(key);
      return { token: pending.token, apiBase: pending.apiBase, ilinkBotId: pending.ilinkBotId, ilinkUserId: pending.ilinkUserId };
    }
    return null;
  }

  /** 渲染层「添加账号」第二步：扫码确认后落地实例（走插件实例完整生命周期）。 */
  async createFromQrcode(pluginId: string, sessionKey: string): Promise<ImAccount> {
    const pending = this.#pendingLogins.get(sessionKey);
    if (pending === undefined || pending.pluginId !== pluginId || pending.instanceId !== null || pending.token === '') {
      throw new AppError('INVALID_INPUT', '扫码会话不可用：请重新扫码');
    }
    const instance = await this.#deps.instances.create(pluginId, {}, 'im');
    const accountId = this.store.idByInstance(instance.id);
    const account = accountId === null ? null : this.store.get(accountId);
    if (account === undefined || account === null) throw new AppError('INTERNAL', '账号落地失败');
    return this.publicAccount(account);
  }

  /** 渲染层「重新扫码」：token 失效后的更新流程（54 §2.3 update）。 */
  async reauthorize(accountId: string, sessionKey: string): Promise<void> {
    const account = this.store.get(accountId);
    if (account === null) throw new AppError('NOT_FOUND', '账号不存在');
    const pending = this.#pendingLogins.get(sessionKey);
    if (pending === undefined || pending.instanceId !== account.instanceId || pending.token === '') {
      throw new AppError('INVALID_INPUT', '扫码会话不可用：请重新扫码');
    }
    await this.#deps.instances.update(account.instanceId, {});
  }

  // --- 实例落地（materializer 专用） ------------------------------------------------

  /** 连接测试 + 落行 + token 入 secrets + 启动会话。返回账号 label（实例 title）。 */
  async createForInstance(input: {
    pluginId: string;
    instanceId: string;
    transport: ImTransport;
    apiBase: string;
    label: string;
    token: string;
    ilinkBotId: string;
    ilinkUserId: string;
  }): Promise<string> {
    const now = this.#deps.clock.now();
    const client = new ILinkClient({ apiBase: input.apiBase, logger: this.#deps.logger });
    await client.notify(input.token, 'start');
    const id = newId('ima');
    this.#deps.secrets.setValue(
      this.#deps.instanceOwner.botTokenSecretName(input.pluginId, input.instanceId),
      input.token,
    );
    this.store.insert({
      id,
      instanceId: input.instanceId,
      transport: input.transport,
      apiBase: input.apiBase,
      label: input.label,
      status: 'connecting',
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      configJson: JSON.stringify({
        ilink_bot_id: input.ilinkBotId,
        ilink_user_id: input.ilinkUserId,
        logged_in_at: now,
        cursor: '',
        forward_times: [],
        forward_failures: 0,
      }),
      createdAt: now,
      updatedAt: now,
    });
    this.#hub.start(id);
    this.#deps.publishAccount(id);
    return input.label;
  }

  /** 重扫落地：替换 secret、更新会话元数据、重启会话。 */
  async reauthorizeForInstance(input: {
    pluginId: string;
    instanceId: string;
    token: string;
    apiBase: string;
    ilinkBotId: string;
    ilinkUserId: string;
  }): Promise<void> {
    const accountId = this.store.idByInstance(input.instanceId);
    if (accountId === null) throw new AppError('NOT_FOUND', '该实例的 IM 账号已不存在');
    const account = this.store.get(accountId)!;
    const now = this.#deps.clock.now();
    this.#deps.secrets.setValue(
      this.#deps.instanceOwner.botTokenSecretName(input.pluginId, input.instanceId),
      input.token,
    );
    const config = imConfig(account);
    this.store.patch(accountId, {
      status: 'connecting',
      lastError: null,
      configJson: JSON.stringify({
        ...config,
        ilink_bot_id: input.ilinkBotId || config.ilinkBotId,
        ilink_user_id: input.ilinkUserId || config.ilinkUserId,
        logged_in_at: now,
        cursor: '',
      }),
      updatedAt: now,
    });
    // apiBase 变化（baseurl 重定向）：表上没有该列的 patch 入参，直接一行 SQL。
    if (input.apiBase !== account.apiBase) {
      this.#deps.db
        .prepare('update im_accounts set api_base = ? where id = ?')
        .run(input.apiBase, accountId);
    }
    this.#hub.start(accountId);
    this.#deps.publishAccount(accountId);
  }

  /** 幂等拆除（materializer remove / 卸载级联）：停会话、删行（绑定 FK 级联）。 */
  deleteByInstance(instanceId: string): void {
    const accountId = this.store.idByInstance(instanceId);
    if (accountId === null) return;
    this.#hub.stop(accountId);
    this.store.delete(accountId);
    this.#deps.publishAccount(accountId);
  }

  /** 删除 Bot 时清它的绑定（账号保留），同 mail。 */
  prepareBotDeletion(botId: string): number {
    return this.store.deleteBindingsForBot(botId);
  }

  // --- 入站（54 §5） ---------------------------------------------------------------

  /** 新消息批。去重靠作业 dedupeKey（持久、崩溃可恢复）；这里做范围过滤与扇出。 */
  ingest(accountId: string, messages: readonly ILinkMessage[]): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    const config = imConfig(account);
    const notices: AppNoticePayload[] = [];
    for (const message of messages) {
      // 只处理与授权用户本人的会话：非用户消息、群聊、陌生来源一律丢弃计数（54 §1/§5）。
      if (message.message_type !== 1) continue;
      if (message.group_id !== undefined && message.group_id !== '') continue;
      const authorized =
        config.ilinkUserId === '' || message.from_user_id === config.ilinkUserId;
      if (!authorized) {
        this.#deps.logger.info({ accountId, from: 'redacted' }, 'im inbound from unauthorized source dropped');
        continue;
      }
      if (message.context_token !== undefined && message.context_token !== '') {
        this.#saveContextToken(accountId, message.context_token);
      }
      this.store.patch(accountId, {
        lastInboundAt: this.#deps.clock.now(),
        updatedAt: this.#deps.clock.now(),
      });
      const text = ilinkMessageText(message);
      if (text.trim() === '') continue;
      const bindings = this.store.bindings(accountId);
      if (bindings.length === 0) {
        notices.push({
          key: unboundNoticeKey(accountId),
          level: 'warning',
          text: `「${account.label}」收到了微信消息，但该账号尚未绑定任何 Bot——在 Bot 详情 → 插件里勾选绑定后即可用微信对话`,
        });
        continue;
      }
      const msgId = ilinkMessageId(message);
      for (const binding of bindings) {
        const outcome = this.#fanOutBinding(account, binding, msgId, text);
        notices.push(...outcome.notices);
      }
    }
    for (const notice of notices) this.#deps.notice(notice);
    if (notices.length > 0) this.#deps.publishAccount(accountId);
  }

  /**
   * 按绑定扇出一条入站：启用集过滤 → 风暴限流 → im_alert 作业 → D111 自动补勾。
   * 同一账号的入站消息可唤醒多个 Bot，幂等键含 botId。
   */
  #fanOutBinding(
    account: ImAccountRecord,
    binding: ImBindingRecord,
    msgId: string,
    text: string,
  ): { notices: AppNoticePayload[] } {
    const notices: AppNoticePayload[] = [];
    const pluginId = this.pluginIdOf(account);
    if (pluginId === null || !this.#deps.pluginEnabledForBot(binding.botId, pluginId)) {
      return { notices };
    }
    const bot = this.#deps.bots.get(binding.botId);
    if (bot === null) return { notices };
    const now = this.#deps.clock.now();
    const recent = recentImAlerts(binding.alertTimes, now);
    if (imAlertsExceeded(recent.length)) {
      this.store.setAlertState(binding.accountId, binding.botId, true, recent);
      notices.push({
        key: `im-paused:${binding.accountId}:${binding.botId}`,
        level: 'warning',
        text: `「${account.label}」一小时内唤醒 ${bot.name} 的消息超过上限，该绑定已暂停提醒；可在 Bot 详情里恢复`,
      });
      return { notices };
    }
    this.store.setAlertState(binding.accountId, binding.botId, false, [...recent, now]);
    const conversation = this.#deps.conversations.openDirect(binding.botId).conversation;
    const key = imAlertDedupeKey(binding.accountId, msgId, binding.botId);
    this.#deps.jobs.enqueue({
      type: 'im_alert',
      botId: binding.botId,
      conversationId: conversation.id,
      payload: {
        accountId: binding.accountId,
        botId: binding.botId,
        msgId,
        key,
        channel: account.label,
        summary: imSnippet(text),
      },
      priority: 2,
      dedupeKey: key,
    });
    // D111 自动补勾：开关关闭时收到该账号的入站 → 同事务置 1 + 一次性提示。永不自动取消。
    if (!binding.forwardEnabled) {
      this.store.setForward(binding.accountId, binding.botId, true, now);
      notices.push({
        key: `im-sync:${binding.accountId}:${binding.botId}`,
        level: 'info',
        text: '检测到你从微信发来消息，已开启同步',
      });
      const systemEvent = this.#deps.messages.append({
        conversationId: conversation.id,
        senderType: 'system',
        kind: 'system_event',
        event: 'im_sync_enabled',
        text: '检测到你从微信发来消息，已开启同步：Bot 的回复将自动转发到微信',
      });
      this.#deps.publishMessage(systemEvent);
    }
    return { notices };
  }

  /** im_alert 作业消费（jobs-runner 调用）：贴卡 + 污点 + 唤醒（幂等）。 */
  runAlertJob(job: JobRow): void {
    const payload = parseAlert(job.payload_json);
    if (payload === null) {
      this.#deps.logger.warn({ jobId: job.id }, 'im_alert job with malformed payload');
      return;
    }
    const account = this.store.get(payload.accountId);
    if (account === null) return;
    if (!this.store.bindings(account.id).some((binding) => binding.botId === payload.botId)) return;
    const conversationId =
      job.conversation_id ?? this.#deps.conversations.openDirect(payload.botId).conversation.id;
    if (!this.#cardExists(conversationId, payload.key)) {
      const card = this.#deps.messages.append({
        conversationId,
        senderType: 'system',
        kind: 'card',
        cardType: IM_CARD_TYPE,
        cardIm: {
          imEvent: 'arrived',
          imAccountId: account.id,
          imKey: payload.key,
          imChannel: payload.channel,
          imSummary: payload.summary,
        },
      });
      this.#deps.publishMessage(card);
    }
    this.#deps.taint.mark(payload.botId, conversationId);
    if (this.#wakeExists(conversationId, payload.accountId, payload.msgId)) return;
    const text = [
      `im_alert ${payload.accountId} ${payload.msgId}`,
      untrustedBlock(`渠道：${payload.channel}\n内容：${payload.summary}`),
    ].join('\n');
    this.#deps.deliverAlert({ botId: payload.botId, conversationId, text });
  }

  #cardExists(conversationId: string, key: string): boolean {
    const row = this.#deps.db
      .prepare(
        "select 1 from messages where conversation_id = ? and kind = 'card' and json_extract(content_json, '$.imKey') = ? limit 1",
      )
      .get(conversationId, key);
    return row !== undefined;
  }

  #wakeExists(conversationId: string, accountId: string, msgId: string): boolean {
    const prefix = `im_alert ${accountId} ${msgId}`;
    return (
      this.#deps.db
        .prepare(
          `select 1 from messages where conversation_id = ? and kind = 'system_event'
           and json_extract(content_json, '$.event') = ?
           and substr(json_extract(content_json, '$.text'), 1, ?) = ? limit 1`,
        )
        .get(conversationId, IM_ALERT_EVENT, prefix.length, prefix) !== undefined
    );
  }

  // --- 出站：自动转发（54 §6，D110） -------------------------------------------------

  /**
   * forwarder 信号入口（forwarder.ts 订阅 message.created 后调用）：只取 Bot 在
   * 私聊里的最终文本回复；对开启同步且属主插件已启用的账号入队 im_forward。
   */
  enqueueForwards(input: {
    conversationId: string;
    messageId: string;
    botId: string;
    text: string;
  }): void {
    const bindings = this.store.bindingsForBot(input.botId).filter((binding) => binding.forwardEnabled);
    for (const binding of bindings) {
      const account = this.store.get(binding.accountId);
      if (account === null) continue;
      const owner = this.pluginIdOf(account);
      if (owner === null) continue;
      // 属主插件未 ∈ Bot 有效启用集：绑定对转发不可见（54 §5 同一纪律）。
      if (!this.#deps.pluginEnabledForBot(input.botId, owner)) continue;
      this.#deps.jobs.enqueue({
        type: 'im_forward',
        botId: input.botId,
        conversationId: input.conversationId,
        payload: {
          accountId: account.id,
          botId: input.botId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          text: input.text,
        },
        priority: 2,
        dedupeKey: imForwardDedupeKey(input.messageId, account.id),
      });
    }
  }

  /** im_forward 作业消费：发送 + 台账 + 限流 + 退避放弃（54 §6）。 */
  async runForwardJob(job: JobRow): Promise<void> {
    const payload = parseForward(job.payload_json);
    if (payload === null) {
      this.#deps.logger.warn({ jobId: job.id }, 'im_forward job with malformed payload');
      return;
    }
    const account = this.store.get(payload.accountId);
    if (account === null) return;
    const binding = this.store
      .bindings(account.id)
      .find((row) => row.botId === payload.botId && row.forwardEnabled);
    if (binding === undefined) return;
    if (account.status === 'auth_failed') {
      this.#forwardNoticeOnce(account, '「{label}」微信登录已失效，转发停止；请重新扫码'.replace('{label}', account.label));
      return;
    }
    if (account.status === 'paused') {
      this.#forwardNoticeOnce(account, `「${account.label}」微信会话暂停中，本条暂不转发`);
      return;
    }
    const pluginId = this.pluginIdOf(account);
    if (pluginId === null || !this.#deps.pluginEnabledForBot(payload.botId, pluginId)) return;
    const token = this.tokenOf(account.id);
    if (token === null) {
      this.#forwardNoticeOnce(account, `「${account.label}」凭据不可用，请重新扫码`);
      return;
    }
    const now = this.#deps.clock.now();
    const config = imConfig(account);
    if (imForwardsExceeded(recentImForwards(config.forwardTimes, now).length)) {
      this.#forwardNoticeOnce(account, `「${account.label}」一小时内转发已达上限，本条已跳过`);
      return;
    }
    const client =
      this.#deps.openClient?.(account) ?? new ILinkClient({ apiBase: account.apiBase, logger: this.#deps.logger });
    let result;
    try {
      result = await client.sendText({
        token,
        toUserId: config.ilinkUserId,
        text: payload.text,
      });
    } catch (error) {
      if (error instanceof ILinkSessionExpiredError) {
        this.store.patch(account.id, {
          status: 'paused',
          lastError: 'iLink 会话暂停（-14）',
          updatedAt: now,
        });
        this.#forwardNoticeOnce(account, `「${account.label}」微信会话被服务器暂停，转发暂停一小时`);
        this.#deps.publishAccount(account.id);
        return;
      }
      throw error;
    }
    // 主动发送被服务器拒绝时的自动降级：用最近一次入站的 context_token 重试
    // （54 §11-1 的保守模式兜底；PoC 定案后保留为兼容路径）。
    if (!result.ok) {
      const contextToken = this.#recentContextToken(account.id);
      if (contextToken !== null) {
        const retry = await client.sendText({
          token,
          toUserId: config.ilinkUserId,
          text: payload.text,
          contextToken,
        });
        if (retry.ok) result = retry;
      }
    }
    if (!result.ok) {
      const failures = config.forwardFailures + 1;
      this.#saveForwardState(account.id, config, { failure: true });
      if (failures >= FORWARD_RETRY_MAX) {
        this.#forwardNoticeOnce(account, `「${account.label}」转发连续失败（${result.code}）：${result.errmsg || '未知错误'}`);
      }
      throw new AppError('INTERNAL', `im_forward failed (${result.code}): ${result.errmsg}`);
    }
    this.#saveForwardState(account.id, config, { failure: false });
    this.store.patch(account.id, {
      lastOutboundAt: now,
      status: 'ready',
      lastError: null,
      updatedAt: now,
    });
    this.#deps.recordEgress?.({
      action: 'im_forward',
      channel: `im-${account.transport}`,
      target: account.label,
      accountId: account.id,
      botId: payload.botId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      chars: payload.text.length,
    });
  }

  #saveForwardState(accountId: string, config: ReturnType<typeof imConfig>, opts: { failure: boolean }): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    const now = this.#deps.clock.now();
    const times = opts.failure
      ? config.forwardTimes
      : [...recentImForwards(config.forwardTimes, now), now];
    const failures = opts.failure ? config.forwardFailures + 1 : 0;
    this.store.patch(accountId, {
      configJson: JSON.stringify({ ...config, forward_times: times, forward_failures: failures }),
      updatedAt: now,
    });
  }

  #forwardNoticeOnce(account: ImAccountRecord, text: string): void {
    this.#deps.notice({ key: forwardFailNoticeKey(account.id), level: 'warning', text });
  }

  // --- 会话回调 ---------------------------------------------------------------------

  #onSessionReady(accountId: string): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    if (account.status !== 'ready') {
      this.store.patch(accountId, { status: 'ready', lastError: null, updatedAt: this.#deps.clock.now() });
      this.#deps.publishAccount(accountId);
    }
    if (this.#connectionNoticeShown.has(accountId)) {
      this.#connectionNoticeShown.delete(accountId);
      this.#deps.notice({ key: connectionNoticeKey(accountId), level: 'info', text: '', dismiss: true });
    }
  }

  #onSessionFailure(accountId: string, error: string, streak: number): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    this.store.patch(accountId, {
      status: 'error',
      lastError: error.slice(0, 300),
      updatedAt: this.#deps.clock.now(),
    });
    if (streak >= CONNECTION_NOTICE_STREAK && !this.#connectionNoticeShown.has(accountId)) {
      this.#connectionNoticeShown.add(accountId);
      this.#deps.notice({
        key: connectionNoticeKey(accountId),
        level: 'warning',
        text: `「${account.label}」微信连接中断，正在自动重连（${error.slice(0, 120)}）`,
      });
    }
    this.#deps.publishAccount(accountId);
  }

  #onSessionExpired(accountId: string): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    this.store.patch(accountId, {
      status: 'paused',
      lastError: 'iLink 会话暂停（-14），一小时后自动重试',
      updatedAt: this.#deps.clock.now(),
    });
    this.#deps.notice({
      key: connectionNoticeKey(accountId),
      level: 'warning',
      text: `「${account.label}」微信会话被服务器暂停一小时，之后自动恢复`,
    });
    this.#deps.publishAccount(accountId);
  }

  #onAuthFailed(accountId: string): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    this.store.patch(accountId, {
      status: 'auth_failed',
      lastError: '登录已失效，请重新扫码',
      updatedAt: this.#deps.clock.now(),
    });
    this.#deps.notice({
      key: connectionNoticeKey(accountId),
      level: 'error',
      text: `「${account.label}」微信登录已失效：打开扩展中心该插件的管理页重新扫码`,
    });
    this.#deps.publishAccount(accountId);
  }

  #saveCursor(accountId: string, cursor: string): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    const config = imConfig(account);
    this.store.patch(accountId, {
      configJson: JSON.stringify({ ...config, cursor }),
      updatedAt: this.#deps.clock.now(),
    });
  }

  #saveContextToken(accountId: string, token: string): void {
    const account = this.store.get(accountId);
    if (account === null) return;
    const config = imConfig(account);
    const next = { ...config, context_token: token, context_token_at: this.#deps.clock.now() };
    this.store.patch(accountId, {
      configJson: JSON.stringify(next),
      updatedAt: this.#deps.clock.now(),
    });
    this.#contextTokens.set(accountId, token);
  }

  #recentContextToken(accountId: string): string | null {
    const cached = this.#contextTokens.get(accountId);
    if (cached !== undefined) return cached;
    const account = this.store.get(accountId);
    if (account === null) return null;
    try {
      const raw = JSON.parse(account.configJson) as Record<string, unknown>;
      if (typeof raw.context_token !== 'string' || raw.context_token === '') return null;
      return raw.context_token;
    } catch {
      return null;
    }
  }

  readonly #contextTokens = new Map<string, string>();

  // --- RPC 面 -----------------------------------------------------------------------

  listAccounts(): ImAccount[] {
    return this.store.listActive().map((account) => this.publicAccount(account));
  }

  publicAccount(account: ImAccountRecord): ImAccount {
    const bindings = this.store.bindings(account.id);
    const pluginId = this.pluginIdOf(account);
    return {
      id: account.id,
      transport: account.transport,
      apiBase: account.apiBase,
      label: account.label,
      status: account.status,
      lastError: account.lastError,
      lastInboundAt: account.lastInboundAt,
      lastOutboundAt: account.lastOutboundAt,
      config: (() => {
        try {
          const raw = JSON.parse(account.configJson) as Record<string, unknown>;
          const { cursor: _cursor, forward_times: _f, forward_failures: _ff, context_token: _ct, context_token_at: _cta, ...safe } = raw;
          return safe;
        } catch {
          return {};
        }
      })(),
      botIds: bindings.map((binding) => binding.botId),
      forwardBotIds: bindings.filter((binding) => binding.forwardEnabled).map((binding) => binding.botId),
      alertPausedBotIds: bindings.filter((binding) => binding.alertsPaused).map((binding) => binding.botId),
      instanceId: account.instanceId,
      pluginId: pluginId ?? '',
      pluginName: pluginId === null ? null : this.#deps.instanceOwner.pluginName(pluginId),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  setBots(accountId: string, botIds: readonly string[]): void {
    const account = this.store.get(accountId);
    if (account === null) throw new AppError('NOT_FOUND', '账号不存在');
    this.store.replaceBots(accountId, botIds, this.#deps.clock.now());
    this.#deps.publishAccount(accountId);
  }

  setForward(accountId: string, botId: string, enabled: boolean): void {
    const account = this.store.get(accountId);
    if (account === null) throw new AppError('NOT_FOUND', '账号不存在');
    const changed = this.store.setForward(accountId, botId, enabled, this.#deps.clock.now());
    if (changed) this.#deps.publishAccount(accountId);
  }

  async #apiBaseForPlugin(pluginId: string): Promise<string> {
    void pluginId;
    return 'https://ilinkai.weixin.qq.com';
  }
}

export const IM_FORWARD_RETRY_MAX = FORWARD_RETRY_MAX;
export const IM_FORWARD_NOTICE_STREAK = FORWARD_NOTICE_STREAK;
