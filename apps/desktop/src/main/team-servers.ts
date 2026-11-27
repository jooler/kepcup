import { chmod as fsChmod, writeFile as fsWriteFile } from 'node:fs/promises';
import type { ZodType } from 'zod';
import {
  platformTeamServersAddInputSchema,
  platformTeamServersLoginInputSchema,
  platformTeamServersProbeInputSchema,
  platformTeamServersRenameInputSchema,
  platformTeamServersServerHashInputSchema,
  platformTeamServersSwitchAccountInputSchema,
  type PlatformTeamServersProbeOutput,
  type TeamServerEntry,
  type TeamServerStatus,
} from '@kepcup/shared';
import { remoteProfileHash } from './remote-mode';
import {
  TeamServerBridge,
  openTeamSocket,
  type BridgeChannel,
  type BridgePortLike,
  type OpenTeamSocket,
  type TeamConnectionStatus,
} from './team-bridge';

/**
 * T7 步骤 1（T7 §2「凭据与多账号」）：桌面融合视图的团队服务器注册表与凭据管理。
 *
 * 状态文件 `<userData>/team-servers.json`：每服务器（`serverHash` = sha256(url) 前
 * 16 hex，与 `remoteProfileHash` 同一实现——复用、不造第二种哈希）下多个曾登录的
 * 成员账号（登录选择器数据，62.10 §4），同一时刻每服务器一个 `activeMemberId`。
 * **懒初始化**：构造零副作用，状态文件只在首个 add / login 时创建，连接只在显式
 * connect 时建立——未配置团队服务器时主进程行为零变化（无文件、无连接、无事件）。
 *
 * token 经 `safeStorage.encryptString` 加密落同文件（base64 `tokenVault` 字段）；
 * `safeStorage.isEncryptionAvailable()` 为 false 时**拒绝保存 token**（DEV-143：
 * remember 强制 false，token 仅本次会话内存持有，不写明文、不做自制加密兜底）。
 * token 永不出主进程：list 输出没有任何 token 字段，也不提供把 token 交给渲染层的
 * 方法；登录（密码）由主进程直接 fetch，不进渲染层。
 *
 * 错误约定（渲染层据此解析）：ipc invoke 失败 reject 的 `Error.message` =
 * `JSON.stringify({code, message, details?})`（code 取 shared ERROR_CODES；登录
 * 401 透传团队服务器口径 `INVALID_CREDENTIALS`）；JSON.parse 失败按通用错误处理。
 *
 * 本模块不 import electron：safeStorage / MessageChannelMain / webContents 发送
 * 均经构造注入（测试用 fake）。
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TeamServersDeps {
  /** 状态文件完整路径（`<userData>/team-servers.json`）。 */
  statePath(): string;
  safeStorage: SafeStorageLike;
  fetch: typeof fetch;
  /** 读状态文件；文件不存在返回 null（不抛）。 */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  createChannel(): BridgeChannel;
  /** port2 → 渲染层（index.ts 接 webContents.postMessage('team-port', …)）。 */
  postPort(serverHash: string, port: BridgePortLike, activeMemberId: string | null): void;
  openSocket?: OpenTeamSocket;
  /** 状态 / 名单有任何变化时通知渲染层（ipc 事件 team-servers:changed）。 */
  onChanged(): void;
  /** 主进程只允许 console.warn / console.error（BR-P13-008：无文案进程）。 */
  log?(message: string, error?: unknown): void;
}

/** ipcMain.handle 的最小结构面（测试注入用）。 */
export type IpcRegistrar = (
  channel: string,
  handler: (event: unknown, input: unknown) => unknown,
) => void;

interface StoredAccount {
  memberId: string;
  username: string;
  displayName: string;
  /** true = token 已加密落盘（tokenVault 非空）；false = 仅内存 / 无 token。 */
  remembered: boolean;
  /** safeStorage 加密后的 token（base64）；null = 未落盘。 */
  tokenVault: string | null;
}

interface StoredServer {
  url: string;
  /** 用户在本机起的显示名（'' = 未设，UI 回退显示 url；不上传服务器）。 */
  name: string;
  activeMemberId: string | null;
  accounts: StoredAccount[];
}

