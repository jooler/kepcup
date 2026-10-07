import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentCatalogEntry,
  AgentPermissionTier,
  AgentToolApprovalPayload,
  AgentToolKind,
  GrantDuration,
} from '@kepcup/shared';
import { canonicalPath, expandTilde, skillsLibraryDir, type AppPaths } from '../../infra/paths.js';
import type { CoreLogger } from '../../infra/logger.js';
import { isInsidePath } from '../../sandbox/sensitive-paths.js';
import type { ToolGateway } from '../../gateway/index.js';
import type { ApprovalsService } from '../../permissions/approvals.js';
import type { GrantsService } from '../../permissions/grants.js';
import type { AllowlistService } from '../../permissions/allowlist.js';
import { unattendedCommandVerdict } from '../../permissions/approvals.js';
import type { RunIdentity } from '../types.js';
import {
  hostBridgeToolOf,
  selectPermissionOption,
  type AcpPermissionToolCall,
  type AcpRequestPermissionRequest,
  type AcpToolCallLike,
  type PermissionVerdict,
  type SessionBridge,
} from './acp/client.js';
import type { AgentIsolation, AgentProvider } from './types.js';

/**
 * 权限桥（docs/design/28-external-agents-acp.md §6，D72 P3）：外部 Agent 的
 * 原生文件 / 命令工具在其自身进程与沙箱里运行，宿主唯一的控制点是 ACP
 * `session/request_permission`。本模块替换 P1 的默认拒绝，按下列顺序裁决：
 *
 * 1. 本会话宿主桥的工具（随机桥名 + 本 run 注入集合）→ 放行（桥内另走网关）；
 * 2. 按 `toolCall.kind` 分级：read / search → 读；edit / delete / move → 写；
 *    execute → 执行；fetch → 联网读取；think → 放行；switch_mode → 拒绝；
 *    其余 / 看不懂 → 弹卡；
 * 3. 路径优先级：工作目录（cwd 与本 run 的 workspace）与技能目录（只读）→
 *    应用数据目录其余部分（拒绝）→ 网关 `checkPath`（已授权放行，其余弹卡）；
 *    工作目录内按档位：read_only 拒写、workspace 放行、ask 弹卡；
 * 4. 执行：只读白名单（D40）放行；read_only 其余拒绝；workspace 档且 Agent
 *    有 OS 沙箱、Provider 确认该命令在沙箱内 → 放行；否则弹卡（只有「仅这一次」）；
 * 5. 选项只按 Provider 的 optionId 白名单选 allow_once / reject_once
 *    （`selectPermissionOption`）；路径类「本对话内」记为 access 授权；
 * 6. 卡片经 `approvals.request`（无人值守并入数据目录底线、run 进
 *    waiting_approval、run 取消时返回 cancelled）。
 */

/** 永不进入的模式（任何 Provider；Provider 可另加，见各自的 FORBIDDEN 列表）。 */
export const FORBIDDEN_AGENT_MODES: ReadonlySet<string> = new Set([
  'bypassPermissions',
  'dontAsk',
  'auto',
  'agent-full-access',
  // codex-acp 的 auto_review：由 AI 审核员代替宿主审批。
  'agent',
  'yolo',
  'full-access',
  'danger-full-access',
]);

/**
 * 某模式是否禁止进入：全局表 + Provider 自己的 `forbiddenModes`，减去
 * Provider 经核对豁免的 `safeModes`（只豁免全局表里同名而含义不同的模式，
 * 如 Cursor 的 `agent`）。不给 Provider = 只看全局表。
 */
export function isForbiddenAgentMode(
  modeId: string,
  provider?: Pick<AgentProvider, 'forbiddenModes' | 'safeModes'>,
): boolean {
  if (provider?.forbiddenModes?.includes(modeId) === true) return true;
  if (provider?.safeModes?.includes(modeId) === true) return false;
  return FORBIDDEN_AGENT_MODES.has(modeId);
}

/**
 * Agent 自身 OS 沙箱在该平台是否可依赖：Windows 上一律视为无（design 28 §6
 * 「Windows」：未核实，强制每次确认）。
 */
