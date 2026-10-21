
import { Type } from '@earendil-works/pi-ai';
import type { WikiOwner } from '@kepcup/shared';
import { AppError, isAppError } from '@kepcup/shared';
import { neutralizeUntrusted, untrustedBlock } from '../infra/data-boundary.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/** The ledger slice the read-time trust wrap needs (D92 T1b WP10). */
export interface WikiSourceStub {
  id: string;
  createdBy: { kind: 'user' } | { kind: 'bot'; id: string };
}

/** The project facts of the current conversation (null outside a project). */
export interface WikiProjectContext {
  conversationId: string;
  leadBotId: string | null;
  memberBotIds: readonly string[];
}

/**
 * The slice of WikiService the response-loop tools consume (owner-based since
 * D92 T1b WP9; WP10 adds the scope selection, the source ledger and the
 * project facts of the running conversation).
 */
export interface WikiToolFacade {
  search(
    owner: WikiOwner,
    query: string,
    limit: number,
  ): Array<{ path: string; title: string; snippet: string }>;
  readPage(owner: WikiOwner, path: string): { path: string; title: string; content: string };
  enqueueIngest(input: {
    owner: WikiOwner;
    botId: string;
    conversationId: string | null;
    source: { sourceType: 'attachment' | 'url' | 'file'; ref: string; note: string };
    createdBy: { kind: 'user' } | { kind: 'bot'; id: string };
  }): { ok: boolean; message: string };
  /** Fast-fail (NOT_FOUND / ACL / conversation mismatch) then queue the job. */
  enqueueRemoveSource(input: {
    owner: WikiOwner;
    sourceId: string;
    actor: { role: 'lead' | 'member' | 'user'; botId?: string };
    leadBotId: string;
    conversationId: string;
  }): void;
  /** Ledger entries of one wiki (empty for bot wikis — no ledger). */
  listSources(owner: WikiOwner): WikiSourceStub[];
  /** Display name of a bot (null when deleted). */
  botName(botId: string): string | null;
  /** Project facts of one conversation (null when it is not a project). */
  projectContext(conversationId: string): WikiProjectContext | null;
}

const WIKI_SEARCH_RESULT_MAX = 20;

/** Links a maintenance loop writes to cite a source asset (SCHEMA.md format). */
const ASSET_LINK_PATTERN = /raw\/_assets\/(ast_[0-9a-f]{24})\.json/g;

/** A missing page (the wiki service's NOT_FOUND) — the read fallback trigger. */
function isNotFound(error: unknown): boolean {
  return isAppError(error) && error.code === 'NOT_FOUND';
}

/** A resolved `scope` argument (D92 T1b WP10 §4 步骤 2). */
export type WikiScopeResolution =
  | { ok: true; scope: 'mine' }
  | { ok: true; scope: 'project' | 'all'; owner: WikiOwner; role: 'lead' | 'member' }
  | { ok: false; message: string };

/**
 * The wiki a tool addresses when the model passes no `scope`:
 * - a project conversation → the shared PROJECT wiki: what is settled in the
 *   group chat stays in the project's knowledge base, not scattered over the
 *   members' personal wikis (D92: 项目组的沉淀留在项目 wiki);
 * - any other conversation → the bot's own wiki.
 */
export function defaultWikiScope(project: WikiProjectContext | null): 'mine' | 'project' {
  return project !== null ? 'project' : 'mine';
}

/**
 * Resolves a wiki tool's `scope` argument against the running conversation
 * (shared by wiki_search / wiki_read / wiki_enqueue / wiki_remove_source):
 * - no conversation / not a project: only `mine` (default); `project` / `all`
 *   fail — only project conversations have a project wiki;
 * - a project conversation: `project` / `all` additionally require the caller
 *   to be a member; the caller's role is lead iff it holds `leadBotId`.
 */
export function resolveWikiScope(
  identity: { botId: string | null },
  scope: 'mine' | 'project' | 'all' | undefined,
  deps: { project: WikiProjectContext | null },
): WikiScopeResolution {
  if (scope === undefined || scope === 'mine') {
    return { ok: true, scope: 'mine' };
  }
  const project = deps.project;
  if (project === null) {
    return { ok: false, message: '只有项目组对话里才有项目 wiki' };
  }
  if (identity.botId === null || !project.memberBotIds.includes(identity.botId)) {
    return { ok: false, message: '你不是该项目组的成员，无法访问项目 wiki' };
  }
  const role = project.leadBotId === identity.botId ? 'lead' : 'member';
  return { ok: true, scope, owner: { kind: 'project', id: project.conversationId }, role };
}

