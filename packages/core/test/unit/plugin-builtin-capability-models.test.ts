import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { VENDOR_DESCRIPTORS } from '@kepcup/shared';

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
import { PluginInstanceService, PluginInstanceStore } from '../../src/plugins/instances.js';
import { CapabilityModelsProjector } from '../../src/plugins/projectors/capability-models.js';
import { BuiltinPlugins } from '../../src/plugins/builtin.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginStore } from '../../src/plugins/store.js';
import type { Clock } from '../../src/infra/clock.js';
import type { CoreServices } from '../../src/start.js';

/**
 * 内置官方数据插件 × 能力模型条目（D124 P4，60 号文档 §决策 12）：仓库 `plugins/`
 * 开发树里的「阿里云百炼」「火山方舟」两个纯数据包经 D104 只读目录机制（builtin
 * 来源）投影——真实清单逐字校验、`plugins.listCapabilityEntries` 可见、Bot 可勾选、
 * 条目解析链可用。builtin 插件不入 `plugins` 表（D104 既有机制），因此不能持有
 * 账号实例（外键，DEV-112）：凭据 / 测试连接 / 真机出图走市场安装路径。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-builtin-capability-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => noopLogger };

/** 仓库 `plugins/` 开发树（本测试以真实包内容为夹具——包坏了这里第一时间爆）。 */
function repoPluginsDir(): string {
  // test/unit → test → core → packages → 仓库根。
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'plugins',
  );
}

