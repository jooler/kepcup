import { describe, expect, it } from 'vitest';

import { dirOfPage, listWikiDir, type WikiListEntry } from './wiki-browse';
import type { WikiPage } from '@kepcup/shared';

/**
 * Wiki 目录浏览纯逻辑：`pages/**` 允许子目录（core 守卫放行 pages/ 子树任意
 * 深度），列表按文件夹 + 页面分层下钻（文件夹在前）；根目录只有虚拟的 pages
 * 文件夹（目录 index.md 由模板单独渲染），页面定位其所在目录（含 pages 前缀）。
 */

function page(path: string, title = path): WikiPage {
  return { path, title };
}

function kinds(entries: readonly WikiListEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

function pageEntries(entries: readonly WikiListEntry[]): WikiPage[] {
  return entries
    .filter((entry): entry is Extract<WikiListEntry, { kind: 'page' }> => entry.kind === 'page')
    .map((entry) => entry.page);
}

function dirEntries(entries: readonly WikiListEntry[]): Array<Extract<WikiListEntry, { kind: 'dir' }>> {
  return entries.filter(
    (entry): entry is Extract<WikiListEntry, { kind: 'dir' }> => entry.kind === 'dir',
  );
}

describe('dirOfPage', () => {
  it('根页面（index.md）为空串，pages/ 下页面所在目录含 pages 前缀', () => {
    expect(dirOfPage('pages/deploy.md')).toBe('pages');
    expect(dirOfPage('pages/guides/rollback.md')).toBe('pages/guides');
    expect(dirOfPage('pages/a/b/c.md')).toBe('pages/a/b');
    expect(dirOfPage('index.md')).toBe('');
  });
});

describe('listWikiDir', () => {
  const pages = [
    page('pages/deploy.md', '部署指南'),
    page('pages/guides/rollback.md', '回滚指南'),
    page('pages/guides/search.md', '检索指南'),
    page('pages/guides/advanced/deep.md', '深层页'),
    page('pages/api.md', 'API'),
  ];

  it('根目录：只有虚拟的 pages 文件夹（计数 = 全部页面）', () => {
    expect(listWikiDir(pages, '')).toEqual([
      { kind: 'dir', name: 'pages', dir: 'pages', pages: 5 },
    ]);
    expect(listWikiDir([], '')).toEqual([]);
  });

  it('pages 目录：子文件夹在前（带子树页面数），直接页面在后', () => {
    const entries = listWikiDir(pages, 'pages');
    expect(kinds(entries)).toEqual(['dir', 'page', 'page']);
    expect(entries[0]).toEqual({ kind: 'dir', name: 'guides', dir: 'pages/guides', pages: 3 });
    expect(pageEntries(entries.slice(1)).map((page) => page.path)).toEqual([
      'pages/api.md',
      'pages/deploy.md',
    ]);
  });

  it('子目录：只列该目录的直接内容，下级文件夹继续聚合', () => {
    const entries = listWikiDir(pages, 'pages/guides');
    expect(kinds(entries)).toEqual(['dir', 'page', 'page']);
    expect(entries[0]).toEqual({
      kind: 'dir',
      name: 'advanced',
      dir: 'pages/guides/advanced',
      pages: 1,
    });
    expect(pageEntries(entries.slice(1)).map((page) => page.title)).toEqual([
      '回滚指南',
      '检索指南',
    ]);
  });

  it('文件夹名排序按 localeCompare，页面按路径排序；不改动入参', () => {
    const reversed = [page('pages/b/x.md'), page('pages/a.md'), page('pages/a/z.md')];
    const entries = listWikiDir(reversed, 'pages');
    expect(dirEntries(entries).map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(reversed.map((p) => p.path)).toEqual(['pages/b/x.md', 'pages/a.md', 'pages/a/z.md']);
  });
});
