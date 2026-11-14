import net from 'node:net';

/**
 * 只够 imapflow 走完登录、ID、SELECT、UID 搜索 / 收取、IDLE 和写操作的假服务器。
 * - `requireId` 时，SELECT / EXAMINE 之前没发过 ID 就回 Unsafe Login（163 的行为）。
 * - `advertiseId`：CAPABILITY 里广告 ID（默认不广告，和 163 一样）。
 * - `rejectId`：收到 ID 回 BAD（Courier / hMailServer 这类不支持 ID 的服务器）。
 * - `rejectLogin`：LOGIN 回 NO；字符串则是应答文本（默认 AUTHENTICATIONFAILED）。
 * - `advertiseMove` / `advertiseUidPlus`：CAPABILITY 里是否广告 MOVE / UIDPLUS（默认都广告）。
 *   关掉分别可测「无 MOVE 走 COPY+删除回退」与「无 UIDPLUS 拒绝精确删除」。
 * - 文件夹是扁平单层（分隔符 "/"），`SELECT` 后才有选中态；SELECT 读写、EXAMINE 只读。
 * - APPEND 用 IMAP literal（{n} + 续行 + n 字节），按字节累计，UTF-8 正文不按字符截断。
 */

export interface FakeImapOptions {
  requireId?: boolean;
  advertiseIdle?: boolean;
  advertiseId?: boolean;
  rejectId?: boolean;
  rejectLogin?: boolean | string;
  advertiseMove?: boolean;
  advertiseUidPlus?: boolean;
  /** SELECT 回报的 PERMANENTFLAGS 原文（缺省全量 + \*）。收窄可测「服务器拒旗标」。 */
  permanentFlags?: string;
}

const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'] as const;

export interface FakeMessage {
  uid: number;
  raw: string;
  /** 当前 flags：系统旗标（\Seen 等）加自定义关键字（标签）。 */
  flags: string[];
  /** 旧用例的兼容视图：flags 是否含 \Seen。 */
  readonly seen: boolean;
}

export interface FakeFolder {
  path: string;
  /** special-use 旗标（'\Drafts' 等）；INBOX 为 null。 */
  specialUse: string | null;
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
}

function makeMessage(uid: number, raw: string, flags: string[]): FakeMessage {
  return {
    uid,
    raw,
    flags: [...flags],
    get seen(): boolean {
      return this.flags.includes('\\Seen');
    },
  };
}

export class FakeImapServer {
  port = 0;
  /** 全部文件夹；INBOX 在构造时就存在，其余经 `addFolder` / `CREATE` 出现。 */
  readonly folders = new Map<string, FakeFolder>();
  /** 兼容旧用例：INBOX 的邮件。 */
  get messages(): FakeMessage[] {
    return this.inbox.messages;
  }
  /** 兼容旧字段：INBOX 的 UIDVALIDITY。 */
  get uidValidity(): number {
    return this.inbox.uidValidity;
  }
  set uidValidity(value: number) {
    this.inbox.uidValidity = value;
  }
  /** 收到的 ID 命令次数（含被拒绝的）。 */
  idCommands = 0;
  /** LOGIN 尝试次数（含被拒绝的）。 */
  loginAttempts = 0;
  /** 累计接受的 TCP 连接数。 */
  connections = 0;
  /** 为 true 时 LOGIN 被拒绝（运行中可切换）。 */
  rejectLogin: boolean | string;
  /** 额外延迟（毫秒）：UID SEARCH 的应答。给并发用例造出补拉窗口。 */
  searchDelayMs = 0;
  /** 最近一次 UID SEARCH 返回了多少个 UID（测试用，确认窗口生效）。 */
  lastSearchReturned = 0;
  /** 最近一次 UID SEARCH 的参数原文。 */
  lastSearchCommand = '';
  /** 新建文件夹时分配的 UIDVALIDITY 序列；INBOX 占了 1。 */
  #uidValiditySeq = 2;
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();
  /** 正在 IDLE 的 socket → 选中文件夹路径（只有 INBOX 的收 EXISTS 推送）。 */
  #idling = new Map<net.Socket, string>();
  readonly #requireId: boolean;
  readonly #advertiseIdle: boolean;
  readonly #advertiseId: boolean;
  readonly #rejectId: boolean;
  readonly #advertiseMove: boolean;
  readonly #advertiseUidPlus: boolean;
  readonly #permanentFlags: string;

