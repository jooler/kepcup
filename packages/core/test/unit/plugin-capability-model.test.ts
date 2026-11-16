import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPluginFixture } from '@kepcup/testkit';

import { BotsService } from '../../src/domain/bots.js';
import { MediaService } from '../../src/media/service.js';
import { bindPluginsMethods } from '../../src/rpc/plugins-bindings.js';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { createCapabilityModelMaterializer } from '../../src/plugins/materializers/capability-model.js';
import { createMediaEntrySource } from '../../src/plugins/media-entry-source.js';
import {
  PluginInstanceService,
  PluginInstanceStore,
  pluginInstanceSecretName,
} from '../../src/plugins/instances.js';
import { CapabilityModelsProjector } from '../../src/plugins/projectors/capability-models.js';
import { PluginPackager } from '../../src/plugins/package.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginStore } from '../../src/plugins/store.js';
import type { Clock } from '../../src/infra/clock.js';
import type { CoreServices } from '../../src/start.js';

/**
 * capability-model kind 全链路（D124，60 号文档 §1–§5）：引擎校验拒装、条目账本、
 * 实例 materializer 落库 / secrets / 卸载回滚，与三个新 RPC 的行为规格。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-capability-model-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => noopLogger };

/** 内存 secrets（实例敏感值 + provider key 同仓；names 支持前缀扫描）。 */
function makeSecrets() {
  const values = new Map<string, string>();
  return {
    hasValue: (name: string) => values.has(name),
    getValue: (name: string) => values.get(name) ?? null,
    setValue: (name: string, value: string) => void values.set(name, value),
    removeValue: (name: string) => void values.delete(name),
    names: () => [...values.keys()],
    size: () => values.size,
  };
}

function makeRig() {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 5_000_000 + tick++ };
  const secrets = makeSecrets();
  const store = new PluginStore(db);
  const instanceStore = new PluginInstanceStore(db);
  const packager = new PluginPackager({
    pluginsDir: paths.pluginsDir,
    logger: noopLogger,
    appVersion: '0.0.0-test',
  });
  const events: Array<{ name: string; payload: unknown }> = [];
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const eventSink = {
    // 事件名是闭联合约；测试夹具只做记录，宽容签名即可。
    emit: (name: string, payload: unknown) => void events.push({ name, payload }),
  } as never;
  const registry = new PluginRegistry({
    store,
    packager,
    projectors: [new CapabilityModelsProjector()],
    secrets: {
      hasValue: secrets.hasValue,
      setValue: secrets.setValue,
      removeValue: secrets.removeValue,
    },
    instanceStore,
    pluginsDir: paths.pluginsDir,
    pluginDataDir: paths.pluginDataDir,
    clock,
    logger: noopLogger,
    events: eventSink,
    audit: { recordSystem: (action, detail) => void audits.push({ action, detail }) },
  });
  const pluginInstances = new PluginInstanceService({
    registry,
    pluginStore: store,
    store: instanceStore,
    secrets,
    clock,
    logger: noopLogger,
    events: eventSink,
    audit: { recordSystem: (action, detail) => void audits.push({ action, detail }) },
  });
  // 卸载 = 级联删除全部实例（与 start.ts 装配一致）；capability-model materializer 同步注册。
  registry.attachInstanceTeardown((pluginId) => pluginInstances.deleteAllOf(pluginId));
  pluginInstances.registerMaterializer('capability-model', createCapabilityModelMaterializer());
  const bots = new BotsService(db, clock);
  bots.attachPluginDirectory({ installed: (pluginId) => store.get(pluginId) !== null });
  // settings 仅条目路径用到全局槽位（image 走 volcengine 全局实例）。
  const settings = {
    get: () => ({
      modelProviders: [
        {
          id: 'volcengine',
          vendor: 'volcengine',
          name: '火山方舟',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          enabled: true,
          models: [],
        },
      ],
      capabilityModels: {
        embedding: null,
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
        image: { provider: 'volcengine', model: 'global-image-model' },
        video: null,
      },
    }),
  };
  const media = new MediaService({
    settings: settings as never,
    secrets: secrets as never,
    logger: noopLogger,
  });
  media.attachEntrySource(
    createMediaEntrySource({
      registry,
      instances: instanceStore,
      secrets: { getValue: secrets.getValue },
      botRuntimeOf: (botId) => bots.get(botId)?.profile.runtime ?? null,
      logger: noopLogger,
    }),
  );
  const services = {
    plugins: registry,
    pluginInstances,
    media,
    domain: { bots },
    events: eventSink,
  } as unknown as CoreServices;
  const bindings = bindPluginsMethods(services);
  return {
    home,
    paths,
    registry,
    store,
    instanceStore,
    pluginInstances,
    bots,
    media,
    secrets,
    events,
    bindings,
    clock,
  };
}

