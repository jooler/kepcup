import { randomBytes } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  AppError,
  CONNECTOR_META_KEY,
  LOCAL_CONNECTORS_MAX,
  LOCAL_CONNECTOR_DESCRIPTION_MAX,
  LOCAL_CONNECTOR_GATE,
  LOCAL_CONNECTOR_ICON,
  LOCAL_CONNECTOR_PROPOSAL_TTL_MS,
  LOCAL_CONNECTOR_TITLE_MAX,
  LOCAL_CONNECTOR_VERSION,
  connectorCategorySchema,
  connectorMetaOf,
  connectorRemoteOf,
  createLocalConnectorRecordSchema,
  isSafeDocUrl,
  isSafeLocalConnectorUrl,
  localConnectorName,
  localConnectorOrigin,
  localConnectorSlug,
  sanitizeLocalConnectorText,
  type ConnectorCatalogEntry,
  type LocalConnectorCard,
  type LocalConnectorRecord,
  type LocalConnectorView,
} from '@kepcup/shared';
import type { McpFetch } from '@earendil-works/pi-mcp';
import type { SettingsService } from '../domain/settings.js';
import type { Clock } from '../infra/clock.js';
import type { EventBus } from '../infra/events.js';
import type { CoreLogger } from '../infra/logger.js';
import { sharedSafeDispatcher } from '../infra/safe-dispatcher.js';
import type { CoreEventsMap } from '../start-types.js';
import type { AppAuditor } from './audit.js';
import { createSafeFetch, isLoopbackAllowed } from './auth/safe-fetch.js';
import type { LocalConnectorSource } from './catalog.js';
import type { AppConnectionStore } from './connection-store.js';
import type { AppDisconnector } from './disconnect.js';
import { probeLocalConnector, type LocalProbeResult } from './local-connector-probe.js';

/**
 * 本机连接（docs/design/29-connected-apps.md §17，todo/local-connector-authoring.md §2）。
 *
 * - **数据**：条目存 `settings.apps.localConnectors`（slug → {@link LocalConnectorRecord}），读取时逐条
 *   校验，坏条目告警后丢弃。同时是目录的 `local()` 来源（{@link LocalConnectorSource}）。
 * - **提案**：Bot 经 `app_propose_local_connector` 给出地址 + 展示文本；这里做 SSRF 安全的探测，
 *   条目内容**只**由探测结果与清洗后的展示文本生成，放进内存里的一次性提案（带 TTL，用 Clock），并
 *   生成确认卡载荷。Bot 自己不能保存：落库只经 {@link confirm}（RPC，用户在卡片上点「添加」）。
 * - **删除**：先断开该条目的全部连接（吊销 + 清令牌 / DCR 客户端，沿用 `AppDisconnector`），再删条目。
 *
 * 开发者模式关闭时：不能提案、不能确认；已有条目保留；`remove` 任何时候都可用。
 */

/** 内存中同时保留的待确认提案上限（Bot 反复提案不能无限占内存）。 */
const PROPOSALS_MAX = 10;

export interface LocalConnectorsDeps {
  settings: Pick<SettingsService, 'get' | 'update'>;
  clock: Clock;
  logger: CoreLogger;
  events: Pick<EventBus<CoreEventsMap>, 'emit'>;
  auditor: AppAuditor;
  store: Pick<AppConnectionStore, 'listByConnector'>;
  disconnector: Pick<AppDisconnector, 'disconnect'>;
  /** 允许明文 / 回环端点的主机；生产恒为空，仅 NODE_ENV=test 的构建可注入。 */
  loopbackAllowlist: readonly string[];
  /** 提案 id 生成（测试可替换）；缺省 24 字节随机。 */
  newProposalId?: (() => string) | undefined;
}

interface Proposal {
  id: string;
  record: LocalConnectorRecord;
  card: LocalConnectorCard;
  expiresAt: number;
  botId: string | null;
  conversationId: string | null;
}

