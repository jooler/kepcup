import { z } from 'zod';
import { nativeCapabilityKeySchema } from './host-capabilities.js';

/**
 * 智能体目录（docs/design/28-external-agents-acp.md §2.1，D72）。
 *
 * 条目与 ACP Registry（`cdn.agentclientprotocol.com/registry/v1/latest/
 * registry.json`）同构，另加 KepCup 扩展字段；本期是随应用打包、精确锁版本
 * 的策展目录，可由 `scripts/import-acp-registry.mjs` 从 Registry 导出骨架后
 * 人工补扩展字段。与 vendors.ts 一样只承载描述性数据：进程管理、协议与
 * 行为差异在 core 的 `agent/external/`（Provider 按 `provider` 字段选取）。
 */

/** ACP Registry 的平台键（binary 分发按平台给归档）。 */
export const agentPlatformSchema = z.enum([
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'windows-aarch64',
  'windows-x86_64',
]);
export type AgentPlatform = z.infer<typeof agentPlatformSchema>;

/** 目录 id：小写字母数字与 `.-_`；`agent:{id}` 是调度键 / 引擎键 / 伪 ref 前缀。 */
export const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** 安装根内的相对路径（`/` 分隔，段为文件名或 `*`，不含 `.` / `..`）。 */
export const AGENT_INSTALL_RELATIVE_GLOB =
  /^(?:\*|(?!\.{1,2}(?:\/|$))[A-Za-z0-9@._-]+)(?:\/(?:\*|(?!\.{1,2}(?:\/|$))[A-Za-z0-9@._-]+))*$/;

