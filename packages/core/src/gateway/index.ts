import { mkdirSync, readdirSync, realpathSync, lstatSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError, BASH_TIMEOUT_DEFAULT_MS } from '@kepcup/shared';

import { isInsidePath, readOnlyRoots, sensitivePaths } from '../sandbox/sensitive-paths.js';
import { buildSandboxPolicy } from '../sandbox/policy.js';
import { executeUnsandboxed } from '../sandbox/confirm-executor.js';
import type { SandboxBackend, SandboxExecResult, SandboxNetworkPolicy } from '../sandbox/types.js';
import { expandTilde, workspacePathFor, type AppPaths } from '../infra/paths.js';
import type { AuditService } from '../domain/audit.js';
import type { SecretsService } from '../domain/secrets.js';
import type { RunIdentity } from '../agent/types.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ApprovalsService } from '../permissions/approvals.js';
import type { GrantsService } from '../permissions/grants.js';
import type { AllowlistService } from '../permissions/allowlist.js';
import type { UnattendedService } from '../permissions/unattended.js';
import type { ProjectRuntime } from '../project/service.js';

export interface GatewayDeps {
  paths: AppPaths;
  sandbox: SandboxBackend;
  /**
   * P12 enhanced-level backend (macOS: Lima, Linux: Podman; null on Windows
   * where the WSL distro serves both levels). Used only when
   * `enhancedRouting.requiredForBot` is true and its probe is available.
   */
  enhanced?: SandboxBackend | undefined;
  /**
   * P12 routing predicate: an active skill of this bot declares `sandbox:
   * enhanced` (and is usable) → route its commands through the enhanced
   * backend. The default backend stays the fallback when the enhanced one is
   * unavailable (skills are gated incompatible in that case — belt and
   * braces, never a silent downgrade to no sandbox).
   */
  enhancedRouting?: { requiredForBot(botId: string): boolean } | undefined;
  audit: AuditService;
  secrets: SecretsService;
  logger: CoreLogger;
  approvals: ApprovalsService;
  grants: GrantsService;
  allowlist: AllowlistService;
  unattended: UnattendedService;
  /** Project runtime (P04): binding lookups, write leases, policy input. */
  projects: ProjectRuntime;
  /**
   * P06 installed toolchains: PATH prefix for sandbox + confirm mode, the
   * read-only toolchains root, and use tracking. Optional so the gateway
   * stays testable without the env manager.
   */
  environment?: {
    toolchainPathPrefix(platform: string): string | null;
    toolchainsRoot(): string;
    noteToolchainUse(): void;
  };
  /**
   * P08 skills: directories this bot's active skills live in. They are
   * inside the data directory (otherwise forbidden) and become readable —
   * never writable — for the file tools, and read-only inside the sandbox.
   */
  skills?: {
    readableDirs(botId: string): string[];
  };
  /**
   * D65: the server id → autoApprove lookup for MCP tool calls (settings-
   * driven). Absent/undefined = never auto-approve (default-deny).
   */
  mcpAutoApprove?: ((serverId: string) => boolean) | undefined;
  platform?: string;
  homeDir?: string;
  /** DI overrides for tests / future policy evolution. */
  readOnlyRootsOverride?: string[];
  sensitiveOverride?: string[];
}

export type PathDecision =
  | { kind: 'allowed'; resolvedPath: string }
  | { kind: 'needs_grant'; resolvedPath: string; reason: string; sensitive: boolean }
  | { kind: 'needs_lease'; resolvedPath: string; reason: string }
  | { kind: 'forbidden'; resolvedPath: string; reason: string };

/** Upper bound for the workspace link scan in `hasExternalHardlink`. */
const HARDLINK_SCAN_ENTRY_CAP = 20_000;

/**
 * True when `resolved` is a file with more directory entries referencing its
 * inode than the workspace itself contains — i.e. at least one hard link
 * lives outside the workspace. A hard link's realpath is the link's own
 * path, so the symlink check cannot see it; writing through it would mutate
 * an external file and reading it would expose one. Directories cannot be
 * hard linked and single-link files are always safe. The scan is capped and
 * fails closed.
 */