export interface ProposeInput {
  mcpUrl: string;
  title: string;
  description?: string | undefined;
  category?: string | undefined;
  docUrl?: string | undefined;
}

export interface ProposeContext {
  botId: string | null;
  conversationId: string | null;
  signal?: AbortSignal | undefined;
}

export type ProposeResult =
  | { kind: 'proposed'; proposalId: string; card: LocalConnectorCard }
  /** 同一 origin 已经添加过：返回已有条目，不再发确认卡。 */
  | { kind: 'existing'; connectorId: string; title: string };

/** 冲突检查需要的目录视图（`ConnectorCatalog` 满足）。 */
export interface LocalConnectorsCatalog {
  list(): readonly ConnectorCatalogEntry[];
  isLocal(slug: string): boolean;
}

export class LocalConnectors implements LocalConnectorSource {
  readonly #deps: LocalConnectorsDeps;
  readonly #schema: ReturnType<typeof createLocalConnectorRecordSchema>;
  readonly #proposals = new Map<string, Proposal>();
  #revision = 0;
  /** 已告警过的坏条目 slug（每次装载都告警会刷屏）。 */
  readonly #warned = new Set<string>();
  /** 目录（装载后接入）：冲突检查需要看打包 / 远端条目。 */
  #catalog: LocalConnectorsCatalog | null = null;

  constructor(deps: LocalConnectorsDeps) {
    this.#deps = deps;
    this.#schema = createLocalConnectorRecordSchema({ allowInsecureHosts: deps.loopbackAllowlist });
  }

  attachCatalog(catalog: LocalConnectorsCatalog): void {
    this.#catalog = catalog;
  }

