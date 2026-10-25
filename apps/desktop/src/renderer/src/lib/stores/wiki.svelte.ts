import type {
  WikiHistoryEntry,
  WikiOwner,
  WikiPage,
  WikiSearchHit,
  WikiSourceView,
} from '@kepcup/shared';
import { wikiOwnerKey } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { t } from '$lib/i18n';
import { dirOfPage } from '$lib/features/wiki/wiki-browse';

/**
 * Wiki browsing state (P09 right panel; owner-partitioned in D92 T1b WP10 so
 * the bot panel and a project's Wiki tab can be open at the same time): one
 * page-tree slot per `wikiOwnerKey(owner)`, loaded on demand; `wiki_changed`
 * events refresh every loaded owner (ingest completions, dedupe skips, lint
 * commits and source removals all publish it, BR-P09-012).
 */

/** 浏览位置（面包屑与下屏内容都由它推导）：列表 / 目录下钻 / 页面 / 历史。 */
export interface WikiNav {
  /** 列表视图当前目录（wiki 根相对，含 pages 前缀：'' | 'pages' | 'pages/…'）。 */
  dir: string;
  /** 列表视图打开的页面（wiki 根相对路径；null = 列表）。 */
  pagePath: string | null;
  /** 下屏视图：页面树 / 搜索，或变更历史。 */
  mode: 'list' | 'history';
  /** 历史视图打开的提交（null = 提交列表）。 */
  historyCommit: string | null;
  /** 历史快照内当前目录（与 dir 同语义，作用于该次提交的页面集）。 */
  historyDir: string;
  /** 历史视图打开的快照页面。 */
  historyPagePath: string | null;
}

const EMPTY_NAV: WikiNav = {
  dir: '',
  pagePath: null,
  mode: 'list',
  historyCommit: null,
  historyDir: '',
  historyPagePath: null,
};

/** 一条面包屑：label + 可选跳转（末段 = 当前位置，不可点）。 */
export interface WikiCrumb {
  label: string;
  onJump?: () => void;
}

class WikiState {
  pages = $state<Record<string, WikiPage[]>>({});
  loading = $state<Record<string, boolean>>({});
  /** 浏览位置（per owner）：WikiBrowser 渲染下屏，右栏 DetailHeader 画面包屑。 */
  nav = $state<Record<string, WikiNav>>({});
  history = $state<Record<string, WikiHistoryEntry[]>>({});
  historyLoading = $state<Record<string, boolean>>({});
  #loaded = new Set<string>();
  #historyLoaded = new Set<string>();
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('wiki_changed', (payload) => {
      const data = payload as { owner?: { kind: 'bot' | 'project'; id: string } };
      if (data.owner === undefined) return;
      const key = wikiOwnerKey(data.owner);
      if (this.#loaded.has(key)) void this.load(data.owner, true);
    });
  }

  pagesOf(owner: WikiOwner): WikiPage[] {
    return this.pages[wikiOwnerKey(owner)] ?? [];
  }

  loadingOf(owner: WikiOwner): boolean {
    return this.loading[wikiOwnerKey(owner)] === true;
  }

  navOf(owner: WikiOwner): WikiNav {
    return this.nav[wikiOwnerKey(owner)] ?? EMPTY_NAV;
  }

