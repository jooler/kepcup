import type { MailProviderTemplate, MailSecure } from '@kepcup/shared';

/**
 * 邮件预填模板（D104 P1-3，设计 51 §4「mail」行）：插件贡献的模板只是「添加邮箱」表单的
 * 预填 overlay，创建出的账号仍是 `provider: 'custom'`——全局的轮询下限、审批与发信规则
 * 一概不变。模板选项的 value 带 `tpl:` 前缀，避免和内置厂商枚举混在同一个 `<select>` 里。
 */

const TEMPLATE_PREFIX = 'tpl:';

export function templateOptionValue(id: string): string {
  return `${TEMPLATE_PREFIX}${id}`;
}

/** `tpl:<id>` → `<id>`；普通厂商值返回 null。 */
export function parseTemplateOption(value: string): string | null {
  return value.startsWith(TEMPLATE_PREFIX) ? value.slice(TEMPLATE_PREFIX.length) : null;
}

/** 表单的字段形状（端口与轮询间隔在表单里是字符串，这里一并转换）。 */
export interface MailTemplateForm {
  provider: 'custom';
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  imapSecure: MailSecure;
  smtpSecure: MailSecure;
  mode: MailProviderTemplate['defaultMode'];
  pollIntervalSec: string;
}

export function applyTemplate(template: MailProviderTemplate): MailTemplateForm {
  return {
    provider: 'custom',
    imapHost: template.imap.host,
    imapPort: String(template.imap.port),
    smtpHost: template.smtp.host,
    smtpPort: String(template.smtp.port),
    imapSecure: template.imap.secure,
    smtpSecure: template.smtp.secure,
    mode: template.defaultMode,
    pollIntervalSec: String(template.defaultPollSec),
  };
}
