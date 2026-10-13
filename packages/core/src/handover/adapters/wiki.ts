import { HANDOVER_WIKI_QUERY_LIMIT, type Bot, type HandoverAction } from '@kepcup/shared';
import type { WikiCopyOutcome } from '../../wiki/service.js';
import type {
  HandoverAdapter,
  HandoverBatchOutcome,
  HandoverContext,
  HandoverEntry,
  InventoryQuery,
} from '../types.js';
import { keyId } from './common.js';

/**
 * Wiki（D88 P2，设计 37 §3.2）：按页（或按目录）复制，A 不变；后台 `handover_copy` 作业里
 * 执行（`background`），N 页一次提交。
 *
 * - key：页 `wiki:pages/a.md`；目录 `wiki:pages/` = 整本、`wiki:pages/{目录}/` = 一个主题目录
 *   （执行时取目录下当下的全部页）。
 * - 盘点：不带查询时给目录条目（整本 + 各子目录，页数与大小）与统计行；`wiki_query` 列页：
 *   `*` = 全部页、`pages/…` = 某目录下的页、其他 = 全文检索。页标题来自 Wiki 内容（包
 *   `<untrusted>`），不给正文片段。
 * - 冲突：B 已有同路径、内容不同的页 → 跳过并在结果里列出（不覆盖、不改名）；单页条目
 *   在卡上置灰。同路径同内容 = 已复制（续跑幂等）。
 * - 写入：`WikiService.copyForHandover`（来源锁内快照 → B 的维护锁内落盘 → 提交「从 {A} 复制
 *   N 页」→ FTS → 给 B 排一次 lint）。
 */

export interface HandoverWikiPort {
  exists(botId: string): boolean;
  pageStats(botId: string): Array<{ path: string; bytes: number }>;
  tree(botId: string): Array<{ path: string; title: string }>;
  /** One page's title (first heading, else the file name). */
  pageTitle(botId: string, pagePath: string): string;
  search(botId: string, query: string, limit: number): Array<{ path: string; title: string }>;
  pageConflict(
    fromBotId: string,
    toBotId: string,
    pagePath: string,
  ): 'absent' | 'same' | 'different';
  copyForHandover(input: {
    fromBotId: string;
    toBotId: string;
    fromName: string;
    handoverId: string;
    pages: string[];
  }): Promise<WikiCopyOutcome>;
}

export interface WikiAdapterDeps {
  wiki: HandoverWikiPort;
  /** `wiki_changed` for the target (an open Wiki tab refreshes). */
  publish(event: string, payload: unknown): void;
}

/** Up to this many conflicting paths are named in card warnings / reasons. */
const LISTED_PATHS_MAX = 5;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, LISTED_PATHS_MAX).join('、');
  return paths.length > LISTED_PATHS_MAX ? `${shown} 等 ${paths.length} 个` : shown;
}

/** `pages/` or `pages/x/…/` (a directory key's path). */
function isDirPath(rel: string): boolean {
  return rel === 'pages/' || (rel.startsWith('pages/') && rel.endsWith('/'));
}

export class WikiAdapter implements HandoverAdapter {
  readonly type = 'wiki' as const;
  readonly stage = 3;
  readonly background = true;
  readonly #deps: WikiAdapterDeps;

