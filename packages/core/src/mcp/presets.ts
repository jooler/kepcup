import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { CoreLogger } from '../infra/logger.js';

/**
 * 精选 MCP 清单（扩展中心「MCP」分组的数据源，设计 29 §16 决定 C）。
 *
 * 数据来自随应用分发的 `apps/desktop/resources/mcp-presets/catalog.json`（风格对齐
 * `preset-skills/catalog.json` / `connectors/catalog.json`）。**首期清单为空**：分组只显示已
 * 安装 MCP 的管理视图；这里先把 schema 与加载器定下来，第一个条目落地时再接 RPC 与打包。
 * 需要 OAuth 的第三方应用不走这份清单，走 `connectors/catalog.json`（「连接」分组）。
 *
 * 加载容错同连接应用目录：文件缺失 / 损坏 → 空清单并告警；单个坏条目只告警并跳过；id 重复时
 * 保留先出现者。
 */

const presetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

/** `mcpb` 包文件在清单目录下的相对路径：不含目录穿越 / 绝对路径 / 反斜杠。 */
const relativeFileSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..' || segment === '' || segment === '.'),
    'must be a safe relative path',
  );

const httpsUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https URL');

/** 安装方式：MCPB 本地包（sha256 绑定）/ stdio 命令 / 无需 OAuth 的 Streamable HTTP 端点。 */
export const mcpPresetInstallSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mcpb'),
    file: relativeFileSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    kind: z.literal('stdio'),
    command: z.string().min(1).max(200),
    args: z.array(z.string().max(500)).max(32).default([]),
  }),
  z.object({
    kind: z.literal('http'),
    url: httpsUrlSchema,
  }),
]);

export const mcpPresetEntrySchema = z.object({
  id: presetIdSchema,
  section: z.string().min(1).max(64),
  displayName: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  icon: z.string().min(1).max(64).default('plug'),
  version: z.string().min(1).max(32),
  tryIt: z.string().max(500).default(''),
  install: mcpPresetInstallSchema,
});

export const mcpPresetCatalogSchema = z.object({
  version: z.number().int().min(1),
  presets: z.array(z.unknown()),
});

export type McpPresetEntry = z.infer<typeof mcpPresetEntrySchema>;

/** 资源目录：env 覆盖 → 向上查找 `apps/desktop/resources/mcp-presets` → null（清单为空）。 */
export function resolveMcpPresetsDir(env: NodeJS.ProcessEnv): string | null {
  const override = env.KEPCUP_MCP_PRESETS;
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? path.resolve(override) : null;
  }
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, 'apps', 'desktop', 'resources', 'mcp-presets');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 校验并去重（坏条目 / 重复 id 告警跳过）。 */
export function parseMcpPresetEntries(
  entries: readonly unknown[],
  logger?: Pick<CoreLogger, 'warn'>,
): McpPresetEntry[] {
  const out: McpPresetEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const parsed = mcpPresetEntrySchema.safeParse(raw);
    if (!parsed.success) {
      logger?.warn(
        { index, issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message) },
        'mcp preset entry rejected',
      );
      continue;
    }
    if (seen.has(parsed.data.id)) {
      logger?.warn({ id: parsed.data.id }, 'mcp preset entry skipped: duplicate id');
      continue;
    }
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

export interface LoadMcpPresetCatalogOptions {
  env: NodeJS.ProcessEnv;
  logger?: Pick<CoreLogger, 'warn'> | undefined;
  /** 直接指定资源目录（测试）；缺省按 {@link resolveMcpPresetsDir} 解析。 */
  dir?: string | null | undefined;
}

/** 读取精选 MCP 清单；目录 / 文件缺失或损坏 → 空数组。 */
export function loadMcpPresetCatalog(options: LoadMcpPresetCatalogOptions): McpPresetEntry[] {
  const dir = options.dir === undefined ? resolveMcpPresetsDir(options.env) : options.dir;
  if (dir === null) return [];
  const file = path.join(dir, 'catalog.json');
  try {
    const parsed = mcpPresetCatalogSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      options.logger?.warn({ file }, 'mcp presets catalog.json failed schema validation');
      return [];
    }
    return parseMcpPresetEntries(parsed.data.presets, options.logger);
  } catch (error) {
    options.logger?.warn(
      { file, error: error instanceof Error ? error.message : String(error) },
      'mcp presets catalog.json unreadable',
    );
    return [];
  }
}
