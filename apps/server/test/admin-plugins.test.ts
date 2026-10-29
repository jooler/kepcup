import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@kepcup/shared';
import { handleAdminRequest, type AdminDeps } from '../src/admin.js';

/**
 * `/admin/plugins/*` (D104 P2 step 7): loopback + token guard, POST JSON endpoints,
 * AppError → 400 and unexpected failures → 500 without leaking details.
 */

interface CallOptions {
  path: string;
  method?: string;
  address?: string;
  token?: string | null;
  body?: string;
}

async function call(
  deps: AdminDeps,
  options: CallOptions,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as unknown });
      },
    } as unknown as ServerResponse;
    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
    Object.assign(req, {
      method: options.method ?? 'POST',
      headers:
        options.token === null
          ? {}
          : { authorization: `Bearer ${options.token ?? 'secret-token'}` },
      socket: { remoteAddress: options.address ?? '127.0.0.1' },
      destroy() {
        // readJson calls destroy() on oversize bodies; nothing to release in the fake.
      },
    });
    handleAdminRequest(deps, req, res, options.path);
    process.nextTick(() => {
      if (options.body !== undefined) req.emit('data', Buffer.from(options.body));
      req.emit('end');
    });
  });
}

function deps(overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    token: 'secret-token',
    pair: () => ({}) as never,
    status: () => ({}) as never,
    pendingRequests: () => [],
    confirmPairing: () => ({ status: 'paired' }),
    devices: () => ({ devices: [] }),
    revoke: () => ({}) as never,
    pluginsInspect: async (input) => ({ inspected: input }),
    pluginsInstall: async (input) => ({ installed: input }),
    ...overrides,
  };
}

const SOURCE = { source: { kind: 'file', path: '/tmp/demo.kepcup' } };

describe('/admin/plugins/*', () => {
  it('rejects non-loopback callers before the token check', async () => {
    const result = await call(deps(), {
      path: '/admin/plugins/inspect',
      address: '10.0.0.7',
      body: JSON.stringify(SOURCE),
    });
    expect(result.status).toBe(403);
  });

  it('rejects a wrong token', async () => {
    const result = await call(deps(), {
      path: '/admin/plugins/install',
      token: 'wrong',
      body: JSON.stringify(SOURCE),
    });
    expect(result.status).toBe(401);
  });

  it('inspects and installs with the parsed body', async () => {
    const inspect = vi.fn(async (input: unknown) => ({ seen: input }));
    const install = vi.fn(async (input: unknown) => ({ seen: input }));
    const first = await call(deps({ pluginsInspect: inspect }), {
      path: '/admin/plugins/inspect',
      body: JSON.stringify(SOURCE),
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ seen: SOURCE });
    expect(inspect).toHaveBeenCalledWith(SOURCE);

    const second = await call(deps({ pluginsInstall: install }), {
      path: '/admin/plugins/install',
      body: JSON.stringify({ ...SOURCE, sha256: 'a'.repeat(64), userConfig: {} }),
    });
    expect(second.status).toBe(200);
    expect(install).toHaveBeenCalledOnce();
  });

  it('maps AppError to 400 with its code', async () => {
    const result = await call(
      deps({
        pluginsInspect: async () => {
          throw new AppError('PLUGIN_INVALID', '包内路径不安全');
        },
      }),
      { path: '/admin/plugins/inspect', body: JSON.stringify(SOURCE) },
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: '包内路径不安全', code: 'PLUGIN_INVALID' });
  });

  it('maps unexpected failures to a generic 500 and hands the cause to onInternalError', async () => {
    const onInternalError = vi.fn();
    const failure = new Error('secret detail');
    const result = await call(
      deps({
        pluginsInstall: async () => {
          throw failure;
        },
        onInternalError,
      }),
      { path: '/admin/plugins/install', body: JSON.stringify(SOURCE) },
    );
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'internal' });
    expect(onInternalError).toHaveBeenCalledWith('/admin/plugins/install', failure);
  });

  it('does not report AppError (400) failures as internal errors', async () => {
    const onInternalError = vi.fn();
    await call(
      deps({
        pluginsInspect: async () => {
          throw new AppError('INVALID_INPUT', '请求体不符合要求：source.kind');
        },
        onInternalError,
      }),
      { path: '/admin/plugins/inspect', body: JSON.stringify({ source: { kind: 'url' } }) },
    );
    expect(onInternalError).not.toHaveBeenCalled();
  });

  it('rejects bodies over 64KB', async () => {
    const inspect = vi.fn(async () => ({ ok: true }));
    const result = await call(deps({ pluginsInspect: inspect }), {
      path: '/admin/plugins/inspect',
      body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid request body' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('only accepts POST', async () => {
    const result = await call(deps(), { path: '/admin/plugins/inspect', method: 'GET' });
    expect(result.status).toBe(404);
  });
});
