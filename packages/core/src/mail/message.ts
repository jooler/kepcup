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

export interface MailImap {
  readonly capabilities: readonly string[];
  selectInbox(): Promise<{ uidNext: number; unseen: number | null }>;
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
}

export type MailImapOpener = (input: MailImapOpenInput) => Promise<MailImap>;

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
    date: parsed.date ? parsed.date.toISOString() : '',
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
