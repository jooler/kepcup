import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pluginManifestSchema, type PluginRuntimeStatePayload } from '@kepcup/shared';
import { BotsService } from '../../src/domain/bots.js';
import { MediaService } from '../../src/media/service.js';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { systemClock } from '../../src/infra/clock.js';
import { createCapabilityModelMaterializer } from '../../src/plugins/materializers/capability-model.js';
import { createMediaEntrySource } from '../../src/plugins/media-entry-source.js';
import { PluginInstanceService, PluginInstanceStore, pluginSecretScope } from '../../src/plugins/instances.js';
import { CapabilityModelsProjector } from '../../src/plugins/projectors/capability-models.js';
import { PluginPackager } from '../../src/plugins/package.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginStore } from '../../src/plugins/store.js';
import { CapabilityBridge } from '../../src/plugins/runtime/bridge.js';
import { PluginHost } from '../../src/plugins/runtime/host.js';
import { PluginStorageStore } from '../../src/plugins/runtime/storage.js';
import { bindPluginsMethods } from '../../src/rpc/plugins-bindings.js';
import {
  assertRuntimeInstallable,
  runtimeDisclosureOf,
} from '../../src/plugins/runtime/install.js';

/**
 * PluginHost 真实子进程集成测试（D125 P2 步骤 5）：
 *
 * - 参考插件（plugins/reference-media）走 fork 全链路：握手 → 调用 → progress →
 *   1×1 PNG 结果；Bot 绑定条目后经 MediaService 出图（验收锚点 1）；
 * - 手写协议探针夹具（packages/core/test/fixtures/plugin-runtime/probe）覆盖：
 *   串行队列 / 调用级超时击杀 / 心跳看门狗击杀 / 崩溃重启 / 契约违规 / Provider
 *   错误透传 / Host API 白名单拒绝 / storage 往返与卸载清除；
 * - 状态迁移广播 `plugin.runtime`、调用环形历史 50 条、restart RPC 语义。
 *
 * DEV-108 构建钩子：beforeAll 先跑 `plugins/reference-media/build.mjs` 重新产出
 * dist/main.js（dist 不入库；全新 clone 上缺失时同样由这次构建补上，且保证插件
 * 侧 SDK 与当前源码同步——Host API 通道 / 心跳 ping 需要 P2 版 SDK）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const referencePluginDir = path.join(repoRoot, 'plugins', 'reference-media');
const probeFixtureDir = path.join(here, '../fixtures/plugin-runtime/probe');
const REFERENCE_ID = 'io.kepcup/reference-media';
const PROBE_ID = 'io.test/runtime-probe';

beforeAll(() => {
  // DEV-108：dist 缺失或无构建钩子 → 测试前显式构建（同时刷新 P2 版 SDK）。
  execFileSync(process.execPath, [path.join(referencePluginDir, 'build.mjs')], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}, 60_000);

const root = mkdtempSync(path.join(tmpdir(), 'plugin-host-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeLogger() {
  const logs: Array<{ level: string; obj: unknown; message: string }> = [];
  const logger = {
    debug: (obj: unknown, message: string) => logs.push({ level: 'debug', obj, message }),
    info: (obj: unknown, message: string) => logs.push({ level: 'info', obj, message }),
    warn: (obj: unknown, message: string) => logs.push({ level: 'warn', obj, message }),
    error: (obj: unknown, message: string) => logs.push({ level: 'error', obj, message }),
    child: () => logger,
  };
  return { logger, logs };
}

function makeSecrets() {
  const values = new Map<string, string>();
  return {
    hasValue: (name: string) => values.has(name),
    getValue: (name: string) => values.get(name) ?? null,
    setValue: (name: string, value: string) => void values.set(name, value),
    removeValue: (name: string) => void values.delete(name),
    names: () => [...values.keys()],
  };
}

/** 目录树哈希（与 PluginPackager 的树哈希同算法；folder 安装的 sha256 入参）。 */
function treeShaOf(dir: string): string {
  const entries: string[] = [];
  const walk = (relative: string): void => {
    const absolute = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    const info = statSync(absolute, { throwIfNoEntry: false });
    if (info === undefined) return;
    if (info.isDirectory()) {
      for (const child of readdirSync(absolute))
        walk(relative === '' ? child : `${relative}/${child}`);
      return;
    }
    entries.push(
      `${relative}\0${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`,
    );
  };
  walk('');
  return createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex');
}

/** 把源插件的指定文件复制到一个干净目录（避免 src / README / node_modules 干扰包扫描）。 */
function stageSourceDir(name: string, source: string, files: string[]): string {
  const dest = path.join(root, `src-${name}-${Math.random().toString(36).slice(2, 8)}`);
  for (const relative of files) {
    const target = path.join(dest, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(source, ...relative.split('/')), target);
  }
  return dest;
}