export const agentDistributionSchema = z.object({
  npx: z
    .object({
      package: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      /**
       * 窄化的安装后步骤（P5 审查 H3）：安装器一律 `npm ci --ignore-scripts`，
       * 个别包的 install 脚本只是恢复预编译文件的可执行位（如 node-pty 的
       * `spawn-helper`）——这里逐条列出相对安装根的路径（段可为 `*`），安装后
       * 只对匹配到的普通文件 chmod 0755，不放开任何脚本。
       */
      postInstall: z
        .object({
          chmodExecutable: z.array(z.string().regex(AGENT_INSTALL_RELATIVE_GLOB)),
        })
        .optional(),
    })
    .optional(),
  binary: z
    .partialRecord(
      agentPlatformSchema,
      z.object({
        archive: z.string().url(),
        cmd: z.string().min(1),
        args: z.array(z.string()).optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .optional(),
  /** 本期不支持（目录可保留字段）。 */
  uvx: z.object({ package: z.string().min(1), args: z.array(z.string()).optional() }).optional(),
  /** KepCup 扩展：复用用户已装的官方 CLI（`detect` 为版本探测参数）。 */
  system: z
    .object({
      cmd: z.string().min(1),
      args: z.array(z.string()).optional(),
      detect: z.array(z.string()),
      /**
       * 兼容的版本范围（P4 安装器探测时校验；如 `>=1.2.0 <2`、`3.14.x`、
       * `^1.2.0`），缺省 = 不限。
       */
      versionRange: z.string().optional(),
    })
    .optional(),
});
export type AgentDistribution = z.infer<typeof agentDistributionSchema>;

/**
 * 目录 / 已安装版本：semver（`x.y.z[-pre][+build]`）。版本号会拼进安装目录名
 * `toolchains/agents/{id}@{version}`，因此不允许路径分隔符。
 */
export const agentVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export const agentCatalogEntrySchema = z.object({
  // —— 与 ACP Registry 同名同义 ——
  id: agentIdSchema,
  name: z.string().min(1),
  version: agentVersionSchema,
  description: z.string(),
  repository: z.string().optional(),
  website: z.string().optional(),
  authors: z.array(z.string()),
  license: z.string(),
  /** 图标随应用打包（渲染层把文件名映射到内置品牌图标），不在运行时拉 CDN。 */
  icon: z.string(),
  distribution: agentDistributionSchema,
  // —— KepCup 扩展 ——
  /** Provider 模块 id（core `agent/external/providers/` 的 PROVIDERS 登记表）。 */
  provider: z.string().min(1),
  /** `shim` = 进程内协议垫片（不支持 ACP 的 Agent）。 */
  transport: z.enum(['acp', 'shim']),
  /** `preview` 档默认权限更严、UI 标注。 */
  tier: z.enum(['supported', 'preview']),
  /** 自带能力 → 原生工具名（能力包默认值与 `<tool_policy>` 点名）。 */
  nativeCapabilities: z.partialRecord(nativeCapabilityKeySchema, z.array(z.string())),
  auth: z.object({
    /**
     * `anonymous`：未登录也可用（如 OpenCode 自带的匿名免费模型），状态机在
     * 未登录时仍可为 `ready`，设置卡提示「登录后可用订阅模型」（todo 附录
     * A.4 第 3 条）。
     */
    kinds: z.array(z.enum(['subscription', 'api-key', 'gateway', 'anonymous'])),
    note: z.string(),
    /**
     * API key 类认证注入的环境变量名（如 DeepSeek Harness 的
     * `DEEPSEEK_API_KEY`）：key 存 secrets `agent:{id}:api-key`，启动 Agent
     * 进程时以此变量注入（D25）。缺省 = 该 Agent 不经 KepCup 配置 key。
     */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
  }),
  /** 安装后约占磁盘（字节，审批 / 安装确认卡展示）；缺省 = 未知。 */
  sizeBytes: z.number().int().min(0).optional(),
  /** 条款提示文案 key（可随版本下线某个 Agent）。 */
  terms: z.object({ noticeKey: z.string() }).optional(),
  /**
   * 发行门禁：发行构建（apps/desktop/scripts/dist.mjs）只收录门禁已放行的
   * 条目，未声明视为未放行（fail-closed）；开发构建与测试不受影响。
   */
  releaseGate: z.string().optional(),
  /**
   * 启动 + ACP `initialize` 的超时上限覆盖（D118）：个别 Agent 启动很重
   * （DeepSeek Harness 的 npx 冷启动约 77 s，超过缺省的 60 s）。缺省
   * `AGENT_INIT_TIMEOUT_MS`。
   */
  initTimeoutMs: z.number().int().min(1000).optional(),
});
export type AgentCatalogEntry = z.infer<typeof agentCatalogEntrySchema>;

/** Bot 使用外部 Agent 时的权限档位（§6）。 */
export const agentPermissionTierSchema = z.enum(['read_only', 'workspace', 'ask']);
export type AgentPermissionTier = z.infer<typeof agentPermissionTierSchema>;

/** `runs.engine` 的内置引擎值；外部 Agent 为 `agent:{id}`。 */
export const BUILTIN_ENGINE = 'builtin';
/** 调度器 provider 键 / `runs.engine` / 伪模型 ref 的公共前缀。 */
export const AGENT_KEY_PREFIX = 'agent:';
/** 伪 ref 中「未指定模型 = Agent 默认」的占位段。 */
export const AGENT_DEFAULT_MODEL_SEGMENT = 'default';

export function agentEngineKey(agentId: string): string {
  return `${AGENT_KEY_PREFIX}${agentId}`;
}

/** 外部 Agent Bot 的伪模型 ref：`agent:{id}/{model||default}`。 */
export function agentModelRef(agentId: string, model: string): string {
  return `${agentEngineKey(agentId)}/${model.length > 0 ? model : AGENT_DEFAULT_MODEL_SEGMENT}`;
}

/**
 * 实际下发给 Agent 的模型：Bot 自己的选择优先，留空回退到设置页里该智能体的
 * 默认模型，'' = 两者都没有（用 Agent 自己的默认）。
 */
export function resolveAgentModel(
  runtimeModel: string,
  setting: { model?: string } | null | undefined,
): string {
  return runtimeModel.length > 0 ? runtimeModel : (setting?.model ?? '');
}

/** 解析伪 ref；不是 `agent:` 开头返回 null。`model` 为 '' 表示 Agent 默认。 */
export function parseAgentModelRef(ref: string): { agentId: string; model: string } | null {
  if (!ref.startsWith(AGENT_KEY_PREFIX)) return null;
  const rest = ref.slice(AGENT_KEY_PREFIX.length);
  const slash = rest.indexOf('/');
  const agentId = slash === -1 ? rest : rest.slice(0, slash);
  const model = slash === -1 ? '' : rest.slice(slash + 1);
  if (agentId.length === 0) return null;
  return { agentId, model: model === AGENT_DEFAULT_MODEL_SEGMENT ? '' : model };
}

/**
 * testkit 的剧本化假 Agent（`@kepcup/testkit` 的 fake-acp-agent）。只经通用
 * Provider 驱动；`releaseGate: 'testkit'` 永不放行 → 发行构建不收录。
 * 启动方式由测试注入（P1 没有安装器）。
 */
const FAKE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'fake',
  name: 'Fake Agent',
  version: '0.0.0',
  description: 'testkit 剧本化 ACP 假智能体（开发与测试专用）',
  authors: ['KepCup'],
  license: 'MIT',
  icon: 'fake.svg',
  distribution: {
    system: { cmd: 'kepcup-fake-acp-agent', detect: ['--version'] },
  },
  provider: 'generic-acp',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: { kinds: [], note: '无需登录' },
  releaseGate: 'testkit',
};

/**
 * Claude Agent（design 28 §9.2）：Anthropic 官方 ACP 适配器，npx 分发、精确锁版本
 * （Registry `claude-acp`）。开发期按启用处理，是否随发行版发布由
 * `releaseGate:'claude'` 在发行前决定（§9.3）。
 */
const CLAUDE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'claude-acp',
  name: 'Claude Agent',
  version: '0.113.0',
  description: "ACP wrapper for Anthropic's Claude",
  repository: 'https://github.com/agentclientprotocol/claude-agent-acp',
  authors: ['Anthropic', 'Zed Industries', 'JetBrains'],
  license: 'proprietary',
  icon: 'claude-acp.svg',
  distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.113.0' } },
  provider: 'claude',
  transport: 'acp',
  tier: 'supported',
  // 原生能力 → 原生工具名（能力包默认值与 <tool_policy> 点名）。离线 spike 只
  // 确认了工具存在；登录后的 P0 spike 需实测确认（todo §3.1「原生能力清单」）。
  nativeCapabilities: { web: ['WebSearch', 'WebFetch'], vision: ['Read'] },
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Claude Pro / Max 订阅或 Anthropic Console（官方 terminal 登录）',
  },
  terms: { noticeKey: 'agents.terms.claude' },
  releaseGate: 'claude',
};

