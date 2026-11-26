import { AGENT_CATALOG } from '@kepcup/shared';
import { fakeAgentEntry } from '@kepcup/testkit';
import { runAgentProviderContract, type ContractMode } from './agent-provider.contract.js';

/**
 * 契约测试入口（vitest 只收 `*.test.ts`）：目录内每个 testkit 假 Agent 条目，
 * 外加一个仅以数据新增的第二条目（扩展性验证：core 代码零改动即可通过）；
 * 再以假 Agent 剧本模拟 Claude / Codex 的行为差异（指令下发方式、会话模式、
 * MCP 工具镜像更新里结构化名字的位置），驱动它们的 Provider 跑同一组用例。
 * 真实 Agent 由 P0 spike 脚本手动执行。
 */
const entries = [
  ...AGENT_CATALOG.filter((entry) => entry.releaseGate === 'testkit'),
  fakeAgentEntry('fake-alt', { name: 'Fake Agent Alt', version: '1.2.3' }),
];

for (const entry of entries) {
  for (const mode of ['in-process', 'subprocess'] as ContractMode[]) {
    runAgentProviderContract({ entry, mode });
  }
}

const claude = AGENT_CATALOG.find((entry) => entry.id === 'claude-acp')!;
const codex = AGENT_CATALOG.find((entry) => entry.id === 'codex-acp')!;

