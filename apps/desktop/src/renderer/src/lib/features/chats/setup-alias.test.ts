import { describe, expect, it } from 'vitest';
import type { MessageKey } from '$lib/i18n';
import type { SetupRequirement } from '@kepcup/shared';
import { setupAliasOf } from './setup-alias';

/** 与 i18n 无关的假文案：直接回 key，断言里认 key。 */
const text = (key: MessageKey): string => key;

describe('setupAliasOf（旧 kind → kind:"setting" 兼容别名）', () => {
  it('capability-model 映到对应的 capability.{能力} 条目', () => {
    expect(setupAliasOf({ kind: 'capability-model', capability: 'asr' }, text)).toEqual({
      kind: 'setting',
      itemId: 'capability.asr',
      reason: 'setupCard.capabilityHint',
    });
    expect(setupAliasOf({ kind: 'capability-model', capability: 'image' }, text)).toEqual({
      kind: 'setting',
      itemId: 'capability.image',
      reason: 'setupCard.capabilityHint',
    });
  });

  it('web-search 映到 search.provider', () => {
    expect(setupAliasOf({ kind: 'web-search' }, text)).toEqual({
      kind: 'setting',
      itemId: 'search.provider',
      reason: 'setupCard.webSearchHint',
    });
  });

  it('mail-account 的 provider 映到 prefill.provider，reason 原样保留', () => {
    expect(
      setupAliasOf({ kind: 'mail-account', provider: 'gmail', reason: '帮我收邮件' }, text),
    ).toEqual({
      kind: 'setting',
      itemId: 'mail.account',
      prefill: { provider: 'gmail' },
      reason: '帮我收邮件',
    });
  });

  it('mail-account 没有 provider / reason 时回退缺省', () => {
    expect(setupAliasOf({ kind: 'mail-account' }, text)).toEqual({
      kind: 'setting',
      itemId: 'mail.account',
      reason: 'setupCard.mailAccountHint',
    });
    expect(setupAliasOf({ kind: 'mail-account', reason: '  ' }, text)).toEqual({
      kind: 'setting',
      itemId: 'mail.account',
      reason: 'setupCard.mailAccountHint',
    });
  });

  it('其余 kind（字段更多或行为特殊）不映射，交回原分支渲染', () => {
    const others: SetupRequirement[] = [
      { kind: 'main-model' },
      { kind: 'agent', agentId: 'claude', reason: 'not_installed' },
      {
        kind: 'connect-app',
        target: { kind: 'custom', serverId: 'srv' },
        reason: 'not_connected',
      },
      { kind: 'setting', itemId: 'models.provider', reason: 'r' },
    ];
    for (const requirement of others) {
      expect(setupAliasOf(requirement, text)).toBeNull();
    }
  });
});
