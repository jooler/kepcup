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
import {
  PluginInstanceService,
  PluginInstanceStore,
  pluginInstanceSecretName,
  pluginSecretScope,
} from '../../src/plugins/instances.js';
import { CapabilityModelsProjector } from '../../src/plugins/projectors/capability-models.js';
import { PluginPackager } from '../../src/plugins/package.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginStore } from '../../src/plugins/store.js';
import { CapabilityBridge } from '../../src/plugins/runtime/bridge.js';
import { minimalPluginEnv, PluginHost } from '../../src/plugins/runtime/host.js';
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
const pilotPluginDir = path.join(repoRoot, 'plugins', 'dashscope-t2i');
const probeFixtureDir = path.join(here, '../fixtures/plugin-runtime/probe');
const REFERENCE_ID = 'io.kepcup/reference-media';
const PILOT_ID = 'io.kepcup/dashscope-t2i';
const PILOT_ENTRY_ID = 'qwen-image-3';
/**
 * 试点条目 `qwen-image-3` 的 model：必须是 qwen-image 系列。试点走**异步**
 * `image-generation/generation` + 轮询（DEV-130）；内置引擎侧是同步
 * `multimodal-generation`（A/B 对照时分别断言端点）。
 */
const PILOT_MODEL = 'qwen-image-3.0';
const PROBE_ID = 'io.test/runtime-probe';