interface RigOptions {
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** 调用级超时覆盖（探针默认把 generateImage 调小到 300ms；参考插件 e2e 用契约默认）。 */
  callTimeoutOverride?: Record<string, number>;
  /** 空闲回收阈值（测试调小；缺省 60s）。 */
  idleStopMs?: number;
  /** 子进程环境白名单的来源（缺省 process.env；测试用于注入一个宿主侧“秘密”）。 */
  baseEnv?: NodeJS.ProcessEnv;
}

function makeRig(options: RigOptions = {}) {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const { logger, logs } = makeLogger();
  const clock = systemClock;
  const secrets = makeSecrets();
  const store = new PluginStore(db);
  const instanceStore = new PluginInstanceStore(db);
  const packager = new PluginPackager({
    pluginsDir: paths.pluginsDir,
    logger,
    appVersion: '9.9.9',
  });
  const events: Array<{ name: string; payload: unknown }> = [];
  const eventSink = {
    emit: (name: string, payload: unknown) => void events.push({ name, payload }),
  };
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
    clock,
    logger,
    events: eventSink as never,
  });
  const pluginInstances = new PluginInstanceService({
    registry,
    pluginStore: store,
    store: instanceStore,
    secrets,
    clock,
    logger,
    events: eventSink as never,
  });
  registry.attachInstanceTeardown((pluginId) => pluginInstances.deleteAllOf(pluginId));
  pluginInstances.registerMaterializer('capability-model', createCapabilityModelMaterializer());
  const bots = new BotsService(db, clock);
  bots.attachPluginDirectory({ installed: (pluginId) => store.get(pluginId) !== null });
  const storage = new PluginStorageStore({ db, clock });
  const bridge = new CapabilityBridge({
    registry,
    instances: instanceStore,
    secrets: { getValue: secrets.getValue, names: secrets.names },
    storage,
    logger,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
  });
  const host = new PluginHost({
    registry,
    bridge,
    events: eventSink as never,
    logger,
    timings: {
      heartbeatIntervalMs: 60,
      heartbeatMisses: 2,
      idleStopMs: options.idleStopMs ?? 60_000,
      startTimeoutMs: 5_000,
      killGraceMs: 100,
      outputLinesPerMinute: 20,
      // 调用级超时注入调小（61 §3.1 media 默认 image/tts 120s / asr 300s / video 900s）。
      callTimeoutOverride: options.callTimeoutOverride ?? { 'media.generateImage': 300 },
    },
    ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
  });
  registry.attachRuntimeStop((pluginId) => host.dispose(pluginId));
  registry.attachRuntimeTeardown((pluginId) => {
    host.dispose(pluginId);
    bridge.clearStorage(pluginId);
  });
  const settings = {
    get: () => ({
      appLanguage: 'zh-CN',
      modelProviders: [],
      capabilityModels: {
        embedding: null,
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
        image: null,
        video: null,
      },
    }),
  };
  const media = new MediaService({
    settings: settings as never,
    secrets: { getValue: secrets.getValue } as never,
    logger: logger as never,
  });
  media.attachEntrySource(
    createMediaEntrySource({
      registry,
      instances: instanceStore,
      secrets: { getValue: secrets.getValue },
      botRuntimeOf: (botId) => bots.get(botId)?.profile.runtime ?? null,
      logger: logger as never,
      hostedAdapterOf: (pluginId) => host.adapterFor(pluginId),
    }),
  );

  const installSource = async (dir: string): Promise<void> => {
    await registry.install({
      source: { kind: 'folder', path: dir },
      sha256: treeShaOf(dir),
      userConfig: {},
      via: 'folder',
    });
  };

  return {
    home,
    db,
    registry,
    store,
    instanceStore,
    pluginInstances,
    bots,
    storage,
    bridge,
    host,
    media,
    secrets,
    events,
    logs,
    installSource,
  };
}

type Rig = ReturnType<typeof makeRig>;

const RUNTIME_EVENTS = (rig: Rig): PluginRuntimeStatePayload[] =>
  rig.events
    .filter((event) => event.name === 'plugin.runtime')
    .map((event) => event.payload as PluginRuntimeStatePayload);

/** 参考插件的干净安装源（dist 由 beforeAll 构建）。 */
function referenceSource(): string {
  return stageSourceDir('reference', referencePluginDir, [
    'plugin.json',
    'package.json',
    'icon.svg',
    'dist/main.js',
  ]);
}

function probeSource(): string {
  return stageSourceDir('probe', probeFixtureDir, ['plugin.json', 'main.mjs']);
}