export function hasOsSandbox(provider: Pick<AgentProvider, 'features'>, platform: string): boolean {
  return provider.features.osSandbox && platform !== 'win32';
}

/**
 * 生效档位：Windows 下的 `workspace` 一律降为 `ask`（没有可依赖的 Agent
 * 沙箱，等同逐条确认）。`preview` 档默认 `ask` 由 Bot 配置界面在选择 Agent
 * 时设定（用户仍可改），core 不覆盖用户的选择。
 */
export function effectiveAgentPermission(
  requested: AgentPermissionTier,
  provider: Pick<AgentProvider, 'features'>,
  platform: string,
): AgentPermissionTier {
  return requested === 'workspace' && !hasOsSandbox(provider, platform) && platform === 'win32'
    ? 'ask'
    : requested;
}

export type PermissionCategory =
  'read' | 'write' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other';

export interface ClassifiedPermission {
  category: PermissionCategory;
  /** ACP 原始 `kind`（'' = 未给出）。 */
  toolKind: string;
  /** 请求涉及的路径（原样，可能相对）。 */
  paths: string[];
  command: string | null;
  /** 命令的工作目录（`rawInput.cwd`）。 */
  commandCwd: string | null;
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'target_file', 'target'];
/** Destinations of moves / renames (the written side; review H1). */
const MOVE_KEYS = [
  'move_path',
  'movePath',
  'new_path',
  'newPath',
  'destination',
  'dest',
  'to',
  'target_path',
];

/** Title / command / reason caps on agent_tool cards (agent text is untrusted, L1). */
export const AGENT_TOOL_TITLE_MAX_CHARS = 200;
export const AGENT_TOOL_COMMAND_MAX_CHARS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 命令原文：`rawInput.command`（字符串，或 argv 数组——`[sh, -c, script]`
 * 取脚本）/ `rawInput.cmd`。
 */
export function commandOfRawInput(rawInput: unknown): string | null {
  const input = asRecord(rawInput);
  if (input === null) return null;
  const value = input['command'] ?? input['cmd'];
  if (typeof value === 'string') return value.trim().length > 0 ? value : null;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    const argv = value as string[];
    if (argv.length === 0) return null;
    const shell = path.basename(argv[0] ?? '');
    if (
      argv.length >= 3 &&
      ['sh', 'bash', 'zsh', 'dash'].includes(shell) &&
      ['-c', '-lc', '-cl'].includes(argv[1] ?? '')
    ) {
      return argv[2] ?? null;
    }
    return argv.join(' ');
  }
  return null;
}

const CONFIG_HASH_MAX_ENTRIES = 5_000;
const CONFIG_HASH_MAX_BYTES = 32 * 1024 * 1024;

/**
 * project 内 Agent 侧配置（AGENTS.md、`.codex/` …）的内容哈希（安全审查
 * M2 / 复核第 2 轮）：文件内容与目录树计入；符号链接按 realpath 跟随、哈希
 * 被指向的内容。凡是无法完整确认的——超出上限（5000 项 / 32MB）、链接指向
 * project 之外、读不到——返回一次性的随机值：永不与已记住的哈希相等，即
 * 每次运行都重新确认（fail closed）。
 */
export function hashAgentConfigFiles(root: string, names: readonly string[]): string {
  const hash = createHash('sha256');
  const projectRoot = canonicalPath(root);
  const seen = new Set<string>();
  let entries = 0;
  let bytes = 0;
  let unverifiable = false;
  const visit = (absolute: string, relative: string): void => {
    if (unverifiable) return;
    entries += 1;
    if (entries > CONFIG_HASH_MAX_ENTRIES) {
      unverifiable = true;
      return;
    }
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      hash.update(`missing:${relative}\n`);
      return;
    }
    if (stats.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(absolute);
      } catch {
        unverifiable = true;
        return;
      }
      // A link out of the project (or a cycle) cannot be vouched for.
      if (!isInsidePath(target, projectRoot) || seen.has(target)) {
        unverifiable = true;
        return;
      }
      hash.update(`link:${relative}:${path.relative(projectRoot, target)}\n`);
      seen.add(target);
      visit(target, relative);
      return;
    }
    if (stats.isDirectory()) {
      hash.update(`dir:${relative}\n`);
      for (const child of readdirSync(absolute).sort()) {
        visit(path.join(absolute, child), `${relative}/${child}`);
      }
    } else if (stats.isFile()) {
      bytes += stats.size;
      if (bytes > CONFIG_HASH_MAX_BYTES) {
        unverifiable = true;
        return;
      }
      hash.update(`file:${relative}:${stats.size}\n`);
      hash.update(readFileSync(absolute));
    } else {
      // Sockets, FIFOs, devices: not configuration we can vouch for.
      unverifiable = true;
    }
  };
  for (const name of [...names].sort()) {
    const clean = name.replace(/[\\/]+$/, '');
    visit(path.join(root, clean), clean);
  }
  return unverifiable ? `unverifiable:${randomUUID()}` : hash.digest('hex');
}

