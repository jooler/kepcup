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
       * `^0.86.0`），缺省 = 不限。
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
  /** 图标随应用打包（`apps/desktop/resources/agents/`），不在运行时拉 CDN。 */
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
  version: '0.86.0',
  description: "ACP wrapper for Anthropic's Claude",
  repository: 'https://github.com/agentclientprotocol/claude-agent-acp',
  authors: ['Anthropic', 'Zed Industries', 'JetBrains'],
  license: 'proprietary',
  icon: 'claude-acp.svg',
  distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.86.0' } },
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
 * npx 分发、精确锁版本（Registry `codex-acp`）；MCP 仅 http。
 */
const CODEX_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'codex-acp',
  name: 'Codex',
  version: '2.1.1',
  description: "ACP adapter for OpenAI's coding assistant",
  repository: 'https://github.com/agentclientprotocol/codex-acp',
  authors: ['OpenAI', 'JetBrains s.r.o', 'Zed Industries'],
  license: 'Apache-2.0',
  icon: 'codex-acp.svg',
  distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.1.1' } },
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
  version: '1.18.35',
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
          'https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-darwin-arm64.zip',
        cmd: './opencode',
        args: ['acp'],
        sha256: '80b05124357a77cd57945bfde36082a028e829c198d222d5e146617f49a2c4b7',
      },
      'darwin-x86_64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-darwin-x64.zip',
        cmd: './opencode',
        args: ['acp'],
        sha256: '8127d69e8e94d7adc496e910435f2f73856d87d456e988d3a947f250c95c1be2',
      },
      'linux-aarch64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-linux-arm64.tar.gz',
        cmd: './opencode',
        args: ['acp'],
        sha256: 'f7f2ba59ee8aa94d388f9696575a32d20e71c2ee48def9f80fc693a60fec6c72',
      },
      'linux-x86_64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-linux-x64.tar.gz',
        cmd: './opencode',
        args: ['acp'],
        sha256: 'c8f888b451f5494a18f858fffb0e0b68f4e4baa9c241761c5f206884f0fa640d',
      },
      'windows-aarch64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-windows-arm64.zip',
        cmd: './opencode.exe',
        args: ['acp'],
        sha256: '3c144f54fea5d56afb00174fd3134709803a7bb6ce990963044831b671bd9882',
      },
      'windows-x86_64': {
        archive:
          'https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-windows-x64.zip',
        cmd: './opencode.exe',
        args: ['acp'],
        sha256: 'c90d248cca75e42fd15422a29b5f83a1b30c441af83565635d6b2682adc58dd1',
      },
    },
  },
  provider: 'opencode',
  transport: 'acp',
  tier: 'supported',
  // 原生工具（opencode 1.18.35 内置 webfetch / websearch / read〔图片〕）；待登录实测。
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
};

/**
 * Cursor（design 28 §9.2）：原生 `cursor-agent acp`，binary 分发
 * （downloads.cursor.com）。Registry 未给 sha256：6 个平台归档均已由导入脚本
 * （`--hash`）下载计算锁定，并与独立下载的 sha256sum 交叉核对一致。认证：
 * `cursor_login`（Agent 自行打开浏览器登录）或 `CURSOR_API_KEY`；用量计入 Cursor
 * 套餐额度。
 */
