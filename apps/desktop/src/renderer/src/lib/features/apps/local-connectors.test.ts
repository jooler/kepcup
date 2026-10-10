import { describe, expect, it } from 'vitest';
import {
  localConnectorOrigin,
  localConnectorSlug,
  type AppCatalogEntry,
  type LocalConnectorCard,
} from '@kepcup/shared';
import {
  canAddLocal,
  cardConnectorId,
  cardExpired,
  isLocalConnectorGone,
  isLocalEntry,
  localCardPhase,
  localConnectorError,
  localEntries,
  localSectionVisible,
  minutesLeft,
  msUntilExpiry,
  removeImpactKey,
  withoutLocalEntries,
} from './local-connectors';
import { mcpChoosesDuration, mcpDurationOptions } from '../approvals/mcp-approval';

/**
 * 本机连接（设计 29 §17）渲染端纯函数：确认卡状态机 / 过期 / 错误映射 / 「本机自建」区的可见性与
 * 目录去重。组件渲染见 e2e `local-connectors.spec.ts`，store 的响应式行为见
 * `stores/apps.svelte.test.ts`。
 */

const card = (overrides: Partial<LocalConnectorCard> = {}): LocalConnectorCard => ({
  proposalId: 'lcp_1',
  title: 'Notes',
  description: '笔记',
  category: 'other',
  mcpUrl: 'https://mcp.example.com/mcp',
  mcpHost: 'mcp.example.com',
  authKind: 'oauth',
  registration: 'dcr',
  issuerHost: 'auth.example.com',
  scopes: [],
  tier: 'developer',
  issuerCrossSite: false,
  warnings: ['w'],
  expiresAt: 1_000_000,
  ...overrides,
});

const entry = (connectorId: string, origin?: AppCatalogEntry['origin']): AppCatalogEntry => ({
  connectorId,
  name: `x/${connectorId}`,
  title: connectorId,
  description: '',
  version: '1.0.0',
  privacyPolicy: 'https://example.com',
  category: 'other',
  tier: origin === 'local' ? 'developer' : 'builtin',
  ...(origin !== undefined ? { origin } : {}),
  authKind: 'oauth',
  registration: 'auto',
  connectable: true,
  scopes: { default: [], write: [] },
  iconDataUri: null,
  connectedAccounts: 0,
  connectionIds: [],
});

describe('目录去重：本机条目只出现在「本机自建」区一次', () => {
  const all = [
    entry('notion', 'bundled'),
    entry('lab', 'local'),
    entry('old'),
    entry('dir', 'directory'),
  ];

  it('预置网格不含 origin=local；本机区只含 origin=local；二者不重叠且无遗漏', () => {
    const grid = withoutLocalEntries(all).map((item) => item.connectorId);
    const local = localEntries(all).map((item) => item.connectorId);
    expect(grid).toEqual(['notion', 'old', 'dir']);
    expect(local).toEqual(['lab']);
    expect([...grid, ...local].sort()).toEqual(all.map((item) => item.connectorId).sort());
    // origin 缺省（旧 core）按预置处理
    expect(isLocalEntry(entry('x'))).toBe(false);
  });
});

describe('localSectionVisible', () => {
  it('开发者模式开启，或已有条目时可见；关闭且无条目时不可见', () => {
    expect(localSectionVisible({ developerMode: false, count: 0 })).toBe(false);
    expect(localSectionVisible({ developerMode: true, count: 0 })).toBe(true);
    expect(localSectionVisible({ developerMode: false, count: 2 })).toBe(true);
    expect(localSectionVisible({ developerMode: true, count: 2 })).toBe(true);
  });
});