interface StateFile {
  version: 1;
  servers: Record<string, StoredServer>;
}

/** 错误约定（见文件头）：message 就是 JSON 载荷，渲染层直接 JSON.parse。 */
export function teamRpcError(code: string, message: string, details?: unknown): Error {
  const payload =
    details === undefined ? { code, message } : { code, message, details };
  const error = new Error(JSON.stringify(payload));
  error.name = 'TeamServersError';
  return error;
}

/**
 * 状态文件落盘（0600）：fs.writeFile 的 `mode` 只在**新建**文件时生效，已存在的
 * 文件保持原权限——写后再 chmod 一次，保证 team-servers.json 恒为 owner-only
 * （内容是 safeStorage 密文，权限面仍然最小化；index.ts 把本函数注入 writeFile）。
 */
export async function writeTeamServersState(path: string, contents: string): Promise<void> {
  await fsWriteFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  await fsChmod(path, 0o600);
}

function parseJsonInput<T>(schema: ZodType<T>, input: unknown): T {
  const check = schema.safeParse(input);
  if (!check.success) throw teamRpcError('INVALID_INPUT', '参数不合法');
  return check.data;
}

/**
 * URL 校验与规范化（规则与 `resolveRemoteMode` 一致：http/https、无内嵌凭据、
 * 剥离 query / hash），错误文案面向「添加团队服务器」的设置界面（不借道环境变量名）。
 */
export function normalizeTeamServerUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw teamRpcError('INVALID_INPUT', '服务器地址不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw teamRpcError('INVALID_INPUT', `不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw teamRpcError('INVALID_INPUT', `只支持 http / https 地址：${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw teamRpcError('INVALID_INPUT', '地址不能内嵌用户名 / 密码');
  }
  return new URL(parsed.origin + parsed.pathname).toString();
}

/** `${url}/path` 拼接（规范化 url 可能带也可能不带尾斜杠）。 */
function joinServerPath(url: string, path: string): string {
  return `${url.replace(/\/$/, '')}${path}`;
}

/**
 * 健康检查失败原因（设置界面弹框展示）：fetch 的顶层 message 常常只有
 * `fetch failed`，真正的 DNS / 连接错误在 `cause` 里——两层都带上。
 */
function probeErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.length > 0 && cause.message !== error.message) {
    return `${error.message}（${cause.message}）`;
  }
  return error.message;
}

/** sha256(url) 前 16 hex——与 remoteProfileHash 同一实现（导出复用，勿造第二种）。 */
export function teamServerHash(url: string): string {
  return remoteProfileHash(url);
}

/** 健康检查超时（添加流程的 whoami 探测；不长期挂死设置界面）。 */
const PROBE_TIMEOUT_MS = 6_000;

export class TeamServers {
  readonly #deps: TeamServersDeps;
  /** 懒加载的内存态（一旦加载即为唯一事实来源；写穿到磁盘）。 */
  #state: StateFile | null = null;
  /** 会话内存 token（remember=false 或 safeStorage 不可用时；主进程重启即失效）。 */
  readonly #memoryTokens = new Map<string, string>();
  readonly #statuses = new Map<string, TeamServerStatus>();
  readonly #bridge: TeamServerBridge;

