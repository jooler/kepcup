import { describe, expect, it } from 'vitest';
import type { Bot } from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';
import { HandoverRegistry } from '../../src/handover/registry.js';
import { WikiAdapter, type HandoverWikiPort } from '../../src/handover/adapters/wiki.js';
import { WidgetAdapter, type HandoverWidgetPort } from '../../src/handover/adapters/widget.js';
import type { HandoverContext } from '../../src/handover/types.js';
import type { WidgetHandoverCandidate } from '../../src/widgets/service.js';
import type { WikiCopyOutcome } from '../../src/wiki/service.js';

/**
 * D88 P2 适配器（todo/bot-handover.md §5）：Wiki（目录 / 页 key、wiki_query、同路径置灰与
 * 跳过、批量结果按 key 归属、后台）与组件（只有 Bot 级、同名 / 上限置灰、幂等判据）。依赖
 * 全部用内存桩；真实复制见 handover-wiki-copy.test.ts 与 integration/handover-p2.test.ts。
 */

function makeBot(id: string, name: string, systemRole: Bot['systemRole'] = null): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: '',
    profile: botProfile({ name }),
    status: 'active',
    setupState: null,
    systemRole,
    createdAt: 1,
    updatedAt: 1,
  };
}

const A = makeBot('bot_a', 'A');
const B = makeBot('bot_b', 'B');

function ctx(toBot: Bot | null = B): HandoverContext & { toBot: Bot } {
  return { handoverId: 'hnd_1', fromBot: A, toBot: toBot as Bot, toName: toBot?.name ?? '新人' };
}

function wikiPort(overrides: Partial<HandoverWikiPort> = {}): HandoverWikiPort & {
  copies: Array<{ pages: string[] }>;
  differentInB: Set<string>;
} {
  const pages = [
    { path: 'pages/a.md', bytes: 100 },
    { path: 'pages/ops/b.md', bytes: 2048 },
    { path: 'pages/ops/c.md', bytes: 10 },
    { path: 'pages/ops/deep/d.md', bytes: 5 },
  ];
  const titles: Record<string, string> = {
    'pages/a.md': 'A 页',
    'pages/ops/b.md': '运维 B',
    'pages/ops/c.md': '运维 C',
    'pages/ops/deep/d.md': '深层 D',
  };
  const copies: Array<{ pages: string[] }> = [];
  const differentInB = new Set<string>();
  return {
    copies,
    differentInB,
    exists: (botId) => botId === 'bot_a',
    pageStats: (botId) => (botId === 'bot_a' ? pages : []),
    tree: () => pages.map((page) => ({ path: page.path, title: titles[page.path]! })),
    pageTitle: (_botId, p) => titles[p] ?? p,
    search: (_botId, query) =>
      pages
        .filter((page) => titles[page.path]!.includes(query))
        .map((page) => ({ path: page.path, title: titles[page.path]! })),
    pageConflict: (_from, _to, p) => (differentInB.has(p) ? 'different' : 'absent'),
    copyForHandover: async (input): Promise<WikiCopyOutcome> => {
      copies.push({ pages: input.pages });
      const conflicts = input.pages.filter((p) => differentInB.has(p));
      return {
        copied: input.pages.filter((p) => !differentInB.has(p)),
        conflicts,
        missing: [],
        rawFiles: 1,
        rawConflicts: [],
        assets: 0,
        bytes: 0,
        commit: 'c0ffee',
      };
    },
    ...overrides,
  };
}

