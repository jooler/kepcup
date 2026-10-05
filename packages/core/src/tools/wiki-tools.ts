import { Type } from '@earendil-works/pi-ai';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/** The slice of WikiService the response-loop tools consume. */
export interface WikiToolFacade {
  search(
    botId: string,
    query: string,
    limit: number,
  ): Array<{ path: string; title: string; snippet: string }>;
  readPage(botId: string, path: string): { path: string; title: string; content: string };
  enqueueIngest(input: {
    botId: string;
    conversationId: string | null;
    source: { sourceType: 'attachment' | 'url' | 'file'; ref: string; note: string };
  }): { ok: boolean; message: string };
}

const WIKI_SEARCH_RESULT_MAX = 20;

/**
 * Response-loop wiki tools (docs/dev/04-agent-runtime.md 工具目录, R 列;
 * access = conversation). The response loop is READ-ONLY towards the wiki
 * (design/05 读写规则 单一写入者): search + read only, writes happen in the
 * serialized wiki maintenance loop. wiki_enqueue is a pure registration
 * (fire-and-forget job, no side effect outside the bot's own wiki), so it
 * needs no confirmation — same posture as create_skill.
 */
export function buildWikiTools(input: {
  identity: RunIdentity;
  wiki: WikiToolFacade;
}): ToolDefinition[] {
  const { identity, wiki } = input;

  const wikiSearch: ToolDefinition<{ query: string; limit?: number }> = {
    name: 'wiki_search',
    description: '全文检索你维护的 Wiki，返回页面路径、标题与片段。回答问题前先查这里是否已有沉淀。',
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词' }),
      limit: Type.Optional(Type.Number({ description: '返回条数上限，默认 20' })),
    }),
    execute: async (params): Promise<ToolResult> => {
      if (identity.botId === null) {
        return { ok: false, content: '当前执行没有所属 Bot', errorCode: 'INVALID_INPUT' };
      }
      const hits = wiki.search(
        identity.botId,
        params.query,
        Math.min(50, Math.max(1, Math.floor(params.limit ?? WIKI_SEARCH_RESULT_MAX))),
      );
      if (hits.length === 0) {
        return { ok: true, content: 'Wiki 中没有匹配的页面。' };
      }
      const lines = hits.map((hit) => `- [${hit.title}]（${hit.path}）：${hit.snippet}`);
      return {
        ok: true,
        content: `<untrusted>\n${lines.join('\n')}\n</untrusted>`,
      };
    },
  };

  const wikiRead: ToolDefinition<{ path: string }> = {
    name: 'wiki_read',
    description:
      '读取你 Wiki 中一个页面的全文（路径限定为 pages/ 下的页面或 index.md；路径来自 wiki_search 或 <wiki_topics>）。',
    parameters: Type.Object({
      path: Type.String({ description: '页面路径（相对 wiki 根目录，例如 pages/go-generics.md）' }),
    }),
    execute: async (params): Promise<ToolResult> => {
      if (identity.botId === null) {
        return { ok: false, content: '当前执行没有所属 Bot', errorCode: 'INVALID_INPUT' };
      }
      try {
        const page = wiki.readPage(identity.botId, params.path);
        return {
          ok: true,
          content: `<untrusted>\n# ${page.title}\n\n${page.content}\n</untrusted>`,
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
  }> = {
    name: 'wiki_enqueue',
    description:
      '登记一个 Wiki 入库任务（用户说“学一下这份文档”或你认为某资料值得沉淀时使用）。来源：attachment（附件 id）、url（网页地址）、file（workspace 或 project 中的文件路径）。后台维护 loop 会阅读资料、更新页面并提交；这是你自己的知识库整理，完成后无需向用户播报，wiki_search 直接就能检索到新内容。',
    parameters: Type.Object({
      source_type: Type.Union(
        ['attachment', 'url', 'file'].map((t) => Type.Literal(t)),
        { description: '来源类型' },
      ),
      ref: Type.String({
        description: '来源引用：附件 id（att_...）/ 完整 URL / 文件路径',
      }),
      note: Type.String({ description: '一句话说明这份资料是什么、为什么要入库' }),
    }),
    execute: async (params): Promise<ToolResult> => {
      if (identity.botId === null) {
        return { ok: false, content: '当前执行没有所属 Bot', errorCode: 'INVALID_INPUT' };
      }
      const outcome = wiki.enqueueIngest({
        botId: identity.botId,
        conversationId: identity.conversationId,
        source: {
          sourceType: params.source_type,
          ref: params.ref,
          note: params.note,
        },
      });
      return outcome.ok
        ? { ok: true, content: outcome.message }
        : { ok: false, content: outcome.message, errorCode: 'INVALID_INPUT' };
    },
  };

  return [wikiSearch, wikiRead, wikiEnqueue];
}