  constructor(deps: WikiAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'wiki') !== null;
  }

  /** The source's pages a key stands for right now (a page, or every page under a directory). */
  #pagesFor(botId: string, key: string): Array<{ path: string; bytes: number }> {
    const rel = keyId(key, 'wiki') ?? '';
    if (!rel.startsWith('pages/') || rel.includes('..')) return [];
    const stats = this.#deps.wiki.pageStats(botId);
    return isDirPath(rel)
      ? stats.filter((page) => page.path.startsWith(rel))
      : stats.filter((page) => page.path === rel);
  }

  #dirEntry(dir: string, pages: Array<{ bytes: number }>): HandoverEntry {
    const bytes = pages.reduce((sum, page) => sum + page.bytes, 0);
    return {
      key: `wiki:${dir}`,
      type: 'wiki',
      label: dir === 'pages/' ? '整本 Wiki（pages/）' : `目录 ${dir}`,
      detail: `${pages.length} 页，${formatBytes(bytes)}`,
      actions: ['copy'],
      defaultAction: 'copy',
      // Directory names are written by the maintenance loop from source material.
      external: true,
    };
  }

  #pageEntry(page: { path: string; bytes: number }, title: string): HandoverEntry {
    return {
      key: `wiki:${page.path}`,
      type: 'wiki',
      label: title,
      detail: `${page.path}，${formatBytes(page.bytes)}`,
      actions: ['copy'],
      defaultAction: 'copy',
      external: true,
    };
  }

  /**
   * The whole wiki and each topic directory (cheap: stat only); with `wiki_query` also
   * pages (`*` = all, `pages/…` = a directory, else full-text search).
   */
  inventory(botId: string, query?: InventoryQuery): HandoverEntry[] {
    if (!this.#deps.wiki.exists(botId)) return [];
    const stats = this.#deps.wiki.pageStats(botId);
    if (stats.length === 0) return [];
    const text = query?.wikiQuery?.trim() ?? '';
    const dirEntries = (): HandoverEntry[] => {
      const dirs = new Map<string, Array<{ bytes: number }>>();
      dirs.set('pages/', stats);
      for (const page of stats) {
        const parts = page.path.split('/');
        for (let depth = 2; depth < parts.length; depth += 1) {
          const dir = `${parts.slice(0, depth).join('/')}/`;
          const list = dirs.get(dir) ?? [];
          list.push(page);
          dirs.set(dir, list);
        }
      }
      return [...dirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, pages]) => this.#dirEntry(dir, pages));
    };
    if (text.length === 0) return dirEntries();
    const bytesOf = new Map(stats.map((page) => [page.path, page.bytes]));
    let hits: Array<{ path: string; title: string }>;
    if (text === '*' || text.startsWith('pages/')) {
      const prefix = text === '*' ? 'pages/' : text;
      hits = this.#deps.wiki.tree(botId).filter((page) => page.path.startsWith(prefix));
    } else {
      hits = this.#deps.wiki.search(botId, text, HANDOVER_WIKI_QUERY_LIMIT);
    }
    return [
      ...dirEntries(),
      ...hits
        .filter((hit) => bytesOf.has(hit.path))
        .slice(0, HANDOVER_WIKI_QUERY_LIMIT)
        .map((hit) =>
          this.#pageEntry({ path: hit.path, bytes: bytesOf.get(hit.path)! }, hit.title),
        ),
    ];
  }

  summary(botId: string): string | null {
    const stats = this.#deps.wiki.exists(botId) ? this.#deps.wiki.pageStats(botId) : [];
    if (stats.length === 0) return '没有页面';
    const bytes = stats.reduce((sum, page) => sum + page.bytes, 0);
    return `${stats.length} 页，共 ${formatBytes(bytes)}。整本复制用 wiki:pages/，一个主题目录用 wiki:pages/{目录}/；要按页挑选，用 wiki_query 列出页（"*" = 全部，"pages/{目录}/" = 某目录，其他 = 关键词检索）。页面引用的原件随页复制；接手方已有同路径的页不覆盖。`;
  }

  /** Any page / non-empty directory of the source is a valid key, listed by a query or not. */
  resolve(fromBotId: string, key: string): HandoverEntry | null {
    const rel = keyId(key, 'wiki') ?? '';
    const pages = this.#pagesFor(fromBotId, key);
    if (pages.length === 0) return null;
    if (isDirPath(rel)) return this.#dirEntry(rel, pages);
    return this.#pageEntry(pages[0]!, this.#deps.wiki.pageTitle(fromBotId, rel));
  }

  #conflicts(ctx: HandoverContext, pages: Array<{ path: string }>): string[] {
    if (ctx.toBot === null) return [];
    const toBotId = ctx.toBot.id;
    return pages
      .filter(
        (page) => this.#deps.wiki.pageConflict(ctx.fromBot.id, toBotId, page.path) === 'different',
      )
      .map((page) => page.path);
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'copy') return 'Wiki 只能复制';
    const rel = keyId(key, 'wiki') ?? '';
    const pages = this.#pagesFor(ctx.fromBot.id, key);
    if (pages.length === 0) return `${ctx.fromBot.name} 的 Wiki 里已经没有 ${rel}`;
    const conflicts = this.#conflicts(ctx, pages);
    if (conflicts.length === pages.length) {
      return pages.length === 1
        ? `${ctx.toName} 的 Wiki 里已有同路径、内容不同的页（不覆盖、不改名）`
        : `${ctx.toName} 的 Wiki 里已有全部这些路径、内容不同的页（不覆盖、不改名）`;
    }
    return null;
  }

  /** The copy itself runs in the background job (`applyBatch`); never inline. */
  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const outcome = (await this.applyBatch(ctx, [key])).get(key);
    if (outcome === undefined) throw new Error('Wiki 复制没有结果');
    if (outcome.status === 'skipped') throw new Error(outcome.reason);
    return { result: outcome.result ?? {} };
  }

  async applyBatch(
    ctx: HandoverContext & { toBot: Bot },
    keys: string[],
  ): Promise<Map<string, HandoverBatchOutcome>> {
    const byKey = new Map(keys.map((key) => [key, this.#pagesFor(ctx.fromBot.id, key)]));
    const union = [...new Set([...byKey.values()].flatMap((pages) => pages.map((p) => p.path)))];
    const outcome = await this.#deps.wiki.copyForHandover({
      fromBotId: ctx.fromBot.id,
      toBotId: ctx.toBot.id,
      fromName: ctx.fromBot.name,
      handoverId: ctx.handoverId,
      pages: union,
    });
    const copied = new Set(outcome.copied);
    const conflicts = new Set(outcome.conflicts);
    const results = new Map<string, HandoverBatchOutcome>();
    for (const [key, pages] of byKey) {
      const paths = pages.map((page) => page.path);
      const done = paths.filter((p) => copied.has(p));
      const skippedPaths = paths.filter((p) => conflicts.has(p));
      const result = {
        copiedCount: done.length,
        skippedPaths,
        missingPaths: paths.filter((p) => !copied.has(p) && !conflicts.has(p)),
        bytes: pages.filter((page) => copied.has(page.path)).reduce((s, p) => s + p.bytes, 0),
        rawConflicts: outcome.rawConflicts,
        commit: outcome.commit,
      };
      if (done.length === 0) {
        results.set(key, {
          status: 'skipped',
          reason:
            skippedPaths.length > 0
              ? `${ctx.toName} 的 Wiki 里已有同路径、内容不同的页，没有覆盖：${listPaths(skippedPaths)}`
              : `${ctx.fromBot.name} 的 Wiki 里已经没有这些页`,
          result,
        });
      } else {
        results.set(key, { status: 'done', result });
      }
    }
    if (outcome.copied.length > 0) this.#deps.publish('wiki_changed', { botId: ctx.toBot.id });
    return results;
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    const rel = keyId(entry.key, 'wiki') ?? '';
    const what = isDirPath(rel)
      ? `${rel === 'pages/' ? '整本 Wiki' : `目录 ${rel}`}（${entry.detail}）`
      : `这一页（${entry.detail}）`;
    return `把${what}连同页面引用的原件复制一份给 ${toName}（后台进行，A 不变）；${toName} 已有同路径的页不覆盖，下次 Wiki 体检时会把新页整理进自己的目录`;
  }

  warnings(ctx: HandoverContext, entry: HandoverEntry): string[] {
    const pages = this.#pagesFor(ctx.fromBot.id, entry.key);
    const conflicts = this.#conflicts(ctx, pages);
    if (conflicts.length === 0 || conflicts.length === pages.length) return [];
    return [
      `${ctx.toName} 已有 ${conflicts.length} 个同路径、内容不同的页，会跳过：${listPaths(conflicts)}`,
    ];
  }
}