const ARK_MANIFEST = {
  id: 'io.test/ark',
  name: '火山方舟测试包',
  instances: ['capability-model'],
  contributions: {
    capabilityModels: [
      {
        id: 'seedream',
        capability: 'image',
        model: 'doubao-seedream-4-5',
        engine: 'volcengine-ark',
        displayName: 'Seedream 4.5',
      },
    ],
  },
};

/** 双条目清单（声明序 alpha → beta；条目输出序 / 回退默认条目测试用）。 */
const TWO_MANIFEST = {
  id: 'io.test/two',
  name: '双条目测试包',
  instances: ['capability-model'],
  contributions: {
    capabilityModels: [
      { id: 'alpha', capability: 'image', model: 'model-alpha', engine: 'volcengine-ark' },
      { id: 'beta', capability: 'image', model: 'model-beta', engine: 'volcengine-ark' },
    ],
  },
};

/** 混能力 / 混引擎条目（capabilityInstanceOf 的 D124 口径回归：引擎取声明序首个）。 */
const MIXED_MANIFEST = {
  id: 'io.test/mixed',
  name: '混引擎测试包',
  instances: ['capability-model'],
  contributions: {
    capabilityModels: [
      { id: 'img', capability: 'image', model: 'model-img', engine: 'dashscope' },
      { id: 'vid', capability: 'video', model: 'model-vid', engine: 'volcengine-ark' },
    ],
  },
};

/**
 * 混合插件（D125 §2 过渡面：runtime 段 + 数据型 engine 条目并存）。执行体来源必须
 * 逐条判定：engine 条目仍由第一方引擎执行，只有不填 engine 的条目走托管适配器。
 * `pluginKey` 与引擎凭据（apiKey / baseUrl）不重名（安装管线拒绝重名）。
 */
const MIXED_RUNTIME_ID = 'io.test/mixed-runtime';
const MIXED_RUNTIME_MANIFEST = {
  id: MIXED_RUNTIME_ID,
  name: '混合执行型测试包',
  instances: ['capability-model'],
  runtime: {
    entry: 'main.mjs',
    hostApi: '^1',
    instanceFields: [
      {
        key: 'pluginKey',
        type: 'string',
        title: '插件凭据',
        required: true,
        sensitive: true,
      },
    ],
  },
  contributions: {
    capabilityModels: [
      {
        id: 'engine-img',
        capability: 'image',
        model: 'engine-model',
        engine: 'volcengine-ark',
      },
      { id: 'plugin-img', capability: 'image', model: 'plugin-model' },
    ],
  },
};

async function installPlugin(
  rig: Awaited<ReturnType<typeof makeRig>>,
  manifest: Record<string, unknown>,
  extraEntries?: Array<{ name: string; data: Buffer | string }>,
): Promise<void> {
  const fixture = await buildPluginFixture({
    dir: path.join(rig.home, `pkg-${Math.random().toString(36).slice(2, 8)}`),
    id: String(manifest['id']),
    name: String(manifest['name']),
    manifest: manifest as never,
    ...(extraEntries !== undefined ? { extraEntries } : {}),
  });
  await rig.registry.install({
    source: { kind: 'file', path: fixture.path },
    sha256: fixture.sha256,
    userConfig: {},
    via: 'file',
  });
}

async function installArk(rig: Awaited<ReturnType<typeof makeRig>>): Promise<void> {
  await installPlugin(rig, ARK_MANIFEST);
}

