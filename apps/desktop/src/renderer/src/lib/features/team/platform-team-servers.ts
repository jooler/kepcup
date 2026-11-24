/**
 * `window.kepcup.platform.teamServers` 的渲染层访问口（T7 与主进程代理 A1 的
 * 钉死契约，README 固定契约 `platform.teamServers.*`）。
 *
 * 这里的本地接口按契约手写：shim.d.ts 的类型由主进程侧并行落地，旧构建 /
 * 类型未到位时这里按「方法不存在」处理（整个团队服务器面隐藏，不炸）。
 * token / 密码永不进入渲染层——login 只在提交瞬间把密码经 platform 调用传给
 * 主进程，不落任何渲染层存储。
 */

export interface TeamServerAccountEntry {
  memberId: string;
  username: string;
  displayName: string;
  remembered: boolean;
}

export type TeamServerStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'unauthenticated'
  | 'error'
  /** 连续多次重试未果（桥仍后台退避重试，服务器恢复后自愈回 connected）。 */
  | 'unreachable';

export interface TeamServerEntry {
  serverHash: string;
  url: string;
  accounts: TeamServerAccountEntry[];
  activeMemberId: string | null;
  status: TeamServerStatus;
}

/** 健康检查结果（whoami 探测分类，主进程 team-servers.probe）。 */
export interface TeamServerProbeResult {
  reachable: boolean;
  kind: 'team' | 'personal' | 'unknown';
  authenticated?: boolean;
  member?: { id: string; displayName: string };
  /** 失败 / 未识别时的可读原因（网络错误文本、HTTP 状态等）。 */
  detail?: string;
}

export interface TeamServersApi {
  list(): Promise<TeamServerEntry[]>;
  add(input: { url: string }): Promise<{ serverHash: string }>;
  remove(input: { serverHash: string }): Promise<{ ok: true }>;
  login(input: {
    serverHash: string;
    username: string;
    password: string;
    remember: boolean;
  }): Promise<{ member: { id: string; displayName: string } }>;
  logout(input: { serverHash: string }): Promise<{ ok: true }>;
  switchAccount(input: { serverHash: string; memberId: string }): Promise<{ ok: true }>;
  connect(input: { serverHash: string }): Promise<{ ok: true }>;
  disconnect(input: { serverHash: string }): Promise<{ ok: true }>;
  probe(input: { url: string }): Promise<TeamServerProbeResult>;
  onChanged(cb: () => void): () => void;
}

/** 主进程调用失败时 Error.message 是 `JSON.stringify({code, message, details?})`。 */
export function parseTeamError(error: unknown): { code: string | null; message: string } {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'code' in parsed) {
      const data = parsed as { code?: unknown; message?: unknown };
      return {
        code: typeof data.code === 'string' ? data.code : null,
        message: typeof data.message === 'string' ? data.message : raw,
      };
    }
  } catch {
    // 非 JSON 包装（本地垫片抛的普通 Error 等）：原样透出文本。
  }
  return { code: null, message: raw };
}

/** 平台方法是否可用（桌面 preload 提供；web 垫片没有）。 */
export function getTeamServersApi(): TeamServersApi | null {
  if (typeof window === 'undefined') return null;
  // 双重 cast：shim.d.ts 的 platform.teamServers 类型由主进程侧并行落地；
  // 这里按「可能不存在」的窄视图读取，类型到位前后都能编译。
  const platform = (
    window as unknown as { kepcup?: { platform?: { teamServers?: unknown } } }
  ).kepcup?.platform;
  const api = platform?.teamServers;
  if (api === null || api === undefined || typeof api !== 'object') return null;
  const candidate = api as Record<string, unknown>;
  const required = ['list', 'add', 'remove', 'login', 'logout', 'switchAccount', 'connect', 'disconnect', 'probe', 'onChanged'];
  return required.every((name) => typeof candidate[name] === 'function')
    ? (candidate as unknown as TeamServersApi)
    : null;
}