  constructor(options: FakeImapOptions = {}) {
    this.#requireId = options.requireId ?? false;
    this.#advertiseIdle = options.advertiseIdle ?? true;
    this.#advertiseId = options.advertiseId ?? false;
    this.#rejectId = options.rejectId ?? false;
    this.#advertiseMove = options.advertiseMove ?? true;
    this.#advertiseUidPlus = options.advertiseUidPlus ?? true;
    this.#permanentFlags = options.permanentFlags ?? `${SYSTEM_FLAGS.join(' ')} \\*`;
    this.rejectLogin = options.rejectLogin ?? false;
    this.folders.set('INBOX', {
      path: 'INBOX',
      specialUse: null,
      uidValidity: 1,
      uidNext: 1,
      messages: [],
    });
  }

  get inbox(): FakeFolder {
    const folder = this.folders.get('INBOX');
    if (folder === undefined) throw new Error('fake imap lost INBOX');
    return folder;
  }

  get advertiseId(): boolean {
    return this.#advertiseId;
  }

  get rejectId(): boolean {
    return this.#rejectId;
  }

  get advertiseIdle(): boolean {
    return this.#advertiseIdle;
  }

  get advertiseMove(): boolean {
    return this.#advertiseMove;
  }

  get advertiseUidPlus(): boolean {
    return this.#advertiseUidPlus;
  }

  get permanentFlags(): string {
    return this.#permanentFlags;
  }