/** 把两个真实插件包拷进 `{ns}/{name}` 两级布局的 builtin 夹具目录（仿 e2e helper）。 */
function builtinFixtureDir(): string {
  const dir = path.join(root, `builtin-${Math.random().toString(36).slice(2, 8)}`);
  for (const name of ['dashscope', 'volcengine-ark']) {
    const target = path.join(dir, 'io.kepcup', name);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(repoPluginsDir(), name), target, { recursive: true });
  }
  return dir;
}

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
  const builtinDir = builtinFixtureDir();
  const builtin = new BuiltinPlugins({
    env: { KEPCUP_BUILTIN_PLUGINS: builtinDir },
    logger: noopLogger,
  });
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 6_000_000 + tick++ };
  const secrets = makeSecrets();
  const store = new PluginStore(db);
  const instanceStore = new PluginInstanceStore(db);
  const events: Array<{ name: string; payload: unknown }> = [];
  const eventSink = {
    emit: (name: string, payload: unknown) => void events.push({ name, payload }),
  } as never;
  const registry = new PluginRegistry({
    store,
    packager: {
      stage: () => {
        throw new Error('builtin rig 不走安装流');
      },
      discard: () => {},
    } as never,
    projectors: [new CapabilityModelsProjector()],
    builtin,
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
    audit: { recordSystem: () => {} },
  });
  const pluginInstances = new PluginInstanceService({
    registry,
    pluginStore: store,
    store: instanceStore,
    secrets,
    clock,
    logger: noopLogger,
    events: eventSink,
    audit: { recordSystem: () => {} },
  });
  pluginInstances.registerMaterializer('capability-model', createCapabilityModelMaterializer());
  const bots = new BotsService(db, clock);
  // 与 start.ts 装配同构：builtin 插件视为已安装（D124 P4 补通路）。
  bots.attachPluginDirectory({
    installed: (pluginId) => store.get(pluginId) !== null || builtin.get(pluginId) !== null,
  });
  const settings = {
    get: () => ({
      modelProviders: [],
      capabilityModels: {
        embedding: null,
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
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
    builtinDir,
    builtin,
    registry,
    store,
    instanceStore,
    pluginInstances,
    bots,
    media,
    secrets,
    events,
    bindings,
  };
}

const DASHSCOPE_ID = 'io.kepcup/dashscope';
const ARK_ID = 'io.kepcup/volcengine-ark';

/**
 * `VENDOR_DESCRIPTORS` presets 全量的条目数口径（与 vendors.ts 逐项核对）。
 * DEV-133：数据包不再携带 image / video 条目——图像 / 视频生成统一由执行型
 * 插件条目提供（dashscope-t2i 试点），绑内置引擎的生成条目会在安装期被拒。
 */
const EXPECTED = {
  [DASHSCOPE_ID]: {
    name: '阿里云百炼',
    entries: 13,
    byCapability: { embedding: 3, rerank: 2, multimodal: 2, tts: 5, asr: 1 },
  },
  [ARK_ID]: {
    name: '火山方舟',
    entries: 3,
    byCapability: { embedding: 1, multimodal: 2 },
  },
} as const;

describe('builtin 官方数据插件：加载与摘要（D124 P4）', () => {
  it('只读目录加载两个真实包；summary 带实例供给声明与引擎实例字段', () => {
    const rig = makeRig();
    const loaded = rig.builtin
      .list()
      .map((plugin) => plugin.id)
      .sort();
    expect(loaded).toEqual([ARK_ID, DASHSCOPE_ID].sort());
    const summaries = rig.builtin.summaries();
    for (const summary of summaries) {
      expect(summary.origin).toBe('builtin');
      expect(summary.state).toBe('installed');
      expect(summary.enabled).toBe(true);
      // 渲染层「模型」管理入口的闸门（ExtensionInstalled 按 providesInstances 判定）。
      expect(summary.providesInstances).toEqual(['capability-model']);
      const apiKey = summary.instanceFields.find((field) => field.key === 'apiKey');
      expect(apiKey).toMatchObject({ required: true, sensitive: true });
    }
  });

  it('registry.list() 含 builtin 且 isConsumable / isBuiltin 成立（manifestOf 可读清单）', async () => {
    const rig = makeRig();
    const ids = rig.registry.list().map((summary) => summary.id);
    expect(ids).toEqual(expect.arrayContaining([DASHSCOPE_ID, ARK_ID]));
    for (const id of [DASHSCOPE_ID, ARK_ID]) {
      expect(rig.registry.isBuiltin(id)).toBe(true);
      expect(rig.registry.isConsumable(id)).toBe(true);
      const manifest = await rig.registry.manifestOf(id);
      expect(manifest?.contributions.capabilityModels?.length).toBe(
        EXPECTED[id as keyof typeof EXPECTED].entries,
      );
    }
    // builtin 插件不入 `plugins` 表（D104 只读目录型机制）。
    expect(rig.store.get(DASHSCOPE_ID)).toBeNull();
    expect(rig.store.get(ARK_ID)).toBeNull();
  });
});

describe('plugins.listCapabilityEntries 投影 builtin 条目（P4 验收面）', () => {
  it('两个插件分组可见，条目数 / 能力覆盖 / engine 与描述符 presets 全量一致', async () => {
    const rig = makeRig();
    const output = await rig.bindings['plugins.listCapabilityEntries']!.handle(undefined);
    const byId = new Map(output.plugins.map((group) => [group.pluginId, group]));
    expect([...byId.keys()].sort()).toEqual([ARK_ID, DASHSCOPE_ID].sort());
    for (const [pluginId, expected] of Object.entries(EXPECTED)) {
      const group = byId.get(pluginId);
      expect(group, pluginId).toBeDefined();
      expect(group!.pluginName).toBe(expected.name);
      expect(group!.entries).toHaveLength(expected.entries);
      const counts: Record<string, number> = {};
      for (const entry of group!.entries) {
        // 数据型条目 engine 必填（安装期 PLUGIN_ENGINE_UNKNOWN 同款约束）。
        expect(entry.engine, `${pluginId}/${entry.entryId}`).toBe(
          pluginId === DASHSCOPE_ID ? 'dashscope' : 'volcengine-ark',
        );
        counts[entry.capability] = (counts[entry.capability] ?? 0) + 1;
        expect(entry.configured).toBe(false);
      }
      expect(counts).toEqual(expected.byCapability);
      // 与 `VENDOR_DESCRIPTORS` 的 presets 逐能力逐模型核对（不是只比数量）：
      // chat 不迁（对话模型走 provider 注册表），其余**有预置模型**的能力的
      // 模型集合必须完全一致。
      const vendor =
        pluginId === DASHSCOPE_ID ? VENDOR_DESCRIPTORS.dashscope : VENDOR_DESCRIPTORS.volcengine;
      for (const [capability, models] of Object.entries(vendor.presets)) {
        if (capability === 'chat' || models.length === 0) {
          expect(
            group!.entries.some((entry) => entry.capability === capability),
            `${pluginId}/${capability}`,
          ).toBe(false);
          continue;
        }
        const actual = group!.entries
          .filter((entry) => entry.capability === capability)
          .map((entry) => entry.model)
          .sort();
        expect(actual, `${pluginId}/${capability}`).toEqual([...models].sort());
      }
    }
    // 百炼条目名抽样（中文 displayName 迁移自描述符）；image / video 条目已删。
    const dashscope = byId.get(DASHSCOPE_ID)!;
    expect(dashscope.entries.find((entry) => entry.entryId === 'qwen3-tts-flash')).toMatchObject({
      capability: 'tts',
      model: 'qwen3-tts-flash',
    });
    expect(dashscope.entries.some((entry) => entry.capability === 'image')).toBe(false);
    expect(dashscope.entries.some((entry) => entry.capability === 'video')).toBe(false);
    // 方舟无 rerank / tts / asr（描述符能力矩阵为空，条目不含）；生成能力同样不含。
    const ark = byId.get(ARK_ID)!;
    expect(ark.entries.some((entry) => entry.capability === 'rerank')).toBe(false);
    expect(ark.entries.some((entry) => entry.capability === 'tts')).toBe(false);
    expect(ark.entries.some((entry) => entry.capability === 'asr')).toBe(false);
    expect(ark.entries.some((entry) => entry.capability === 'image')).toBe(false);
    expect(ark.entries.some((entry) => entry.capability === 'video')).toBe(false);
  });

  it('条目可勾选：setBotCapabilityEntries 接受 builtin ref；未知 ref 拒绝；plugin_ids 可启用 builtin 插件', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '内置条目 Bot' } }, { skipDefaultAgent: true });
    // plugin_ids 校验（start.ts 同款：builtin 视为已安装）。
    rig.bots.setPluginIds(bot.id, [DASHSCOPE_ID]);
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [{ plugin: DASHSCOPE_ID, entry: 'qwen3-tts-flash' }],
    });
    expect(rig.bots.get(bot.id)?.profile.runtime.capability_entries).toEqual([
      { plugin: DASHSCOPE_ID, entry: 'qwen3-tts-flash' },
    ]);
    await expect(
      rig.bindings['plugins.setBotCapabilityEntries']!.handle({
        botId: bot.id,
        entries: [{ plugin: DASHSCOPE_ID, entry: 'ghost' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('条目解析链：entriesFor 按 Bot 勾选返回 builtin 条目（零实例 = 无 instanceId，凭据走市场安装路径）', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '内置条目 Bot' } }, { skipDefaultAgent: true });
    rig.bots.setPluginIds(bot.id, [DASHSCOPE_ID, ARK_ID]);
    await rig.bindings['plugins.setBotCapabilityEntries']!.handle({
      botId: bot.id,
      entries: [
        { plugin: DASHSCOPE_ID, entry: 'qwen3-tts-flash' },
        { plugin: ARK_ID, entry: 'doubao-seed-2-1-pro-260915' },
      ],
    });
    // builtin 插件不能持有实例：`plugin_instances.plugin_id` 外键引用 `plugins(id)`
    // （0056/0075），D104 内置插件不入该表——实例面走市场安装路径（NOT_FOUND 干净拒绝）。
    await expect(
      rig.pluginInstances.create(DASHSCOPE_ID, { apiKey: 'sk-bailian' }, 'capability-model'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const source = createMediaEntrySource({
      registry: rig.registry,
      instances: rig.instanceStore,
      secrets: { getValue: rig.secrets.getValue },
      botRuntimeOf: (botId) => rig.bots.get(botId)?.profile.runtime ?? null,
      logger: noopLogger,
    });
    const tts = await source.entriesFor(bot.id, 'tts');
    expect(tts).toHaveLength(1);
    expect(tts[0]).toMatchObject({
      pluginId: DASHSCOPE_ID,
      entryId: 'qwen3-tts-flash',
      model: 'qwen3-tts-flash',
      engine: 'dashscope',
      instances: [],
    });
    expect(tts[0]?.instanceId).toBeUndefined();
    const multimodal = await source.entriesFor(bot.id, 'multimodal');
    expect(multimodal).toHaveLength(1);
    expect(multimodal[0]).toMatchObject({ pluginId: ARK_ID, engine: 'volcengine-ark' });
    // 未勾选的能力（asr 条目存在但不在此 Bot 的条目集）不返回。
    expect(await source.entriesFor(bot.id, 'asr')).toEqual([]);
  });

  it('plugins.testCapabilityEntry 对 builtin 条目走真实解析（零实例 → CAPABILITY_NOT_CONFIGURED 带条目定位）', async () => {
    const rig = makeRig();
    await expect(
      rig.bindings['plugins.testCapabilityEntry']!.handle({
        pluginId: DASHSCOPE_ID,
        entryId: 'qwen3-tts-flash',
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' });
    // 未知条目 → NOT_FOUND。
    await expect(
      rig.bindings['plugins.testCapabilityEntry']!.handle({
        pluginId: DASHSCOPE_ID,
        entryId: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