/**
 * Codex（design 28 §9.2）：OpenAI 共同维护的 ACP 适配器（内含 `@openai/codex`），
 * npx 分发、精确锁版本（Registry `codex-acp`）；MCP 支持 stdio / http / acp。
 */
const CODEX_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'codex-acp',
  name: 'Codex',
  version: '2.12.1',
  description: "ACP adapter for OpenAI's coding assistant",
  repository: 'https://github.com/agentclientprotocol/codex-acp',
  authors: ['OpenAI', 'JetBrains s.r.o', 'Zed Industries'],
  license: 'Apache-2.0',
  icon: 'codex-acp.svg',
  distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.12.1' } },
  provider: 'codex',
  transport: 'acp',
  tier: 'supported',
  // 待登录后的 P0 spike 实测确认（图像生成 `image_gen` 等未列入）。
  nativeCapabilities: { web: ['web_search'] },
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'ChatGPT 订阅或 OpenAI API key（由 Codex 自行完成登录）',
  },
  terms: { noticeKey: 'agents.terms.codex' },
  releaseGate: 'codex',
};

/**
 * OpenCode（design 28 §9.2）：原生 `opencode acp`，binary 分发（GitHub release，
 * Registry `opencode` 给出的 sha256 已逐个下载复核一致）。未登录即可用自带的
 * 匿名免费模型（`opencode/*-free`），登录（`opencode auth login`，terminal 认证只在
 * `_meta['terminal-auth']`）后可用订阅 / API key 模型；**不要**登录 Claude 订阅。
 * Registry 的 windows-aarch64 `cmd` 写作 `./opencode`，归档内实际是
 * `opencode.exe`（已核对归档目录），此处更正。
 */
