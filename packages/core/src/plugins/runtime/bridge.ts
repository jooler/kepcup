import dns from 'node:dns/promises';
import net from 'node:net';
import {
  AppError,
  PLUGIN_RUNTIME_NET_MAX_BYTES,
  PLUGIN_RUNTIME_NET_MAX_TIMEOUT_MS,
  type PluginFieldValue,
  type PluginHostApiRequest,
  type PluginHostNetResponse,
  type PluginRuntimeProgressPayload,
} from '@kepcup/shared';
import { fetch as undiciFetch } from 'undici';
import {
  assertNoPrivateAddress,
  connectRejectionText,
  sharedSafeDispatcher,
} from '../../infra/safe-dispatcher.js';
import type { CoreLogger } from '../../infra/logger.js';
import { pluginSecretScope, type PluginInstanceRow } from '../instances.js';
import type { PluginRegistry } from '../registry.js';
import type { PluginStorageStore } from './storage.js';

/**
 * 能力桥（D125 P2，docs/design/61-plugin-runtime-platform.md §4 / §3.3）：
 * 插件进程 → 宿主基础能力的唯一通道，白名单与配额在这里强制，插件拿不到裸能力。
 *
 * - `net.fetch`：清单 `runtime.network.allow` 域名匹配（精确 host 或 `*.domain`，大小写
 *   不敏感）→ 不命中 `PLUGIN_NETWORK_DENIED`；SSRF 守卫**复用** `infra/safe-dispatcher`
 *   （web_fetch 的同一份逻辑：解析后私网 / 元数据拒绝 + 连接时逐跳校验），逐跳复检
 *   重定向；单次响应 ≤20MB；文本 / JSON 直返、二进制 base64；每插件每域计数进日志。
 * - `credentials`：调用时从实例凭据（secrets 前缀扫描，只含实例 sensitive 字段）组装，
 *   **永不写日志、永不进历史、永不进错误消息**。
 * - `secrets.get`：键必须属于本插件的实例前缀（`plugin:{pluginId}:instance:*`）；
 *   只读（Q1 未决，61 §10）。
 * - `storage`：`plugin_storage` 表 + 10MB 配额（写前聚合校验）。
 * - `progress`：限速透传（≤1 次/秒），由 PluginHost 在转发进 run 进度通道前使用
 *   {@link ProgressRelay}。
 *
 * 本类只做能力裁决；进程 / 队列 / 超时归 PluginHost。
 */

/** 一次调用的进度透传限速器（宿主侧第二道防线，SDK 侧已限速一次）。 */
export class ProgressRelay {
  readonly #emit: (payload: PluginRuntimeProgressPayload) => void;
  readonly #minIntervalMs: number;
  #lastSentAt = 0;

  constructor(emit: (payload: PluginRuntimeProgressPayload) => void, minIntervalMs = 1_000) {
    this.#emit = emit;
    this.#minIntervalMs = minIntervalMs;
  }

