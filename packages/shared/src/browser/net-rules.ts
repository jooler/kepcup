/**
 * Browser network rules (docs/dev/phases/P11-browser.md 任务 2, docs/design/
 * 14-models-and-browser.md 网络): public internet is reachable; loopback is
 * only reachable when the page's conversation has a bound project (local dev
 * servers); every other private, link-local and cloud-metadata address is
 * blocked. The browser does not go through the sandbox, so these rules are an
 * independent implementation (NOT srt) — the classification mirrors the always-
 * denied ranges of sandbox/policy.ts where the semantics agree (loopback is
 * conditional here).
 *
 * Pure functions: the main process feeds them host + resolved addresses, the
 * tool layer and tests reuse them. Fail-closed: any address that cannot be
 * classified blocks the request.
 */

export type AddressClass =
  /** 127.0.0.0/8, ::1, 0.0.0.0 (unroutable "this host"). */
  | 'loopback'
  /** RFC1918 + carrier-grade NAT + multicast/broadcast + reserved. */
  | 'private'
  /** 169.254.0.0/16, fe80::/10. */
  | 'linkLocal'
  /** Cloud instance metadata endpoints (AWS/GCP/Azure/...). */
  | 'metadata'
  /** Everything globally routable. */
  | 'public'
  /** Unparseable input — callers must treat this as blocked. */
  | 'unrecognized';

export interface BrowserNetworkContext {
  /** True when the page's conversation has a bound project (local ports). */
  allowLoopback: boolean;
}

export interface RequestDecision {
  action: 'allow' | 'cancel';
  /** Machine-readable reason when cancelled (also used in tool messages). */
  reason?: 'private-address' | 'metadata-address' | 'link-local-address' | 'loopback-not-allowed' | 'unresolvable-host' | 'unsupported-scheme';
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(address: string): number[] | null {
  const m = V4.exec(address);
  if (!m || m.length < 5) return null;
  const octets = [m[1], m[2], m[3], m[4]].map((group) => Number(group ?? ''));
  if (octets.some((o) => Number.isNaN(o) || o > 255)) return null;
  return octets;
}

/** Parses an IPv6 address (with IPv4-mapped tails) into 8 groups. */
export function parseIpv6(address: string): number[] | null {
  let rest = address.toLowerCase();
  let v4Tail: number[] | null = null;
  const v4m = /((?:\d{1,3}\.){3}\d{1,3})$/.exec(rest);
  if (v4m?.[1] !== undefined && rest.includes(':')) {
    v4Tail = parseIpv4(v4m[1]);
    if (v4Tail === null) return null;
    rest = rest.slice(0, rest.length - v4m[1].length);
    if (rest.endsWith(':')) rest = rest.slice(0, -1); // drop the separator colon
  }
  const parts = rest.split('::');
  if (parts.length > 2) return null;
  const [left = '', right = ''] = parts;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  let head: number[];
  let tail: number[];
  if (parts.length === 2) {
    const parsedHead = parseGroups(left);
    const parsedTail = parseGroups(right);
    if (parsedHead === null || parsedTail === null) return null;
    head = parsedHead;
    tail = parsedTail;
    const missing = 8 - head.length - tail.length - (v4Tail ? 2 : 0);
    if (missing < 0) return null;
    head.push(...new Array<number>(missing).fill(0));
  } else {
    const parsed = parseGroups(rest);
    if (parsed === null) return null;
    head = parsed;
    tail = [];
  }
  const groups = [...head, ...tail];
  if (v4Tail) {
    const [t0 = 0, t1 = 0, t2 = 0, t3 = 0] = v4Tail;
    groups.push((t0 << 8) | t1, (t2 << 8) | t3);
  }
  return groups.length === 8 ? groups : null;
}

function classifyIpv4(octets: number[]): AddressClass {
  const [a = 0, b = 0] = octets;
  const c = octets[2] ?? 0;
  const d = octets[3] ?? 0;
  if (a === 127 || a === 0) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Cloud metadata endpoints before the wider ranges they fall into
  // (100.100.100.200 sits inside carrier-grade NAT space).
  if (a === 100 && b === 100 && c === 100 && d >= 200) return 'metadata';
  if (a === 168 && b === 63 && c === 129) return 'metadata';
  if (a === 192 && b === 0 && c === 0 && d === 192) return 'metadata';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT
  if (a === 169 && b === 254) {
    // AWS/Azure/GCP metadata lives inside link-local space; label it so the
    // tool message can name the reason precisely.
    if (c === 169 && d === 254) return 'metadata';
    return 'linkLocal';
  }
  if (a === 192 && b === 0 && c === 2) return 'private'; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
  if (a === 224 || a === 240 || (a === 255 && b === 255 && c === 255 && d === 255)) {
    return 'private'; // multicast / reserved / broadcast
  }
  return 'public';
}

function classifyIpv6(input: number[]): AddressClass {
  const at = (i: number): number => input[i] ?? 0;
  const g = [0, 1, 2, 3, 4, 5, 6, 7].map(at);
  // :: (all zero) and ::1 (loopback), plus IPv4-mapped pairs judged by the
  // embedded v4 address.
  if (g.every((v) => v === 0)) return 'loopback'; // ::
  if (g.slice(0, 6).every((v) => v === 0) && g[6] === 0 && g[7] === 1) return 'loopback'; // ::1
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const t6 = at(6);
    const t7 = at(7);
    return classifyIpv4([t6 >> 8, t6 & 0xff, t7 >> 8, t7 & 0xff]);
  }
  const top = at(0);
  if ((top & 0xffc0) === 0xfe80) return 'linkLocal'; // fe80::/10
  if ((top & 0xfe00) === 0xfc00) {
    // Unique-local space also hosts cloud metadata endpoints (mirrors
    // sandbox/policy.ts always-denied list).
    if (g[0] === 0xfd00 && g[1] === 0xec2) return 'metadata'; // fd00:ec2::/32 (AWS)
    if (g[0] === 0xfd00 && g[1] === 0xc1 && g[6] === 0xa9fe && g[7] === 0xa9fe) return 'metadata';
    if (g[0] === 0xfd00 && g[1] === 0x42 && g[7] === 0x42) return 'metadata';
    if (g[0] === 0xfd00 && g[1] === 0x100 && g[6] === 0x100 && g[7] === 0x200) return 'metadata';
    if (g[0] === 0xfd00 && g[1] === 0xa9fe && g[2] === 0xa9fe && g[7] === 1) return 'metadata';
    if (g[0] === 0xfd20 && g[1] === 0x0ce && g[7] === 0x254) return 'metadata'; // fd20:ce::254
    return 'private';
  }
  if ((top & 0xff00) === 0xff00) return 'private'; // multicast
  return 'public';
}

