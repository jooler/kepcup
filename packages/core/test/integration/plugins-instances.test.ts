import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PluginInstanceSummary } from '@kepcup/shared';
import { buildPluginFixture, createTestStack, type TestStack } from '@kepcup/testkit';

import {
  pluginConfigSecretName,
  type InstanceMaterializer,
} from '../../src/plugins/instances.js';

/**
 * 插件配置与实例机制（D105 P1）：纯实例清单、PLUGIN_UPGRADE_REQUIRED、config 的
 * secrets / config_json 落点与审计不含值、实例 CRUD + materializer 失败回滚、
 * 卸载级联拆实例。
 */

const PLUGIN_ID = 'io.github.tester/mail-x';

const root = mkdtempSync(path.join(tmpdir(), 'plugins-instances-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stacks: TestStack[] = [];

async function setup(): Promise<TestStack> {
  const stack = await createTestStack({});
  stacks.push(stack);
  return stack;
}

let fixtureCounter = 0;

async function pureInstanceFixture(
  manifest: Record<string, unknown> = {},
): Promise<{ path: string; sha256: string }> {
  const built = await buildPluginFixture({
    dir: path.join(root, `fx-${(fixtureCounter += 1)}`),
    manifest: {
      id: PLUGIN_ID,
      contributions: null, // 纯实例清单：整个省略 contributions
      instances: ['mail'],
      config: {
        fields: [
          { key: 'pollSec', type: 'number', title: '轮询间隔', min: 60, max: 3600 },
          { key: 'apiKey', type: 'string', title: 'API Key', required: true, sensitive: true },
        ],
      },
      ...manifest,
    },
  });
  return { path: built.path, sha256: built.sha256 };
}

function fakeMaterializer(
  behavior: { createError?: Error } = {},
): InstanceMaterializer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async create(ctx) {
      calls.push(`create:${ctx.instanceId}`);
      if (behavior.createError !== undefined) throw behavior.createError;
      return { title: `邮箱 ${Object.keys(ctx.values).length} 项` };
    },
    async update(ctx) {
      calls.push(`update:${ctx.instanceId}`);
      return {};
    },
    async remove(ctx) {
      calls.push(`remove:${ctx.instanceId}`);
    },
  };
}

async function install(core: TestStack['core'], fixture: { path: string; sha256: string }) {
  return (await core.rpc.call('plugins.install', {
    source: { kind: 'file', path: fixture.path },
    sha256: fixture.sha256,
    userConfig: {},
  })) as { plugin: { id: string } };
}

const instanceRows = (core: TestStack['core']) =>
  core.services.mainDb!.prepare('select * from plugin_instances').all() as Array<
    Record<string, unknown>
  >;