runAgentProviderContract({
  entry: fakeAgentEntry('fake-claude', {
    provider: 'claude',
    nativeCapabilities: claude.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'claude_meta',
  // claude-agent-acp 0.113.0 permissions/options/shared.js
  permission: {
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow-with-updates', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
    ],
    allow: 'allow-once',
    reject: 'reject',
  },
  scriptDefaults: {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'acceptEdits', name: 'Accept Edits' },
        { id: 'plan', name: 'Plan' },
        { id: 'dontAsk', name: "Don't Ask" },
        { id: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    },
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-codex', {
    provider: 'codex',
    nativeCapabilities: codex.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'codex_raw_input',
  // codex-acp 2.12.1 ApprovalOptionId / McpApprovalOptionId
  permission: {
    options: [
      { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Session', kind: 'allow_always' },
      { optionId: 'decline', name: 'No', kind: 'reject_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    allow: 'allow_once',
    reject: 'decline',
  },
  scriptDefaults: {
    modes: {
      currentModeId: 'agent',
      availableModes: [
        { id: 'read-only', name: 'Read-only' },
        { id: 'workspace-write', name: 'Workspace access' },
        { id: 'agent', name: 'Auto review' },
        { id: 'agent-full-access', name: 'Full access' },
      ],
    },
  },
});

// —— P5：OpenCode / DeepSeek Harness / Cursor / Antigravity（剧本模拟其已知差异，
// 来源见各 Provider 模块头注释）——

const opencode = AGENT_CATALOG.find((entry) => entry.id === 'opencode')!;
const dsh = AGENT_CATALOG.find((entry) => entry.id === 'dsh')!;
const cursor = AGENT_CATALOG.find((entry) => entry.id === 'cursor')!;
const antigravity = AGENT_CATALOG.find((entry) => entry.id === 'antigravity-acp')!;

runAgentProviderContract({
  entry: fakeAgentEntry('fake-opencode', {
    provider: 'opencode',
    nativeCapabilities: opencode.nativeCapabilities,
  }),
  mode: 'in-process',
  // V2 carries a structured name, but this shared fake emits the generic
  // `mcp__server__tool` spelling. OpenCode's real `server_tool` recognition is
  // covered directly in agent-providers-p5.test.ts.
  mirrorNameIn: 'opaque',
  // opencode 2.4.2 ACP permission options.
  permission: {
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'once',
    reject: 'reject',
  },
  scriptDefaults: {
    agentInfo: { name: 'OpenCode', version: '2.4.2' },
    // The control connection advertises both terminal-auth capabilities.
    authMethods: [
      {
        id: 'opencode-login',
        name: 'Login with opencode',
        description: 'Run `opencode auth login` in the terminal',
        type: 'terminal',
        args: ['--login'],
        _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'] } },
      },
    ],
    // No session modes: the `mode` config option (build / plan) only.
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opencode/big-pickle',
        options: [{ value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' }],
      },
      {
        id: 'mode',
        name: 'Session Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [
          { value: 'build', name: 'build' },
          { value: 'plan', name: 'plan' },
        ],
      },
    ],
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-dsh', {
    provider: 'dsh',
    tier: 'preview',
    nativeCapabilities: dsh.nativeCapabilities,
  }),
  mode: 'in-process',
  // @deepseek-ai/dsh-acp 0.2.0-rc.2 one-shot options.
  permission: {
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'allow-once',
    reject: 'reject-once',
  },
  scriptDefaults: {
    agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
    authMethods: [],
    // No modes, no load; config has model / reasoning_effort only.
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: '["deepseek-official","deepseek-v4-flash"]',
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek',
            options: [
              { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
            ],
          },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-cursor', {
    provider: 'cursor',
    nativeCapabilities: cursor.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'cursor_raw_input',
  // cursor-agent 2026.11.22 permission options.
  permission: {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'allow-once',
    reject: 'reject-once',
  },
  scriptDefaults: {
    agentInfo: { name: 'Cursor', version: '2026.11.22' },
    authMethods: [{ id: 'cursor_login', name: 'Cursor Login', description: 'Browser login' }],
    // Sessions start in `agent` (globally forbidden name, safe for Cursor).
    modes: {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'plan', name: 'Plan' },
        { id: 'ask', name: 'Ask' },
      ],
    },
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-antigravity', {
    provider: 'antigravity',
    tier: 'preview',
    nativeCapabilities: antigravity.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'antigravity_meta',
  // agy_acp_server 1.5.2 permission options.
  permission: {
    options: [
      { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
    allow: 'allow',
    reject: 'deny',
  },
  scriptDefaults: {
    agentInfo: { name: 'agy_acp_server', version: '1.5.2' },
    authMethods: [
      { id: 'oauth-personal', name: 'Google account' },
      { id: 'oauth-business', name: 'Gemini Enterprise' },
      { id: 'gemini-api-key', name: 'Gemini API key' },
      { id: 'agent-platform', name: 'Agent Platform' },
    ],
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto_edit', name: 'Auto Edit' },
        { id: 'yolo', name: 'YOLO' },
      ],
    },
  },
});

// —— 2026-11 新增专用 Provider：contract 走真实 engine（session/new、权限
// optionId、模式切换、MCP 桥与事件映射），不只断言 Provider 描述符。 ——

const cline = AGENT_CATALOG.find((entry) => entry.id === 'cline')!;
const copilot = AGENT_CATALOG.find((entry) => entry.id === 'github-copilot-cli')!;
const qwen = AGENT_CATALOG.find((entry) => entry.id === 'qwen-code')!;
const grok = AGENT_CATALOG.find((entry) => entry.id === 'grok-build')!;
const kimi = AGENT_CATALOG.find((entry) => entry.id === 'kimi')!;
const goose = AGENT_CATALOG.find((entry) => entry.id === 'goose')!;

runAgentProviderContract({
  entry: fakeAgentEntry('fake-cline', {
    provider: 'cline',
    tier: 'preview',
    nativeCapabilities: cline.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'name',
  // Deterministic: the global Hooks/Plugins/Skills scan is covered by the
  // provider unit test with an injected HOME.
  loadUserConfig: true,
  permission: {
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'allow_once',
    reject: 'reject_once',
  },
  scriptDefaults: {
    modes: {
      currentModeId: 'act',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'act', name: 'Act' },
      ],
    },
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-copilot', {
    provider: 'copilot',
    tier: 'preview',
    nativeCapabilities: copilot.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'name',
  permission: {
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'allow_once',
    reject: 'reject_once',
  },
  scriptDefaults: {
    modes: {
      currentModeId: 'agent',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'agent', name: 'Agent' },
        { id: 'autopilot', name: 'Autopilot' },
      ],
    },
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-qwen', {
    provider: 'qwen',
    tier: 'preview',
    nativeCapabilities: qwen.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'name',
  loadUserConfig: true,
  permission: {
    options: [
      { optionId: 'proceed_once', name: 'Proceed once', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    allow: 'proceed_once',
    reject: 'cancel',
  },
  scriptDefaults: {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'default', name: 'Default' },
        { id: 'auto-edit', name: 'Auto edit' },
        { id: 'auto', name: 'Auto' },
        { id: 'yolo', name: 'YOLO' },
      ],
    },
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-kimi', {
    provider: 'kimi',
    tier: 'preview',
    nativeCapabilities: kimi.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'name',
  permission: {
    options: [
      { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'approve_once',
    reject: 'reject',
  },
  scriptDefaults: {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
        { id: 'auto', name: 'Auto' },
        { id: 'yolo', name: 'YOLO' },
      ],
    },
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-grok', {
    provider: 'grok',
    tier: 'preview',
    nativeCapabilities: grok.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'opaque',
  permission: {
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'allow_once',
    reject: 'reject_once',
  },
});

runAgentProviderContract({
  entry: fakeAgentEntry('fake-goose', {
    provider: 'goose',
    tier: 'preview',
    nativeCapabilities: goose.nativeCapabilities,
  }),
  mode: 'in-process',
  mirrorNameIn: 'name',
  permission: {
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
    allow: 'allow_once',
    reject: 'reject_once',
  },
});