  push(payload: PluginRuntimeProgressPayload): void {
    const now = Date.now();
    if (now - this.#lastSentAt < this.#minIntervalMs) return;
    this.#lastSentAt = now;
    this.#emit(payload);
  }
}

/** 域名白名单判定：精确 host 或 `*.domain`（通配只匹配子域，大小写不敏感）。 */
export function isHostAllowed(host: string, allow: readonly string[]): boolean {
  const candidate = host.toLowerCase();
  for (const entry of allow) {
    const rule = entry.trim().toLowerCase();
    if (rule.startsWith('*.')) {
      const domain = rule.slice(2);
      if (domain.length === 0) continue;
      if (candidate.length > domain.length && candidate.endsWith(`.${domain}`)) return true;
      continue;
    }
    if (candidate === rule) return true;
  }
  return false;
}

export interface PluginRuntimePolicy {
  pluginId: string;
  networkAllow: readonly string[];
  maxConcurrent: number;
  storageQuotaBytes: number;
}

export interface CapabilityBridgeDeps {
  registry: Pick<PluginRegistry, 'manifestOf'>;
  instances: { list(pluginId: string): PluginInstanceRow[] };
  secrets: { getValue(name: string): string | null; names(): string[] };
  storage: PluginStorageStore;
  logger: CoreLogger;
  /** 测试缝：注入 fetch（不走 SSRF dispatcher；白名单仍强制）。 */
  fetchImpl?: typeof fetch;
  /** 测试缝：注入 DNS 解析（模拟私网地址 / DNS rebinding）。 */
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  /**
   * 测试缝：单次 `net.fetch` 的宿主默认超时（生产不注入 = 用
   * {@link PLUGIN_RUNTIME_NET_MAX_TIMEOUT_MS} 兜底；插件可用 `init.timeoutMs` 声明更短值）。
   */
  netTimeoutMs?: number;
}

const MAX_REDIRECTS = 5;
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; KepCup-Plugin/1.0; +https://kepcup.app)';

/** 能力桥发出的请求形状（global fetch 与 undici fetch 的类型不一致，这里收窄后断言）。 */
interface NetRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  redirect: 'manual';
  signal: AbortSignal;
}

function isTextContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base.endsWith('+json') ||
    base === 'application/xml' ||
    base.endsWith('+xml') ||
    base === 'application/javascript' ||
    base === 'application/x-www-form-urlencoded' ||
    base === 'application/yaml' ||
    base === 'application/x-yaml'
  );
}