/** Asset ids a page's body cites (`raw/_assets/ast_….json` links). */
function citedAssetIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(ASSET_LINK_PATTERN)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/** The submitter label of one creator (deleted bots show their id, design 01). */
function creatorLabel(
  createdBy: { kind: 'user' } | { kind: 'bot'; id: string },
  botName: (botId: string) => string | null,
): string {
  return createdBy.kind === 'user' ? '用户' : (botName(createdBy.id) ?? createdBy.id);
}

/**
 * The read result of one PROJECT wiki page (conservative trust wrap, WP10 §7):
 * trusted only when the page cites at least one source AND every cited source
 * exists and was created by the user — returned verbatim. Anything else (a bot
 * creator among them, a dangling citation, or no citation at all) is wrapped in
 * `<untrusted source="project_wiki">` with a submitter line up front.
 */
function projectPageResult(
  page: { title: string; content: string },
  sources: readonly WikiSourceStub[],
  botName: (botId: string) => string | null,
): string {
  const body = `# ${page.title}\n\n${page.content}`;
  const byId = new Map(sources.map((source) => [source.id, source.createdBy]));
  const cited = citedAssetIds(page.content);
  const trusted =
    cited.length > 0 &&
    cited.every((id) => byId.get(id)?.kind === 'user');
  if (trusted) {
    return body;
  }
  const labels: string[] = [];
  for (const id of cited) {
    const createdBy = byId.get(id);
    if (createdBy !== undefined) {
      const label = creatorLabel(createdBy, botName);
      if (!labels.includes(label)) labels.push(label);
    }
  }
  const submitterLine =
    labels.length > 0 ? `（来源提交者：${labels.join('、')}）` : '（无来源引用）';
  return `${submitterLine}\n<untrusted source="project_wiki">\n${neutralizeUntrusted(body)}\n</untrusted>`;
}

/**
 * Response-loop wiki tools (docs/dev/04-agent-runtime.md 工具目录, R 列;
 * access = conversation). The response loop is READ-ONLY towards the wiki
 * (design/05 读写规则 单一写入者): search + read only, writes happen in the
 * serialized wiki maintenance loop. wiki_enqueue / wiki_remove_source are pure
 * registrations (fire-and-forget jobs, no immediate side effect beyond the
 * bot's own or the project's wiki), so they need no confirmation — same
 * posture as create_skill.
 *
 * D92 T1b WP10: the `scope` argument selects the addressed wiki — `mine` (the
 * bot's own, the default outside project conversations), `project` (the shared
 * project wiki, the default inside a project conversation) and `all` (search
 * only, the default inside a project conversation). wiki_remove_source
 * registers only in project conversations.
 */
