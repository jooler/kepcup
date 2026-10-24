import { homedir } from 'node:os';
import path from 'node:path';
import { relayEndpointSchema } from '@kepcup/shared';

/**
 * CLI / 环境变量解析（D102 §3.3）。子命令：run（缺省）/ pair / devices / version。
 * 环境变量 KEPCUP_SERVER_{HOST,PORT,DATA_DIR,PUBLIC_URL} 作为同名参数的兜底，
 * systemd 单元里比长命令行好维护。
 */

export interface ServerConfig {
  command: 'run' | 'pair' | 'devices' | 'version';
  /** run：HTTP/WS 绑定地址（默认 127.0.0.1，公网/局域网部署显式给 0.0.0.0）。 */
  host: string;
  /** run：端口（默认 8642）。 */
  port: number;
  /** 数据目录（默认 ~/.kepcup-server，与桌面 ~/.kepcup 区分）。 */
  dataDir: string;
  /**
   * 客户端可访问的公开 WS 地址（`ws://` 或 `wss://`）。缺省从 host:port 推导；
   * host 为通配地址时必须显式给出。配对链接的 origin 由它推导（ws→http / wss→https）。
   */
  publicUrl: string;
  /** 中转出站模式（--relay）：不监听入站，anchor 主动外连公共/自建中转。 */
  relayUrl: string | null;
  keystore: 'system' | 'file';
  /** PWA 静态目录（缺省包内 web/，不存在则不托管）。 */
  webDir: string | null;
  /** 不自动接受配对请求（打印待确认列表，由 `pair --accept` 人工确认）。 */
  pairingManual: boolean;
  /** 完全关闭首配自动出码（已有设备时本来也不出）。 */
  autoPair: boolean;
  /** pair 子命令：确认指定 requestId。 */
  acceptRequestId: string | null;
  /** devices 子命令：revoke <deviceId>。 */
  revokeDeviceId: string | null;
  /** pair/devices：JSON 输出（脚本友好）。 */
  json: boolean;
  /** 内部：publicUrl 是否用户显式给定（port=0 时推导用的公开端口会变）。 */
  publicUrlExplicit: boolean;
}

export class ConfigError extends Error {}

const DEFAULT_PORT = 8642;

function env(name: string): string | undefined {
  const value = process.env[`KEPCUP_SERVER_${name}`];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parsePositiveInt(raw: string, what: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new ConfigError(`${what} 必须是 1-65535 的端口，收到 "${raw}"`);
  }
  return value;
}

function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

function validateWsUrl(raw: string, what: string): string {
  const parsed = relayEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${what} 必须是 ws:// 或 wss:// URL（收到 "${raw}"）`);
  }
  return parsed.data;
}

function derivePublicUrl(host: string, port: number, explicit: string | undefined): string {
  if (explicit !== undefined) return validateWsUrl(explicit, '--public-url');
  if (host === '0.0.0.0' || host === '::' || host === '*') {
    throw new ConfigError(
      'host 为通配地址时无法推导公开地址：请用 --public-url ws(s)://<你的地址>[:端口] 指明客户端从哪里连（配对二维码用它生成）',
    );
  }
  return `ws://${host}:${port}`;
}

