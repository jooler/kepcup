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