  get catalog(): LocalConnectorsCatalog {
    if (this.#catalog === null) throw new AppError('NOT_IMPLEMENTED', '应用目录未就绪');
    return this.#catalog;
  }

  // --- 目录来源 -------------------------------------------------------------------------

  revision(): number {
    return this.#revision;
  }

  entries(): readonly ConnectorCatalogEntry[] {
    return this.#records().map((record) => record.entry);
  }

  /** 读设置并逐条校验（至多 {@link LOCAL_CONNECTORS_MAX} 条，量很小；不缓存，设置是唯一事实来源）。 */
  #records(): LocalConnectorRecord[] {
    const stored = this.#deps.settings.get().apps.localConnectors;
    const records: LocalConnectorRecord[] = [];
    for (const [slug, raw] of Object.entries(stored)) {
      const parsed = this.#schema.safeParse(raw);
      if (!parsed.success || connectorMetaOf(parsed.data.entry).slug !== slug) {
        if (!this.#warned.has(slug)) {
          this.#warned.add(slug);
          this.#deps.logger.warn(
            {
              slug,
              issues: parsed.success
                ? ['slug key mismatch']
                : parsed.error.issues.slice(0, 3).map((issue) => issue.message),
            },
            'local connector record rejected',
          );
        }
        continue;
      }
      records.push(parsed.data);
    }
    records.sort((a, b) => a.addedAt - b.addedAt || a.entry.name.localeCompare(b.entry.name));
    return records;
  }

  // --- 读 -------------------------------------------------------------------------------

  list(): LocalConnectorView[] {
    return this.#records().map((record) => {
      const meta = connectorMetaOf(record.entry);
      const connections = this.#deps.store.listByConnector(meta.slug);
      const url = connectorRemoteOf(record.entry)!.url;
      return {
        connectorId: meta.slug,
        title: record.entry.title,
        description: record.entry.description,
        category: meta.category,
        mcpUrl: url,
        mcpHost: new URL(url).host,
        addedAt: record.addedAt,
        ...(record.sourceDocUrl !== undefined ? { sourceDocUrl: record.sourceDocUrl } : {}),
        connectedAccounts: connections.length,
        connectionIds: connections.map((connection) => connection.id),
      };
    });
  }

  developerMode(): boolean {
    return this.#deps.settings.get().apps.developerMode;
  }

  // --- 提案 -----------------------------------------------------------------------------

  /**
   * 探测并生成提案。抛 `DEVELOPER_MODE_REQUIRED` / `LOCAL_CONNECTOR_REJECTED`（message = 具体原因）。
   * 条目内容只取自探测结果和清洗后的展示文本，绝不取 Bot 转述的认证 / 范围 / 域名。
   */
  async propose(input: ProposeInput, context: ProposeContext): Promise<ProposeResult> {
    this.#requireDeveloperMode();
    const reject = (message: string): AppError => new AppError('LOCAL_CONNECTOR_REJECTED', message);

    const title = sanitizeLocalConnectorText(input.title, LOCAL_CONNECTOR_TITLE_MAX);
    if (title.length === 0) throw reject('需要提供 title（展示名）');
    const rawUrl = input.mcpUrl.trim();
    const allowlisted = this.#allowlisted(rawUrl);
    if (!allowlisted && !isSafeLocalConnectorUrl(rawUrl)) {
      throw reject(
        'mcpUrl 必须是 https 域名地址：不能是 http、IP 地址、localhost 或内网域名，也不能带用户名密码、? 查询串或 # 片段',
      );
    }
    const url = new URL(rawUrl);
    const origin = localConnectorOrigin(url.href);
    if (origin === null) throw reject('mcpUrl 不是合法的地址');
    const slug = localConnectorSlug(origin);

    // 同一 origin 已添加：返回已有条目（不再发确认卡）。
    const existing = this.#records().find((record) => connectorMetaOf(record.entry).slug === slug);
    if (existing !== undefined) {
      return { kind: 'existing', connectorId: slug, title: existing.entry.title };
    }
    this.#sweepExpired();
    if (this.#records().length >= LOCAL_CONNECTORS_MAX) {
      throw reject(`本机连接已达上限（${LOCAL_CONNECTORS_MAX} 个），请先在扩展中心删除不用的`);
    }
    // 目录里已有同一服务（打包 / 远端条目）：直接用那个，不再生成未审核的副本。
    for (const entry of this.catalog.list()) {
      if (this.catalog.isLocal(connectorMetaOf(entry).slug)) continue;
      const remote = connectorRemoteOf(entry);
      if (remote !== null && localConnectorOrigin(remote.url) === origin) {
        throw reject(`该服务已经在应用目录里（「${entry.title}」），请直接请求连接它，不需要本机连接`);
      }
    }

    const probe = await probeLocalConnector(url.href, {
      fetch: createSafeFetch({ loopbackHosts: this.#deps.loopbackAllowlist }),
      loopbackAllowlist: this.#deps.loopbackAllowlist,
      signal: context.signal,
    });

    const description =
      sanitizeLocalConnectorText(input.description ?? '', LOCAL_CONNECTOR_DESCRIPTION_MAX) ||
      `通过本机连接添加的 MCP 服务（${url.host}）`;
    const category = connectorCategorySchema.safeParse(
      sanitizeLocalConnectorText(input.category ?? '', 20).toLowerCase(),
    );
    const docUrl =
      input.docUrl !== undefined && isSafeDocUrl(input.docUrl.trim())
        ? input.docUrl.trim()
        : undefined;

    const entry: ConnectorCatalogEntry = {
      name: localConnectorName(slug),
      title,
      description,
      version: LOCAL_CONNECTOR_VERSION,
      remotes: [{ type: 'streamable-http', url: url.href }],
      packages: [],
      _meta: {
        [CONNECTOR_META_KEY]: {
          slug,
          icon: LOCAL_CONNECTOR_ICON,
          category: category.success ? category.data : 'other',
          tier: 'developer',
          auth: {
            kind: 'oauth',
            registration: 'auto',
            clientRef: null,
            scopes: { default: probe.scopes, write: [] },
          },
          toolPolicy: {},
          skills: [],
          ui: false,
          // 本机条目没有隐私政策：占位为服务自己的站点（界面不应把它当成「已审核的隐私政策」展示）。
          privacyPolicy: `${origin}/`,
          releaseGate: LOCAL_CONNECTOR_GATE,
        },
      },
    };
    const record = this.#schema.safeParse({
      entry,
      addedAt: this.#deps.clock.now(),
      ...(docUrl !== undefined ? { sourceDocUrl: docUrl } : {}),
    });
    if (!record.success) {
      // 不应发生（上面的输入都已校验）：fail closed，并留日志。
      this.#deps.logger.warn(
        { issues: record.error.issues.slice(0, 3).map((issue) => issue.message) },
        'local connector proposal failed validation',
      );
      throw reject('生成的条目未通过校验，已拒绝');
    }
    // 与目录里其它条目的 slug / name 冲突（理论上不会：本机 slug 以 l 开头加 12 位十六进制）。
    for (const other of this.catalog.list()) {
      if (this.catalog.isLocal(connectorMetaOf(other).slug)) continue;
      if (connectorMetaOf(other).slug === slug || other.name === entry.name) {
        throw reject('与应用目录里已有条目的标识冲突，已拒绝');
      }
    }

    const now = this.#deps.clock.now();
    const id = this.#deps.newProposalId?.() ?? `lcp_${randomBytes(24).toString('base64url')}`;
    const expiresAt = now + LOCAL_CONNECTOR_PROPOSAL_TTL_MS;
    const card = buildCard({
      proposalId: id,
      entry,
      url: url.href,
      host: url.host,
      docUrl,
      probe,
      expiresAt,
    });
    // 同一服务的旧提案作废（最新一次探测为准）。
    for (const [key, previous] of this.#proposals) {
      if (connectorMetaOf(previous.record.entry).slug === slug) this.#proposals.delete(key);
    }
    while (this.#proposals.size >= PROPOSALS_MAX) {
      const oldest = this.#proposals.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#proposals.delete(oldest);
    }
    this.#proposals.set(id, {
      id,
      record: record.data,
      card,
      expiresAt,
      botId: context.botId,
      conversationId: context.conversationId,
    });
    this.#deps.logger.info(
      { slug, host: url.host, registration: probe.registration, issuerHost: probe.issuerHost },
      'local connector proposal created',
    );
    return { kind: 'proposed', proposalId: id, card };
  }

  /** 用户在确认卡上点「取消」：丢弃提案（幂等）。 */
  reject(proposalId: string): void {
    this.#proposals.delete(proposalId);
  }

  /**
   * 用户在确认卡上点「添加」：一次性消费提案并落库。开发者模式关闭 → `DEVELOPER_MODE_REQUIRED`；
   * 提案不存在 / 已用过 / 过期 → `LOCAL_CONNECTOR_EXPIRED`。
   */
  confirm(proposalId: string): { connectorId: string; title: string } {
    this.#requireDeveloperMode();
    const proposal = this.#proposals.get(proposalId);
    // 一次性：无论成败都不能再用同一个 id。
    this.#proposals.delete(proposalId);
    if (proposal === undefined || proposal.expiresAt <= this.#deps.clock.now()) {
      throw new AppError('LOCAL_CONNECTOR_EXPIRED', '这个添加请求已过期或已处理，请让 Bot 重新发起');
    }
    const meta = connectorMetaOf(proposal.record.entry);
    const current = this.#deps.settings.get().apps;
    const already = this.#records().find((item) => connectorMetaOf(item.entry).slug === meta.slug);
    if (already !== undefined) return { connectorId: meta.slug, title: already.entry.title };
    if (this.#records().length >= LOCAL_CONNECTORS_MAX) {
      throw new AppError('LOCAL_CONNECTOR_REJECTED', `本机连接已达上限（${LOCAL_CONNECTORS_MAX} 个）`);
    }
    // 提案之后目录可能新增了同服务的条目（远端同步）：落库前再核一次。
    for (const entry of this.catalog.list()) {
      if (this.catalog.isLocal(connectorMetaOf(entry).slug)) continue;
      const remote = connectorRemoteOf(entry);
      const origin = localConnectorOrigin(connectorRemoteOf(proposal.record.entry)!.url);
      if (
        connectorMetaOf(entry).slug === meta.slug ||
        entry.name === proposal.record.entry.name ||
        (remote !== null && localConnectorOrigin(remote.url) === origin)
      ) {
        throw new AppError('LOCAL_CONNECTOR_REJECTED', `该服务已经在应用目录里（「${entry.title}」）`);
      }
    }
    this.#deps.settings.update({
      apps: {
        ...current,
        localConnectors: { ...current.localConnectors, [meta.slug]: proposal.record },
      },
    });
    this.#bump();
    this.#deps.events.emit('apps.catalog_changed', { connectorId: meta.slug, change: 'added' });
    this.#deps.auditor.auditLocalConnectorAdd({
      connectorId: meta.slug,
      host: proposal.card.mcpHost,
      botId: proposal.botId,
      conversationId: proposal.conversationId,
    });
    this.#deps.logger.info({ slug: meta.slug, host: proposal.card.mcpHost }, 'local connector added');
    return { connectorId: meta.slug, title: proposal.record.entry.title };
  }

  /**
   * 删除本机条目：先断开它的全部连接（吊销 + 清令牌 / DCR 客户端 / Bot 勾选），再删条目。
   * 任何时候都可用（含开发者模式已关闭）。幂等：条目不存在 → `NOT_FOUND`。
   */
  async remove(connectorId: string): Promise<void> {
    const current = this.#deps.settings.get().apps;
    // 以存储为准（损坏的记录也要能删掉），不以校验后的视图为准。
    if (current.localConnectors[connectorId] === undefined) {
      throw new AppError('NOT_FOUND', `没有本机连接「${connectorId}」`);
    }
    const record = this.#records().find(
      (item) => connectorMetaOf(item.entry).slug === connectorId,
    );
    const host =
      record !== undefined ? new URL(connectorRemoteOf(record.entry)!.url).host : '(invalid)';
    const sweep = async (): Promise<void> => {
      for (const connection of this.#deps.store.listByConnector(connectorId)) {
        await this.#deps.disconnector.disconnect(connection.id, { removeRow: true });
      }
    };
    await sweep();
    const latest = this.#deps.settings.get().apps;
    const { [connectorId]: _removed, ...rest } = latest.localConnectors;
    this.#deps.settings.update({ apps: { ...latest, localConnectors: rest } });
    this.#bump();
    // 删除条目的瞬间若有新连接（刚好在授权完成）落地，一并收掉，避免孤儿。
    await sweep();
    for (const [key, proposal] of this.#proposals) {
      if (connectorMetaOf(proposal.record.entry).slug === connectorId) this.#proposals.delete(key);
    }
    this.#deps.events.emit('apps.catalog_changed', { connectorId, change: 'removed' });
    this.#deps.auditor.auditLocalConnectorRemove({
      connectorId,
      host,
      botId: null,
      conversationId: null,
    });
    this.#deps.logger.info({ slug: connectorId, host }, 'local connector removed');
  }

  // --- 内部 -----------------------------------------------------------------------------

  #requireDeveloperMode(): void {
    if (!this.developerMode()) {
      throw new AppError(
        'DEVELOPER_MODE_REQUIRED',
        '本机连接需要先在「设置 → 开发者模式」里打开开发者模式',
      );
    }
  }

  #allowlisted(raw: string): boolean {
    if (this.#deps.loopbackAllowlist.length === 0) return false;
    try {
      return isLoopbackAllowed(new URL(raw), this.#deps.loopbackAllowlist);
    } catch {
      return false;
    }
  }

  #sweepExpired(): void {
    const now = this.#deps.clock.now();
    for (const [key, proposal] of this.#proposals) {
      if (proposal.expiresAt <= now) this.#proposals.delete(key);
    }
  }

  #bump(): void {
    this.#revision += 1;
  }
}