export function buildWikiTools(input: {
  identity: RunIdentity;
  wiki: WikiToolFacade;
}): ToolDefinition[] {
  const { identity, wiki } = input;
  const project =
    identity.conversationId !== null ? wiki.projectContext(identity.conversationId) : null;

  const requireBot = (): ToolResult | null => {
    if (identity.botId === null) {
      return { ok: false, content: '当前执行没有所属 Bot', errorCode: 'INVALID_INPUT' };
    }
    return null;
  };

  const scopeFailure = (message: string): ToolResult => ({
    ok: false,
    content: message,
    errorCode: 'INVALID_INPUT',
  });

  const wikiSearch: ToolDefinition<{
    query: string;
    limit?: number;
    scope?: 'mine' | 'project' | 'all';
  }> = {
    name: 'wiki_search',
    description:
      '全文检索 Wiki，返回页面路径、标题与片段。回答问题前先查这里是否已有沉淀。scope 可选：mine（你自己的 Wiki）、project（项目组共享的项目 wiki）、all（两边都查）；项目组对话里默认 all，其它对话默认 mine。结果逐条以 [mine] / [project] 标注来源，项目的在前。',
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词' }),
      limit: Type.Optional(Type.Number({ description: '返回条数上限，默认 20' })),
      scope: Type.Optional(
        Type.Union(
          [Type.Literal('mine'), Type.Literal('project'), Type.Literal('all')],
          { description: '检索范围' },
        ),
      ),
    }),
    execute: async (params): Promise<ToolResult> => {
      const noBot = requireBot();
      if (noBot !== null) return noBot;
      const botId = identity.botId!;
      const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? WIKI_SEARCH_RESULT_MAX)));
      const requested = params.scope ?? (project !== null ? 'all' : 'mine');
      const resolved = resolveWikiScope({ botId }, requested, { project });
      if (!resolved.ok) return scopeFailure(resolved.message);

      const line = (tag: 'mine' | 'project', hit: { title: string; path: string; snippet: string }) =>
        `- [${tag}] [${hit.title}]（${hit.path}）：${hit.snippet}`;
      if (resolved.scope === 'mine') {
        const hits = wiki.search({ kind: 'bot', id: botId }, params.query, limit);
        if (hits.length === 0) return { ok: true, content: 'Wiki 中没有匹配的页面。' };
        return { ok: true, content: untrustedBlock(hits.map((hit) => line('mine', hit)).join('\n')) };
      }
      // 'project' / 'all': project results first (WP10 §4 步骤 2).
      const projectHits = wiki.search(resolved.owner, params.query, limit);
      if (resolved.scope === 'project') {
        if (projectHits.length === 0) return { ok: true, content: '项目 Wiki 中没有匹配的页面。' };
        return {
          ok: true,
          content: untrustedBlock(projectHits.map((hit) => line('project', hit)).join('\n')),
        };
      }
      const mineHits = wiki.search({ kind: 'bot', id: botId }, params.query, limit);
      const lines = [
        ...projectHits.map((hit) => line('project', hit)),
        ...mineHits.map((hit) => line('mine', hit)),
      ];
      if (lines.length === 0) return { ok: true, content: 'Wiki 中没有匹配的页面。' };
      return { ok: true, content: untrustedBlock(lines.join('\n')) };
    },
  };

  const wikiRead: ToolDefinition<{ path: string; scope?: 'mine' | 'project' }> = {
    name: 'wiki_read',
    description:
      '读取一个 Wiki 页面的全文（路径限定为 pages/ 下的页面或 index.md；路径来自 wiki_search、<wiki_topics> 或 <project_wiki_topics>）。scope 可选 mine / project：项目组对话里不传就是先读共享的项目 wiki、那一页不在项目 wiki 时再读你自己的 wiki；其它对话默认读你自己的 wiki。wiki_search 结果里的 [mine] / [project] 标注原样传回即可。',
    parameters: Type.Object({
      path: Type.String({ description: '页面路径（相对 wiki 根目录，例如 pages/go-generics.md）' }),
      scope: Type.Optional(
        Type.Union([Type.Literal('mine'), Type.Literal('project')], { description: '读取范围' }),
      ),
    }),
    execute: async (params): Promise<ToolResult> => {
      const noBot = requireBot();
      if (noBot !== null) return noBot;
      const botId = identity.botId!;
      // 项目组里不传 scope：先读共享的项目 wiki（<project_wiki_topics> 的页面），
      // 那一页不在项目 wiki 时回落到自己的 wiki（<wiki_topics> 的页面）。
      if (params.scope === undefined && project !== null) {
        const projectResolved = resolveWikiScope({ botId }, 'project', { project });
        if (projectResolved.ok && projectResolved.scope !== 'mine') {
          try {
            const page = wiki.readPage(projectResolved.owner, params.path);
            return {
              ok: true,
              content: projectPageResult(
                page,
                wiki.listSources(projectResolved.owner),
                wiki.botName,
              ),
            };
          } catch (error) {
            if (!isNotFound(error)) {
              const message = error instanceof Error ? error.message : String(error);
              return { ok: false, content: message, errorCode: 'NOT_FOUND' };
            }
            // 项目 wiki 里没有这一页 → 继续走自己的 wiki。
          }
        }
      }
      const resolved = resolveWikiScope({ botId }, params.scope ?? 'mine', { project });
      if (!resolved.ok) return scopeFailure(resolved.message);
      try {
        if (resolved.scope === 'mine') {
          const page = wiki.readPage({ kind: 'bot', id: botId }, params.path);
          return {
            ok: true,
            content: untrustedBlock(`# ${page.title}\n\n${page.content}`),
          };
        }
        // Project pages carry a conservative trust wrap (WP10 §7).
        const page = wiki.readPage(resolved.owner, params.path);
        return {
          ok: true,
          content: projectPageResult(page, wiki.listSources(resolved.owner), wiki.botName),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, content: message, errorCode: 'NOT_FOUND' };
      }
    },
  };

  const wikiEnqueue: ToolDefinition<{
    source_type: 'attachment' | 'url' | 'file';
    ref: string;
    note: string;
    scope?: 'mine' | 'project';
  }> = {
    name: 'wiki_enqueue',
    description:
      '登记一个 Wiki 入库任务（用户说“学一下这份文档”或你认为某资料值得沉淀时使用）。来源：attachment（附件 id）、url（网页地址）、file（workspace 或 workdir 中的单个文件路径）。file / attachment 来源必须是单个文件，不能是目录：要入库一个目录，先用 ls 列出其中的文件，再逐文件登记。后台维护 loop 会阅读资料、更新页面并提交；完成后无需向用户播报，wiki_search 直接就能检索到新内容。scope 可选：mine（沉淀到你自己的 Wiki）、project（写入项目组共享的项目 wiki）。项目组对话里不传 scope 就默认写进共享的项目 wiki——群聊里沉淀的东西留在项目 wiki，只有纯个人经验才显式传 scope=mine；其它对话（单聊）默认写自己的 Wiki。',
    parameters: Type.Object({
      source_type: Type.Union(
        ['attachment', 'url', 'file'].map((t) => Type.Literal(t)),
        { description: '来源类型' },
      ),
      ref: Type.String({
        description:
          '来源引用：附件 id（att_...）/ 完整 URL / 单个文件的路径（目录不能直接入库，先 ls 列出再逐文件登记）',
      }),
      note: Type.String({ description: '一句话说明这份资料是什么、为什么要入库' }),
      scope: Type.Optional(
        Type.Union([Type.Literal('mine'), Type.Literal('project')], {
          description:
            '入库范围：项目组对话里默认 project（写入共享的项目 wiki），其它对话默认 mine',
        }),
      ),
    }),
    execute: async (params): Promise<ToolResult> => {
      const noBot = requireBot();
      if (noBot !== null) return noBot;
      const botId = identity.botId!;
      // 项目组对话里默认写进共享的项目 wiki（群聊里的沉淀留在项目 wiki）；
      // 单聊里默认写自己的 wiki。
      const resolved = resolveWikiScope({ botId }, params.scope ?? defaultWikiScope(project), {
        project,
      });
      if (!resolved.ok) return scopeFailure(resolved.message);
      try {
        const owner: WikiOwner =
          resolved.scope === 'project' ? resolved.owner : { kind: 'bot', id: botId };
        const outcome = wiki.enqueueIngest({
          owner,
          botId,
          conversationId: identity.conversationId,
          source: {
            sourceType: params.source_type,
            ref: params.ref,
            note: params.note,
          },
          createdBy: { kind: 'bot', id: botId },
        });
        return outcome.ok
          ? { ok: true, content: outcome.message }
          : { ok: false, content: outcome.message, errorCode: 'INVALID_INPUT' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, content: message, errorCode: 'INVALID_INPUT' };
      }
    },
  };

  // Registered only in a project conversation (WP10 §4 步骤 2); membership and
  // the entry-level ACL are enforced at execute time and again in the job.
  const wikiRemoveSource: ToolDefinition<{ source_id: string }> | null =
    project === null
      ? null
      : {
          name: 'wiki_remove_source',
          description:
            '删除项目 Wiki 里的一份来源（异步托管动作，登记后稍后生效，不需要等待）。只能删除自己添加的来源；负责人可以删除任意来源。删除后，引用它的页面会在下一次体检时被整理。',
          parameters: Type.Object({
            source_id: Type.String({ description: '来源 id（ast_…，见台账或维护 loop 的反馈）' }),
          }),
          execute: async (params): Promise<ToolResult> => {
            const noBot = requireBot();
            if (noBot !== null) return noBot;
            const botId = identity.botId!;
            const resolved = resolveWikiScope({ botId }, 'project', { project });
            if (!resolved.ok || resolved.scope === 'mine') {
              return scopeFailure(resolved.ok ? '只有项目组对话里才有项目 wiki' : resolved.message);
            }
            if (project!.leadBotId === null) {
              return scopeFailure('项目组没有负责人，无法登记删除');
            }
            try {
              wiki.enqueueRemoveSource({
                owner: resolved.owner,
                sourceId: params.source_id,
                actor: { role: resolved.role, botId },
                leadBotId: project!.leadBotId,
                conversationId: project!.conversationId,
              });
              return {
                ok: true,
                content:
                  '已登记删除，稍后生效；删除完成后，引用它的页面会在下一次体检时被整理，无需等待或播报进度。',
              };
            } catch (error) {
              const message =
                error instanceof AppError
                  ? error.message
                  : error instanceof Error
                    ? error.message
                    : String(error);
              return { ok: false, content: message, errorCode: 'INVALID_INPUT' };
            }
          },
        };

  const tools: ToolDefinition[] = [wikiSearch, wikiRead, wikiEnqueue];
  if (wikiRemoveSource !== null) tools.push(wikiRemoveSource);
  return tools;
}