  #setNav(owner: WikiOwner, nav: WikiNav): void {
    this.nav[wikiOwnerKey(owner)] = nav;
  }

  // --- 浏览位置（目录 / 页面） -------------------------------------------------

  /** 进入某目录（空串 = 根），同时离开页面与历史视图。 */
  openDir(owner: WikiOwner, dir: string): void {
    this.#setNav(owner, {
      dir,
      pagePath: null,
      mode: 'list',
      historyCommit: null,
      historyDir: '',
      historyPagePath: null,
    });
  }

  /** 打开页面：所在目录成为当前目录（返回列表时落在页面这一层）。 */
  openPage(owner: WikiOwner, path: string): void {
    this.#setNav(owner, {
      dir: dirOfPage(path),
      pagePath: path,
      mode: 'list',
      historyCommit: null,
      historyDir: '',
      historyPagePath: null,
    });
  }

  closePage(owner: WikiOwner): void {
    this.#setNav(owner, { ...this.navOf(owner), pagePath: null });
  }

  // --- 浏览位置（历史视图） ----------------------------------------------------

  openHistory(owner: WikiOwner): void {
    this.#setNav(owner, {
      ...this.navOf(owner),
      mode: 'history',
      historyCommit: null,
      historyDir: '',
      historyPagePath: null,
    });
  }

  closeHistory(owner: WikiOwner): void {
    this.#setNav(owner, {
      ...this.navOf(owner),
      mode: 'list',
      historyCommit: null,
      historyDir: '',
      historyPagePath: null,
    });
  }

  openHistoryCommit(owner: WikiOwner, oid: string): void {
    this.#setNav(owner, {
      ...this.navOf(owner),
      historyCommit: oid,
      historyDir: '',
      historyPagePath: null,
    });
  }

  closeHistoryCommit(owner: WikiOwner): void {
    this.#setNav(owner, {
      ...this.navOf(owner),
      historyCommit: null,
      historyDir: '',
      historyPagePath: null,
    });
  }

  /** 快照内进入某目录（空串 = 快照根），同时离开快照页面。 */
  openHistoryDir(owner: WikiOwner, dir: string): void {
    this.#setNav(owner, { ...this.navOf(owner), historyDir: dir, historyPagePath: null });
  }

  openHistoryPage(owner: WikiOwner, path: string): void {
    this.#setNav(owner, {
      ...this.navOf(owner),
      historyDir: dirOfPage(path),
      historyPagePath: path,
    });
  }

  closeHistoryPage(owner: WikiOwner): void {
    this.#setNav(owner, { ...this.navOf(owner), historyPagePath: null });
  }

  // --- 数据 -------------------------------------------------------------------

  async load(owner: WikiOwner, force = false): Promise<void> {
    const key = wikiOwnerKey(owner);
    if (!force && this.#loaded.has(key)) return;
    this.loading[key] = true;
    try {
      const result = (await core.call('wiki.tree', { owner })) as { pages: WikiPage[] };
      this.pages[key] = result.pages;
      this.#loaded.add(key);
    } finally {
      this.loading[key] = false;
    }
  }

  async page(
    owner: WikiOwner,
    path: string,
  ): Promise<{ path: string; title: string; content: string }> {
    return (await core.call('wiki.page', { owner, path })) as {
      path: string;
      title: string;
      content: string;
    };
  }

  async search(owner: WikiOwner, query: string): Promise<WikiSearchHit[]> {
    const result = (await core.call('wiki.search', { owner, query })) as {
      hits: WikiSearchHit[];
    };
    return result.hits;
  }

  historyOf(owner: WikiOwner): WikiHistoryEntry[] {
    return this.history[wikiOwnerKey(owner)] ?? [];
  }

  historyLoadingOf(owner: WikiOwner): boolean {
    return this.historyLoading[wikiOwnerKey(owner)] === true;
  }

  async loadHistory(owner: WikiOwner, force = false): Promise<void> {
    const key = wikiOwnerKey(owner);
    if (!force && this.#historyLoaded.has(key)) return;
    this.historyLoading[key] = true;
    try {
      const result = (await core.call('wiki.history', { owner })) as {
        history: WikiHistoryEntry[];
      };
      this.history[key] = result.history;
      this.#historyLoaded.add(key);
    } finally {
      this.historyLoading[key] = false;
    }
  }

  /** 历史快照：某次提交时的页面列表（wiki.commitTree，只读 git 对象）。 */
  async commitTree(owner: WikiOwner, commitOid: string): Promise<WikiPage[]> {
    const result = (await core.call('wiki.commitTree', { owner, commitOid })) as {
      pages: WikiPage[];
    };
    return result.pages;
  }

  /** 历史快照：某次提交时一个页面的全文（wiki.commitPage）。 */
  async commitPage(
    owner: WikiOwner,
    commitOid: string,
    path: string,
  ): Promise<{ path: string; title: string; content: string }> {
    return (await core.call('wiki.commitPage', { owner, commitOid, path })) as {
      path: string;
      title: string;
      content: string;
    };
  }

  /** Rollback creates a NEW commit (history grows); the tree reloads after. */
  async rollback(owner: WikiOwner, commitOid: string): Promise<void> {
    await core.call('wiki.rollback', { owner, commitOid });
    await this.load(owner, true);
  }

  /** Delete creates a NEW commit too (recoverable via rollback); reload after. */
  async deletePage(owner: WikiOwner, path: string): Promise<void> {
    await core.call('wiki.deletePage', { owner, path });
    await this.load(owner, true);
  }

  // --- project source ledger (D92 T1b WP10) -----------------------------------

  async sources(owner: WikiOwner): Promise<WikiSourceView[]> {
    const result = (await core.call('wiki.sources', { owner })) as { sources: WikiSourceView[] };
    return result.sources;
  }

  /** Enqueues the user-submitted ingest; the page appears on wiki_changed. */
  async addSource(
    owner: WikiOwner,
    input: { sourceType: 'url' | 'text'; ref: string; note?: string },
  ): Promise<void> {
    await core.call('wiki.addSource', { owner, ...input });
  }

  /** Registers the async removal; the row disappears on wiki_changed. */
  async deleteSource(owner: WikiOwner, sourceId: string): Promise<void> {
    await core.call('wiki.deleteSource', { owner, sourceId });
  }
}

export const wikiStore = new WikiState();

/** 页面标题（面包屑末段）：树里有就用树标题；index.md 即目录；否则退回文件名。 */
function crumbTitle(owner: WikiOwner, path: string): string {
  if (path === 'index.md') return t('wiki.index');
  const found = wikiStore.pagesOf(owner).find((page) => page.path === path);
  if (found !== undefined) return found.title;
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

/**
 * 面包屑段（右栏 DetailHeader 与项目 Wiki 内联共用），只负责内容导航（目录
 * 与页面）；历史视图有自己的返回按钮，不进面包屑。根段「Wiki」与每级目录段
 * 恒为可点按钮——样式不随是否为当前位置切换（避免文字跳动）：点击进入该目录
 * 并重载树，点在当前位置即刷新。末段（页面标题）为当前位置，不可点。
 */
export function wikiCrumbs(owner: WikiOwner): WikiCrumb[] {
  const nav = wikiStore.navOf(owner);
  const jumpToDir = (target: string): void => {
    wikiStore.openDir(owner, target);
    void wikiStore.load(owner, true);
  };
  const crumbs: WikiCrumb[] = [{ label: t('rightPanel.tabWiki'), onJump: () => jumpToDir('') }];
  const segments = nav.dir.split('/').filter((segment) => segment.length > 0);
  segments.forEach((segment, index) => {
    const target = segments.slice(0, index + 1).join('/');
    crumbs.push({ label: segment, onJump: () => jumpToDir(target) });
  });
  if (nav.pagePath !== null) crumbs.push({ label: crumbTitle(owner, nav.pagePath) });
  return crumbs;
}
