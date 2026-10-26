import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, MCP_SERVER_ID_PATTERN } from '@kepcup/shared';
import {
  assertInstallablePluginId,
  pluginDirName,
  pluginDirOf,
  pluginServerId,
} from '../../src/plugins/ids.js';

/**
 * 插件身份（D104 P0a-1 步骤 5）：目录名小写化、安装目录守卫、稳定 server id、
 * 保留命名空间拒绝（内置加载器不经过这道闸）。
 */

describe('pluginDirName / pluginDirOf', () => {
  it('lower-cases id and version into one directory name', () => {
    expect(pluginDirName('io.github.Alice/Doc-Tools', '1.2.0')).toBe(
      'io.github.alice/doc-tools@1.2.0',
    );
  });

  it('resolves to {pluginsDir}/{ns}/{name}@{version} and maps case-variant ids to the same dir', () => {
    const dir = pluginDirOf('/home/.kepcup/plugins', 'io.github.alice/doc-tools', '1.2.0');
    expect(dir).toBe(
      path.join('/home/.kepcup/plugins', 'io.github.alice', 'doc-tools@1.2.0'),
    );
    expect(pluginDirOf('/home/.kepcup/plugins', 'IO.GITHUB.ALICE/DOC-TOOLS', '1.2.0')).toBe(dir);
  });

  it('rejects path-escaping ids and versions even if the schema missed them', () => {
    for (const [id, version] of [
      ['..', '1.0.0'],
      ['a', '../../b'],
      ['a', '..\\x'],
      ['no-slash', '1.0.0'],
      ['io.github.alice/doc-tools', 'not-a-version'],
    ] as const) {
      expect(() => pluginDirOf('/home/.kepcup/plugins', id, version)).toThrow(/越界/);
    }
  });

  it('throws PLUGIN_INVALID AppError', () => {
    try {
      pluginDirOf('/home/.kepcup/plugins', '..', '1.0.0');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PLUGIN_INVALID');
    }
  });
});

describe('pluginServerId', () => {
  it('is deterministic, key-sensitive and always matches MCP_SERVER_ID_PATTERN', () => {
    const first = pluginServerId('io.github.alice/doc-tools', 'dbtools');
    expect(first).toBe(pluginServerId('io.github.alice/doc-tools', 'dbtools'));
    expect(pluginServerId('io.github.alice/doc-tools', 'docs')).not.toBe(first);
    expect(pluginServerId('io.github.alice/other', 'dbtools')).not.toBe(first);
    expect(first).toMatch(/^plg_[0-9a-f]{12}$/);
    expect(MCP_SERVER_ID_PATTERN.test(first)).toBe(true);
    for (const key of ['a', 'x'.repeat(31), '0']) {
      expect(MCP_SERVER_ID_PATTERN.test(pluginServerId('io.github.a/b', key))).toBe(true);
    }
  });
});

describe('assertInstallablePluginId', () => {
  it('rejects the reserved namespaces, including case variants', () => {
    for (const id of ['com.kepcup/x', 'local.kepcup/x', 'COM.KEPCUP/X', 'Com.KepCup/starter']) {
      expect(() => assertInstallablePluginId(id)).toThrow(/为 KepCup 保留/);
    }
    expect(() => assertInstallablePluginId('io.github.alice/doc-tools')).not.toThrow();
    expect(() => assertInstallablePluginId('com.kepcuppers/x')).not.toThrow();
  });

  it('throws PLUGIN_INVALID', async () => {
    try {
      assertInstallablePluginId('com.kepcup/x');
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe('PLUGIN_INVALID');
    }
  });
});
