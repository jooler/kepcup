import type { Conversation, Message } from '@kepcup/shared';
import { messagePreviewText } from '@kepcup/shared';
import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';
import { toast } from 'svelte-sonner';
import { connections, serverHashOf, type SourceId } from '$lib/rpc/connections.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { t } from '$lib/i18n';
import type { FusionStorage } from './fusion-pref';

/**
 * 离开态分身运行时（T10，62.06 §3，开源客户端适配 / 休眠门控）：
 *
 * - 仅桌面融合视图（ENDPOINT_KIND === 'desktop'）注册：web / 手机端不注册
 *   （没有本地大脑）；未连接团队服务器、未设离开、未开分身 = 零行为——
 *   运行时不启动、不订阅任何事件（休眠铁律）。
 * - 激活是显式的：本窗口 `team.presence.setAway` 成功携带分身开关时激活该
 *   来源； deactivated 由 `team.avatarRevoked`（服务端定向撤销）、自己成员的
 *   presence 变化（回来 / 分身被另一端接管清空）或连接断开触发。
 * - 订阅**团队来源**的 dm `message.created`（经 connections 团队来源事件流）；
 *   过滤：他人发送（senderType user 且 senderPrincipalId ≠ 自己）、非
 *   `origin='avatar'`、非 Bot、会话为 dm——分身不回分身 / 不回 Bot（防环护栏）。
 * - 限频：每会话 2 分钟 1 条 + 每来源每小时 10 条（内存态；时钟可注入）。
 * - 生成走**本机** core（`bots.composeReply`：无工具、不注入本机记忆/画像），
 *   代回经成员自己的团队连接 `messages.send`（origin:'avatar' + avatar.botName）。
 * - 回归摘要：离开期间代回条数按 serverHash+memberId 记本机 localStorage，
 *   回到 online 时 toast「离开期间分身代回 N 条」并清零（只存本机）。
 */

/** 每会话代回冷却（毫秒）。 */
export const AVATAR_COOLDOWN_MS = 2 * 60_000;
/** 每来源每小时代回上限。 */
export const AVATAR_HOURLY_LIMIT = 10;
/** 组装代回上下文的最近消息条数。 */
export const AVATAR_TRANSCRIPT_LIMIT = 10;

const PREF_KEY = 'kepcup.team.avatarBot.v1';
const COUNT_KEY = 'kepcup.team.avatarCount.v1';

export interface AvatarRuntimeOptions {
  /** 时钟（单测注入）。 */
  now?: () => number;
  /** localStorage 缝（单测注入；缺省取 globalThis.localStorage）。 */
  storage?: FusionStorage | null;
  /** 回归摘要通知（单测注入；缺省 svelte-sonner toast）。 */
  notify?: (message: string) => void;
}

interface ActiveRuntime {
  source: SourceId;
  memberId: string;
  /** 代回用的本机 Bot（'' = 管家缺省在 send 前解析）。 */
  botId: string;
  unsubs: Array<() => void>;
}

/** 本机 Bot 清单（分身选择器；懒加载缓存）。 */
export interface AvatarBotOption {
  id: string;
  name: string;
  isButler: boolean;
}