describe('确认卡：过期与阶段', () => {
  it('过期判定以 expiresAt 为界（到点即过期）', () => {
    expect(cardExpired(card(), 999_999)).toBe(false);
    expect(cardExpired(card(), 1_000_000)).toBe(true);
    expect(msUntilExpiry(card(), 400_000)).toBe(600_000);
    expect(msUntilExpiry(card(), 2_000_000)).toBe(0);
    expect(minutesLeft(card(), 400_000)).toBe(10);
    expect(minutesLeft(card(), 999_990)).toBe(1);
  });

  it('阶段：ready → expired（时间 / core 报失效）；已添加优先于过期；取消最优先', () => {
    const base = {
      card: card(),
      now: 0,
      alreadyAdded: false,
      staleReported: false,
      rejected: false,
    };
    expect(localCardPhase(base)).toBe('ready');
    expect(localCardPhase({ ...base, now: 1_000_000 })).toBe('expired');
    expect(localCardPhase({ ...base, staleReported: true })).toBe('expired');
    // 重启后卡片重现但条目其实已添加：直接进入连接步骤，即使提案早已过期
    expect(localCardPhase({ ...base, now: 9_999_999, alreadyAdded: true })).toBe('added');
    expect(localCardPhase({ ...base, alreadyAdded: true, rejected: true })).toBe('rejected');
    expect(localCardPhase({ ...base, rejected: true })).toBe('rejected');
  });

  it('卡上 MCP 地址推出的 slug 与 core 同一派生规则', () => {
    const url = 'https://mcp.example.com/mcp';
    expect(cardConnectorId(card({ mcpUrl: url }))).toBe(
      localConnectorSlug(localConnectorOrigin(url)!),
    );
    // 同 origin 不同路径 = 同一条目
    expect(cardConnectorId(card({ mcpUrl: 'https://MCP.example.com:443/other' }))).toBe(
      cardConnectorId(card({ mcpUrl: url })),
    );
    expect(cardConnectorId(card({ mcpUrl: 'not a url' }))).toBeNull();
  });
});

describe('canAddLocal：防重复提交与跨站授权服务器的显式确认（评审 A1）', () => {
  const base = { phase: 'ready' as const, acknowledged: false, busy: false };

  it('普通卡片：ready 且不忙才可添加', () => {
    const c = card({ issuerCrossSite: false });
    expect(canAddLocal({ ...base, card: c })).toBe(true);
    expect(canAddLocal({ ...base, card: c, busy: true })).toBe(false); // 在途：不可重复点
    for (const phase of ['expired', 'added', 'rejected'] as const) {
      expect(canAddLocal({ ...base, card: c, phase })).toBe(false);
    }
  });

  it('跨站授权服务器：没勾选「我了解」就不可添加，勾选后可添加', () => {
    const c = card({ issuerCrossSite: true });
    expect(canAddLocal({ ...base, card: c })).toBe(false);
    expect(canAddLocal({ ...base, card: c, acknowledged: true })).toBe(true);
    expect(canAddLocal({ ...base, card: c, acknowledged: true, busy: true })).toBe(false);
    expect(canAddLocal({ ...base, card: c, acknowledged: true, phase: 'expired' })).toBe(false);
  });
});

describe('错误映射', () => {
  const err = (code: string, message = 'm') => Object.assign(new Error(message), { code });

  it('三个本机连接错误码映射到清晰文案；过期 / 已处理标记为失效', () => {
    expect(localConnectorError(err('LOCAL_CONNECTOR_EXPIRED'))).toEqual({
      key: 'apps.local.error.expired',
      stale: true,
    });
    expect(localConnectorError(err('DEVELOPER_MODE_REQUIRED'))).toEqual({
      key: 'apps.local.error.developerMode',
      stale: false,
    });
    expect(localConnectorError(err('LOCAL_CONNECTOR_ACK_REQUIRED'))).toEqual({
      key: 'apps.local.error.ackRequired',
      stale: false,
    });
    expect(localConnectorError(err('LOCAL_CONNECTOR_REJECTED', '已达上限'))).toEqual({
      key: 'apps.local.error.rejected',
      stale: false,
      detail: '已达上限',
    });
    expect(localConnectorError(err('INTERNAL'))).toBeNull();
    expect(localConnectorError(new Error('x'))).toBeNull();
    expect(localConnectorError(undefined)).toBeNull();
  });

  it('remove 的 NOT_FOUND 当作已删除', () => {
    expect(isLocalConnectorGone(err('NOT_FOUND'))).toBe(true);
    expect(isLocalConnectorGone(err('INTERNAL'))).toBe(false);
  });

  it('删除确认文案按账号数区分', () => {
    expect(removeImpactKey(0)).toBe('apps.local.remove.noAccounts');
    expect(removeImpactKey(3)).toBe('apps.local.remove.withAccounts');
  });
});

describe('developer 分级的审批卡只给「仅这一次」', () => {
  it('core 对本机连接下发 durations=[once]：不显示时长选择', () => {
    expect(mcpDurationOptions({ durations: ['once'] })).toEqual(['once']);
    expect(mcpChoosesDuration({ durations: ['once'] })).toBe(false);
    // 对照：builtin 的写入档仍有三档
    expect(mcpChoosesDuration({ durations: ['once', 'conversation', 'bot'] })).toBe(true);
  });
});
