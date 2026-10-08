import { AGENT_CATALOG, type AgentCatalogEntry, type HostCapabilityId } from '@kepcup/shared';
import { buildExternalAgentTools, hostToolNamer } from '../../src/agent/external/capabilities.js';
import { PROVIDERS } from '../../src/agent/external/providers/index.js';
import type { AgentProvider } from '../../src/agent/external/types.js';
import { buildAgentToolPolicy } from '../../src/agent/context/system-prompt.js';
import type { ToolDefinition } from '../../src/agent/types.js';

/**
 * 原生优先遵守度（D72 P6，todo §9.1「原生优先遵守度回归」）：产品实际下发给
 * 外部 Agent 的措辞——补位工具的「[补充能力]」描述前缀与 `<tool_policy>`——
 * 按 Provider 生成，写成 `scripts/agent-spike/fixtures/native-first-wording.json`
 * 供真机遵守度脚本（`agent-spike/adherence.mjs`）使用。单测保证该文件与产品
 * 措辞一致（`KEPCUP_UPDATE_WORDING=1` 重新生成）；契约测试保证经引擎 + 宿主桥
 * 真正送达 Agent 的就是它。
 */

/** 脚本里宿主 MCP server 的固定名字（产品为 `kepcup_<8hex>`，按会话随机）。 */
export const ADHERENCE_SERVER_NAME = 'kepcup_adherence';

/** 用例：能力包 + 注入工具（基础描述是占位；产品措辞是前缀与策略）。 */
export const ADHERENCE_CASES: Readonly<
  Record<
    'web' | 'vision',
    {
      capability: HostCapabilityId;
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    }
  >
> = {
  web: {
    capability: 'web',
    tools: [
      {
        name: 'web_search',
        description: '联网搜索：返回标题、链接与摘要。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      {
        name: 'web_fetch',
        description: '抓取网页正文（Markdown）。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
      },
    ],
  },
  vision: {
    capability: 'image_understanding',
    tools: [
      {
        name: 'understand_image',
        description: '识别图片内容（多模态模型）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, question: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
  },
};

export interface WordingCase {
  /** `<tool_policy>` 正文（按 Provider 的工具名写法，server = ADHERENCE_SERVER_NAME）。 */
  policy: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface ProviderWording {
  /** 用这份措辞的目录条目（同一 Provider 的第一个；generic-acp 为 testkit 假 Agent）。 */
  catalogId: string;
  instructionMode: AgentProvider['instructionMode'];
  nativeCapabilities: AgentCatalogEntry['nativeCapabilities'];
  cases: Record<string, WordingCase>;
}

export function adherenceToolDefinitions(caseId: keyof typeof ADHERENCE_CASES): ToolDefinition[] {
  return ADHERENCE_CASES[caseId].tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async () => ({ ok: true, content: 'ADHERENCE-STUB' }),
  }));
}

/** 一个 Provider（以某目录条目的原生能力声明）在各用例下的产品措辞。 */
export function providerWording(entry: AgentCatalogEntry): ProviderWording {
  const provider = PROVIDERS[entry.provider];
  if (provider === undefined) throw new Error(`no provider ${entry.provider}`);
  const toolName = hostToolNamer(provider, ADHERENCE_SERVER_NAME);
  const cases: Record<string, WordingCase> = {};
  for (const [caseId, spec] of Object.entries(ADHERENCE_CASES)) {
    const tools = buildExternalAgentTools({
      responseTools: adherenceToolDefinitions(caseId as keyof typeof ADHERENCE_CASES),
      capabilities: [spec.capability],
    });
    cases[caseId] = {
      policy: buildAgentToolPolicy({
        toolNames: tools.map((tool) => tool.name),
        nativeCapabilities: entry.nativeCapabilities,
        toolName,
      }),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as Record<string, unknown>,
      })),
    };
  }
  return {
    catalogId: entry.id,
    instructionMode: provider.instructionMode,
    nativeCapabilities: entry.nativeCapabilities,
    cases,
  };
}

/** spike 脚本的 Agent 键（`agents.mjs`）→ 目录条目 id。 */
export const SPIKE_AGENT_ENTRIES: Readonly<Record<string, string>> = {
  fake: 'fake',
  claude: 'claude-acp',
  codex: 'codex-acp',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'cursor',
  antigravity: 'antigravity-acp',
};

/** 整份 fixture（键 = spike 的 Agent 键）。 */
export function nativeFirstWordingFixture(): {
  serverName: string;
  generatedBy: string;
  agents: Record<string, ProviderWording>;
} {
  const agents: Record<string, ProviderWording> = {};
  for (const [spikeId, catalogId] of Object.entries(SPIKE_AGENT_ENTRIES)) {
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === catalogId);
    if (entry === undefined) throw new Error(`catalog entry ${catalogId} missing`);
    agents[spikeId] = providerWording(entry);
  }
  return {
    serverName: ADHERENCE_SERVER_NAME,
    generatedBy:
      'packages/core/test/unit/native-first-wording.test.ts（KEPCUP_UPDATE_WORDING=1 重新生成）',
    agents,
  };
}
