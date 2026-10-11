import net from 'node:net';

/**
 * 只够 imapflow 走完登录、ID、SELECT、UID 搜索 / 收取和 IDLE 的假服务器。
 * `requireId` 时，SELECT / EXAMINE 之前没发过 ID 就回 Unsafe Login（163 的行为）。
 */

export interface FakeImapOptions {
  requireId?: boolean;
  advertiseIdle?: boolean;
}

export class FakeImapServer {
  port = 0;
  readonly messages: Array<{ uid: number; raw: string }> = [];
  /** 最近一次 UID SEARCH 返回了多少个 UID（测试用，确认窗口生效）。 */
  lastSearchReturned = 0;
  /** 最近一次 UID SEARCH 的参数原文。 */
  lastSearchCommand = '';
  #uidNext = 1;
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();
  #idling = new Set<net.Socket>();
  readonly #requireId: boolean;
  readonly #advertiseIdle: boolean;

  constructor(options: FakeImapOptions = {}) {
    this.#requireId = options.requireId ?? false;
    this.#advertiseIdle = options.advertiseIdle ?? true;
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

  addMessage(raw: string): number {
    const uid = this.#uidNext++;
    this.messages.push({ uid, raw });
    const exists = `* ${this.messages.length} EXISTS\r\n`;
    for (const socket of this.#idling) socket.write(exists);
    return uid;
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket);
    const session = new ImapSession(this, socket);
    socket.write('* OK KepCup fake IMAP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\r\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        session.onLine(line);
        newline = buffer.indexOf('\r\n');
      }
    });
    socket.on('close', () => {
      this.#sockets.delete(socket);
      this.#idling.delete(socket);
    });
  }

  get requireId(): boolean {
    return this.#requireId;
  }

  get advertiseIdle(): boolean {
    return this.#advertiseIdle;
  }

  markIdling(socket: net.Socket, idling: boolean): void {
    if (idling) this.#idling.add(socket);
    else this.#idling.delete(socket);
  }
}

class ImapSession {
  #sawId = false;
  #idleTag: string | null = null;

  constructor(
    private readonly server: FakeImapServer,
    private readonly socket: net.Socket,
  ) {}

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
      case 'CAPABILITY':
        this.#write(
          `* CAPABILITY IMAP4rev1${this.server.advertiseIdle ? ' IDLE' : ''} NAMESPACE\r\n${tag} OK CAPABILITY completed\r\n`,
        );
        return;
      case 'LOGIN':
      case 'AUTHENTICATE':
        this.#write(`${tag} OK LOGIN completed\r\n`);
        return;
      case 'ID':
        this.#sawId = true;
        this.#write(`* ID NIL\r\n${tag} OK ID completed\r\n`);
        return;
      case 'NAMESPACE':
        this.#write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
        return;
      case 'LIST':
      case 'LSUB':
        this.#write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK LIST completed\r\n`);
        return;
      case 'SELECT':
      case 'EXAMINE':
        if (this.server.requireId && !this.#sawId) {
          this.#write(`${tag} NO Unsafe Login\r\n`);
          return;
        }
        this.#write(this.#selectText(tag));
        return;
      case 'UID':
        this.#uid(tag, rest);
        return;
      case 'IDLE':
        this.#idleTag = tag;
        this.server.markIdling(this.socket, true);
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

  #selectText(tag: string): string {
    const count = this.server.messages.length;
    return [
      `* ${count} EXISTS`,
      '* 0 RECENT',
      '* OK [UIDVALIDITY 1] UIDs valid',
      `* OK [UIDNEXT ${this.#uidNext()}] Predicted next UID`,
      '* FLAGS (\\Seen)',
      '* OK [PERMANENTFLAGS ()] Read-only',
      `${tag} OK [READ-ONLY] SELECT completed`,
      '',
    ].join('\r\n');
  }

  #uidNext(): number {
    const last = this.server.messages.at(-1);
    return last === undefined ? 1 : last.uid + 1;
  }

  #uid(tag: string, rest: string): void {
    const upper = rest.toUpperCase();
    if (upper.startsWith('SEARCH')) {
      let uids = this.server.messages.map((message) => message.uid);
      const uidRange = /\bUID\s+(\d+)\s*:\s*(\*|\d+)/i.exec(rest);
      if (uidRange !== null) {
        const start = Number(uidRange[1]);
        const end = uidRange[2] === '*' ? Number.POSITIVE_INFINITY : Number(uidRange[2]);
        uids = uids.filter((uid) => uid >= start && uid <= end);
      }
      this.server.lastSearchCommand = rest;
      this.server.lastSearchReturned = uids.length;
      this.#write(`* SEARCH${uids.map((uid) => ` ${uid}`).join('')}\r\n${tag} OK SEARCH completed\r\n`);
      return;
    }
    if (upper.startsWith('FETCH')) {
      const wanted = this.#wantedUids(rest);
      const lines: string[] = [];
      this.server.messages.forEach((message, index) => {
        if (wanted !== null && !wanted.has(message.uid)) return;
        const bytes = Buffer.byteLength(message.raw);
        lines.push(`* ${index + 1} FETCH (UID ${message.uid} BODY[] {${bytes}}\r\n${message.raw})`);
      });
      lines.push(`${tag} OK FETCH completed`);
      this.#write(`${lines.join('\r\n')}\r\n`);
      return;
    }
    this.#write(`${tag} OK UID completed\r\n`);
  }

  #wantedUids(rest: string): Set<number> | null {
    const match = /FETCH\s+([0-9:,]+)/i.exec(rest);
    if (match === null) return null;
    const spec = match[1] ?? '';
    if (spec.includes(':') || spec.includes(',')) {
      const out = new Set<number>();
      for (const part of spec.split(',')) {
        if (part.includes(':')) {
          const [startText, endText] = part.split(':');
          const start = Number(startText);
          const end = endText === '*' ? Number.POSITIVE_INFINITY : Number(endText);
          for (const message of this.server.messages) {
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
    return Number.isInteger(uid) ? new Set([uid]) : null;
  }

  #write(text: string): void {
    this.socket.write(text);
  }
}

export function sampleMessage(subject: string, body: string): string {
  return [
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    `Subject: ${subject}`,
    'Date: Mon, 12 Oct 2026 01:00:00 +0000',
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
              this.messages.push(raw);
              raw = '';
              socket.write('250 OK\r\n');
            } else {
              raw += `${line}\r\n`;
            }
          } else {
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
              socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
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