const OPENCODE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'opencode',
  name: 'OpenCode',
  version: '2.4.2',
  description: 'The open source coding agent',
  repository: 'https://github.com/anomalyco/opencode',
  website: 'https://opencode.ai',
  authors: ['Anomaly'],
  license: 'MIT',
  icon: 'opencode.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-darwin-arm64.zip',
        cmd: './opencode',
        args: ['acp'],
        sha256: 'd5a8c9fb4b121ebd531d9369d7ba6ce8af91c9d4d51d6685dbb4e0c7224fa5f3',
      },
      'darwin-x86_64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-darwin-x64.zip',
        cmd: './opencode',
        args: ['acp'],
        sha256: 'ea4204a75602ce4f1d2121c781a15fa3af6d1c4285cf8b6ae81f61a76deca2a2',
      },
      'linux-aarch64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-linux-arm64.tar.gz',
        cmd: './opencode',
        args: ['acp'],
        sha256: 'bf8d18dde87224629341ff398e76c7c17216b9b406affc728b6c1a5c136abf93',
      },
      'linux-x86_64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-linux-x64.tar.gz',
        cmd: './opencode',
        args: ['acp'],
        sha256: '452912288f934d1771bd5bd0d8611ba3a6adc3db3ac3333c37facf373770ba66',
      },
      'windows-aarch64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-windows-arm64.zip',
        cmd: './opencode.exe',
        args: ['acp'],
        sha256: '0081574c145d60fc6b0079db558ca1b071394b8ccc4549424dec0acb66706942',
      },
      'windows-x86_64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-windows-x64.zip',
        cmd: './opencode.exe',
        args: ['acp'],
        sha256: 'a8ab3034ca5b3ec8476e9ee73b1dc334b6d8e93edaaf224b3d2a5205e2cbfb99',
      },
    },
  },
  provider: 'opencode',
  transport: 'acp',
  tier: 'supported',
  // 原生工具（opencode 2.4.2 内置 webfetch / websearch / read〔图片〕）；待登录实测。
  nativeCapabilities: { web: ['webfetch', 'websearch'], vision: ['read'] },
  auth: {
    kinds: ['subscription', 'api-key', 'anonymous'],
    note: '未登录可用自带免费模型；`opencode auth login` 登录 GitHub Copilot / ChatGPT / Z.AI 等（不要登录 Claude 订阅）',
  },
  // 解压后的单个可执行文件：linux ≈ 186 MB（各平台 144–186 MB，取最大）。
  sizeBytes: 186_000_000,
  terms: { noticeKey: 'agents.terms.opencode' },
  releaseGate: 'opencode',
};

/**
 * DeepSeek Harness（design 28 §9.2）：原生 `dsh --profile acp`，npx 分发、精确锁
 * 版本（不在 ACP Registry；官方定位 automation-only，preview）。无登录流程，
 * 只用 `DEEPSEEK_API_KEY`；不支持 `session/load` / modes / 图片；很重（npx 冷
 * 启动约 77 s、约 760 MB）。
 */
const DSH_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  version: '0.2.0-rc.2',
  description: 'DeepSeek Harness automation agent (ACP profile)',
  repository: 'https://github.com/deepseek-ai/deepseek-harness',
  website: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
  authors: ['DeepSeek'],
  license: 'MIT',
  icon: 'dsh.svg',
  distribution: {
    npx: {
      package: '@deepseek-ai/dsh@0.2.0-rc.2',
      args: ['--profile', 'acp'],
      // @deepseek-ai/dsh-subprocess-local 的 postinstall 只为 node-pty 预编译的
      // spawn-helper 恢复可执行位（macOS 上缺它命令无法执行，待 Mac 真机验证）。
      postInstall: { chmodExecutable: ['node_modules/node-pty/prebuilds/*/spawn-helper'] },
    },
  },
  provider: 'dsh',
  transport: 'acp',
  tier: 'preview',
  // dsh-tool-web（web 抓取 / 搜索）；工具名待登录（配 key）后实测。
  nativeCapabilities: {},
  auth: {
    kinds: ['api-key'],
    note: 'DeepSeek API key（按量计费，无订阅制）',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  // 离线 spike：npx 缓存约 758 MB。
  sizeBytes: 800_000_000,
  terms: { noticeKey: 'agents.terms.dsh' },
  releaseGate: 'dsh',
  // npx 冷启动约 77 s（离线 spike，todo 附录 A.4）：超过缺省的 60 s（D118）。
  initTimeoutMs: 120_000,
};

/**
 * Cursor（design 28 §9.2）：原生 `cursor-agent acp`，binary 分发
 * （downloads.cursor.com）。6 个平台归档均锁定官方 `.sha256` sidecar。认证：
 * `cursor_login`（Agent 自行打开浏览器登录）或 `CURSOR_API_KEY`；用量计入 Cursor
 * 套餐额度。
 */