describe('wiki adapter', () => {
  it('inventory: whole wiki + topic directories without a query; pages with wiki_query; titles are untrusted', () => {
    const adapter = new WikiAdapter({ wiki: wikiPort(), publish: () => {} });
    expect(adapter.background).toBe(true);
    const dirs = adapter.inventory('bot_a');
    expect(dirs.map((entry) => entry.key)).toEqual([
      'wiki:pages/',
      'wiki:pages/ops/',
      'wiki:pages/ops/deep/',
    ]);
    expect(dirs[0]).toMatchObject({
      label: '整本 Wiki（pages/）',
      detail: '4 页，2.1 KB',
      external: true,
    });
    expect(dirs[1]!.detail).toBe('3 页，2.0 KB');

    const all = adapter.inventory('bot_a', { wikiQuery: '*' }).filter((e) => !e.key.endsWith('/'));
    expect(all.map((entry) => entry.key)).toHaveLength(4);
    const dir = adapter
      .inventory('bot_a', { wikiQuery: 'pages/ops/deep/' })
      .filter((e) => !e.key.endsWith('/'));
    expect(dir.map((entry) => entry.key)).toEqual(['wiki:pages/ops/deep/d.md']);
    const hits = adapter
      .inventory('bot_a', { wikiQuery: '运维' })
      .filter((e) => !e.key.endsWith('/'));
    expect(hits.map((entry) => entry.label)).toEqual(['运维 B', '运维 C']);
    expect(hits[0]).toMatchObject({
      detail: 'pages/ops/b.md，2.0 KB',
      external: true,
      actions: ['copy'],
    });

    expect(adapter.inventory('bot_b')).toEqual([]);
    expect(adapter.summary('bot_a')).toContain('4 页');
    expect(adapter.summary('bot_b')).toBe('没有页面');
  });

  it('resolve: any page / non-empty directory of the source; fabricated or escaping keys are not', () => {
    const adapter = new WikiAdapter({ wiki: wikiPort(), publish: () => {} });
    const registry = new HandoverRegistry([adapter]);
    expect(registry.entry('bot_a', 'wiki:pages/ops/c.md')?.entry.label).toBe('运维 C');
    expect(registry.entry('bot_a', 'wiki:pages/ops/')?.entry.label).toBe('目录 pages/ops/');
    expect(registry.entry('bot_a', 'wiki:pages/nope.md')).toBeNull();
    expect(registry.entry('bot_a', 'wiki:pages/empty/')).toBeNull();
    expect(registry.entry('bot_a', 'wiki:pages/../SCHEMA.md')).toBeNull();
    expect(registry.entry('bot_a', 'wiki:raw/x.md')).toBeNull();
  });

  it('validate: same-path page with other content greys a page key; a directory only warns about the conflicting part', () => {
    const port = wikiPort();
    port.differentInB.add('pages/ops/b.md');
    const adapter = new WikiAdapter({ wiki: port, publish: () => {} });
    expect(adapter.validate(ctx(), 'wiki:pages/ops/b.md', 'copy')).toContain('同路径');
    expect(adapter.validate(ctx(), 'wiki:pages/ops/c.md', 'copy')).toBeNull();
    expect(adapter.validate(ctx(), 'wiki:pages/ops/', 'copy')).toBeNull();
    expect(adapter.validate(ctx(), 'wiki:pages/ops/', 'move')).toBe('Wiki 只能复制');
    expect(adapter.validate(ctx(), 'wiki:pages/gone.md', 'copy')).toContain('已经没有');
    // New target (not created yet): nothing to conflict with.
    expect(adapter.validate(ctx(null), 'wiki:pages/ops/b.md', 'copy')).toBeNull();
    const entry = adapter.resolve('bot_a', 'wiki:pages/ops/')!;
    expect(adapter.warnings(ctx(), entry)).toEqual([
      'B 已有 1 个同路径、内容不同的页，会跳过：pages/ops/b.md',
    ]);
    expect(adapter.describe(entry, 'copy', 'B')).toContain('不覆盖');
  });

  it('applyBatch: one copy for the union of the keys; per-key results; all-conflict key is skipped with the paths', async () => {
    const port = wikiPort();
    port.differentInB.add('pages/a.md');
    const published: unknown[] = [];
    const adapter = new WikiAdapter({
      wiki: port,
      publish: (_e, payload) => published.push(payload),
    });
    const outcomes = await adapter.applyBatch(ctx(), [
      'wiki:pages/ops/',
      'wiki:pages/ops/c.md',
      'wiki:pages/a.md',
    ]);
    expect(port.copies).toHaveLength(1);
    expect(port.copies[0]!.pages.sort()).toEqual([
      'pages/a.md',
      'pages/ops/b.md',
      'pages/ops/c.md',
      'pages/ops/deep/d.md',
    ]);
    expect(outcomes.get('wiki:pages/ops/')).toMatchObject({
      status: 'done',
      result: { copiedCount: 3, skippedPaths: [] },
    });
    expect(outcomes.get('wiki:pages/ops/c.md')).toMatchObject({
      status: 'done',
      result: { copiedCount: 1 },
    });
    expect(outcomes.get('wiki:pages/a.md')).toMatchObject({
      status: 'skipped',
      result: { copiedCount: 0, skippedPaths: ['pages/a.md'] },
    });
    expect((outcomes.get('wiki:pages/a.md') as { reason: string }).reason).toContain('pages/a.md');
    expect(published).toEqual([{ botId: 'bot_b' }]);
  });

  it('applyBatch: a directory with some same-path pages is done and lists the skipped ones', async () => {
    const port = wikiPort();
    port.differentInB.add('pages/ops/b.md');
    const adapter = new WikiAdapter({ wiki: port, publish: () => {} });
    const outcomes = await adapter.applyBatch(ctx(), ['wiki:pages/']);
    expect(outcomes.get('wiki:pages/')).toMatchObject({
      status: 'done',
      result: { copiedCount: 3, skippedPaths: ['pages/ops/b.md'] },
    });
  });
});

