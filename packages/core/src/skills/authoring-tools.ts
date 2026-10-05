import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { BASH_TIMEOUT_DEFAULT_MS, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';

import { canonicalPath, type AppPaths } from '../infra/paths.js';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import { buildSandboxPolicy } from '../sandbox/policy.js';
import type { SandboxBackend } from '../sandbox/types.js';
import { truncateToBudget } from '../agent/tokens.js';
import type { ToolDefinition, ToolResult } from '../agent/types.js';

export interface AuthoringToolDeps {
  paths: AppPaths;
  sandbox: SandboxBackend;
  /** The draft directory of the skill being generated. */
  draftsDir: string;
  platform?: string;
}

/**
 * Toolset of the skill generation loop (docs/dev/04-agent-runtime.md loop
 * 表 "技能生成"): file tools restricted to `_drafts/{name}/` plus bash that
 * only ever runs inside the sandbox with the draft directory as its
 * workspace. No gateway, no grants: the directory is app-owned and the loop
 * is background; everything outside the draft directory is refused.
 */
export function buildAuthoringTools(deps: AuthoringToolDeps): ToolDefinition[] {
  const platform = deps.platform ?? process.platform;
  const drafts = canonicalPath(deps.draftsDir);
  mkdirSync(drafts, { recursive: true });

  /** Resolves inside the draft directory or throws (no approvals here). */
  const guard = (target: string): string => {
    const resolved = canonicalPath(path.resolve(drafts, target));
    if (!isInsidePath(resolved, drafts)) {
      throw new Error(
        `PATH_OUT_OF_SCOPE: 技能生成只能访问草稿目录 ${drafts}，拒绝访问 ${target}`,
      );
    }
    return resolved;
  };

  const read = createReadToolDefinition(drafts, {
    operations: {
      access: async (p) => {
        statSync(guard(p));
      },
      readFile: async (p) => readFileSync(guard(p)),
      detectImageMimeType: async () => null,
    },
  });

  const write = createWriteToolDefinition(drafts, {
    operations: {
      writeFile: async (p, content) => {
        writeFileSync(guard(p), content, 'utf-8');
      },
      mkdir: async (dir) => {
        mkdirSync(guard(dir), { recursive: true });
      },
    },
  });

  const ls = createLsToolDefinition(drafts, {
    operations: {
      exists: async (p) => existsSync(guard(p)),
      stat: async (p) => {
        const stats = statSync(guard(p));
        return { isDirectory: () => stats.isDirectory() };
      },
      readdir: async (p) => readdirSync(guard(p)),
    },
  });

  const bash: ToolDefinition<{ command: string; timeout?: number }> = {
    name: 'bash',
    description:
      '在沙箱中执行一条命令（工作目录为技能草稿目录；无网络）。用于运行测试命令验证技能。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
      },
      required: ['command'],
    },
    execute: async (params, ctx): Promise<ToolResult> => {
      const availability = await deps.sandbox.probe();
      if (!availability.available) {
        // Fail-closed: skill tests never run outside the sandbox
        // (docs/design/13-permissions.md "绝不悄悄在无沙箱的情况下运行").
        return {
          ok: false,
          content: `沙箱不可用（${availability.reason ?? '未知原因'}），无法执行命令。`,
          errorCode: 'SANDBOX_UNAVAILABLE',
        };
      }
      const policy = buildSandboxPolicy({
        platform,
        paths: deps.paths,
        workspacePath: drafts,
        network: { mode: 'none', allowDomains: [], allowLocalhost: false },
      });
      const result = await deps.sandbox.exec({
        command: params.command,
        cwd: drafts,
        policy,
        timeoutMs: Math.min(
          params.timeout !== undefined && params.timeout > 0 ? params.timeout * 1000 : BASH_TIMEOUT_DEFAULT_MS,
          BASH_TIMEOUT_DEFAULT_MS,
        ),
        signal: ctx.signal,
      });
      const body = [result.stdout, result.stderr].filter((s) => s.length > 0).join('\n').trim();
      const truncated = truncateToBudget(body, TOOL_OUTPUT_MAX_CHARS);
      const suffix = truncated.truncated ? '\n[输出已截断]' : '';
      return {
        ok: result.exitCode === 0,
        content: `<untrusted>exit ${result.exitCode ?? 'unknown'}\n${truncated.text || '（无输出）'}${suffix}</untrusted>`,
        ...(result.exitCode === 0 ? {} : { errorCode: 'COMMAND_FAILED' }),
      };
    },
  };

  return [
    wrap(read),
    wrap(write),
    wrap(ls),
    bash,
  ];
}

/** Shared wrapper: AppError-ish failures become tool results, not throws. */
function wrap(def: { name: string; description: string; parameters: unknown; execute(
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: { cwd: string },
): Promise<{ content: Array<{ type: string; text?: string }> }> }): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (params, ctx) => {
      try {
        const result = await def.execute('call', params, ctx.signal, undefined, { cwd: '' });
        const text = (result.content ?? [])
          .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
          .trim();
        return { ok: true, content: text.length > 0 ? `<untrusted>\n${text}\n</untrusted>` : '（完成）' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          content: message,
          errorCode: message.startsWith('PATH_OUT_OF_SCOPE') ? 'PATH_OUT_OF_SCOPE' : 'TOOL_FAILED',
        };
      }
    },
  };
}
