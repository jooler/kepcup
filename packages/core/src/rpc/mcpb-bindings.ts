import type { z } from 'zod';
import {
  AppError,
  mcpbInspectInputSchema,
  mcpbInspectOutputSchema,
  mcpbInstallInputSchema,
  mcpbInstallOutputSchema,
} from '@kepcup/shared';
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
 * `mcpb.inspect` / `mcpb.install`（D73 P2 §6.5）：本地 .mcpb 包的预览与安装。
 * 安装后的 server 与其它自定义 server 一样用 `mcp.removeServer` 删除（该路径会顺带清理解包目录）。
 */
export function bindMcpbMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const installer = () => {
    if (services.mcpb === null) throw new AppError('NOT_IMPLEMENTED', 'MCPB 安装模块未就绪');
    return services.mcpb;
  };
  return {
    'mcpb.inspect': method(mcpbInspectInputSchema, mcpbInspectOutputSchema, async (input) => {
      const { manifest: _manifest, ...summary } = await installer().inspect(input.path);
      void _manifest;
      return summary;
    }),
    'mcpb.install': method(mcpbInstallInputSchema, mcpbInstallOutputSchema, async (input) =>
      installer().install({
        filePath: input.path,
        sha256: input.sha256,
        userConfig: input.userConfig,
        // NOTE: a conversation-started install uses an `environment`-kind card, which D41
        // unattended mode auto-approves; any agent-initiated path must add a never-auto marker first.
        ...(input.conversationId !== undefined
          ? { approvalContext: { conversationId: input.conversationId } }
          : {}),
        ...(input.fromCatalog !== undefined ? { fromCatalog: input.fromCatalog } : {}),
      }),
    ),
  };
}