const CURSOR_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'cursor',
  name: 'Cursor',
  version: '2026.10.01',
  description: "Cursor's coding agent",
  website: 'https://cursor.com/docs/cli/acp',
  authors: ['Cursor'],
  license: 'proprietary',
  icon: 'cursor.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://downloads.cursor.com/lab/2026.10.01-14929f9/darwin/arm64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: '778d04e542adc5c8b6760fda3ebe0757f903b1764f2792c232ef9a35e6e2151b',
      },
      'darwin-x86_64': {
        archive:
          'https://downloads.cursor.com/lab/2026.10.01-14929f9/darwin/x64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: '8930008f9902a4d02d3185c0d34071e0536bac3426439b55bcfd48b78765a3dd',
      },
      'linux-aarch64': {
        archive:
          'https://downloads.cursor.com/lab/2026.10.01-14929f9/linux/arm64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: 'c31ef0ba6b827fdf8053919de57abae4a7bd71afefdf2cab061e276faac42b3a',
      },
      'linux-x86_64': {
        archive:
          'https://downloads.cursor.com/lab/2026.10.01-14929f9/linux/x64/agent-cli-package.tar.gz',
        cmd: './dist-package/cursor-agent',
        args: ['acp'],
        sha256: 'ba9a855f8f813c91b9f2707127572d2dc9ae5a62818e1c36719625d0fb8bd452',
      },
      'windows-aarch64': {
        archive:
          'https://downloads.cursor.com/lab/2026.10.01-14929f9/windows/arm64/agent-cli-package.zip',
        cmd: './dist-package\\cursor-agent.cmd',
        args: ['acp'],
        sha256: 'eda025bf9cc7632e48d290fa52468104916f0db261e2fa44306ad184cd1274c9',
      },
      'windows-x86_64': {
        archive:
          'https://downloads.cursor.com/lab/2026.10.01-14929f9/windows/x64/agent-cli-package.zip',
        cmd: './dist-package\\cursor-agent.cmd',
        args: ['acp'],
        sha256: '2558ae1ddc155f43791e8eed145afa0366c5ad6a266b0e40c0b5c9490a945a5f',
      },
    },
  },
  provider: 'cursor',
  transport: 'acp',
  tier: 'supported',
  // 权限请求里出现的原生 web 工具（web_fetch / web_search，见 cursor-agent
  // 2026.10.01 的 tool-call 呈现）；确切工具名待登录实测。
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
 * 分发（dl.google.com）。Registry 未给 sha256：6 个平台归档均已下载计算锁定。
 * 条款第 6 条禁止第三方软件经个人 Google 账号（Antigravity OAuth）访问——
 * Provider 只放行 `gemini-api-key` 与 `agent-platform`（Vertex），过滤
 * `oauth-personal` / `oauth-business`，并以私有 `GEMINI_HOME` 隔离用户在其它
 * 客户端里选过的登录方式。`preview` 档。
 */
const ANTIGRAVITY_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'antigravity-acp',
  name: 'Google Antigravity',
  version: '1.3.0',
  description: 'Google’s AI coding agent',
  website: 'https://antigravity.google/docs/ide/extensions',
  authors: ['Google LLC'],
  license: 'proprietary',
  icon: 'antigravity-acp.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
        cmd: './agy_acp_server.par',
        sha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
      },
      'darwin-x86_64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
        cmd: './agy_acp_server.par',
        sha256: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
      },
      'linux-aarch64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip',
        cmd: './agy_acp_server.par',
        args: ['--uid='],
        sha256: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
      },
      'linux-x86_64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
        cmd: './agy_acp_server.par',
        args: ['--uid='],
        sha256: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
      },
      'windows-aarch64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip',
        cmd: './agy_acp_server.exe',
        sha256: '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3',
      },
      'windows-x86_64': {
        archive:
          'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
        cmd: './agy_acp_server.exe',
        sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
      },
    },
  },
  provider: 'antigravity',
  transport: 'acp',
  tier: 'preview',
  // 待登录（配 key）后实测原生工具名（web 检索 / 读图）。
  nativeCapabilities: {},
  auth: {
    kinds: ['api-key'],
    note: 'Gemini API key（AI Studio）或 Vertex AI（agent-platform）；不支持 Google 个人账号登录',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  // 解压后：linux ≈ 1.06 GB、macOS ≈ 407 MB、Windows ≈ 227 MB（取最大）。
  sizeBytes: 1_060_000_000,
  terms: { noticeKey: 'agents.terms.antigravity' },
  releaseGate: 'antigravity',
};

/**
 * 策展目录：只在实验开关 `settings.experimental.externalAgents` 打开时可选。
 * P2 收录 Claude Agent 与 Codex（安装器在 P4：此前只能经测试缝启动）；
 * P5 收录 OpenCode、DeepSeek Harness、Cursor、Google Antigravity。
 */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  FAKE_AGENT_ENTRY,
  CLAUDE_AGENT_ENTRY,
  CODEX_AGENT_ENTRY,
  OPENCODE_AGENT_ENTRY,
  DSH_AGENT_ENTRY,
  CURSOR_AGENT_ENTRY,
  ANTIGRAVITY_AGENT_ENTRY,
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
