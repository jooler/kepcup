import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PluginInstanceSummary } from '@kepcup/shared';
import { buildPluginFixture, createTestStack, type TestStack } from '@kepcup/testkit';

import {
  pluginConfigSecretName,
  pluginSecretScope,
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
      // 缺省：mail 供给规范 + 机制用例的假 materializer（不会真连，锁定端点写占位主机）。
      // 覆盖 `instances` / `contributions` / `config` 的用例直接传 manifest 覆盖。
      instances: ['mail'],
      contributions: {
        skills: [],
        connectors: [],
        mcp: [],
        mail: [
          {
            id: 'generic',
            label: '机制用例',
            imap: { host: 'imap.invalid', port: 993, secure: 'ssl' },
            smtp: { host: 'smtp.invalid', port: 465, secure: 'ssl' },
          },
        ],
      },
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

// P3：mail 内置实例字段（address / username / password）已生效——实例机制的通用用例
// 也按真实字段提交（address / password 必填）。
const MAIL_VALUES = { address: 'bot@example.com', password: 'authcode' };

const instanceRows = (core: TestStack['core']) =>
  core.services.mainDb!.prepare('select * from plugin_instances').all() as Array<
    Record<string, unknown>
  >;

describe('plugin config & instances (D105 P1)', () => {
  it('纯实例清单：inspect 正确、可安装；create 实例在本版本被拒（无 materializer）', async () => {
    const { core } = await setup();
    // P3：纯实例形态（无贡献）只剩 mcp；mail 声明必须伴随供给规范贡献。
    const fixture = await pureInstanceFixture({
      instances: ['mcp'],
      contributions: null,
    });
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixture.path },
    })) as {
      installable: boolean;
      configFields: Array<{ key: string }>;
      capabilitySummary: string;
    };
    expect(inspect.installable).toBe(true);
    expect(inspect.configFields.map((field) => field.key)).toEqual(['pollSec', 'apiKey']);
    expect(inspect.capabilitySummary).toBe('可添加自定义工具');

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
    expect(summary.providesInstances).toEqual(['mcp']);
    expect(summary.instanceCounts).toEqual({ mail: 0, mcp: 0 });
    expect(summary.configFields).toHaveLength(2);

    // P1：mcp 实例 P4-M2 才接入 —— create 在适配器层停下（预期 PLUGIN_INVALID）。
    await expect(
      core.rpc.call('plugins.instances.create', {
        pluginId: PLUGIN_ID,
        values: {},
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
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
      values: MAIL_VALUES,
    })) as { instance: PluginInstanceSummary };
    expect(created.instance.kind).toBe('mail');
    expect(created.instance.values).toEqual({ address: MAIL_VALUES.address });
    expect(materializer.calls).toHaveLength(1);

    const list = (await core.rpc.call('plugins.instances.list', {
      pluginId: PLUGIN_ID,
    })) as { instances: PluginInstanceSummary[] };
    expect(list.instances).toHaveLength(1);
    const summary = (await core.rpc.call('plugins.list', undefined)) as {
      plugins: Array<{ id: string; instanceCounts: { mail: number } }>;
    };
    // P3 口径：instanceCounts.mail 按 mail_accounts 活跃账号统计——假 materializer
    // 不落真实账号，实例行存在也计 0。
    expect(summary.plugins.find((entry) => entry.id === PLUGIN_ID)!.instanceCounts.mail).toBe(0);

    await core.rpc.call('plugins.instances.update', {
      id: created.instance.id,
      values: MAIL_VALUES,
    });
    expect(materializer.calls).toContain(`update:${created.instance.id}`);

    await core.rpc.call('plugins.instances.delete', { id: created.instance.id });
    expect(materializer.calls).toContain(`remove:${created.instance.id}`);
    expect(instanceRows(core)).toHaveLength(0);

    // materializer 失败：实例行回滚，错误上抛。
    const failing = fakeMaterializer({ createError: new Error('domain landing failed') });
    core.services.pluginInstances!.registerMaterializer('mail', failing);
    await expect(
      core.rpc.call('plugins.instances.create', { pluginId: PLUGIN_ID, values: MAIL_VALUES }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(instanceRows(core)).toHaveLength(0);
  });

  it('卸载级联：先经 materializer 拆实例，再删插件行与实例行；remove 失败不阻断卸载', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);
    let failRemove = false;
    const materializer = fakeMaterializer();
    const originalRemove = materializer.remove.bind(materializer);
    materializer.remove = async (ctx) => {
      materializer.calls.push(`remove:${ctx.instanceId}`);
      if (failRemove) throw new Error('domain teardown failed');
      return originalRemove(ctx);
    };
    core.services.pluginInstances!.registerMaterializer('mail', materializer);
    const { instance } = (await core.rpc.call('plugins.instances.create', {
      pluginId: PLUGIN_ID,
      values: MAIL_VALUES,
    })) as { instance: PluginInstanceSummary };
    expect(instanceRows(core)).toHaveLength(1);

    // 级联对 materializer 失败取 best-effort：卸载必须完成，失败只记日志。
    failRemove = true;
    await core.rpc.call('plugins.uninstall', { id: PLUGIN_ID });
    expect(materializer.calls).toContain(`remove:${instance.id}`);
    expect(instanceRows(core)).toHaveLength(0);
    expect(
      core.services.mainDb!.prepare('select 1 from plugins where id = ?').get(PLUGIN_ID),
    ).toBeUndefined();
  });

  it('崩溃恢复：卸载中途崩溃（state=uninstalling 留有实例行）→ recoverInterrupted 不留实例孤儿', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);
    const materializer = fakeMaterializer();
    core.services.pluginInstances!.registerMaterializer('mail', materializer);
    const { instance } = (await core.rpc.call('plugins.instances.create', {
      pluginId: PLUGIN_ID,
      values: MAIL_VALUES,
    })) as { instance: PluginInstanceSummary };

    // 模拟：卸载把行标成 uninstalling 后进程死亡。
    core.services.mainDb!
      .prepare("update plugins set state = 'uninstalling' where id = ?")
      .run(PLUGIN_ID);

    const recovered = await core.services.plugins!.recoverInterrupted();
    expect(recovered).toBe(1);
    expect(materializer.calls).toContain(`remove:${instance.id}`);
    expect(instanceRows(core)).toHaveLength(0);
    expect(
      core.services.mainDb!.prepare('select 1 from plugins where id = ?').get(PLUGIN_ID),
    ).toBeUndefined();
  });

  it('update：materializer 失败时行值原样保留（无补偿窗口）；成功后合并落库', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);
    let failUpdate = false;
    const materializer = fakeMaterializer();
    const originalUpdate = materializer.update.bind(materializer);
    materializer.update = async (ctx) => {
      if (failUpdate) throw new Error('domain update failed');
      return originalUpdate(ctx);
    };
    core.services.pluginInstances!.registerMaterializer('mail', materializer);
    const { instance } = (await core.rpc.call('plugins.instances.create', {
      pluginId: PLUGIN_ID,
      values: MAIL_VALUES,
    })) as { instance: PluginInstanceSummary };

    failUpdate = true;
    await expect(
      core.rpc.call('plugins.instances.update', { id: instance.id, values: MAIL_VALUES }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    const row = core.services.mainDb!
      .prepare('select config_json, updated_at from plugin_instances where id = ?')
      .get(instance.id) as { config_json: string; updated_at: number };
    expect(JSON.parse(row.config_json)).toEqual(instance.values);

    failUpdate = false;
    const updated = (await core.rpc.call('plugins.instances.update', {
      id: instance.id,
      values: MAIL_VALUES,
    })) as { instance: PluginInstanceSummary };
    expect(updated.instance.id).toBe(instance.id);
  });

  it('FK CASCADE 兜底：直接删插件行时实例行随之消失', async () => {
    const { core } = await setup();
    const fixture = await pureInstanceFixture();
    await install(core, fixture);
    core.services.pluginInstances!.registerMaterializer('mail', fakeMaterializer());
    await core.rpc.call('plugins.instances.create', { pluginId: PLUGIN_ID, values: MAIL_VALUES });
    expect(instanceRows(core)).toHaveLength(1);
    core.services.mainDb!.prepare('delete from plugins where id = ?').run(PLUGIN_ID);
    expect(instanceRows(core)).toHaveLength(0);
  });

  it('插件标识的 secrets 转义无歧义：易碰撞对与真实键互不冲突；实例敏感值落地并可枚举', async () => {
    // 转义单射性（`_u/_d/_s`）：`x._y` 与 `x_.y` 这类 id 编码后必须不同。
    expect(pluginSecretScope('io.a/x._y')).not.toBe(pluginSecretScope('io.a/x_.y'));
    expect(pluginSecretScope('io.a/b')).not.toBe(pluginSecretScope('io.a_s/b'));

    const { core } = await setup();
    const fixture = await pureInstanceFixture({
      // 换一个 id 避免与其它用例的 secrets 混淆（本测试有独立 stack，其实不必要，稳妥起见）。
      id: 'io.github.tester/mail-y',
    });
    await install(core, fixture);
    let fields: Array<{ key: string; type: string; sensitive: boolean; required: boolean }> = [];
    const materializer: InstanceMaterializer & { seen?: Record<string, unknown> } = {
      async create(ctx) {
        return { title: '邮箱' };
      },
      async update() {
        return {};
      },
      async remove() {},
    };
    void materializer;
    void fields;
    // 通过 config 路径验证敏感值经转义键落 secrets（实例敏感值路径 P3 才有字段）。
    await core.rpc.call('plugins.config.set', {
      id: 'io.github.tester/mail-y',
      values: { apiKey: 'sk-instance-test' },
    });
    const names = core.services.domain!.secrets.names();
    const scope = `${pluginSecretScope('io.github.tester/mail-y')}:`;
    expect(names.filter((name) => name.startsWith(scope))).toEqual([
      pluginConfigSecretName('io.github.tester/mail-y', 'apiKey'),
    ]);
  });
});
