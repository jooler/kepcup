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
  /** 当前 flags（\Seen 等 + 自定义关键字）；服务器不给时缺省。 */
  flags?: string[];
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
  /** 命中该关键字（自定义标签 / keyword）的邮件。 */
  keyword?: string;
}

/** SELECT INBOX 的结果。`unseen` 是未读邮件的数量（STATUS UNSEEN），不是 SELECT 里 [UNSEEN n] 的序号。 */
export interface MailboxState {
  uidNext: number;
  /** UIDVALIDITY；服务器不给时为 null。 */
  uidValidity: number | null;
  unseen: number | null;
}

/** 一封信当前的 flags：系统旗标（\Seen 等）加自定义关键字（标签）。 */
export interface MailFlagsEntry {
  uid: number;
  flags: string[];
}

/** LIST 出来的一个文件夹。specialUse 是 '\Drafts' 这类 special-use 旗标，识别不了为 null。 */
export interface MailFolderInfo {
  path: string;
  name: string;
  specialUse: string | null;
  delimiter: string | null;
  /** 服务器没标 \Noselect。 */
  selectable: boolean;
}

/** MOVE / COPY 的结果：UIDPLUS 服务器给的新旧 UID 对照；没有就 null（Bot 只知道信过去了）。 */
export interface MailMoveResult {
  uidMap: Record<number, number> | null;
}

/** STORE 的操作方向。 */
export type MailFlagOp = 'add' | 'remove' | 'set';

export interface MailImap {
  readonly capabilities: readonly string[];
  /** 读写 SELECT INBOX（收信主循环和写操作都挂在这条会话上）。 */
  selectInbox(): Promise<MailboxState>;
  /** 读写 SELECT 任意文件夹（浏览 / 标记子文件夹用）。 */
  select(path: string): Promise<MailboxState>;
  /** 当前 SELECT 的文件夹路径；没选中为 null。 */
  selectedPath(): string | null;
  /**
   * 订阅连接级错误（socket 断开、协议错误等库在空闲时 emit 的 `error`）。
   * 返回取消订阅函数；连接 close 后所有订阅自动清掉。
   */
  onError(listener: (error: Error) => void): () => void;
  search(query: MailSearchQuery): Promise<number[]>;
  /** `withSource` 为 false 时只取信封，text 为空。 */
  fetch(uids: number[], withSource: boolean): Promise<FetchedMail[]>;
  /** 批量取 flags（标签列表 / 状态核对）。 */
  fetchFlags(uids: number[]): Promise<MailFlagsEntry[]>;
  /**
   * STORE flags。返回 false 表示服务器把全部目标旗标拒了（PERMANENTFLAGS 不含），
   * 部分成功仍算 true——库层面只回一个布尔，逐旗标结果拿不到。
   */
  storeFlags(uids: number[], op: MailFlagOp, flags: string[]): Promise<boolean>;
  /** MOVE（服务器没有 MOVE 能力时库自动 COPY + 删除回退）。 */
  move(uids: number[], destination: string): Promise<MailMoveResult>;
  /**
   * \Deleted + EXPUNGE（硬删除）。没有 UIDPLUS 的服务器上是全箱 EXPUNGE，
   * 会把别的客户端挂起的删除一起收掉——调用方必须先确认 capabilities 里有 UIDPLUS。
   */
  deleteMessages(uids: number[]): Promise<boolean>;
  /** APPEND 原始 RFC822 到指定文件夹（存草稿）。返回新 uid；服务器不给为 null。 */
  append(path: string, source: Buffer, flags: string[]): Promise<number | null>;
  /** 列出全部文件夹（LIST + special-use 归类）。 */
  listFolders(): Promise<MailFolderInfo[]>;
  /** 已存在不算错（created=false）。 */
  createFolder(path: string): Promise<{ created: boolean }>;
  renameFolder(path: string, newPath: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
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
