import { mkdirSync, readdirSync, realpathSync, lstatSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError, BASH_TIMEOUT_DEFAULT_MS, type ApprovalDuration } from '@kepcup/shared';

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
import type { McpToolDecision } from '../mcp/policy.js';
import type { AppToolGrants } from '../apps/grants.js';
import type { AppToolContext } from '../apps/exposure.js';
import { recipientFields } from '../mcp/recipients.js';
import { activeEffectHooks } from '../permissions/tool-call-scope.js';

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
   * D65 / W5: call-time decision for an MCP tool — risk re-resolved from the
   * server's current annotations + the saved tool policy / server autoApprove
   * (settings-driven, re-read on every call). Absent = destructive + ask
   * (default-deny).
   */
  mcpToolDecision?:
    | ((input: {
        botId: string | null;
        serverId: string;
        toolName: string;
        signal?: AbortSignal | undefined;
      }) => Promise<McpToolDecision>)
    | undefined;
  /**
   * D73 P1: persistent grants for app tools (write risk — 「本对话内一直允许」/「对该 Bot 总是
   * 允许」). An `ask` decision first looks here; a hit needs no card. Absent = no grants
   * (every `ask` shows a card).
   */
  appGrants?: Pick<AppToolGrants, 'find' | 'create'> | undefined;
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
  /** `readOnlyRun`: refused because the run may not write at all (D75, RUN_READ_ONLY). */
  | { kind: 'forbidden'; resolvedPath: string; reason: string; readOnlyRun?: true };

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

/** 破坏性应用工具审批卡展示的完整参数上限（字符；超出截断）。 */
const MCP_APPROVAL_ARGS_FULL_MAX = 20_000;

const MCP_RISK_LABELS: Record<McpToolDecision['risk'], string> = {
  read: '只读',
  write: '写入',
  destructive: '破坏性',
};