  async start(): Promise<void> {
    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fake imap has no port');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  /** 往 INBOX 播一封信（测试种子）。`seen` / `flags` 决定初始 flags。 */
  addMessage(raw: string, options: { seen?: boolean; flags?: string[] } = {}): number {
    const folder = this.inbox;
    const uid = folder.uidNext++;
    const flags = [...(options.flags ?? [])];
    if (options.seen === true && !flags.includes('\\Seen')) flags.push('\\Seen');
    folder.messages.push(makeMessage(uid, raw, flags));
    const exists = `* ${folder.messages.length} EXISTS\r\n`;
    for (const [socket, path] of this.#idling) {
      if (path === 'INBOX') socket.write(exists);
    }
    return uid;
  }

  /** 预建一个文件夹（测试种子）；已存在时返回现有文件夹。 */
  addFolder(path: string, options: { specialUse?: string } = {}): FakeFolder {
    const existing = this.folders.get(path);
    if (existing !== undefined) return existing;
    const folder: FakeFolder = {
      path,
      specialUse: options.specialUse ?? null,
      uidValidity: this.#uidValiditySeq++,
      uidNext: 1,
      messages: [],
    };
    this.folders.set(path, folder);
    return folder;
  }

  /**
   * 模拟「服务器重建了邮箱」：清空 INBOX 邮件、UID 从 1 重来、UIDVALIDITY 换成新值。
   * 已有连接不受影响，下一次 SELECT 起生效。
   */
  reset(newUidValidity: number): void {
    const inbox = this.inbox;
    inbox.messages.length = 0;
    inbox.uidNext = 1;
    inbox.uidValidity = newUidValidity;
  }

  /** 把所有活连接掐掉（服务器重启、网络中断）。 */
  dropConnections(): void {
    for (const socket of this.#sockets) socket.destroy();
  }

  /** 以 TCP RST 掐掉所有活连接：客户端 socket 会收到 ECONNRESET，库会 emit('error')。 */
  resetConnections(): void {
    for (const socket of this.#sockets) socket.resetAndDestroy();
  }

  #accept(socket: net.Socket): void {
    this.connections += 1;
    this.#sockets.add(socket);
    const session = new ImapSession(this, socket);
    socket.write('* OK KepCup fake IMAP ready\r\n');
    socket.on('data', (chunk) => session.consume(chunk));
    socket.on('close', () => {
      this.#sockets.delete(socket);
      this.#idling.delete(socket);
    });
  }

  get requireId(): boolean {
    return this.#requireId;
  }

  markIdling(socket: net.Socket, idling: boolean, path = 'INBOX'): void {
    if (idling) this.#idling.set(socket, path);
    else this.#idling.delete(socket);
  }
}

/** IMAP 关键字 / 旗标的合法性：可选的 `\` 前缀（系统旗标）+ 不含 atom-specials 的 atom。 */
const FLAG_ATOM = /^\\?[^\s(){%*"'\\]+$/;

class ImapSession {
  #sawId = false;
  #idleTag: string | null = null;
  /** 当前选中的文件夹；SELECT / EXAMINE 之前是 null。 */
  #selected: FakeFolder | null = null;
  #readOnly = false;
  #buf: Buffer = Buffer.alloc(0);
  /** APPEND 的 literal：还差多少字节、已收到的内容、挂起的命令头。 */
  #literalRemaining = 0;
  #literalContent: Buffer = Buffer.alloc(0);
  #pendingAppend: { tag: string; folder: FakeFolder; flags: string[] } | null = null;

  constructor(
    private readonly server: FakeImapServer,
    private readonly socket: net.Socket,
  ) {}

  consume(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#literalRemaining > 0) {
        if (this.#buf.length === 0) return;
        const take = Math.min(this.#literalRemaining, this.#buf.length);
        this.#literalContent = Buffer.concat([this.#literalContent, this.#buf.subarray(0, take)]);
        this.#buf = this.#buf.subarray(take);
        this.#literalRemaining -= take;
        if (this.#literalRemaining > 0) return;
        this.#finishAppend();
        continue;
      }
      const newline = this.#buf.indexOf('\r\n');
      if (newline < 0) return;
      const line = this.#buf.subarray(0, newline).toString('utf8');
      this.#buf = this.#buf.subarray(newline + 2);
      this.onLine(line);
    }
  }

  onLine(line: string): void {
    if (this.#idleTag !== null) {
      if (line.trim().toUpperCase() === 'DONE') {
        const tag = this.#idleTag;
        this.#idleTag = null;
        this.server.markIdling(this.socket, false);
        this.#write(`${tag} OK IDLE completed\r\n`);
      }
      return;
    }
    const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    if (match === null) return;
    const tag = match[1] ?? '';
    const command = (match[2] ?? '').toUpperCase();
    const rest = match[3] ?? '';
    switch (command) {
      case 'CAPABILITY': {
        const extra = [
          this.server.advertiseIdle ? ' IDLE' : '',
          this.server.advertiseId ? ' ID' : '',
          this.server.advertiseMove ? ' MOVE' : '',
          this.server.advertiseUidPlus ? ' UIDPLUS' : '',
          // RFC 6154：imapflow 只在广告了 SPECIAL-USE 时才采信 LIST 里的 \Sent 等旗标，
          // 否则只按本地名字表兜底（INBOX.Sent 这类前缀路径匹配不上 → specialUse=null）。
          ' SPECIAL-USE',
        ].join('');
        this.#write(`* CAPABILITY IMAP4rev1${extra} NAMESPACE\r\n${tag} OK CAPABILITY completed\r\n`);
        return;
      }
      case 'LOGIN':
      case 'AUTHENTICATE':
        this.server.loginAttempts += 1;
        if (this.server.rejectLogin !== false) {
          const text =
            typeof this.server.rejectLogin === 'string'
              ? this.server.rejectLogin
              : '[AUTHENTICATIONFAILED] Invalid credentials';
          this.#write(`${tag} NO ${text}\r\n`);
          return;
        }
        this.#write(`${tag} OK LOGIN completed\r\n`);
        return;
      case 'ID':
        this.server.idCommands += 1;
        if (this.server.rejectId) {
          this.#write(`${tag} BAD Command not recognized\r\n`);
          return;
        }
        this.#sawId = true;
        this.#write(`* ID NIL\r\n${tag} OK ID completed\r\n`);
        return;
      case 'STATUS': {
        const folder = this.#folderArg(rest);
        if (folder === null) {
          this.#write(`${tag} NO [NONEXISTENT] No such mailbox\r\n`);
          return;
        }
        const unseen = folder.messages.filter((message) => !message.flags.includes('\\Seen')).length;
        this.#write(
          `* STATUS ${quoted(folder.path)} (UNSEEN ${unseen})\r\n${tag} OK STATUS completed\r\n`,
        );
        return;
      }
      case 'NAMESPACE':
        this.#write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
        return;
      case 'LIST':
      case 'LSUB': {
        const lines = [...this.server.folders.values()].map((folder) => {
          const flags = ['\\HasNoChildren'];
          if (folder.specialUse !== null) flags.push(folder.specialUse);
          return `* ${command} (${flags.join(' ')}) "/" ${quoted(folder.path)}`;
        });
        this.#write(`${lines.join('\r\n')}\r\n${tag} OK ${command} completed\r\n`);
        return;
      }
      case 'SELECT':
      case 'EXAMINE': {
        if (this.server.requireId && !this.#sawId) {
          this.#write(`${tag} NO Unsafe Login\r\n`);
          return;
        }
        const folder = this.#folderArg(rest);
        if (folder === null) {
          this.#write(`${tag} NO [NONEXISTENT] No such mailbox\r\n`);
          return;
        }
        this.#selected = folder;
        this.#readOnly = command === 'EXAMINE';
        this.#write(this.#selectText(tag, folder, this.#readOnly));
        return;
      }
      case 'CLOSE': {
        if (this.#selected !== null && !this.#readOnly) this.#expunge(null);
        this.#selected = null;
        this.#write(`${tag} OK CLOSE completed\r\n`);
        return;
      }
      case 'EXPUNGE': {
        if (this.#selected === null) {
          this.#write(`${tag} NO No mailbox selected\r\n`);
          return;
        }
        if (this.#readOnly) {
          this.#write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
          return;
        }
        const removed = this.#expunge(null);
        this.#write(`${tag} OK EXPUNGE completed${removed > 0 ? ` (${removed} messages)` : ''}\r\n`);
        return;
      }
      case 'APPEND':
        this.#append(tag, rest);
        return;
      case 'CREATE': {
        const path = unquoteArg(rest);
        if (path === '' || this.server.folders.has(path)) {
          this.#write(
            `${tag} NO${path !== '' ? ' [ALREADYEXISTS]' : ''} ${path === '' ? 'Bad mailbox name' : 'Mailbox exists'}\r\n`,
          );
          return;
        }
        this.server.addFolder(path);
        this.#write(`${tag} OK CREATE completed\r\n`);
        return;
      }
      case 'RENAME': {
        const parts = rest.split(/\s+/).map(unquoteArg);
        const from = parts[0] ?? '';
        const to = (parts[1] ?? '').trim();
        const source = from !== '' ? this.server.folders.get(from) : undefined;
        if (source === undefined || to === '' || this.server.folders.has(to)) {
          this.#write(
            `${tag} NO ${source === undefined ? '[NONEXISTENT] No such mailbox' : to !== '' && this.server.folders.has(to) ? '[ALREADYEXISTS] Target exists' : 'Bad rename'}\r\n`,
          );
          return;
        }
        this.server.folders.delete(from);
        source.path = to;
        this.server.folders.set(to, source);
        if (this.#selected === source) this.#selected = null;
        this.#write(`${tag} OK RENAME completed\r\n`);
        return;
      }
      case 'DELETE': {
        const path = unquoteArg(rest);
        const folder = path !== '' ? this.server.folders.get(path) : undefined;
        if (path === '' || path.toUpperCase() === 'INBOX' || folder === undefined) {
          this.#write(
            `${tag} NO ${folder === undefined ? '[NONEXISTENT] No such mailbox' : '[CANNOT] INBOX cannot be deleted'}\r\n`,
          );
          return;
        }
        this.server.folders.delete(path);
        if (this.#selected === folder) this.#selected = null;
        this.#write(`${tag} OK DELETE completed\r\n`);
        return;
      }
      case 'UID':
        this.#uid(tag, rest);
        return;
      case 'IDLE':
        this.#idleTag = tag;
        this.server.markIdling(this.socket, true, this.#selected?.path ?? 'INBOX');
        this.#write('+ idling\r\n');
        return;
      case 'NOOP':
      case 'CHECK':
      case 'ENABLE':
      case 'COMPRESS':
        this.#write(`${tag} OK ${command} completed\r\n`);
        return;
      case 'LOGOUT':
        this.#write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        this.socket.end();
        return;
      default:
        this.#write(`${tag} OK ${command} completed\r\n`);
    }
  }

  #selectText(tag: string, folder: FakeFolder, readOnly: boolean): string {
    const count = folder.messages.length;
    const firstUnseen = folder.messages.findIndex((message) => !message.flags.includes('\\Seen'));
    return [
      `* ${count} EXISTS`,
      '* 0 RECENT',
      // 真实服务器的 [UNSEEN n] 是第一封未读的序号，不是数量。
      ...(firstUnseen >= 0 ? [`* OK [UNSEEN ${firstUnseen + 1}] First unseen`] : []),
      `* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`,
      `* OK [UIDNEXT ${folder.uidNext}] Predicted next UID`,
      `* FLAGS (${SYSTEM_FLAGS.join(' ')})`,
      readOnly
        ? '* OK [PERMANENTFLAGS ()] Read-only'
        : `* OK [PERMANENTFLAGS (${this.server.permanentFlags})] Flags permitted`,
      `${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] SELECT completed`,
      '',
    ].join('\r\n');
  }

  /** rest 的第一个参数（去引号）→ 文件夹；INBOX 大小写不敏感。 */
  #folderArg(rest: string): FakeFolder | null {
    const arg = unquoteArg(rest);
    if (arg.toUpperCase() === 'INBOX') return this.server.inbox;
    return this.server.folders.get(arg) ?? null;
  }

  #uid(tag: string, rest: string): void {
    const upper = rest.toUpperCase();
    if (upper.startsWith('SEARCH')) {
      this.#search(tag, rest);
      return;
    }
    if (upper.startsWith('FETCH')) {
      this.#fetch(tag, rest);
      return;
    }
    if (upper.startsWith('STORE')) {
      this.#store(tag, rest);
      return;
    }
    if (upper.startsWith('MOVE')) {
      this.#moveOrCopy(tag, rest, true);
      return;
    }
    if (upper.startsWith('COPY')) {
      this.#moveOrCopy(tag, rest, false);
      return;
    }
    if (upper.startsWith('EXPUNGE')) {
      this.#uidExpunge(tag, rest);
      return;
    }
    this.#write(`${tag} OK UID completed\r\n`);
  }

  #search(tag: string, rest: string): void {
    const selected = this.#selected;
    if (selected === null) {
      this.#write(`${tag} NO No mailbox selected\r\n`);
      return;
    }
    const keyword = /\bKEYWORD\s+(\S+)/i.exec(rest)?.[1];
    let messages = selected.messages.filter((message) => {
      if (/\bUNSEEN\b/i.test(rest) && message.flags.includes('\\Seen')) return false;
      if (keyword !== undefined) {
        const hit = message.flags.some((flag) => flag.toLowerCase() === keyword.toLowerCase());
        if (!hit) return false;
      }
      return true;
    });
    let uids = messages.map((message) => message.uid);
    const uidRange = /\bUID\s+(\d+)\s*:\s*(\*|\d+)/i.exec(rest);
    if (uidRange !== null) {
      const start = Number(uidRange[1]);
      const end = uidRange[2] === '*' ? Number.POSITIVE_INFINITY : Number(uidRange[2]);
      uids = uids.filter((uid) => uid >= start && uid <= end);
    }
    this.server.lastSearchCommand = rest;
    this.server.lastSearchReturned = uids.length;
    const reply = `* SEARCH${uids.map((uid) => ` ${uid}`).join('')}\r\n${tag} OK SEARCH completed\r\n`;
    if (this.server.searchDelayMs > 0) setTimeout(() => this.#write(reply), this.server.searchDelayMs);
    else this.#write(reply);
  }

  #fetch(tag: string, rest: string): void {
    const selected = this.#selected;
    if (selected === null) {
      this.#write(`${tag} NO No mailbox selected\r\n`);
      return;
    }
    const wanted = this.#wantedUids(rest);
    const lines: string[] = [];
    selected.messages.forEach((message, index) => {
      if (!wanted.has(message.uid)) return;
      const bytes = Buffer.byteLength(message.raw);
      const parts = [`UID ${message.uid}`, `FLAGS (${message.flags.join(' ')})`];
      if (/\bENVELOPE\b/i.test(rest)) parts.push(`ENVELOPE ${envelopeOf(message.raw)}`);
      if (/\bINTERNALDATE\b/i.test(rest)) parts.push('INTERNALDATE "12-Oct-2026 01:00:00 +0000"');
      // 点名 BODY 的请求才回正文；信封 / flags 级请求和真实服务器一样不带 BODY[]。
      if (/\bBODY(?:\.PEEK)?\[/i.test(rest)) {
        lines.push(`* ${index + 1} FETCH (${parts.join(' ')} BODY[] {${bytes}}\r\n${message.raw})`);
      } else {
        lines.push(`* ${index + 1} FETCH (${parts.join(' ')})`);
      }
    });
    lines.push(`${tag} OK FETCH completed`);
    this.#write(`${lines.join('\r\n')}\r\n`);
  }

  #store(tag: string, rest: string): void {
    const selected = this.#selected;
    if (selected === null) {
      this.#write(`${tag} NO No mailbox selected\r\n`);
      return;
    }
    if (this.#readOnly) {
      this.#write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
      return;
    }
    // rest = `STORE <set> <op> [(flags)]`——首 token 是命令名，UID 已被上层摘掉。
    const match = /^STORE\s+(\S+)\s+([+-]?FLAGS)(?:\.SILENT)?\s*(?:\(([^)]*)\)|(\S+))?\s*$/i.exec(rest);
    if (match === null) {
      this.#write(`${tag} BAD STORE syntax\r\n`);
      return;
    }
    const wanted = this.#wantedUids(`STORE ${match[1] ?? ''}`);
    const op = (match[2] ?? '').toUpperCase().replace('.SILENT', '');
    const silent = /\.SILENT/i.test(rest);
    const incoming = parseFlagList(match[3] ?? match[4] ?? '');
    const affected: Array<{ message: FakeMessage; index: number }> = [];
    selected.messages.forEach((message, index) => {
      if (!wanted.has(message.uid)) return;
      if (op === '+FLAGS') {
        for (const flag of incoming) if (!message.flags.includes(flag)) message.flags.push(flag);
      } else if (op === '-FLAGS') {
        message.flags = message.flags.filter((flag) => !incoming.includes(flag));
      } else {
        message.flags = [...incoming];
      }
      affected.push({ message, index });
    });
    // 非 SILENT 的 STORE，真实服务器会对受影响邮件回未缀 FETCH FLAGS。
    if (!silent) {
      for (const { message, index } of affected) {
        this.#write(`* ${index + 1} FETCH (UID ${message.uid} FLAGS (${message.flags.join(' ')}))\r\n`);
      }
    }
    this.#write(`${tag} OK STORE completed\r\n`);
  }

