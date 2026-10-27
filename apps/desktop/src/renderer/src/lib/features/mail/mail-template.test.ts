import { describe, expect, it } from 'vitest';
import type { MailProviderTemplate } from '@kepcup/shared';
import { applyTemplate, parseTemplateOption, templateOptionValue } from './mail-template';

/**
 * 邮件预填模板的纯函数（D104 P1-3）：`tpl:` 前缀把插件模板与内置厂商区分开，
 * 模板只负责把表单字段填好——创建请求仍是 `provider: 'custom'`。
 */

const template: MailProviderTemplate = {
  id: 'io.github.tester/fixture#corp',
  pluginId: 'io.github.tester/fixture',
  pluginName: 'Fixture',
  label: 'Corp Mail',
  imap: { host: 'imap.corp.example', port: 993, secure: 'ssl' },
  smtp: { host: 'smtp.corp.example', port: 465, secure: 'ssl' },
  defaultMode: 'poll_only',
  defaultPollSec: 600,
  minPollSec: 120,
  helpUrl: 'https://corp.example/help',
};

describe('mail template options', () => {
  it('round-trips template ids', () => {
    expect(parseTemplateOption(templateOptionValue(template.id))).toBe(template.id);
  });

  it('returns null for built-in provider values', () => {
    for (const value of ['qq', 'gmail', 'outlook', 'custom']) {
      expect(parseTemplateOption(value)).toBeNull();
    }
  });

  it('applyTemplate fills the form as a custom mailbox', () => {
    expect(applyTemplate(template)).toEqual({
      provider: 'custom',
      imapHost: 'imap.corp.example',
      imapPort: '993',
      smtpHost: 'smtp.corp.example',
      smtpPort: '465',
      imapSecure: 'ssl',
      smtpSecure: 'ssl',
      mode: 'poll_only',
      pollIntervalSec: '600',
    });
  });
});
