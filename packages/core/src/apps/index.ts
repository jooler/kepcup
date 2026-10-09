import { KEPCUP_OAUTH_CLIENT_ID } from '@kepcup/shared';
import type { SecretsService } from '../domain/secrets.js';
import type { SettingsService } from '../domain/settings.js';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { EventBus } from '../infra/events.js';
import type { CoreLogger } from '../infra/logger.js';
import type { CoreEventsMap } from '../start-types.js';
import { ConnectFlowManager, type ConnectionInvalidator } from './auth/flow.js';
import { AppConnectionStore, isCustomConnectionId } from './connection-store.js';
import type { ShellHostRpc } from './shell-facade.js';
import { TokenVault } from './token-vault.js';

/**
 * 连接应用（D73）的服务束：Token Vault、连接行存取、交互授权流程管理器。
 *
 * `start.ts` 在域服务阶段构造一次（`CoreServices.apps`），RPC 绑定（`rpc/apps-bindings.ts`）
 * 与运行时授权（`ConnectionAuthRegistry` / `McpService`，另一条线）都从它取依赖：
 *
 * - `store` / `vault`：运行时 provider 与 registry 共用同一份（令牌只经 Vault）；
 * - `flows`：交互授权；完成后调用 `invalidator.invalidate(connectionId)` ——registry 构造后用
 *   {@link AppServices.attachRegistry} 接入（registry 满足 {@link ConnectionInvalidator}）；
 * - `cimdClientId` / `loopbackAllowlist`：registry 刷新时必须与交互流程用**同一份**值（测试里
 *   CIMD URL 与回环白名单都可经 `CoreServicesOptions` 覆盖，生产恒为常量 / 空）。
 */
export interface AppServices {
  store: AppConnectionStore;
  vault: TokenVault;
  flows: ConnectFlowManager;
  /** 生效的 CIMD `client_id`：生产恒为 `KEPCUP_OAUTH_CLIENT_ID`，仅 NODE_ENV=test 可覆盖。 */
  cimdClientId: string;
  /** 额外允许明文 / 私网访问的回环主机；生产恒为空，仅 NODE_ENV=test 可注入。 */
  loopbackAllowlist: readonly string[];
  /** 把运行时 registry 接入交互流程（授权完成后失效其缓存、重置 server 失败计数）。 */
  attachRegistry(registry: ConnectionInvalidator): void;
  /** 应用退出：取消所有进行中的流程并等待清理。 */
  shutdown(): Promise<void>;
}

/** 仅 NODE_ENV=test 且包含测试钩子的构建才生效的注入点（照 `KEPCUP_KEYSTORE`）。 */
export interface AppServicesTestOptions {
  /** 覆盖 CIMD URL（测试用 testkit 文件服务托管的 http 文档）。 */
  cimdUrl?: string | undefined;
  /** 允许访问的回环主机（`hostname` 或 `host:port`）。 */
  loopbackAllowlist?: readonly string[] | undefined;
  /** 回调固定候选端口（避开并行用例的端口争用）。 */
  callbackPorts?: readonly number[] | undefined;
  /** 流程总时限。 */
  flowTimeoutMs?: number | undefined;
}

export interface CreateAppServicesDeps {
  db: SqliteDatabase;
  secrets: SecretsService;
  settings: Pick<SettingsService, 'get'>;
  clock: Clock;
  logger: CoreLogger;
  events: Pick<EventBus<CoreEventsMap>, 'emit'>;
  shell: ShellHostRpc;
  env: NodeJS.ProcessEnv;
  /** `__KEPCUP_TEST_HOOKS__`：打包产物里恒为 false，测试注入点整体剔除。 */
  testHooks: boolean;
  test?: AppServicesTestOptions | undefined;
}

/**
 * 启动时收拾上次未正常退出留下的 `connecting` 行（交互流程只存在于进程内存，崩溃 / 强杀后
 * 不会有人把它改回来，界面会一直显示「连接中」）：已有令牌 → `connected`（令牌已过期且无
 * refresh token 则 `expired`）；没有令牌 → `not_connected`。返回被修正的连接 id。
 */
export function recoverInterruptedConnections(deps: {
  store: AppConnectionStore;
  vault: TokenVault;
  clock: Clock;
  logger: CoreLogger;
}): string[] {
  const recovered: string[] = [];
  for (const row of deps.store.list({ includeCustom: true })) {
    if (row.status !== 'connecting') continue;
    const tokens = deps.vault.getTokens(row.id);
    if (tokens === null && !isCustomConnectionId(row.id)) {
      // 目录连接的临时行（流程中途崩溃）：没有令牌就没有任何价值，直接删除。
      deps.store.delete(row.id);
      recovered.push(row.id);
      deps.logger.info({ connectionId: row.id }, 'dropped interrupted catalog connection');
      continue;
    }
    const expired =
      tokens !== null &&
      tokens.refreshToken === undefined &&
      tokens.expiresAt !== null &&
      tokens.expiresAt <= deps.clock.now();
    const status = tokens === null ? 'not_connected' : expired ? 'expired' : 'connected';
    deps.store.setStatus(row.id, status);
    recovered.push(row.id);
    deps.logger.info({ connectionId: row.id, status }, 'reset interrupted app connection');
  }
  return recovered;
}

export function createAppServices(deps: CreateAppServicesDeps): AppServices {
  const testing = deps.testHooks && deps.env.NODE_ENV === 'test';
  const test = testing ? (deps.test ?? {}) : {};
  const cimdClientId = test.cimdUrl ?? KEPCUP_OAUTH_CLIENT_ID;
  const loopbackAllowlist = test.loopbackAllowlist ?? [];

  const store = new AppConnectionStore({ db: deps.db, clock: deps.clock });
  const vault = new TokenVault({ secrets: deps.secrets, store, clock: deps.clock });
  recoverInterruptedConnections({ store, vault, clock: deps.clock, logger: deps.logger });
  const flows = new ConnectFlowManager({
    store,
    vault,
    settings: deps.settings,
    shell: deps.shell,
    events: deps.events,
    logger: deps.logger,
    clock: deps.clock,
    cimdUrl: cimdClientId,
    // 生产路径断言 CIMD URL 为 https（构造时抛错）；只有测试覆盖才允许 http。
    allowInsecureCimdUrl: test.cimdUrl !== undefined,
    loopbackAllowlist,
    ...(test.callbackPorts !== undefined ? { callbackPorts: test.callbackPorts } : {}),
    ...(test.flowTimeoutMs !== undefined ? { flowTimeoutMs: test.flowTimeoutMs } : {}),
  });
  return {
    store,
    vault,
    flows,
    cimdClientId,
    loopbackAllowlist,
    attachRegistry: (registry) => flows.attachInvalidator(registry),
    shutdown: () => flows.shutdown(),
  };
}
