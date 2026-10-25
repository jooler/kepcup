import type { WikiPage } from '@kepcup/shared';

/**
 * Wiki 目录浏览的纯逻辑。`pages/**` 在数据层允许子目录（core 的读写删除守卫
 * 都放行 pages/ 子树任意深度，SCHEMA 只是推荐平铺），列表按文件夹 + 页面分层
 * 下钻：文件夹在前、页面在后；根目录只有虚拟的 pages 文件夹与目录（index.md）
 * 一个文档。全部是纯函数。
 */

/** 当前目录下的一行：文件夹（含其下页面总数）或该目录下直接的一页。 */
export type WikiListEntry =
  | { kind: 'dir'; name: string; dir: string; pages: number }
  | { kind: 'page'; page: WikiPage };

/** 页面所在的目录（wiki 根相对，含 pages 前缀；index.md 在根）。 */
export function dirOfPage(pagePath: string): string {
  if (!pagePath.startsWith('pages/')) return '';
  const rest = pagePath.slice('pages/'.length);
  const slash = rest.lastIndexOf('/');
  return slash === -1 ? 'pages' : `pages/${rest.slice(0, slash)}`;
}

/**
 * 当前目录下的条目：根目录（''）只产出虚拟的 pages 文件夹（目录 index.md 由
 * 模板单独渲染）；pages/ 内部则列出子文件夹与直接页面。
 */
export function listWikiDir(pages: readonly WikiPage[], dir: string): WikiListEntry[] {
  if (dir === '') {
    return pages.length === 0 ? [] : [{ kind: 'dir', name: 'pages', dir: 'pages', pages: pages.length }];
  }
  const prefix = `${dir}/`;
  const dirs = new Map<string, number>();
  const files: WikiPage[] = [];
  for (const page of pages) {
    if (!page.path.startsWith(prefix)) continue;
    const rest = page.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(page);
    } else {
      const name = rest.slice(0, slash);
      dirs.set(name, (dirs.get(name) ?? 0) + 1);
    }
  }
  const dirEntries = [...dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({
      kind: 'dir' as const,
      name,
      dir: `${dir}/${name}`,
      pages: count,
    }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return [...dirEntries, ...files.map((page) => ({ kind: 'page' as const, page }))];
}