/** Classifies one IP literal (IPv4 or IPv6). */
export function classifyAddress(address: string): AddressClass {
  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6) return classifyIpv6(v6);
  return 'unrecognized';
}

const REASON_BY_CLASS: Partial<Record<AddressClass, RequestDecision['reason']>> = {
  private: 'private-address',
  metadata: 'metadata-address',
  linkLocal: 'link-local-address',
  loopback: 'loopback-not-allowed',
};

/**
 * True for hostnames that RFC 6761 reserves for the loopback — they resolve to
 * 127.0.0.1/::1 (or are special-cased by resolvers) and follow loopback rules
 * even before DNS answers.
 */
export function isLoopbackHostname(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

export interface BrowserRequestContextInput {
  /** Hostname or IP literal from the URL. */
  host: string;
  /** All resolved addresses (DNS `all: true`); empty = unresolvable. */
  addresses: string[];
  /** Scheme of the request; only http/https are ever allowed through. */
  scheme: string;
  context: BrowserNetworkContext;
}

/**
 * Decide one request: blocked as soon as ANY resolved address falls into a
 * blocked class (fail-closed against multi-address DNS rebinding). Unresolvable
 * hosts and unsupported schemes are blocked too.
 */
export function decideBrowserRequest(input: BrowserRequestContextInput): RequestDecision {
  if (input.scheme !== 'http:' && input.scheme !== 'https:') {
    return { action: 'cancel', reason: 'unsupported-scheme' };
  }
  if (input.addresses.length === 0) {
    return { action: 'cancel', reason: 'unresolvable-host' };
  }
  const classes = input.addresses.map((a) => classifyAddress(a));
  for (const cls of classes) {
    if (cls === 'loopback') {
      if (!input.context.allowLoopback) return { action: 'cancel', reason: 'loopback-not-allowed' };
      continue;
    }
    if (cls === 'public') continue;
    return { action: 'cancel', reason: REASON_BY_CLASS[cls] ?? 'private-address' };
  }
  return { action: 'allow' };
}

const REASON_TEXT: Record<NonNullable<RequestDecision['reason']>, string> = {
  'private-address': '内网地址',
  'metadata-address': '云服务器元数据地址',
  'link-local-address': '链路本地地址',
  'loopback-not-allowed': '本机地址（当前对话未绑定 project）',
  'unresolvable-host': '无法解析的主机',
  'unsupported-scheme': '不支持的协议',
};

/** Human-readable block reason for tool results (already untrusted-safe text). */
export function blockReasonText(reason: NonNullable<RequestDecision['reason']>): string {
  return REASON_TEXT[reason];
}