const CURSOR_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'cursor',
  name: 'Cursor',
  version: '2026.11.22',
  description: "Cursor's coding agent",
  website: 'https://cursor.com/docs/cli/acp',
  authors: ['Cursor'],
  license: 'proprietary',
  icon: 'cursor.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://downloads.cursor.com/lab/2026.11.22-e9042b2/darwin/arm64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: '92f39e448218897538bd801cdb01d69106ab37a86aaf3dc0e6b55159c79b75e2',
      },
      'darwin-x86_64': {
        archive:
          'https://downloads.cursor.com/lab/2026.11.22-e9042b2/darwin/x64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: '16cc7314128243b24d74575cae5f7e1a215656d48115d55084e2d6725ef7c542',
      },
      'linux-aarch64': {
        archive:
          'https://downloads.cursor.com/lab/2026.11.22-e9042b2/linux/arm64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: '7b7dd0020fb9a2a9e1e7e3f39e2f9f512d1dd9577174ecda8aa82ac31dbc9565',
      },
      'linux-x86_64': {
        archive:
          'https://downloads.cursor.com/lab/2026.11.22-e9042b2/linux/x64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: '7663b1c5d1b56e095ef8e23bef38d66df6cfd665c4873470214e0e411f0f97b3',
      },
      'windows-aarch64': {
        archive:
          'https://downloads.cursor.com/lab/2026.11.22-e9042b2/windows/arm64/agent-cli-package.zip',
        cmd: './dist-package\\cursor-agent.cmd',
        args: ['acp'],
        sha256: 'e920523e611c8568a9b137e0e156861d5f6a5781a58a782f0025c311b3093d7f',
      },
      'windows-x86_64': {
        archive:
          'https://downloads.cursor.com/lab/2026.11.22-e9042b2/windows/x64/agent-cli-package.zip',
        cmd: './dist-package\\cursor-agent.cmd',
        args: ['acp'],
        sha256: '4bf0afdadaa41c2cb58508cb50984656a35b9d494fc92944ed1132a8a067086f',
      },
    },
  },
  provider: 'cursor',
  transport: 'acp',
  tier: 'supported',
  // 权限请求里出现的原生 web 工具（web_fetch / web_search，见 cursor-agent
  // 2026.11.22 的 tool-call 呈现）；确切工具名待登录实测。
  nativeCapabilities: { web: ['web_search', 'web_fetch'] },
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Cursor 账号（浏览器登录，计入 Cursor 套餐额度）或 CURSOR_API_KEY',
    apiKeyEnv: 'CURSOR_API_KEY',
  },
  // 解压后：linux ≈ 582 MB、macOS ≈ 619 MB、Windows ≈ 258 MB（取最大）。
  sizeBytes: 620_000_000,
  terms: { noticeKey: 'agents.terms.cursor' },
  releaseGate: 'cursor',
};

/**
 * Google Antigravity（design 28 §9.2 / §9.3）：原生 `agy_acp_server`，binary
 * 分发（dl.google.com）。6 个平台归档锁定官方 ACP Registry 的 sha256。
 * 条款第 6 条禁止第三方软件经个人 Google 账号（Antigravity OAuth）访问——
 * 2026-11-26 凭据策略修订：应用只提供能力 + 风险提示，由用户自行权衡
 * （`oauth-personal` 经 UI 二次确认后可触发；`oauth-business` 为 Google 建议
 * 的合规通道；`gemini-api-key` 不受限）。默认仍以私有 `GEMINI_HOME` 隔离用户
 * 在其它客户端里选过的登录方式，「复用本机登录」开启后共享本机 `~/.gemini`。
 * `preview` 档。
 */
const ANTIGRAVITY_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'antigravity-acp',
  name: 'Google Antigravity',
  version: '1.5.2',
  description: 'Google’s AI coding agent',
  website: 'https://antigravity.google/docs/ide/extensions',
  authors: ['Google LLC'],
  license: 'proprietary',
  icon: 'antigravity-acp.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip',
        cmd: './agy_acp_server.par',
        sha256: '123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845',
      },
      'darwin-x86_64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-x86_64.zip',
        cmd: './agy_acp_server.par',
        sha256: '92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06',
      },
      'linux-aarch64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-arm64.zip',
        cmd: './agy_acp_server.par',
        args: ['--uid='],
        sha256: 'e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb',
      },
      'linux-x86_64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip',
        cmd: './agy_acp_server.par',
        args: ['--uid='],
        sha256: '99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852',
      },
      'windows-aarch64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-arm64.zip',
        cmd: './agy_acp_server.exe',
        sha256: '8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab',
      },
      'windows-x86_64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-x86_64.zip',
        cmd: './agy_acp_server.exe',
        sha256: '5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6',
      },
    },
  },
  provider: 'antigravity',
  transport: 'acp',
  tier: 'preview',
  // 待登录（配 key）后实测原生工具名（web 检索 / 读图）。
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Gemini API key（AI Studio）、Google 账号 OAuth（浏览器授权，条款风险自负）或 Gemini Enterprise；Vertex 暂不可用',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  // 解压后：linux ≈ 1.06 GB、macOS ≈ 407 MB、Windows ≈ 227 MB（取最大）。
  sizeBytes: 1_060_000_000,
  terms: { noticeKey: 'agents.terms.antigravity' },
  releaseGate: 'antigravity',
};

