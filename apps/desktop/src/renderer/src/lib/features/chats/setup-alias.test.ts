import { describe, expect, it } from 'vitest';
import type { MessageKey } from '$lib/i18n';
import type { SetupRequirement } from '@kepcup/shared';
import { isPluginCredentialEntryPath, setupAliasOf } from './setup-alias';

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

  it('mail-account 映到目录条目，reason 原样保留（P3：无厂商预填）', () => {
    expect(setupAliasOf({ kind: 'mail-account', reason: '帮我收邮件' }, text)).toEqual({
      kind: 'setting',
      itemId: 'mail.account',
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
    ];
    for (const requirement of others) {
      expect(setupAliasOf(requirement, text)).toBeNull();
    }
  });

  it('已是通用 setting kind 的直通', () => {
    const requirement: SetupRequirement = {
      kind: 'setting',
      itemId: 'models.provider',
      reason: 'r',
    };
    expect(setupAliasOf(requirement, text)).toBe(requirement);
  });
});

describe('isPluginCredentialEntryPath（D124 条目路径缺凭据的凭据卡分发）', () => {
  const entryRequirement = (patch: Partial<Extract<SetupRequirement, { kind: 'capability-model' }>> = {}): SetupRequirement => ({
    kind: 'capability-model',
    capability: 'image',
    pluginId: 'p/one',
    entryId: 'e1',
    ...patch,
  });

  it('payload 带插件定位且插件在已装清单：走插件凭据卡', () => {
    expect(isPluginCredentialEntryPath(entryRequirement(), true, () => true)).toBe(true);
  });

  it('清单尚未拉到（冷启动直出卡）：也按条目路径渲染——落全局槽位卡会误导且解不了实例凭据', () => {
    expect(isPluginCredentialEntryPath(entryRequirement(), false, () => false)).toBe(true);
  });

  it('清单拉到后插件已卸载：回落全局槽位卡', () => {
    expect(isPluginCredentialEntryPath(entryRequirement(), true, () => false)).toBe(false);
  });

  it('payload 无插件定位（全局槽位路径，D124 前唯一形态）：不走凭据卡', () => {
    expect(
      isPluginCredentialEntryPath(entryRequirement({ pluginId: undefined }), true, () => true),
    ).toBe(false);
    expect(
      isPluginCredentialEntryPath(entryRequirement({ pluginId: undefined }), false, () => false),
    ).toBe(false);
  });

  it('其余 kind 一律不走凭据卡', () => {
    const others: SetupRequirement[] = [
      { kind: 'main-model' },
      { kind: 'web-search' },
      { kind: 'setting', itemId: 'models.provider', reason: 'r' },
    ];
    for (const requirement of others) {
      expect(isPluginCredentialEntryPath(requirement, true, () => true)).toBe(false);
    }
  });
});
