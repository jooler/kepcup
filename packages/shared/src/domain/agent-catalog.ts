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
  // npx 冷启动约 77 s（离线 spike，todo 附录 A.4）：超过缺省的 60 s（D118）。
  initTimeoutMs: 120_000,
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
 * InkCop（design 28 / InkCop ACP 规划 §10）：本机已装 `inkcop-acp` stdio 适配器，
 * 经通用 ACP Provider 附着已运行的 InkCop 主对话。密钥与登录态只在 InkCop 应用内
 * （桥开关：InkCop「设置 → 服务 → ACP 智能体」）；发行门禁 `inkcop` 预览期不放行。
 */
const INKCOP_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'inkcop',
  name: 'InkCop',
  version: '0.1.0',
  description: 'InkCop 主对话（写作），经 ACP 暴露给 KepCup 任务引擎',
  authors: ['InkCop'],
  license: 'proprietary',
  icon: 'inkcop.svg',
  distribution: {
    system: {
      cmd: 'inkcop-acp',
      detect: ['--version'],
      versionRange: '>=0.1.0',
    },
  },
  provider: 'generic-acp',
  transport: 'acp',
  tier: 'preview',
  // P0 工具默认关；P1 只读工具名再核对后填入。
  nativeCapabilities: {},
  auth: {
    kinds: ['anonymous'],
    note: '请先启动并登录 InkCop，并在 InkCop「设置 → 服务 → ACP 智能体」开启桥；密钥不经 KepCup 注入',
  },
  terms: { noticeKey: 'agents.terms.inkcop' },
  releaseGate: 'inkcop',
};



/**
 * Cline（D118 新目标，Registry `cline` 3.0.74）：`cline --acp`，npx 分发、精确
 * 锁版本。认证：Cline 账号（ACP authenticate method `cline`，Agent 自行开浏览器
 * ——OpenBot 实跑）或设备码；也接受各家 API key。差异（权限 optionId、原生
 * 工具、错误形态）待真机 spike 后再决定是否需要专属 Provider。
 */
const CLINE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'cline',
  name: 'Cline',
  version: '3.0.74',
  description: 'Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more',
  repository: 'https://github.com/cline/cline',
  website: 'https://cline.bot/cli',
  authors: ['Cline Bot Inc.'],
  license: 'Apache-2.0',
  icon: 'cline.svg',
  distribution: { npx: { package: 'cline@3.0.74', args: ['--acp'] } },
  provider: 'generic-acp',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Cline 账号（官方登录）或各家 API key；用量计入 Cline / 对应厂商',
  },
  terms: { noticeKey: 'agents.terms.cline' },
  releaseGate: 'cline',
};

/**
 * GitHub Copilot（D118 新目标，Registry `github-copilot-cli` 1.0.105）：
 * `copilot --acp`，npx 分发（`@github/copilot`）。认证：Copilot 订阅（`copilot
 * login`，浏览器或设备码）；登出走 ACP `logout` 方法（OpenBot 实跑）。差异待
 * 真机 spike。
 */
const COPILOT_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'github-copilot-cli',
  name: 'GitHub Copilot',
  version: '1.0.105',
  description: "GitHub's AI pair programmer",
  repository: 'https://github.com/github/copilot-cli',
  website: 'https://github.com/features/copilot/cli/',
  authors: ['GitHub'],
  license: 'proprietary',
  icon: 'github-copilot-cli.svg',
  distribution: { npx: { package: '@github/copilot@1.0.105', args: ['--acp'] } },
  provider: 'generic-acp',
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
 * goose（D118 新目标，Registry `goose` 1.57.0，Block 开源）：`goose acp`，binary
 * 分发（Registry 自带 sha256；无 windows-aarch64 归档）。认证：goose 配置内的
 * 各家 provider key（goose 自管，不经 KepCup 注入）。差异待真机 spike。
 */
