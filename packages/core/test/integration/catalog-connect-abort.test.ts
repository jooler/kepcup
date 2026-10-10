import { afterEach, describe, expect, it } from 'vitest';
import type { AppCatalogEntry, AppConnection } from '@kepcup/shared';
import { until, startCatalogEnv, type CatalogEnv } from '../support/catalog-connect-env.js';

/**
 * 目录应用「首次连接没走完」的收尾（用户实测的 Linear 场景）：授权一开始 core 就建了一行
 * 临时行（`connecting`，无令牌），取消 / 超时 / 拒绝授权都会把它删掉。要求：
 * - 进行中的临时行不算已连接账号（`apps.connections.list` 不含、`apps.catalog.list` 的
 *   `connectedAccounts` 为 0）——否则卡片会显示「已连接 1 个账号」；
 * - 行被删时事件带 `removed: true`（渲染端据此移除，而不是把幽灵行改成 not_connected）；
 * - 数据库里不留行 / 令牌，目录账号数仍为 0。
 */

const envs: CatalogEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0).reverse()) await env.cleanup();
});
async function start(options: Parameters<typeof startCatalogEnv>[0] = {}): Promise<CatalogEnv> {
  const env = await startCatalogEnv(options);
  envs.push(env);
  return env;
}

const storeRows = (env: CatalogEnv): AppConnection[] => env.core.services.apps!.store.list();

async function listed(env: CatalogEnv): Promise<AppConnection[]> {
  return (
    (await env.core.rpc.call('apps.connections.list', {})) as { connections: AppConnection[] }
  ).connections;
}

async function accounts(env: CatalogEnv): Promise<number> {
  const { entries } = (await env.core.rpc.call('apps.catalog.list', undefined)) as {
    entries: AppCatalogEntry[];
  };
  return entries.find((entry) => entry.connectorId === env.slug)!.connectedAccounts;
}

async function startFlow(env: CatalogEnv): Promise<string> {
  const { flowId } = (await env.core.rpc.call('apps.connect', {
    target: { kind: 'catalog', connectorId: env.slug },
  })) as { flowId: string };
  return flowId;
}

function assertClean(env: CatalogEnv): void {
  expect(storeRows(env)).toHaveLength(0);
  expect(env.core.services.domain!.secrets.names().filter((n) => n.startsWith('conn:'))).toEqual(
    [],
  );
}

function expectRemovedEvent(env: CatalogEnv, connectionId: string): void {
  expect(env.statusEvents).toContainEqual({
    connectionId,
    status: 'not_connected',
    removed: true,
  });
}

describe('目录首次连接没走完：临时行不算账号，收尾后不留痕', () => {
  it('授权页开着、用户没授权就取消：进行中不计账号；取消后行已删、事件带 removed', async () => {
    const env = await start({ browser: 'none', fake: { tools: [] } });
    const flowId = await startFlow(env);
    await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'awaiting_browser'),
      10_000,
      'awaiting browser',
    );
    // 临时行存在，但不是账号。
    const scratch = storeRows(env);
    expect(scratch).toHaveLength(1);
    expect(scratch[0]!.status).toBe('connecting');
    expect(await listed(env)).toEqual([]);
    expect(await accounts(env)).toBe(0);

    await env.core.rpc.call('apps.connect.cancel', { flowId });
    await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'cancelled'),
      10_000,
      'cancelled',
    );
    assertClean(env);
    expect(await accounts(env)).toBe(0);
    expectRemovedEvent(env, scratch[0]!.id);
  });

  it('超时：失败收尾同样删行、带 removed', async () => {
    const env = await start({ browser: 'none', flowTimeoutMs: 1_500, fake: { tools: [] } });
    const flowId = await startFlow(env);
    const failed = await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'failed'),
      10_000,
      'timeout',
    );
    expect(failed.error?.code).toBe('OAUTH_FLOW_TIMEOUT');
    assertClean(env);
    expect(await accounts(env)).toBe(0);
    expect(env.statusEvents.some((e) => e.removed === true)).toBe(true);
  });

  it('授权页拒绝（access_denied）：失败收尾删行、带 removed', async () => {
    const env = await start({ fake: { tools: [], authorizeError: 'access_denied' } });
    const flowId = await startFlow(env);
    const failed = await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'failed'),
      10_000,
      'denied',
    );
    expect(failed.error?.code).toBeDefined();
    assertClean(env);
    expect(await accounts(env)).toBe(0);
    expect(env.statusEvents.some((e) => e.removed === true)).toBe(true);
  });

  it('工具复核阶段取消：账号已建但被撤销清除，事件带 removed，账号数回到 0', async () => {
    const env = await start({ fake: { tools: [{ name: 'echo', description: 'Echo' }] } });
    const outcome = await env.connect({ review: 'cancel' });
    expect(outcome.last.phase).toBe('cancelled');
    assertClean(env);
    expect(await accounts(env)).toBe(0);
    expect(env.statusEvents.some((e) => e.removed === true)).toBe(true);
  });

  it('成功连接后：账号计 1、列表含它；断开（删行）事件带 removed，账号数回到 0', async () => {
    const env = await start({ fake: { tools: [{ name: 'echo', description: 'Echo' }] } });
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    expect(await accounts(env)).toBe(1);
    expect(await listed(env)).toHaveLength(1);

    const id = outcome.last.connectionId!;
    await env.core.rpc.call('apps.disconnect', { connectionId: id });
    expect(await accounts(env)).toBe(0);
    expectRemovedEvent(env, id);
  });
});