/** 安装探针 + 建一个实例（探针无凭据字段），返回插件 id 对应的 rig。 */
async function withProbe(options: RigOptions = {}) {
  const rig = makeRig(options);
  await rig.installSource(probeSource());
  const instance = await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
  return { rig, instanceId: instance.id };
}

const PROBE_ENTRY_ID = 'probe-image';

async function callProbe(
  rig: Rig,
  instanceId: string,
  model: string,
  extra: {
    params?: Record<string, unknown>;
    onProgress?: (payload: unknown) => void;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  return rig.host.call(
    PROBE_ID,
    'media',
    'generateImage',
    { prompt: '探针' },
    {
      entryId: PROBE_ENTRY_ID,
      model,
      instanceId,
      ...(extra.params !== undefined ? { params: extra.params } : {}),
      ...(extra.onProgress !== undefined ? { onProgress: extra.onProgress } : {}),
      ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
    },
  );
}

describe('PluginHost 真实子进程（D125 P2）', () => {
  it('参考插件端到端：Bot 绑定条目 → media.generateImage 走子进程出 1×1 PNG；假视频任务轮询成功', async () => {
    // 参考插件的假实现耗时 2.2s（两次 1.1s 延迟）：这里用契约默认超时。
    const rig = makeRig({ callTimeoutOverride: {} });
    await rig.installSource(referenceSource());
    const instance = await rig.pluginInstances.create(REFERENCE_ID, {}, 'capability-model');
    const bot = rig.bots.create({ identity: { name: '参考插件 Bot' } }, { skipDefaultAgent: true });
    rig.bots.setPluginIds(bot.id, [REFERENCE_ID]);
    rig.bots.setCapabilityEntries(bot.id, [
      { plugin: REFERENCE_ID, entry: 'reference-image' },
      { plugin: REFERENCE_ID, entry: 'reference-video' },
    ]);

    const image = await rig.media.generateImage(
      { prompt: '画一张测试图' },
      { loopType: 'task', botId: bot.id },
      { botId: bot.id },
    );
    expect(image.images).toHaveLength(1);
    expect(image.images[0]?.mimeType).toBe('image/png');
    expect(image.images[0]?.url?.startsWith('data:image/png;base64,')).toBe(true);

    // 进度事件：插件给出 queued → generating 两个阶段，宿主限速后透传进 run 进度通道。
    const phases: string[] = [];
    await rig.host.call(
      REFERENCE_ID,
      'media',
      'generateImage',
      { prompt: '进度测试' },
      {
        entryId: 'reference-image',
        model: 'reference-image-1',
        instanceId: instance.id,
        onProgress: (payload) => phases.push(payload.phase ?? ''),
      },
    );
    expect(phases).toEqual(['queued', 'generating']);

    // 状态迁移广播（starting → ready → busy → ready）。
    const statuses = RUNTIME_EVENTS(rig)
      .filter((event) => event.pluginId === REFERENCE_ID)
      .map((event) => event.status);
    expect(statuses).toContain('starting');
    expect(statuses).toContain('ready');
    expect(statuses).toContain('busy');

    // 调用历史：成功 + 方法 / 时长。
    const state = rig.host.statusOf(REFERENCE_ID);
    expect(state.recent[0]).toMatchObject({
      contract: 'media',
      method: 'generateImage',
      ok: true,
    });
    expect(state.recent[0]?.durationMs).toBeGreaterThan(1000); // 参考插件两次 1.1s 延迟
    expect(rig.host.statusOf(REFERENCE_ID).status).toBe('ready');

    // 视频异步三方法：generateVideo → 3 秒后 succeeded。
    const handle = await rig.media.generateVideo(
      { prompt: '夜景延时' },
      { loopType: 'task', botId: bot.id },
      { botId: bot.id },
    );
    expect(handle.provider).toBe(instance.id);
    const running = await rig.media.videoStatus(handle.provider, handle.taskId);
    expect(running.status).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const done = await rig.media.videoStatus(handle.provider, handle.taskId);
    expect(done.status).toBe('succeeded');
    expect(done.videoUrl).toContain('example.invalid');
    rig.host.disposeAll();
  }, 30_000);

  it('progress / log 事件：限速透传给 run 进度回调，log 进 core logger', async () => {
    const { rig, instanceId } = await withProbe();
    const phases: string[] = [];
    const result = (await callProbe(rig, instanceId, 'ok', {
      onProgress: (payload) => phases.push((payload as { phase: string }).phase),
    })) as { images: Array<{ url: string }> };
    expect(result.images[0]?.url.startsWith('data:image/png')).toBe(true);
    expect(phases).toEqual(['queued']);
    expect(
      rig.logs.some(
        (entry) =>
          entry.message.includes('探针日志') || JSON.stringify(entry.obj).includes('探针日志'),
      ),
    ).toBe(true);
    rig.host.disposeAll();
  });

  it('进程边界：env 白名单不透传宿主秘密；cwd = 安装目录；execArgv 为空', async () => {
    const { rig, instanceId } = await withProbe({
      baseEnv: { ...process.env, PLUGIN_TEST_SECRET: 'top-secret' },
    });
    const result = (await callProbe(rig, instanceId, 'env')) as {
      images: Array<{ mimeType: string }>;
    };
    const mime = result.images[0]!.mimeType;
    const parts = mime.split('+');
    expect(parts[0]).toBe('image/png');
    expect(parts[1]).toBe('no-secret');
    const reportedCwd = parts.slice(2, -1).join('+');
    const installDir = await rig.registry.runtimeDirOf(PROBE_ID);
    expect(installDir).not.toBeNull();
    expect(realpathSync(reportedCwd)).toBe(realpathSync(installDir!));
    expect(parts.at(-1)).toBe('0');
    rig.host.disposeAll();
  });

  it('stderr 收集：插件输出进 core logger（插件前缀），不混入调用结果', async () => {
    const { rig, instanceId } = await withProbe();
    await callProbe(rig, instanceId, 'stderr');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const entry = rig.logs.find((log) => log.message.includes('探针 stderr 输出'));
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({ plugin: PROBE_ID });
    rig.host.disposeAll();
  });

  it('credentials 注入：invoke.context 只带该实例的 sensitive 字段（host-api 不泄露）', async () => {
    const { rig, instanceId } = await withProbe();
    rig.secrets.setValue(`${pluginSecretScope(PROBE_ID)}:instance:${instanceId}:apiKey`, 'sk-probe');
    const result = (await callProbe(rig, instanceId, 'creds')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(result.images[0]?.mimeType).toBe('image/png+apiKey+sk-probe');
    rig.host.disposeAll();
  });

  it('host.secrets.get：本插件明文键可读（翻译到存储名）；越权键被拒', async () => {
    const { rig, instanceId } = await withProbe();
    rig.secrets.setValue(`${pluginSecretScope(PROBE_ID)}:instance:${instanceId}:apiKey`, 'sk-own');
    const own = (await callProbe(rig, instanceId, 'secret', {
      params: { key: `plugin:${PROBE_ID}:instance:${instanceId}:apiKey` },
    })) as { images: Array<{ mimeType: string }> };
    expect(own.images[0]?.mimeType).toBe('image/png+ok+sk-own');

    rig.secrets.setValue('plugin:io_dtest_sother:instance:pli_x:apiKey', 'sk-foreign');
    await expect(
      callProbe(rig, instanceId, 'secret', {
        params: { key: 'plugin:io_dtest_sother:instance:pli_x:apiKey' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(rig.secrets.getValue('plugin:io_dtest_sother:instance:pli_x:apiKey')).toBe('sk-foreign');
    rig.host.disposeAll();
  });

  it('空闲回收：idle 到点优雅停（stopped），下一次调用自动重新拉起', async () => {
    const { rig, instanceId } = await withProbe({ idleStopMs: 80 });
    await callProbe(rig, instanceId, 'ok');
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rig.host.statusOf(PROBE_ID).status).toBe('stopped');
    const after = (await callProbe(rig, instanceId, 'ok')) as { images: unknown[] };
    expect(after.images).toHaveLength(1);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    rig.host.disposeAll();
  });

  it('kill switch：停用后排队中的调用不得重新拉起进程（排队调用被拒）', async () => {
    const { rig, instanceId } = await withProbe({
      callTimeoutOverride: { 'media.generateImage': 5_000 },
    });
    const first = callProbe(rig, instanceId, 'hang');
    // 先挂上拒绝断言（避免 kill switch 在断言前拒绝造成 unhandled rejection）。
    const firstRejected = expect(first).rejects.toBeDefined();
    // 等第一次调用真的进入 busy（进程已握手 + invoke 已发出），再排队第二次。
    for (let i = 0; i < 200 && rig.host.statusOf(PROBE_ID).status !== 'busy'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(rig.host.statusOf(PROBE_ID).status).toBe('busy');
    const queued = callProbe(rig, instanceId, 'ok');
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await rig.registry.setEnabled(PROBE_ID, false);
    await firstRejected;
    await queuedRejected;
    expect(rig.host.statusOf(PROBE_ID).status).toBe('stopped');
    await expect(rig.host.restart(PROBE_ID)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    rig.host.disposeAll();
  });

  it('AbortSignal：abort → cancel 帧；已 abort 的调用不启动进程', async () => {
    const { rig, instanceId } = await withProbe();
    const controller = new AbortController();
    const pending = callProbe(rig, instanceId, 'abortable', { signal: controller.signal });
    for (let i = 0; i < 200 && rig.host.statusOf(PROBE_ID).status !== 'busy'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(rig.host.statusOf(PROBE_ID).status).toBe('busy');
    controller.abort();
    const result = (await pending) as { images: Array<{ mimeType: string }> };
    expect(result.images[0]?.mimeType).toBe('image/png+aborted');
    rig.host.disposeAll();

    // 已 abort 的 signal：直接拒绝，不创建进程。
    const preRig = makeRig();
    await preRig.installSource(probeSource());
    const preInstance = await preRig.pluginInstances.create(
      PROBE_ID,
      {},
      'capability-model',
    );
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      callProbe(preRig, preInstance.id, 'ok', { signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(preRig.host.statusOf(PROBE_ID).status).toBe('stopped');
    preRig.host.disposeAll();
  });

  it('串行队列：并发调用被排队（探针会拒绝并发 invoke，三次并行全部成功）', async () => {
    const { rig, instanceId } = await withProbe();
    const results = await Promise.all([
      callProbe(rig, instanceId, 'slow'),
      callProbe(rig, instanceId, 'slow'),
      callProbe(rig, instanceId, 'slow'),
    ]);
    expect(results).toHaveLength(3);
    expect(rig.host.statusOf(PROBE_ID).recent.filter((record) => record.ok)).toHaveLength(3);
    rig.host.disposeAll();
  });

  it('调用级超时：hang 插件被击杀 → PLUGIN_TIMEOUT；下次调用自动重启进程', async () => {
    const { rig, instanceId } = await withProbe();
    await expect(callProbe(rig, instanceId, 'hang')).rejects.toMatchObject({
      code: 'PLUGIN_TIMEOUT',
    });
    expect(rig.host.statusOf(PROBE_ID).status).toBe('error');
    expect(rig.host.statusOf(PROBE_ID).lastError).toContain('无响应');
    // 崩溃 / 击杀后下一次调用自动重启（61 §3.1）。
    const after = await callProbe(rig, instanceId, 'ok');
    expect((after as { images: unknown[] }).images).toHaveLength(1);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    rig.host.disposeAll();
  });

  it('心跳看门狗：同步死循环（submitVideo，900s 契约超时）被 2 次心跳无响应击杀', async () => {
    const { rig, instanceId } = await withProbe();
    await expect(
      rig.host.call(
        PROBE_ID,
        'media',
        'submitVideo',
        { prompt: 'spin' },
        {
          entryId: 'probe-video',
          model: 'spin',
          instanceId,
        },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
    expect(rig.host.statusOf(PROBE_ID).status).toBe('error');
    expect(rig.host.statusOf(PROBE_ID).detail).toContain('心跳');
    rig.host.disposeAll();
  });

  it('崩溃重启：crash → PLUGIN_CRASHED（进程退出），下一次调用起新进程成功', async () => {
    const { rig, instanceId } = await withProbe();
    await expect(callProbe(rig, instanceId, 'crash')).rejects.toMatchObject({
      code: 'PLUGIN_CRASHED',
    });
    expect(rig.host.statusOf(PROBE_ID).status).toBe('error');
    const after = await callProbe(rig, instanceId, 'ok');
    expect((after as { images: unknown[] }).images).toHaveLength(1);
    rig.host.disposeAll();
  });

  it('合同违规：非法 output → PLUGIN_CONTRACT_VIOLATION，不部分投递', async () => {
    const { rig, instanceId } = await withProbe();
    await expect(callProbe(rig, instanceId, 'bad-output')).rejects.toMatchObject({
      code: 'PLUGIN_CONTRACT_VIOLATION',
    });
    const record = rig.host.statusOf(PROBE_ID).recent[0];
    expect(record).toMatchObject({ ok: false, errorCode: 'PLUGIN_CONTRACT_VIOLATION' });
    rig.host.disposeAll();
  });

  it('托管适配器错误映射：PROVIDER_AUTH_FAILED / PROVIDER_QUOTA 透传；PLUGIN_CRASHED → PROVIDER_UNAVAILABLE', async () => {
    const { rig, instanceId } = await withProbe();
    const adapter = rig.host.adapterFor(PROBE_ID);
    const ctx = {
      vendor: 'custom' as const,
      baseUrl: '',
      apiKey: '',
      logger: rig.logs as never,
      entryRef: { pluginId: PROBE_ID, entryId: 'probe-image' },
      instanceId,
    };
    await expect(adapter.generateImage(ctx, 'error-auth', { prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
    await expect(adapter.generateImage(ctx, 'error-quota', { prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA',
    });
    await expect(adapter.generateImage(ctx, 'crash', { prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { pluginId: PROBE_ID, code: 'PLUGIN_CRASHED' },
    });
    // 看门狗击杀（调用超时）→ 工具收到人话的 PROVIDER_UNAVAILABLE。
    await expect(adapter.generateImage(ctx, 'hang', { prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { pluginId: PROBE_ID, code: 'PLUGIN_TIMEOUT' },
    });
    rig.host.disposeAll();
  });

  it('Host API 白名单：白名单外域名 → PLUGIN_NETWORK_DENIED；SSRF 私网地址被拒', async () => {
    // 拒绝路径不需要网络：未命中白名单在 DNS 之前拦截。
    const { rig, instanceId } = await withProbe();
    await expect(
      callProbe(rig, instanceId, 'net', { params: { url: 'https://blocked.invalid/x' } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_NETWORK_DENIED' });
    // 拒绝进调用历史（插件卡活动可见 PLUGIN_NETWORK_DENIED）。
    expect(rig.host.statusOf(PROBE_ID).recent[0]).toMatchObject({
      ok: false,
      errorCode: 'PLUGIN_NETWORK_DENIED',
    });
    rig.host.disposeAll();

    // 命中白名单但解析到私网：SSRF 守卫拒绝（复用 web_fetch 的 assertNoPrivateAddress）。
    const privateRig = (
      await withProbe({
        lookup: async () => [{ address: '10.0.0.8' }],
        fetchImpl: (async () => new Response('should-not-fetch')) as unknown as typeof fetch,
      })
    ).rig;
    await expect(
      callProbe(privateRig, privateRig.pluginInstances.list(PROBE_ID)[0]!.id, 'net', {
        params: { url: 'https://example.invalid/private' },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_NETWORK_DENIED' });
    privateRig.host.disposeAll();
  });

  it('Host API 白名单命中：公网地址 + 注入 fetch → 调用成功', async () => {
    let fetched = '';
    const { rig, instanceId } = await withProbe({
      lookup: async () => [{ address: '93.184.216.34' }],
      fetchImpl: (async (url: string) => {
        fetched = String(url);
        return new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }) as unknown as typeof fetch,
    });
    const result = (await callProbe(rig, instanceId, 'net', {
      params: { url: 'https://example.invalid/ok' },
    })) as { images: unknown[] };
    expect(result.images).toHaveLength(1);
    expect(fetched).toBe('https://example.invalid/ok');
    expect(rig.bridge.auditSnapshot()[PROBE_ID]).toEqual({ 'example.invalid': 1 });
    rig.host.disposeAll();
  });

  it('Host API storage：set/get/list/delete 往返；卸载清空 plugin_storage', async () => {
    const { rig, instanceId } = await withProbe();
    const result = (await callProbe(rig, instanceId, 'storage')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(result.images[0]?.mimeType).toBe('image/png+world+1');
    // 探针删除过自己的键，但桥的写入是真实的：直接再写一条，卸载后应清空。
    rig.bridge.storageSet(PROBE_ID, 'leftover', { kept: true });
    expect(rig.storage.list(PROBE_ID)).toEqual(['leftover']);
    await rig.registry.uninstall(PROBE_ID);
    expect(rig.storage.list(PROBE_ID)).toEqual([]);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('stopped');
    rig.host.disposeAll();
  });

  it('调用历史环形缓冲：55 次调用只保留最近 50 条（最新在前）', async () => {
    const { rig, instanceId } = await withProbe();
    for (let i = 0; i < 55; i += 1) {
      await callProbe(rig, instanceId, 'ok');
    }
    const state = rig.host.statusOf(PROBE_ID);
    expect(state.recent).toHaveLength(50);
    expect(state.recent[0]?.ok).toBe(true);
    expect(state.recent[0]?.at).toBeGreaterThan(state.recent[49]?.at ?? 0);
    rig.host.disposeAll();
  }, 20_000);

  it('plugins.runtime.restart：进程被终止并重新拉起（ready）', async () => {
    const { rig, instanceId } = await withProbe();
    await callProbe(rig, instanceId, 'ok');
    await rig.host.restart(PROBE_ID);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    const after = await callProbe(rig, instanceId, 'ok');
    expect((after as { images: unknown[] }).images).toHaveLength(1);
    rig.host.disposeAll();
  });

  it('plugins.runtime.list：全部已装执行型插件的状态机行；非执行型插件不出现', async () => {
    const { rig, instanceId } = await withProbe();
    await callProbe(rig, instanceId, 'ok');
    const rows = await rig.host.list();
    expect(rows.map((row) => row.pluginId)).toEqual([PROBE_ID]);
    expect(rows[0]).toMatchObject({ status: 'ready' });
    expect(rows[0]?.recent.length).toBeGreaterThan(0);
    rig.host.disposeAll();
  });

  it('执行型条目 RPC：listCapabilityEntries（source plugin / configured 看实例）+ testCapabilityEntry 走托管 invoke', async () => {
    const { rig, instanceId } = await withProbe();
    const bindings = bindPluginsMethods({
      plugins: rig.registry,
      pluginInstances: rig.pluginInstances,
      media: rig.media,
      pluginRuntime: rig.host,
    } as never);
    const listed = (await bindings['plugins.listCapabilityEntries']!.handle(undefined)) as {
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
    const group = listed.plugins.find((row) => row.pluginId === PROBE_ID);
    expect(group).toBeDefined();
    expect(group?.entries[0]).toMatchObject({
      entryId: 'probe-image',
      engine: null,
      source: 'plugin',
      configured: true,
    });
    // 条目级探测经 HostedAdapter 的同一 invoke 路径（探针 model=ok 返回 1×1 PNG）。
    await expect(
      bindings['plugins.testCapabilityEntry']!.handle({
        pluginId: PROBE_ID,
        entryId: 'probe-image',
        instanceId,
      }),
    ).resolves.toEqual({ ok: true });
    rig.host.disposeAll();
  });

  it('RPC 绑定：plugins.runtime.list / restart 委托宿主；未装配 → NOT_IMPLEMENTED', async () => {
    const { rig, instanceId } = await withProbe();
    await callProbe(rig, instanceId, 'ok');
    const bindings = bindPluginsMethods({ pluginRuntime: rig.host } as never);
    const listed = (await bindings['plugins.runtime.list']!.handle(undefined)) as {
      plugins: Array<{ pluginId: string; status: string; recent: unknown[] }>;
    };
    expect(listed.plugins[0]?.pluginId).toBe(PROBE_ID);
    expect(listed.plugins[0]?.status).toBe('ready');
    expect(listed.plugins[0]?.recent.length).toBeGreaterThan(0);
    await expect(
      bindings['plugins.runtime.restart']!.handle({ pluginId: PROBE_ID }),
    ).resolves.toEqual({ ok: true });
    const empty = bindPluginsMethods({ pluginRuntime: null } as never);
    await expect(empty['plugins.runtime.list']!.handle(undefined)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
    rig.host.disposeAll();
  });

  it('停用即时生效：setEnabled(false) 杀掉进程（kill switch）', async () => {
    const { rig, instanceId } = await withProbe();
    await callProbe(rig, instanceId, 'ok');
    await rig.registry.setEnabled(PROBE_ID, false);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('stopped');
    await expect(callProbe(rig, instanceId, 'ok')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    rig.host.disposeAll();
  });
});

describe('执行型插件安装管线（D125 步骤 4：层级 / entry / 包防护 / hostApi）', () => {
  /** 由探针清单派生一个变体（建到干净目录，manifest 可改 runtime 段）。 */
  function variantDir(
    name: string,
    runtimePatch: Record<string, unknown> | null,
    extraFiles: Array<{ relative: string; text: string; exec?: boolean }> = [],
  ): string {
    const dir = path.join(root, `variant-${name}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const manifest = JSON.parse(
      readFileSync(path.join(probeFixtureDir, 'plugin.json'), 'utf8'),
    ) as Record<string, unknown> & { runtime?: Record<string, unknown> };
    if (runtimePatch !== null && manifest.runtime !== undefined) {
      manifest.runtime = { ...manifest.runtime, ...runtimePatch };
    }
    writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    copyFileSync(path.join(probeFixtureDir, 'main.mjs'), path.join(dir, 'main.mjs'));
    for (const file of extraFiles) {
      const target = path.join(dir, ...file.relative.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.text);
      if (file.exec === true) chmodSync(target, 0o755);
    }
    return dir;
  }

  it('hostApi 与当前 Host API 不匹配 → 拒装（PLUGIN_UPGRADE_REQUIRED）；语法非法 → PLUGIN_INVALID', async () => {
    const rig = makeRig();
    const mismatch = variantDir('hostapi-range', { hostApi: '^2' });
    await expect(rig.installSource(mismatch)).rejects.toMatchObject({
      code: 'PLUGIN_UPGRADE_REQUIRED',
    });
    expect(rig.store.get(PROBE_ID)).toBeNull();
    const invalid = variantDir('hostapi-invalid', { hostApi: 'banana' });
    await expect(rig.installSource(invalid)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('包内含 .node / 可执行位文件 → 拒装（PLUGIN_INVALID）', async () => {
    const rig = makeRig();
    const native = variantDir('native', null, [{ relative: 'lib/evil.node', text: 'x' }]);
    await expect(rig.installSource(native)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    const executable = variantDir('exec', null, [
      { relative: 'tools/run.sh', text: '#!/bin/sh\n', exec: true },
    ]);
    await expect(rig.installSource(executable)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    expect(rig.store.get(PROBE_ID)).toBeNull();
  });

  it('runtime.entry 指向包外 / 不存在 → 拒装（PLUGIN_INVALID）', async () => {
    const rig = makeRig();
    const missing = variantDir('missing-entry', { entry: 'dist/missing.mjs' });
    await expect(rig.installSource(missing)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    const escape = variantDir('escape-entry', { entry: '../../../etc/passwd' });
    // schema 层即拒绝（isSafePluginRelPath）→ 包阶段 PLUGIN_INVALID。
    await expect(rig.installSource(escape)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it.skipIf(process.platform === 'win32')(
    'runtime.entry 是符号链接（指向包外）→ 拒装（PLUGIN_INVALID）',
    async () => {
      const dir = variantDir('symlink-entry', null);
      rmSync(path.join(dir, 'main.mjs'));
      symlinkSync('../../../etc/passwd', path.join(dir, 'main.mjs'));
      const manifest = pluginManifestSchema.parse(
        JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')),
      );
      await expect(
        assertRuntimeInstallable(manifest, { dir, tier: 'developer' }),
      ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
      // 包内其它位置的符号链接同样触发包防护。
      const other = variantDir('symlink-other', null);
      symlinkSync('/etc/hosts', path.join(other, 'linked.txt'));
      const otherManifest = pluginManifestSchema.parse(
        JSON.parse(readFileSync(path.join(other, 'plugin.json'), 'utf8')),
      );
      await expect(
        assertRuntimeInstallable(otherManifest, { dir: other, tier: 'developer' }),
      ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    },
  );

  it('community 层级含 runtime → 拒装（PLUGIN_INCOMPATIBLE）', async () => {
    const dir = variantDir('community', null);
    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')),
    );
    await expect(
      assertRuntimeInstallable(manifest, { dir, tier: 'community' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INCOMPATIBLE' });
    // verified / developer 放行（同一份包）。
    await expect(
      assertRuntimeInstallable(manifest, { dir, tier: 'verified' }),
    ).resolves.toBeUndefined();
  });

  it('有 runtime 但没有任何执行型条目 → 拒装（PLUGIN_INVALID）', async () => {
    const dir = variantDir('no-hosted-entry', null);
    const raw = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as {
      contributions: { capabilityModels: Array<Record<string, unknown>> };
    };
    raw.contributions.capabilityModels = [
      { id: 'img', capability: 'image', model: 'm', engine: 'dashscope' },
    ];
    writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(raw, null, 2));
    const manifest = pluginManifestSchema.parse(raw);
    await expect(
      assertRuntimeInstallable(manifest, { dir, tier: 'developer' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('执行型条目只声明 embedding / rerank（v1 契约不开放）→ 拒装（PLUGIN_INVALID）', async () => {
    const dir = variantDir('embedding-only', null);
    const raw = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as {
      contributions: { capabilityModels: Array<Record<string, unknown>> };
    };
    raw.contributions.capabilityModels = [
      { id: 'vec', capability: 'embedding', model: 'm' },
      { id: 'rank', capability: 'rerank', model: 'm' },
    ];
    writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(raw, null, 2));
    const manifest = pluginManifestSchema.parse(raw);
    await expect(
      assertRuntimeInstallable(manifest, { dir, tier: 'developer' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('同意卡披露：registry.inspect 的 payload 带 runtime 披露（不含凭据值）', async () => {
    const rig = makeRig();
    const info = await rig.registry.inspect({ kind: 'folder', path: probeSource() });
    expect(info.runtime).toEqual({
      hostApi: '^1',
      networkDomains: ['example.invalid'],
      credentialFields: [],
      storageQuotaBytes: 10 * 1024 * 1024,
    });
    expect(info.installable).toBe(true);
  });

  it('同意卡披露：network / storage 配额 / hostApi；检视阻断列表同源', async () => {
    const dir = variantDir('disclosure', null);
    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')),
    );
    const disclosure = await runtimeDisclosureOf(manifest, { dir, tier: 'developer' });
    expect(disclosure.blockers).toEqual([]);
    expect(disclosure.runtime).toEqual({
      hostApi: '^1',
      networkDomains: ['example.invalid'],
      credentialFields: [],
      storageQuotaBytes: 10 * 1024 * 1024,
    });
    const blocked = await runtimeDisclosureOf(manifest, { dir, tier: 'community' });
    expect(blocked.blockers.join(' ')).toContain('社区');
  });
});