const GOOSE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'goose',
  name: 'goose',
  version: '1.57.0',
  description: 'A local, extensible, open source AI agent that automates engineering tasks',
  repository: 'https://github.com/block/goose',
  website: 'https://block.github.io/goose/',
  authors: ['Block'],
  license: 'Apache-2.0',
  icon: 'goose.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://github.com/block/goose/releases/download/v1.57.0/goose-aarch64-apple-darwin.tar.bz2',
        cmd: './goose',
        args: ['acp'],
        sha256: '2fbafa227ab28654c47065f1c9ebcd12f527f017e30c08e618bc6fcf363d7935',
      },
      'darwin-x86_64': {
        archive:
          'https://github.com/block/goose/releases/download/v1.57.0/goose-x86_64-apple-darwin.tar.bz2',
        cmd: './goose',
        args: ['acp'],
        sha256: 'e48fe024891a4c272a89c74b9ae843d76a73229643c917b785b0680fef9c647a',
      },
      'linux-aarch64': {
        archive:
          'https://github.com/block/goose/releases/download/v1.57.0/goose-aarch64-unknown-linux-gnu.tar.bz2',
        cmd: './goose',
        args: ['acp'],
        sha256: '17c6b090db6acc5605da904bbe19cc2765bc7a6786019d85a6d0a361de06dbf7',
      },
      'linux-x86_64': {
        archive:
          'https://github.com/block/goose/releases/download/v1.57.0/goose-x86_64-unknown-linux-gnu.tar.bz2',
        cmd: './goose',
        args: ['acp'],
        sha256: 'e54036f3b7f95d3b0d7854c09465af5ef52a28c7fa03d2497d0ea68a6382282d',
      },
      'windows-x86_64': {
        archive:
          'https://github.com/block/goose/releases/download/v1.57.0/goose-x86_64-pc-windows-msvc.zip',
        cmd: './goose-package\\goose.exe',
        args: ['acp'],
        sha256: '1ab2117ceec37f95be4d3ad0cdb921d3e97fd8b0fa244046631ecf4b7619d502',
      },
    },
  },
  provider: 'generic-acp',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['api-key'],
    note: 'goose 配置内的各家 provider key（在 goose 自己的配置里登录，不经 KepCup）',
  },
  terms: { noticeKey: 'agents.terms.goose' },
  releaseGate: 'goose',
};

/**
 * Qwen Code（D118 新目标，Registry `qwen-code` 0.26.7，Alibaba）：`qwen --acp
 * --experimental-skills`，npx 分发。认证：Qwen OAuth（免费档）或各家 API key。
 * 差异待真机 spike。
 */
const QWEN_CODE_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'qwen-code',
  name: 'Qwen Code',
  version: '0.26.7',
  description: "Alibaba's Qwen coding assistant",
  repository: 'https://github.com/QwenLM/qwen-code',
  website: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
  authors: ['Alibaba Qwen Team'],
  license: 'Apache-2.0',
  icon: 'qwen-code.svg',
  distribution: {
    npx: {
      package: '@qwen-code/qwen-code@0.26.7',
      args: ['--acp', '--experimental-skills'],
    },
  },
  provider: 'generic-acp',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Qwen OAuth（免费额度）或各家 API key（qwen 官方登录）',
  },
  terms: { noticeKey: 'agents.terms.qwen-code' },
  releaseGate: 'qwen-code',
};

/**
 * Kimi CLI（D118 新目标，Registry `kimi` 1.52.0，Moonshot AI）：`kimi acp`，
 * binary 分发（Registry 自带 sha256；**无 darwin-x86_64 归档**——Intel Mac 不可
 * 用，设置卡文案披露）。认证：Kimi 会员 / API key（`kimi login`）。专属
 * Provider 只带 `sessionNotFound`（OpenBot 观察到的 `-32602 + data.session_id`，
 * 未真机复核）；其余差异待 spike。
 */
const KIMI_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'kimi',
  name: 'Kimi CLI',
  version: '1.52.0',
  description: "Moonshot AI's coding assistant",
  repository: 'https://github.com/MoonshotAI/kimi-cli',
  website: 'https://moonshotai.github.io/kimi-cli/',
  authors: ['Moonshot AI'],
  license: 'MIT',
  icon: 'kimi.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive:
          'https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-aarch64-apple-darwin.tar.gz',
        cmd: './kimi',
        args: ['acp'],
        sha256: '43fe091f70bbf8860974200f9021a05689a020857cc9926d56f1505f0d0d5cb8',
      },
      'linux-aarch64': {
        archive:
          'https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-aarch64-unknown-linux-gnu.tar.gz',
        cmd: './kimi',
        args: ['acp'],
        sha256: '9e06eea96273600aed485b1f0bedda95b7084db4f22cf28614fe20138933507a',
      },
      'linux-x86_64': {
        archive:
          'https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-x86_64-unknown-linux-gnu.tar.gz',
        cmd: './kimi',
        args: ['acp'],
        sha256: 'a676204f7804ed5dae87652a9d66f578e0718d5026c9cb1bfa32b9a5eace4208',
      },
      'windows-aarch64': {
        archive:
          'https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-aarch64-pc-windows-msvc.zip',
        cmd: './kimi.exe',
        args: ['acp'],
        sha256: '7c77cd413e7a3a59416c171a45ee4ff50534869b331469138aad84b9e3acb6c0',
      },
      'windows-x86_64': {
        archive:
          'https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0/kimi-1.52.0-x86_64-pc-windows-msvc.zip',
        cmd: './kimi.exe',
        args: ['acp'],
        sha256: '2c269e15e152b9f28ac1556795280f90a2c9860ff44c60c628c3fce4dd4c58a7',
      },
    },
  },
  provider: 'kimi',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'Kimi 会员或 Moonshot API key（`kimi login` 官方登录）；Intel Mac 暂不提供官方构建',
  },
  terms: { noticeKey: 'agents.terms.kimi' },
  releaseGate: 'kimi',
};

