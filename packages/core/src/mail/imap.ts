import { ImapFlow } from 'imapflow';
import {
  MAIL_IDLE_REFRESH_MS,
  MAIL_IMAP_ID_NAME,
  MAIL_IMAP_ID_VERSION,
  mailSearchUidLowerBound,
} from '@kepcup/shared';
import { isMailLoopbackHost, mailPrivateHostsAllowed, resolveMailHost } from './hosts.js';
import {
  mailHostNeedsImapId,
  parseMailSource,
  safeIsoDate,
  type FetchedMail,
  type MailImap,
  type MailboxState,
  type MailImapOpenInput,
  type MailSearchQuery,
} from './message.js';

/**
 * imapflow 适配（D84）。
 *
 * - 连接前 resolveMailHost 钉死 IP，TLS SNI 仍用原主机名，避免 DNS 重绑定。
 * - `starttls` 设 doSTARTTLS=true，服务器不升级就失败，绝不落明文。
 * - IMAP ID（RFC 2971，`name=KepCup`）：库对广告了 ID 的服务器自己会发；网易系不广告却要求，这里补发。
 * - 连接级 `error` 事件在 open 时就接住，转给会话层；绝不让它变成未处理异常。
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
  // imapflow 在连接建立之后出的错（socket 复位、协议错、超时）只会 emit('error')；
  // 没有监听器就是未处理异常，直接带崩 core。必须在 connect 之前就挂上，且整个连接生命周期都不摘。
  const mail = new ImapflowMail(client);
  try {
    await client.connect();
    await sendImapIdIfNeeded(client, input);
  } catch (error) {
    mail.dispose();
    client.close();
    throw error;
  }
  return mail;
}

/**
 * 网易系（163/126/yeah.net/188）的 CAPABILITY 不广告 ID，却要求 SELECT 前见过 ID；库只在广告了
 * ID 时才发，所以这里补一次。其余服务器不需要：已广告 ID 的，库在登录前后已经发过；
 * 不支持 ID 的（Courier、hMailServer、部分 Exchange）收到会回 BAD，甚至断连——所以不强发。
 * 强发的这一次也吞掉 NO/BAD：服务器不吃就算了，能不能登录由后面的 SELECT 决定。
 */
async function sendImapIdIfNeeded(client: ImapFlow, input: MailImapOpenInput): Promise<void> {
  const force = input.forceId ?? mailHostNeedsImapId(input.host);
  if (!force || client.capabilities.has('ID')) return;
  // 库的 ID 命令以 capabilities 里有 ID 为前提，临时置位，发完还原，不把假能力暴露给调用方。
  client.capabilities.set('ID', true);
  try {
    await (
      client as ImapFlow & {
        run(command: string, info: { name: string; version: string }): Promise<unknown>;
      }
    ).run('ID', { name: MAIL_IMAP_ID_NAME, version: MAIL_IMAP_ID_VERSION });
  } catch {
    // BAD / NO：忽略。
  } finally {
    client.capabilities.delete('ID');
  }
}

class ImapflowMail implements MailImap {
  #closed = false;
  #failure: Error | null = null;
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #handleError = (error: unknown): void => {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#failure ??= failure;
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(failure);
      } catch {
        // 订阅方的异常不能再冒出来。
      }
    }
  };

  constructor(private readonly client: ImapFlow) {
    client.on('error', this.#handleError);
  }

  get capabilities(): readonly string[] {
    return [...this.client.capabilities.keys()];
  }

  onError(listener: (error: Error) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#errorListeners.add(listener);
    const early = this.#failure;
    // 订阅之前已经出过错（open 与订阅之间的间隙）：补发一次，别漏。
    if (early !== null) queueMicrotask(() => this.#errorListeners.has(listener) && listener(early));
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  /** 订阅方清空。库自己的 error 处理器保留：关闭过程中库仍可能 emit，没人接就会崩进程。 */
  dispose(): void {
    this.#errorListeners.clear();
  }

  async selectInbox(): Promise<MailboxState> {
    const mailbox = await this.client.mailboxOpen('INBOX', { readOnly: true });
    // mailbox.unseen 是 SELECT 的 [UNSEEN n]——第一封未读的序号，不是数量；数量要用 STATUS。
    const unseen = await this.client
      .status('INBOX', { unseen: true })
      .then((status) => (status && typeof status.unseen === 'number' ? status.unseen : null))
      // 个别服务器不允许对已选中的邮箱 STATUS：未读数未知，不影响收信。
      .catch(() => null);
    const validity = mailbox.uidValidity === undefined ? null : Number(mailbox.uidValidity);
    return {
      uidNext: mailbox.uidNext ?? 1,
      uidValidity: validity !== null && Number.isSafeInteger(validity) && validity > 0 ? validity : null,
      unseen,
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
    const query = {
      uid: true,
      envelope: true,
      internalDate: true,
      ...(withSource ? { source: { start: 0, maxLength: SOURCE_MAX_BYTES } } : {}),
    };
    const out: FetchedMail[] = [];
    for await (const message of this.client.fetch(uids, query, { uid: true })) {
      // 单封信解析不了不能拖垮整批：降级成信封（或空壳），让调用方的 UID 游标照常越过它。
      try {
        out.push(await toFetchedMail(message, withSource));
      } catch {
        out.push({ uid: message.uid, from: '', to: [], subject: '', date: '', text: '', attachments: [] });
      }
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
    this.dispose();
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

type FetchedMessage = Exclude<Awaited<ReturnType<ImapFlow['fetchOne']>>, false | undefined>;

async function toFetchedMail(message: FetchedMessage, withSource: boolean): Promise<FetchedMail> {
  let parsed: Awaited<ReturnType<typeof parseMailSource>> | null = null;
  if (withSource && message.source) {
    try {
      parsed = await parseMailSource(
        Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source),
      );
    } catch {
      parsed = null;
    }
  }
  const envelope = message.envelope;
  return {
    uid: message.uid,
    from: parsed?.from || envelopeFrom(envelope),
    to: parsed?.to ?? [],
    subject: parsed?.subject || envelope?.subject || '',
    // Date 头不可解析时 imapflow 把 envelope.date 留成原始字符串（mailparser 则悄悄换成「现在」）：
    // 信封日期有效就用它，否则用服务器的 INTERNALDATE，最后才用正文解析出的日期。
    date: safeIsoDate(envelope?.date) || safeIsoDate(message.internalDate) || parsed?.date || '',
    text: parsed?.text ?? '',
    attachments: parsed?.attachments ?? [],
  };
}

function envelopeFrom(envelope: { from?: Array<{ name?: string; address?: string }> } | undefined): string {
  const first = envelope?.from?.[0];
  if (!first) return '';
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? first.name ?? '';
}
