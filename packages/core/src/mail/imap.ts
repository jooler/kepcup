import { ImapFlow } from 'imapflow';
import {
  MAIL_IDLE_REFRESH_MS,
  MAIL_IMAP_ID_NAME,
  MAIL_IMAP_ID_VERSION,
  mailSearchUidLowerBound,
} from '@kepcup/shared';
import { isMailLoopbackHost, mailPrivateHostsAllowed, resolveMailHost } from './hosts.js';
import {
  parseMailSource,
  type FetchedMail,
  type MailImap,
  type MailImapOpenInput,
  type MailSearchQuery,
} from './message.js';

/**
 * imapflow 适配（D84）。
 *
 * - 连接前 resolveMailHost 钉死 IP，TLS SNI 仍用原主机名，避免 DNS 重绑定。
 * - `starttls` 设 doSTARTTLS=true，服务器不升级就失败，绝不落明文。
 * - 每条连接在登录后、SELECT 前发送 IMAP ID（RFC 2971，`name=KepCup`）。
 * - list/search 用 UID 窗口，不跑 SEARCH ALL。
 */

const SOURCE_MAX_BYTES = 512 * 1024;

export interface ImapflowConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  doSTARTTLS?: boolean;
  servername?: string;
  auth: { user: string; pass: string };
  clientInfo: { name: string; version: string };
  logger: false;
  tls: { rejectUnauthorized: boolean };
  disableAutoIdle: true;
  disableCompression: true;
  maxIdleTime: number;
}

/** 纯函数，方便单测核对 ssl / starttls 不会落到明文。 */
export function buildImapflowConnectOptions(
  input: MailImapOpenInput,
  resolved: { dialHost: string; servername: string | null },
): ImapflowConnectOptions {
  const testLoopback = mailPrivateHostsAllowed() && isMailLoopbackHost(input.host);
  const base: ImapflowConnectOptions = {
    host: resolved.dialHost,
    port: input.port,
    secure: false,
    auth: { user: input.username, pass: input.password },
    clientInfo: { name: MAIL_IMAP_ID_NAME, version: MAIL_IMAP_ID_VERSION },
    logger: false,
    tls: { rejectUnauthorized: !testLoopback },
    disableAutoIdle: true,
    disableCompression: true,
    maxIdleTime: MAIL_IDLE_REFRESH_MS,
    ...(resolved.servername !== null ? { servername: resolved.servername } : {}),
  };
  if (testLoopback) {
    // 假服务器只有明文 TCP。
    return { ...base, secure: false, doSTARTTLS: false };
  }
  if (input.secure === 'ssl') {
    return { ...base, secure: true };
  }
  // starttls：必须升级，服务器不支持就失败（拒绝明文）。
  return { ...base, secure: false, doSTARTTLS: true };
}

export function createImapflowOpener(): (input: MailImapOpenInput) => Promise<MailImap> {
  return (input) => openImapflow(input);
}

export async function openImapflow(input: MailImapOpenInput): Promise<MailImap> {
  const resolved = await resolveMailHost(input.host);
  const options = buildImapflowConnectOptions(input, resolved);
  const client = new ImapFlow(options);
  await client.connect();
  // 163 的 CAPABILITY 经常不含 ID，而库只在广告了 ID 时才发。SELECT 前强制再发一次。
  if (!client.capabilities.has('ID')) client.capabilities.set('ID', true);
  await (
    client as ImapFlow & {
      run(command: string, info: { name: string; version: string }): Promise<unknown>;
    }
  ).run('ID', { name: MAIL_IMAP_ID_NAME, version: MAIL_IMAP_ID_VERSION });
  return new ImapflowMail(client);
}

class ImapflowMail implements MailImap {
  #closed = false;

  constructor(private readonly client: ImapFlow) {}

  get capabilities(): readonly string[] {
    return [...this.client.capabilities.keys()];
  }

  async selectInbox(): Promise<{ uidNext: number; unseen: number | null }> {
    const mailbox = await this.client.mailboxOpen('INBOX', { readOnly: true });
    return {
      uidNext: mailbox.uidNext ?? 1,
      unseen: typeof mailbox.unseen === 'number' ? mailbox.unseen : null,
    };
  }

  async search(query: MailSearchQuery): Promise<number[]> {
    const mailbox = this.client.mailbox;
    const uidNext =
      typeof mailbox === 'object' && mailbox !== null ? (mailbox.uidNext ?? 1) : 1;
    const lower = mailSearchUidLowerBound(uidNext, {
      ...(query.minUid !== undefined ? { minUid: query.minUid } : {}),
    });
    const criteria: Record<string, unknown> = {
      uid: `${lower}:*`,
    };
    if (query.unseen === true) criteria.seen = false;
    if (query.from) criteria.from = query.from;
    if (query.to) criteria.to = query.to;
    if (query.subject) criteria.subject = query.subject;
    if (query.since) criteria.since = new Date(`${query.since}T00:00:00Z`);
    const found = await this.client.search(criteria, { uid: true });
    const uids = Array.isArray(found) ? found : [];
    return uids.filter((uid) => Number.isInteger(uid) && uid > 0);
  }

  async fetch(uids: number[], withSource: boolean): Promise<FetchedMail[]> {
    if (uids.length === 0) return [];
    const query = withSource
      ? { uid: true, envelope: true, source: { start: 0, maxLength: SOURCE_MAX_BYTES } }
      : { uid: true, envelope: true };
    const out: FetchedMail[] = [];
    for await (const message of this.client.fetch(uids, query, { uid: true })) {
      const fromSource =
        withSource && message.source
          ? await parseMailSource(Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source))
          : null;
      const envelope = message.envelope;
      out.push({
        uid: message.uid,
        from: fromSource?.from || envelopeFrom(envelope),
        to: fromSource?.to ?? [],
        subject: fromSource?.subject || envelope?.subject || '',
        date: fromSource?.date || (envelope?.date ? new Date(envelope.date).toISOString() : ''),
        text: fromSource?.text ?? '',
        attachments: fromSource?.attachments ?? [],
      });
    }
    return out;
  }

  async idle(signal: AbortSignal): Promise<'exists' | 'timeout' | 'close'> {
    if (signal.aborted) return 'timeout';
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: 'exists' | 'timeout' | 'close') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.client.off('exists', onExists);
        this.client.off('close', onClose);
        resolve(value);
      };
      const breakIdle = () => {
        if (!this.#closed) void this.client.noop().catch(() => undefined);
      };
      const onExists = () => breakIdle();
      const onClose = () => finish('close');
      const onAbort = () => breakIdle();
      const timer = setTimeout(onAbort, MAIL_IDLE_REFRESH_MS);
      signal.addEventListener('abort', onAbort);
      this.client.on('exists', onExists);
      this.client.on('close', onClose);
      // 等库里的 IDLE 真正结束再返回。提前 resolve 会让下一条 FETCH 撞上还没 DONE 的连接。
      this.client.idle().then(
        () => finish(signal.aborted ? 'timeout' : 'exists'),
        (error: unknown) => {
          if (signal.aborted) {
            finish('timeout');
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          this.client.off('exists', onExists);
          this.client.off('close', onClose);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async noop(): Promise<void> {
    await this.client.noop();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

function envelopeFrom(envelope: { from?: Array<{ name?: string; address?: string }> } | undefined): string {
  const first = envelope?.from?.[0];
  if (!first) return '';
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? first.name ?? '';
}
