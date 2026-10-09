import { afterEach, describe, expect, it } from 'vitest';
import { recoverInterruptedConnections } from '../../src/apps/index.js';
import { openAppAuthEnv, type AppAuthEnv } from '../support/app-auth-env.js';

/** 启动时收拾上次未正常退出留下的 `connecting` 行（D73 P0 + 目录连接的临时行）。 */

let app: AppAuthEnv | undefined;
afterEach(() => {
  app?.dispose();
  app = undefined;
});

const LOGGER = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe('recoverInterruptedConnections', () => {
  it('drops catalog scratch rows without tokens; resets custom rows; keeps token holders', () => {
    app = openAppAuthEnv();
    const { store, vault, env } = app;
    const scratch = store.create({
      connectorId: 'notion',
      label: 'tmp',
      serverUrl: 'https://x/mcp',
      status: 'connecting',
    });
    const custom = store.ensureCustom('mine', {
      label: 'mine',
      serverUrl: 'https://y/mcp',
      status: 'connecting',
    });
    const withTokens = store.create({
      connectorId: 'notion',
      label: 'ok',
      serverUrl: 'https://x/mcp',
      status: 'connecting',
    });
    vault.saveTokens(withTokens.id, {
      access_token: 'tok-access-1',
      token_type: 'Bearer',
      refresh_token: 'tok-refresh-1',
    });

    const recovered = recoverInterruptedConnections({
      store,
      vault,
      clock: env.clock,
      logger: LOGGER,
    });

    expect(recovered.sort()).toEqual([scratch.id, custom.id, withTokens.id].sort());
    expect(store.get(scratch.id)).toBeNull();
    expect(store.get(custom.id)!.status).toBe('not_connected');
    expect(store.get(withTokens.id)!.status).toBe('connected');
  });
});
