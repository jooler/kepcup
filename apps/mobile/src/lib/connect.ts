import { parsePairingLink, type PairingLink } from '@kepcup/shared';

/**
 * 连接目标解析与交接 URL 构建(D122 §3):首页把「扫码 / 输入」的结果规范化成
 * 连接目标,再拼出 WebView 交接地址 `<origin>/?shell=native&shellBack=<首页>`。
 *
 * 目标两类(D96 / D102 的三种连接方式归一):
 * - `pairing`:配对链接(`<origin>/#pair=<relayUrl>,<sessionId>,<secret>`),交接后
 *   由 Gate 走 D96 配对流程;
 * - `server`:headless 服务地址(密码模式登录 / 配对模式门),交接后由 Gate 的
 *   认证探测分流(probeServerAuth)。
 *
 * 纯函数、无 Capacitor 依赖(测试直接跑);首页 URL 由调用方传入(shellBack)。
 */

export type ConnectTarget =
  { kind: 'pairing'; link: PairingLink; sourceUrl: string } | { kind: 'server'; url: string };

/** 中转地址协议 → 托管 PWA 的 http(s) 源(与 core pairingQrUrl 的推导一致);非 ws(s) 原样返回。 */
export function relayOrigin(relayUrl: string): string {
  if (relayUrl.startsWith('wss:')) return `https:${relayUrl.slice(4)}`;
  if (relayUrl.startsWith('ws:')) return `http:${relayUrl.slice(3)}`;
  return relayUrl;
}

/**
 * 解析连接目标。优先识别配对链接(整条 URL 或裸 `#pair=`/`pair=` 片段都认,
 * 与 Gate 的粘贴框同宽容度);否则按 http(s) 服务地址解析。都不是 → null
 * (UI 提示「不是 KepCup 配对码或服务地址」)。
 */
export function resolveConnectTarget(raw: string): ConnectTarget | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const link = parsePairingLink(text);
  if (link !== null) return { kind: 'pairing', link, sourceUrl: text };
  const url = normalizeAddressInput(text);
  if (url === null) return null;
  return { kind: 'server', url };
}

/**
 * 规范化手动输入的服务地址:补协议、校验 http(s)。补协议的启发式——裸 IP /
 * localhost / 带显式端口 / 局域网后缀按 http(自建 headless 直连常态),其余
 * 域名按 https(反代 TLS 是 README 推荐部署)。无法识别 → null。
 */
export function normalizeAddressInput(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.includes('#pair=')) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
  // 无协议:取 host[:port][/path] 形状。以第一个 `/` 切开判断主机部分。
  const hostPart = text.split('/', 1)[0] ?? '';
  if (!looksLikeHost(hostPart)) return null;
  const scheme = addressScheme(hostPart);
  try {
    return new URL(`${scheme}://${text}`).toString();
  } catch {
    return null;
  }
}

/** 主机形状:host(:port)?——点分 IPv4 / [IPv6] / 域名标签序列。 */
function looksLikeHost(host: string): boolean {
  if (host.length === 0 || host.includes('@')) return false;
  // [IPv6][:port]
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end <= 0) return false;
    const rest = host.slice(end + 1);
    return rest === '' || /^:\d+$/.test(rest);
  }
  const hostOnly = host.includes(':') ? host.slice(0, host.indexOf(':')) : host;
  if (hostOnly.length === 0) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostOnly)) return true;
  // 域名:至少一个点或单标签(localhost),标签为字母数字/连字符。
  return /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
    hostOnly,
  );
}

function addressScheme(hostPort: string): 'http' | 'https' {
  const host = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : hostPort.includes(':')
      ? hostPort.slice(0, hostPort.indexOf(':'))
      : hostPort;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.lan')) return 'http';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return 'http';
  // IP 字面量统一按 http(与 IPv4 同语义);[IPv6] 无端口也在此命中。
  if (/^\[[0-9a-fA-F:]+\]$/.test(host)) return 'http';
  if (hostPort.includes(':') && /:\d+$/.test(hostPort)) return 'http';
  return 'https';
}

/**
 * 构建交接 URL:目标地址 + `?shell=native&shellBack=<首页>`(查询参数在 hash 前;
 * Gate 只读 hash 与 storage,多出的参数不影响任何流程)。配对链接保留原 hash;
 * 裸片段(#pair=… / pair=…)没有源可取,按中转协议推导 PWA 源。
 */
export function buildConnectUrl(target: ConnectTarget, homeUrl: string): string {
  if (target.kind === 'server') {
    const url = new URL(target.url);
    url.searchParams.set('shell', 'native');
    url.searchParams.set('shellBack', homeUrl);
    return url.toString();
  }
  // 配对链接:优先用扫码原文里的源(自建反代子路径也保留);裸片段(#pair=… / pair=…)
  // 没有源可取,按中转协议推导 PWA 源(与 core pairingQrUrl 同款推导)。
  let url: URL;
  if (/^https?:\/\//i.test(target.sourceUrl)) {
    url = new URL(target.sourceUrl);
  } else {
    url = new URL(relayOrigin(target.link.relayUrl));
    url.hash = target.sourceUrl.startsWith('#') ? target.sourceUrl : `#${target.sourceUrl}`;
  }
  url.searchParams.set('shell', 'native');
  url.searchParams.set('shellBack', homeUrl);
  return url.toString();
}

/** 展示用主机名(最近连接列表的 label):host(:port),去协议去路径。 */
export function targetLabel(target: ConnectTarget): string {
  if (target.kind === 'pairing') {
    if (/^https?:\/\//i.test(target.sourceUrl)) {
      try {
        return new URL(target.sourceUrl).host;
      } catch {
        // 落到中转地址展示。
      }
    }
    try {
      return new URL(target.link.relayUrl).host;
    } catch {
      return target.link.sessionId.slice(0, 6);
    }
  }
  try {
    return new URL(target.url).host;
  } catch {
    return target.url;
  }
}

/** 最近连接的稳定 id:同目标去重的键。pairing 段带 sessionId——同一公共中转上的两台桌面 host 相同,须各自成条目。 */
export function targetId(target: ConnectTarget): string {
  return target.kind === 'pairing'
    ? `pairing:${targetLabel(target)}:${target.link.sessionId}`
    : `server:${target.url}`;
}
