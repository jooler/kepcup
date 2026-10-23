import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FilePreviewSessions,
  bindFilesPreviewMethods,
  filePreviewTokenOf,
  webMimeOf,
} from '../../src/rpc/files-preview-bindings.js';

/**
 * kepcup-file 目录预览的 RPC 绑定（docs/design/47）：token 派生、MIME 表、
 * previewResource 的范围校验（穿越 / 符号链接 / 目录 / 未知会话）、会话表
 * （滑动 TTL + 真 LRU）、previewSession 只对 HTML artifact 开。
 */

type Services = Parameters<typeof bindFilesPreviewMethods>[0];

async function call(
  services: Services,
  method: 'files.previewSession' | 'files.previewResource',
  input: unknown,
): Promise<unknown> {
  const bound = bindFilesPreviewMethods(services);
  const spec = (method === 'files.previewSession' ? bound.app : bound.platform)[method]!;
  return (spec.handle as (value: unknown) => Promise<unknown>)(spec.input.parse(input));
}

function servicesFor(hasArtifactPath: (conversationId: string, p: string) => boolean): Services {
  return { domain: { messages: { hasArtifactPath } } } as unknown as Services;
}

const codeOf = (error: unknown): unknown => (error as { code?: string }).code;

describe('filePreviewTokenOf / webMimeOf', () => {
  it('token is f + 24 hex of the sha256, stable per canonical path', () => {
    const a = filePreviewTokenOf('/tmp/w/index.html');
    expect(a).toMatch(/^f[0-9a-f]{24}$/);
    expect(filePreviewTokenOf('/tmp/w/index.html')).toBe(a);
    expect(filePreviewTokenOf('/tmp/w/other.html')).not.toBe(a);
  });

  it('web mime covers web assets, falls back to octet-stream', () => {
    expect(webMimeOf('a.html')).toBe('text/html');
    expect(webMimeOf('a.JS')).toBe('text/javascript');
    expect(webMimeOf('x.woff2')).toBe('font/woff2');
    expect(webMimeOf('x.bin')).toBe('application/octet-stream');
  });
});

describe('FilePreviewSessions', () => {
  it('get refreshes the sliding TTL and moves the entry to the LRU back', () => {
    let now = 1_000;
    const sessions = new FilePreviewSessions({ now: () => now, ttlMs: 1_000, max: 2 });
    sessions.set('a', '/a');
    sessions.set('b', '/b');
    // 取用 a：TTL 重置且挪到队尾——淘汰从最久未用的 b 开始。
    now += 900;
    expect(sessions.get('a')).toBe('/a');
    now += 900;
    sessions.set('c', '/c'); // b 过期被清；a 在第 1900 刚续期，仍活着。
    expect(sessions.get('b')).toBeUndefined();
    expect(sessions.get('a')).toBe('/a');
    expect(sessions.get('c')).toBe('/c');
  });

  it('evicts the least-recently-used entry beyond max even when not yet expired', () => {
    let now = 0;
    const sessions = new FilePreviewSessions({ now: () => now, ttlMs: 60_000, max: 2 });
    sessions.set('a', '/a');
    sessions.set('b', '/b');
    now += 1;
    sessions.get('a'); // a 变成最近使用。
    now += 1;
    sessions.set('c', '/c'); // 挤掉的是 b（最久未用），不是 a。
    expect(sessions.get('b')).toBeUndefined();
    expect(sessions.get('a')).toBe('/a');
    expect(sessions.get('c')).toBe('/c');
    expect(sessions.size).toBe(2);
  });

  it('an expired entry is gone even without a sweep trigger', () => {
    let now = 0;
    const sessions = new FilePreviewSessions({ now: () => now, ttlMs: 100, max: 8 });
    sessions.set('a', '/a');
    now += 101;
    expect(sessions.get('a')).toBeUndefined();
  });
});

describe('files.preview bindings', () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    // macOS 的 tmpdir 在 /var（符号链接 → /private/var）：canonical 化后再拼路径，
    // 否则 core 侧 canonicalPath 解出的真实路径与测试里的字符串不相等。
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'kepcup-file-preview-')));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'kepcup-file-outside-')));
    writeFileSync(path.join(dir, 'index.html'), '<p>hi</p>');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'a.png'), 'png');
    writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('previewSession validates the artifact and registers the directory', async () => {
    const file = path.join(dir, 'index.html');
    const services = servicesFor((conversationId, p) => conversationId === 'c1' && p === file);
    const out = (await call(services, 'files.previewSession', {
      conversationId: 'c1',
      path: file,
    })) as { token: string; size: number };
    expect(out.token).toBe(filePreviewTokenOf(file));
    expect(out.size).toBe('<p>hi</p>'.length);

    await expect(
      call(services, 'files.previewSession', { conversationId: 'c2', path: file }),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });
  });

  it('previewSession only opens directories for HTML artifacts (design 47)', async () => {
    // 会话授权的是「所在目录」：非 HTML artifact 卡不能把它的目录变成可枚举读取的源。
    writeFileSync(path.join(dir, 'notes.txt'), 'secret-ish');
    const text = path.join(dir, 'notes.txt');
    const services = servicesFor(() => true);
    await expect(
      call(services, 'files.previewSession', { conversationId: 'c1', path: text }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('previewResource serves files inside the root and rejects escapes', async () => {
    const file = path.join(dir, 'index.html');
    const token = filePreviewTokenOf(file);
    const services = servicesFor(() => true);
    await call(services, 'files.previewSession', { conversationId: 'c1', path: file });

    const html = (await call(services, 'files.previewResource', {
      token,
      rel: 'index.html',
    })) as { mime: string; dataBase64: string };
    expect(html.mime).toBe('text/html');
    expect(html.dataBase64).toBe(Buffer.from('<p>hi</p>').toString('base64'));

    const png = (await call(services, 'files.previewResource', {
      token,
      rel: 'assets/a.png',
    })) as { mime: string };
    expect(png.mime).toBe('image/png');

    for (const rel of ['../secret.txt', 'assets/../../../outside/secret.txt', 'nope.txt']) {
      await expect(call(services, 'files.previewResource', { token, rel })).rejects.toSatisfy(
        (error: unknown) => {
          const code = codeOf(error);
          return code === 'PATH_OUT_OF_SCOPE' || code === 'NOT_FOUND';
        },
      );
    }
    // 目录不是文件。
    await expect(
      call(services, 'files.previewResource', { token, rel: 'assets' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 未知 token（core 重启 / 过期）。
    await expect(
      call(services, 'files.previewResource', {
        token: filePreviewTokenOf(path.join(outside, 'x.html')),
        rel: 'x.html',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a symlink inside the root pointing outside is rejected', async () => {
    const file = path.join(dir, 'index.html');
    const token = filePreviewTokenOf(file);
    const services = servicesFor(() => true);
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'));
    } catch {
      // Windows 无符号链接权限时跳过。
      return;
    }
    await call(services, 'files.previewSession', { conversationId: 'c1', path: file });
    await expect(
      call(services, 'files.previewResource', { token, rel: 'leak.txt' }),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });
  });
});