function storageOf(options: AvatarRuntimeOptions): FusionStorage | null {
  if (options.storage !== undefined) return options.storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readMap(storage: FusionStorage | null, key: string): Record<string, unknown> {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeMap(
  storage: FusionStorage | null,
  key: string,
  value: Record<string, unknown>,
): void {
  if (storage === null) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私模式：尽力而为。
  }
}

export class AvatarRuntime {
  readonly #options: AvatarRuntimeOptions; /** 每来源的活跃运行时（dormancy: Map 为空 = 零订阅零行为）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 运行端台账（订阅句柄集合），不是 UI 状态。
  readonly #active = new Map<SourceId, ActiveRuntime>();
  /** 每会话上次代回时间（refKey → ts）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 限频台账，不是 UI 状态。
  readonly #lastSentAt = new Map<string, number>();
  /** 每来源的小时窗（serverHash → 时间戳数组）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 限频台账，不是 UI 状态。
  readonly #hourWindow = new Map<string, number[]>();
  /** 本机 Bot 清单缓存（分身选择器 / 名字解析）。 */
  localBots = $state<AvatarBotOption[]>([]);
  #started = false;
  #sourcesUnsub: (() => void) | null = null;

  constructor(options: AvatarRuntimeOptions = {}) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now();
  }

  #notify(message: string): void {
    if (this.#options.notify !== undefined) {
      this.#options.notify(message);
      return;
    }
    toast.success(message);
  }

  /**
   * 应用启动接线（App.svelte 与 connections.start 同处）：桌面端点才挂来源
   * 监听；web / 无端点环境完全休眠（不订阅任何事件）。
   */
  start(): void {
    if (this.#started || ENDPOINT_KIND !== 'desktop') return;
    this.#started = true;
    this.#sourcesUnsub = connections.onSourcesChanged(() => this.#pruneSources());
    this.#pruneSources();
  }

  /** 测试 / teardown：拆掉全部运行端与订阅。 */
  stop(): void {
    for (const runtime of this.#active.values()) {
      for (const unsub of runtime.unsubs) unsub();
    }
    this.#active.clear();
    this.#sourcesUnsub?.();
    this.#sourcesUnsub = null;
    this.#started = false;
  }

  /** 某来源当前是否在跑分身（展示侧）。 */
  isActive(source: SourceId): boolean {
    return this.#active.has(source);
  }

  // --- 分身 Bot 选择（本机；默认管家） -----------------------------------------

  /**
   * 本机 Bot 清单（分身选择器数据源；懒加载）。管家（systemRole 'butler'）排首。
   */
  async loadLocalBots(): Promise<AvatarBotOption[]> {
    try {
      const result = (await connections.get('local').call('bots.list')) as {
        bots: Array<{
          id: string;
          profile: { identity: { name: string } };
          systemRole?: string | null;
          status?: string;
        }>;
      };
      const bots = (result.bots ?? [])
        .filter((bot) => bot.status !== 'deleted')
        .map((bot) => ({
          id: bot.id,
          name: bot.profile.identity.name,
          isButler: bot.systemRole === 'butler',
        }));
      bots.sort((a, b) => (a.isButler === b.isButler ? 0 : a.isButler ? -1 : 1));
      this.localBots = bots;
      return bots;
    } catch {
      return this.localBots;
    }
  }

  #prefKeyOf(serverHash: string, memberId: string): string {
    return `${serverHash}.${memberId}`;
  }

  /** 该来源配置的分身 Bot id（'' = 缺省管家）。 */
  preferredBotId(serverHash: string, memberId: string): string {
    const map = readMap(storageOf(this.#options), PREF_KEY);
    const value = map[this.#prefKeyOf(serverHash, memberId)];
    return typeof value === 'string' ? value : '';
  }

  setPreferredBot(serverHash: string, memberId: string, botId: string): void {
    const storage = storageOf(this.#options);
    const map = readMap(storage, PREF_KEY);
    map[this.#prefKeyOf(serverHash, memberId)] = botId;
    writeMap(storage, PREF_KEY, map);
  }

  /**
   * 解析「这次离开要用的本机 Bot」：显式 id 优先；'' = 缺省管家（本机必有唯一
   * 管家，D70）；都没有时退回第一个可用 Bot。清单未加载时现拉一次。解析不出
   * （本机没有可用 Bot）返回 null——调用方按「不开分身」继续。
   */
  async resolveAvatarBot(botId: string): Promise<AvatarBotOption | null> {
    let bots = this.localBots;
    if (bots.length === 0) bots = await this.loadLocalBots();
    return (
      bots.find((option) => option.id === botId) ??
      bots.find((option) => option.isButler) ??
      bots[0] ??
      null
    );
  }

  // --- 激活 / 停用 -------------------------------------------------------------

  /**
   * 激活某来源的分身运行端（`awayState.setAway` 成功携带分身开关时调用）。
   * `botId` 为空 = 缺省管家（本机 systemRole 'butler'）。幂等：重复激活先拆旧
   * 订阅再重建。
   */
  activate(source: SourceId, botId: string): void {
    if (ENDPOINT_KIND !== 'desktop') return;
    const conn = connections.get(source);
    if (conn.status !== 'connected') return;
    const memberId = contacts.teamSelfOf(source)?.id ?? conn.memberId;
    if (memberId === null) return;
    this.deactivate(source, { silent: true });
    const unsubs: Array<() => void> = [];
    unsubs.push(
      conn.onEvent('message.created', (payload) => {
        void this.#onTeamMessage(source, payload);
      }),
    );
    unsubs.push(
      conn.onEvent('conversation.updated', (payload) => {
        // 自己会话的视图刷新只用于类型缓存预热；非 dm / 非本人会话无副作用。
        const data = payload as { conversation: Conversation };
        this.#conversationTypes.set(data.conversation.id, data.conversation.type);
      }),
    );
    unsubs.push(
      conn.onTeamEvent('team.avatarRevoked', (payload) => {
        const data = payload as { memberId?: string; targetClientId?: string };
        if (data.memberId !== memberId) return;
        // 定向撤销只命中运行端连接；未带 targetClientId 的成员级撤销同样停用。
        if (data.targetClientId !== undefined && data.targetClientId !== conn.clientIdentity.id) {
          return;
        }
        this.deactivate(source, { silent: true });
      }),
    );
    unsubs.push(
      conn.onTeamEvent('member.presenceChanged', (payload) => {
        const data = payload as { memberId?: string; state?: string };
        if (data.memberId !== memberId) return;
        if (data.state !== 'away') {
          // 回来（或被另一端取消离开）：停用并出回归摘要。
          this.deactivate(source, { silent: false });
        }
      }),
    );
    this.#active.set(source, { source, memberId, botId, unsubs });
    void this.loadLocalBots();
  }

  /**
   * 停用某来源的运行端。`silent` = 不出回归摘要（接管撤销 / 重复激活）；
   * 出摘要时读本机计数、toast 后清零（62.06 离开简报只存本机）。
   */
  deactivate(source: SourceId, options: { silent?: boolean } = {}): void {
    const runtime = this.#active.get(source);
    if (runtime === undefined) return;
    for (const unsub of runtime.unsubs) unsub();
    this.#active.delete(source);
    if (options.silent === true) return;
    const hash = serverHashOf(source);
    if (hash === null) return;
    const count = this.takeSummaryCount(hash, runtime.memberId);
    if (count > 0) {
      this.#notify(t('team.avatarSummaryToast', { count: String(count) }));
    }
  }

  // --- 回归摘要计数（本机 localStorage，serverHash+memberId 键） ---------------

  #countKeyOf(serverHash: string, memberId: string): string {
    return `${serverHash}.${memberId}`;
  }

  takeSummaryCount(serverHash: string, memberId: string): number {
    const storage = storageOf(this.#options);
    const map = readMap(storage, COUNT_KEY);
    const key = this.#countKeyOf(serverHash, memberId);
    const value = map[key];
    delete map[key];
    writeMap(storage, COUNT_KEY, map);
    return typeof value === 'number' ? Math.floor(value) : 0;
  }

  #bumpSummaryCount(serverHash: string, memberId: string): void {
    const storage = storageOf(this.#options);
    const map = readMap(storage, COUNT_KEY);
    const key = this.#countKeyOf(serverHash, memberId);
    const value = map[key];
    map[key] = (typeof value === 'number' ? value : 0) + 1;
    writeMap(storage, COUNT_KEY, map);
  }

  // --- 限频（内存态；时钟注入） ------------------------------------------------

  #canSend(source: SourceId, conversationId: string): boolean {
    const now = this.#now();
    const hash = serverHashOf(source);
    const last = this.#lastSentAt.get(`${hash ?? 'local'}::${conversationId}`);
    if (last !== undefined && now - last < AVATAR_COOLDOWN_MS) return false;
    const window = this.#hourWindow.get(hash ?? 'local') ?? [];
    const cutoff = now - 60 * 60_000;
    const recent = window.filter((ts) => ts > cutoff);
    return recent.length < AVATAR_HOURLY_LIMIT;
  }

  #recordSend(source: SourceId, conversationId: string): void {
    const now = this.#now();
    const hash = serverHashOf(source);
    const key = `${hash ?? 'local'}::${conversationId}`;
    this.#lastSentAt.set(key, now);
    const window = (this.#hourWindow.get(hash ?? 'local') ?? []).filter(
      (ts) => ts > now - 60 * 60_000,
    );
    window.push(now);
    this.#hourWindow.set(hash ?? 'local', window);
  }

  // --- 消息处理（防环护栏在过滤器里） -----------------------------------------

  /** dm 类型缓存（conversations.get 一次；失败不缓存重试）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 会话类型缓存，不是 UI 状态。
  readonly #conversationTypes = new Map<string, Conversation['type']>();

  async #conversationType(
    source: SourceId,
    conversationId: string,
  ): Promise<Conversation['type'] | null> {
    const cached = this.#conversationTypes.get(conversationId);
    if (cached !== undefined) return cached;
    try {
      const result = (await connections
        .get(source)
        .call('conversations.get', { id: conversationId })) as {
        conversation: Conversation | null;
      };
      if (result.conversation === null) return null;
      this.#conversationTypes.set(conversationId, result.conversation.type);
      return result.conversation.type;
    } catch {
      return null;
    }
  }

  async #onTeamMessage(source: SourceId, payload: unknown): Promise<void> {
    const runtime = this.#active.get(source);
    if (runtime === undefined) return;
    const conn = connections.get(source);
    if (conn.status !== 'connected') {
      this.deactivate(source, { silent: true });
      return;
    }
    const data = payload as { conversationId?: string; message?: Message };
    const conversationId = data.conversationId;
    const message = data.message;
    if (conversationId === undefined || message === undefined) return;

    // 防环护栏（62.06 §3）：分身不回 avatar 消息、不回 Bot 消息；只回**他人**
    // 发来的用户消息。任何一条不满足即静默忽略（分身对非 dm 会话零行为）。
    if (message.senderType !== 'user') return;
    // content 是按 kind 的联合：origin 只在部分内容形态上有，用窄化读。
    const origin = (message.content as { origin?: unknown } | null | undefined)?.origin;
    if (origin === 'avatar') return;
    const sender = message.senderPrincipalId;
    if (sender !== null && sender !== undefined && sender === runtime.memberId) return;

    const type = await this.#conversationType(source, conversationId);
    if (type !== 'dm') return;
    if (!this.#canSend(source, conversationId)) return;

    let sent: boolean;
    try {
      sent = await this.#composeAndSend(source, runtime, conversationId);
    } catch {
      sent = false;
    }
    if (sent) {
      this.#recordSend(source, conversationId);
      this.#bumpSummaryCount(serverHashOf(source) ?? 'local', runtime.memberId);
    }
  }

  /** 组装 transcript → 本机 composeReply → 团队连接代回。返回是否成功发送。 */
  async #composeAndSend(
    source: SourceId,
    runtime: ActiveRuntime,
    conversationId: string,
  ): Promise<boolean> {
    const conn = connections.get(source);
    const self = contacts.teamSelfOf(source);
    const selfName = self?.displayName ?? '';
    const conversation = await this.#conversationView(source, conversationId);
    const peerId =
      (conversation?.peerPrincipalIds ?? []).find((id) => id !== runtime.memberId) ?? null;
    const peer = peerId === null ? null : contacts.teamMemberById(source, peerId);
    const peerName = peer?.displayName || peerId || '';
    if (selfName.length === 0 || peerName.length === 0) return false;

    const listing = (await conn.call('messages.list', {
      conversationId,
      limit: AVATAR_TRANSCRIPT_LIMIT,
    })) as { messages: Message[] };
    const transcript = (listing.messages ?? [])
      .map((entry) => ({ entry, text: messagePreviewText(entry) }))
      .filter(
        (row): row is { entry: Message; text: string } => row.text !== null && row.text.length > 0,
      )
      .slice(-AVATAR_TRANSCRIPT_LIMIT)
      .map((row) => ({
        speaker:
          row.entry.senderType === 'user'
            ? row.entry.senderPrincipalId === runtime.memberId
              ? selfName
              : peerName
            : 'Bot',
        text: row.text,
      }));
    if (transcript.length === 0) return false;

    // 分身 Bot：用户选的本机 Bot；'' = 缺省管家（本机必有唯一管家，D70）。
    const bot = await this.resolveAvatarBot(runtime.botId);
    if (bot === undefined || bot === null) return false;

    // 提示词明示代答边界（62.06 §3 护栏）：不承诺、不披露本机私人信息。
    const instructions = t('team.avatarComposeInstructions', {
      self: selfName,
      peer: peerName,
    });
    const composed = (await connections.get('local').call('bots.composeReply', {
      botId: bot.id,
      transcript,
      instructions,
    })) as { text: string };
    const text = composed.text?.trim();
    if (text === undefined || text.length === 0) return false;

    const identity = conn.clientIdentity;
    await conn.call('messages.send', {
      conversationId,
      text,
      origin: 'avatar' as const,
      avatar: { botName: bot.name },
      client: { id: identity.id, name: identity.name },
    });
    return true;
  }

  async #conversationView(source: SourceId, conversationId: string): Promise<Conversation | null> {
    try {
      const result = (await connections
        .get(source)
        .call('conversations.get', { id: conversationId })) as {
        conversation: Conversation | null;
      };
      return result.conversation;
    } catch {
      return null;
    }
  }

  /** 来源消失（取消融合 / 移除服务器）：运行端一并拆除（不出摘要）。 */
  #pruneSources(): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 来源快照，非 UI 状态。
    const sources = new Set(connections.sources());
    for (const source of [...this.#active.keys()]) {
      if (!sources.has(source)) this.deactivate(source, { silent: true });
    }
  }
}

/** 单例（away-state / TeamSection 消费；测试直接 new AvatarRuntime(options)）。 */
export const avatarRuntime = new AvatarRuntime();