  #moveOrCopy(tag: string, rest: string, move: boolean): void {
    const selected = this.#selected;
    if (selected === null) {
      this.#write(`${tag} NO No mailbox selected\r\n`);
      return;
    }
    // rest = `<cmd> <set> <folder>`——首 token 是命令名，UID 已被上层摘掉。
    const match = /^\S+\s+(\S+)\s+(?:"([^"]+)"|(\S+))\s*$/.exec(rest);
    const set = match?.[1] ?? '';
    const targetPath = (match?.[2] ?? match?.[3] ?? '').trim();
    const target = targetPath.toUpperCase() === 'INBOX' ? this.server.inbox : this.server.folders.get(targetPath);
    if (target === undefined || targetPath === '') {
      this.#write(`${tag} NO [TRYCREATE] No such mailbox\r\n`);
      return;
    }
    if (move && this.#readOnly) {
      this.#write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
      return;
    }
    const wanted = this.#wantedUids(`${move ? 'MOVE' : 'COPY'} ${set}`);
    if (wanted.size === 0) {
      this.#write(`${tag} OK ${move ? 'MOVE' : 'COPY'} completed\r\n`);
      return;
    }
    const sourceUids: number[] = [];
    const destUids: number[] = [];
    for (const message of [...selected.messages]) {
      if (!wanted.has(message.uid)) continue;
      const uid = target.uidNext++;
      target.messages.push(makeMessage(uid, message.raw, message.flags));
      destUids.push(uid);
      sourceUids.push(message.uid);
    }
    if (move) {
      // 移走的消息不带 \Deleted，必须按 uid 直接摘（EXPUNGE 只摘 \Deleted）。
      const removed = this.#removeMessages((message) => wanted.has(message.uid));
      if (removed !== sourceUids.length) {
        // 理论到不了：wanted 来自同一份列表。防御一下，别静默吞差异。
        this.#write(`${tag} NO [SERVERBUG] Move mismatch\r\n`);
        return;
      }
    }
    const copyUid =
      this.server.advertiseUidPlus && sourceUids.length > 0
        ? ` [COPYUID ${target.uidValidity} ${sourceUids.join(',')} ${destUids.join(',')}]`
        : '';
    this.#write(`${tag} OK${copyUid} ${move ? 'MOVE' : 'COPY'} completed\r\n`);
  }

  #uidExpunge(tag: string, rest: string): void {
    const selected = this.#selected;
    if (selected === null) {
      this.#write(`${tag} NO No mailbox selected\r\n`);
      return;
    }
    if (this.#readOnly) {
      this.#write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
      return;
    }
    const wanted = this.#wantedUids(rest);
    const removed = this.#expunge((uid) => wanted.has(uid));
    this.#write(`${tag} OK UID EXPUNGE completed${removed > 0 ? ` (${removed} messages)` : ''}\r\n`);
  }

  /**
   * 按谓词摘走邮件并按降序吐 `* n EXPUNGE`（降序保证先发的序号不被后面的删除移位）。
   * EXPUNGE 命令只摘 \Deleted；MOVE / UID EXPUNGE 直接传谓词。
   */
  #removeMessages(predicate: (message: FakeMessage) => boolean): number {
    const selected = this.#selected;
    if (selected === null) return 0;
    const doomed: number[] = [];
    selected.messages.forEach((message, index) => {
      if (!predicate(message)) return;
      doomed.push(index);
    });
    for (let i = doomed.length - 1; i >= 0; i -= 1) {
      const index = doomed[i];
      if (index === undefined) continue;
      selected.messages.splice(index, 1);
      this.#write(`* ${index + 1} EXPUNGE\r\n`);
    }
    return doomed.length;
  }

  #expunge(only: ((uid: number) => boolean) | null): number {
    return this.#removeMessages((message) => {
      if (!message.flags.includes('\\Deleted')) return false;
      return only === null || only(message.uid);
    });
  }

  #append(tag: string, rest: string): void {
    if (this.server.requireId && !this.#sawId) {
      this.#write(`${tag} NO Unsafe Login\r\n`);
      return;
    }
    const match =
      /^(?:"([^"]+)"|(\S+))(?:\s+\(([^)]*)\))?(?:\s+"[^"]*")?\s*\{(\d+)\}\s*$/.exec(rest);
    if (match === null) {
      this.#write(`${tag} BAD APPEND requires a literal\r\n`);
      return;
    }
    const path = (match[1] ?? match[2] ?? '').trim();
    const folder = path.toUpperCase() === 'INBOX' ? this.server.inbox : this.server.folders.get(path);
    if (folder === undefined || path === '') {
      this.#write(`${tag} NO [NONEXISTENT] No such mailbox\r\n`);
      return;
    }
    const size = Number(match[4]);
    if (!Number.isInteger(size) || size < 0) {
      this.#write(`${tag} BAD APPEND literal size\r\n`);
      return;
    }
    this.#pendingAppend = { tag, folder, flags: parseFlagList(match[3] ?? '') };
    this.#literalRemaining = size;
    this.#literalContent = Buffer.alloc(0);
    this.#write('+ Ready for literal\r\n');
  }

  #finishAppend(): void {
    const pending = this.#pendingAppend;
    this.#pendingAppend = null;
    if (pending === null) return;
    const uid = pending.folder.uidNext++;
    pending.folder.messages.push(makeMessage(uid, this.#literalContent.toString('utf8'), pending.flags));
    this.#literalContent = Buffer.alloc(0);
    const copyUid = this.server.advertiseUidPlus ? ` [APPENDUID ${pending.folder.uidValidity} ${uid}]` : '';
    this.#write(`${pending.tag} OK${copyUid} APPEND completed\r\n`);
  }

  /** `FETCH <set>` / `STORE <set>` / `EXPUNGE <set>` 里的 UID 集合；解析不了回空集（宁可不动，不许全量误伤）。 */
  #wantedUids(rest: string): Set<number> {
    const match = /(?:FETCH|STORE|EXPUNGE|MOVE|COPY)\s+([0-9:,]+)/i.exec(rest);
    const out = new Set<number>();
    if (match === null) return out;
    const spec = match[1] ?? '';
    if (spec.includes(':') || spec.includes(',')) {
      for (const part of spec.split(',')) {
        if (part.includes(':')) {
          const [startText, endText] = part.split(':');
          const start = Number(startText);
          const end = endText === '*' ? Number.POSITIVE_INFINITY : Number(endText);
          for (const message of (this.#selected ?? this.server.inbox).messages) {
            if (message.uid >= start && message.uid <= end) out.add(message.uid);
          }
        } else {
          const uid = Number(part);
          if (Number.isInteger(uid)) out.add(uid);
        }
      }
      return out;
    }
    const uid = Number(spec);
    if (Number.isInteger(uid)) out.add(uid);
    return out;
  }

  #write(text: string): void {
    this.socket.write(text);
  }
}