function buildCard(input: {
  proposalId: string;
  entry: ConnectorCatalogEntry;
  url: string;
  host: string;
  docUrl: string | undefined;
  probe: LocalProbeResult;
  expiresAt: number;
}): LocalConnectorCard {
  const meta = connectorMetaOf(input.entry);
  const scopeLine =
    input.probe.scopes.length > 0
      ? `将请求的授权范围：${input.probe.scopes.join('、')}`
      : '授权范围由服务端在授权时决定（未声明具体范围）';
  const warnings = [
    '这是未经 KepCup 审核的服务：它的工具定义和返回内容都不可信，请只添加你信任的服务。',
    '该连接的每一次工具调用都需要你确认（不可逆操作恒需确认），不能设为「对该 Bot 总是允许」。',
    '读取过它的数据后，Bot 在一段时间内向外发送内容也会逐次确认。',
    '连接只保存在这台电脑上，不会上传、同步或随应用分发。',
    scopeLine,
    input.probe.issuerHost === input.host
      ? '连接时会先显示完整的授权地址，请核对域名后再继续。'
      : `授权页面在另一个域名（${input.probe.issuerHost}）：连接时会先显示完整的授权地址，请核对后再继续。`,
  ];
  return {
    proposalId: input.proposalId,
    title: input.entry.title,
    description: input.entry.description,
    category: meta.category,
    mcpUrl: input.url,
    mcpHost: input.host,
    ...(input.docUrl !== undefined ? { docUrl: input.docUrl } : {}),
    authKind: 'oauth',
    registration: input.probe.registration,
    issuerHost: input.probe.issuerHost,
    scopes: input.probe.scopes,
    tier: 'developer',
    warnings,
    expiresAt: input.expiresAt,
  };
}