/**
 * Cline（D118 新目标，官方 stable `cline` 3.0.76）：`cline --acp`，npx 分发、精确
 * 锁版本。认证：Cline 账号（ACP authenticate method `cline`，Agent 自行开浏览器
 * ——OpenBot 实跑）或设备码；也接受各家 API key。专属 Provider 固定 plan / act、
 * 一次性权限、私有 `CLINE_DIR`，并扫描无法隔离的个人 Hooks / Plugins / Skills。
 */
const CLINE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'cline',
  name: 'Cline',
  version: '3.0.76',
  description:
    'Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more',
  repository: 'https://github.com/cline/cline',
  website: 'https://cline.bot/cli',
  authors: ['Cline Bot Inc.'],
  license: 'Apache-2.0',
  icon: 'cline.svg',
  distribution: { npx: { package: 'cline@3.0.76', args: ['--acp'] } },
  provider: 'cline',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Cline 账号（官方登录）或各家 API key；用量计入 Cline / 对应厂商',
    apiKeyEnv: 'CLINE_API_KEY',
  },
  terms: { noticeKey: 'agents.terms.cline' },
  releaseGate: 'cline',
};

/**
 * GitHub Copilot（D118 新目标，官方 stable `github-copilot-cli` 1.0.116）：
 * `copilot --acp`，npx 分发（`@github/copilot`）。认证：Copilot 订阅（`copilot
 * login`，浏览器或设备码）；登出走 ACP `logout` 方法（OpenBot 实跑）。差异待
 * 真机 spike。
 */
const COPILOT_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'github-copilot-cli',
  name: 'GitHub Copilot',
  version: '1.0.116',
  description: "GitHub's AI pair programmer",
  repository: 'https://github.com/github/copilot-cli',
  website: 'https://github.com/features/copilot/cli/',
  authors: ['GitHub'],
  license: 'proprietary',
  icon: 'github-copilot-cli.svg',
  distribution: {
    npx: { package: '@github/copilot@1.0.116', args: ['--acp', '--no-auto-update'] },
  },
  provider: 'copilot',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'GitHub Copilot 订阅（官方登录，计入 Copilot 套餐额度）',
  },
  terms: { noticeKey: 'agents.terms.copilot' },
  releaseGate: 'github-copilot-cli',
};

/**
 * goose（D118 新目标，官方 stable `goose` 1.61.1，AAIF 开源）：直接运行官方
 * lean `goose-acp` binary（无子命令；无 windows-aarch64 归档）。认证：goose
 * 配置内的各家 provider key（goose 自管，不经 KepCup 注入）。差异待真机 spike。
 */
const GOOSE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'goose',
  name: 'goose',
  version: '1.61.1',
  description: 'A local, extensible, open source AI agent that automates engineering tasks',
  repository: 'https://github.com/aaif-goose/goose',
  website: 'https://goose-docs.ai/',
  authors: ['AAIF'],
  license: 'Apache-2.0',
  icon: 'goose.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://github.com/aaif-goose/goose/releases/download/v1.61.1/goose-acp-aarch64-apple-darwin.tar.gz',
        cmd: './goose-acp',
        sha256: 'b1feb9d08907dc49786b9b0b11bd54f92bbc456dc4b795e694e685013382385b',
      },
      'darwin-x86_64': {
        archive:
          'https://github.com/aaif-goose/goose/releases/download/v1.61.1/goose-acp-x86_64-apple-darwin.tar.gz',
        cmd: './goose-acp',
        sha256: '2df980ec9c7a5149d3e6cb0617821f519f089c6c34f813c236c61d77bac552e8',
      },
      'linux-aarch64': {
        archive:
          'https://github.com/aaif-goose/goose/releases/download/v1.61.1/goose-acp-aarch64-unknown-linux-gnu.tar.gz',
        cmd: './goose-acp',
        sha256: 'a7a9bd1da54420872aae2897299a55b98eaef6128d962ccf7029f0101e815c49',
      },
      'linux-x86_64': {
        archive:
          'https://github.com/aaif-goose/goose/releases/download/v1.61.1/goose-acp-x86_64-unknown-linux-gnu.tar.gz',
        cmd: './goose-acp',
        sha256: '515706537cfa1fa38a0744bea004528a37d37f98c9da363cea6e13136e267fb4',
      },
      'windows-x86_64': {
        archive:
          'https://github.com/aaif-goose/goose/releases/download/v1.61.1/goose-acp-x86_64-pc-windows-msvc.zip',
        cmd: './goose-acp.exe',
        sha256: 'b1d4f1085e1dbd1e6b32ff35aa8abb27cd89cfd858e02c171573b2bcf4988ce8',
      },
    },
  },
  provider: 'goose',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['api-key'],
    note: 'goose 配置内的各家 provider key（在 goose 自己的配置里登录；需开启「加载我的个人配置」才能复用已有 key）',
  },
  terms: { noticeKey: 'agents.terms.goose' },
  releaseGate: 'goose',
};

