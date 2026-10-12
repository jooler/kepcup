import { simpleParser } from 'mailparser';
import { MAIL_SNIPPET_MAX_CHARS } from '@kepcup/shared';

/** 一封信交给会话层的形状。正文已抽成纯文本，附件只有元数据。 */
export interface FetchedMail {
  uid: number;
  from: string;
  to: string[];
  subject: string;
  date: string;
  text: string;
  attachments: MailAttachmentMeta[];
}

export interface MailAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

export interface MailSearchQuery {
  from?: string;
  to?: string;
  subject?: string;
  /** YYYY-MM-DD。 */
  since?: string;
  unseen?: boolean;
  /** 含本 UID。 */
  minUid?: number;
}

/** SELECT INBOX 的结果。`unseen` 是未读邮件的数量（STATUS UNSEEN），不是 SELECT 里 [UNSEEN n] 的序号。 */
export interface MailboxState {
  uidNext: number;
  /** UIDVALIDITY；服务器不给时为 null。 */
  uidValidity: number | null;
  unseen: number | null;
}

export interface MailImap {
  readonly capabilities: readonly string[];
  selectInbox(): Promise<MailboxState>;
  /**
   * 订阅连接级错误（socket 断开、协议错误等库在空闲时 emit 的 `error`）。
   * 返回取消订阅函数；连接 close 后所有订阅自动清掉。
   */
  onError(listener: (error: Error) => void): () => void;
  search(query: MailSearchQuery): Promise<number[]>;
  /** `withSource` 为 false 时只取信封，text 为空。 */
  fetch(uids: number[], withSource: boolean): Promise<FetchedMail[]>;
  idle(signal: AbortSignal): Promise<'exists' | 'timeout' | 'close'>;
  noop(): Promise<void>;
  close(): Promise<void>;
}

export interface MailImapOpenInput {
  host: string;
  port: number;
  secure: 'ssl' | 'starttls';
  username: string;
  password: string;
  /**
   * 是否在 SELECT 前强制发 IMAP ID（RFC 2971）。省略时按主机判断（网易系需要），
   * 见 {@link mailHostNeedsImapId}。
   */
  forceId?: boolean;
}

export type MailImapOpener = (input: MailImapOpenInput) => Promise<MailImap>;

/**
 * 网易系邮箱（163 / 126 / yeah.net / 188）的 CAPABILITY 不广告 ID，却在 SELECT 前
 * 没见过 ID 就回 `Unsafe Login`。别的服务器不需要，也不一定支持（Courier、hMailServer 会回 BAD）。
 */
export function mailHostNeedsImapId(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return /(^|\.)(163\.com|126\.com|yeah\.net|188\.com)$/.test(bare);
}

/** 日期值 → ISO 字符串；不是有效日期（imapflow 对解析不了的 Date 头会留原始字符串）返回 ''。 */
export function safeIsoDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const date = value instanceof Date ? value : new Date(String(value));
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : '';
}

/**
 * 邮件头字段（发件人、主题）进入提示词、历史和卡片前的清理：去控制字符与换行（防止伪造多行结构），
 * 折叠空白，限长。
 */
export function oneLineMailField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const collapsed = value.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

export const MAIL_FROM_MAX_CHARS = 200;
export const MAIL_SUBJECT_MAX_CHARS = 300;

export function mailSnippet(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAIL_SNIPPET_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, MAIL_SNIPPET_MAX_CHARS)}…`;
}

export async function parseMailSource(source: Buffer): Promise<Omit<FetchedMail, 'uid'>> {
  const parsed = await simpleParser(source);
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = (parsed.text ?? '').trim() || stripHtml(html);
  const toField = parsed.to;
  const toList = (Array.isArray(toField) ? toField : toField ? [toField] : []).flatMap((entry) =>
    entry.value.map((item) => item.address ?? '').filter((address) => address.length > 0),
  );
  return {
    from: parsed.from?.text ?? '',
    to: toList,
    subject: parsed.subject ?? '',
    date: safeIsoDate(parsed.date),
    text,
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? 'attachment',
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatAddressList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '（无）';
}