/** 与 start.ts 装配同构的条目仓库（run 内多次构造以换 botRuntimeOf 闭包之外的依赖）。 */
function entrySourceOf(rig: Awaited<ReturnType<typeof makeRig>>) {
  return createMediaEntrySource({
    registry: rig.registry,
    instances: rig.instanceStore,
    secrets: { getValue: rig.secrets.getValue },
    botRuntimeOf: (botId) => rig.bots.get(botId)?.profile.runtime ?? null,
    logger: noopLogger,
  });
}

const okArkImage = (async () =>
  new Response(
    JSON.stringify({ data: [{ url: 'https://out.example/ark.png' }] }),
  )) as unknown as typeof fetch;

describe('capability-model 安装管线（D124）', () => {
  it('条目 engine 未注册 → 拒装（PLUGIN_ENGINE_UNKNOWN，错误信息列出已注册引擎）', async () => {
    const rig = makeRig();
    const fixture = await buildPluginFixture({
      dir: path.join(rig.home, 'pkg-unknown'),
      id: 'io.test/unknown',
      name: '未知引擎',
      manifest: {
        id: 'io.test/unknown',
        instances: ['capability-model'],
        contributions: {
          capabilityModels: [
            { id: 'm1', capability: 'image', model: 'x', engine: 'totally-new-engine' },
          ],
        },
      } as never,
    });
    await expect(
      rig.registry.install({
        source: { kind: 'file', path: fixture.path },
        sha256: fixture.sha256,
        userConfig: {},
        via: 'file',
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ENGINE_UNKNOWN' });
    // 错误信息列出已注册引擎 id（60 §2）。
    await expect(
      rig.registry.install({
        source: { kind: 'file', path: fixture.path },
        sha256: fixture.sha256,
        userConfig: {},
        via: 'file',
      }),
    ).rejects.toThrow(/dashscope/);
    expect(rig.store.get('io.test/unknown')).toBeNull();
  });

  it('已知引擎安装成功：条目记入 plugin_items 账本（kind capability-model）', async () => {
    const rig = makeRig();
    await installArk(rig);
    expect(rig.store.refs('io.test/ark', 'capability-model')).toEqual(['seedream']);
    const summary = rig.registry.list().find((plugin) => plugin.id === 'io.test/ark');
    expect(summary?.providesInstances).toContain('capability-model');
    // 插件卡的 counts / items 保持固定五键口径（条目清单走 listCapabilityEntries）。
    expect(summary?.items.some((item) => item.kind === ('capability-model' as never))).toBe(false);
    expect(summary?.counts).toEqual({ skills: 0, connectors: 0, mcp: 0, mail: 0, im: 0 });
  });

  it('更新引入未知引擎条目 → 拒绝（本地同 id 重装 = 更新流；旧版本原样保留）', async () => {
    const rig = makeRig();
    await installArk(rig);
    const before = rig.store.get('io.test/ark');
    expect(before?.version).toBe('1.0.0');
    const fixture = await buildPluginFixture({
      dir: path.join(rig.home, 'pkg-update-unknown'),
      id: ARK_MANIFEST.id,
      name: ARK_MANIFEST.name,
      manifest: {
        ...ARK_MANIFEST,
        version: '2.0.0',
        contributions: {
          capabilityModels: [
            { id: 'seedream', capability: 'image', model: 'x', engine: 'totally-new-engine' },
          ],
        },
      } as never,
    });
    await expect(
      rig.registry.install({
        source: { kind: 'file', path: fixture.path },
        sha256: fixture.sha256,
        userConfig: {},
        via: 'file',
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ENGINE_UNKNOWN' });
    // 拒绝路径不碰旧版本（任何持久化写入之前拒绝）。
    const after = rig.store.get('io.test/ark');
    expect(after?.version).toBe('1.0.0');
    expect(after?.state).toBe('installed');
  });
});

describe('capability-model 实例 materializer（D124）', () => {
  it('实例落库：config_json 存非敏感值，敏感值入 secrets，标题取插件名', async () => {
    const rig = makeRig();
    await installArk(rig);
    const instance = await rig.pluginInstances.create(
      'io.test/ark',
      { apiKey: 'sk-live', baseUrl: 'https://override.example/v3' },
      'capability-model',
    );
    expect(instance.kind).toBe('capability-model');
    expect(instance.title).toBe('火山方舟测试包');
    expect(instance.values).toEqual({ baseUrl: 'https://override.example/v3' });
    expect(instance.storedSensitiveKeys).toEqual(['apiKey']);
    // secrets 名沿用 D105 规则：plugin:{pluginId}:instance:{instanceId}:{key}。
    const secretName = `plugin:io_dtest_sark:instance:${instance.id}:apiKey`;
    expect(rig.secrets.getValue(secretName)).toBe('sk-live');
  });

  it('实例删除：行与 secrets 一并清掉（前缀扫描）', async () => {
    const rig = makeRig();
    await installArk(rig);
    const instance = await rig.pluginInstances.create(
      'io.test/ark',
      { apiKey: 'sk-live' },
      'capability-model',
    );
    expect(rig.secrets.size()).toBe(1);
    await rig.pluginInstances.delete(instance.id);
    expect(rig.instanceStore.list('io.test/ark')).toHaveLength(0);
    expect(rig.secrets.size()).toBe(0);
  });

  it('卸载插件：实例级联回滚（行 + secrets + 账本条目全部消失）', async () => {
    const rig = makeRig();
    await installArk(rig);
    await rig.pluginInstances.create('io.test/ark', { apiKey: 'sk-live' }, 'capability-model');
    await rig.registry.uninstall('io.test/ark');
    expect(rig.store.get('io.test/ark')).toBeNull();
    expect(rig.instanceStore.list('io.test/ark')).toHaveLength(0);
    expect(rig.store.refs('io.test/ark', 'capability-model')).toEqual([]);
    expect(rig.secrets.size()).toBe(0);
  });

  it('materializer 直拒未注册引擎（防降级场景）', async () => {
    const rig = makeRig();
    await installArk(rig);
    const materializer = createCapabilityModelMaterializer();
    await expect(
      materializer.create({
        pluginId: 'io.test/ark',
        instanceId: 'pli_x',
        kind: 'capability-model',
        title: 'x',
        manifest: {
          name: 'x',
          contributions: {
            capabilityModels: [
              { id: 'm', capability: 'image', model: 'x', engine: 'future-engine' },
            ],
          },
        } as never,
        values: {},
        readStoredSecret: () => null,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ENGINE_UNKNOWN' });
  });
});

describe('plugins.* 能力模型条目 RPC（D124）', () => {
  it('plugins.testCapabilityEntry：按条目能力走同款探针，keyOverride 未保存先测', async () => {
    const rig = makeRig();
    await installArk(rig);
    await rig.pluginInstances.create('io.test/ark', { apiKey: 'sk-saved' }, 'capability-model');
    // 注入 fetch seam（方舟图像同步端点返回一张图）。
    const media = new MediaService({
      settings: (rig.media as never as { '#settings': unknown })['#settings'] as never,
      secrets: rig.secrets as never,
      logger: noopLogger,
      fetchImpl: okArkImage,
    });
    media.attachEntrySource(
      createMediaEntrySource({
        registry: rig.registry,
        instances: rig.instanceStore,
        secrets: { getValue: rig.secrets.getValue },
        botRuntimeOf: (botId) => rig.bots.get(botId)?.profile.runtime ?? null,
        logger: noopLogger,
      }),
    );
    const bindings = bindPluginsMethods({
      plugins: rig.registry,
      pluginInstances: rig.pluginInstances,
      media,
      domain: { bots: rig.bots },
      events: { emit: () => {} },
    } as unknown as CoreServices);
    // 未保存先测：keyOverride 优先于 secrets。
    await expect(
      bindings['plugins.testCapabilityEntry']!.handle({
        pluginId: 'io.test/ark',
        entryId: 'seedream',
        keyOverride: 'sk-unsaved',
      }),
    ).resolves.toEqual({ ok: true });
    // 存量凭据同样可测。
    await expect(
      bindings['plugins.testCapabilityEntry']!.handle({
        pluginId: 'io.test/ark',
        entryId: 'seedream',
      }),
    ).resolves.toEqual({ ok: true });
    // 条目不存在 → NOT_FOUND。
    await expect(
      bindings['plugins.testCapabilityEntry']!.handle({
        pluginId: 'io.test/ark',
        entryId: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('plugins.listCapabilityEntries：实例状态与凭据齐备口径（configured）', async () => {
    const rig = makeRig();
    await installArk(rig);
    const before = await rig.bindings['plugins.listCapabilityEntries']!.handle(undefined);
    expect(before.plugins).toHaveLength(1);
    expect(before.plugins[0]).toMatchObject({
      pluginId: 'io.test/ark',
      pluginName: '火山方舟测试包',
      tier: 'developer',
    });
    expect(before.plugins[0]?.entries).toEqual([
      {
        entryId: 'seedream',
        capability: 'image',
        model: 'doubao-seedream-4-5',
        displayName: 'Seedream 4.5',
        engine: 'volcengine-ark',
        source: 'engine',
        instanceState: 'none',
        configured: false,
      },
    ]);
    await rig.pluginInstances.create('io.test/ark', { apiKey: 'sk-live' }, 'capability-model');
    const after = await rig.bindings['plugins.listCapabilityEntries']!.handle(undefined);
    expect(after.plugins[0]?.entries[0]).toMatchObject({
      instanceState: 'single',
      configured: true,
    });
  });

  it('plugins.setBotCapabilityEntries：未知 ref 整批拒绝并列出违规项；合法写入 capability_entries', async () => {
    const rig = makeRig();
    await installArk(rig);
    const bot = rig.bots.create({ identity: { name: '测试 Bot' } }, { skipDefaultAgent: true });
    // 未知插件 + 已装插件的未知条目：一次性列出，且两种原因分开（未安装 ≠ 条目不存在）。
    const rejection = await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [
        { plugin: 'io.test/ghost', entry: 'm' },
        { plugin: 'io.test/ark', entry: 'ghost-entry' },
      ],
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(rejection?.code).toBe('INVALID_INPUT');
    expect(rejection?.message).toContain('io.test/ghost/m（插件未安装）');
    expect(rejection?.message).toContain('io.test/ark/ghost-entry（条目不存在）');
    // 合法整集替换 + 事件广播（bot.updated + plugins.changed）。
    rig.events.length = 0;
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [
        { plugin: 'io.test/ark', entry: 'seedream' },
        { plugin: 'io.test/ark', entry: 'seedream' }, // 重复勾选折叠
      ],
    });
    expect(rig.bots.get(bot.id)?.profile.runtime.capability_entries).toEqual([
      { plugin: 'io.test/ark', entry: 'seedream' },
    ]);
    expect(rig.events.some((event) => event.name === 'bot.updated')).toBe(true);
    expect(rig.events.some((event) => event.name === 'plugins.changed')).toBe(true);
  });

  it('条目解析链端到端：Bot 勾选条目后媒体调用走插件实例凭据（卸载后回退全局槽位）', async () => {
    const rig = makeRig();
    await installArk(rig);
    const bot = rig.bots.create({ identity: { name: '测试 Bot' } }, { skipDefaultAgent: true });
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [{ plugin: 'io.test/ark', entry: 'seedream' }],
    });
    await rig.pluginInstances.create('io.test/ark', { apiKey: 'sk-live' }, 'capability-model');
    // Bot 勾选了条目但插件不在 plugin_ids（effectivePluginIds）→ 条目不生效，走全局。
    const calls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ url: 'https://out.example/ark.png' }] }));
    }) as unknown as typeof fetch;
    const media = rig.media;
    // 用真实 rig 的 media 换上 fetch seam 的最小办法：直接断言 entriesFor 行为。
    // （MediaService 的解析分支已由 media-entry-resolution.test.ts 覆盖，这里验证
    // createMediaEntrySource 的有效集口径。）
    const source = createMediaEntrySource({
      registry: rig.registry,
      instances: rig.instanceStore,
      secrets: { getValue: rig.secrets.getValue },
      botRuntimeOf: (botId) => rig.bots.get(botId)?.profile.runtime ?? null,
      logger: noopLogger,
    });
    expect(await source.entriesFor(bot.id, 'image')).toEqual([]);
    // 勾选 plugin_ids 后条目生效（条目 model / 引擎 / 唯一实例解析）。
    rig.bots.setPluginIds(bot.id, ['io.test/ark']);
    const entries = await source.entriesFor(bot.id, 'image');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pluginId: 'io.test/ark',
      entryId: 'seedream',
      model: 'doubao-seedream-4-5',
      engine: 'volcengine-ark',
      instanceId: expect.stringMatching(/^pli_/),
      instances: [expect.stringMatching(/^pli_/)],
    });
    // 卸载插件 → 残留引用静默跳过。
    await rig.registry.uninstall('io.test/ark');
    expect(await source.entriesFor(bot.id, 'image')).toEqual([]);
    void fetchImpl;
    void calls;
    void media;
  });

  it('entriesFor 有效集第三闸：全局停用插件 → 条目不消费；重新启用恢复（60 决策 5「已安装启用」）', async () => {
    const rig = makeRig();
    await installArk(rig);
    const bot = rig.bots.create({ identity: { name: '测试 Bot' } }, { skipDefaultAgent: true });
    rig.bots.setPluginIds(bot.id, ['io.test/ark']);
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [{ plugin: 'io.test/ark', entry: 'seedream' }],
    });
    await rig.pluginInstances.create('io.test/ark', { apiKey: 'sk-live' }, 'capability-model');
    const source = entrySourceOf(rig);
    expect(await source.entriesFor(bot.id, 'image')).toHaveLength(1);
    await rig.registry.setEnabled('io.test/ark', false);
    expect(await source.entriesFor(bot.id, 'image')).toEqual([]);
    await rig.registry.setEnabled('io.test/ark', true);
    expect(await source.entriesFor(bot.id, 'image')).toHaveLength(1);
  });

  it('entriesFor 输出序：插件内按条目声明序（勾选序不影响回退默认条目，60 §4 ① 内排序）', async () => {
    const rig = makeRig();
    await installPlugin(rig, TWO_MANIFEST);
    const bot = rig.bots.create({ identity: { name: '测试 Bot' } }, { skipDefaultAgent: true });
    rig.bots.setPluginIds(bot.id, ['io.test/two']);
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      // 勾选序 beta → alpha（与声明序相反）。
      entries: [
        { plugin: 'io.test/two', entry: 'beta' },
        { plugin: 'io.test/two', entry: 'alpha' },
      ],
    });
    await rig.pluginInstances.create('io.test/two', { apiKey: 'sk-live' }, 'capability-model');
    const entries = await entrySourceOf(rig).entriesFor(bot.id, 'image');
    // 声明序 alpha → beta 胜出；回退默认条目 = alpha。
    expect(entries.map((entry) => entry.entryId)).toEqual(['alpha', 'beta']);
    expect(entries.every((entry) => entry.model === `model-${entry.entryId}`)).toBe(true);
  });

  it('capabilityInstanceOf 数据型口径不变：引擎 / 条目取声明序首个（不因 video 条目改道）', async () => {
    const rig = makeRig();
    await installPlugin(rig, MIXED_MANIFEST);
    const instance = await rig.pluginInstances.create(
      'io.test/mixed',
      { apiKey: 'sk-live' },
      'capability-model',
    );
    expect(await entrySourceOf(rig).capabilityInstanceOf(instance.id)).toEqual({
      pluginId: 'io.test/mixed',
      engine: 'dashscope',
      source: 'engine',
      entryId: 'img',
      model: 'model-img',
    });
  });

  it('混合插件（runtime + 数据型条目）：执行体来源逐条判定，engine 条目不被送进插件进程', async () => {
    const rig = makeRig();
    await installPlugin(rig, MIXED_RUNTIME_MANIFEST, [{ name: 'main.mjs', data: 'export {};\n' }]);
    const bot = rig.bots.create({ identity: { name: '测试 Bot' } }, { skipDefaultAgent: true });
    rig.bots.setPluginIds(bot.id, [MIXED_RUNTIME_ID]);
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [
        { plugin: MIXED_RUNTIME_ID, entry: 'engine-img' },
        { plugin: MIXED_RUNTIME_ID, entry: 'plugin-img' },
      ],
    });
    const instance = await rig.pluginInstances.create(
      MIXED_RUNTIME_ID,
      { apiKey: 'sk-ark', pluginKey: 'pk-plugin' },
      'capability-model',
    );
    const source = entrySourceOf(rig);
    // 本条即是回归点：按插件整体判定时两条都会被标成 source:'plugin'。
    expect(await source.entriesFor(bot.id, 'image')).toMatchObject([
      { entryId: 'engine-img', engine: 'volcengine-ark', source: 'engine' },
      { entryId: 'plugin-img', engine: '', source: 'plugin' },
    ]);
    // 视频往返同口径（无 video 条目 → 声明序首个；这里是 engine 条目）。
    expect(await source.capabilityInstanceOf(instance.id)).toMatchObject({
      engine: 'volcengine-ark',
      source: 'engine',
      entryId: 'engine-img',
    });

    // 同意 / 勾选视图：source / engine 逐条，configured 按各自必填凭据判定。
    const listed = (await rig.bindings['plugins.listCapabilityEntries']!.handle(undefined)) as {
      plugins: Array<{
        pluginId: string;
        entries: Array<{
          entryId: string;
          engine: string | null;
          source?: string;
          configured: boolean;
        }>;
      }>;
    };
    const group = listed.plugins.find((row) => row.pluginId === MIXED_RUNTIME_ID);
    expect(group?.entries).toMatchObject([
      { entryId: 'engine-img', engine: 'volcengine-ark', source: 'engine', configured: true },
      { entryId: 'plugin-img', engine: null, source: 'plugin', configured: true },
    ]);
    // 删掉插件条目的必填凭据：只有 plugin-img 变「未配置」，引擎条目的 apiKey 不受影响。
    rig.secrets.removeValue(pluginInstanceSecretName(MIXED_RUNTIME_ID, instance.id, 'pluginKey'));
    const afterRemoval = (await rig.bindings['plugins.listCapabilityEntries']!.handle(
      undefined,
    )) as typeof listed;
    expect(
      afterRemoval.plugins
        .find((row) => row.pluginId === MIXED_RUNTIME_ID)
        ?.entries.map((entry) => [entry.entryId, entry.configured]),
    ).toEqual([
      ['engine-img', true],
      ['plugin-img', false],
    ]);

    // 条目级探测：engine 条目走第一方引擎（fetch seam），plugin 条目走托管适配器。
    const hostedProbes: string[] = [];
    const hostedOverrides: Array<Record<string, string> | undefined> = [];
    const media = new MediaService({
      settings: {
        get: () => ({ appLanguage: 'zh-CN', modelProviders: [], capabilityModels: {} }),
      } as never,
      secrets: rig.secrets as never,
      logger: noopLogger,
      fetchImpl: okArkImage,
    });
    media.attachEntrySource(
      createMediaEntrySource({
        registry: rig.registry,
        instances: rig.instanceStore,
        secrets: { getValue: rig.secrets.getValue },
        botRuntimeOf: (botId) => rig.bots.get(botId)?.profile.runtime ?? null,
        logger: noopLogger,
        hostedAdapterOf: () =>
          ({
            generateImage: async (ctx: { credentialOverrides?: Record<string, string> }) => {
              hostedProbes.push('plugin-img');
              hostedOverrides.push(ctx.credentialOverrides);
              return { images: [{ url: 'https://out.example/plugin.png' }] };
            },
          }) as never,
      }),
    );
    // 未保存先测：keyOverride 映射到 runtime.instanceFields 的敏感键（pluginKey）。
    expect(
      await media.testCapabilityEntry(MIXED_RUNTIME_ID, 'engine-img', {
        keyOverride: 'sk-ark-unsaved',
      }),
    ).toBeUndefined();
    expect(hostedProbes).toEqual([]);
    await expect(
      media.testCapabilityEntry(MIXED_RUNTIME_ID, 'plugin-img', { keyOverride: 'pk-unsaved' }),
    ).resolves.toBeUndefined();
    expect(hostedProbes).toEqual(['plugin-img']);
    expect(hostedOverrides).toEqual([{ pluginKey: 'pk-unsaved' }]);
  });
});
