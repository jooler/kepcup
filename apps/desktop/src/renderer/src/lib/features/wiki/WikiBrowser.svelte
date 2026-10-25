<script lang="ts">
  import type { WikiHistoryEntry, WikiOwner, WikiPage, WikiSearchHit } from '@kepcup/shared';
  import { BookOpen, ArrowLeft, History, Trash2, Folder, ChevronLeft } from '@lucide/svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { lazyMarkdown } from '$lib/features/chats/markdown-lazy.svelte';
  import { wikiCrumbs, wikiStore, type WikiCrumb } from '$lib/stores/wiki.svelte';
  import { listWikiDir } from './wiki-browse';
  import WikiSourcesPanel from './WikiSourcesPanel.svelte';
  import DetailHeader from '../right-panel/DetailHeader.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';

  /**
   * The browsed wiki (D92 T1b WP10): a bot's own wiki in the right panel, the
   * project's shared wiki in the project Wiki tab. Testids are shared between
   * both surfaces — the bot panel's e2e (wiki.spec.ts) must keep passing.
   *
   * 页面在数据层允许目录结构（pages/** 任意深度），列表按当前目录分层下钻；
   * 位置状态在 wikiStore（per owner），面包屑由本组件画：Bot 右栏经
   * DetailHeader（onBack 传入时，含右侧页面删除），项目 Wiki 页内联在顶行。
   * 历史视图内联替换搜索 + 列表（不再是弹框）。
   */
  let {
    owner,
    active,
    onBack = null,
    headerTitle = '',
  }: {
    owner: WikiOwner;
    active: boolean;
    /** 传入时（Bot 右栏）在顶部渲染 DetailHeader：返回二级菜单 + 面包屑。 */
    onBack?: (() => void) | null;
    /** DetailHeader 的标题（aria-label 与无面包屑兜底，仅 onBack 传入时用）。 */
    headerTitle?: string;
  } = $props();

  /** The sources sub-view (project wikis only — bot wikis have no ledger). */
  let sourcesOpen = $state(false);

  const nav = $derived(wikiStore.navOf(owner));
  const pages = $derived(wikiStore.pagesOf(owner));
  const history = $derived(wikiStore.historyOf(owner));
  const crumbs = $derived(wikiCrumbs(owner));
  const listing = $derived(listWikiDir(pages, nav.dir));
  /** 浏览视图根目录：提示文本与历史入口只在这里出现，其余位置由面包屑导航。 */
  const atRoot = $derived(nav.mode === 'list' && nav.dir === '' && nav.pagePath === null);

  /** Search box content; empty string means "not searching" (tree shown). */
  let search = $state('');
  /** Search results of the current query (null = no search running). */
  let hits = $state<WikiSearchHit[] | null>(null);
  let searching = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Opened page content (null = list view). */
  let page = $state<{ path: string; title: string; content: string } | null>(null);
  let pageLoading = $state(false);

  /** The snapshot page list of the opened history commit. */
  let commitPages = $state<WikiPage[] | null>(null);
  let commitPagesLoading = $state(false);
  /** Opened historical page content (read-only). */
  let historyPage = $state<{ path: string; title: string; content: string } | null>(null);
  let historyPageLoading = $state(false);

  /** Two-step rollback: the entry awaiting confirmation. */
  let rollbackTarget = $state<WikiHistoryEntry | null>(null);
  let rollingBack = $state(false);

  /** Two-step delete inside the page view (pages/ pages only). */
  let deleteArmed = $state(false);
  let deleting = $state(false);

  /** 快照内的目录条目：与浏览视图同一分组逻辑，作用于该次提交的页面集。 */
  const historyListing = $derived(listWikiDir(commitPages ?? [], nav.historyDir));
  /** 快照面包屑末段（打开的快照页面）：列表标题优先，内容标题兜底，再退文件名。 */
  const historyPageCrumb = $derived.by(() => {
    const path = nav.historyPagePath;
    if (path === null) return null;
    if (path === 'index.md') return t('wiki.index');
    return (
      commitPages?.find((item) => item.path === path)?.title ??
      historyPage?.title ??
      (path.split('/').pop() ?? path).replace(/\.md$/i, '')
    );
  });
  /**
   * 快照面包屑：根段「Wiki」+ 每级目录恒为可点按钮（点当前位置即刷新，避免
   * 样式跳动）；打开快照页面时末段追加文档名（当前位置，不可点）——与浏览
   * 视图同一体验，返回（上一级 / 根）也走面包屑。
   */
  const historyCrumbs = $derived.by(() => {
    const crumbs: WikiCrumb[] = [
      { label: t('rightPanel.tabWiki'), onJump: () => wikiStore.openHistoryDir(owner, '') },
    ];
    const segments = nav.historyDir.split('/').filter((segment) => segment.length > 0);
    segments.forEach((segment, index) => {
      const target = segments.slice(0, index + 1).join('/');
      crumbs.push({ label: segment, onJump: () => wikiStore.openHistoryDir(owner, target) });
    });
    if (historyPageCrumb !== null) crumbs.push({ label: historyPageCrumb });
    return crumbs;
  });

  // bits-ui keeps inactive tab content mounted (hidden): fetch only while the
  // tab is visible, and refetch on every activation (MemoryTab precedent).
  $effect(() => {
    wikiStore.start();
    if (active) void wikiStore.load(owner, true);
  });

  // P13 任务 7: markdown pipeline loads on first page view (startup cost).
  $effect(() => {
    if (page !== null || historyPage !== null) lazyMarkdown.start();
  });

  // 列表视图打开的页面：内容随导航位置拉取；失败（如页面已被维护删除）退回列表。
  $effect(() => {
    const path = nav.pagePath;
    // 换页 / 离开页面即撤销已点下的删除确认（控件贴面包屑，易被顺手带过去）。
    deleteArmed = false;
    if (nav.mode !== 'list' || path === null) {
      page = null;
      pageLoading = false;
      return;
    }
    let cancelled = false;
    page = null;
    pageLoading = true;
    void wikiStore
      .page(owner, path)
      .then((result) => {
        if (!cancelled) {
          page = result;
          pageLoading = false;
        }
      })
      .catch((error) => {
        if (!cancelled) {
          pageLoading = false;
          wikiStore.closePage(owner);
          toast.error(
            errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  });

  // 历史视图打开的提交：该提交时的页面列表（wiki.commitTree 快照）。
  $effect(() => {
    const oid = nav.historyCommit;
    if (nav.mode !== 'history' || oid === null) {
      commitPages = null;
      commitPagesLoading = false;
      return;
    }
    let cancelled = false;
    commitPages = null;
    commitPagesLoading = true;
    void wikiStore
      .commitTree(owner, oid)
      .then((result) => {
        if (!cancelled) {
          commitPages = result;
          commitPagesLoading = false;
        }
      })
      .catch((error) => {
        if (!cancelled) {
          commitPagesLoading = false;
          wikiStore.closeHistoryCommit(owner);
          toast.error(
            errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  });

  // 历史视图打开的快照页面：该提交时的全文（wiki.commitPage）。
  $effect(() => {
    const oid = nav.historyCommit;
    const path = nav.historyPagePath;
    if (nav.mode !== 'history' || oid === null || path === null) {
      historyPage = null;
      historyPageLoading = false;
      return;
    }
    let cancelled = false;
    historyPage = null;
    historyPageLoading = true;
    void wikiStore
      .commitPage(owner, oid, path)
      .then((result) => {
        if (!cancelled) {
          historyPage = result;
          historyPageLoading = false;
        }
      })
      .catch((error) => {
        if (!cancelled) {
          historyPageLoading = false;
          wikiStore.closeHistoryPage(owner);
          toast.error(
            errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  });

  function queueSearch(): void {
    clearTimeout(searchTimer);
    const query = search.trim();
    if (query.length === 0) {
      hits = null;
      searching = false;
      return;
    }
    searching = true;
    // wiki.search is a server-side FTS query: debounce instead of per-keystroke.
    searchTimer = setTimeout(() => void runSearch(query), 250);
  }

  async function runSearch(query: string): Promise<void> {
    try {
      const result = await wikiStore.search(owner, query);
      // A newer edit superseded this request; keep its pending result.
      if (query !== search.trim()) return;
      hits = result;
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
      );
    } finally {
      if (query === search.trim()) searching = false;
    }
  }

  /** A search hit opens the page and returns to the tree on back. */
  function openHit(hit: WikiSearchHit): void {
    search = '';
    hits = null;
    searching = false;
    wikiStore.openPage(owner, hit.path);
  }

  /** 历史按钮：下屏切换为提交列表（再点一次回到浏览视图）。 */
  function toggleHistory(): void {
    if (nav.mode === 'history') {
      closeHistoryView();
      return;
    }
    rollbackTarget = null;
    wikiStore.openHistory(owner);
    void wikiStore.loadHistory(owner, true).catch((error) => {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
      );
    });
  }

  /** 退出历史视图回浏览（提示行左侧的返回按钮与历史按钮共用）。 */
  function closeHistoryView(): void {
    rollbackTarget = null;
    wikiStore.closeHistory(owner);
  }

  async function rollback(): Promise<void> {
    const target = rollbackTarget;
    if (target === null) return;
    rollingBack = true;
    try {
      // wiki.rollback records a NEW commit — history grows by one entry.
      await wikiStore.rollback(owner, target.oid);
      toast.success(t('wiki.rollbackDone'));
      rollbackTarget = null;
      // 回滚整树替换页面内容：打开中的页面视图不再可靠，退回列表。
      wikiStore.closePage(owner);
      await wikiStore.loadHistory(owner, true);
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
      );
    } finally {
      rollingBack = false;
    }
  }

  /** wiki.deletePage: a NEW commit on the append-only history (recoverable). */
  async function deletePage(): Promise<void> {
    const path = nav.pagePath;
    if (path === null) return;
    deleting = true;
    try {
      await wikiStore.deletePage(owner, path);
      toast.success(t('wiki.deleteDone'));
      deleteArmed = false;
      wikiStore.closePage(owner);
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')),
      );
    } finally {
      deleting = false;
    }
  }

  /** e2e-friendly test id: `pages/deploy.md` → `wiki-page-pages-deploy-md`. */
  function slug(path: string): string {
    return path.replaceAll(/[^a-zA-Z0-9]+/g, '-');
  }

  function shortOid(oid: string): string {
    return oid.slice(0, 10);
  }

  /** The opened commit's first message line (history list is loaded there). */
  function commitMessage(oid: string): string {
    const entry = history.find((item) => item.oid === oid);
    return entry?.message.split('\n')[0]?.trim() || shortOid(oid);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="wiki-tab">
  {#snippet pageDeleteControl()}
    <!--
      页面删除（pages/ 页面才有）：图标按钮贴在面包屑行右侧（Bot 右栏在
      DetailHeader 动作区，项目 Wiki 页在顶行右端），两步确认原地展开。
    -->
    {#if nav.mode === 'list' && nav.pagePath !== null && nav.pagePath.startsWith('pages/')}
      {#if deleteArmed}
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => (deleteArmed = false)}
          data-testid="wiki-page-delete-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          class="h-6 px-2 text-xs"
          disabled={deleting}
          onclick={() => void deletePage()}
          data-testid="wiki-page-delete-confirm"
        >
          {t('wiki.deleteConfirm')}
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="icon"
          class="size-7 shrink-0 text-destructive hover:text-destructive"
          title={t('wiki.delete')}
          onclick={() => (deleteArmed = true)}
          data-testid="wiki-page-delete"
        >
          <Trash2 class="size-4" aria-hidden="true" />
        </Button>
      {/if}
    {/if}
  {/snippet}

  {#if onBack !== null && nav.mode !== 'history'}
    <!--
      Bot 右栏的「< Wiki」头行（返回二级菜单 + 内容面包屑）由本组件渲染：
      页面删除控件与面包屑同行（DetailHeader 动作区）。历史视图仍走下面的
      返回行（历史不属于内容导航，不进面包屑），此时头行整体让位。
    -->
    <DetailHeader
      title={headerTitle}
      {onBack}
      breadcrumb={crumbs}
      breadcrumbTestid="wiki-breadcrumb"
      action={pageDeleteControl}
    />
  {/if}

  {#snippet historyBreadcrumb()}
    <!-- 快照面包屑（提交列表下方 / 快照页面顶行共用）：目录段可点，末段文档名不可点 -->
    <nav
      class="flex min-w-0 items-center gap-0.5 text-sm font-medium"
      data-testid="wiki-history-breadcrumb"
      aria-label={t('wiki.history')}
    >
      {#each historyCrumbs as crumb, index (index)}
        {#if index > 0}
          <span class="shrink-0 text-xs text-muted-foreground">/</span>
        {/if}
        {#if crumb.onJump !== undefined}
          <button
            type="button"
            class="min-w-0 cursor-pointer truncate rounded px-0.5 text-muted-foreground transition-colors hover:text-foreground"
            onclick={crumb.onJump}
            title={crumb.label}
          >
            {crumb.label}
          </button>
        {:else}
          <span class="min-w-0 truncate" title={crumb.label}>{crumb.label}</span>
        {/if}
      {/each}
    </nav>
  {/snippet}

  {#if !(nav.mode === 'history' && nav.historyCommit !== null)}
    <!-- 提交内部（快照列表 / 快照页面）自带返回行：顶部的提示行整体隐藏。 -->
    {#if owner.kind === 'project' || nav.mode === 'history' || atRoot}
      <!--
        提示文本与历史入口只在根目录出现：下钻后的位置导航全走面包屑（Bot
        面板是右栏 DetailHeader，项目 Wiki 页是下面的内联面包屑），此行让位。
        历史列表态仍渲染本行，只留返回按钮（退出历史视图的唯一入口）。
      -->
      <div class="flex items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1">
          {#if nav.mode === 'history'}
            <!-- 历史视图的返回：历史不属于内容导航（不进面包屑），这里回浏览视图。 -->
            <Button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              title={t('common.back')}
              onclick={() => closeHistoryView()}
              data-testid="wiki-history-back"
            >
              <ChevronLeft class="size-4" aria-hidden="true" />
            </Button>
          {/if}
          {#if nav.mode !== 'history' && owner.kind === 'project' && crumbs.length > 1}
            <!-- 项目 Wiki 页没有 DetailHeader：面包屑内联在顶行（Bot 右栏走上面的 DetailHeader）。 -->
            <nav
              class="flex min-w-0 items-center gap-0.5 text-sm font-medium"
              data-testid="wiki-breadcrumb"
              aria-label="Wiki"
            >
              {#each crumbs as crumb, index (index)}
                {#if index > 0}
                  <span class="shrink-0 text-xs text-muted-foreground">/</span>
                {/if}
                {#if crumb.onJump !== undefined}
                  <button
                    type="button"
                    class="min-w-0 cursor-pointer truncate rounded px-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    onclick={crumb.onJump}
                    title={crumb.label}
                  >
                    {crumb.label}
                  </button>
                {:else}
                  <span class="min-w-0 truncate" title={crumb.label}>{crumb.label}</span>
                {/if}
              {/each}
            </nav>
          {:else if atRoot}
            <p class="min-w-0 truncate text-xs text-muted-foreground">
              {t(owner.kind === 'project' ? 'project.wiki.hint' : 'wiki.tabHint')}
            </p>
          {/if}
        </span>
        <span class="flex shrink-0 items-center gap-1">
          {#if owner.kind === 'project'}
            <Button
              size="sm"
              variant={sourcesOpen ? 'secondary' : 'outline'}
              onclick={() => (sourcesOpen = !sourcesOpen)}
              data-testid="wiki-sources-toggle"
              aria-pressed={sourcesOpen}
            >
              <BookOpen class="size-3.5" aria-hidden="true" />
              {t('wiki.sources.title')}
            </Button>
          {/if}
          {#if atRoot}
            <Button
              size="sm"
              variant="outline"
              onclick={() => toggleHistory()}
              data-testid="wiki-history"
            >
              <History class="size-3.5" aria-hidden="true" />
              {t('wiki.history')}
            </Button>
          {/if}
          {@render pageDeleteControl()}
        </span>
      </div>
    {/if}
  {/if}

  {#if nav.mode === 'history'}
    {#if nav.historyCommit === null}
      <!-- 变更历史（原弹框内容内联化）：点条目浏览该次提交的 Wiki 快照 -->
      <div class="flex min-h-0 flex-1 flex-col gap-2">
        <p class="text-xs text-muted-foreground" data-testid="wiki-history-hint">
          {t('wiki.historyHint')}
        </p>
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="wiki-history-list">
          {#if wikiStore.historyLoadingOf(owner)}
            <p class="text-sm text-muted-foreground">…</p>
          {:else if history.length === 0}
            <p class="text-sm text-muted-foreground" data-testid="wiki-history-empty">
              {t('wiki.historyEmpty')}
            </p>
          {:else}
            {#each history as entry (entry.oid)}
              <div
                class="rounded-md border p-2 text-sm"
                data-testid={`wiki-history-item-${entry.oid}`}
              >
                <p class="break-words" data-testid="wiki-history-message">{entry.message}</p>
                <p class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <code data-testid="wiki-history-oid">{shortOid(entry.oid)}</code>
                  <span>{new Date(entry.createdAt).toLocaleString()}</span>
                </p>
                <div class="mt-1 flex items-center justify-end gap-1">
                  {#if rollbackTarget?.oid === entry.oid}
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-6 px-2 text-xs"
                      onclick={() => (rollbackTarget = null)}
                      data-testid="wiki-rollback-cancel"
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      class="h-6 px-2 text-xs"
                      disabled={rollingBack}
                      onclick={() => void rollback()}
                      data-testid="wiki-rollback-confirm"
                    >
                      {t('wiki.rollbackConfirm')}
                    </Button>
                  {:else}
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-6 px-2 text-xs"
                      onclick={() => wikiStore.openHistoryCommit(owner, entry.oid)}
                      data-testid={`wiki-history-open-${entry.oid}`}
                    >
                      {t('wiki.viewVersion')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-6 px-2 text-xs"
                      onclick={() => (rollbackTarget = entry)}
                      data-testid={`wiki-rollback-${entry.oid}`}
                    >
                      {t('wiki.rollback')}
                    </Button>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {:else}
      <!-- 该次提交的快照（只读）：返回 + 摘要行在列表 / 文档两个状态下都保留 -->
      <div
        class="flex min-h-0 flex-1 flex-col gap-2"
        data-testid={nav.historyPagePath !== null ? 'wiki-history-page-view' : 'wiki-commit-view'}
      >
        <div class="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            class="h-6 px-2 text-xs"
            onclick={() => wikiStore.closeHistoryCommit(owner)}
            data-testid="wiki-commit-back"
          >
            <ArrowLeft class="size-3.5" aria-hidden="true" />
            {t('wiki.back')}
          </Button>
          <p class="min-w-0 truncate text-xs text-muted-foreground">
            {commitMessage(nav.historyCommit)}
          </p>
        </div>
        {#if nav.historyPagePath !== null}
          <!-- 历史快照页面：面包屑（含文档名末段）+ 只读提示在摘要行下方，直接全文 -->
          <div class="flex min-w-0 items-center gap-2">
            {@render historyBreadcrumb()}
            <span class="ml-auto shrink-0 text-xs text-muted-foreground">
              {t('wiki.historyVersionHint')}
            </span>
          </div>
          <div
            class="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm"
            data-testid="wiki-history-page-content"
          >
            {#if historyPageLoading}
              <p class="text-muted-foreground">…</p>
            {:else if lazyMarkdown.component}
              {@const Markdown = lazyMarkdown.component}
              <Markdown content={historyPage?.content ?? ''} />
            {:else}
              <div class="whitespace-pre-wrap">{historyPage?.content ?? ''}</div>
            {/if}
          </div>
        {:else}
          {#if commitPages !== null && commitPages.length > 0}
            <!-- 快照面包屑（返回 + 摘要行的下方）：Wiki / pages / …，全部可点 -->
            {@render historyBreadcrumb()}
          {/if}
          <div
            class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
            data-testid="wiki-commit-pages"
          >
            {#if commitPagesLoading}
              <p class="text-sm text-muted-foreground">…</p>
            {:else if commitPages !== null && commitPages.length === 0}
              <p class="text-sm text-muted-foreground" data-testid="wiki-commit-empty">
                {t('wiki.commitEmpty')}
              </p>
            {:else}
              <ul class="space-y-2">
                {#if nav.historyDir === ''}
                  <li>
                    <button
                      class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
                      onclick={() => wikiStore.openHistoryPage(owner, 'index.md')}
                      data-testid="wiki-history-page-index"
                      data-page-path="index.md"
                    >
                      <p class="font-medium">{t('wiki.index')}</p>
                      <p class="text-xs text-muted-foreground">index.md</p>
                    </button>
                  </li>
                {/if}
                {#each historyListing as entry (entry.kind === 'dir' ? `dir:${entry.dir}` : entry.page.path)}
                  <li>
                    {#if entry.kind === 'dir'}
                      <button
                        class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
                        onclick={() => wikiStore.openHistoryDir(owner, entry.dir)}
                        data-testid={`wiki-history-dir-${slug(entry.dir)}`}
                        data-dir={entry.dir}
                      >
                        <p class="flex items-center gap-1.5 font-medium">
                          <Folder
                            class="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          {entry.name}
                        </p>
                        <p class="text-xs text-muted-foreground">
                          {t('wiki.dirPages', { count: entry.pages })}
                        </p>
                      </button>
                    {:else}
                      <button
                        class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
                        onclick={() => wikiStore.openHistoryPage(owner, entry.page.path)}
                        data-testid={`wiki-history-page-${slug(entry.page.path)}`}
                        data-page-path={entry.page.path}
                      >
                        <p class="font-medium">{entry.page.title}</p>
                        <p class="text-xs text-muted-foreground">{entry.page.path}</p>
                      </button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {:else if nav.pagePath !== null}
    <!-- 页面内容：markdown 渲染（与消息气泡同一 Streamdown 先例）；导航走面包屑，
         删除入口在面包屑行右侧（pageDeleteControl）。 -->
    <div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="wiki-page-view">
      <!-- 文档名不单独成行：面包屑末段（DetailHeader / 内联）已是当前位置。 -->
      <div
        class="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm"
        data-testid="wiki-page-content"
      >
        {#if pageLoading}
          <p class="text-muted-foreground">…</p>
        {:else if lazyMarkdown.component}
          {@const Markdown = lazyMarkdown.component}
          <Markdown content={page?.content ?? ''} />
        {:else}
          <div class="whitespace-pre-wrap">{page?.content ?? ''}</div>
        {/if}
      </div>
    </div>
  {:else if sourcesOpen && owner.kind === 'project'}
    <WikiSourcesPanel {owner} />
  {:else}
    <Input
      placeholder={t('wiki.searchPlaceholder')}
      bind:value={search}
      oninput={() => queueSearch()}
      data-testid="wiki-search"
    />
    {#if hits !== null || searching}
      <!-- 搜索结果（wiki.search：FTS 全文检索） -->
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="wiki-search-results">
        {#if hits !== null && hits.length === 0}
          <p class="text-sm text-muted-foreground" data-testid="wiki-search-empty">
            {t('wiki.searchEmpty')}
          </p>
        {:else}
          {#each hits ?? [] as hit (hit.path)}
            <button
              class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
              onclick={() => openHit(hit)}
              data-testid={`wiki-search-hit-${slug(hit.path)}`}
              data-hit-path={hit.path}
            >
              <p class="font-medium">{hit.title}</p>
              <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</p>
            </button>
          {/each}
        {/if}
      </div>
    {:else if wikiStore.loadingOf(owner) && pages.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="wiki-loading">…</p>
    {:else if pages.length === 0}
      <!-- 页面树（wiki.tree）为空：项目 wiki 未初始化 / Bot 还没有整理过资料 -->
      <p class="text-sm text-muted-foreground" data-testid="wiki-empty">
        {t(owner.kind === 'project' ? 'project.wiki.empty' : 'wiki.empty')}
      </p>
    {:else}
      <!-- 页面树（wiki.tree）：目录结构分层——目录在前（含子树页面数），页面在后 -->
      <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="wiki-tree">
        {#if nav.dir === ''}
          <li>
            <button
              class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
              onclick={() => wikiStore.openPage(owner, 'index.md')}
              data-testid="wiki-page-index"
              data-page-path="index.md"
            >
              <p class="font-medium">{t('wiki.index')}</p>
              <p class="text-xs text-muted-foreground">index.md</p>
            </button>
          </li>
        {/if}
        {#each listing as entry (entry.kind === 'dir' ? `dir:${entry.dir}` : entry.page.path)}
          <li>
            {#if entry.kind === 'dir'}
              <button
                class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
                onclick={() => wikiStore.openDir(owner, entry.dir)}
                data-testid={`wiki-dir-${slug(entry.dir)}`}
                data-dir={entry.dir}
              >
                <p class="flex items-center gap-1.5 font-medium">
                  <Folder class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {entry.name}
                </p>
                <p class="text-xs text-muted-foreground">
                  {t('wiki.dirPages', { count: entry.pages })}
                </p>
              </button>
            {:else}
              <button
                class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
                onclick={() => wikiStore.openPage(owner, entry.page.path)}
                data-testid={`wiki-page-${slug(entry.page.path)}`}
                data-page-path={entry.page.path}
              >
                <p class="font-medium">{entry.page.title}</p>
                <p class="text-xs text-muted-foreground">{entry.page.path}</p>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