/** 请求的分级（纯函数）。永不看自由文本的 `title`。 */
export function classifyPermissionRequest(toolCall: AcpPermissionToolCall): ClassifiedPermission {
  const kind = toolCall.kind ?? '';
  const input = asRecord(toolCall.rawInput);
  const paths: string[] = [];
  for (const location of toolCall.locations ?? []) {
    if (typeof location.path === 'string' && location.path.length > 0) paths.push(location.path);
  }
  // Diff content names the written files (incl. a move's target path).
  for (const item of toolCall.content ?? []) {
    if (item.type === 'diff' && typeof item.path === 'string' && item.path.length > 0) {
      paths.push(item.path);
    }
  }
  const collect = (record: Record<string, unknown>) => {
    for (const key of [...PATH_KEYS, ...MOVE_KEYS]) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) paths.push(value);
    }
  };
  if (input !== null) {
    collect(input);
    const many = input['paths'];
    if (Array.isArray(many)) {
      for (const value of many)
        if (typeof value === 'string' && value.length > 0) paths.push(value);
    }
    // Patch-style requests: `changes` as an array of {path, move_path…} or a
    // record keyed by path.
    const changes = input['changes'];
    if (Array.isArray(changes)) {
      for (const change of changes) {
        const record = asRecord(change);
        if (record !== null) collect(record);
      }
    } else {
      const record = asRecord(changes);
      if (record !== null) {
        for (const [key, value] of Object.entries(record)) {
          if (key.length > 0) paths.push(key);
          const inner = asRecord(value);
          if (inner !== null) collect(inner);
        }
      }
    }
  }
  const category: PermissionCategory =
    kind === 'read' || kind === 'search'
      ? 'read'
      : kind === 'edit' || kind === 'delete' || kind === 'move'
        ? 'write'
        : kind === 'execute'
          ? 'execute'
          : kind === 'fetch'
            ? 'fetch'
            : kind === 'think'
              ? 'think'
              : kind === 'switch_mode'
                ? 'switch_mode'
                : 'other';
  const cwd = input !== null && typeof input['cwd'] === 'string' ? input['cwd'] : null;
  return {
    category,
    toolKind: kind,
    paths: [...new Set(paths)],
    command: commandOfRawInput(toolCall.rawInput),
    commandCwd: cwd,
  };
}

export interface AgentPermissionBridgeDeps {
  paths: AppPaths;
  gateway: Pick<ToolGateway, 'checkPath' | 'audit' | 'workspacePath'>;
  approvals: Pick<ApprovalsService, 'request' | 'publishEvent'>;
  grants: Pick<GrantsService, 'create' | 'listActive' | 'hasEffectiveGrant'>;
  allowlist: Pick<AllowlistService, 'match'>;
  /** 本 Bot 的技能目录（数据目录内，只读）。 */
  skillDirs(botId: string): string[];
  /** secrets.redact：卡片上的命令 / 标题先脱敏（L1）。 */
  redact?(text: string): string;
  /** 用户主目录（`~` 展开；缺省 os.homedir()）。 */
  homeDir?: string;
  logger: CoreLogger;
  platform?: string;
}