/**
 * Tool gateway (docs/dev/02-architecture.md "工具网关"). Every tool side
 * effect goes through here; the model-supplied ids are never trusted, only
 * the RunIdentity of the executing loop.
 *
 * Writes of a read-only run (D75: supervisor turn, `writes: false` task) are
 * refused first, at execution time — not just by leaving tools unregistered:
 * file writes get RUN_READ_ONLY, commands run with a read-only policy.
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
    // Once grants the grants service revokes on its own (consumed by their
    // tool call, TTL, run end) must reach the right panel too (D75).
    // Stubbed grants in unit tests may not implement it.
    if (typeof deps.grants.onAutoRevoke === 'function') {
      deps.grants.onAutoRevoke((conversationId) => {
        deps.approvals.publishEvent('grant.changed', {
          conversationId,
          grants: deps.grants.listActive(conversationId),
        });
      });
    }
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

  /**
   * D75 §2.1 / §5.1: null when the identity may write, else the readable
   * reason. Only turns, tasks and the sub runs they own (`subagent`, resolved
   * to the owning run) can be read-only; the run lookup lives with the
   * write-lease authority (ProjectRuntime.writeDenial).
   */
  writeDenial(identity: RunIdentity): string | null {
    const { loopType } = identity;
    if (loopType !== 'turn' && loopType !== 'task' && loopType !== 'subagent') return null;
    return this.#deps.projects.writeDenial(identity);
  }

  /**
   * Download directory of a read-only run's browser page (D75): a host-owned
   * directory in the app cache — outside every workspace and never readable
   * by the model (the data home is off limits) — instead of the workspace's
   * `downloads/`, which a page click would otherwise write to behind the
   * gateway's back. The page is shared per bot + conversation; every browser
   * tool call re-sends its own run's directory before acting.
   */
  readOnlyDownloadsDir(identity: RunIdentity): string {
    return path.join(
      this.#deps.paths.cacheDir,
      'readonly-downloads',
      identity.botId ?? '_',
      identity.conversationId ?? '_',
    );
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

    // 0. Read-only runs never write, wherever the path is (D75).
    if (mode === 'write') {
      const denial = this.writeDenial(identity);
      if (denial !== null) {
        return { kind: 'forbidden', resolvedPath: resolved, reason: denial, readOnlyRun: true };
      }
    }

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
      // D75：「仅这一次」随使用它的这次工具调用结束而失效。
      this.#deps.grants.noteOnceUse(grant);
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
   * Write check for a copy the host itself makes into a fixed directory of
   * the identity's workspace (`get_attachment` → `.attachments/`): the bytes
   * and the file name come from the host, not the model, so the D75 read-only
   * rule does not apply — a read-only run must still be able to read a PDF or
   * image attachment by id. The exemption is confined: the resolved target
   * must stay inside `<workspace>/<hostDir>/` (a symlinked `hostDir` or file
   * resolving elsewhere is refused) and must not be a hard link with entries
   * outside the workspace. Runs that may write get the ordinary write check.
   */
  checkHostCopyPath(identity: RunIdentity, inputPath: string, hostDir: string): PathDecision {
    const decision = this.checkPath(identity, inputPath, 'write');
    if (decision.kind !== 'forbidden' || decision.readOnlyRun !== true) return decision;
    const workspace = this.workspacePath(identity);
    if (workspace === null) return decision;
    const norm = (p: string) => normalizeForCompare(p, this.#platform);
    const dir = path.join(workspace, hostDir);
    if (
      norm(decision.resolvedPath) !== norm(dir) &&
      isInsidePath(norm(decision.resolvedPath), norm(dir)) &&
      !hasExternalHardlink(decision.resolvedPath, workspace)
    ) {
      return { kind: 'allowed', resolvedPath: decision.resolvedPath };
    }
    return {
      kind: 'forbidden',
      resolvedPath: decision.resolvedPath,
      reason: `${decision.reason}（宿主只能把文件复制到 workspace 的 ${hostDir} 目录）`,
      readOnlyRun: true,
    };
  }

  /**
   * Gateway verdict as a path the caller may touch: allowed paths pass
   * through, grantable paths raise an access approval (blocking until the
   * user decides), forbidden paths throw PATH_OUT_OF_SCOPE (RUN_READ_ONLY for
   * writes of a read-only run). Denials surface as APPROVAL_DENIED so the bot
   * can adjust.
   *
   * A「仅这一次」grant created here is consumed by the current tool call
   * (D75); `preauthorize` (request_access) leaves it for the next tool call
   * that uses it instead — still bounded by GRANT_ABSOLUTE_TTL_MS.
   */
  async ensurePathAccess(
    identity: RunIdentity,
    inputPath: string,
    mode: 'read' | 'write',
    reason: string,
    options: { signal?: AbortSignal; preauthorize?: boolean } = {},
  ): Promise<string> {
    const decision = this.checkPath(identity, inputPath, mode);
    if (decision.kind === 'allowed') return decision.resolvedPath;
    if (decision.kind === 'forbidden') {
      throw new AppError(
        decision.readOnlyRun === true ? 'RUN_READ_ONLY' : 'PATH_OUT_OF_SCOPE',
        `${decision.reason}：${inputPath}`,
      );
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
    // D75 §2.1 / §7.3 (审查 M4): a supervisor turn never waits for an access
    // approval — that would hold the (bot, conversation) mailbox until the
    // user decides. It fails fast; reading outside the authorized range is a
    // task's work (request_access inside the task).
    if (identity.loopType === 'turn') {
      throw new AppError(
        'PATH_OUT_OF_SCOPE',
        `${decision.reason}：${inputPath}。对话轮不申请访问授权：需要读取它请用 start_task 派一个任务，在任务里读取（必要时先用 request_access 申请）。`,
      );
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
      { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
    );
    if (outcome.decision !== 'approved') {
      throw new AppError('APPROVAL_DENIED', '用户拒绝或审批已取消，无法访问该路径');
    }
    // `grants` only ever see once | conversation (decide() confines `bot` to mcp_tool cards).
    const duration =
      outcome.approval.decision?.duration === 'conversation' ? 'conversation' : 'once';
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
    if (options.preauthorize !== true) this.#deps.grants.noteOnceUse(grant);
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
    // D75: a read-only run's commands get a read-only policy (sandbox) or are
    // limited to the read-only allowlist (confirm mode).
    const readOnlyReason = this.writeDenial(identity);
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
      // Effective = conversation grants + once grants this tool call owns or
      // may claim (unclaimed request_access pre-authorizations); once grants
      // owned by a parallel call of the same run are not visible here (D75).
      const grants = this.#deps.grants.listEffective(identity);
      // Every grant in the policy is usable by this command, so every once
      // grant in it is consumed by this tool call. Which mounts a command
      // actually touches is not observable (and parsing the command for paths
      // would miss scripts, cd and variables), so a claimable pre-authorization
      // for an unrelated path is consumed too: the safe side — a mounted grant
      // must never stay usable for further commands.
      for (const grant of grants) this.#deps.grants.noteOnceUse(grant);
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
        ...(readOnlyReason !== null ? { readOnlyRun: true } : {}),
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
        ...(readOnlyReason !== null ? { readOnlyRun: true } : {}),
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
    // Without a sandbox nothing keeps an approved command from writing.
    if (readOnlyReason !== null) {
      throw new AppError(
        'RUN_READ_ONLY',
        `${readOnlyReason}。当前沙箱不可用，只能执行只读白名单内的命令：${req.command}`,
      );
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
    const readOnlyReason = this.writeDenial(identity);
    if (readOnlyReason !== null) {
      throw new AppError('RUN_READ_ONLY', `${readOnlyReason}（不能申请沙箱外执行）`);
    }
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
    // Every git remote operation mutates the repository or the remote.
    const readOnlyReason = this.writeDenial(identity);
    if (readOnlyReason !== null) {
      throw new AppError('RUN_READ_ONLY', `${readOnlyReason}（不能执行 git 远程操作）`);
    }
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
    // W2: an approved command leaves the sandbox — the calling tool (bash in
    // confirm mode) now has an external effect; the ledger records it from here.
    activeEffectHooks()?.escalate('unsandboxed', identity.runId);
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
   * MCP 工具调用（D65 / W5）：与内置工具同管道的审批 + 审计。
   *
   * 每次调用都重新解析风险与策略（工具列表刷新后注解可能变、设置可能改）：
   * 停用的工具拒绝（MCP_TOOL_NOT_FOUND）；只读工具面（对话轮 / 子代理）上只能
   * 调「只读 + 有效审批 auto」的工具，否则 RUN_READ_ONLY（该去任务里做）。
   * 决定顺序 tool policy > server autoApprove > 风险档默认（read→auto，其余→ask）；
   * 需要审批时 payload 带 risk，无人值守模式由 approvals 的 mcp_tool 显式分支
   * 自动批准（所有风险档，§5 护栏 7：审计写风险档）。args 在审计里经 redact。
   */
  async mcpToolCall(
    identity: RunIdentity,
    server: { id: string; name: string },
    toolName: string,
    args: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      /**
       * D73: connection context of a catalog app's tool (its identity goes onto the
       * card and into the audit; absent for plain MCP servers).
       */
      connection?: AppToolContext;
    } = {},
  ): Promise<{
    decision: McpToolDecision;
    approvedBy: 'auto' | 'user' | 'unattended' | 'grant';
    grantId?: string;
  }> {
    const decision: McpToolDecision = (await this.#deps.mcpToolDecision?.({
      botId: identity.botId,
      serverId: server.id,
      toolName,
      signal: options.signal,
    })) ?? {
      risk: 'destructive',
      riskSource: 'default',
      approval: 'ask',
      approvalSource: 'default',
      enabled: true,
    };
    if (!decision.enabled) {
      throw new AppError(
        'MCP_TOOL_NOT_FOUND',
        `MCP 工具 ${toolName} 已被用户停用（或其服务器已停用 / 不再分配给该 Bot），不能调用`,
      );
    }
    if (
      (identity.loopType === 'turn' || identity.loopType === 'subagent') &&
      !(decision.risk === 'read' && decision.approval === 'auto')
    ) {
      throw new AppError(
        'RUN_READ_ONLY',
        identity.loopType === 'turn'
          ? '该工具需要在任务中执行，请用 start_task'
          : '该工具需要在任务中执行（子代理只能调用只读且免审批的 MCP 工具），请在结论中说明，由任务本身调用',
      );
    }
    const connection = options.connection;
    // D73 identity of the third-party account this call acts as (card, audit).
    const connectionAudit =
      connection !== undefined
        ? {
            connectionId: connection.connectionId,
            connectorSlug: connection.connectorSlug,
            accountLabel: connection.accountLabel,
            appName: connection.appName,
          }
        : {};
    let approvedBy: 'auto' | 'user' | 'unattended' | 'grant' = 'auto';
    let grantId: string | undefined;
    if (decision.approval === 'ask') {
      // D73: a standing grant (this conversation / this bot) for a WRITE app tool
      // needs no card. Destructive calls always ask (grants are never created for
      // them, and a tool whose risk was raised since the grant must ask again).
      // An explicit per-tool「每次确认」policy (approvalSource 'policy') overrides both
      // standing grants and the longer durations on the card.
      const grantable =
        connection !== undefined &&
        decision.risk === 'write' &&
        decision.approvalSource !== 'policy' &&
        identity.botId !== null;
      const grant =
        connection !== undefined && grantable && identity.botId !== null
          ? (this.#deps.appGrants?.find({
              botId: identity.botId,
              connectionId: connection.connectionId,
              toolName,
              conversationId: identity.conversationId,
            }) ?? null)
          : null;
      if (grant !== null) {
        approvedBy = 'grant';
        grantId = grant.id;
      } else {
        // 卡片与落库 payload 都经脱敏：参数里可能出现模型误带入的密钥值。
        const argsRedacted = this.#deps.secrets.redact(JSON.stringify(args));
        // W4 精确卡片：发送类（写入 / 破坏性）工具的收件方字段完整列出，不参与
        // argsSummary 的截断（同样脱敏）。
        const recipients =
          decision.risk !== 'read'
            ? recipientFields(args, (text) => this.#deps.secrets.redact(text))
            : [];
        // 应用工具：写入档可选「本对话内 / 对该 Bot 总是允许」，破坏性档只有「仅这一次」。
        const durations: ApprovalDuration[] | undefined =
          connection === undefined
            ? undefined
            : grantable
              ? ['once', 'conversation', 'bot']
              : ['once'];
        const outcome = await this.#deps.approvals.request(
          identity,
          'mcp_tool',
          {
            serverId: server.id,
            serverName: connection?.appName ?? server.name,
            toolName,
            argsSummary:
              argsRedacted.length > 400 ? `${argsRedacted.slice(0, 400)}…（已截断）` : argsRedacted,
            risk: decision.risk,
            ...(recipients.length > 0 ? { recipients } : {}),
            ...(connection !== undefined
              ? {
                  connectionId: connection.connectionId,
                  connectorSlug: connection.connectorSlug,
                  accountLabel: connection.accountLabel,
                  ...(durations !== undefined ? { durations } : {}),
                  // 不可撤销的操作：卡片展示完整参数（脱敏、设上限），而不只是摘要。
                  ...(decision.risk === 'destructive'
                    ? {
                        argsFull: this.#deps.secrets
                          .redact(JSON.stringify(args, null, 2))
                          .slice(0, MCP_APPROVAL_ARGS_FULL_MAX),
                      }
                    : {}),
                }
              : {}),
          },
          options,
        );
        if (outcome.decision !== 'approved') {
          throw new AppError('APPROVAL_DENIED', '用户拒绝或取消了该 MCP 工具调用');
        }
        approvedBy = outcome.approval.autoApproved === true ? 'unattended' : 'user';
        // 审批通过且选了「本对话内 / 对该 Bot 总是允许」→ 写持续授权（decide() 已按卡片
        // 提供的时长降级，这里再核一次：只有写入档的应用工具、卡片确实提供了该时长才建）。
        const chosen = outcome.approval.decision?.duration;
        if (
          approvedBy === 'user' &&
          connection !== undefined &&
          grantable &&
          identity.botId !== null &&
          (chosen === 'conversation' || chosen === 'bot') &&
          durations?.includes(chosen) === true &&
          (chosen === 'bot' || identity.conversationId !== null)
        ) {
          grantId = this.#deps.appGrants?.create({
            botId: identity.botId,
            connectionId: connection.connectionId,
            toolName,
            conversationId: chosen === 'conversation' ? identity.conversationId : null,
            approvalId: outcome.approval.id,
          }).id;
        }
      }
    }
    this.audit(identity, 'mcp_tool_call', {
      serverId: server.id,
      serverName: server.name,
      toolName,
      args,
      risk: decision.risk,
      riskSource: decision.riskSource,
      approval: approvedBy,
      approvalSource: decision.approvalSource,
      unattendedAutoApproved: approvedBy === 'unattended',
      ...(approvedBy === 'unattended'
        ? { note: `无人值守自动批准（${MCP_RISK_LABELS[decision.risk]}）` }
        : {}),
      ...connectionAudit,
      ...(grantId !== undefined ? { grantId } : {}),
    });
    return { decision, approvedBy, ...(grantId !== undefined ? { grantId } : {}) };
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