/** 上限内的读取：超过上限即取消流并抛错（不把巨型响应整个读进内存）。 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError('INVALID_INPUT', `响应超过 ${Math.round(maxBytes / (1024 * 1024))}MB 上限`);
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError(
        'INVALID_INPUT',
        `响应超过 ${Math.round(maxBytes / (1024 * 1024))}MB 上限`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class CapabilityBridge {
  readonly #deps: CapabilityBridgeDeps;
  /** 每插件每域调用计数（审计面，61 §3.3）。 */
  readonly #audit = new Map<string, Map<string, number>>();
  /** 每插件在途 `net.fetch` 的取消器（进程退出 / 卸载时统一 abort，防连接悬挂）。 */
  readonly #inflight = new Map<string, Set<AbortController>>();

  constructor(deps: CapabilityBridgeDeps) {
    this.#deps = deps;
  }

  /** 插件的运行时策略（未安装执行型插件 = null）。 */
  async policyOf(pluginId: string): Promise<PluginRuntimePolicy | null> {
    const manifest = await this.#deps.registry.manifestOf(pluginId);
    if (manifest?.runtime === undefined) return null;
    return {
      pluginId,
      networkAllow: manifest.runtime.network?.allow ?? [],
      maxConcurrent: manifest.runtime.maxConcurrent ?? 1,
      storageQuotaBytes: this.#deps.storage.quotaBytes,
    };
  }

  // --- credentials ------------------------------------------------------------

  /**
   * 实例凭据（只含实例 `sensitive` 字段）：按 secrets 前缀扫描取值——清单改字段名 /
   * 删字段也不会漏掉已存值（与 PluginInstanceService 的清理口径一致）。调用方保证
   * 这些值只进 invoke 帧的 `context.credentials`，**不得进入任何日志 / 历史 / 错误**。
   */
  credentialsFor(pluginId: string, instanceId: string): Record<string, string> {
    const prefix = `${pluginSecretScope(pluginId)}:instance:${instanceId}:`;
    const credentials: Record<string, string> = {};
    for (const name of this.#deps.secrets.names()) {
      if (!name.startsWith(prefix)) continue;
      const value = this.#deps.secrets.getValue(name);
      if (value === null) continue;
      credentials[name.slice(prefix.length)] = value;
    }
    return credentials;
  }

  /**
   * 握手 `init.instances`：每个实例的字段键值（非敏感 config_json 标量 + 实例敏感
   * 字段）。实例 `ready()` 需要长期持有的数据从这一帧拿；每次调用仍会注入该实例的
   * 最新凭据。
   */
  instancesFor(pluginId: string): Array<{ instanceId: string; fields: Record<string, string> }> {
    return this.#deps.instances.list(pluginId).map((row) => {
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.#configOf(row))) {
        const text = scalarText(value);
        if (text !== null) fields[key] = text;
      }
      Object.assign(fields, this.credentialsFor(pluginId, row.id));
      return { instanceId: row.id, fields };
    });
  }

  // --- secrets ----------------------------------------------------------------

  /**
   * `host.secrets.get`：只读；键必须指向本插件的实例密钥。接受两种写法：
   * - 文档 / 固定契约的明文形态 `plugin:{pluginId}:instance:{instanceId}:{key}`；
   * - 实际存储名 `plugin:{encodedPluginId}:instance:...`（`/` `.` `_` 已转义）。
   * 明文形态会被翻译成本插件的存储前缀后再查（不直接拿明文查库，避免把文档
   * 承诺变成永远返回 null）；其它插件 / 命名空间一律拒绝。
   */
  secretsGet(pluginId: string, key: string): string | null {
    const storagePrefix = `${pluginSecretScope(pluginId)}:instance:`;
    if (key.startsWith(storagePrefix)) return this.#deps.secrets.getValue(key);
    const documentedPrefix = `plugin:${pluginId}:instance:`;
    if (key.startsWith(documentedPrefix)) {
      const storageKey = `${storagePrefix}${key.slice(documentedPrefix.length)}`;
      return this.#deps.secrets.getValue(storageKey);
    }
    throw new AppError(
      'INVALID_INPUT',
      '只能读取本插件的实例密钥（plugin:{pluginId}:instance:*）',
    );
  }

  // --- storage ----------------------------------------------------------------

  storageGet(pluginId: string, key: string): unknown {
    const entry = this.#deps.storage.get(pluginId, key);
    if (entry === null) return null;
    try {
      return JSON.parse(entry.valueJson) as unknown;
    } catch {
      return null;
    }
  }

  storageSet(pluginId: string, key: string, value: unknown): void {
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      throw new AppError('INVALID_INPUT', 'storage 的值必须是 JSON 兼容数据');
    }
    if (text === undefined) {
      throw new AppError('INVALID_INPUT', 'storage 的值必须是 JSON 兼容数据');
    }
    this.#deps.storage.set(pluginId, key, text);
  }

  storageDelete(pluginId: string, key: string): void {
    this.#deps.storage.delete(pluginId, key);
  }

  storageList(pluginId: string, prefix?: string): string[] {
    return this.#deps.storage.list(pluginId, prefix);
  }

  storageUsage(pluginId: string): number {
    return this.#deps.storage.usageBytes(pluginId);
  }

  /** 卸载 / 回滚清除（注册表 teardown 钩子调用；幂等）。 */
  clearStorage(pluginId: string): void {
    this.#deps.storage.clear(pluginId);
    this.#audit.delete(pluginId);
  }

  /** 审计计数快照（每插件每域调用次数；诊断与测试用）。 */
  auditSnapshot(): Record<string, Record<string, number>> {
    const snapshot: Record<string, Record<string, number>> = {};
    for (const [pluginId, hosts] of this.#audit) snapshot[pluginId] = Object.fromEntries(hosts);
    return snapshot;
  }

  // --- net.fetch ---------------------------------------------------------------

  /**
   * `host.net.fetch`（61 §4）：白名单 + SSRF + 体积上限 + 审计。HTTP 非 2xx 按 fetch
   * 语义返回响应（不抛错）；策略拒绝 / 私网 / 体积越界 / 网络失败抛 AppError。
   */
  async netFetch(
    pluginId: string,
    rawUrl: string,
    init?: Extract<PluginHostApiRequest, { api: 'net.fetch' }>['init'],
  ): Promise<PluginHostNetResponse> {
    const manifest = await this.#deps.registry.manifestOf(pluginId);
    const allow = manifest?.runtime?.network?.allow ?? [];
    if (init?.body !== undefined && init.bodyBase64 !== undefined) {
      throw new AppError('INVALID_INPUT', '请求体只能给 body 或 bodyBase64 之一');
    }
    let url = await this.#assertAllowedUrl(pluginId, rawUrl, allow);
    // 审计：每插件每域调用次数（进日志，不阻塞）。
    this.#count(pluginId, url.hostname);
    // 超时由插件声明（init.timeoutMs），宿主只钳制上限——不同厂商协议的合理单次请求
    // 时长差异很大（同步出图可达数分钟），固定 60s 会误杀正常请求（61 §4 能力注入语义）。
    // 调用级看门狗仍是最终裁判；插件进程退出时 abortFor 会取消这里的在途请求。
    const timeoutMs = Math.min(
      init?.timeoutMs ?? this.#deps.netTimeoutMs ?? PLUGIN_RUNTIME_NET_MAX_TIMEOUT_MS,
      PLUGIN_RUNTIME_NET_MAX_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.#track(pluginId, controller);
    const body =
      init?.bodyBase64 !== undefined
        ? Buffer.from(init.bodyBase64, 'base64')
        : init?.body !== undefined
          ? init.body
          : undefined;
    try {
      return await this.#netFetchLoop(pluginId, url, allow, init, body, controller.signal);
    } finally {
      clearTimeout(timer);
      this.#untrack(pluginId, controller);
    }
  }

  /**
   * 取消某插件的全部在途 `net.fetch`（插件进程退出 / 卸载时调用）。
   *
   * 请求是宿主代发的：插件进程死亡后请求本身不会自动停止，若不取消会一直挂到自己的
   * 超时（上限 15 分钟）并长期占用连接。PluginHost 的 dispose / 失败收尾负责调用。
   */
  abortFor(pluginId: string): void {
    for (const controller of this.#inflight.get(pluginId) ?? []) controller.abort();
    this.#inflight.delete(pluginId);
  }

  #track(pluginId: string, controller: AbortController): void {
    const set = this.#inflight.get(pluginId) ?? new Set<AbortController>();
    set.add(controller);
    this.#inflight.set(pluginId, set);
  }

  #untrack(pluginId: string, controller: AbortController): void {
    const set = this.#inflight.get(pluginId);
    if (set === undefined) return;
    set.delete(controller);
    if (set.size === 0) this.#inflight.delete(pluginId);
  }

  /** `netFetch` 的重定向循环主体（超时 / 在途登记由调用方负责）。 */
  async #netFetchLoop(
    pluginId: string,
    startUrl: URL,
    allow: readonly string[],
    init: Extract<PluginHostApiRequest, { api: 'net.fetch' }>['init'],
    body: Buffer | string | undefined,
    signal: AbortSignal,
  ): Promise<PluginHostNetResponse> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      // UA 固定（61 §4）：插件自定义 headers 不能覆盖 User-Agent。
      const requestHeaders: Record<string, string> = { 'User-Agent': FETCH_USER_AGENT };
      for (const [name, value] of Object.entries(init?.headers ?? {})) {
        if (name.toLowerCase() !== 'user-agent') requestHeaders[name] = value;
      }
      try {
        response = await this.#fetch(url.toString(), {
          method: init?.method ?? 'GET',
          headers: requestHeaders,
          ...(body !== undefined ? { body } : {}),
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        const rejection = connectRejectionText(error);
        if (rejection !== null) {
          throw new AppError('PLUGIN_NETWORK_DENIED', rejection, { host: url.hostname });
        }
        if (
          (error instanceof Error && error.name === 'TimeoutError') ||
          signal.aborted
        ) {
          throw new AppError('PROVIDER_UNREACHABLE', '插件网络请求超时');
        }
        throw new AppError(
          'PROVIDER_UNREACHABLE',
          `插件网络请求失败：${error instanceof Error ? error.message : String(error)}`,
          { host: url.hostname },
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location !== null) {
          // 不读取重定向响应体：显式取消，避免把连接 / 大响应留在内存里。
          await response.body?.cancel().catch(() => undefined);
          url = await this.#assertAllowedUrl(pluginId, new URL(location, url).toString(), allow);
          this.#count(pluginId, url.hostname);
          continue;
        }
      }
      let buffer: Buffer;
      try {
        buffer = await readCapped(response, PLUGIN_RUNTIME_NET_MAX_BYTES);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ) {
          throw new AppError('PROVIDER_UNREACHABLE', '插件网络请求超时');
        }
        throw new AppError(
          'PROVIDER_UNREACHABLE',
          `读取插件网络响应失败：${error instanceof Error ? error.message : String(error)}`,
          { host: url.hostname },
        );
      }
      const contentType = response.headers.get('content-type') ?? '';
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      if (isTextContentType(contentType)) {
        return {
          status: response.status,
          ok: response.ok,
          headers,
          bodyText: buffer.toString('utf8'),
        };
      }
      return {
        status: response.status,
        ok: response.ok,
        headers,
        bodyBase64: buffer.toString('base64'),
      };
    }
    throw new AppError('INVALID_INPUT', `重定向超过 ${MAX_REDIRECTS} 跳`);
  }

  #fetch(url: string, init: NetRequestInit): Promise<Response> {
    const impl = this.#deps.fetchImpl;
    if (impl !== undefined) return impl(url, init as unknown as RequestInit);
    return undiciFetch(url, {
      ...init,
      dispatcher: sharedSafeDispatcher(),
    } as never) as unknown as Promise<Response>;
  }

  /**
   * URL 白名单 + SSRF 前置校验（重定向逐跳复检）。IP 字面量必须显式过私网判定
   * （Node 直连 IP 不走 `lookup`）；域名先解析再判定，连接时由 safe dispatcher 再校验
   * 一次（无 DNS rebinding 窗口）。
   */
  async #assertAllowedUrl(
    pluginId: string,
    rawUrl: string,
    allow: readonly string[],
  ): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError('INVALID_INPUT', `URL 无法解析：${rawUrl.slice(0, 200)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('PLUGIN_NETWORK_DENIED', '只允许 http/https 地址', { pluginId });
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!isHostAllowed(hostname, allow)) {
      throw new AppError('PLUGIN_NETWORK_DENIED', `域名不在插件清单的联网白名单内：${hostname}`, {
        pluginId,
        host: hostname,
      });
    }
    let addresses: string[];
    if (net.isIP(hostname) !== 0) {
      addresses = [hostname];
    } else {
      try {
        addresses =
          this.#deps.lookup === undefined
            ? (await dns.lookup(hostname, { all: true })).map((entry) => entry.address)
            : (await this.#deps.lookup(hostname)).map((entry) => entry.address);
      } catch {
        throw new AppError('PLUGIN_NETWORK_DENIED', `域名无法解析：${hostname}`, {
          pluginId,
          host: hostname,
        });
      }
    }
    try {
      assertNoPrivateAddress(addresses.map((address) => ({ address })));
    } catch (error) {
      throw new AppError('PLUGIN_NETWORK_DENIED', (error as Error).message, {
        pluginId,
        host: hostname,
      });
    }
    return url;
  }

  #count(pluginId: string, host: string): void {
    let hosts = this.#audit.get(pluginId);
    if (hosts === undefined) {
      hosts = new Map();
      this.#audit.set(pluginId, hosts);
    }
    const next = (hosts.get(host) ?? 0) + 1;
    hosts.set(host, next);
    this.#deps.logger.info({ plugin: pluginId, host, count: next }, 'plugin net.fetch');
  }

  #configOf(row: PluginInstanceRow): Record<string, PluginFieldValue> {
    try {
      return JSON.parse(row.configJson) as Record<string, PluginFieldValue>;
    } catch {
      return {};
    }
  }
}

/** 标量 → 字符串（数组 / 对象不进握手帧，避免把复杂结构当成凭据面）。 */
function scalarText(value: PluginFieldValue | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
