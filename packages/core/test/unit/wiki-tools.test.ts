import { describe, expect, it } from 'vitest';
import type { WikiOwner } from '@kepcup/shared';

import type { RunIdentity, ToolDefinition } from '../../src/agent/types.js';
import {
  buildWikiTools,
  type WikiProjectContext,
  type WikiSourceStub,
  type WikiToolFacade,
} from '../../src/tools/wiki-tools.js';

/**
 * D92 T1b WP10 步骤 2：wiki 工具的 `scope` 选择、搜索结果的 scope 前缀、
 * wiki_read 的可信度包裹（保守判定四种情形）、wiki_enqueue 的 job payload、
 * wiki_remove_source 的 ACL 与异步语义（含非项目会话不注册）。
 */

const BOT = 'bot_a';
const LEAD = 'bot_lead';
const MEMBER = 'bot_member';
const OUTSIDER = 'bot_outsider';
const DIRECT = 'conv_direct';
const PROJECT = 'conv_project';

interface EnqueueCall {
  owner: WikiOwner;
  botId: string;
  conversationId: string | null;
  source: { sourceType: 'attachment' | 'url' | 'file'; ref: string; note: string };
  createdBy: { kind: 'user' } | { kind: 'bot'; id: string };
}

interface RemoveCall {
  owner: WikiOwner;
  sourceId: string;
  actor: { role: 'lead' | 'member' | 'user'; botId?: string };
  leadBotId: string;
  conversationId: string;
}

interface Harness {
  tools: ToolDefinition[];
  wiki: {
    search: Array<{ owner: WikiOwner; query: string }>;
    readPages: Array<{ owner: WikiOwner; path: string }>;
    enqueued: EnqueueCall[];
    removals: RemoveCall[];
  };
}

const harness: Harness = { tools: [], wiki: { search: [], readPages: [], enqueued: [], removals: [] } };

function projectContext(asMember: readonly string[] = [LEAD, MEMBER]): WikiProjectContext {
  return { conversationId: PROJECT, leadBotId: LEAD, memberBotIds: asMember };
}

function identity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_x', botId, conversationId, loopType: 'turn' };
}