/**
 * Qwen Code（D118 新目标，官方 stable `qwen-code` 0.28.6，Alibaba）：`qwen --acp`，
 * npx 分发。认证：ACP `openai` API key（`OPENAI_API_KEY`）。差异待真机 spike。
 */
const QWEN_CODE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'qwen-code',
  name: 'Qwen Code',
  version: '0.28.6',
  description: "Alibaba's Qwen coding assistant",
  repository: 'https://github.com/QwenLM/qwen-code',
  website: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
  authors: ['Alibaba Qwen Team'],
  license: 'Apache-2.0',
  icon: 'qwen-code.svg',
  distribution: {
    npx: {
      package: '@qwen-code/qwen-code@0.28.6',
      args: ['--acp'],
    },
  },
  provider: 'qwen',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['api-key'],
    note: 'Qwen Code ACP 的 openai API key（OPENAI_API_KEY）',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  terms: { noticeKey: 'agents.terms.qwen-code' },
  releaseGate: 'qwen-code',
};

/**
 * Kimi Code（D118 新目标，官方 stable `kimi-code` 2.8.1，Moonshot AI）：
 * `kimi acp`，npx 分发。Kimi CLI Legacy 1.52.0 已归档且 `kimi acp` 只打印弃用
 * 提示后退出，因此迁移到官方继任实现。认证：Kimi Code OAuth / Kimi Platform
 * API key（`kimi login`；ACP terminal auth 执行 `kimi acp --login`）。专属
 * Provider 覆盖 modes、权限 option、
 * 私有 `KIMI_CODE_HOME` 与会话丢失形态。
 */
const KIMI_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'kimi',
  name: 'Kimi Code',
  version: '2.8.1',
  description: "Moonshot AI's coding assistant",
  repository: 'https://github.com/MoonshotAI/kimi-code',
  website: 'https://moonshotai.github.io/kimi-code/',
  authors: ['Moonshot AI'],
  license: 'MIT',
  icon: 'kimi.svg',
  distribution: { npx: { package: '@moonshot-ai/kimi-code@2.8.1', args: ['acp'] } },
  provider: 'kimi',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Kimi Code OAuth 或 Kimi Platform API key（`kimi login`；ACP terminal auth 用 `kimi acp --login`）',
  },
  terms: { noticeKey: 'agents.terms.kimi' },
  releaseGate: 'kimi',
};

/**
 * Grok Build（D118 新目标，官方 stable `grok-build` 1.0.92，xAI）：
 * `grok --no-auto-update agent stdio`，npx 分发（`@xai-official/grok`）。
 * 认证：grok.com 登录（OAuth / 设备码）或 xAI API key。
 */
const GROK_BUILD_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'grok-build',
  name: 'Grok Build',
  version: '1.0.92',
  description: "xAI's coding agent and CLI",
  website: 'https://x.ai/cli',
  authors: ['xAI'],
  license: 'Apache-2.0',
  icon: 'grok-build.svg',
  distribution: {
    npx: {
      package: '@xai-official/grok@1.0.92',
      args: ['--no-auto-update', 'agent', 'stdio'],
    },
  },
  provider: 'grok',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'grok.com 账号（官方登录，计入 xAI 套餐额度）或 xAI API key',
    apiKeyEnv: 'XAI_API_KEY',
  },
  terms: { noticeKey: 'agents.terms.grok-build' },
  releaseGate: 'grok-build',
};

/**
 * Devin（D118 新目标，官方 stable `devin` 3000.15.14，Cognition）：`devin acp`，
 * binary 分发（6 平台 sha256 锁定官方 versioned manifest）。
 * 认证：Devin 账号（ACP authenticate method `devin-browser`）。专属 Provider
 * 只带 `sessionNotFound`（OpenBot 观察到的 `-32016 + cognition.ai/errorKind:
 * session_not_found`，未真机复核）；其余差异待 spike。
 */
