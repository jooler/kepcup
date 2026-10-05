import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_MODEL_VERSION,
  ENV_CATALOG,
  ONNXRUNTIME_VERSION,
  embeddingBundleEntries,
  platformKey,
  validateCatalog,
  catalogSchema,
} from '../../src/env/catalog.js';

describe('env catalog (P06)', () => {
  it('pinned catalog passes schema and per-kind completeness validation', () => {
    expect(catalogSchema.safeParse(ENV_CATALOG).success).toBe(true);
    expect(validateCatalog(ENV_CATALOG)).toEqual([]);
    const items = ENV_CATALOG.map((entry) => entry.item);
    // 任务书目录：uv、python（经 uv 安装）、node、git + P12 的 lima/podman
    // （kind=system 只检测）+ P07 本地向量栈（DEV-007 已落实：onnxruntime
    // 运行库 + embedding-model，kind=files 多文件钉住下载）。
    expect(items).toEqual([
      'uv',
      'python',
      'node',
      'git',
      'lima',
      'podman',
      'onnxruntime',
      'embedding-model',
    ]);
    // P07: 两个新条目均为 files 类型、全平台、真实钉住（无 downloadPending）。
    for (const item of ['onnxruntime', 'embedding-model']) {
      const entry = ENV_CATALOG.find((e) => e.item === item)!;
      expect(entry.downloadPending).toBeUndefined();
      expect(entry.install.via).toBe('files');
      expect(Object.values(entry.platforms).every((p) => p.kind === 'files')).toBe(true);
      expect(Object.values(entry.platforms).every((p) => p.url === '' && p.sha256 === '')).toBe(
        true,
      );
    }
    // 体积 = 文件之和（卡片数字诚实）；模型 ≤200MB（任务书上限）。
    const runtime = ENV_CATALOG.find((e) => e.item === 'onnxruntime')!;
    const runtimeTotal = runtime.install.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    expect(runtime.platforms['darwin-arm64']?.sizeBytes).toBe(runtimeTotal);
    const model = ENV_CATALOG.find((e) => e.item === 'embedding-model')!;
    const modelTotal = model.install.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    expect(model.platforms['darwin-arm64']?.sizeBytes).toBe(modelTotal);
    expect(modelTotal).toBeLessThanOrEqual(200_000_000);
    expect(model.verify).toEqual({ files: ['model.onnx', 'vocab.txt', 'config.json'] });
    expect(EMBEDDING_MODEL_VERSION).toBe('1.5');
    expect(ONNXRUNTIME_VERSION).toBe(runtime.version);
    // bundle 助手：模型审批的运行前置。
    const bundle = embeddingBundleEntries(ENV_CATALOG);
    expect(bundle?.runtime.item).toBe('onnxruntime');
    expect(bundle?.model.item).toBe('embedding-model');
    // P12: 增强级条目 system 只检测；lima 检测的是 limactl CLI。
    const lima = ENV_CATALOG.find((entry) => entry.item === 'lima')!;
    expect(lima.detectBin).toBe('limactl');
    expect(lima.platforms['darwin-arm64']?.kind).toBe('system');
    expect(lima.platforms['linux-x64']).toBeUndefined();
    const podman = ENV_CATALOG.find((entry) => entry.item === 'podman')!;
    expect(podman.platforms['linux-x64']?.kind).toBe('system');
    expect(podman.platforms['darwin-arm64']).toBeUndefined();
    // P12: wslDistro 条目（node/python）在 Windows 主机上装进发行版。
    for (const item of ['node', 'python']) {
      expect(ENV_CATALOG.find((entry) => entry.item === item)!.wslDistro).toBe(true);
    }
    // 所有下载地址只来自登记过的官方源：github/nodejs/python 官方发布页；
    // registry.npmmirror.com（npm 官方 tarball，字节与 registry.npmjs.org
    // 一致，sha512 integrity 已核对）；ModelScope（Xenova/bge ONNX 导出的
    // 分发站，见 catalog 内注释与 docs/design/16）。
    for (const entry of ENV_CATALOG) {
      for (const platform of Object.values(entry.platforms)) {
        if (platform === undefined || platform.url.length === 0) continue;
        expect(
          platform.url.startsWith('https://github.com/') ||
            platform.url.startsWith('https://nodejs.org/') ||
            platform.url.startsWith('https://www.python.org/'),
          `unexpected source: ${platform.url}`,
        ).toBe(true);
      }
      const files = entry.install.via === 'files' ? entry.install.files : [];
      for (const file of files) {
        expect(
          file.url.startsWith('https://registry.npmmirror.com/') ||
            file.url.startsWith('https://www.modelscope.cn/'),
          `unexpected file source: ${file.url}`,
        ).toBe(true);
      }
    }
  });

  it('covers the six documented platforms where upstream publishes artifacts', () => {
    const uv = ENV_CATALOG.find((entry) => entry.item === 'uv')!;
    expect(Object.keys(uv.platforms).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].sort(),
    );
    const node = ENV_CATALOG.find((entry) => entry.item === 'node')!;
    // Node upstream publishes no win32-arm64 builds.
    expect(node.platforms['win32-x64']).toBeDefined();
    expect(node.platforms['win32-arm64']).toBeUndefined();
    const git = ENV_CATALOG.find((entry) => entry.item === 'git')!;
    // git：Windows 用 MinGit（archive），macOS/Linux 由系统安装（system）。
    expect(git.platforms['win32-x64']?.kind).toBe('archive');
    expect(git.platforms['darwin-arm64']?.kind).toBe('system');
    expect(git.platforms['linux-x64']?.kind).toBe('system');
  });

  it('flags archive entries with missing or malformed fields', () => {
    const base = ENV_CATALOG.find((entry) => entry.item === 'uv')!;
    const broken = [
      {
        ...base,
        item: 'broken-a',
        platforms: {
          'darwin-arm64': { url: '', sha256: 'a'.repeat(64), sizeBytes: 10, kind: 'archive' },
        },
      },
      {
        ...base,
        item: 'broken-b',
        platforms: {
          'darwin-arm64': {
            url: 'https://example.com/x.tar.gz',
            sha256: 'short',
            sizeBytes: 10,
            kind: 'archive',
          },
        },
      },
      {
        ...base,
        item: 'broken-c',
        platforms: {
          'darwin-arm64': {
            url: 'https://example.com/x.tar.gz',
            sha256: 'a'.repeat(64),
            sizeBytes: 0,
            kind: 'archive',
          },
        },
      },
      {
        ...base,
        item: 'broken-d',
        platforms: { 'darwin-arm64': { url: '', sha256: '', sizeBytes: 5, kind: 'system' } },
      },
    ] as never;
    const errors = validateCatalog(broken);
    expect(errors.some((e) => e.includes('broken-a/darwin-arm64: archive without url'))).toBe(true);
    expect(errors.some((e) => e.includes('broken-b/darwin-arm64: archive without sha256'))).toBe(
      true,
    );
    expect(errors.some((e) => e.includes('broken-c/darwin-arm64: archive without sizeBytes'))).toBe(
      true,
    );
    expect(errors.some((e) => e.startsWith('broken-d'))).toBe(false);
  });

  it('flags files entries with unsafe names, dest traversal, or duplicate roots', () => {
    const model = ENV_CATALOG.find((entry) => entry.item === 'embedding-model')!;
    const runtime = ENV_CATALOG.find((entry) => entry.item === 'onnxruntime')!;
    const file = (patch: Partial<(typeof model.install.files)[number]>) => ({
      ...model.install.files[0]!,
      ...patch,
    });
    const broken = [
      {
        ...model,
        item: 'files-a',
        install: { via: 'files', files: [file({ name: 'sub/dir/model.onnx' })] },
      },
      {
        ...model,
        item: 'files-b',
        install: {
          via: 'files',
          files: [file({ extract: { dest: '/abs/dest' } }), file({ name: 'vocab.txt' })],
        },
      },
      {
        ...model,
        item: 'files-c',
        install: {
          via: 'files',
          files: [file({ extract: { dest: '../escape' } }), file({ name: 'vocab.txt' })],
        },
      },
      {
        ...runtime,
        item: 'files-d',
        // onnxruntime 本体就是 dest='' 的解包件；再造一个 dest='' 互相覆盖。
        install: {
          via: 'files',
          files: [
            ...runtime.install.files,
            { ...runtime.install.files[0]!, name: 'another-node.tgz' },
          ],
        },
      },
      {
        ...model,
        item: 'files-e',
        install: {
          via: 'files',
          files: [file(), file()],
        },
      },
    ] as never;
    const errors = validateCatalog(broken);
    expect(
      errors.some((e) => e.includes('files-a: file name must not contain path separators')),
    ).toBe(true);
    expect(errors.some((e) => e.includes('files-b: extract.dest must be relative'))).toBe(true);
    expect(errors.some((e) => e.includes('files-c: extract.dest must not traverse up'))).toBe(true);
    expect(
      errors.some((e) =>
        e.includes('files-d: at most one file may extract to the install dir root'),
      ),
    ).toBe(true);
    expect(errors.some((e) => e.includes('files-e: duplicate file name model.onnx'))).toBe(true);
  });

  it('maps platform+arch to catalog keys and rejects unknown combos', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('sunos', 'x64')).toBeNull();
  });
});