function parseFlagList(text: string): string[] {
  return text
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((flag) => flag.trim())
    .filter((flag) => flag !== '' && FLAG_ATOM.test(flag));
}

function unquoteArg(rest: string): string {
  const first = rest.trim();
  if (first.startsWith('"')) {
    const end = first.indexOf('"', 1);
    return end > 0 ? first.slice(1, end) : first.slice(1);
  }
  return first.split(/\s+/)[0] ?? '';
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function headerOf(raw: string, name: string): string {
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(raw);
  return match?.[1]?.trim() ?? '';
}

function addressList(value: string): string {
  const match = /^(?:"?([^"<]*?)"?\s*)?<([^@>]+)@([^>]+)>$/.exec(value.trim());
  if (match === null) return 'NIL';
  const name = (match[1] ?? '').trim();
  return `((${name === '' ? 'NIL' : quoted(name)} NIL ${quoted(match[2] ?? '')} ${quoted(match[3] ?? '')}))`;
}

/** 从原始头拼一个 IMAP ENVELOPE；Date 原样给出（含不可解析的），和真实服务器一致。 */
function envelopeOf(raw: string): string {
  const from = addressList(headerOf(raw, 'From'));
  const to = addressList(headerOf(raw, 'To'));
  const date = headerOf(raw, 'Date');
  return `(${date === '' ? 'NIL' : quoted(date)} ${quoted(headerOf(raw, 'Subject'))} ${from} ${from} ${from} ${to} NIL NIL NIL ${quoted(headerOf(raw, 'Message-ID'))})`;
}