const DEVIN_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'devin',
  name: 'Devin',
  version: '3000.15.14',
  description: 'Devin CLI coding agent by Cognition',
  website: 'https://docs.devin.ai/cli',
  repository: 'https://github.com/CognitionAI/devin-cli',
  authors: ['Cognition'],
  license: 'proprietary',
  icon: 'devin.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://static.devin.ai/cli/3000.15.14/devin-3000.15.14-aarch64-apple-darwin.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '23911fdf9b5c45ebefa382e57ff1996e762c2b30a2fe1f4b536fa633e2fcbd1f',
      },
      'darwin-x86_64': {
        archive:
          'https://static.devin.ai/cli/3000.15.14/devin-3000.15.14-x86_64-apple-darwin.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '5f9197bac49d90c1c213a9405326588503d7813942f347cdcc4a21bdab6b5189',
      },
      'linux-aarch64': {
        archive:
          'https://static.devin.ai/cli/3000.15.14/devin-3000.15.14-aarch64-unknown-linux.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '66a84d89ffff16bb0c4acdd8597102d752b3f4bf4ab53ff249637ac6ec698f87',
      },
      'linux-x86_64': {
        archive:
          'https://static.devin.ai/cli/3000.15.14/devin-3000.15.14-x86_64-unknown-linux.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: 'd219f885ed601d1424ae2ecdf5b37441cf60f15a38a4961d2a6f0b41ec913f28',
      },
      'windows-aarch64': {
        archive: 'https://static.devin.ai/cli/3000.15.14/devin-3000.15.14-aarch64-pc-windows.zip',
        cmd: './bin\\devin.exe',
        args: ['acp'],
        sha256: '9caa748fbc943ba8788be245f3ca6f481466501a3c63ea9587f1bd8d52d52209',
      },
      'windows-x86_64': {
        archive: 'https://static.devin.ai/cli/3000.15.14/devin-3000.15.14-x86_64-pc-windows.zip',
        cmd: './bin\\devin.exe',
        args: ['acp'],
        sha256: '7cee2a258d9043a66c84d7f1613418b40d6b0a7a7ea5dc4a20f83fd0a30f5ddf',
      },
    },
  },
  provider: 'devin',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription'],
    note: 'Devin 账号（官方登录，计入 Cognition 套餐额度）',
  },
  terms: { noticeKey: 'agents.terms.devin' },
  releaseGate: 'devin',
};

/**
 * 策展目录（设置页「智能体」列出全部条目，含未启用的）。
 * P2 收录 Claude Agent 与 Codex（安装器在 P4：此前只能经测试缝启动）；
 * P5 收录 OpenCode、DeepSeek Harness、Cursor、Google Antigravity。
 * D118 收录 ACP Registry 已有的 7 个新目标（Cline、GitHub Copilot、goose、
 * Qwen Code、Kimi Code、Grok Build、Devin；来源：OpenBot 0.62.0 预置目标对比
 * 调研，todo/acp-hardening-and-new-targets.md §3）——全部 `preview` 档，
 * `releaseGate` 未进发行放行清单：真机 spike + 合规确认后才随发行版发布。
 */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  FAKE_AGENT_ENTRY,
  CLAUDE_AGENT_ENTRY,
  CODEX_AGENT_ENTRY,
  OPENCODE_AGENT_ENTRY,
  DSH_AGENT_ENTRY,
  CURSOR_AGENT_ENTRY,
  ANTIGRAVITY_AGENT_ENTRY,
  CLINE_AGENT_ENTRY,
  COPILOT_AGENT_ENTRY,
  GOOSE_AGENT_ENTRY,
  QWEN_CODE_AGENT_ENTRY,
  KIMI_AGENT_ENTRY,
  GROK_BUILD_AGENT_ENTRY,
  DEVIN_AGENT_ENTRY,
];

export function findAgentEntry(
  catalog: readonly AgentCatalogEntry[],
  agentId: string,
): AgentCatalogEntry | null {
  return catalog.find((entry) => entry.id === agentId) ?? null;
}

/**
 * 发行门禁过滤：`approvedGates` 为 null（开发构建 / 测试）时原样返回；
 * 否则只保留 `releaseGate` 在放行清单中的条目。**fail-closed**：没有声明
 * `releaseGate` 的条目在发行构建中同样不收录——随发行版发布任何 Agent 都
 * 必须显式放行（apps/desktop/agent-release-gates.json）。
 */
export function filterReleasedAgents(
  catalog: readonly AgentCatalogEntry[],
  approvedGates: readonly string[] | null,
): AgentCatalogEntry[] {
  if (approvedGates === null) return [...catalog];
  return catalog.filter(
    (entry) => entry.releaseGate !== undefined && approvedGates.includes(entry.releaseGate),
  );
}