/**
 * Grok Build（D118 新目标，Registry `grok-build` 1.0.77，xAI）：
 * `grok --no-auto-update agent stdio`，npx 分发（`@xai-official/grok`）。
 * `--no-auto-update` 取自 OpenBot 的实跑参数（宿主不允许 Agent 自我升级），
 * spike 复核。认证：grok.com 登录（OAuth / 设备码）或 xAI API key。
 */
const GROK_BUILD_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'grok-build',
  name: 'Grok Build',
  version: '1.0.77',
  description: "xAI's coding agent and CLI",
  website: 'https://x.ai/cli',
  authors: ['xAI'],
  license: 'proprietary',
  icon: 'grok-build.svg',
  distribution: {
    npx: {
      package: '@xai-official/grok@1.0.77',
      args: ['--no-auto-update', 'agent', 'stdio'],
    },
  },
  provider: 'generic-acp',
  transport: 'acp',
  tier: 'preview',
  nativeCapabilities: {},
  auth: {
    kinds: ['subscription', 'api-key'],
    note: 'grok.com 账号（官方登录，计入 xAI 套餐额度）或 xAI API key',
  },
  terms: { noticeKey: 'agents.terms.grok-build' },
  releaseGate: 'grok-build',
};

/**
 * Devin（D118 新目标，Registry `devin` 3000.11.234，Cognition）：`devin acp`，
 * binary 分发（Registry 无 sha256 → 导入脚本 `--hash` 下载计算并锁定）。
 * 认证：Devin 账号（ACP authenticate method `devin-browser`）。专属 Provider
 * 只带 `sessionNotFound`（OpenBot 观察到的 `-32016 + cognition.ai/errorKind:
 * session_not_found`，未真机复核）；其余差异待 spike。
 */
const DEVIN_AGENT_ENTRY: AgentCatalogEntry = {
  id: 'devin',
  name: 'Devin',
  version: '3000.11.234',
  description: 'Devin CLI coding agent by Cognition',
  website: 'https://docs.devin.ai/cli',
  repository: 'https://github.com/CognitionAI/devin-cli',
  authors: ['Cognition'],
  license: 'proprietary',
  icon: 'devin.svg',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive: 'https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-aarch64-apple-darwin.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '35f17a21e53a49435e42fb9627731726aa8ef7fa63e5c3d9d43d0cc5ca43edaf',
      },
      'darwin-x86_64': {
        archive: 'https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-x86_64-apple-darwin.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '55ef4f2d2b2c82b5258b7516eb1126549e6f10d6b418035676237bcc18e93e46',
      },
      'linux-aarch64': {
        archive: 'https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-aarch64-unknown-linux.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '438ca7f8280b3ef0747afc406e827d9e182156000277a1660358ac4fbd04156e',
      },
      'linux-x86_64': {
        archive: 'https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-x86_64-unknown-linux.tar.gz',
        cmd: './bin/devin',
        args: ['acp'],
        sha256: '201370cddd2924294e3ca6b46fd8ece49b5763953b644a1dd823fce5490cb41a',
      },
      'windows-aarch64': {
        archive: 'https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-aarch64-pc-windows.zip',
        cmd: './bin\\devin.exe',
        args: ['acp'],
        sha256: '1fc2fcedfe0649a9ed370b122064d66f406c9a2e4a7622b4c6712cc098c01b22',
      },
      'windows-x86_64': {
        archive: 'https://static.devin.ai/cli/3000.11.234/devin-3000.11.234-x86_64-pc-windows.zip',
        cmd: './bin\\devin.exe',
        args: ['acp'],
        sha256: 'de01a37364c3c09389e20b699e993962296e5b8e1bea60aa48c95cc57dd228e3',
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
 * 策展目录：只在实验开关 `settings.experimental.externalAgents` 打开时可选。
 * P2 收录 Claude Agent 与 Codex（安装器在 P4：此前只能经测试缝启动）；
 * P5 收录 OpenCode、DeepSeek Harness、Cursor、Google Antigravity；
 * InkCop 以 system 分发挂入（本机 `inkcop-acp`）。
 * D118 收录 ACP Registry 已有的 7 个新目标（Cline、GitHub Copilot、goose、
 * Qwen Code、Kimi CLI、Grok Build、Devin；来源：OpenBot 0.62.0 预置目标对比
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
  INKCOP_AGENT_ENTRY,
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