function toolOf(name: string): ToolDefinition {
  const tool = harness.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

interface FacadeOptions {
  project: WikiProjectContext | null;
  hits?: (owner: WikiOwner) => Array<{ path: string; title: string; snippet: string }>;
  page?: (owner: WikiOwner, path: string) => { title: string; content: string };
  sources?: WikiSourceStub[];
  removeError?: (call: RemoveCall) => string | null;
  botNames?: Record<string, string>;
}

function fresh(options: FacadeOptions, botId = MEMBER, conversationId = PROJECT): void {
  const local: Harness = { tools: [], wiki: { search: [], readPages: [], enqueued: [], removals: [] } };
  const facade: WikiToolFacade = {
    search: (owner, query) => {
      local.wiki.search.push({ owner, query });
      return (options.hits ?? (() => []))(owner);
    },
    readPage: (owner, path) => {
      local.wiki.readPages.push({ owner, path });
      return (options.page ?? (() => ({ title: '页', content: '' })))(owner, path);
    },
    enqueueIngest: (input) => {
      local.wiki.enqueued.push(input);
      return { ok: true, message: '已登记入库任务' };
    },
    enqueueRemoveSource: (input) => {
      const error = options.removeError?.(input) ?? null;
      if (error !== null) throw Object.assign(new Error(error), { code: 'INVALID_INPUT' });
      local.wiki.removals.push(input);
    },
    listSources: (owner) => (owner.kind === 'project' ? (options.sources ?? []) : []),
    botName: (botId2) => options.botNames?.[botId2] ?? null,
    projectContext: (conversationId2) =>
      options.project !== null && conversationId2 === options.project.conversationId
        ? options.project
        : null,
  };
  local.tools = buildWikiTools({ identity: identity(botId, conversationId), wiki: facade });
  harness.tools = local.tools;
  harness.wiki = local.wiki;
}

const USER_ASSET: WikiSourceStub = { id: 'ast_111111111111111111111111', createdBy: { kind: 'user' } };
const BOT_ASSET: WikiSourceStub = { id: 'ast_222222222222222222222222', createdBy: { kind: 'bot', id: MEMBER } };
const DELETED_BOT_ASSET: WikiSourceStub = {
  id: 'ast_333333333333333333333333',
  createdBy: { kind: 'bot', id: 'bot_gone' },
};

describe('D92 T1b WP10：scope 解析与注册（resolveWikiScope / buildWikiTools）', () => {
  it('非项目会话：传 project / all → 工具失败；wiki_remove_source 未注册', async () => {
    fresh({ project: null }, BOT, DIRECT);
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      'wiki_search',
      'wiki_read',
      'wiki_enqueue',
    ]);
    const search = toolOf('wiki_search');
    const failed = (await search.execute({ query: 'x', scope: 'project' })) as {
      ok: boolean;
      content: string;
      errorCode: string;
    };
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe('INVALID_INPUT');
    expect(failed.content).toContain('只有项目组对话里才有项目 wiki');
    const failedAll = (await search.execute({ query: 'x', scope: 'all' })) as { ok: boolean };
    expect(failedAll.ok).toBe(false);
  });

  it('项目会话的非成员（外表 Bot）→ 失败', async () => {
    fresh({ project: projectContext() }, OUTSIDER, PROJECT);
    const failed = (await toolOf('wiki_search').execute({
      query: 'x',
      scope: 'project',
    })) as { ok: boolean; content: string };
    expect(failed.ok).toBe(false);
    expect(failed.content).toContain('不是该项目组的成员');
  });

  it('wiki_search 默认 scope：项目组对话为 all（结果带 [project] / [mine] 前缀、项目在前），单聊为 mine', async () => {
    fresh(
      {
        project: projectContext(),
        hits: (owner) =>
          owner.kind === 'project'
            ? [{ path: 'pages/p1.md', title: '项目页', snippet: '共享片段' }]
            : [{ path: 'pages/m1.md', title: '个人页', snippet: '私人片段' }],
      },
      MEMBER,
      PROJECT,
    );
    const result = (await toolOf('wiki_search').execute({ query: '共享' })) as {
      ok: boolean;
      content: string;
    };
    expect(result.ok).toBe(true);
    const lines = result.content.split('\n');
    expect(lines.some((line) => line.includes('[project] [项目页]（pages/p1.md）'))).toBe(true);
    expect(lines.some((line) => line.includes('[mine] [个人页]（pages/m1.md）'))).toBe(true);
    expect(lines.findIndex((l) => l.includes('[project]'))).toBeLessThan(
      lines.findIndex((l) => l.includes('[mine]')),
    );
    // 直查两边的 owner 形态正确。
    expect(harness.wiki.search.map((call) => call.owner)).toEqual([
      { kind: 'project', id: PROJECT },
      { kind: 'bot', id: MEMBER },
    ]);

    fresh({ project: null, hits: () => [{ path: 'pages/m1.md', title: '个人页', snippet: 's' }] }, BOT, DIRECT);
    const mine = (await toolOf('wiki_search').execute({ query: 'x' })) as { content: string };
    expect(mine.content).toContain('[mine] [个人页]（pages/m1.md）');
    expect(mine.content).not.toContain('[project]');
  });

  it('wiki_read scope=project 的可信度包裹四种情形', async () => {
    const page = (content: string) => (_owner: WikiOwner, _path: string) => ({
      title: '项目页',
      content,
    });
    // ① 全部出处为用户 → 不包裹。
    fresh({
      project: projectContext(),
      page: page(`结论\n\n[源：a](../raw/_assets/${USER_ASSET.id}.json)`),
      sources: [USER_ASSET],
    });
    const trusted = (await toolOf('wiki_read').execute({
      path: 'pages/p.md',
      scope: 'project',
    })) as { content: string };
    expect(trusted.content).not.toContain('<untrusted');
    expect(trusted.content).toContain('# 项目页');

    // ② 含 Bot 出处 → 包裹并列出提交者（成员名）。
    fresh({
      project: projectContext(),
      page: page(
        `结论\n\n[源：a](../raw/_assets/${USER_ASSET.id}.json)\n[源：b](../raw/_assets/${BOT_ASSET.id}.json)`,
      ),
      sources: [USER_ASSET, BOT_ASSET],
      botNames: { [MEMBER]: '成员甲' },
    });
    const untrusted = (await toolOf('wiki_read').execute({
      path: 'pages/p.md',
      scope: 'project',
    })) as { content: string };
    expect(untrusted.content).toContain('<untrusted source="project_wiki">');
    expect(untrusted.content).toContain('（来源提交者：用户、成员甲）');
    expect(untrusted.content.indexOf('（来源提交者：')).toBeLessThan(
      untrusted.content.indexOf('<untrusted'),
    );

    // ③ 无出处引用 → 包裹并标「无来源引用」。
    fresh({ project: projectContext(), page: page('没有任何引用的页面'), sources: [USER_ASSET] });
    const noCite = (await toolOf('wiki_read').execute({
      path: 'pages/p.md',
      scope: 'project',
    })) as { content: string };
    expect(noCite.content).toContain('<untrusted source="project_wiki">');
    expect(noCite.content).toContain('（无来源引用）');

    // ④ Bot 已删除的提交者显示 id；悬空引用同样按不可信包裹。
    fresh({
      project: projectContext(),
      page: page(`[源：c](../raw/_assets/${DELETED_BOT_ASSET.id}.json)`),
      sources: [DELETED_BOT_ASSET],
      botNames: {},
    });
    const gone = (await toolOf('wiki_read').execute({
      path: 'pages/p.md',
      scope: 'project',
    })) as { content: string };
    expect(gone.content).toContain(`（来源提交者：bot_gone）`);

    // mine 读取（默认）仍走 Bot 自己的 wiki 与既有 untrusted 包裹。
    fresh({ project: projectContext(), page: page('自己的页面'), sources: [BOT_ASSET] });
    const mineRead = (await toolOf('wiki_read').execute({ path: 'pages/m.md' })) as {
      content: string;
    };
    expect(mineRead.content).toContain('<untrusted>\n# 项目页');
    expect(harness.wiki.readPages).toEqual([{ owner: { kind: 'bot', id: MEMBER }, path: 'pages/m.md' }]);
  });

  it('wiki_enqueue：默认 mine、显式 project 的 job payload（owner / createdBy / 执行者）', async () => {
    fresh({ project: projectContext() }, MEMBER, PROJECT);
    // 默认 mine。
    await toolOf('wiki_enqueue').execute({
      source_type: 'url',
      ref: 'https://example.com/a',
      note: '资料',
    });
    expect(harness.wiki.enqueued[0]).toMatchObject({
      owner: { kind: 'bot', id: MEMBER },
      botId: MEMBER,
      conversationId: PROJECT,
      createdBy: { kind: 'bot', id: MEMBER },
    });
    // 显式 project。
    await toolOf('wiki_enqueue').execute({
      source_type: 'url',
      ref: 'https://example.com/b',
      note: '共享资料',
      scope: 'project',
    });
    expect(harness.wiki.enqueued[1]).toMatchObject({
      owner: { kind: 'project', id: PROJECT },
      botId: MEMBER,
      conversationId: PROJECT,
      createdBy: { kind: 'bot', id: MEMBER },
    });
  });

  it('wiki_remove_source 的 ACL：成员删他人失败；负责人删他人入队；成员删自己入队', async () => {
    // 成员删他人 → 服务端快速失败 → 工具失败结果（带人话原因）。
    fresh({
      project: projectContext(),
      removeError: () => '只能删除自己添加的来源',
    });
    const denied = (await toolOf('wiki_remove_source').execute({
      source_id: 'ast_999999999999999999999999',
    })) as { ok: boolean; content: string; errorCode: string };
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain('只能删除自己添加的来源');
    expect(denied.errorCode).toBe('INVALID_INPUT');
    expect(harness.wiki.removals).toHaveLength(0);

    // 负责人删他人 → 入队（actor.role = lead）。
    fresh({ project: projectContext() }, LEAD, PROJECT);
    await toolOf('wiki_remove_source').execute({ source_id: 'ast_888888888888888888888888' });
    expect(harness.wiki.removals[0]).toMatchObject({
      owner: { kind: 'project', id: PROJECT },
      sourceId: 'ast_888888888888888888888888',
      actor: { role: 'lead', botId: LEAD },
      leadBotId: LEAD,
      conversationId: PROJECT,
    });

    // 成员删自己 → 入队（actor.role = member）。
    fresh({ project: projectContext() }, MEMBER, PROJECT);
    const ok = (await toolOf('wiki_remove_source').execute({
      source_id: 'ast_777777777777777777777777',
    })) as { ok: boolean; content: string };
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain('已登记删除');
    expect(harness.wiki.removals[0]).toMatchObject({
      actor: { role: 'member', botId: MEMBER },
    });
  });
});
