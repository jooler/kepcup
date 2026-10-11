import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '@kepcup/shared';
import { assertNoPrivateAddress, isPrivateAddress } from '../infra/safe-dispatcher.js';
import '../infra/test-hooks.js';

/**
 * 自定义 IMAP/SMTP 主机的出口检查（D84 §8.5）。
 *
 * 真正的防 DNS 重绑定做法：解析一次、校验私网，然后用**钉死的 IP** 建连，
 * TLS 的 SNI / 证书名仍用原来的主机名（servername）。库不会再对主机名做第二次
 * DNS，校验与连接之间没有 TOCTOU 窗口。
 *
 * 测试里的假服务器在本机，只有测试构建且显式打开 KEPCUP_MAIL_ALLOW_PRIVATE 才放行。
 */

export function mailPrivateHostsAllowed(): boolean {
  return __KEPCUP_TEST_HOOKS__ === true && process.env.KEPCUP_MAIL_ALLOW_PRIVATE === '1';
}

export function isMailLoopbackHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

export type MailHostLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface MailHostResolved {
  /** 用户填写的主机（日志用）。 */
  originalHost: string;
  /** 实际 dial 的地址：公网 IP 字面量，或测试放行时的原主机。 */
  dialHost: string;
  /** TLS SNI / 证书校验名。连 IP 字面量且没有主机名时为 null。 */
  servername: string | null;
}

const defaultLookup: MailHostLookup = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * 解析并钉死邮件服务器地址。调用方应把 `dialHost` 交给 IMAP/SMTP 库的 host，
 * 把 `servername`（若有）交给 TLS SNI，不要再让库按原主机名解析。
 */
export async function resolveMailHost(
  host: string,
  lookup: MailHostLookup = defaultLookup,
): Promise<MailHostResolved> {
  const trimmed = host.trim();
  if (trimmed.length === 0) {
    throw new AppError('INVALID_INPUT', '邮件服务器地址为空');
  }
  const bare = trimmed.replace(/^\[|\]$/g, '');
  if (mailPrivateHostsAllowed()) {
    return {
      originalHost: bare,
      dialHost: bare,
      servername: net.isIP(bare) ? null : bare,
    };
  }
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw privateHost(bare);
    return { originalHost: bare, dialHost: bare, servername: null };
  }
  if (bare.toLowerCase() === 'localhost' || bare.toLowerCase().endsWith('.localhost')) {
    throw privateHost(bare);
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(bare);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('MAIL_CONNECT_FAILED', `无法解析邮件服务器 ${bare}：${message}`);
  }
  if (records.length === 0) {
    throw new AppError('MAIL_CONNECT_FAILED', `无法解析邮件服务器 ${bare}`);
  }
  try {
    assertNoPrivateAddress(records);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('MAIL_CONNECT_FAILED', message);
  }
  // 优先 IPv4：不少邮件服务器的 IPv6 可达性较差。
  const chosen = records.find((entry) => entry.family === 4) ?? records[0]!;
  return {
    originalHost: bare,
    dialHost: chosen.address,
    servername: bare,
  };
}

/** 只做出口校验（不返回钉死地址）。建连请用 {@link resolveMailHost}。 */
export async function assertMailHost(host: string, lookup?: MailHostLookup): Promise<void> {
  await resolveMailHost(host, lookup);
}

function privateHost(host: string): AppError {
  return new AppError(
    'MAIL_CONNECT_FAILED',
    `拒绝连接内网或本机地址 ${host}。邮件服务器应是公网主机。`,
  );
}