beforeAll(() => {
  // DEV-108：dist 缺失或无构建钩子 → 测试前显式构建（同时刷新 P2 版 SDK）。
  for (const dir of [referencePluginDir, pilotPluginDir]) {
    execFileSync(process.execPath, [path.join(dir, 'build.mjs')], {
      cwd: repoRoot,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  }
}, 120_000);

const root = mkdtempSync(path.join(tmpdir(), 'plugin-host-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('minimalPluginEnv（fork 子进程的最小 env 白名单）', () => {
  it('只透传白名单键，宿主的其它环境变量（含密钥类）不进入插件进程', () => {
    const env = minimalPluginEnv(
      {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        HOME: '/secret/home',
        KEPCUP_PLUGIN_SIGNING_KEY: 'leak',
        ELECTRON_RUN_AS_NODE: '0',
      } as NodeJS.ProcessEnv,
      false,
    );
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
  });

  it('Electron 宿主追加 ELECTRON_RUN_AS_NODE=1（fork 按 Node 执行入口脚本）', () => {
    // 纯 Node 宿主：不添加（headless server 行为不变）。
    expect(minimalPluginEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, false)).toEqual({
      PATH: '/usr/bin',
    });
    // Electron（desktop utilityProcess）：execPath 指向 Electron 二进制，显式声明
    // run-as-node 保证入口脚本按 Node 执行（跨平台 / 版本行为一致）。
    expect(
      minimalPluginEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, true)['ELECTRON_RUN_AS_NODE'],
    ).toBe('1');
  });
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
  /** RSS warn 阈值（测试调小触发观测日志；缺省 512MB）。 */
  rssWarnBytes?: number;
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
    pluginDataDir: paths.pluginDataDir,
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
    pluginDataDir: paths.pluginDataDir,
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
    ...(options.rssWarnBytes !== undefined ? { rssWarnBytes: options.rssWarnBytes } : {}),
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

/** 同一探针夹具的旧 SDK 形态：ready 帧不带 features（宿主不得发送 instanceId）。 */
function legacyProbeSource(): string {
  const dir = stageSourceDir('probe-legacy', probeFixtureDir, ['plugin.json', 'main.mjs']);
  const main = path.join(dir, 'main.mjs');
  writeFileSync(
    main,
    readFileSync(main, 'utf8').replace(
      "const LEGACY_SDK = import.meta.url.includes('probe-legacy');",
      'const LEGACY_SDK = true;',
    ),
  );
  return dir;
}

/** 百炼文生图执行型试点（dist 由 beforeAll 构建）。 */
function pilotSource(): string {
  return stageSourceDir('dashscope-t2i', pilotPluginDir, [
    'plugin.json',
    'package.json',
    'icon.svg',
    'dist/main.js',
  ]);
}

/**
 * 扩权 diff 夹具（D125 P4）：在探针实例字段版本上改写 `runtime.network.allow` 与
 * `instanceFields`，用于「更新能力清单扩大 → 重新同意」。
 */
function runtimeSourceWithCapabilities(options: {
  networkAllow: string[];
  extraFields?: Array<Record<string, unknown>>;
  version?: string;
}): string {
  const dir = probeSourceWithInstanceFields();
  const manifestPath = path.join(dir, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string;
    runtime: { network: { allow: string[] }; instanceFields: Array<Record<string, unknown>> };
  };
  manifest.version = options.version ?? manifest.version;
  manifest.runtime.network = { allow: options.networkAllow };
  manifest.runtime.instanceFields = [
    ...manifest.runtime.instanceFields,
    ...(options.extraFields ?? []),
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * DEV-114 方案 1 夹具：给探针清单加 `runtime.instanceFields`（apiKey 敏感必填 +
 * region 非敏感默认值），验证「声明 → 实例表单 → secrets → credentials 注入」。
 */
function probeSourceWithInstanceFields(): string {
  const dir = probeSource();
  const manifestPath = path.join(dir, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    runtime: Record<string, unknown>;
  };
  manifest.runtime.instanceFields = [
    { key: 'apiKey', type: 'string', title: 'API Key', required: true, sensitive: true },
    { key: 'region', type: 'string', title: 'Region', default: 'cn-beijing' },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * 探针变体：清单声明方法级调用超时（`runtime.timeouts`）。
 * 用于验证「超时由插件声明，宿主只钳制上限」——声明的 1.5s 生效而不是契约的 120s。
 */
function probeSourceWithDeclaredTimeout(timeoutMs: number): string {
  const dir = probeSource();
  const manifestPath = path.join(dir, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    runtime: Record<string, unknown>;
  };
  manifest.runtime.timeouts = { 'media.generateImage': timeoutMs };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/** 数据型插件（无 runtime 段）：`plugins.runtime.list` 必须忽略它（P3 验收 4）。 */
function dataPluginSource(): string {
  const dir = path.join(root, `data-plugin-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        format_version: 1,
        id: 'io.test/data-only',
        name: '数据型插件（测试夹具）',
        version: '1.0.0',
        description: '不含 runtime 段的能力条目包：运行时列表不得出现它的行。',
        usage: '测试专用：与执行型探针同装，断言 plugins.runtime.list 只含执行型插件。',
        instances: ['capability-model'],
        contributions: {
          capabilityModels: [
            {
              // DEV-133：image 引擎条目安装期被拒；夹具改用引擎仍支持的 multimodal。
              id: 'data-image',
              capability: 'multimodal',
              model: 'data-multimodal-model',
              engine: 'dashscope',
              displayName: '数据型看图',
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  return dir;
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
    const bot = rig.bots.create({ identity: { name: '参考插件 Bot' } });
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

  it('百炼 Qwen-Image 执行型试点：MediaService 条目解析 → 子进程异步提交/轮询 → 产物 URL + 进度阶段（D125 P4）', async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string;
      asyncHeader: string;
      body: Record<string, unknown>;
    }> = [];
    let polls = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers['Authorization'] ?? '',
        asyncHeader: headers['X-DashScope-Async'] ?? '',
        body,
      });
      if (url.endsWith('/api/v1/services/aigc/image-generation/generation')) {
        // qwen-image 异步提交：秒级返回 task_id（不是等出图）。
        expect(headers['X-DashScope-Async']).toBe('enable');
        return new Response(JSON.stringify({ output: { task_id: 'task-pilot-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // 轮询：PENDING → RUNNING → SUCCEEDED；成功取 choices[].message.content[].image。
      polls += 1;
      const status = polls === 1 ? 'PENDING' : polls === 2 ? 'RUNNING' : 'SUCCEEDED';
      return new Response(
        JSON.stringify({
          output: {
            task_status: status,
            ...(status === 'SUCCEEDED'
              ? {
                  choices: [
                    {
                      message: {
                        content: [{ image: 'https://dashscope.aliyuncs.com/out/1.png' }],
                      },
                    },
                  ],
                }
              : {}),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const rig = makeRig({ fetchImpl, callTimeoutOverride: {} });
    await rig.installSource(pilotSource());

    // 实例字段声明面：apiKey 敏感必填 → 实例表单 + secrets（DEV-114 与试点同一条链）。
    const summary = rig.registry.list().find((plugin) => plugin.id === PILOT_ID);
    expect(summary?.instanceFields.map((field) => field.key)).toEqual(['apiKey']);
    // PILOT_MODEL 必须与插件清单条目一致：manifest 换 model 而测试仍断言旧 id 会让
    // 真机协议错误漏测（DEV-124 的 url error 教训）。
    const pilotEntries = JSON.parse(
      readFileSync(path.join(pilotPluginDir, 'plugin.json'), 'utf8'),
    ) as {
      engines: { kepcup: string };
      runtime: { timeouts?: Record<string, number> };
      contributions: { capabilityModels: Array<{ id: string; model: string }> };
    };
    // `engines.kepcup` 是**应用最低版本**，不是插件版本：固定 >=0.5.14，不要随插件
    // 版本号（1.x）抬高——否则当前应用（0.5.x）会因 PLUGIN_INCOMPATIBLE 装不上。
    expect(pilotEntries.engines.kepcup).toBe('>=0.5.14');
    expect(
      pilotEntries.contributions.capabilityModels.find((entry) => entry.id === PILOT_ENTRY_ID)
        ?.model,
    ).toBe(PILOT_MODEL);
    // 插件声明的调用超时（异步排队 + 出图 5 分钟），宿主只钳制上限（DEV-130）。
    expect(pilotEntries.runtime.timeouts?.['media.generateImage']).toBe(300_000);
    const instance = await rig.pluginInstances.create(
      PILOT_ID,
      { apiKey: 'sk-pilot' },
      'capability-model',
    );
    expect(rig.secrets.getValue(pluginInstanceSecretName(PILOT_ID, instance.id, 'apiKey'))).toBe(
      'sk-pilot',
    );

    // Bot 绑定执行型条目 → MediaService 解析到托管适配器。
    const bot = rig.bots.create({ identity: { name: '百炼试点 Bot' } });
    rig.bots.setPluginIds(bot.id, [PILOT_ID]);
    rig.bots.setCapabilityEntries(bot.id, [{ plugin: PILOT_ID, entry: PILOT_ENTRY_ID }]);
    const phases: string[] = [];
    const image = await rig.media.generateImage(
      { prompt: '一只在窗台上的橘猫' },
      { loopType: 'task', botId: bot.id },
      { botId: bot.id, onProgress: (payload) => phases.push(payload.phase ?? '') },
    );
    expect(image.images).toEqual([{ url: 'https://dashscope.aliyuncs.com/out/1.png' }]);
    const submit = requests.find((request) => request.method === 'POST');
    expect(submit?.url).toContain('/api/v1/services/aigc/image-generation/generation');
    expect(submit?.authorization).toBe('Bearer sk-pilot');
    expect(submit?.body).toMatchObject({
      model: PILOT_MODEL,
      // qwen-image 协议：prompt 在 input.messages[0].content[].text。
      input: { messages: [{ role: 'user', content: [{ text: '一只在窗台上的橘猫' }] }] },
      // 条目 params 的默认 size / n / prompt_extend / watermark（工具不传时生效）。
      parameters: { size: '1024*1024', n: 1, prompt_extend: true, watermark: false },
    });

    // 异步轮询：提交 → 排队 → 生成中 → 取回 四段都能观测到（与同步接口不同）。
    expect(phases[0]).toBe('submitting');
    expect(phases).toContain('queued');
    expect(phases).toContain('generating');
    expect(phases).toContain('downloading');

    expect(rig.host.statusOf(PILOT_ID).recent[0]).toMatchObject({
      contract: 'media',
      method: 'generateImage',
      ok: true,
    });
    rig.host.disposeAll();
  }, 30_000);

  it('百炼试点错误映射：401 → PROVIDER_AUTH_FAILED；402 → PROVIDER_QUOTA；429 → PROVIDER_RATE_LIMITED', async () => {
    const statusByModel: Record<string, number> = {
      'auth-fail': 401,
      'quota-fail': 402,
      'rate-fail': 429,
    };
    const authorizations: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authorizations.push(headers['Authorization'] ?? '');
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const model = (JSON.parse(raw) as { model?: string }).model ?? '';
      const status = statusByModel[model] ?? 500;
      return new Response(
        JSON.stringify({
          code:
            status === 401
              ? 'InvalidApiKey'
              : status === 402
                ? 'Arrearage'
                : status === 429
                  ? 'Throttling'
                  : 'InternalError',
          message:
            status === 402
              ? '账户已欠费，请充值后重试'
              : status === 429
                ? '请求过于频繁'
                : '鉴权失败',
        }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const rig = makeRig({ fetchImpl, callTimeoutOverride: {} });
    await rig.installSource(pilotSource());
    const instance = await rig.pluginInstances.create(
      PILOT_ID,
      { apiKey: 'sk-pilot' },
      'capability-model',
    );
    const call = (model: string, credentialOverrides?: Record<string, string>) =>
      rig.host.call(
        PILOT_ID,
        'media',
        'generateImage',
        { prompt: '错误映射' },
        {
          entryId: PILOT_ENTRY_ID,
          model,
          instanceId: instance.id,
          ...(credentialOverrides !== undefined ? { credentialOverrides } : {}),
        },
      );
    await expect(call('auth-fail')).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    await expect(call('quota-fail')).rejects.toMatchObject({ code: 'PROVIDER_QUOTA' });
    await expect(call('rate-fail')).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(authorizations).toEqual(['Bearer sk-pilot', 'Bearer sk-pilot', 'Bearer sk-pilot']);
    // D125：条目级「未保存先测」的 credentialOverrides 在实例 secrets 之后合并。
    await expect(call('auth-fail', { apiKey: 'sk-override' })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
    expect(authorizations.at(-1)).toBe('Bearer sk-override');
    rig.host.disposeAll();
  }, 20_000);

  it('百炼试点取消：signal abort → cancel 帧 → 轮询等待中尽快返回；活动历史标 CANCELLED', async () => {
    // 异步轮询：取消在 sleep 间隙生效（不必等厂商响应），提交仍是秒级短请求。
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v1/services/aigc/image-generation/generation')) {
        return new Response(JSON.stringify({ output: { task_id: 'task-cancel-1' } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ output: { task_status: 'PENDING' } }), { status: 200 });
    }) as typeof fetch;
    const rig = makeRig({
      fetchImpl,
      callTimeoutOverride: { 'media.generateImage': 8_000 },
    });
    await rig.installSource(pilotSource());
    const instance = await rig.pluginInstances.create(
      PILOT_ID,
      { apiKey: 'sk-pilot' },
      'capability-model',
    );
    const controller = new AbortController();
    const pending = rig.host.call(
      PILOT_ID,
      'media',
      'generateImage',
      { prompt: '取消' },
      {
        entryId: PILOT_ENTRY_ID,
        model: PILOT_MODEL,
        instanceId: instance.id,
        signal: controller.signal,
      },
    );
    // 等到第一次轮询（插件固定 3s 间隔）之后 abort，覆盖「轮询等待中取消」。
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringContaining('调用已取消'),
    });
    expect(rig.host.statusOf(PILOT_ID).recent[0]).toMatchObject({
      ok: false,
      errorCode: 'CANCELLED',
      message: '调用已取消',
    });
    // 插件进程仍 ready（取消不是崩溃），下次调用无需重启。
    expect(rig.host.statusOf(PILOT_ID).status).toBe('ready');
    rig.host.disposeAll();
  }, 20_000);

  it('插件侧集成：异步提交 + 轮询出图（DEV-133：内置引擎 generateImage 已移除，插件是唯一通道）', async () => {
    const prompt = '一只在窗台上的橘猫';
    const size = '1024*1024';
    // 插件走异步任务端点 + 轮询（qwen-image 异步模式）；活动记录 / 阶段进度 /
    // 取消链只在插件侧（原「A/B 对照」保留插件半边，内置引擎半边随 DEV-133 移除）。
    const pluginRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let polls = 0;
    const pluginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      pluginRequests.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
      if (url.endsWith('/api/v1/services/aigc/image-generation/generation')) {
        return new Response(JSON.stringify({ output: { task_id: 'ab-task-1' } }), { status: 200 });
      }
      polls += 1;
      const status = polls === 1 ? 'PENDING' : 'SUCCEEDED';
      return new Response(
        JSON.stringify({
          output: {
            task_status: status,
            ...(status === 'SUCCEEDED'
              ? {
                  choices: [
                    {
                      message: {
                        content: [{ image: 'https://dashscope.aliyuncs.com/out/plugin.png' }],
                      },
                    },
                  ],
                }
              : {}),
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const rig = makeRig({ fetchImpl: pluginFetch, callTimeoutOverride: {} });
    await rig.installSource(pilotSource());
    const instance = await rig.pluginInstances.create(
      PILOT_ID,
      { apiKey: 'sk-ab' },
      'capability-model',
    );
    const pluginProgress: string[] = [];
    const viaPlugin = (await rig.host.call(
      PILOT_ID,
      'media',
      'generateImage',
      { prompt, size },
      {
        entryId: PILOT_ENTRY_ID,
        model: PILOT_MODEL,
        instanceId: instance.id,
        onProgress: (payload) => pluginProgress.push(payload.phase ?? ''),
      },
    )) as { images: Array<{ url: string }> };
    expect(viaPlugin.images).toEqual([{ url: 'https://dashscope.aliyuncs.com/out/plugin.png' }]);

    // 请求形态：插件走异步任务端点 + 轮询（提交 + 至少一次轮询）。
    expect(pluginRequests[0]?.url).toContain('/api/v1/services/aigc/image-generation/generation');
    expect(pluginRequests[0]?.body).toMatchObject({
      model: PILOT_MODEL,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters: { size, n: 1 },
    });
    expect(pluginRequests.length).toBeGreaterThanOrEqual(2);

    // 观测面（61 §6）：有阶段进度、插件卡历史。
    expect(pluginProgress.length).toBeGreaterThan(0);
    expect(pluginProgress).toContain('queued');
    expect(rig.host.statusOf(PILOT_ID).recent[0]).toMatchObject({ ok: true });
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

  it('实例数超过清单的 4 个 kind 上限仍能握手（账号数不受 PLUGIN_MAX_INSTANCES 限制）', async () => {
    const { rig } = await withProbe();
    // 用户可为一个插件添加多个厂商账号实例（D124）：清单的 PLUGIN_MAX_INSTANCES（4）
    // 是 **实例 kind 数**上限，不是账号数。旧实现把它当 init 帧数组上限，第 5 个实例
    // 会让握手 schema 校验失败、插件永远起不来。
    const instanceIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      instanceIds.push((await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model')).id);
    }
    const result = (await callProbe(rig, instanceIds.at(-1)!, 'ok')) as {
      images: Array<{ url: string }>;
    };
    expect(result.images[0]?.url.startsWith('data:image/png')).toBe(true);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    rig.host.disposeAll();
  });

  it('进程边界：env 白名单不透传宿主秘密；cwd = 插件数据目录；execArgv 为空', async () => {
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
    // D125 补丁：进程 cwd 是插件私有数据目录（不是安装目录）——相对路径写入落在
    // 用户数据区，更新替换安装树时不受影响。
    const dataDir = path.join(rig.home, 'plugin-data', 'io.test', 'runtime-probe');
    expect(realpathSync(reportedCwd)).toBe(realpathSync(dataDir));
    expect(statSync(dataDir).isDirectory()).toBe(true);
    const installDir = await rig.registry.runtimeDirOf(PROBE_ID);
    expect(installDir).not.toBeNull();
    expect(realpathSync(reportedCwd)).not.toBe(realpathSync(installDir!));
    expect(parts.at(-1)).toBe('0');
    rig.host.disposeAll();
  });

  it('数据目录不可用（同名文件占位）：启动失败置 error，调用得到 PLUGIN_CRASHED', async () => {
    const rig = makeRig();
    await rig.installSource(probeSource());
    await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
    const botId = bindProbeBot(rig);
    const dataDir = path.join(rig.home, 'plugin-data', 'io.test', 'runtime-probe');
    rmSync(dataDir, { recursive: true, force: true });
    writeFileSync(dataDir, 'not-a-directory');
    await expect(
      rig.media.generateImage({ prompt: '目录不可用' }, { loopType: 'task', botId }, { botId }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { pluginId: PROBE_ID, code: 'PLUGIN_CRASHED' },
    });
    expect(rig.host.statusOf(PROBE_ID).status).toBe('error');
    expect(rig.host.statusOf(PROBE_ID).detail).toBe('插件数据目录不可用');
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
    rig.secrets.setValue(
      `${pluginSecretScope(PROBE_ID)}:instance:${instanceId}:apiKey`,
      'sk-probe',
    );
    const result = (await callProbe(rig, instanceId, 'creds')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(result.images[0]?.mimeType).toBe('image/png+apiKey+sk-probe');
    rig.host.disposeAll();
  });

  it('实例字段声明（DEV-114）：runtime.instanceFields → 实例表单 / secrets / 子进程 credentials + instanceId', async () => {
    const rig = makeRig();
    await rig.installSource(probeSourceWithInstanceFields());
    const summary = rig.registry.list().find((plugin) => plugin.id === PROBE_ID);
    expect(summary?.instanceFields.map((field) => field.key)).toEqual(['apiKey', 'region']);

    const instance = await rig.pluginInstances.create(
      PROBE_ID,
      { apiKey: 'sk-from-form', region: 'cn-shanghai' },
      'capability-model',
    );
    // 敏感字段值只进 secrets；实例摘要只报告「已设置」。
    expect(rig.secrets.getValue(pluginInstanceSecretName(PROBE_ID, instance.id, 'apiKey'))).toBe(
      'sk-from-form',
    );
    expect(instance.values['apiKey']).toBeUndefined();
    expect(instance.storedSensitiveKeys).toContain('apiKey');
    expect(instance.values['region']).toBe('cn-shanghai');

    // 真实子进程：invoke.context.credentials 带敏感值，instanceId 可选字段可对齐实例。
    const creds = (await callProbe(rig, instance.id, 'creds')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(creds.images[0]?.mimeType).toBe('image/png+apiKey+sk-from-form');
    const ctx = (await callProbe(rig, instance.id, 'ctx')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(ctx.images[0]?.mimeType).toBe(`image/png+${instance.id}`);
    rig.host.disposeAll();
  });

  it('旧 SDK 兼容（D125 P4）：ready 未声明 features → 宿主不发送 instanceId，调用仍成功', async () => {
    const rig = makeRig();
    await rig.installSource(legacyProbeSource());
    const instance = await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
    const ctx = (await callProbe(rig, instance.id, 'ctx')) as {
      images: Array<{ mimeType: string }>;
    };
    // 帧里没有 instanceId（旧 SDK 的 strict schema 不会因此丢弃整帧）。
    expect(ctx.images[0]?.mimeType).toBe('image/png+');
    // 凭据注入仍按实例工作（实例没有敏感字段 → 空凭据，旧帧 shape 不变）。
    const creds = (await callProbe(rig, instance.id, 'creds')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(creds.images[0]?.mimeType).toBe('image/png++');
    rig.host.disposeAll();
  });

  it('RSS 观测（61 §3.3）：心跳 pong 自报超过阈值 → 记一条 warn（每进程一次，不击杀）', async () => {
    // 阈值调成 1 字节：探针在 pong 里自报真实 RSS，必然越过；只验观测日志。
    const { rig, instanceId } = await withProbe({ rssWarnBytes: 1 });
    await callProbe(rig, instanceId, 'ok');
    for (let i = 0; i < 100; i += 1) {
      if (
        rig.logs.some((entry) => entry.message.includes('RSS exceeded the observation threshold'))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const warnings = rig.logs.filter((entry) =>
      entry.message.includes('RSS exceeded the observation threshold'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ plugin: PROBE_ID, thresholdBytes: 1 });
    // 观测不是治理：进程仍 ready，随后的调用照常成功。
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    const after = (await callProbe(rig, instanceId, 'ok')) as { images: unknown[] };
    expect(after.images).toHaveLength(1);
    rig.host.disposeAll();
  });

  it('更新扩权（D125 P4）：network.allow / 敏感实例字段扩大 → inspect 报差异、无 acknowledgeDiff 拒更新', async () => {
    const rig = makeRig();
    await rig.installSource(runtimeSourceWithCapabilities({ networkAllow: ['example.invalid'] }));
    const v2 = runtimeSourceWithCapabilities({
      networkAllow: ['example.invalid', 'api.example.com'],
      extraFields: [
        { key: 'secretKey', type: 'string', title: 'Secret Key', required: false, sensitive: true },
      ],
    });
    const info = await rig.registry.inspect({ kind: 'folder', path: v2 });
    expect(info.update).toMatchObject({ permissionsExpanded: true });
    expect(info.update?.added).toContain('执行型插件新增可访问的网络域名 api.example.com');
    expect(info.update?.added).toContain(
      '执行型插件新增实例凭据字段 secretKey（只保存你填写的值）',
    );

    await expect(
      rig.registry.install({
        source: { kind: 'folder', path: v2 },
        sha256: treeShaOf(v2),
        userConfig: {},
        via: 'folder',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { permissionsExpanded: true } });

    // 显式确认后才落盘（同 id 本地重装 = 更新流）。
    const updated = await rig.registry.install({
      source: { kind: 'folder', path: v2 },
      sha256: treeShaOf(v2),
      userConfig: {},
      via: 'folder',
      acknowledgeDiff: true,
    });
    expect(updated.id).toBe(PROBE_ID);
    const summary = rig.registry.list().find((plugin) => plugin.id === PROBE_ID);
    expect(summary?.instanceFields.map((field) => field.key)).toEqual([
      'apiKey',
      'region',
      'secretKey',
    ]);
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
    const preInstance = await preRig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
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

  it('清单声明的调用超时生效：runtime.timeouts 1.5s → hang 在 1.5s 被杀（不是契约 120s）', async () => {
    // 不传 callTimeoutOverride：验证 manifest `runtime.timeouts` 是 host 的取值来源。
    const rig = makeRig();
    await rig.installSource(probeSourceWithDeclaredTimeout(1_500));
    const instance = await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
    const startedAt = Date.now();
    await expect(
      rig.host.call(
        PROBE_ID,
        'media',
        'generateImage',
        { prompt: '探针' },
        { entryId: 'probe-image', model: 'hang', instanceId: instance.id },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
    // 看门狗使用插件声明的 1.5s（+2s 强杀宽限），远小于契约默认 120s。
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('error');
    rig.host.disposeAll();
  }, 30_000);

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

  it('Host API storage：set/get/list/delete 往返；卸载清空 plugin_storage / secrets / 进程（61 验收）', async () => {
    const rig = makeRig();
    await rig.installSource(probeSourceWithInstanceFields());
    const instance = await rig.pluginInstances.create(
      PROBE_ID,
      { apiKey: 'sk-uninstall' },
      'capability-model',
    );
    const instanceId = instance.id;
    const secretName = pluginInstanceSecretName(PROBE_ID, instanceId, 'apiKey');
    expect(rig.secrets.getValue(secretName)).toBe('sk-uninstall');
    const result = (await callProbe(rig, instanceId, 'storage')) as {
      images: Array<{ mimeType: string }>;
    };
    expect(result.images[0]?.mimeType).toBe('image/png+world+1');
    // 探针删除过自己的键，但桥的写入是真实的：直接再写一条，卸载后应清空。
    rig.bridge.storageSet(PROBE_ID, 'leftover', { kept: true });
    expect(rig.storage.list(PROBE_ID)).toEqual(['leftover']);
    await rig.registry.uninstall(PROBE_ID);
    expect(rig.storage.list(PROBE_ID)).toEqual([]);
    // 卸载清理：进程终止、实例行与 secrets 清除（61 验收「卸载清理」）。
    expect(rig.host.statusOf(PROBE_ID).status).toBe('stopped');
    expect(rig.instanceStore.list(PROBE_ID)).toEqual([]);
    expect(rig.secrets.getValue(secretName)).toBeNull();
    // 条目残留静默跳过：执行型插件不再出现在运行时列表里。
    expect((await rig.host.list()).some((row) => row.pluginId === PROBE_ID)).toBe(false);
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

  it('error → restart → ready 闭环（P3 验收 1：插件卡「重启运行时」的宿主语义）', async () => {
    const { rig, instanceId } = await withProbe();
    await expect(callProbe(rig, instanceId, 'hang')).rejects.toMatchObject({
      code: 'PLUGIN_TIMEOUT',
    });
    expect(rig.host.statusOf(PROBE_ID).status).toBe('error');
    await rig.host.restart(PROBE_ID);
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
    // 最近错误保留（重启不清历史；徽标回 ready 后不显示 tooltip）。
    expect(rig.host.statusOf(PROBE_ID).lastError).toContain('无响应');
    const after = await callProbe(rig, instanceId, 'ok');
    expect((after as { images: unknown[] }).images).toHaveLength(1);
    rig.host.disposeAll();
  });

  it('plugins.runtime.list：全部已装执行型插件的状态机行；非执行型插件不出现', async () => {
    const { rig, instanceId } = await withProbe();
    // 同装一个数据型插件（无 runtime 段）：registry 里有它，但运行时列表不得出现。
    await rig.installSource(dataPluginSource());
    expect(rig.store.get('io.test/data-only')).not.toBeNull();
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

  // --- D125 P3：进度 / 取消的生产链路（工具 → MediaService → HostedAdapter → Host） ---

  /** 建 Bot 并绑定探针条目（MediaService 的条目路径要求 botId + 条目）。 */
  const bindProbeBot = (
    rig: Rig,
    entries: Array<{ plugin: string; entry: string }> = [
      { plugin: PROBE_ID, entry: 'probe-image' },
    ],
  ): string => {
    const bot = rig.bots.create({ identity: { name: '探针 Bot' } });
    rig.bots.setPluginIds(bot.id, [PROBE_ID]);
    rig.bots.setCapabilityEntries(bot.id, entries);
    return bot.id;
  };

  it('进度链：host.progress 帧 → MediaService resolve.onProgress（宿主限速后透传）', async () => {
    const rig = makeRig();
    await rig.installSource(probeSource());
    await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
    const botId = bindProbeBot(rig);
    const progress: unknown[] = [];
    const result = await rig.media.generateImage(
      { prompt: '进度测试' },
      { loopType: 'task', botId },
      { botId, onProgress: (payload) => progress.push(payload) },
    );
    expect(result.images).toHaveLength(1);
    // 探针 'ok' 行为发一条 progress（phase/percent/message 原样透传）。
    expect(progress).toEqual([{ phase: 'queued', percent: 10, message: '探针已排队' }]);
    rig.host.disposeAll();
  });

  it('来源回调（D125 补丁）：执行型插件条目 → onResolved({ pluginId })', async () => {
    const rig = makeRig();
    await rig.installSource(probeSource());
    await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
    const botId = bindProbeBot(rig);
    const origins: Array<{ pluginId?: string }> = [];
    await rig.media.generateImage(
      { prompt: '来源回调' },
      { loopType: 'task', botId },
      { botId, onResolved: (origin) => origins.push(origin) },
    );
    expect(origins).toEqual([{ pluginId: PROBE_ID }]);
    rig.host.disposeAll();
  });

  it('取消链（DEV-118）：MediaService resolve.signal → cancel 帧；活动历史标 CANCELLED', async () => {
    const rig = makeRig({ callTimeoutOverride: { 'media.generateImage': 5_000 } });
    await rig.installSource(probeSource());
    await rig.pluginInstances.create(PROBE_ID, {}, 'capability-model');
    // probe-abort 条目 model = abortable：等宿主 cancel 帧后返回可区分结果。
    const botId = bindProbeBot(rig, [{ plugin: PROBE_ID, entry: 'probe-abort' }]);
    const controller = new AbortController();
    const pending = rig.media.generateImage(
      { prompt: '取消测试' },
      { loopType: 'task', botId },
      { botId, signal: controller.signal },
    );
    for (let i = 0; i < 200 && rig.host.statusOf(PROBE_ID).status !== 'busy'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(rig.host.statusOf(PROBE_ID).status).toBe('busy');
    controller.abort();
    // 工具拿到的仍是插件返回（取消由工具侧决定是否采用）；这里断言链路与历史。
    const result = await pending;
    expect(result.images[0]?.mimeType).toBe('image/png+aborted');
    expect(rig.host.statusOf(PROBE_ID).recent[0]).toMatchObject({
      ok: false,
      errorCode: 'CANCELLED',
      message: '调用已取消',
      contract: 'media',
      method: 'generateImage',
    });
    // 取消不是插件错误：活动历史记 CANCELLED，但不污染「最近错误」。
    expect(rig.host.statusOf(PROBE_ID).lastError).toBeNull();
    expect(rig.host.statusOf(PROBE_ID).status).toBe('ready');
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

  it('runtime.timeouts 引用未注册契约方法 → 拒装（PLUGIN_INVALID）；合法键通过', async () => {
    const rig = makeRig();
    const unknown = variantDir('timeout-unknown', {
      timeouts: { 'media.notAMethod': 60_000 },
    });
    await expect(rig.installSource(unknown)).rejects.toMatchObject({
      code: 'PLUGIN_INVALID',
      message: expect.stringContaining('media.notAMethod'),
    });
    expect(rig.store.get(PROBE_ID)).toBeNull();
    const unknownContract = variantDir('timeout-contract', {
      timeouts: { 'search.query': 60_000 },
    });
    await expect(rig.installSource(unknownContract)).rejects.toMatchObject({
      code: 'PLUGIN_INVALID',
    });
    const valid = variantDir('timeout-valid', {
      timeouts: { 'media.generateImage': 180_000 },
    });
    await expect(rig.installSource(valid)).resolves.toBeUndefined();
  });

  it('包内含 .node / .wasm / .dll / .so / .exe / 可执行位文件 → 拒装（PLUGIN_INVALID）', async () => {
    const rig = makeRig();
    for (const relative of [
      'lib/evil.node',
      'lib/evil.wasm',
      'lib/evil.dll',
      'lib/evil.so',
      'lib/evil.exe',
      'lib/evil.dylib',
    ]) {
      const dir = variantDir(`native-${relative.split('.').pop()}`, null, [
        { relative, text: 'x' },
      ]);
      await expect(rig.installSource(dir), relative).rejects.toMatchObject({
        code: 'PLUGIN_INVALID',
      });
    }
    // Windows 没有可执行位语义（scanPackage 在 win32 上不检查 mode），此断言只在 POSIX 上成立。
    if (process.platform !== 'win32') {
      const executable = variantDir('exec', null, [
        { relative: 'tools/run.sh', text: '#!/bin/sh\n', exec: true },
      ]);
      await expect(rig.installSource(executable)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    }
    expect(rig.store.get(PROBE_ID)).toBeNull();
  });

  it('runtime.entry 必须是 ESM：.cjs / 无扩展名 / .js 缺 package.json type module / 嵌套 package.json → 拒装', async () => {
    const rig = makeRig();
    for (const relative of ['main.cjs', 'main']) {
      const dir = variantDir(`entry-${relative.replace('.', '-')}`, { entry: relative }, [
        { relative, text: 'globalThis.ok = 1;' },
      ]);
      await expect(rig.installSource(dir), relative).rejects.toMatchObject({
        code: 'PLUGIN_INVALID',
      });
    }
    const jsNoPackage = variantDir('entry-js-no-package', { entry: 'main.js' }, [
      { relative: 'main.js', text: 'globalThis.ok = 1;' },
    ]);
    await expect(rig.installSource(jsNoPackage)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    const jsCommonJs = variantDir('entry-js-cjs', { entry: 'main.js' }, [
      { relative: 'main.js', text: 'globalThis.ok = 1;' },
      { relative: 'package.json', text: '{"type":"commonjs"}' },
    ]);
    await expect(rig.installSource(jsCommonJs)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    const nestedPackage = variantDir('entry-nested-package', { entry: 'main.js' }, [
      { relative: 'main.js', text: 'globalThis.ok = 1;' },
      { relative: 'package.json', text: '{"type":"module"}' },
      { relative: 'nested/package.json', text: '{"type":"commonjs"}' },
    ]);
    await expect(rig.installSource(nestedPackage)).rejects.toMatchObject({
      code: 'PLUGIN_INVALID',
    });
    const jsEsm = variantDir('entry-js-esm', { entry: 'main.js' }, [
      { relative: 'main.js', text: 'globalThis.ok = 1;' },
      { relative: 'package.json', text: '{"type":"module"}' },
    ]);
    await expect(rig.installSource(jsEsm)).resolves.toBeUndefined();
    expect(rig.store.get(PROBE_ID)?.state).toBe('installed');
    rig.host.disposeAll();
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

  it('混合插件：runtime.instanceFields 与引擎凭据字段重名 → 拒装（避免非敏感声明覆盖 secrets 语义）', async () => {
    const dir = variantDir('field-collision', null);
    const raw = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as {
      runtime: Record<string, unknown>;
      contributions: { capabilityModels: Array<Record<string, unknown>> };
    };
    raw.runtime.instanceFields = [
      { key: 'apiKey', type: 'string', title: 'API Key', sensitive: false },
    ];
    raw.contributions.capabilityModels.push({
      id: 'ds-image',
      capability: 'image',
      model: 'qwen-image',
      engine: 'dashscope',
    });
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

  it('同意卡披露：runtime.instanceFields 的敏感键进入 credentialFields（DEV-114）', async () => {
    const rig = makeRig();
    const info = await rig.registry.inspect({
      kind: 'folder',
      path: probeSourceWithInstanceFields(),
    });
    expect(info.runtime).toMatchObject({
      hostApi: '^1',
      networkDomains: ['example.invalid'],
      credentialFields: ['apiKey'],
    });
    expect(info.installable).toBe(true);
  });

  it('同意卡披露：network.allow 重复条目按声明序去重（渲染层 keyed each 不炸）', async () => {
    const dir = variantDir('disclosure-dup', {
      network: { allow: ['example.invalid', 'api.example.com', 'example.invalid'] },
    });
    const raw = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as {
      runtime: { network: { allow: string[] } };
    };
    raw.runtime.network.allow = ['example.invalid', 'api.example.com', 'example.invalid'];
    writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(raw, null, 2));
    const manifest = pluginManifestSchema.parse(raw);
    const disclosure = await runtimeDisclosureOf(manifest, { dir, tier: 'developer' });
    expect(disclosure.runtime?.networkDomains).toEqual(['example.invalid', 'api.example.com']);
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
