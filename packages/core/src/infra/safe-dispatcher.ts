import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';

/**
 * SSRF 连接防线（从 `search/service.ts` 抽出，供 web_fetch 与 OAuth 发现 / 令牌请求共用）。
 *
 * 真正的防线是 undici `Agent` 的 `connect.lookup`：对**主机名**的每一次解析都在 TCP
 * 连接前校验解析结果，私网 / 保留地址直接拒绝——校验与连接用同一次解析，不存在
 * DNS rebinding 窗口。注意 IP 字面量不经过 `lookup`（Node 直连），所以调用方对 URL
 * 的主机是 IP 字面量时须先行用 {@link assertNoPrivateAddress} 校验。
 */

/** 拒绝信息的固定前缀：undici 把连接阶段失败包成 `fetch failed`，调用方靠它从 cause 链还原原因。 */
export const PRIVATE_ADDRESS_REJECTION_PREFIX = '拒绝访问内网/保留地址';

/**
 * 解析结果里出现私网/保留地址即抛错（错误信息以 {@link PRIVATE_ADDRESS_REJECTION_PREFIX}
 * 开头）。先行 URL 校验与连接时校验（{@link createSafeDispatcher}）共用同一判定。
 */
export function assertNoPrivateAddress(addresses: Array<{ address: string }>): void {
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`${PRIVATE_ADDRESS_REJECTION_PREFIX}：${entry.address}`);
    }
  }
}

/** IPv4 私网、环回、链路本地、CGNAT、文档 / 基准测试段、组播与保留段。 */
function isPrivateIPv4(a: number, b: number, c: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // 链路本地 + AWS/GCP 元数据 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 IETF 协议、192.0.2.0/24 文档
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 文档
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 文档
  if (a >= 224) return true; // 组播/保留
  return false;
}

/**
 * 把 IPv6 文本解析为 16 字节（支持 `::` 压缩与末尾内嵌点分 IPv4）；非法返回 null。
 * 不依赖输入是否已规范化：WHATWG `URL` 会把 `[::ffff:127.0.0.1]` 规范化为 `::ffff:7f00:1`，
 * 只有按字节解析才能稳妥识别其中内嵌的 IPv4。
 */
function parseIPv6(address: string): Uint8Array | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!net.isIPv6(text)) return null;
  // 末尾内嵌的点分 IPv4 先转成两个十六进制组。
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const rest = halves[1] === '' || halves[1] === undefined ? [] : halves[1].split(':');
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const value = Number.parseInt(groups[i] ?? '', 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/**
 * IPv4/IPv6 私网、环回、链路本地、保留段与云元数据地址。IPv6 按 16 字节解析：
 * IPv4 映射（`::ffff:0:0/96`）、NAT64（`64:ff9b::/96`）、6to4（`2002::/16`）会取出内嵌 IPv4 复判；
 * IPv4 兼容（`::/96`）、Teredo（`2001::/32`）、站点本地（`fec0::/10`）、链路本地（`fe80::/10`）、
 * ULA（`fc00::/7`）、组播（`ff00::/8`）、文档（`2001:db8::/32`）与丢弃前缀（`100::/64`）一律拒绝。
 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    return isPrivateIPv4(a, b, c);
  }
  const bytes = parseIPv6(address);
  if (bytes === null) return false;
  const at = (i: number): number => bytes[i] ?? 0;
  const embedded = (offset: number): boolean =>
    isPrivateIPv4(at(offset), at(offset + 1), at(offset + 2));
  const zeroRange = (from: number, to: number): boolean => {
    for (let i = from; i < to; i += 1) if (at(i) !== 0) return false;
    return true;
  };
  if (zeroRange(0, 10) && at(10) === 0xff && at(11) === 0xff) return embedded(12); // ::ffff:a.b.c.d
  if (zeroRange(0, 12)) return true; // ::/96：未指定、环回、IPv4 兼容
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) {
    // 64:ff9b::/96 NAT64 取内嵌 IPv4；64:ff9b:1::/48 本地使用，拒绝。
    return zeroRange(4, 12) ? embedded(12) : true;
  }
  if (at(0) === 0x01 && at(1) === 0x00 && zeroRange(2, 8)) return true; // 100::/64 丢弃前缀
  if (at(0) === 0x20 && at(1) === 0x02) return embedded(2); // 6to4
  if (at(0) === 0x20 && at(1) === 0x01) {
    if (at(2) === 0 && at(3) === 0) return true; // Teredo 2001::/32
    if (at(2) === 0x0d && at(3) === 0xb8) return true; // 文档 2001:db8::/32
  }
  if ((at(0) & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0xc0) return true; // fec0::/10 站点本地
  if (at(0) === 0xff) return true; // 组播
  return false;
}

/**
 * 沿 cause 链找回连接校验的拒绝原因（undici 会把它包成 `TypeError: fetch failed`）；
 * 不是私网拒绝则返回 null。
 */
export function connectRejectionText(error: unknown): string | null {
  let current = error instanceof Error ? error : undefined;
  while (current !== undefined) {
    if (current.message.startsWith(PRIVATE_ADDRESS_REJECTION_PREFIX)) return current.message;
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return null;
}

/**
 * 连接时校验解析地址的 undici Agent：fetch 内部对同一 hostname 的（再次）解析也走本
 * lookup，私网地址在 TCP 连接前即被拒绝。
 */
export function createSafeDispatcher(
  /** 解析器（测试可注入，模拟 DNS 重绑定：探测时返回公网地址、连接时返回内网地址）。 */
  resolve: (
    hostname: string,
    family: 4 | 6 | undefined,
  ) => Promise<Array<{ address: string; family: number }>> = (hostname, family) =>
    dns.lookup(hostname, { all: true, ...(family !== undefined ? { family } : {}) }),
): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        resolve(hostname, options.family === 4 || options.family === 6 ? options.family : undefined)
          .then((addresses) => {
            try {
              assertNoPrivateAddress(addresses);
              callback(null, addresses);
            } catch (error) {
              callback(error as Error, []);
            }
          })
          .catch((error: Error) => callback(error, []));
      },
    },
  });
}

let shared: Agent | undefined;

/** 进程内共享的守卫 Agent（搜索 / OAuth 共用连接池）。 */
export function sharedSafeDispatcher(): Agent {
  shared ??= createSafeDispatcher();
  return shared;
}