describe('plugin config & instances (D105 P1)', () => {
  it('纯实例清单：inspect 正确、可安装；create 实例在本版本被拒（无 materializer）', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixture.path },
    })) as {
      installable: boolean;
      configFields: Array<{ key: string }>;
      capabilitySummary: string;
    };
    expect(inspect.installable).toBe(true);
    expect(inspect.configFields.map((field) => field.key)).toEqual(['pollSec', 'apiKey']);
    expect(inspect.capabilitySummary).toBe('可添加多个邮箱账号');

    const { plugin } = await install(core, fixture);
    expect(plugin.id).toBe(PLUGIN_ID);
    const list = (await core.rpc.call('plugins.list', undefined)) as {
      plugins: Array<{
        id: string;
        providesInstances: string[];
        instanceCounts: { mail: number; mcp: number };
        configFields: Array<{ key: string }>;
      }>;
    };
    const summary = list.plugins.find((entry) => entry.id === PLUGIN_ID)!;
    expect(summary.providesInstances).toEqual(['mail']);
    expect(summary.instanceCounts).toEqual({ mail: 0, mcp: 0 });
    expect(summary.configFields).toHaveLength(2);

    // P1：mail materializer P3 才接入 —— create 在这里停下（预期 INVALID_INPUT）。
    await expect(
      core.rpc.call('plugins.instances.create', {
        pluginId: PLUGIN_ID,
        values: { address: 'a@b.c' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(instanceRows(core)).toHaveLength(0);
  });

  it('PLUGIN_UPGRADE_REQUIRED：未知字段 / 未知实例类型都提示升级而不是报包无效', async () => {
    const { core } = await setup();
    const unknownField = await buildPluginFixture({
      dir: path.join(root, `fx-${(fixtureCounter += 1)}`),
      manifest: { id: 'io.github.tester/future' },
      rawManifest: JSON.stringify({
        format_version: 1,
        id: 'io.github.tester/future',
        name: '来自未来',
        version: '1.0.0',
        skills: [{ dir: 'skills/docx' }],
        future_section: { x: 1 },
      }),
    });
    await expect(
      core.rpc.call('plugins.inspect', { source: { kind: 'file', path: unknownField.path } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_UPGRADE_REQUIRED' });

    const unknownKind = await buildPluginFixture({
      dir: path.join(root, `fx-${(fixtureCounter += 1)}`),
      manifest: { id: 'io.github.tester/sms' },
      rawManifest: JSON.stringify({
        format_version: 1,
        id: 'io.github.tester/sms',
        name: '短信',
        version: '1.0.0',
        instances: ['sms'],
      }),
    });
    await expect(
      core.rpc.call('plugins.inspect', { source: { kind: 'file', path: unknownKind.path } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_UPGRADE_REQUIRED' });
  });

  it('config.set：敏感值只进 secrets，config_json 不含值，审计不含值；敏感项留存语义', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);

    await expect(
      core.rpc.call('plugins.config.set', {
        id: PLUGIN_ID,
        values: { pollSec: 300, apiKey: 'sk-plugin-config' },
      }),
    ).resolves.toMatchObject({ ok: true });

    const stored = core.services.mainDb!
      .prepare('select config_json from plugins where id = ?')
      .get(PLUGIN_ID) as { config_json: string };
    expect(JSON.parse(stored.config_json)).toEqual({ pollSec: 300 });
    expect(stored.config_json).not.toContain('sk-plugin-config');
    expect(
      core.services.domain!.secrets.getValue(pluginConfigSecretName(PLUGIN_ID, 'apiKey')),
    ).toBe('sk-plugin-config');

    const read = (await core.rpc.call('plugins.config.get', { id: PLUGIN_ID })) as {
      values: Record<string, unknown>;
      storedSensitiveKeys: string[];
    };
    expect(read.values).toEqual({ pollSec: 300 });
    expect(read.storedSensitiveKeys).toEqual(['apiKey']);

    // 未提交的敏感项保留存值；非敏感项整体替换（pollSec 清掉）。
    await core.rpc.call('plugins.config.set', { id: PLUGIN_ID, values: {} });
    const after = (await core.rpc.call('plugins.config.get', { id: PLUGIN_ID })) as {
      values: Record<string, unknown>;
      storedSensitiveKeys: string[];
    };
    expect(after.values).toEqual({});
    expect(after.storedSensitiveKeys).toEqual(['apiKey']);

    // 必填（apiKey）已无提交但有存值 → 满足；未知键拒绝。
    await expect(
      core.rpc.call('plugins.config.set', { id: PLUGIN_ID, values: { nope: 'x' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 清掉存值后必填不再满足。
    core.services.domain!.secrets.removeValue(pluginConfigSecretName(PLUGIN_ID, 'apiKey'));
    await expect(
      core.rpc.call('plugins.config.set', { id: PLUGIN_ID, values: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const audits = core.services.mainDb!
      .prepare("select detail_json from audit_log where action = 'plugin_config_set'")
      .all() as Array<{ detail_json: string }>;
    expect(audits.length).toBeGreaterThanOrEqual(1);
    for (const row of audits) {
      expect(row.detail_json).not.toContain('sk-plugin-config');
      expect(JSON.parse(row.detail_json)).toEqual({ pluginId: PLUGIN_ID });
    }
  });

  it('实例 CRUD：materializer 落领域数据、敏感值入 secrets、失败回滚不留孤儿行', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);
    const materializer = fakeMaterializer();
    core.services.pluginInstances!.registerMaterializer('mail', materializer);

    const created = (await core.rpc.call('plugins.instances.create', {
      pluginId: PLUGIN_ID,
      values: {},
    })) as { instance: PluginInstanceSummary };
    expect(created.instance.kind).toBe('mail');
    expect(created.instance.values).toEqual({});
    expect(materializer.calls).toHaveLength(1);

    const list = (await core.rpc.call('plugins.instances.list', {
      pluginId: PLUGIN_ID,
    })) as { instances: PluginInstanceSummary[] };
    expect(list.instances).toHaveLength(1);
    const summary = (await core.rpc.call('plugins.list', undefined)) as {
      plugins: Array<{ id: string; instanceCounts: { mail: number } }>;
    };
    expect(summary.plugins.find((entry) => entry.id === PLUGIN_ID)!.instanceCounts.mail).toBe(1);

    await core.rpc.call('plugins.instances.update', {
      id: created.instance.id,
      values: {},
    });
    expect(materializer.calls).toContain(`update:${created.instance.id}`);

    await core.rpc.call('plugins.instances.delete', { id: created.instance.id });
    expect(materializer.calls).toContain(`remove:${created.instance.id}`);
    expect(instanceRows(core)).toHaveLength(0);

    // materializer 失败：实例行回滚，错误上抛。
    const failing = fakeMaterializer({ createError: new Error('domain landing failed') });
    core.services.pluginInstances!.registerMaterializer('mail', failing);
    await expect(
      core.rpc.call('plugins.instances.create', { pluginId: PLUGIN_ID, values: {} }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(instanceRows(core)).toHaveLength(0);
  });

  it('卸载级联：先经 materializer 拆实例，再删插件行与实例行', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);
    const materializer = fakeMaterializer();
    core.services.pluginInstances!.registerMaterializer('mail', materializer);
    const { instance } = (await core.rpc.call('plugins.instances.create', {
      pluginId: PLUGIN_ID,
      values: {},
    })) as { instance: PluginInstanceSummary };
    expect(instanceRows(core)).toHaveLength(1);

    await core.rpc.call('plugins.uninstall', { id: PLUGIN_ID });
    expect(materializer.calls).toContain(`remove:${instance.id}`);
    expect(instanceRows(core)).toHaveLength(0);
    expect(
      core.services.mainDb!.prepare('select 1 from plugins where id = ?').get(PLUGIN_ID),
    ).toBeUndefined();
  });
});