  constructor(deps: TeamServersDeps) {
    this.#deps = deps;
    this.#bridge = new TeamServerBridge(
      {
        createChannel: deps.createChannel,
        postPort: (serverHash, port) => {
          const activeMemberId = this.#state?.servers[serverHash]?.activeMemberId ?? null;
          this.#deps.postPort(serverHash, port, activeMemberId);
        },
        openSocket: deps.openSocket ?? openTeamSocket,
        fetch: deps.fetch,
        log: deps.log,
      },
      (serverHash, status) => this.#setStatus(serverHash, status),
    );
  }

  /** 注册 ipcMain handlers（channel：`platform:teamServers:<verb>`）。 */
  registerIpc(register: IpcRegistrar): void {
    register('platform:teamServers:list', () => this.list());
    register('platform:teamServers:add', (_event, input) =>
      this.add(parseJsonInput(platformTeamServersAddInputSchema, input)),
    );
    register('platform:teamServers:remove', (_event, input) =>
      this.remove(parseJsonInput(platformTeamServersServerHashInputSchema, input)),
    );
    register('platform:teamServers:login', (_event, input) =>
      this.login(parseJsonInput(platformTeamServersLoginInputSchema, input)),
    );
    register('platform:teamServers:logout', (_event, input) =>
      this.logout(parseJsonInput(platformTeamServersServerHashInputSchema, input)),
    );
    register('platform:teamServers:switchAccount', (_event, input) =>
      this.switchAccount(parseJsonInput(platformTeamServersSwitchAccountInputSchema, input)),
    );
    register('platform:teamServers:rename', (_event, input) =>
      this.rename(parseJsonInput(platformTeamServersRenameInputSchema, input)),
    );
    register('platform:teamServers:connect', (_event, input) =>
      this.connect(parseJsonInput(platformTeamServersServerHashInputSchema, input)),
    );
    register('platform:teamServers:disconnect', (_event, input) =>
      this.disconnect(parseJsonInput(platformTeamServersServerHashInputSchema, input)),
    );
    register('platform:teamServers:probe', (_event, input) =>
      this.probe(parseJsonInput(platformTeamServersProbeInputSchema, input)),
    );
  }

  /** 窗口（重）加载后补发团队端口（bridge 内部为每条活连接换新 MessagePort）。 */
  refreshPorts(): void {
    this.#bridge.refreshPorts();
  }

  /** 应用退出：断开全部团队连接（服务器侧落 last_seen）。 */
  shutdown(): void {
    this.#bridge.disconnectAll();
  }

  async list(): Promise<TeamServerEntry[]> {
    const state = await this.#load();
    return Object.entries(state.servers).map(([serverHash, server]) => ({
      serverHash,
      url: server.url,
      name: server.name,
      accounts: server.accounts.map((account) => ({
        memberId: account.memberId,
        username: account.username,
        displayName: account.displayName,
        remembered: account.remembered,
      })),
      activeMemberId: server.activeMemberId,
      status: this.#statuses.get(serverHash) ?? 'idle',
    }));
  }

  /**
   * 登记一台服务器。校验即规范化（同 resolveRemoteMode 规则）；重复 add（规范化后
   * 同址）幂等返回既有 serverHash，不重写文件。首个 add 即创建状态文件。
   */
  async add(input: { url: string }): Promise<{ serverHash: string }> {
    const url = normalizeTeamServerUrl(input.url);
    const serverHash = teamServerHash(url);
    const state = await this.#load();
    if (state.servers[serverHash] === undefined) {
      state.servers[serverHash] = { url, name: '', activeMemberId: null, accounts: [] };
      await this.#persist();
      this.#deps.onChanged();
    }
    return { serverHash };
  }

  /**
   * 本机重命名（设置 - 团队服务器）：name trim 后落盘（空 = 清除，UI 回退显示
   * url）。名字只存本机状态文件，与服务器无交互；未登记的 serverHash 报 NOT_FOUND。
   */
  async rename(input: { serverHash: string; name: string }): Promise<{ ok: true }> {
    const state = await this.#load();
    const server = this.#requireServer(state, input.serverHash);
    const name = input.name.trim();
    if (server.name === name) return { ok: true };
    server.name = name;
    await this.#persist();
    this.#deps.onChanged();
    return { ok: true };
  }

  /**
   * 健康检查（添加流程第一步，`GET /api/auth/whoami`，6s 超时）：可达性 + 服务
   * 身份分类，通过才轮到渲染层登记（add）并出现登录表单。分类口径与
   * authed-transport 的 probeServerAuth 一致——团队服务器 whoami 只回 200
   * {member} 或 401 {error}，从不 404：401/403 + JSON = 密码模式未登录；
   * 200 + member = 已认证；404 = 配对模式（headless 个人服务器，不是团队服务器）；
   * 非 JSON / 其它状态 = unknown；网络错误按 reachable:false（不抛错——探测结果
   * 本身就是返回值）。
   */
  async probe(input: { url: string }): Promise<PlatformTeamServersProbeOutput> {
    const url = normalizeTeamServerUrl(input.url);
    let res: Response;
    try {
      res = await this.#deps.fetch(joinServerPath(url, '/api/auth/whoami'), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      return { reachable: false, kind: 'unknown', detail: probeErrorDetail(error) };
    }
    // 非 JSON 响应（别的 web 服务占着端口）视作不是 KepCup。
    let body: { member?: unknown; error?: unknown } | null;
    try {
      body = (await res.json()) as { member?: unknown; error?: unknown };
    } catch {
      body = null;
    }
    if (body === null) {
      return {
        reachable: true,
        kind: 'unknown',
        detail: `HTTP ${res.status}：响应不是 JSON`,
      };
    }
    const member = body.member as { id?: unknown; displayName?: unknown } | undefined;
    if (res.ok && typeof member?.id === 'string' && typeof member?.displayName === 'string') {
      return {
        reachable: true,
        kind: 'team',
        authenticated: true,
        member: { id: member.id, displayName: member.displayName },
      };
    }
    if ((res.status === 401 || res.status === 403) && typeof body.error === 'string') {
      return { reachable: true, kind: 'team', authenticated: false };
    }
    if (res.status === 404) {
      return { reachable: true, kind: 'personal', detail: 'HTTP 404' };
    }
    return { reachable: true, kind: 'unknown', detail: `HTTP ${res.status}` };
  }

  /** 删配置 + 删已存 token + 断开桥接。 */
  async remove(input: { serverHash: string }): Promise<{ ok: true }> {
    const state = await this.#load();
    const server = this.#requireServer(state, input.serverHash);
    this.#bridge.disconnect(input.serverHash);
    for (const account of server.accounts) this.#memoryTokens.delete(this.#tokenKey(input.serverHash, account.memberId));
    delete state.servers[input.serverHash];
    this.#statuses.delete(input.serverHash);
    await this.#persist();
    this.#deps.onChanged();
    return { ok: true };
  }

  /**
   * 主进程直接登录（密码不进渲染层）：POST /api/auth/login → token 与成员信息。
   * token 按 remember 决定是否加密落盘；`safeStorage` 不可用时强制不落盘
   * （remembered=false，本次会话内存持有——DEV-143）。成功后设为 active。
   */
  async login(input: {
    serverHash: string;
    username: string;
    password: string;
    remember: boolean;
  }): Promise<{ member: { id: string; displayName: string } }> {
    const state = await this.#load();
    const server = this.#requireServer(state, input.serverHash);
    let res: Response;
    try {
      res = await this.#deps.fetch(joinServerPath(server.url, '/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: input.username, password: input.password }),
      });
    } catch (error) {
      throw teamRpcError(
        'INTERNAL',
        `无法连接团队服务器：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 401) {
      // 团队服务器对未知用户名 / 密码错误 / 已禁用统一 INVALID_CREDENTIALS（防枚举）。
      throw teamRpcError('INVALID_CREDENTIALS', '用户名或密码不正确');
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw teamRpcError('RATE_LIMITED', '登录尝试过于频繁，请稍后再试', {
        retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }
    if (!res.ok) throw teamRpcError('INTERNAL', `登录失败（HTTP ${res.status}）`);
    let body: { token?: unknown; member?: { id?: unknown; displayName?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw teamRpcError('INTERNAL', '登录响应不是合法 JSON');
    }
    if (
      typeof body.token !== 'string' ||
      body.token.length === 0 ||
      typeof body.member?.id !== 'string' ||
      typeof body.member?.displayName !== 'string'
    ) {
      throw teamRpcError('INTERNAL', '登录响应缺少 token 或成员信息');
    }
    const memberId = body.member.id;
    const displayName = body.member.displayName;
    const canPersist = this.#deps.safeStorage.isEncryptionAvailable();
    const remembered = input.remember && canPersist;
    let tokenVault: string | null = null;
    if (remembered) {
      try {
        tokenVault = this.#deps.safeStorage.encryptString(body.token).toString('base64');
      } catch (error) {
        // 加密失败与不可用同款处理：不落盘，仅内存。
        this.#deps.log?.('safeStorage encrypt failed; token kept in memory only', error);
      }
    }
    const existing = server.accounts.find((account) => account.memberId === memberId);
    if (existing === undefined) {
      server.accounts.push({
        memberId,
        username: input.username,
        displayName,
        remembered: tokenVault !== null,
        tokenVault,
      });
    } else {
      existing.username = input.username;
      existing.displayName = displayName;
      existing.remembered = tokenVault !== null;
      existing.tokenVault = tokenVault;
    }
    server.activeMemberId = memberId;
    this.#memoryTokens.set(this.#tokenKey(input.serverHash, memberId), body.token);
    await this.#persist();
    this.#deps.onChanged();
    return { member: { id: memberId, displayName } };
  }

  /**
   * 登出：清 active 与该账号已存 token；账号条目保留（remembered=false）——62.10 §4
   * 登录选择器列出本设备登录过的成员。断开桥接（状态 idle）。服务器端 token 是无状态
   * 签名（30 天 TTL），本地丢弃即失效面；不做服务端 logout（那只清 cookie）。
   */
  async logout(input: { serverHash: string }): Promise<{ ok: true }> {
    const state = await this.#load();
    const server = this.#requireServer(state, input.serverHash);
    const memberId = server.activeMemberId;
    this.#bridge.disconnect(input.serverHash);
    if (memberId !== null) {
      const account = server.accounts.find((entry) => entry.memberId === memberId);
      if (account !== undefined) {
        account.remembered = false;
        account.tokenVault = null;
      }
      this.#memoryTokens.delete(this.#tokenKey(input.serverHash, memberId));
    }
    server.activeMemberId = null;
    this.#setStatus(input.serverHash, 'idle');
    await this.#persist();
    this.#deps.onChanged();
    return { ok: true };
  }

  /**
   * 换激活账号：先拆旧桥接再写新 active / 重连——否则仍在重试的旧端口可能在
   * 身份切换后被盖上新账号（postPort 读当前 active）。新账号有可用 token
   * （内存或已存）则重连，否则置 `unauthenticated`（等用户 login；不自动重试）。
   */
  async switchAccount(input: { serverHash: string; memberId: string }): Promise<{ ok: true }> {
    const state = await this.#load();
    const server = this.#requireServer(state, input.serverHash);
    if (!server.accounts.some((account) => account.memberId === input.memberId)) {
      throw teamRpcError('NOT_FOUND', '该成员账号不在本设备登录记录中');
    }
    const hadBridge = this.#bridge.has(input.serverHash);
    if (hadBridge) {
      this.#bridge.disconnect(input.serverHash);
      this.#setStatus(input.serverHash, 'idle');
    }
    server.activeMemberId = input.memberId;
    await this.#persist();
    if (hadBridge) {
      const token = await this.#activeToken(state, input.serverHash);
      if (token !== null) {
        this.#bridge.connect(input.serverHash, { url: server.url, token });
      } else {
        this.#setStatus(input.serverHash, 'unauthenticated');
      }
    }
    this.#deps.onChanged();
    return { ok: true };
  }

  /**
   * 启动桥接。需要 active 账号且有可用 token；没有则置 `unauthenticated`（渲染层
   * 引导重新登录），不抛错——状态机由 list()/onChanged 驱动。
   */
  async connect(input: { serverHash: string }): Promise<{ ok: true }> {
    const state = await this.#load();
    const server = this.#requireServer(state, input.serverHash);
    const token = await this.#activeToken(state, input.serverHash);
    if (token === null) {
      this.#setStatus(input.serverHash, 'unauthenticated');
      return { ok: true };
    }
    this.#bridge.connect(input.serverHash, { url: server.url, token });
    return { ok: true };
  }

  /** 停止桥接：关 WS / 双侧 port，状态 idle。 */
  async disconnect(input: { serverHash: string }): Promise<{ ok: true }> {
    const state = await this.#load();
    this.#requireServer(state, input.serverHash);
    this.#bridge.disconnect(input.serverHash);
    this.#setStatus(input.serverHash, 'idle');
    return { ok: true };
  }

  // --- internals -------------------------------------------------------------

  #tokenKey(serverHash: string, memberId: string): string {
    return `${serverHash}\n${memberId}`;
  }

  #requireServer(state: StateFile, serverHash: string): StoredServer {
    const server = state.servers[serverHash];
    if (server === undefined) throw teamRpcError('NOT_FOUND', '未登记的团队服务器');
    return server;
  }

  /** 懒加载状态文件（缺失 → 空态，不建文件）。 */
  async #load(): Promise<StateFile> {
    if (this.#state !== null) return this.#state;
    let raw: string | null;
    try {
      raw = await this.#deps.readFile(this.#deps.statePath());
    } catch (error) {
      throw teamRpcError(
        'INTERNAL',
        `读取 team-servers.json 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null) {
      this.#state = { version: 1, servers: {} };
      return this.#state;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw teamRpcError('INTERNAL', 'team-servers.json 不是合法 JSON');
    }
    this.#state = this.#coerceState(parsed);
    return this.#state;
  }

  /** 最小形状校验（不做 schema 级深校验——文件由本模块独占写）。 */
  #coerceState(parsed: unknown): StateFile {
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { servers?: unknown }).servers !== 'object' ||
      (parsed as { servers: unknown }).servers === null
    ) {
      throw teamRpcError('INTERNAL', 'team-servers.json 结构不识别');
    }
    const servers: Record<string, StoredServer> = {};
    for (const [hash, raw] of Object.entries((parsed as { servers: Record<string, unknown> }).servers)) {
      if (raw === null || typeof raw !== 'object') {
        throw teamRpcError('INTERNAL', 'team-servers.json 结构不识别');
      }
      const server = raw as Record<string, unknown>;
      if (
        typeof server.url !== 'string' ||
        (server.activeMemberId !== null && typeof server.activeMemberId !== 'string') ||
        !Array.isArray(server.accounts)
      ) {
        throw teamRpcError('INTERNAL', 'team-servers.json 结构不识别');
      }
      servers[hash] = {
        url: server.url,
        // 旧版本状态文件没有 name 字段 → ''（未命名，UI 回退显示 url）；
        // trim 防手改文件的空白名绕过「空 = 回退地址」语义（正常写入恒已 trim）。
        name: typeof server.name === 'string' ? server.name.trim() : '',
        activeMemberId: (server.activeMemberId as string | null) ?? null,
        accounts: (server.accounts as unknown[]).map((entry) => {
          const account = entry as Record<string, unknown>;
          return {
            memberId: String(account.memberId),
            username: String(account.username ?? ''),
            displayName: String(account.displayName ?? ''),
            remembered: account.remembered === true,
            tokenVault: typeof account.tokenVault === 'string' ? account.tokenVault : null,
          };
        }),
      };
    }
    return { version: 1, servers };
  }

  async #persist(): Promise<void> {
    const state = this.#state;
    if (state === null) return;
    try {
      await this.#deps.writeFile(this.#deps.statePath(), `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      throw teamRpcError(
        'INTERNAL',
        `写入 team-servers.json 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** active 账号的可用 token：内存优先，其次解密 tokenVault（并回填内存）。 */
  async #activeToken(state: StateFile, serverHash: string): Promise<string | null> {
    const server = state.servers[serverHash];
    if (server === undefined || server.activeMemberId === null) return null;
    const memberId = server.activeMemberId;
    const key = this.#tokenKey(serverHash, memberId);
    const memory = this.#memoryTokens.get(key);
    if (memory !== undefined) return memory;
    const account = server.accounts.find((entry) => entry.memberId === memberId);
    if (account?.tokenVault == null || !this.#deps.safeStorage.isEncryptionAvailable()) return null;
    try {
      const token = this.#deps.safeStorage.decryptString(Buffer.from(account.tokenVault, 'base64'));
      if (token.length === 0) return null;
      this.#memoryTokens.set(key, token);
      return token;
    } catch (error) {
      // 解密失败（系统钥匙串换了 / 文件被挪动）：按无 token 处理，等重新登录。
      this.#deps.log?.('safeStorage decrypt failed; treating account as unauthenticated', error);
      return null;
    }
  }

  #setStatus(serverHash: string, status: TeamConnectionStatus): void {
    const next: TeamServerStatus = status;
    if (this.#statuses.get(serverHash) === next) return;
    this.#statuses.set(serverHash, next);
    this.#deps.onChanged();
  }
}