function widgetPort(): HandoverWidgetPort & {
  rows: WidgetHandoverCandidate[];
  copies: string[];
  blocked: Map<string, string>;
  copied: Set<string>;
} {
  const rows: WidgetHandoverCandidate[] = [
    {
      widgetId: 'wgt_1',
      title: '记账本',
      description: '每月开销',
      latestVersion: 3,
      versionCount: 3,
      bytes: 4096,
      queriesCount: 2,
      docsCount: 5,
      checkStatus: 'passed',
    },
  ];
  const copies: string[] = [];
  const blocked = new Map<string, string>();
  const copied = new Set<string>();
  return {
    rows,
    copies,
    blocked,
    copied,
    candidates: (botId) => (botId === 'bot_a' ? rows : []),
    conversationScopedCount: (botId) => (botId === 'bot_a' ? 2 : 0),
    findCopy: (widgetId) => (copied.has(widgetId) ? 'wgt_copy' : null),
    blocker: (widgetId) => blocked.get(widgetId) ?? null,
    copy: (widgetId) => {
      copies.push(widgetId);
      copied.add(widgetId);
      return { widgetId: 'wgt_copy', versions: 3 };
    },
  };
}

describe('widget adapter', () => {
  it('inventory lists bot-scope widgets only; conversation-scoped ones only counted', () => {
    const adapter = new WidgetAdapter({ widgets: widgetPort() });
    expect(adapter.background).toBe(true);
    const [entry] = adapter.inventory('bot_a');
    expect(entry).toMatchObject({
      key: 'widget:wgt_1',
      label: '记账本',
      actions: ['copy'],
      external: true,
    });
    expect(entry!.detail).toBe('3 个版本，4.0 KB；2 个查询模板；5 条存储数据；自检通过；每月开销');
    expect(adapter.summary('bot_a')).toContain('2 个会话级组件');
    expect(adapter.summary('bot_b')).toBeNull();
    expect(adapter.describe(entry!, 'copy', 'B')).toContain('不用再确认');
  });

  it('validate greys name collisions / limits; apply copies once; isApplied recognises the copy', async () => {
    const port = widgetPort();
    const adapter = new WidgetAdapter({ widgets: port });
    expect(adapter.validate(ctx(), 'widget:wgt_1', 'copy')).toBeNull();
    expect(adapter.validate(ctx(), 'widget:wgt_1', 'move')).toBe('组件只能复制');
    expect(adapter.validate(ctx(), 'widget:wgt_gone', 'copy')).toContain('已没有');
    port.blocked.set('wgt_1', 'B 已有同名组件「记账本」');
    expect(adapter.validate(ctx(), 'widget:wgt_1', 'copy')).toBe('B 已有同名组件「记账本」');
    expect(adapter.validate(ctx(null), 'widget:wgt_1', 'copy')).toBeNull();
    port.blocked.clear();

    expect(adapter.isApplied(ctx(), 'widget:wgt_1')).toBe(false);
    await expect(adapter.apply(ctx(), 'widget:wgt_1')).resolves.toEqual({
      result: { widgetId: 'wgt_copy', copiedCount: 3 },
    });
    expect(adapter.isApplied(ctx(), 'widget:wgt_1')).toBe(true);
    expect(port.copies).toEqual(['wgt_1']);
  });
});
