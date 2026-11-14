import nodemailer from 'nodemailer';
import type { MailSecure } from '@kepcup/shared';
import { isMailLoopbackHost, mailPrivateHostsAllowed, resolveMailHost } from './hosts.js';

export interface SmtpSendInput {
  host: string;
  port: number;
  secure: MailSecure;
  username: string;
  password: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
}

/** 测连：登录成功即可，不发信。 */
export async function verifySmtp(
  input: Omit<SmtpSendInput, 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'text'>,
): Promise<void> {
  const transport = await createTransport(input);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendSmtp(input: SmtpSendInput): Promise<void> {
  const transport = await createTransport(input);
  try {
    await transport.sendMail({
      from: input.from,
      to: input.to,
      cc: input.cc.length > 0 ? input.cc : undefined,
      bcc: input.bcc.length > 0 ? input.bcc : undefined,
      subject: input.subject,
      text: input.text,
    });
  } finally {
    transport.close();
  }
}

export interface DraftSourceInput {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
}

/**
 * 离线构建一封 RFC822 原文（存草稿 APPEND 用），不经任何网络。
 * nodemailer 的 streamTransport + buffer 只做 MIME 组装：Date / Message-ID / UTF-8 编码
 * 与真实发信完全同源，回读（parseMailSource）能得到一样的信封。
 * newline 必须是 '\r\n'：nodemailer 只认 'win'/'windows'/'dos'/'\r\n'，写 'crlf' 会被
 * 当成 unix 换行归一，把头部 CRLF 也改写成裸 LF（RFC 822/9051 要求 CRLF）。
 */
export async function buildDraftSource(input: DraftSourceInput): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: '\r\n' });
  try {
    const info = await transport.sendMail({
      from: input.from,
      to: input.to,
      cc: input.cc.length > 0 ? input.cc : undefined,
      bcc: input.bcc.length > 0 ? input.bcc : undefined,
      subject: input.subject,
      text: input.text,
    });
    const message = (info as { message?: Buffer | string }).message;
    if (Buffer.isBuffer(message)) return message;
    if (typeof message === 'string') return Buffer.from(message, 'utf8');
    throw new Error('草稿内容组装失败');
  } finally {
    transport.close();
  }
}

async function createTransport(input: {
  host: string;
  port: number;
  secure: MailSecure;
  username: string;
  password: string;
}): Promise<ReturnType<typeof nodemailer.createTransport>> {
  const resolved = await resolveMailHost(input.host);
  const testPlain = mailPrivateHostsAllowed() && isMailLoopbackHost(input.host);
  return nodemailer.createTransport({
    host: resolved.dialHost,
    port: input.port,
    secure: input.secure === 'ssl' && !testPlain,
    auth: { user: input.username, pass: input.password },
    tls: { rejectUnauthorized: !testPlain },
    ...(resolved.servername !== null ? { servername: resolved.servername } : {}),
    ...(testPlain ? { ignoreTLS: true } : {}),
    // starttls：要求升级，不允许悄悄落明文。
    ...(input.secure === 'starttls' && !testPlain ? { requireTLS: true } : {}),
  });
}