export function hasExternalHardlink(resolved: string, workspace: string): boolean {
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch {
    return false; // vanished or not created yet; the later IO reports the truth
  }
  if (stats.isDirectory() || stats.nlink <= 1) return false;
  const wanted = `${stats.dev}:${stats.ino}`;
  let found = 0;
  let visited = 0;
  const stack = [workspace];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > HARDLINK_SCAN_ENTRY_CAP) return true; // fail closed
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (!entry.isFile()) continue;
      try {
        if (`${statSync(full).dev}:${statSync(full).ino}` === wanted) found += 1;
      } catch {
        // raced away; not a link we can count
      }
    }
  }
  return found < stats.nlink;
}

export interface GatewayExecRequest {
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Merged stdout/stderr chunks, forwarded to the run status line. */
  onOutput?: (chunk: string) => void;
  /** Network policy for this command (from the bot's Profile). */
  network: SandboxNetworkPolicy;
}

export type GatewayExecResult = SandboxExecResult & { policyApplied: boolean };

/** Case-insensitive comparison on filesystems that need it. */
function normalizeForCompare(p: string, platform: string): string {
  const lowered = platform === 'darwin' || platform === 'win32';
  return lowered ? p.toLowerCase() : p;
}

/**
 * Resolves a path to its realpath; when the target does not exist the deepest
 * existing ancestor is resolved and the remaining segments appended. This is
 * what keeps symlink escapes out: a link pointing outside resolves outside.
 */
export function resolveStandingPath(target: string): string {
  let current = target;
  let rest = '';
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length === 0 ? real : path.join(real, rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest = path.join(path.basename(current), rest);
      current = parent;
    }
  }
}

/**
 * Tool gateway (docs/dev/02-architecture.md "工具网关"). Every tool side
 * effect goes through here; the model-supplied ids are never trusted, only
 * the RunIdentity of the executing loop.
 *
 * Access order in checkPath: workspace → data directory (never grantable) →
 * bound project (read per protect rules; write needs the lease) → active
 * grants → sensitive locations (needs_grant, prominent warning) →
 * system/toolchain roots (read allowed, write needs a grant) → everything
 * else needs_grant.
 */