/** 一次权限请求所在的 run。 */
export interface PermissionRequestContext {
  identity: RunIdentity;
  entry: AgentCatalogEntry;
  provider: AgentProvider;
  tier: AgentPermissionTier;
  /** 会话 cwd（project 或 workspace）。 */
  workdir: string;
  /** run 的取消信号：挂起的审批随之 cancelled。 */
  signal: AbortSignal;
  bridge: SessionBridge | null;
}

/** 引擎依赖的权限桥切片（测试可替换）。 */
export interface AgentPermissionHandler {
  decide(
    request: AcpRequestPermissionRequest,
    ctx: PermissionRequestContext,
  ): Promise<PermissionVerdict>;
  isolationFor(identity: RunIdentity, workdir: string): AgentIsolation;
  audit(identity: RunIdentity, action: string, detail: Record<string, unknown>): void;
}

type PathVerdict =
  | { kind: 'allow' }
  | { kind: 'reject'; reason: string }
  | { kind: 'ask'; reason: string; sensitive: boolean };

interface Roots {
  dataHome: string;
  workdirs: string[];
  skillDirs: string[];
  /** 数据目录里可以触及的目录（无人值守底线的例外）。 */
  exempt: string[];
}

export class AgentPermissionBridge implements AgentPermissionHandler {
  readonly #deps: AgentPermissionBridgeDeps;
  readonly #platform: string;

  constructor(deps: AgentPermissionBridgeDeps) {
    this.#deps = deps;
    this.#platform = deps.platform ?? process.platform;
  }

  /**
   * 数据目录在 Agent 自身沙箱里的隔离（Claude `sandbox.filesystem`）：整个
   * 数据目录不可读，除本 run 的 workspace（cwd 在其中时含 cwd）与技能目录；
   * 不可写：cwd 在数据目录外时是整个数据目录，否则（cwd = workspace）是其中
   * 的数据库、日志、备份、toolchains/ 与技能目录——沙箱缺省只允许写 cwd。
   */
  isolationFor(identity: RunIdentity, workdir: string): AgentIsolation {
    const roots = this.#roots(identity, workdir);
    const paths = this.#deps.paths;
    const cwd = canonicalPath(workdir);
    const cwdInside = isInsidePath(cwd, roots.dataHome);
    return {
      dataHome: roots.dataHome,
      denyRead: [roots.dataHome],
      allowRead: roots.exempt,
      denyWrite: cwdInside
        ? [
            paths.mainDbPath,
            paths.runsDbPath,
            paths.logsDir,
            paths.backupsDir,
            paths.toolchainsDir,
            skillsLibraryDir(paths),
            ...roots.skillDirs,
          ]
        : [roots.dataHome],
    };
  }