/** 解析 argv（含 process.argv[1:] 语义）。抛 ConfigError 时由 CLI 层打印用法。 */
export function parseConfig(argv: readonly string[]): ServerConfig {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === '') continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // 布尔开关表；其余都按取值参数解析（值里的 -- 开头串需要转义的场景不存在）。
      if (['pairing-manual', 'no-auto-pair', 'json', 'help'].includes(key)) {
        flags.add(key);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ConfigError(`--${key} 需要一个值`);
      }
      values.set(key, next);
      i += 1;
      continue;
    }
    positionals.push(arg);
  }
  if (flags.has('help')) throw new ConfigError('help');

  const command = (positionals[0] ?? 'run') as ServerConfig['command'];
  if (!['run', 'pair', 'devices', 'version'].includes(command)) {
    throw new ConfigError(`未知子命令 "${command}"（可用：run / pair / devices / version）`);
  }
  if (command === 'version') {
    return emptyConfig('version');
  }
  // 位置参数只允许子命令本身，例外：`devices revoke <id>`（id 也可走 --revoke）。
  let positionalRevoke: string | null = null;
  if (positionals.length > 1) {
    const revokeTail =
      command === 'devices' && positionals[1] === 'revoke' && positionals.length <= 3;
    if (!revokeTail) {
      throw new ConfigError(
        `多余的位置参数 "${positionals.slice(1).join(' ')}"（撤销设备用 devices revoke <id>，其余配置走 -- 选项）`,
      );
    }
    positionalRevoke = positionals[2] ?? null;
  }

  const host = values.get('host') ?? env('HOST') ?? '127.0.0.1';
  const portRaw = values.get('port') ?? env('PORT') ?? String(DEFAULT_PORT);
  const port = parsePositiveInt(portRaw, '--port');
  const dataDir = path.resolve(
    expandTilde(values.get('data-dir') ?? env('DATA_DIR') ?? '~/.kepcup-server'),
  );
  const relayRaw = values.get('relay') ?? env('RELAY');
  const relayUrl = relayRaw !== undefined ? validateWsUrl(relayRaw, '--relay') : null;
  const explicitPublicUrl = values.get('public-url') ?? env('PUBLIC_URL');
  const publicUrl = derivePublicUrl(host, port, explicitPublicUrl);
  const keystore = (values.get('keystore') ?? 'system') as 'system' | 'file';
  if (keystore !== 'system' && keystore !== 'file') {
    throw new ConfigError(`--keystore 只支持 system 或 file（收到 "${keystore}"）`);
  }
  if (relayUrl !== null && values.get('public-url') !== undefined) {
    throw new ConfigError('--relay 与 --public-url 互斥：中转模式下配对地址由中转自身决定');
  }

  return {
    command,
    host,
    port,
    dataDir,
    publicUrl,
    relayUrl,
    keystore,
    webDir: values.get('web-dir') !== undefined ? path.resolve(values.get('web-dir') as string) : null,
    pairingManual: flags.has('pairing-manual'),
    autoPair: !flags.has('no-auto-pair'),
    acceptRequestId: values.get('accept') ?? null,
    revokeDeviceId: values.get('revoke') ?? positionalRevoke,
    json: flags.has('json'),
    publicUrlExplicit: explicitPublicUrl !== undefined,
  };
}

function emptyConfig(command: ServerConfig['command']): ServerConfig {
  return {
    command,
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    dataDir: '',
    publicUrl: '',
    relayUrl: null,
    keystore: 'system',
    webDir: null,
    pairingManual: false,
    autoPair: true,
    acceptRequestId: null,
    revokeDeviceId: null,
    json: false,
    publicUrlExplicit: false,
  };
}

export function usageText(): string {
  return `kepcup-server — KepCup headless 服务端（D102）

用法：
  kepcup-server [run] [选项]        起服务（缺省子命令）
  kepcup-server pair [选项]          生成配对码（打印链接与二维码；服务须在跑）
  kepcup-server devices [list]       列出已配对设备
  kepcup-server devices revoke <id>  撤销设备（踢下线并删除）
  kepcup-server version              打印版本

run 选项：
  --host <addr>          绑定地址（默认 127.0.0.1；局域网/公网用 0.0.0.0）
  --port <n>             端口（默认 8642）
  --data-dir <dir>       数据目录（默认 ~/.kepcup-server）
  --public-url <url>     客户端可访问的 ws(s):// 地址；通配 host 时必填；
                         反代 TLS 场景填 wss://<域名>
  --relay <url>          中转出站模式（不经本服务监听，anchor 主动连中转）
  --keystore <kind>      system（默认，Linux 需 Secret Service）| file（0600 明文，NAS 常用）
  --web-dir <dir>        PWA 静态目录（默认包内 web/）
  --pairing-manual       配对请求不自动接受，改由 pair --accept 人工确认
  --no-auto-pair         关闭首配自动出码

环境变量兜底：KEPCUP_SERVER_HOST / _PORT / _DATA_DIR / _PUBLIC_URL / _RELAY`;
}