export function sampleMessage(subject: string, body: string, options: { date?: string; from?: string } = {}): string {
  return [
    `From: ${options.from ?? 'Alice <alice@example.com>'}`,
    'To: Bob <bob@example.com>',
    `Subject: ${subject}`,
    `Date: ${options.date ?? 'Mon, 12 Oct 2026 01:00:00 +0000'}`,
    'Message-ID: <m@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

/** 收一封信的明文 SMTP，给审批通过后的 mail_send 用。 */
export class FakeSmtpServer {
  port = 0;
  readonly messages: string[] = [];
  /** 字符串：AUTH 回 535 并带上这段文字（可以故意塞进密码，检验脱敏）。true 用默认文字。 */
  rejectAuth: boolean | string = false;
  /** 字符串：DATA 结束时回 554 并带上这段文字。 */
  rejectData: string | null = null;
  #server: net.Server | null = null;

  async start(): Promise<void> {
    const server = net.createServer((socket) => {
      let buffer = '';
      let data = false;
      let raw = '';
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\r\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          if (data) {
            if (line === '.') {
              data = false;
              if (this.rejectData !== null) {
                raw = '';
                socket.write(`554 5.7.1 ${this.rejectData}\r\n`);
              } else {
                this.messages.push(raw);
                raw = '';
                socket.write('250 OK\r\n');
              }
            } else {
              raw += `${line}\r\n`;
            }
          } else {
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
              socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
            } else if (upper.startsWith('AUTH') && this.rejectAuth !== false) {
              const text = typeof this.rejectAuth === 'string' ? this.rejectAuth : 'Authentication failed';
              socket.write(`535 5.7.8 ${text}\r\n`);
            } else if (upper.startsWith('DATA')) {
              data = true;
              socket.write('354 Go ahead\r\n');
            } else if (upper.startsWith('QUIT')) {
              socket.write('221 Bye\r\n');
              socket.end();
            } else {
              socket.write('250 OK\r\n');
            }
          }
          newline = buffer.indexOf('\r\n');
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fake smtp has no port');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