export class ToolGateway {
  readonly #deps: GatewayDeps;
  readonly #platform: string;
  readonly #readOnlyRoots: string[];
  readonly #sensitive: string[];

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#platform = deps.platform ?? process.platform;
    // Canonicalize roots so comparisons survive symlinked temp dirs.
    this.#readOnlyRoots = (deps.readOnlyRootsOverride ?? readOnlyRoots(this.#platform)).map(
      resolveStandingPath,
    );
    this.#sensitive = (deps.sensitiveOverride ?? sensitivePaths(this.#platform)).map(
      resolveStandingPath,
    );
  }

  /** Canonical skill directories of one bot (library + authored). */
  #skillDirs(botId: string): string[] {
    return this.#deps.skills?.readableDirs(botId).map(resolveStandingPath) ?? [];
  }

  /** The executing identity's workspace; the only writable data location. */
  workspacePath(identity: RunIdentity): string | null {
    if (identity.botId === null || identity.conversationId === null) return null;
    return workspacePathFor(this.#deps.paths, identity.botId, identity.conversationId);
  }

  /** The bound project of the identity's conversation (null when none). */
  boundProject(identity: RunIdentity) {
    return this.#deps.projects.boundProject(identity.conversationId);
  }

  /** Creates the workspace on first use ("首次执行时创建"). */
  ensureWorkspace(identity: RunIdentity): string {
    const workspace = this.workspacePath(identity);
    if (workspace === null) {
      throw new AppError('PATH_OUT_OF_SCOPE', '当前执行没有 workspace');
    }
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  checkPath(identity: RunIdentity, inputPath: string, mode: 'read' | 'write'): PathDecision {
    const workspace = this.workspacePath(identity);
    if (workspace === null) {
      return {
        kind: 'forbidden',
        resolvedPath: inputPath,
        reason: '当前执行没有可访问的 workspace',
      };
    }
    const paths = this.#deps.paths;
    const expanded = expandTilde(inputPath);
    // Relative paths resolve against the project when one is bound
    // (docs/dev/04-agent-runtime.md "工具目录": 相对路径以 project 为基准).
    const base = this.#deps.projects.boundProject(identity.conversationId)?.path ?? workspace;
    const absolute = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(base, expanded);
    const resolved = resolveStandingPath(absolute);

    const norm = (p: string) => normalizeForCompare(p, this.#platform);
    const resolvedNorm = norm(resolved);
    const workspaceNorm = norm(workspace);

    // 1. The current workspace (read and write). Hard links with entries
    //    outside the workspace are rejected here: their realpath stays inside
    //    the workspace, so the symlink resolution above cannot catch them.
    if (isInsidePath(resolvedNorm, workspaceNorm)) {
      if (hasExternalHardlink(resolved, workspace)) {
        return {
          kind: 'forbidden',
          resolvedPath: resolved,
          reason: '目标文件存在 workspace 之外的硬链接',
        };
      }
      return { kind: 'allowed', resolvedPath: resolved };
    }

    // 2. The data directory: everything except the current workspace (above)
    //    and this bot's skill directories (below). Never grantable — checked
    //    before grants on purpose.
    const skillDirs = identity.botId !== null ? this.#skillDirs(identity.botId) : [];
    for (const dir of skillDirs) {
      if (isInsidePath(resolvedNorm, norm(dir))) {
        if (mode === 'read') return { kind: 'allowed', resolvedPath: resolved };
        // 技能目录只读（docs/dev/phases/P08-skills.md 范围）；数据目录不可授权，
        // 写入直接拒绝而不是发起审批。
        return {
          kind: 'forbidden',
          resolvedPath: resolved,
          reason: '技能目录只读，不能写入',
        };
      }
    }
    if (isInsidePath(resolvedNorm, norm(paths.home))) {
      return { kind: 'forbidden', resolvedPath: resolved, reason: '应用数据目录不可访问' };
    }

    // 3. The bound project: reads follow the protect rules; writes require
    //    this run to hold the write lease (P04).
    const project = this.#deps.projects.boundProject(identity.conversationId);
    if (project !== null && isInsidePath(resolvedNorm, norm(project.path))) {
      if (this.#deps.projects.matchesProtectRule(project, resolved, mode)) {
        return {
          kind: 'forbidden',
          resolvedPath: resolved,
          reason:
            mode === 'read'
              ? '被项目保护规则禁止读取（可在权限设置中调整）'
              : '被项目保护规则禁止写入（可在权限设置中调整）',
        };
      }
      if (mode === 'read') return { kind: 'allowed', resolvedPath: resolved };
      if (this.#deps.projects.holdsLease(identity, project.path)) {
        return { kind: 'allowed', resolvedPath: resolved };
      }
      return {
        kind: 'needs_lease',
        resolvedPath: resolved,
        reason: 'project 写入需要先取得写入租约',
      };
    }

    // 4. An active grant of this bot in this conversation.
    const grant = this.#deps.grants.hasEffectiveGrant(
      identity,
      resolved,
      mode,
      (grantPath, candidate) => isInsidePath(norm(candidate), norm(grantPath)),
    );
    if (grant !== null) {
      this.#deps.approvals.noteGrantUsed(grant.id, identity);
      return { kind: 'allowed', resolvedPath: resolved };
    }

    // 5. Sensitive locations: grantable, but the card warns prominently.
    for (const sensitive of this.#sensitive) {
      if (isInsidePath(resolvedNorm, norm(sensitive))) {
        return {
          kind: 'needs_grant',
          resolvedPath: resolved,
          reason: '敏感位置需要授权',
          sensitive: true,
        };
      }
    }

    // 6. System and toolchain directories: read-only without a grant.
    for (const root of this.#readOnlyRoots) {
      if (isInsidePath(resolvedNorm, norm(root))) {
        if (mode === 'read') return { kind: 'allowed', resolvedPath: resolved };
        return {
          kind: 'needs_grant',
          resolvedPath: resolved,
          reason: '系统目录与工具链目录默认只读，写入需要授权',
          sensitive: false,
        };
      }
    }

    // 7. Everything else: outside the default range, grantable.
    return {
      kind: 'needs_grant',
      resolvedPath: resolved,
      reason: '位于当前 workspace 与系统目录之外',
      sensitive: false,
    };
  }

  /**
   * Gateway verdict as a path the caller may touch: allowed paths pass
   * through, grantable paths raise an access approval (blocking until the
   * user decides), forbidden paths throw PATH_OUT_OF_SCOPE. Denials surface
   * as APPROVAL_DENIED so the bot can adjust.
   */
  async ensurePathAccess(
    identity: RunIdentity,
    inputPath: string,
    mode: 'read' | 'write',
    reason: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const decision = this.checkPath(identity, inputPath, mode);
    if (decision.kind === 'allowed') return decision.resolvedPath;
    if (decision.kind === 'forbidden') {
      throw new AppError('PATH_OUT_OF_SCOPE', `${decision.reason}：${inputPath}`);
    }
    // Project writes go through the write lease, not an access approval
    // (docs/design/08-project.md "并发：写入租约") — acquire, then re-check.
    if (decision.kind === 'needs_lease') {
      await this.#deps.projects.ensureWriteLease(identity, decision.resolvedPath, {
        signal: options.signal,
        reason,
      });
      const after = this.checkPath(identity, decision.resolvedPath, mode);
      if (after.kind === 'allowed') return after.resolvedPath;
      throw new AppError('PATH_OUT_OF_SCOPE', `${'写入仍被拒绝'}：${inputPath}`);
    }
    // BR-P03-002: a broad grant (e.g. the user home) would silently cover
    // sensitive locations downstream, so the card must warn whenever the
    // requested path is or covers one — the user approves them knowingly.
    const norm = (p: string) => normalizeForCompare(p, this.#platform);
    const coversSensitive = this.#sensitive.some((sensitive) =>
      isInsidePath(norm(sensitive), norm(decision.resolvedPath)),
    );
    const outcome = await this.#deps.approvals.request(
      identity,
      'access',
      {
        path: decision.resolvedPath,
        access: mode,
        reason,
        sensitive: decision.sensitive || coversSensitive,
      },
      options,
    );
    if (outcome.decision !== 'approved') {
      throw new AppError('APPROVAL_DENIED', '用户拒绝或审批已取消，无法访问该路径');
    }
    const duration = outcome.approval.decision?.duration ?? 'once';
    const grant = this.#deps.grants.create({
      botId: identity.botId ?? '',
      conversationId: identity.conversationId ?? '',
      path: decision.resolvedPath,
      access: mode,
      duration,
      runId: identity.runId,
      approvalId: outcome.approval.id,
    });
    this.#deps.logger.info(
      { grantId: grant.id, path: decision.resolvedPath, duration },
      'grant created',
    );
    const conversationId = identity.conversationId ?? '';
    this.#deps.approvals.publishEvent('grant.changed', {
      conversationId,
      grants: this.#deps.grants.listActive(conversationId),
    });
    return decision.resolvedPath;
  }

  /**
   * Runs a command. Sandbox available: per-command policy (with the effective
   * grants) and sandboxed execution. Sandbox unavailable: confirm mode —
   * allowlisted read-only commands run directly, everything else needs a
   * `command` approval and then runs unsandboxed.
   */
  async exec(identity: RunIdentity, req: GatewayExecRequest): Promise<GatewayExecResult> {
    const workspace = this.ensureWorkspace(identity);
    // P12 routing: a bot with an active enhanced-sandbox skill runs through
    // the enhanced backend; its probe decides availability (the default
    // backend takes over when the enhanced one reports unavailable — the
    // sandbox gate below applies to whichever backend runs).
    let backend = this.#deps.sandbox;
    if (
      this.#deps.enhanced !== undefined &&
      identity.botId !== null &&
      (this.#deps.enhancedRouting?.requiredForBot(identity.botId) ?? false)
    ) {
      const enhancedAvailability = await this.#deps.enhanced.probe();
      if (enhancedAvailability.available) backend = this.#deps.enhanced;
    }
    const availability = await backend.probe();
    const project = this.#deps.projects.policyInfo(identity);
    // Bound conversation: commands default to the project directory and the
    // sandbox permits listening on / reaching localhost (dev servers).
    const cwd = project !== null ? project.path : workspace;
    // P06: installed toolchains join every command — sandbox policy env and
    // confirm-mode overlay use the same childEnvFor allowlist + overlay.
    const toolchainPrefix = this.#deps.environment?.toolchainPathPrefix(this.#platform) ?? null;
    const policyEnv: Record<string, string> = {};
    if (toolchainPrefix !== null) {
      policyEnv.PATH = `${toolchainPrefix}${this.#platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
      this.#deps.environment?.noteToolchainUse();
    }
    if (availability.available) {
      const grants = this.#deps.grants.listEffective(identity);
      const policy = buildSandboxPolicy({
        platform: this.#platform,
        paths: this.#deps.paths,
        workspacePath: workspace,
        network: {
          ...req.network,
          allowLocalhost: project !== null,
          allowedPorts: project?.allowedPorts ?? undefined,
        },
        grants,
        project:
          project !== null
            ? {
                path: project.path,
                hasLease: project.hasLease,
                denyReadGlobs: project.denyReadGlobs,
              }
            : undefined,
        ...(toolchainPrefix !== null ? { toolchainPathPrefix: toolchainPrefix } : {}),
        toolchainsRoot: this.#deps.environment?.toolchainsRoot() ?? this.#deps.paths.toolchainsDir,
        skillReadOnlyDirs: identity.botId !== null ? this.#skillDirs(identity.botId) : [],
      });
      const result = await backend.exec({
        command: req.command,
        cwd,
        policy,
        timeoutMs: req.timeoutMs ?? BASH_TIMEOUT_DEFAULT_MS,
        signal: req.signal,
        onOutput: req.onOutput,
      });
      this.audit(identity, 'exec', {
        command: req.command,
        cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        violations: result.violations.length,
        network: req.network.mode,
        grants: grants.length,
        project: project !== null,
        lease: project !== null ? project.hasLease : null,
        backend: backend.kind,
      });
      return { ...result, policyApplied: true };
    }

    // Confirm mode: every command is confirmed (allowlist) or approved.
    const verdict = this.#deps.allowlist.match(req.command, {
      isPathAllowed: (p) => this.checkPath(identity, p, 'read').kind === 'allowed',
    });
    if (verdict.exempt) {
      const result = await executeUnsandboxed({
        command: req.command,
        cwd,
        timeoutMs: req.timeoutMs ?? BASH_TIMEOUT_DEFAULT_MS,
        signal: req.signal,
        onOutput: req.onOutput,
        ...(Object.keys(policyEnv).length > 0 ? { envOverlay: policyEnv } : {}),
      });
      this.audit(identity, 'exec_confirm_allowlist', {
        command: req.command,
        cwd,
        exitCode: result.exitCode,
        sandboxUnavailable: availability.reason ?? '',
      });
      return { ...result, policyApplied: false };
    }

    const outcome = await this.#deps.approvals.request(
      identity,
      'command',
      {
        command: req.command,
        cwd,
        reason: '',
        confirmModeReason: availability.reason ?? '',
      },
      { signal: req.signal },
    );
    if (outcome.decision !== 'approved') {
      throw new AppError('APPROVAL_DENIED', '用户未确认该命令');
    }
    return this.#executeUnsandboxedApproved(
      identity,
      req,
      cwd,
      'confirm-mode',
      Object.keys(policyEnv).length > 0 ? policyEnv : undefined,
    );
  }

  /**
   * `request_unsandboxed`: runs one command outside the sandbox after an
   * explicit per-command approval (never "always allow"). `cwd` must already
   * be validated inside the workspace by the caller.
   */
  async requestUnsandboxed(
    identity: RunIdentity,
    command: string,
    reason: string,
    options: { signal?: AbortSignal; cwd?: string } = {},
  ): Promise<SandboxExecResult> {
    const workspace = options.cwd ?? this.ensureWorkspace(identity);
    const outcome = await this.#deps.approvals.request(
      identity,
      'unsandboxed',
      { command, cwd: workspace, reason, confirmModeReason: '' },
      options,
    );
    if (outcome.decision !== 'approved') {
      throw new AppError('APPROVAL_DENIED', '用户未批准沙箱外执行');
    }
    const prefix = this.#deps.environment?.toolchainPathPrefix(this.#platform) ?? null;
    const envOverlay =
      prefix !== null
        ? { PATH: `${prefix}${this.#platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
        : undefined;
    return this.#executeUnsandboxedApproved(
      identity,
      {
        command,
        signal: options.signal,
        onOutput: undefined,
      },
      workspace,
      'request_unsandboxed',
      envOverlay,
    );
  }

  /**
   * `git_remote` (P04): per-operation approval card, then the system git CLI
   * runs outside the sandbox with the user's own credentials environment.
   */
  async gitRemote(
    identity: RunIdentity,
    input: {
      operation: 'push' | 'pull' | 'fetch' | 'clone' | 'remote_add' | 'init';
      args: string[];
      reason: string;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ exitCode: number | null; output: string }> {
    return this.#deps.projects.gitRemote(identity, input, {
      signal: options.signal,
      requestApproval: async (payload) => {
        const outcome = await this.#deps.approvals.request(identity, 'git_remote', payload, {
          signal: options.signal,
        });
        return outcome.decision;
      },
    });
  }

  async #executeUnsandboxedApproved(
    identity: RunIdentity,
    req: {
      command: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    },
    workspace: string,
    via: string,
    envOverlay?: Record<string, string>,
  ): Promise<GatewayExecResult> {
    const result = await executeUnsandboxed({
      command: req.command,
      cwd: workspace,
      timeoutMs: req.timeoutMs ?? BASH_TIMEOUT_DEFAULT_MS,
      signal: req.signal,
      onOutput: req.onOutput,
      ...(envOverlay !== undefined && Object.keys(envOverlay).length > 0 ? { envOverlay } : {}),
    });
    this.audit(identity, 'exec_unsandboxed', {
      command: req.command,
      cwd: workspace,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      via,
    });
    return { ...result, policyApplied: false };
  }

  /**
   * MCP 工具调用（D65）：与内置工具同管道的审批 + 审计。autoApprove 的
   * server 免卡（审批卡免了，审计照写）；无人值守模式走 D41 自动批准语义
   * （approvals.request 的统一路径）。args 在审计 payload 里经 redact。
   */
  async mcpToolCall(
    identity: RunIdentity,
    server: { id: string; name: string },
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const autoApprove = this.#deps.mcpAutoApprove?.(server.id) ?? false;
    if (!autoApprove) {
      // 卡片与落库 payload 都经脱敏：参数里可能出现模型误带入的密钥值。
      const argsSummary = this.#deps.secrets.redact(JSON.stringify(args));
      const outcome = await this.#deps.approvals.request(
        identity,
        'mcp_tool',
        {
          serverId: server.id,
          serverName: server.name,
          toolName,
          argsSummary:
            argsSummary.length > 400 ? `${argsSummary.slice(0, 400)}…（已截断）` : argsSummary,
        },
        options,
      );
      if (outcome.decision !== 'approved') {
        throw new AppError('APPROVAL_DENIED', '用户拒绝或取消了该 MCP 工具调用');
      }
    }
    this.audit(identity, 'mcp_tool_call', {
      serverId: server.id,
      serverName: server.name,
      toolName,
      args,
    });
  }

  /** Append-only audit write; details are redacted like any tool payload. */
  audit(identity: RunIdentity, action: string, detail: Record<string, unknown>): void {
    const redacted = JSON.parse(this.#deps.secrets.redact(JSON.stringify(detail))) as Record<
      string,
      unknown
    >;
    this.#deps.audit.record(identity, action, redacted);
  }

  /** Top-level workspace entries for the system prompt. */
  workspaceTopLevel(workspace: string, limit = 50): string[] {
    try {
      return readdirSync(workspace, { withFileTypes: true })
        .slice(0, limit)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    } catch {
      return [];
    }
  }

  /** Home directory of the process (tilde expansion base). */
  homeDir(): string {
    return this.#deps.homeDir ?? os.homedir();
  }
}