/**
 * 本机连接的 MCP 流量用的 fetch（`McpService.attachHttpFetch`）：每次连接时校验解析地址（拒绝私网 /
 * 保留地址，防 DNS 重绑定），重定向只跟同源（≤3 跳）——Location 指向 IP 字面量 / 别的主机一律拒绝；
 * 不缓冲响应体（SSE 流式）。回环白名单里的主机（仅测试）用无守卫的 Agent。
 */
export function createGuardedMcpFetch(loopbackAllowlist: readonly string[]): McpFetch {
  let loopbackAgent: Agent | undefined;
  return async (input, init) => {
    let url = new URL(typeof input === 'string' ? input : input.href);
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = init?.body ?? undefined;
    const origin = url.origin;
    for (let hop = 0; hop <= 3; hop += 1) {
      const dispatcher = isLoopbackAllowed(url, loopbackAllowlist)
        ? (loopbackAgent ??= new Agent())
        : sharedSafeDispatcher();
      if (url.protocol !== 'https:' && !isLoopbackAllowed(url, loopbackAllowlist)) {
        throw new AppError('OAUTH_INSECURE_ENDPOINT', '本机连接的 MCP 请求必须使用 https');
      }
      const response = (await undiciFetch(url, {
        ...(init as Record<string, unknown>),
        method,
        body: body as never,
        redirect: 'manual',
        dispatcher,
      } as never)) as unknown as Response;
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        void response.body?.cancel().catch(() => undefined);
        const next = new URL(response.headers.get('location') as string, url);
        if (next.origin !== origin) {
          throw new AppError('OAUTH_INSECURE_ENDPOINT', '本机连接的 MCP 请求不允许跨源重定向');
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
      return response;
    }
    throw new AppError('OAUTH_INSECURE_ENDPOINT', '重定向跳数过多');
  };
}
