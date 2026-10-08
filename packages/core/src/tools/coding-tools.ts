import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  globSync,
} from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createBashToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { AppError, BASH_TIMEOUT_DEFAULT_MS, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../agent/types.js';
import type { ToolGateway } from '../gateway/index.js';
import type { SecretsService } from '../domain/secrets.js';
import type { SandboxNetworkPolicy } from '../sandbox/types.js';
import type { FileReadState } from './fs-state.js';

export interface CodingToolDeps {
  gateway: ToolGateway;
  workspacePath: string;
  /** Bound project directory; the base for relative paths and bash (P04). */
  projectPath: string | null;
  network: SandboxNetworkPolicy;
  /** Redacts stored secret values from every tool output (BR-P02-003). */
  secrets: SecretsService;
  /** Per-run read hashes for staleness detection (docs/design/08 "过期检测"). */
  fsState: FileReadState;
}

/**
 * Coding tools from pi-coding-agent factories with their file/command
 * operations replaced by gateway implementations (docs/dev/04-agent-runtime.md
 * "工具目录"). Every file access below goes through the gateway — out-of-scope
 * paths raise an access approval via `ensurePathAccess` and block until the
 * user decides (P03 soft isolation).
 */

/** Awaiting the access approval; throws APPROVAL_DENIED when refused. */
async function checked(
  identity: ToolContext['identity'],
  gateway: ToolGateway,
  p: string,
  mode: 'read' | 'write',
  toolName: string,
): Promise<string> {
  return gateway.ensurePathAccess(identity, p, mode, `执行 ${toolName} 需要访问该路径`);
}

/**
 * D75 read-only runs: refuse write / edit up front so the result carries
 * RUN_READ_ONLY (pi's edit tool re-wraps errors from its file operations as
 * plain Errors). The gateway still refuses the write itself either way.
 */
function assertMayWrite(identity: ToolContext['identity'], gateway: ToolGateway): void {
  const denial = gateway.writeDenial(identity);
  if (denial !== null) throw new AppError('RUN_READ_ONLY', denial);
}

function assertReadable(resolved: string): void {
  statSync(resolved);
}

/**
 * Staleness gate (docs/design/08 "过期检测"): when this run read the file
 * earlier and the disk content changed since (user's editor), the write is
 * refused with STALE_FILE — the model must read again first.
 */
function assertFresh(runId: string, fsState: FileReadState, resolved: string): void {
  if (fsState.isStale(runId, resolved)) {
    throw new AppError(
      'STALE_FILE',
      `文件在你读取之后被外部修改过，请重新读取后再写入：${resolved}`,
    );
  }
}

function imageMimeOf(resolved: string): string | null {
  let header: Buffer;
  try {
    const fd = readFileSync(resolved);
    header = fd.subarray(0, 24);
  } catch {
    return null;
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (header[0] === 0xff && header[1] === 0xd8) return 'image/jpeg';
  if (header.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (
    header.subarray(0, 4).toString('latin1') === 'RIFF' &&
    header.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Locates rg without ever triggering pi's network download fallback. */
export function resolveRgPath(bundledBinDir: string | null): string | null {
  if (bundledBinDir !== null) {
    const bundled = path.join(bundledBinDir, 'rg');
    if (existsSync(bundled)) return bundled;
  }
  const probe = spawnSync('rg', ['--version'], { stdio: 'ignore' });
  return probe.error === undefined ? 'rg' : null;
}

type PiToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  /**
   * pi 1.x 语义（0.87.1 → 1.0.2 行为差异）：工具失败不再 throw，而是返回
   * `isError: true` 的结果（agent-core types.d.ts "errors come back as
   * `isError: true`"）。不识别该标志会把失败命令误报为成功。
   */
  isError?: boolean;
};

/** The slice of pi's ToolDefinition the gateway glue relies on. */
interface PiToolLike {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ): Promise<PiToolResult>;
}

interface WrapOptions {
  /** Runs before the underlying tool (status-line progress, D75 write guard); an AppError it throws becomes the tool error. */
  before?(params: unknown, ctx: ToolContext): void;
}

/** Converts a pi tool definition into our ToolDefinition with untrusted wrapping. */
export function wrapPiTool(
  def: PiToolLike,
  workspacePath: string,
  secrets: SecretsService,
  options?: WrapOptions,
): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (params, ctx): Promise<ToolResult> => {
      try {
        options?.before?.(params, ctx);
        const result = (await def.execute('call', params, ctx.signal, undefined, {
          cwd: workspacePath,
        })) as PiToolResult;
        const text = (result.content ?? [])
          .map((block) =>
            block.type === 'text' && typeof block.text === 'string' ? block.text : '',
          )
          .join('\n')
          .trim();
        // Redact before truncation so a secret at the head cannot push its
        // own redaction past the budget (same order as runs persistence).
        const redacted = secrets.redact(text);
        const truncated = truncateToBudget(redacted, TOOL_OUTPUT_MAX_CHARS);
        const body = truncated.truncated
          ? `${truncated.text}\n[输出已截断，共 ${redacted.length} 字符]`
          : truncated.text;
        // pi 1.x：非零退出（含被沙箱拦截）返回 isError:true 的结果，不再 throw。
        if (result.isError === true) {
          return {
            ok: false,
            content: `<untrusted>\n${body}\n</untrusted>`,
            errorCode: 'COMMAND_FAILED',
          };
        }
        return { ok: true, content: `<untrusted>\n${body}\n</untrusted>` };
      } catch (error) {
        if (error instanceof AppError) {
          return {
            ok: false,
            content: `${error.code}: ${secrets.redact(error.message)}`,
            errorCode: error.code,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        const code = message.startsWith('PATH_OUT_OF_SCOPE') ? 'PATH_OUT_OF_SCOPE' : 'TOOL_FAILED';
        return { ok: false, content: secrets.redact(message), errorCode: code };
      }
    },
  };
}

function shortCommand(command: string): string {
  const firstLine = command.split('\n', 1)[0] ?? command;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/** srt violation lines: `cat(x) deny(1) file-read-data /path`. */
const VIOLATION_PATH_PATTERN = /\bfile-(?:read|write)(?:-data|-metadata|-create)?\s+(.+)$/;

/** Unique paths the sandbox blocked, for the request_access hint. */
export function extractViolationPaths(violations: Array<{ line: string }>): string[] {
  const found: string[] = [];
  for (const violation of violations) {
    const match = VIOLATION_PATH_PATTERN.exec(violation.line);
    const target = match?.[1]?.trim();
    if (target && !found.includes(target)) found.push(target);
    if (found.length >= 5) break;
  }
  return found;
}

/** read / write / edit / ls / find / grep / bash wired through the gateway. */
export function buildCodingTools(
  identity: ToolContext['identity'],
  deps: CodingToolDeps,
  options?: {
    /**
     * Subagent 减配（D66）：只读研究集——不含 write / edit，避免子 run 与主
     * run 的 project 写租约竞争；写需求走主 loop 自己完成。
     */
    excludeWriteTools?: boolean;
  },
): ToolDefinition[] {
  const { gateway, workspacePath, network, secrets, fsState } = deps;
  // Relative paths and bash default to the project when one is bound
  // (docs/design/08-project.md "上下文注入"); the workspace remains the
  // bot's private scratch area.
  const baseDir = deps.projectPath ?? workspacePath;
  const runId = identity.runId;

  const readOps = {
    access: async (p: string) => {
      assertReadable(await checked(identity, gateway, p, 'read', 'read'));
    },
    readFile: async (p: string) => {
      const resolved = await checked(identity, gateway, p, 'read', 'read');
      const content = readFileSync(resolved);
      fsState.record(runId, resolved, content);
      return content;
    },
    detectImageMimeType: async (p: string) => {
      const resolved = await checked(identity, gateway, p, 'read', 'read');
      return imageMimeOf(resolved);
    },
  };

  const writeOps = {
    writeFile: async (p: string, content: string) => {
      const resolved = await checked(identity, gateway, p, 'write', 'write');
      assertFresh(identity.runId, fsState, resolved);
      writeFileSync(resolved, content, 'utf-8');
      fsState.recordWrite(runId, resolved, content);
      gateway.audit(identity, 'fs_write', { path: resolved, tool: 'write' });
    },
    mkdir: async (dir: string) => {
      const resolved = await checked(identity, gateway, dir, 'write', 'write');
      mkdirSync(resolved, { recursive: true });
      gateway.audit(identity, 'fs_write', { path: resolved, tool: 'write', op: 'mkdir' });
    },
  };

  const editOps = {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: async (p: string) => {
      const resolved = await checked(identity, gateway, p, 'write', 'edit');
      assertReadable(resolved);
      assertFresh(runId, fsState, resolved);
    },
  };

  const read = createReadToolDefinition(baseDir, { operations: readOps });
  const write = createWriteToolDefinition(baseDir, { operations: writeOps });
  const edit = createEditToolDefinition(baseDir, { operations: editOps });

  const ls = createLsToolDefinition(baseDir, {
    operations: {
      exists: async (p: string) => {
        const decision = gateway.checkPath(identity, p, 'read');
        return decision.kind === 'allowed' && existsSync(decision.resolvedPath);
      },
      stat: async (p: string) => {
        const resolved = await checked(identity, gateway, p, 'read', 'ls');
        const stats = statSync(resolved);
        return { isDirectory: () => stats.isDirectory() };
      },
      readdir: async (p: string) => {
        const resolved = await checked(identity, gateway, p, 'read', 'ls');
        return readdirSync(resolved);
      },
    },
  });

  const find = createFindToolDefinition(baseDir, {
    operations: {
      exists: async (p: string) => {
        const decision = gateway.checkPath(identity, p, 'read');
        return decision.kind === 'allowed' && existsSync(decision.resolvedPath);
      },
      glob: async (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => {
        const resolved = await checked(identity, gateway, cwd, 'read', 'find');
        const entries = globSync(pattern, {
          cwd: resolved,
          exclude: (entry: string) =>
            options.ignore.some((ignored) =>
              entry.includes(ignored.replaceAll('**/', '').replaceAll('/**', '')),
            ),
        });
        return entries.slice(0, options.limit).map((entry) => path.join(resolved, entry));
      },
    },
  });

  const grep = createGrepToolDefinition(baseDir, {
    operations: {
      isDirectory: async (p: string) => {
        const resolved = await checked(identity, gateway, p, 'read', 'grep');
        return statSync(resolved).isDirectory();
      },
      readFile: async (p: string) => {
        const resolved = await checked(identity, gateway, p, 'read', 'grep');
        return readFileSync(resolved, 'utf-8');
      },
    },
  });

  const bash = createBashToolDefinition(baseDir, {
    exposeSessionEnvironment: false,
    operations: {
      exec: async (
        command: string,
        cwd: string,
        options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
      ) => {
        void cwd; // commands always run in the workspace
        const timeoutMs = Math.min(
          options.timeout !== undefined && options.timeout > 0
            ? options.timeout * 1000
            : BASH_TIMEOUT_DEFAULT_MS,
          BASH_TIMEOUT_DEFAULT_MS,
        );
        const result = await gateway.exec(identity, {
          command,
          timeoutMs,
          signal: options.signal,
          network,
          onOutput: (chunk) => options.onData(Buffer.from(chunk, 'utf8')),
        });
        if (result.timedOut) {
          options.onData(
            Buffer.from(
              `\n[命令超时（${Math.round(timeoutMs / 1000)} 秒），已终止进程树]\n`,
              'utf8',
            ),
          );
        }
        if (result.violations.length > 0) {
          const samples = result.violations.slice(0, 5).map((v) => v.line);
          const notes = [
            `\n[被沙箱拦截 ${result.violations.length} 次，示例]\n${samples.join('\n')}`,
          ];
          const blockedPaths = extractViolationPaths(result.violations);
          if (blockedPaths.length > 0) {
            notes.push(
              `[提示] 以下路径在可访问范围之外：${blockedPaths.join('、')}。` +
                '可调用 request_access 工具申请对这些路径的访问授权，批准后重新执行命令。',
            );
          }
          options.onData(Buffer.from(`${notes.join('\n')}\n`, 'utf8'));
        }
        if (options.signal?.aborted) throw new Error('aborted');
        return { exitCode: result.exitCode ?? 1 };
      },
    },
  });

  const codingTools = [
    wrapPiTool(read, baseDir, secrets),
    wrapPiTool(write, baseDir, secrets, {
      before: (params, ctx) => {
        assertMayWrite(identity, gateway);
        const target = (params as { path?: string }).path;
        if (target !== undefined) ctx.progress(`正在写入 ${shortCommand(target)}`);
      },
    }),
    wrapPiTool(edit, baseDir, secrets, {
      before: (params, ctx) => {
        assertMayWrite(identity, gateway);
        const target = (params as { path?: string }).path;
        if (target !== undefined) ctx.progress(`正在编辑 ${shortCommand(target)}`);
      },
    }),
    wrapPiTool(ls, baseDir, secrets),
    wrapPiTool(find, baseDir, secrets),
    wrapPiTool(grep, baseDir, secrets),
    wrapPiTool(bash, baseDir, secrets, {
      before: (params, ctx) => {
        const command = (params as { command?: string }).command;
        if (command !== undefined) ctx.progress(`正在执行命令 ${shortCommand(command)}`);
      },
    }),
  ];
  if (options?.excludeWriteTools === true) {
    return codingTools.filter((tool) => tool.name !== 'write' && tool.name !== 'edit');
  }
  return codingTools;
}
