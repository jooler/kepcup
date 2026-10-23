import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import {
  AppError,
  filePreviewResourceInputSchema,
  filePreviewResourceOutputSchema,
  filePreviewSessionInputSchema,
  filePreviewSessionOutputSchema,
  type FilePreviewResourceInput,
  type FilePreviewResourceOutput,
  type FilePreviewSessionOutput,
} from '@kepcup/shared';
import { canonicalPath } from '../infra/paths.js';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * 目录预览协议的 RPC（`kepcup-file://`，docs/design/47）：
 *
 * - `files.previewSession`（app）：校验「该对话文件卡里的 HTML artifact」→ 记一个
 *   `{token → 所在目录}` 会话（内存，滑动 TTL + LRU 上限），返回 token 与大小。token 由
 *   canonical 绝对路径派生（可复现：重开同一文件 = 同一协议源，localStorage 延续）。
 * - `files.previewResource`（平台，主进程协议处理器按 token 调）：取会话目录内一个文件的
 *   字节。路径穿越 / 符号链接逃逸由 canonicalPath + isInsidePath 拦；单文件有大小上限。
 *
 * core 重启丢会话表：协议侧得到 404，用户重开 FileViewer 即重建（file-preview.ts 渲染端
 * 每次打开都会先调 previewSession）。
 */

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSIONS_MAX = 64;
/** 单文件字节上限（WebApp 资产可以比预览大，但不设防的读取不给予）。 */
const RESOURCE_MAX_BYTES = 64 * 1024 * 1024;

/** token = `f` + sha256(canonical 绝对路径) 前 24 hex。 */
export function filePreviewTokenOf(canonicalFile: string): string {
  return `f${createHash('sha256').update(canonicalFile).digest('hex').slice(0, 24)}`;
}

/**
 * 预览会话表（内存）：token → 预览目录根。滑动 TTL（每次取用续期）+ LRU 上限
 * （模式同 widgets resource-store：取用把条目挪到队尾，淘汰从最久未用的队首开始；
 * TTL 只回收渲染端没来得及重开的孤儿会话——重开同一文件 = 同一 token，自动续期）。
 * core 重启整表消失：协议侧 404，重开 FileViewer 即重建。
 */
export class FilePreviewSessions {
  readonly #entries = new Map<string, { root: string; expiresAt: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(options: { now: () => number; ttlMs?: number; max?: number }) {
    this.#now = options.now;
    this.#ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.#max = options.max ?? SESSIONS_MAX;
  }

  /** 登记 / 重开（同一 token 覆盖并挪到队尾）。 */
  set(token: string, root: string): void {
    this.#sweep();
    // Map 按插入序迭代：删了再插 = 最近使用，淘汰从队首（最久未用）开始。
    this.#entries.delete(token);
    this.#entries.set(token, { root, expiresAt: this.#now() + this.#ttlMs });
  }

  /** 取会话目录并滑动续期（挪到 LRU 队尾）；过期 / 不存在 = undefined。 */
  get(token: string): string | undefined {
    const entry = this.#entries.get(token);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (entry.expiresAt <= now) {
      this.#entries.delete(token);
      return undefined;
    }
    entry.expiresAt = now + this.#ttlMs;
    this.#entries.delete(token);
    this.#entries.set(token, entry);
    return entry.root;
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}

const sessions = new FilePreviewSessions({ now: Date.now });

const WEB_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'text/xml',
  '.map': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown',
};

export function webMimeOf(filePath: string): string {
  return WEB_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function bindFilesPreviewMethods(services: CoreServices): {
  app: Record<string, RpcMethodSpec>;
  platform: Record<string, RpcMethodSpec>;
} {
  const messages = () => {
    if (services.domain === null) throw new AppError('NOT_IMPLEMENTED', '消息模块未就绪');
    return services.domain.messages;
  };
  return {
    app: {
      'files.previewSession': method(
        filePreviewSessionInputSchema,
        filePreviewSessionOutputSchema,
        async (input): Promise<FilePreviewSessionOutput> => {
          const resolved = canonicalPath(input.path);
          // 与 files.preview 同一信任边界：只有文件卡登记过的路径才开目录会话。
          // 这也是符号链接防护：登记的是 canonical 路径。
          if (!messages().hasArtifactPath(input.conversationId, resolved)) {
            throw new AppError('PATH_OUT_OF_SCOPE', '该文件不在本对话的文件卡内');
          }
          // 目录会话的授权范围是「所在目录」：只对 HTML 入口开（FileViewer 的唯一用法，
          // 设计 47），别的 artifact 卡不能把它的目录变成可枚举读取的源。
          if (webMimeOf(resolved) !== 'text/html') {
            throw new AppError('INVALID_INPUT', '目录预览只支持 HTML 文件');
          }
          const stats = await stat(resolved).catch(() => null);
          if (stats === null || !stats.isFile()) {
            throw new AppError('NOT_FOUND', '文件不存在或已被移动');
          }
          const token = filePreviewTokenOf(resolved);
          sessions.set(token, path.dirname(resolved));
          return { token, size: stats.size };
        },
      ),
    },
    platform: {
      'files.previewResource': method(
        filePreviewResourceInputSchema,
        filePreviewResourceOutputSchema,
        async (input: FilePreviewResourceInput): Promise<FilePreviewResourceOutput> => {
          const root = sessions.get(input.token);
          if (root === undefined) {
            throw new AppError('NOT_FOUND', '预览会话不存在或已过期，请重新打开文件');
          }
          // URL 段已解码；统一分隔符后再规范化，`..` 与符号链接逃逸都落在 isInsidePath 上。
          const rel = input.rel.replaceAll('\\', '/');
          const target = canonicalPath(path.join(root, rel));
          if (!isInsidePath(target, root)) {
            throw new AppError('PATH_OUT_OF_SCOPE', '路径越过预览目录');
          }
          const stats = await stat(target).catch(() => null);
          if (stats === null || !stats.isFile()) {
            throw new AppError('NOT_FOUND', '资源不存在');
          }
          if (stats.size > RESOURCE_MAX_BYTES) {
            throw new AppError(
              'INVALID_INPUT',
              `资源过大（${stats.size} 字节），超过目录预览上限 ${RESOURCE_MAX_BYTES} 字节`,
            );
          }
          return {
            mime: webMimeOf(target),
            dataBase64: (await readFile(target)).toString('base64'),
          };
        },
      ),
    },
  };
}
