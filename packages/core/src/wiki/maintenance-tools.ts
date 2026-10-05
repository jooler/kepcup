import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { canonicalPath } from '../infra/paths.js';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import { untrustedBlock } from '../infra/data-boundary.js';
import { TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { ToolDefinition, ToolResult } from '../agent/types.js';

export interface MaintenanceToolDeps {
  /** The bot's wiki root (created by init before the loop starts). */
  wikiRoot: string;
}

/**
 * Toolset of the Wiki maintenance loop (docs/dev/04-agent-runtime.md loop 表
 * "Wiki 维护"): file tools restricted to the bot's wiki directory — read
 * everywhere inside it (`raw/` stays read-only by construction), writes only
 * into `pages/`, `index.md` and `log.md` (`SCHEMA.md` and `raw/` are not
 * writable), and page deletion only under `pages/`. No gateway, no grants: the
 * directory is app-owned, the loop is background, and everything outside the
 * wiki root is refused — the loop can never touch project or workspace
 * (任务书 注意事项).
 */
export function buildMaintenanceTools(deps: MaintenanceToolDeps): ToolDefinition[] {
  const root = canonicalPath(deps.wikiRoot);
  mkdirSync(root, { recursive: true });

  /** Resolves inside the wiki root or throws. */
  const readGuard = (target: string): string => {
    const resolved = canonicalPath(path.resolve(root, target));
    if (!isInsidePath(resolved, root)) {
      throw new Error(
        `PATH_OUT_OF_SCOPE: Wiki 维护只能访问本 Bot 的 wiki 目录 ${root}，拒绝访问 ${target}`,
      );
    }
    return resolved;
  };

  const WRITABLE_TOP_LEVEL = new Set(['index.md', 'log.md']);

  /** Write guard: pages/ subtree, or index.md / log.md at the root. */
  const writeGuard = (target: string): string => {
    const resolved = readGuard(target);
    const rel = path.relative(root, resolved);
    // The wiki root itself: pi's write tool mkdirs the parent before writing,
    // and index.md/log.md live directly in the root.
    if (rel === '') return resolved;
    if (rel === 'SCHEMA.md') {
      throw new Error('PATH_OUT_OF_SCOPE: SCHEMA.md 是维护规范，不能修改');
    }
    const insidePages = rel === 'pages' || rel.startsWith(`pages${path.sep}`) || rel.startsWith('pages/');
    const topLevel = !rel.includes('/') && !rel.includes(path.sep);
    if (!insidePages && !(topLevel && WRITABLE_TOP_LEVEL.has(rel))) {
      throw new Error(
        `PATH_OUT_OF_SCOPE: 只能写入 pages/ 下的页面、index.md 与 log.md（raw/ 只读），拒绝写入 ${target}`,
      );
    }
    return resolved;
  };

  const read = createReadToolDefinition(root, {
    operations: {
      access: async (p) => {
        statSync(readGuard(p));
      },
      readFile: async (p) => readFileSync(readGuard(p)),
      detectImageMimeType: async () => null,
    },
  });

  const write = createWriteToolDefinition(root, {
    operations: {
      writeFile: async (p, content) => {
        writeFileSync(writeGuard(p), content, 'utf-8');
      },
      mkdir: async (dir) => {
        mkdirSync(writeGuard(dir), { recursive: true });
      },
    },
  });

  const ls = createLsToolDefinition(root, {
    operations: {
      exists: async (p) => existsSync(readGuard(p)),
      stat: async (p) => {
        const stats = statSync(readGuard(p));
        return { isDirectory: () => stats.isDirectory() };
      },
      readdir: async (p) => readdirSync(readGuard(p)),
    },
  });

  /** Delete guard: regular files strictly under pages/ (nothing else goes). */
  const deleteGuard = (target: string): string => {
    const resolved = readGuard(target);
    const rel = path.relative(root, resolved);
    const insidePages = rel.startsWith(`pages${path.sep}`) || rel.startsWith('pages/');
    if (!insidePages) {
      throw new Error(
        `PATH_OUT_OF_SCOPE: 只能删除 pages/ 下的页面（index.md、log.md、raw/ 与 SCHEMA.md 不可删除），拒绝删除 ${target}`,
      );
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`NOT_FOUND: 页面不存在或不是文件：${target}`);
    }
    return resolved;
  };

  // A page that should no longer exist at all is deleted as a real deletion —
  // the platform commits it (add -A) and the FTS sync drops the row, so the
  // content stays recoverable via wiki rollback (git history is append-only).
  const deletePage: ToolDefinition<{ path: string }> = {
    name: 'delete',
    description:
      '删除 pages/ 下的一个页面文件（整页不再需要时使用；删除后同步更新 index.md，并在 log.md 末尾追加一条记录）。index.md、log.md、raw/ 与 SCHEMA.md 不可删除。',
    parameters: Type.Object({
      path: Type.String({ description: '页面路径（pages/ 下，例如 pages/obsolete.md）' }),
    }),
    execute: async (params): Promise<ToolResult> => {
      try {
        const resolved = deleteGuard(params.path);
        rmSync(resolved);
        const rel = path.relative(root, resolved).replaceAll('\\', '/');
        return { ok: true, content: `已删除 ${rel}（随后更新 index.md 与 log.md）` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          content: message,
          errorCode: message.startsWith('PATH_OUT_OF_SCOPE')
            ? 'PATH_OUT_OF_SCOPE'
            : message.startsWith('NOT_FOUND')
              ? 'NOT_FOUND'
              : 'TOOL_FAILED',
        };
      }
    },
  };

  return [wrap(read), wrap(write), wrap(ls), deletePage];
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
        const truncated = truncateToBudget(text, TOOL_OUTPUT_MAX_CHARS);
        const suffix = truncated.truncated ? '\n[输出已截断]' : '';
        return {
          ok: true,
          // BR-P09-004: read results embed raw/ material — a literal
          // `</untrusted>` inside it must not close the data boundary.
          content: text.length > 0 ? untrustedBlock(truncated.text + suffix) : '（完成）',
        };
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
