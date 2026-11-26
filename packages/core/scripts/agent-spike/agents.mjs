// Agent 配置表：每个 Agent 的启动方式、分发来源、登录提示。
// distribution:
//   npx    { package }                       -> `npx -y <package> [args]`
//   binary { registryId, large? }            -> 从 ACP Registry 下载归档（校验 sha256），解压后执行 cmd + args
//   system { detect }                        -> 使用本机已装程序（--command 指定或 PATH 查找）
//   shim   { }                               -> 无 ACP，只做安装检测
//   fake   { }                               -> 仓库内假 Agent，也供 testkit 复用（可被 --command 覆盖）
// 其余字段：
//   apiKeyEnv      该 Agent 的 API key 环境变量（只做 --pass-env 提示，脚本不读取）
//   loginHint      用户登录提示（真正的命令以 initialize.authMethods 为准）
//   isolateMeta    --isolate 时合并进 session/new._meta 的「尽量不读用户 / 项目配置」预设
//   instructionMode  'meta-append' | 'prompt-prefix'（见设计 28 §9.2）
//   readOnlyModeIds  complete 用例优先切换的只读 / 精简模式 id（按顺序取第一个存在的）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export const AGENTS = {
  claude: {
    id: 'claude',
    title: 'Claude Agent',
    distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.113.0' } },
    args: [],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    loginHint:
      'terminal 认证：命令取自 initialize.authMethods（claude-ai-login / console-login / 远程环境 claude-login，args 追加到 agent 调用后）',
    instructionMode: 'meta-append',
    isolateMeta: { claudeCode: { options: { settingSources: [] } } },
    readOnlyModeIds: ['plan'],
  },
  codex: {
    id: 'codex',
    title: 'Codex',
    distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.12.1' } },
    args: [],
    apiKeyEnv: 'OPENAI_API_KEY',
    loginHint:
      '认证方式见 initialize.authMethods（chat-gpt 由 Agent 自行处理；api-key 用 OPENAI_API_KEY / CODEX_API_KEY）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['read-only'],
  },
  opencode: {
    id: 'opencode',
    title: 'OpenCode',
    distribution: { binary: { registryId: 'opencode' } },
    args: ['acp'],
    loginHint: '`opencode auth login`（terminal 认证，命令取自 authMethods）；不要登录 Claude 订阅',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['plan'],
  },
  dsh: {
    id: 'dsh',
    title: 'DeepSeek Harness',
    distribution: { npx: { package: '@deepseek-ai/dsh@0.2.0-rc.2' } },
    args: ['--profile', 'acp'],
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    loginHint: '无登录流程，需 DEEPSEEK_API_KEY（--pass-env DEEPSEEK_API_KEY）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: [],
  },
  cursor: {
    id: 'cursor',
    title: 'Cursor',
    distribution: { binary: { registryId: 'cursor', large: true } },
    args: ['acp'],
    apiKeyEnv: 'CURSOR_API_KEY',
    loginHint: '`cursor-agent login`（或 CURSOR_API_KEY）；体积 0.5–1 GB，下载需 --allow-large',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['ask', 'plan'],
  },
  antigravity: {
    id: 'antigravity',
    title: 'Google Antigravity',
    distribution: { binary: { registryId: 'antigravity-acp', large: true } },
    args: [],
    apiKeyEnv: 'GEMINI_API_KEY',
    loginHint:
      'gemini-api-key / oauth-personal（条款风险自负）/ oauth-business；禁止 gateway / agent-platform；体积约 1 GB，下载需 --allow-large',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: [],
    forbiddenAuthMethodIds: ['gateway', 'agent-platform'],
  },
  cline: {
    id: 'cline',
    title: 'Cline',
    distribution: { npx: { package: 'cline@3.0.76' } },
    args: ['--acp'],
    apiKeyEnv: 'CLINE_API_KEY',
    loginHint: 'Cline 账号（ACP authenticate `cline`）或设备码；各家 API key',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['plan'],
  },
  copilot: {
    id: 'copilot',
    title: 'GitHub Copilot',
    distribution: { npx: { package: '@github/copilot@1.0.116' } },
    args: ['--acp', '--no-auto-update'],
    loginHint: 'Copilot 订阅（`copilot login`，浏览器 / 设备码）；登出走 ACP logout',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['plan'],
  },
  goose: {
    id: 'goose',
    title: 'goose（Registry 完整 CLI；产品使用 lean goose-acp）',
    distribution: { binary: { registryId: 'goose' } },
    args: ['acp'],
    loginHint: 'goose 配置内各家 provider key（`goose configure`）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: [],
  },
  qwen: {
    id: 'qwen',
    title: 'Qwen Code',
    distribution: { npx: { package: '@qwen-code/qwen-code@0.28.6' } },
    args: ['--acp'],
    apiKeyEnv: 'OPENAI_API_KEY',
    loginHint: 'ACP `openai` API key（`--pass-env OPENAI_API_KEY`）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['plan'],
  },
  kimi: {
    id: 'kimi',
    title: 'Kimi Code',
    distribution: { npx: { package: '@moonshot-ai/kimi-code@2.8.1' } },
    args: ['acp'],
    loginHint: '`kimi login`（设备码；ACP terminal auth 为 `kimi acp --login`）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['plan'],
  },
  grok: {
    id: 'grok',
    title: 'Grok Build',
    distribution: { npx: { package: '@xai-official/grok@1.0.92' } },
    args: ['--no-auto-update', 'agent', 'stdio'],
    apiKeyEnv: 'XAI_API_KEY',
    loginHint: 'grok.com 登录（OAuth / 设备码）或 XAI_API_KEY',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: [],
  },
  devin: {
    id: 'devin',
    title: 'Devin',
    distribution: { binary: { registryId: 'devin' } },
    args: ['acp'],
    loginHint: 'Devin 账号（ACP authenticate `devin-browser`）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: [],
  },
  zcode: {
    id: 'zcode',
    title: 'ZCode',
    distribution: { shim: {} },
    args: [],
    loginHint: '`zcode login`（桌面应用内置 CLI；无 ACP，本脚本只检测安装）',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: [],
  },
  fake: {
    id: 'fake',
    title: 'Fake ACP agent（脚本自测 / 预留给 testkit）',
    distribution: { fake: {} },
    command: process.execPath,
    args: [path.join(here, 'fake-agent.mjs')],
    loginHint: '无',
    instructionMode: 'prompt-prefix',
    readOnlyModeIds: ['plan'],
  },
};

export const ALL_STEPS = [
  'initialize',
  'auth',
  'session',
  'prompt',
  'steer',
  'cancel',
  'permission',
  'mcp',
  'modes',
  'complete',
  'native',
];
