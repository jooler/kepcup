import { describe, expect, it } from 'vitest';
import type { AppCatalogEntry, AppConnection } from '@kepcup/shared';
import {
  catalogAction,
  isConnectionGone,
  toolsLoadableStatus,
  catalogLoadState,
  catalogView,
  manageTarget,
  showManageButton,
} from '../apps/app-catalog';

/**
 * 扩展中心「连接」组的视图逻辑（卡片 / 已连接状态与账号数 / 「管理」去向 / 目录加载态）。
 * 组件本身没有 DOM 测试环境，逻辑都落在这些纯函数里；真实渲染见
 * e2e `extension-center.spec.ts`。发行门禁的语义由 core `connector-catalog.test.ts` 覆盖。
 */

function entry(connectorId: string, overrides: Partial<AppCatalogEntry> = {}): AppCatalogEntry {
  return {
    connectorId,
    name: `com.example/${connectorId}`,
    title: connectorId[0]!.toUpperCase() + connectorId.slice(1),
    description: `${connectorId} tools`,
    version: '1.0.0',
    privacyPolicy: 'https://example.com/privacy',
    category: 'productivity',
    tier: 'builtin',
    authKind: 'oauth',
    registration: 'auto',
    connectable: true,
    scopes: { default: [], write: [] },
    iconDataUri: null,
    connectedAccounts: 0,
    connectionIds: [],
    ...overrides,
  };
}

function connection(id: string, connectorId: string): Pick<AppConnection, 'id' | 'connectorId'> {
  return { id, connectorId };
}

describe('目录卡片：非空目录', () => {
  const catalog = [
    entry('linear', { connectedAccounts: 2, connectionIds: ['c1', 'c2'] }),
    entry('notion'),
  ];

  it('渲染所有条目；已连接的显示账号数并改按钮为「再连一个账号」', () => {
    const view = catalogView(catalog, {});
    expect(view.map((item) => item.connectorId)).toEqual(['linear', 'notion']);
    const linear = view.find((item) => item.connectorId === 'linear')!;
    expect(linear.connectedAccounts).toBe(2);
    expect(catalogAction(linear).labelKey).toBe('apps.catalog.connectAnother');
    expect(catalogAction(view.find((item) => item.connectorId === 'notion')!).labelKey).toBe(
      'apps.catalog.connect',
    );
  });

  it('「管理」只在有宿主入口且该应用已有账号时出现', () => {
    expect(showManageButton(catalog[0]!, true)).toBe(true);
    expect(showManageButton(catalog[1]!, true)).toBe(false);
    expect(showManageButton(catalog[0]!, false)).toBe(false);
  });
});

describe('manageTarget（点「管理」去哪）', () => {
  it('单个账号直进详情', () => {
    expect(
      manageTarget([connection('c1', 'linear'), connection('c9', 'notion')], 'linear'),
    ).toEqual({ kind: 'detail', connectionId: 'c1' });
  });

  it('多个账号先列出来', () => {
    expect(
      manageTarget([connection('c1', 'linear'), connection('c2', 'linear')], 'linear'),
    ).toEqual({ kind: 'list' });
  });

  it('没有账号（或只有自定义 server 的占位连接）→ none', () => {
    expect(manageTarget([], 'linear')).toEqual({ kind: 'none' });
    expect(manageTarget([connection('custom:linear', 'custom:linear')], 'custom:linear')).toEqual({
      kind: 'none',
    });
  });
});

describe('catalogLoadState（目录读取失败不再一直「正在读取」）', () => {
  it('未加载且无错误 → loading；未加载且有错误 → error（显示重试）', () => {
    expect(catalogLoadState({ loaded: false, error: null })).toBe('loading');
    expect(catalogLoadState({ loaded: false, error: 'boom' })).toBe('error');
  });

  it('加载成功过之后刷新失败仍显示旧目录', () => {
    expect(catalogLoadState({ loaded: true, error: null })).toBe('ready');
    expect(catalogLoadState({ loaded: true, error: 'later failure' })).toBe('ready');
  });
});

describe('详情页的加载守卫', () => {
  it('只有能向 server 拉清单的状态才去拉工具；授权没了 / 过期 / 缺权限 / 连接中只读本地授权记录', () => {
    for (const status of ['connected', 'tools_changed', 'disabled'] as const) {
      expect(toolsLoadableStatus(status), status).toBe(true);
    }
    for (const status of [
      'not_connected',
      'connecting',
      'expired',
      'needs_scope',
      'error',
    ] as const) {
      expect(toolsLoadableStatus(status), status).toBe(false);
    }
  });

  it('「连接不存在」是终局：不重试、不弹 toast', () => {
    expect(isConnectionGone({ code: 'APP_CONNECTION_NOT_FOUND' })).toBe(true);
    expect(isConnectionGone({ code: 'INTERNAL' })).toBe(false);
    expect(isConnectionGone(new Error('x'))).toBe(false);
    expect(isConnectionGone(undefined)).toBe(false);
  });
});