  audit(identity: RunIdentity, action: string, detail: Record<string, unknown>): void {
    try {
      this.#deps.gateway.audit(identity, action, detail);
    } catch (error) {
      // Runs can settle during shutdown (audit db closed): never fail a run over it.
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'agent permission audit failed',
      );
    }
  }

  async decide(
    request: AcpRequestPermissionRequest,
    ctx: PermissionRequestContext,
  ): Promise<PermissionVerdict> {
    const toolCall = request.toolCall;
    const classified = classifyPermissionRequest(toolCall);
    const record = (verdict: PermissionVerdict, via: string, reason: string, extra = {}) => {
      this.audit(ctx.identity, 'agent_permission', {
        agentId: ctx.entry.id,
        toolCallId: toolCall.toolCallId,
        title: toolCall.title ?? '',
        toolKind: classified.toolKind,
        category: classified.category,
        tier: ctx.tier,
        decision: verdict.decision,
        via,
        reason,
        ...extra,
      });
      return verdict;
    };
    const allow = (via: string, reason: string, extra = {}) =>
      record(selectPermissionOption(request.options, ctx.provider, 'allow'), via, reason, extra);
    const reject = (via: string, reason: string, extra = {}) =>
      record(selectPermissionOption(request.options, ctx.provider, 'reject'), via, reason, extra);

    if (ctx.signal.aborted) {
      return record(
        { response: { outcome: { outcome: 'cancelled' } }, decision: 'cancelled' },
        'auto',
        'run cancelled',
      );
    }
    // 1. This session's host bridge tool (gated again inside the bridge).
    if (
      ctx.bridge !== null &&
      hostBridgeToolOf(toolCall as AcpToolCallLike, ctx.provider, ctx.bridge) !== null
    ) {
      return allow('auto', 'host bridge tool');
    }

    const roots = this.#roots(ctx.identity, ctx.workdir);
    switch (classified.category) {
      case 'think':
        return allow('auto', 'no side effects');
      case 'switch_mode':
        // Mode switches are host-controlled (tier); never let the agent flip it.
        return reject('auto', 'mode switch refused');
      case 'fetch':
        // Network reads (WebFetch / WebSearch): the bot network policy does
        // not reach agents (design 13); only the per-call tier confirms them.
        if (ctx.tier !== 'ask') return allow('auto', 'network read');
        return this.#ask(request, ctx, classified, roots, {
          kind: 'other',
          locations: [],
          durations: ['once'],
          reason: '「每次确认」档：联网读取需确认',
        });
      case 'read':
      case 'write':
        return this.#decidePaths(request, ctx, classified, roots, allow, reject);
      case 'execute':
        return this.#decideExec(request, ctx, classified, roots, allow, reject);
      case 'other':
        // Fail closed where no card can be justified (review M1).
        if (ctx.tier === 'read_only') return reject('auto', '只读档：无法识别的工具请求一律拒绝');
        return this.#ask(request, ctx, classified, roots, {
          kind: 'other',
          locations: this.#resolveAll(classified.paths, ctx.workdir),
          durations: ['once'],
          reason: '无法识别的工具权限请求',
        });
    }
  }

  async #decidePaths(
    request: AcpRequestPermissionRequest,
    ctx: PermissionRequestContext,
    classified: ClassifiedPermission,
    roots: Roots,
    allow: (via: string, reason: string, extra?: object) => PermissionVerdict,
    reject: (via: string, reason: string, extra?: object) => PermissionVerdict,
  ): Promise<PermissionVerdict> {
    const mode = classified.category === 'write' ? 'write' : 'read';
    if (classified.paths.length === 0) {
      // A search without an explicit path runs in the working directory.
      if (mode === 'read' && classified.toolKind === 'search')
        return allow('auto', 'search in cwd');
      if (ctx.tier === 'read_only') return reject('auto', '只读档：未给出路径的请求一律拒绝');
      return this.#ask(request, ctx, classified, roots, {
        kind: 'other',
        locations: [],
        durations: ['once'],
        reason: '请求未给出路径',
      });
    }
    // Deduplicated after resolution (`a.txt` and `/proj/a.txt` are one path).
    const resolved = this.#resolveAll(classified.paths, ctx.workdir);
    // Review H1: a write the agent asks about although it lies in the cwd
    // (Codex only asks for writes its sandbox refuses) hides the real target.
    const escapes =
      mode === 'write' &&
      ctx.provider.writeSandboxed?.(request.toolCall as AcpToolCallLike) === false;
    const verdicts = resolved.map((target) => ({
      target,
      verdict: this.#pathVerdict(ctx, roots, target, mode, escapes),
    }));
    const rejected = verdicts.find((entry) => entry.verdict.kind === 'reject');
    if (rejected !== undefined && rejected.verdict.kind === 'reject') {
      return reject('auto', rejected.verdict.reason, { locations: resolved });
    }
    const asked = verdicts.filter((entry) => entry.verdict.kind === 'ask');
    if (asked.length === 0) return allow('auto', 'within scope', { locations: resolved });
    const first = asked[0]!.verdict as Extract<PathVerdict, { kind: 'ask' }>;
    return this.#ask(request, ctx, classified, roots, {
      kind: mode,
      access: mode,
      locations: asked.map((entry) => entry.target),
      // An uncertain target cannot be granted for the conversation (review #9).
      durations: escapes ? ['once'] : ['once', 'conversation'],
      reason: escapes
        ? `${first.reason}；真实写入目标可能与显示的路径不同（该智能体只为越出其沙箱的写入发请求）`
        : first.reason,
      sensitive: asked.some((entry) => entry.verdict.kind === 'ask' && entry.verdict.sensitive),
      // Review round 2: unattended mode refuses these (the target is unknown).
      targetUncertain: escapes,
    });
  }

  #pathVerdict(
    ctx: PermissionRequestContext,
    roots: Roots,
    target: string,
    mode: 'read' | 'write',
    escapes = false,
  ): PathVerdict {
    const norm = (p: string) => this.#norm(p);
    const candidate = norm(target);
    // 1. Working directories (cwd + this run's workspace).
    const workdir = roots.workdirs.find((dir) => isInsidePath(candidate, norm(dir)));
    if (workdir !== undefined) {
      if (mode === 'read') return { kind: 'allow' };
      if (ctx.tier === 'read_only') return { kind: 'reject', reason: '只读档：不允许写入' };
      // Never silently: the repository's own .git (hooks run outside any
      // sandbox) and the agent's own config files (hooks, MCP commands …).
      const relative = path.relative(norm(workdir), candidate).split(path.sep);
      if (relative.includes('.git')) {
        return { kind: 'ask', reason: '写入仓库的 .git 目录（含 hooks）需确认', sensitive: true };
      }
      if (this.#isAgentConfig(ctx, roots, candidate)) {
        return { kind: 'ask', reason: '写入智能体自身的配置文件需确认', sensitive: true };
      }
      if (escapes) {
        return { kind: 'ask', reason: '该写入超出了智能体自身沙箱的允许范围', sensitive: false };
      }
      if (ctx.tier === 'workspace') return { kind: 'allow' };
      if (this.#granted(ctx.identity, target, mode)) return { kind: 'allow' };
      return { kind: 'ask', reason: '「每次确认」档：写入需确认', sensitive: false };
    }
    // 2. This bot's skill directories: read-only.
    if (roots.skillDirs.some((dir) => isInsidePath(candidate, norm(dir)))) {
      return mode === 'read'
        ? { kind: 'allow' }
        : { kind: 'reject', reason: '技能目录只读，不能写入' };
    }
    // 3. The rest of the data directory: never (not even with a card).
    if (isInsidePath(candidate, norm(roots.dataHome))) {
      return { kind: 'reject', reason: '应用数据目录不可访问' };
    }
    if (mode === 'write' && ctx.tier === 'read_only') {
      return { kind: 'reject', reason: '只读档：不允许写入' };
    }
    // 4. The regular access range (grants, sensitive locations, system roots).
    const decision = this.#deps.gateway.checkPath(ctx.identity, target, mode);
    switch (decision.kind) {
      case 'allowed':
        return { kind: 'allow' };
      case 'forbidden':
        return { kind: 'reject', reason: decision.reason };
      case 'needs_grant':
        return { kind: 'ask', reason: decision.reason, sensitive: decision.sensitive };
      case 'needs_lease':
        // The run's lease is pinned to its cwd (review M6): another lease
        // target cannot be written during an external run.
        return {
          kind: 'reject',
          reason: '外部智能体 run 只能写入其工作目录（其他 project 需要另取写入租约）',
        };
    }
  }

  /** `candidate` is (inside) one of the provider's agent-side config files of the cwd. */
  #isAgentConfig(ctx: PermissionRequestContext, roots: Roots, candidate: string): boolean {
    const cwd = this.#norm(roots.workdirs[0] ?? canonicalPath(ctx.workdir));
    return ctx.provider.agentSideConfigFiles.some((name) =>
      isInsidePath(candidate, this.#norm(path.join(cwd, name.replace(/[\\/]+$/, '')))),
    );
  }

  async #decideExec(
    request: AcpRequestPermissionRequest,
    ctx: PermissionRequestContext,
    classified: ClassifiedPermission,
    roots: Roots,
    allow: (via: string, reason: string, extra?: object) => PermissionVerdict,
    reject: (via: string, reason: string, extra?: object) => PermissionVerdict,
  ): Promise<PermissionVerdict> {
    const command = classified.command;
    if (command === null) {
      if (ctx.tier === 'read_only') return reject('auto', '只读档：未给出命令的执行请求一律拒绝');
      return this.#ask(request, ctx, classified, roots, {
        kind: 'other',
        locations: [],
        durations: ['once'],
        reason: '执行请求未给出命令',
      });
    }
    const cwd = this.#resolve(classified.commandCwd ?? ctx.workdir, ctx.workdir);
    const norm = (p: string) => this.#norm(p);
    // Review H3: a command working directory inside the data directory (other
    // than this run's workspace / skill dirs) is the same hard floor as paths.
    if (
      isInsidePath(norm(cwd), norm(roots.dataHome)) &&
      !roots.exempt.some((dir) => isInsidePath(norm(cwd), norm(dir)))
    ) {
      return reject('auto', '命令工作目录位于应用数据目录内', { command, cwd });
    }
    const cwdInScope = roots.workdirs.some((dir) => isInsidePath(norm(cwd), norm(dir)));
    // Only a command the provider confirms inside its own OS sandbox is ever
    // exempt (review H2): the read-only allowlist would otherwise run it
    // outside any sandbox — Codex's command requests always are.
    const sandboxed =
      hasOsSandbox(ctx.provider, this.#platform) &&
      ctx.provider.execSandboxed?.(request.toolCall as AcpToolCallLike) === true;
    if (sandboxed && cwdInScope) {
      const verdict = this.#deps.allowlist.match(command, {
        isPathAllowed: (candidate) =>
          this.#pathVerdict(
            { ...ctx, tier: 'read_only' },
            roots,
            this.#resolve(candidate, cwd),
            'read',
          ).kind === 'allow',
      });
      if (verdict.exempt)
        return allow('auto', 'allowlisted read-only command (sandboxed)', { command });
    }
    if (ctx.tier === 'read_only') return reject('auto', '只读档：不允许执行命令', { command });
    if (sandboxed && ctx.tier === 'workspace') {
      return allow('auto', 'runs inside the agent sandbox', { command });
    }
    const base =
      ctx.tier === 'ask'
        ? '「每次确认」档：命令需逐条确认'
        : !hasOsSandbox(ctx.provider, this.#platform)
          ? '该智能体没有可用的 OS 沙箱，命令需逐条确认'
          : '该命令将在智能体沙箱之外执行';
    // Review round 2: the same fail-closed analysis unattended mode applies;
    // the user sees when it cannot vouch for the command.
    const workspace = this.#deps.gateway.workspacePath(ctx.identity);
    const analysis = unattendedCommandVerdict(command, {
      dataHome: roots.dataHome,
      homeDir: this.#deps.homeDir ?? os.homedir(),
      cwd,
      exemptDirs: workspace !== null ? [workspace] : [],
      platform: this.#platform,
    });
    return this.#ask(request, ctx, classified, roots, {
      kind: 'execute',
      locations: [],
      command,
      cwd,
      durations: ['once'],
      reason: analysis.safe
        ? base
        : `${base}；⚠ 可能触及应用数据目录 / 无法静态分析（${analysis.reason ?? ''}）`,
    });
  }

  /** Raises an `agent_tool` card; approval → allow_once (+ grants for paths). */
  async #ask(
    request: AcpRequestPermissionRequest,
    ctx: PermissionRequestContext,
    classified: ClassifiedPermission,
    roots: Roots,
    card: {
      kind: AgentToolKind;
      access?: 'read' | 'write';
      locations: string[];
      command?: string;
      cwd?: string;
      durations: GrantDuration[];
      reason: string;
      sensitive?: boolean;
      targetUncertain?: boolean;
    },
  ): Promise<PermissionVerdict> {
    const toolCall = request.toolCall;
    // Agent-supplied text lands on the card, in notifications and in other
    // bots' context: redact secrets and cap it (review L1, as mcp_tool does).
    const clean = (text: string, max: number) => {
      const redacted = this.#deps.redact?.(text) ?? text;
      return redacted.length > max ? `${redacted.slice(0, max)}…（已截断）` : redacted;
    };
    const payload: AgentToolApprovalPayload = {
      agentId: ctx.entry.id,
      agentName: ctx.entry.name,
      title: clean(toolCall.title ?? toolCall.name ?? '', AGENT_TOOL_TITLE_MAX_CHARS),
      kind: card.kind,
      toolKind: classified.toolKind,
      ...(card.access !== undefined ? { access: card.access } : {}),
      locations: card.locations,
      ...(card.command !== undefined
        ? { command: clean(card.command, AGENT_TOOL_COMMAND_MAX_CHARS) }
        : {}),
      cwd: card.cwd ?? ctx.workdir,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      durations: card.durations,
      reason: card.reason,
      sensitive: card.sensitive === true,
      exemptDirs: roots.exempt,
      ...(card.targetUncertain === true ? { targetUncertain: true } : {}),
    };
    const outcome = await this.#deps.approvals.request(ctx.identity, 'agent_tool', payload, {
      signal: ctx.signal,
    });
    const audit = (verdict: PermissionVerdict) => {
      this.audit(ctx.identity, 'agent_permission', {
        agentId: ctx.entry.id,
        toolCallId: toolCall.toolCallId,
        title: payload.title,
        toolKind: classified.toolKind,
        category: classified.category,
        tier: ctx.tier,
        decision: verdict.decision,
        via: outcome.approval.autoApproved ? 'unattended' : 'approval',
        approvalId: outcome.approval.id,
        reason: card.reason,
        locations: card.locations,
        ...(card.command !== undefined ? { command: card.command } : {}),
      });
      return verdict;
    };
    if (outcome.decision === 'cancelled') {
      return audit({ response: { outcome: { outcome: 'cancelled' } }, decision: 'cancelled' });
    }
    if (outcome.decision !== 'approved') {
      return audit(selectPermissionOption(request.options, ctx.provider, 'reject'));
    }
    if (card.access !== undefined && card.locations.length > 0) {
      this.#grant(ctx.identity, card.locations, card.access, outcome.approval);
    }
    return audit(selectPermissionOption(request.options, ctx.provider, 'allow'));
  }

  /**
   * 路径类批准记为 access 授权（D37 语义：「仅这一次」随 run 失效，「本对话
   * 内」到对话结束）——同一路径的后续请求经网关授权直接放行。
   */
  #grant(
    identity: RunIdentity,
    locations: string[],
    access: 'read' | 'write',
    approval: { id: string; decision: { duration?: GrantDuration } | null },
  ): void {
    if (identity.botId === null || identity.conversationId === null) return;
    const duration = approval.decision?.duration ?? 'once';
    for (const location of locations) {
      this.#deps.grants.create({
        botId: identity.botId,
        conversationId: identity.conversationId,
        path: location,
        access,
        duration,
        runId: identity.runId,
        approvalId: approval.id,
      });
    }
    this.#deps.approvals.publishEvent('grant.changed', {
      conversationId: identity.conversationId,
      grants: this.#deps.grants.listActive(identity.conversationId),
    });
  }

  #granted(identity: RunIdentity, target: string, mode: 'read' | 'write'): boolean {
    return (
      this.#deps.grants.hasEffectiveGrant(identity, target, mode, (grantPath, candidate) =>
        isInsidePath(this.#norm(candidate), this.#norm(grantPath)),
      ) !== null
    );
  }

  #roots(identity: RunIdentity, workdir: string): Roots {
    const dataHome = canonicalPath(this.#deps.paths.home);
    const workspace = this.#deps.gateway.workspacePath(identity);
    const workdirs = [
      canonicalPath(workdir),
      ...(workspace !== null ? [canonicalPath(workspace)] : []),
    ];
    const skillDirs =
      identity.botId !== null ? this.#deps.skillDirs(identity.botId).map(canonicalPath) : [];
    const exempt = [...new Set([...workdirs, ...skillDirs])].filter((dir) =>
      isInsidePath(this.#norm(dir), this.#norm(dataHome)),
    );
    return { dataHome, workdirs: [...new Set(workdirs)], skillDirs, exempt };
  }

  /** Resolved + deduplicated (review M5: one card row per real path). */
  #resolveAll(paths: readonly string[], base: string): string[] {
    return [...new Set(paths.map((p) => this.#resolve(p, base)))];
  }

  /** Absolute canonical form (relative to the session cwd; `~` expanded). */
  #resolve(target: string, base: string): string {
    const expanded = expandTilde(target);
    return canonicalPath(path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded));
  }

  #norm(p: string): string {
    return this.#platform === 'darwin' || this.#platform === 'win32' ? p.toLowerCase() : p;
  }
}
